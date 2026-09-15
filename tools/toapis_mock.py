"""A mock of toapis.com for tools/toapis_test.py (the pattern of tools/llm_mock.py).

Answers the routes electron/main/providers/toapis.js talks to, on 127.0.0.1 (an allowed base for the adapter):

    POST /v1/uploads/images               multipart `file` -> { success, data: { id, url: <mock>/files/<n>.<ext> } }
                                          (over 10 MB: 400 { success: false, message })
    POST /v1/images/generations           JSON -> { id: "tsk_img_mock_<n>", status: "queued" }
    GET  /v1/images/generations/<id>      in_progress on the first query when the model is mock-slow,
                                          else completed with result.data[0].url; failed for model mock-fail
    GET  /files/<n>                       the uploaded bytes (an edit's answer is its crop echoed back) or,
                                          for a text task, a PNG of the aspect and tier it asked for
    GET  /v1/balance                      { success: true, remain_credits: 2100, credits_per_usd: 200 }

Model `mock-429` answers its first submit with 429 and Retry-After: 1. Every request is recorded with its path,
method, Authorization header and body (uploads with their name, type and bytes) so the test can assert what was
sent, and which calls carried the key.

    python tools/toapis_mock.py [port]     runs it standalone for poking at by hand
"""
import json
import re
import struct
import sys
import threading
import zlib
from email.parser import BytesParser
from email.policy import default as email_default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_UPLOAD = 10 * 1000 * 1000   # the stricter reading of the page's "10MB", as the adapter uses
PNG_SIGNATURE = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
TIER_BASE = {"0.5k": 512, "1k": 1024, "2k": 2048, "3k": 3072, "4k": 3840}


def png_bytes(w, h, rgb=(40, 120, 200)):
    """A plain RGB PNG of w x h in one colour with a light diagonal, written with zlib only."""
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        for x in range(w):
            k = 60 if (x * h // max(1, w)) == y else 0
            rows.extend((min(255, rgb[0] + k), min(255, rgb[1] + k), min(255, rgb[2] + k)))

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b"")


def text_size(body):
    """The pixels a text task asked for: "W:H" with a tier, or "WxH"."""
    size = str(body.get("size") or "1:1")
    m = re.match(r"^(\d+)[x*](\d+)$", size)
    if m:
        w, h = int(m.group(1)), int(m.group(2))
    else:
        a, b = (int(v) for v in size.split(":")) if ":" in size else (1, 1)
        tier = str(body.get("resolution") or (body.get("metadata") or {}).get("resolution") or "1k").lower()
        base = TIER_BASE.get(tier, 1024)
        w, h = (base, round(base * b / a)) if a >= b else (round(base * a / b), base)
    k = min(1.0, 512 / max(w, h))   # small answers keep the test quick; the aspect is what is checked
    return max(16, round(w * k)), max(16, round(h * k))


class Mock(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.lock = threading.Lock()
        self.calls = []       # every request: { method, path, auth, json? }
        self.uploads = []     # { name, type, bytes, url }
        self.submits = []     # generation bodies
        self.tasks = {}       # id -> { body, polls, url }
        self.files = {}       # "/files/<n>.<ext>" -> (type, bytes)
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
                "calls": [dict(c) for c in self.calls],
                "uploads": [{k: (v if k != "bytes" else len(v)) for k, v in u.items()} for u in self.uploads],
                "submits": json.loads(json.dumps(self.submits)),
            }

    def upload_bytes(self, i):
        with self.lock:
            return self.uploads[i]["bytes"]

    def reset(self):
        with self.lock:
            self.calls.clear()
            self.uploads.clear()
            self.submits.clear()


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

    def _record(self, extra=None):
        c = {"method": self.command, "path": self.path, "auth": self.headers.get("Authorization")}
        if extra:
            c.update(extra)
        with self.server.lock:
            self.server.calls.append(c)

    def _authorised(self):
        auth = self.headers.get("Authorization") or ""
        if not auth.startswith("Bearer ") or len(auth) < 12:
            self._send(401, {"error": {"code": "", "message": "未提供令牌 (request id: mock)", "type": "new_api_error"}})
            return False
        return True

    def do_GET(self):
        path = self.path.split("?")[0]
        self._record()
        s = self.server
        if path.startswith("/files/"):
            with s.lock:
                f = s.files.get(path)
            if not f:
                self._send(404, {"error": {"message": "no file " + path}})
                return
            self._send(200, f[1], ctype=f[0])
            return
        if not self._authorised():
            return
        if path == "/v1/balance":
            self._send(200, {"success": True, "remain_balance": 10.5, "used_balance": 2.3, "remain_credits": 2100, "used_credits": 460, "credits_per_usd": 200, "unlimited_quota": False})
            return
        m = re.match(r"^/v1/images/generations/([^/]+)$", path)
        if m:
            tid = m.group(1)
            with s.lock:
                t = s.tasks.get(tid)
                if t:
                    t["polls"] += 1
            if not t:
                self._send(404, {"error": {"code": 404, "message": "Task not found", "type": "not_found_error"}})
                return
            model = t["body"].get("model")
            if model == "mock-fail":
                self._send(200, {"id": tid, "object": "generation.task", "model": model, "status": "failed", "progress": 0, "billing": {"status": "refunded", "credits": "0", "cost_usd": "0"}, "error": {"code": "generation_failed", "message": "call upstream API failed: upstream returned status 422"}})
                return
            if model == "mock-slow" and t["polls"] < 2:
                self._send(200, {"id": tid, "object": "generation.task", "model": model, "status": "in_progress", "progress": 50})
                return
            self._send(200, {"id": tid, "object": "generation.task", "model": model, "status": "completed", "progress": 100, "billing": {"status": "settled", "credits": "27", "cost_usd": "0.135"}, "result": {"type": "image", "data": [{"url": t["url"]}]}})
            return
        self._send(404, {"error": {"message": "no route " + path}})

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        s = self.server
        if path == "/v1/uploads/images":
            self._record()
            if not self._authorised():
                return
            msg = BytesParser(policy=email_default).parsebytes(b"Content-Type: " + (self.headers.get("Content-Type") or "").encode() + b"\r\n\r\n" + raw)
            part = None
            for p in msg.iter_parts():
                if p.get_param("name", header="content-disposition") == "file":
                    part = p
            if part is None:
                self._send(400, {"success": False, "message": "no file"})
                return
            data = part.get_payload(decode=True) or b""
            if len(data) > MAX_UPLOAD:
                self._send(400, {"success": False, "message": "Image too large. Maximum size is 10MB"})
                return
            ctype = part.get_content_type()
            with s.lock:
                n = len(s.files) + 1
                ext = "jpg" if ctype == "image/jpeg" else "png"
                fpath = f"/files/{n}.{ext}"
                s.files[fpath] = (ctype, data)
                url = s.url + fpath
                dims = list(struct.unpack(">II", data[16:24])) if data[:8] == PNG_SIGNATURE and len(data) >= 24 else None
                s.uploads.append({"name": part.get_filename(), "type": ctype, "bytes": data, "url": url, "dims": dims})
            self._send(200, {"success": True, "message": "", "data": {"id": f"upload_{n}", "url": url, "mime_type": ctype, "size": len(data)}})
            return
        if path == "/v1/images/generations":
            try:
                body = json.loads(raw.decode("utf-8"))
            except ValueError:
                self._record()
                self._send(400, {"error": {"code": "invalid_request", "message": "body is not JSON"}})
                return
            self._record({"json": body})
            if not self._authorised():
                return
            with s.lock:
                s.submits.append(body)
            model = body.get("model")
            if model == "mock-429" and "429" not in s.retried:
                s.retried.add("429")
                self._send(429, {"error": {"code": "rate_limit_exceeded", "message": "Async task request rate exceeded"}}, headers={"Retry-After": "1"})
                return
            images = body.get("image_urls") or []
            first = images[0] if images else None
            if isinstance(first, dict):
                first = first.get("url")
            with s.lock:
                n = len(s.tasks) + 1
                tid = f"tsk_img_mock_{n}"
                if first:
                    url = first                                   # an edit: the crop comes back
                else:
                    w, h = text_size(body)
                    fpath = f"/files/text_{n}.png"
                    s.files[fpath] = ("image/png", png_bytes(w, h))
                    url = s.url + fpath
                s.tasks[tid] = {"body": body, "polls": 0, "url": url}
            self._send(200, {"id": tid, "object": "generation.task", "model": model, "status": "queued", "progress": 0, "created_at": 1789000000, "metadata": {}})
            return
        self._record()
        self._send(404, {"error": {"message": "no route " + path}})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8798
    server = Mock(port)
    print("mock ToAPIs on", server.url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
