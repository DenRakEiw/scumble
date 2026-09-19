"""A mock of BytePlus ModelArk's image generation API for tools/ark_test.py (the pattern of tools/openrouter_mock.py).

Answers the one route electron/main/providers/ark.js talks to, on 127.0.0.1 (the only base besides the two regional
hosts that the adapter accepts, through settings.ark.base, and the only one a "test-" key goes to):

    POST /api/v3/images/generations   401 without a Bearer key, with the body the live hosts answered on 2026-09-19
                                      (docs/RECIPES.md "BytePlus ModelArk"). An edit (`image` given) echoes its first
                                      picture back as data[0].b64_json; a text request (no `image`) gets a plain PNG
                                      of exactly the requested size "WxH". data[0].size is the requested size either
                                      way, data[0].output_format the requested one (jpeg without one), and usage
                                      counts one generated image with output_tokens = W * H / 256.

The answer's shape is the API reference's sample (docs.byteplus.com/en/docs/ModelArk/1541523), the error bodies are
{ error: { code, message, param, type } } with the codes and types of the error-code page (1299023). What the mock
refuses as the live API would (as far as the docs say): a missing model or prompt (400 MissingParameter), a size that
is not "WxH" (400 InvalidParameter), a picture that is not a base64 data URL with a lowercase image type (400
InvalidImageURL.InvalidFormat), and a model id it does not know (404 InvalidEndpointOrModel.NotFound). Known ids: the
four Seedream ids of the model list (1330310), the lite alias, and the synthetic ones below.

Synthetic models: `mock-quota` answers 429 QuotaExceeded (the free trial quota), `mock-ipm` answers its first request
with 429 ModelAccountIpmRateLimitExceeded and Retry-After: 1 and the next one normally, `mock-notopen` answers 404
ModelNotOpen (the model is not activated). Every request is recorded with its method, path, all its headers (names
lowercased) and its JSON body; the pictures are kept apart (decoded bytes, media type, PNG size) and replaced in the
recorded body by a short summary, so a snapshot stays small. `calls` is cleared by reset(), `every_call` never is.
Every answer closes its connection (`Connection: close`, see llm_mock.py): a pooled connection would outlive stop().

    python tools/ark_mock.py [port]     runs it standalone for poking at by hand
"""
import base64
import json
import re
import struct
import sys
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PATH = "/api/v3/images/generations"
PNG_SIGNATURE = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
# the "Image generation" table of docs.byteplus.com/en/docs/ModelArk/1330310 (2026-09-17), plus the lite alias it names
MODELS = ["dola-seedream-5-0-pro-260628", "seedream-5-0-260128", "seedream-5-0-lite-260128", "seedream-4-5-251128", "seedream-4-0-250828"]
SYNTHETIC = ["mock-quota", "mock-ipm", "mock-notopen"]
REQUEST_ID = "021789000000000mock0000000000000000000000000000000000"


def png_bytes(w, h, rgb=(52, 110, 160)):
    """A plain RGB PNG of w x h in one colour, streamed through zlib row by row (cheap at any size)."""
    row = b"\x00" + bytes(rgb) * w
    z = zlib.compressobj(6)
    parts = []
    for _ in range(h):
        parts.append(z.compress(row))
    parts.append(z.flush())
    idat = b"".join(parts)

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def png_size(data):
    """[width, height] from a PNG's IHDR, or None."""
    if not data or data[:8] != PNG_SIGNATURE or len(data) < 24:
        return None
    return list(struct.unpack(">II", data[16:24]))


def parse_size(value):
    """(w, h) of a "WxH" size, or None."""
    m = re.match(r"^(\d+)x(\d+)$", str(value or ""))
    if not m or int(m.group(1)) <= 0 or int(m.group(2)) <= 0:
        return None
    return int(m.group(1)), int(m.group(2))


def data_url(url):
    """(media type, bytes) of a base64 data URL, (media type, None) when its payload does not decode, or (None, None)."""
    m = re.match(r"^data:([^;,]+);base64,(.*)$", str(url or ""), re.S)
    if not m:
        return None, None
    try:
        return m.group(1), base64.b64decode(m.group(2), validate=True)
    except ValueError:
        return m.group(1), None


def error_body(code, message, kind):
    return {"error": {"code": code, "message": message, "param": "", "type": kind}}


class Mock(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.lock = threading.Lock()
        self.calls = []        # every request since reset(): { method, path, headers, auth, json? }
        self.every_call = []   # every request since start, never cleared
        self.images = []       # authorised POSTs to PATH: { body (pictures summarised), refs: [{ mime, bytes, dims }] }
        self.retried = set()
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
            return {
                "calls": json.loads(json.dumps(self.calls)),
                "images": [{"body": json.loads(json.dumps(i["body"])), "refs": [{"mime": r["mime"], "size": len(r["bytes"] or b""), "dims": r["dims"]} for r in i["refs"]]} for i in self.images],
            }

    def all_calls(self):
        with self.lock:
            return json.loads(json.dumps(self.every_call))

    def ref_bytes(self, i, j):
        """The decoded bytes of picture j of image request i (since reset())."""
        with self.lock:
            return self.images[i]["refs"][j]["bytes"]

    def reset(self):
        with self.lock:
            self.calls.clear()
            self.images.clear()
            self.retried.clear()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_a):
        pass

    def _send(self, code, payload, ctype="application/json; charset=utf-8", headers=None):
        data = payload if isinstance(payload, (bytes, bytearray)) else json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Request-Id", REQUEST_ID)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        # no keep-alive: a pooled connection would outlive stop() (llm_mock.py)
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(data)

    def _record(self, body=None):
        c = {"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "auth": self.headers.get("Authorization")}
        if body is not None:
            c["json"] = body
        with self.server.lock:
            self.server.calls.append(c)
            self.server.every_call.append(c)

    def _authorised(self):
        auth = self.headers.get("Authorization") or ""
        if not auth.startswith("Bearer ") or len(auth.strip()) <= len("Bearer "):
            # the live answer to a request without a key (scratchpad ark/probe_*.txt, 2026-09-19)
            self._send(401, error_body("AuthenticationError", "the API key or AK/SK in the request is missing or invalid. request id: mock", "Unauthorized"),
                       headers={"X-Error-Code": "AuthN_MissOrInvalidAuthorizationHeader"})
            return False
        return True

    def do_GET(self):
        self._record()
        self._send(404, error_body("NotFound", "no route GET " + self.path.split("?")[0], "NotFound"))

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            self._record({"size": len(raw)})
            self._send(400, error_body("InvalidParameter", "the request body is not JSON. Request id: mock", "BadRequest"))
            return
        if path == PATH and isinstance(body, dict):
            self._image(body)
            return
        self._record(body if len(raw) < 20000 else {"size": len(raw)})
        self._send(404, error_body("NotFound", "no route POST " + path, "NotFound"))

    def _image(self, body):
        s = self.server
        refs = []
        shown = json.loads(json.dumps({k: v for k, v in body.items() if k != "image"}))
        if "image" in body:
            pics = body["image"]
            shown["image_type"] = type(pics).__name__
            pics = pics if isinstance(pics, list) else [pics]
            shown["image"] = []
            for url in pics:
                mime, data = data_url(url)
                refs.append({"mime": mime, "bytes": data, "dims": png_size(data), "url": str(url)[:40]})
                shown["image"].append((str(url)[:30] + "...(%d chars)" % len(str(url))) if url else None)
        self._record(shown)
        if not self._authorised():
            return
        with s.lock:
            s.images.append({"body": shown, "refs": refs})
        model = str(body.get("model") or "")
        if not model:
            self._send(400, error_body("MissingParameter", "The request failed because it is missing one or multiple required parameters: model. Request id: mock", "BadRequest"))
            return
        if not str(body.get("prompt") or "").strip():
            self._send(400, error_body("MissingParameter", "The request failed because it is missing one or multiple required parameters: prompt. Request id: mock", "BadRequest"))
            return
        if model not in MODELS and model not in SYNTHETIC:
            self._send(404, error_body("InvalidEndpointOrModel.NotFound", f"The model or endpoint {model} does not exist or you do not have access to it. Request id: mock", "NotFound"))
            return
        size = parse_size(body.get("size"))
        if not size:
            self._send(400, error_body("InvalidParameter", f"the parameter `size` specified in the request is not valid: {body.get('size')!r}. Request id: mock", "BadRequest"))
            return
        for i, r in enumerate(refs):
            if not r["mime"] or not r["bytes"] or not re.match(r"^image/[a-z0-9.+-]+$", r["mime"]):
                self._send(400, error_body("InvalidImageURL.InvalidFormat", f"Invalid base64 image url (image[{i}]). Request id: mock", "BadRequest"))
                return
        if model == "mock-quota":
            self._send(429, error_body("QuotaExceeded", "Your account [mock] has exhausted its free trial quota for the [mock-quota] model. Request ID: mock.", "TooManyRequests"))
            return
        if model == "mock-notopen":
            self._send(404, error_body("ModelNotOpen", "Your account mock has not activated the model mock-notopen. Please activate the model service in the Ark Console. Request id: mock", "NotFound"))
            return
        if model == "mock-ipm":
            with s.lock:
                first = "ipm" not in s.retried
                s.retried.add("ipm")
            if first:
                self._send(429, error_body("ModelAccountIpmRateLimitExceeded", "IPM (Images Per Minute) limit of the model is exceeded. Request id: mock", "TooManyRequests"), headers={"Retry-After": "1"})
                return
        w, h = size
        fmt = body.get("output_format") or "jpeg"
        if refs:
            # an edit: the first picture comes back as it went out (its own bytes, whatever the requested size)
            b64 = base64.b64encode(refs[0]["bytes"]).decode("ascii")
        else:
            b64 = base64.b64encode(png_bytes(w, h)).decode("ascii")
        tokens = round(w * h / 256)
        self._send(200, {
            "model": model, "created": 1789000000,
            "data": [{"b64_json": b64, "size": f"{w}x{h}", "output_format": fmt}],
            "usage": {**({"input_images": len(refs)} if refs else {}), "generated_images": 1, "output_tokens": tokens, "total_tokens": tokens},
        })


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8798
    server = Mock(port)
    print("mock ModelArk on", server.url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
