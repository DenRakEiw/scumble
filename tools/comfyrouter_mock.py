"""A mock of Comfy Router (api.comfy.org) for tools/comfyrouter_test.py (the pattern of tools/ark_mock.py).

Answers the routes electron/main/providers/comfyrouter.js talks to, on 127.0.0.1 (the only base besides api.comfy.org
that the adapter accepts, through settings.comfyrouter.base, and the only one a "test-" key goes to):

    POST /v2/models/{provider}/{model}/requests       401 unauthorized without X-API-Key; else 201 { request_id,
                                                      status: IN_QUEUE, queue_position, status_url, response_url,
                                                      cancel_url } with Retry-After: 1 (the URLs deliberately name
                                                      another host: the adapter composes its own)
    GET  .../requests/{id}/status                     IN_PROGRESS on the first read, COMPLETED after (Retry-After: 1)
    GET  .../requests/{id}                            the model's native answer (below), X-Comfy-Credits-Used
    PUT  .../requests/{id}/cancel                     202 CANCELLATION_REQUESTED
    POST /v2/models/{provider}/{model}                the synchronous route: the native answer at once
    GET  /asset/{n}.png                               a picture an answer links to

and the Partner API routes electron/main/providers/comfypartner.js uses for HY Image 3.5:

    POST /customers/storage                           { upload_url: <mock>/upload/<id>, download_url: <mock>/stored/<id> }
    PUT  /upload/{id}                                 keeps the bytes (a signed URL: no key expected)
    POST /proxy/tencent/v1/wand/hunyuan-image/v35-generation
                                                      checks every image_url was uploaded here, answers
                                                      choices[0].delta.image.url = a picture of the asked size; a
                                                      prompt holding "mock-download-failed" gets one answer
                                                      { error: { message: "code: 400, msg: download image failed" } }

The native answers follow the per-model schemas (tools/refs/comfyrouter/): OpenAI and Seedream answer data[0].b64_json,
Gemini candidates[0].content.parts[].inlineData, FLUX a result.sample link, Qwen output.choices[0].message.content
[].image, Freepik data.generated[0], xAI data[0].url, Ideogram data[0].url, Krea result.urls[0]. An edit gets its
first picture back as it went out; a text run a plain PNG of the size it asked for (OpenAI "WxH", Seedream "WxH",
Gemini 1024 on the long side of its aspect); an upscale the picture's size times scale_factor.

Synthetic models (any provider segment): `mock-credits` answers the submit with 402 insufficient_credits, `mock-busy`
answers its first submit with 429 rate_limited and Retry-After: 1 and the next one normally, `mock-noqueue` answers
every submit with 403 not_enabled (so the adapter goes to the synchronous route), `mock-refused` completes with
error_type content_policy_violation. Every request is recorded with its method, path, all its headers (names
lowercased) and its JSON body, the pictures summarised. Every answer closes its connection (see llm_mock.py).

    python tools/comfyrouter_mock.py [port]     runs it standalone for poking at by hand
"""
import base64
import json
import re
import struct
import sys
import threading
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PNG_SIGNATURE = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
HY_PATH = "/proxy/tencent/v1/wand/hunyuan-image/v35-generation"
ROUTE = re.compile(r"^/v2/models/([a-z0-9_-]+)/([a-z0-9._-]+)(/requests(?:/([0-9a-f-]{36})(/status|/cancel)?)?)?$")


def png_bytes(w, h, rgb=(52, 110, 160)):
    """A plain RGB PNG of w x h in one colour."""
    row = b"\x00" + bytes(rgb) * w
    z = zlib.compressobj(6)
    idat = b"".join(z.compress(row) for _ in range(h)) + z.flush()

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def png_size(data):
    if not data or data[:8] != PNG_SIGNATURE or len(data) < 24:
        return None
    return list(struct.unpack(">II", data[16:24]))


def decode(value):
    """(media type, bytes) of a data URL or of plain base64, else (None, None)."""
    s = str(value or "")
    m = re.match(r"^data:([^;,]+);base64,(.*)$", s, re.S)
    try:
        if m:
            return m.group(1), base64.b64decode(m.group(2), validate=True)
        return "base64", base64.b64decode(s, validate=True)
    except ValueError:
        return None, None


def pictures_of(prov, body):
    """The pictures a body carries, in order, as [(field, mime, bytes)]."""
    out = []
    if prov in ("openai", "byteplus"):
        img = body.get("image")
        for u in (img if isinstance(img, list) else [img] if img else []):
            out.append(("image",) + decode(u))
        if body.get("mask"):
            out.append(("mask",) + decode(body["mask"]))
    elif prov == "vertexai":
        for c in body.get("contents") or []:
            for p in c.get("parts") or []:
                d = p.get("inlineData")
                if d:
                    out.append(("inlineData", d.get("mimeType"), base64.b64decode(d.get("data") or "")))
    elif prov == "bfl":
        for k in ["image", "mask", "input_image"] + ["input_image_%d" % i for i in range(2, 10)]:
            if body.get(k):
                out.append((k,) + decode(body[k]))
    elif prov == "qwen":
        for m in (body.get("input") or {}).get("messages") or []:
            for c in m.get("content") or []:
                if c.get("image"):
                    out.append(("image",) + decode(c["image"]))
    elif prov == "freepik" and body.get("image"):
        out.append(("image",) + decode(body["image"]))
    return out


def wxh(value, sep="x"):
    m = re.match(r"^(\d+)%s(\d+)$" % re.escape(sep), str(value or ""))
    return (int(m.group(1)), int(m.group(2))) if m else None


class Mock(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.lock = threading.Lock()
        self.calls = []
        self.every_call = []
        self.runs = {}        # request_id -> { prov, model, body, polled }
        self.busy = set()
        self.stored = {}      # upload id -> { mime, bytes }
        self.hy_failed = set()
        self._thread = None

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_address[1]}"

    def start(self):
        self._thread = threading.Thread(target=self.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self.shutdown()
        self.server_close()
        if self._thread:
            self._thread.join(timeout=5)

    def snapshot(self):
        with self.lock:
            return {"calls": json.loads(json.dumps(self.calls))}

    def all_calls(self):
        with self.lock:
            return json.loads(json.dumps(self.every_call))

    def reset(self):
        with self.lock:
            self.calls.clear()
            self.runs.clear()
            self.busy.clear()
            self.stored.clear()
            self.hy_failed.clear()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_a):
        pass

    def _send(self, code, payload, ctype="application/json", headers=None):
        data = payload if isinstance(payload, (bytes, bytearray)) else json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(data)

    def _error(self, code, kind, detail, headers=None):
        self._send(code, {"detail": detail, "error_type": kind}, headers={"X-Comfy-Error-Type": kind, "X-Comfy-Request-Id": "mock-err", **(headers or {})})

    def _record(self, body=None, pictures=None):
        c = {"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}}
        if body is not None:
            c["json"] = body
        if pictures is not None:
            c["pictures"] = pictures
        with self.server.lock:
            self.server.calls.append(c)
            self.server.every_call.append(c)

    def _authorised(self):
        if not (self.headers.get("X-API-Key") or "").strip():
            self._error(401, "unauthorized", "Missing or invalid credentials.")
            return False
        return True

    def do_GET(self):
        path = self.path.split("?")[0]
        self._record()
        if path.startswith("/stored/"):
            with self.server.lock:
                item = self.server.stored.get(path.split("/")[-1])
            if not item:
                self._error(404, "request_not_found", "no such stored file")
            else:
                self._send(200, item["bytes"], ctype=item["mime"])
            return
        if path.startswith("/asset/"):
            m = re.match(r"^/asset/(\d+)x(\d+)\.png$", path)
            w, h = (int(m.group(1)), int(m.group(2))) if m else (64, 64)
            self._send(200, png_bytes(w, h, (200, 90, 60)), ctype="image/png")
            return
        m = ROUTE.match(path)
        if not m or not m.group(4) or m.group(5) == "/cancel":
            self._error(404, "request_not_found", "no route GET " + path)
            return
        if not self._authorised():
            return
        rid, tail = m.group(4), m.group(5)
        with self.server.lock:
            run = self.server.runs.get(rid)
            if run and tail == "/status":
                run["polled"] += 1
        if not run:
            self._error(404, "request_not_found", "The request_id names no request of the caller's under this model.")
            return
        refused = run["model"] == "mock-refused"
        if tail == "/status":
            done = run["polled"] > 1
            body = {"request_id": rid, "status": "COMPLETED" if done else "IN_PROGRESS", "queue_position": 0}
            if done and refused:
                body["error_type"] = "content_policy_violation"
            self._send(200, body, headers={"Retry-After": "1"})
            return
        if refused:
            self._error(400, "content_policy_violation", "The provider refused the request on content-policy grounds.")
            return
        self._send(200, self._answer(run["prov"], run["body"]), headers={"X-Comfy-Request-Id": rid, "X-Comfy-Credits-Used": "12.5"})

    def do_PUT(self):
        path = self.path.split("?")[0]
        if path.startswith("/upload/"):
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self._record(None, [{"field": "upload", "mime": self.headers.get("Content-Type"), "size": len(raw), "dims": png_size(raw)}])
            with self.server.lock:
                self.server.stored[path.split("/")[-1]] = {"mime": self.headers.get("Content-Type") or "application/octet-stream", "bytes": raw}
            self._send(200, b"", ctype="text/plain")
            return
        self._record()
        m = ROUTE.match(path)
        if not m or m.group(5) != "/cancel":
            self._error(404, "request_not_found", "no route PUT " + path)
            return
        self._send(202, {"request_id": m.group(4), "status": "CANCELLATION_REQUESTED"})

    def do_POST(self):
        path = self.path.split("?")[0]
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        m = ROUTE.match(path)
        if path in ("/customers/storage", HY_PATH):
            self._partner(path, raw)
            return
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            self._record({"size": len(raw)})
            self._error(400, "invalid_input", "The request body is not JSON.")
            return
        prov, model = (m.group(1), m.group(2)) if m else ("", "")
        pics = pictures_of(prov, body) if m else []
        summary = [{"field": f, "mime": mime, "size": len(b or b""), "dims": png_size(b)} for f, mime, b in pics]
        self._record(self._shown(body), summary)
        if not m or (m.group(3) and m.group(3) != "/requests"):
            self._error(404, "model_not_found", "no route POST " + path)
            return
        if not self._authorised():
            return
        queue = m.group(3) == "/requests"
        if model == "mock-credits":
            self._error(402, "insufficient_credits", "The calling workspace does not have enough credits to run the model.")
            return
        if model == "mock-noqueue" and queue:
            self._error(403, "not_enabled", "This caller cannot use the queue.")
            return
        if model == "mock-busy" and queue:
            key = self.headers.get("Idempotency-Key") or ""
            with self.server.lock:
                first = key not in self.server.busy
                self.server.busy.add(key)
            if first:
                self._error(429, "rate_limited", "The caller has spent its allowance for this window.", headers={"Retry-After": "1"})
                return
        if not queue:
            self._send(200, self._answer(prov, body), headers={"X-Comfy-Request-Id": "mock-sync", "X-Comfy-Credits-Used": "7"})
            return
        rid = str(uuid.uuid4())
        with self.server.lock:
            self.server.runs[rid] = {"prov": prov, "model": model, "body": body, "polled": 0}
        other = "https://elsewhere.invalid/v2/models/%s/%s/requests/%s" % (prov, model, rid)
        self._send(201, {"request_id": rid, "status": "IN_QUEUE", "queue_position": 0, "status_url": other + "/status", "response_url": other, "cancel_url": other + "/cancel"},
                   headers={"X-Comfy-Request-Id": rid, "Retry-After": "1"})

    def _partner(self, path, raw):
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            body = None
        self._record(self._shown(body) if isinstance(body, dict) else {"size": len(raw)})
        if not isinstance(body, dict):
            self._send(400, {"error": "invalid_request", "message": "The body is not JSON."})
            return
        if not (self.headers.get("X-API-Key") or "").strip():
            self._send(401, {"error": "unauthorized", "message": "Unauthorized"})
            return
        if path == "/customers/storage":
            uid = uuid.uuid4().hex + (".jpg" if body.get("content_type") == "image/jpeg" else ".png")
            self._send(200, {"upload_url": "%s/upload/%s?sig=mock" % (self.server.url, uid), "download_url": "%s/stored/%s?sig=mock" % (self.server.url, uid)})
            return
        content = ((body.get("messages") or [{}])[0].get("content")) or []
        text = " ".join(c.get("text") or "" for c in content if c.get("type") == "text")
        for c in content:
            if c.get("type") == "image_url":
                url = (c.get("image_url") or {}).get("url") or ""
                uid = url.split("?")[0].split("/")[-1]
                with self.server.lock:
                    known = uid in self.server.stored
                if not known:
                    self._send(200, {"error": {"message": "code: 400, msg: download image failed", "code": 400}})
                    return
        if "mock-download-failed" in text:
            with self.server.lock:
                first = "hy" not in self.server.hy_failed
                self.server.hy_failed.add("hy")
            if first:
                self._send(200, {"error": {"message": "code: 400, msg: download image failed", "code": 400}})
                return
        w, h = wxh(body.get("size")) or (1024, 1024)
        self._send(200, {"choices": [{"delta": {"image": {"url": "%s/asset/%dx%d.png" % (self.server.url, w, h), "width": w, "height": h}}, "finish_reason": "stop"}], "request_id": "hy-mock"})

    @staticmethod
    def _shown(body):
        """The body with every long string (the pictures) cut short, so a snapshot stays small."""
        def cut(v):
            if isinstance(v, str):
                return v if len(v) < 300 else v[:40] + "...(%d chars)" % len(v)
            if isinstance(v, list):
                return [cut(x) for x in v]
            if isinstance(v, dict):
                return {k: cut(x) for k, x in v.items()}
            return v
        return cut(body)

    def _answer(self, prov, body):
        pics = pictures_of(prov, body)
        first = pics[0][2] if pics else None
        base = self.server.url

        def asset(w, h):
            return "%s/asset/%dx%d.png" % (base, w, h)

        if prov == "openai":
            size = wxh(body.get("size")) or (1024, 1024)
            data = first if first else png_bytes(*size)
            return {"created": 1789000000, "data": [{"b64_json": base64.b64encode(data).decode("ascii")}], "output_format": body.get("output_format") or "png", "size": "%dx%d" % size}
        if prov == "byteplus":
            size = wxh(body.get("size")) or (2048, 2048)
            data = first if first else png_bytes(*size)
            return {"model": "seedream", "created": 1789000000, "data": [{"b64_json": base64.b64encode(data).decode("ascii"), "size": "%dx%d" % size}], "usage": {"generated_images": 1}}
        if prov == "vertexai":
            if first:
                data = first
            else:
                cfg = (body.get("generationConfig") or {}).get("imageConfig") or {}
                a = [float(x) for x in str(cfg.get("aspectRatio") or "1:1").split(":")]
                w, h = (1024, round(1024 * a[1] / a[0])) if a[0] >= a[1] else (round(1024 * a[0] / a[1]), 1024)
                data = png_bytes(w, h)
            return {"candidates": [{"content": {"role": "model", "parts": [{"text": "draft", "thought": True}, {"inlineData": {"mimeType": "image/png", "data": base64.b64encode(data).decode("ascii")}}]}, "finishReason": "STOP"}]}
        dims = png_size(first) if first else None
        if prov == "bfl":
            w, h = dims or (int(body.get("width") or 1024), int(body.get("height") or 1024))
            return {"id": "bfl-mock", "status": "Ready", "result": {"sample": asset(w, h), "seed": 2784347701}}
        if prov == "qwen":
            w, h = dims or wxh((body.get("parameters") or {}).get("size"), "*") or (1024, 1024)
            return {"output": {"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": [{"image": asset(w, h)}]}}]}, "request_id": "q-mock"}
        if prov == "freepik":
            f = int(body.get("scale_factor") or 2)
            w, h = dims or (256, 256)
            return {"data": {"task_id": str(uuid.uuid4()), "status": "COMPLETED", "generated": [asset(w * f, h * f)]}}
        if prov == "xai":
            return {"data": [{"url": asset(1024, 1024), "mime_type": "image/png"}]}
        if prov == "ideogram":
            w, h = wxh(body.get("resolution")) or (2048, 2048)
            return {"created": "2026-09-23T10:00:00Z", "data": [{"url": asset(w, h), "seed": 5, "resolution": body.get("resolution"), "is_image_safe": True}]}
        if prov == "krea":
            return {"job_id": str(uuid.uuid4()), "created_at": "2026-09-23T10:00:00Z", "completed_at": "2026-09-23T10:00:09Z", "status": "completed", "result": {"urls": [asset(1024, 1024)]}}
        return {}


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    server = Mock(port)
    print("mock Comfy Router on", server.url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
