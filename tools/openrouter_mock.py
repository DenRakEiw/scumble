"""A mock of openrouter.ai for tools/openrouter_test.py (the pattern of tools/toapis_mock.py).

Answers the routes electron/main/providers/openrouter.js and the OpenRouter rows of electron/main/llm.js talk to,
on 127.0.0.1 (the only base besides https://openrouter.ai that the adapter accepts, and the only one a "test-" key
goes to):

    GET  /api/v1/providers          { data: [{ name, slug, headquarters, datacenters }] }, no key needed; one host
                                    has its headquarters in CN, one a datacentre in CN, one neither
    POST /api/v1/images             401 without a Bearer key. An edit (input_references) echoes its first picture
                                    back as data[0].b64_json with that picture's media type; a text request gets a
                                    PNG of its aspect_ratio at its resolution's long side (1K = 1024, 512 = 512, ...);
                                    usage.cost 0.04
    GET  /api/v1/key                { data: { label, limit: 20, limit_remaining: 12.5, usage: 7.5, ... } };
                                    limit_remaining null while `unlimited` is set
    POST /api/v1/chat/completions   the instruction's first five words + " UPSAMPLED, image: yes|no" (llm_mock.py's
                                    answer) for the four OpenRouter row ids of llm.js MODELS; 404 for another model

Image models by name: `mock-402` answers 402 with the documented "Insufficient credits" body, `mock-429` answers its
first request with 429 and Retry-After: 1 and the next one normally, `mock-502` answers 502 (a generation that did
not finish). Every request is recorded with its method, path, all its headers (names lowercased) and its JSON body;
the pictures of an image request are kept apart (decoded bytes, media type, PNG size) and replaced in the recorded
body by a short summary, so the snapshot stays small. `calls` is cleared by reset(), `every_call` never is (the
test's check that no attribution header went out on any request). Every answer closes its connection
(`Connection: close`, see llm_mock.py): a pooled connection would outlive stop().

    python tools/openrouter_mock.py [port]     runs it standalone for poking at by hand
"""
import base64
import json
import re
import struct
import sys
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PNG_SIGNATURE = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
TIER_BASE = {"512": 512, "0.5K": 512, "1K": 1024, "2K": 2048, "4K": 4096}
# the upsampling rows of electron/main/llm.js MODELS (provider "openrouter"), 2026-09-19
CHAT_MODELS = ["google/gemini-3.8-flash", "openai/gpt-5.6-luna", "anthropic/claude-haiku-4.5", "mistralai/mistral-small-2603"]
# GET /api/v1/providers: the shape of the live list (scratchpad img_api/providers.json), four made-up hosts
PROVIDERS = [
    {"name": "Mock US", "slug": "mock-us-host", "privacy_policy_url": None, "terms_of_service_url": None, "status_page_url": None, "headquarters": "US", "datacenters": ["US"]},
    {"name": "Mock CN", "slug": "mock-cn-host", "privacy_policy_url": None, "terms_of_service_url": None, "status_page_url": None, "headquarters": "CN", "datacenters": None},
    {"name": "Mock SG", "slug": "mock-sg-cn", "privacy_policy_url": None, "terms_of_service_url": None, "status_page_url": None, "headquarters": "SG", "datacenters": ["SG", "CN"]},
    {"name": "Mock EU", "slug": "mock-eu-host", "privacy_policy_url": None, "terms_of_service_url": None, "status_page_url": None, "headquarters": "DE", "datacenters": ["DE", "FR"]},
]
CN_SLUGS = ["mock-cn-host", "mock-sg-cn"]
NOT_CN_SLUGS = ["mock-us-host", "mock-eu-host"]


def png_bytes(w, h, rgb=(40, 120, 200)):
    """A plain RGB PNG of w x h in one colour with a light diagonal, written with zlib only."""
    row = bytes(rgb) * w
    light = bytes(min(255, c + 60) for c in rgb)
    rows = bytearray()
    for y in range(h):
        r = bytearray(row)
        x = y * w // max(1, h)
        if x < w:
            r[3 * x:3 * x + 3] = light
        rows.append(0)
        rows += r

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b"")


def png_size(data):
    """[width, height] from a PNG's IHDR, or None."""
    if data[:8] != PNG_SIGNATURE or len(data) < 24:
        return None
    return list(struct.unpack(">II", data[16:24]))


def text_size(body):
    """The pixels a text request asked for: aspect_ratio "W:H" (1:1 without one) at the resolution's long side."""
    a, b = 1, 1
    m = re.match(r"^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$", str(body.get("aspect_ratio") or ""))
    if m and float(m.group(1)) > 0 and float(m.group(2)) > 0:
        a, b = float(m.group(1)), float(m.group(2))
    base = TIER_BASE.get(str(body.get("resolution") or "1K"), 1024)
    w, h = (base, round(base * b / a)) if a >= b else (round(base * a / b), base)
    return max(16, w), max(16, h)


def data_url(url):
    """(media type, bytes) of a base64 data URL, or (None, None)."""
    m = re.match(r"^data:([^;,]+);base64,(.*)$", str(url or ""), re.S)
    if not m:
        return None, None
    try:
        return m.group(1), base64.b64decode(m.group(2))
    except ValueError:
        return m.group(1), None


def has_image(body):
    for m in body.get("messages") or []:
        content = m.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    return True
    return False


def instruction_of(body):
    for m in body.get("messages") or []:
        content = m.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    return part.get("text") or ""
    return ""


def stripped_chat(body):
    """A chat body with each image part's data URL replaced by its length."""
    out = json.loads(json.dumps(body))
    for m in out.get("messages") or []:
        content = m.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url") or ""
                    part["image_url"] = {"url": url[:30] + "...(%d chars)" % len(url)}
    return out


class Mock(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.lock = threading.Lock()
        self.calls = []        # every request since reset(): { method, path, headers, auth, json? }
        self.every_call = []   # every request since start, never cleared
        self.images = []       # POST /api/v1/images: { body (pictures summarised), refs: [{ mime, bytes, dims }] }
        self.chats = []        # POST /api/v1/chat/completions: { body (image parts summarised), image, auth }
        self.retried = set()
        self.unlimited = False  # GET /api/v1/key answers limit_remaining null
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
                "chats": json.loads(json.dumps(self.chats)),
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
            self.chats.clear()
            self.retried.clear()


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
        if not auth.startswith("Bearer ") or len(auth) < 12:
            self._send(401, {"error": {"code": 401, "message": "No auth credentials found"}})
            return False
        return True

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        self._record()
        s = self.server
        if path == "/api/v1/providers":
            self._send(200, {"data": PROVIDERS})
            return
        if path == "/api/v1/key":
            if not self._authorised():
                return
            self._send(200, {"data": {
                "label": "sk-or-v1-mock...", "limit": None if s.unlimited else 20, "limit_remaining": None if s.unlimited else 12.5,
                "limit_reset": None, "include_byok_in_limit": False, "usage": 7.5, "usage_daily": 0.5, "usage_weekly": 2.5, "usage_monthly": 7.5,
                "byok_usage": 0, "is_free_tier": False, "is_management_key": False, "expires_at": None,
            }})
            return
        self._send(404, {"error": {"code": 404, "message": "no route " + path}})

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        s = self.server
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            self._record()
            self._send(400, {"error": {"code": 400, "message": "body is not JSON"}})
            return
        if path == "/api/v1/images":
            self._image(body)
            return
        if path == "/api/v1/chat/completions":
            self._chat(body)
            return
        self._record(body if len(raw) < 20000 else {"size": len(raw)})
        self._send(404, {"error": {"code": 404, "message": "no route " + path}})

    def _image(self, body):
        s = self.server
        refs = []
        shown = json.loads(json.dumps({k: v for k, v in body.items() if k != "input_references"}))
        if "input_references" in body:
            shown["input_references"] = []
            for r in body.get("input_references") or []:
                url = ((r or {}).get("image_url") or {}).get("url") if isinstance(r, dict) else None
                mime, data = data_url(url)
                refs.append({"mime": mime, "bytes": data, "dims": png_size(data) if data else None})
                shown["input_references"].append({"type": (r or {}).get("type") if isinstance(r, dict) else None, "url": (str(url)[:30] + "...(%d chars)" % len(str(url))) if url else None})
        self._record(shown)
        if not self._authorised():
            return
        with s.lock:
            s.images.append({"body": shown, "refs": refs})
        model = str(body.get("model") or "")
        if model == "mock-402":
            self._send(402, {"error": {"code": 402, "message": "Insufficient credits. Add more using https://openrouter.ai/credits"}})
            return
        if model == "mock-502":
            self._send(502, {"error": {"code": 502, "message": "Provider returned error", "metadata": {"provider_name": "Mock"}}})
            return
        if model == "mock-429":
            with s.lock:
                first = "429" not in s.retried
                s.retried.add("429")
            if first:
                self._send(429, {"error": {"code": 429, "message": "Rate limit exceeded"}}, headers={"Retry-After": "1"})
                return
        if refs:
            first = refs[0]
            if not first["bytes"]:
                self._send(400, {"error": {"code": 400, "message": "input_references[0] is not a base64 data URL"}})
                return
            b64, mime = base64.b64encode(first["bytes"]).decode("ascii"), first["mime"] or "image/png"
        else:
            w, h = text_size(body)
            b64, mime = base64.b64encode(png_bytes(w, h)).decode("ascii"), "image/png"
        self._send(200, {"created": 1789000000, "data": [{"b64_json": b64, "media_type": mime}],
                         "usage": {"prompt_tokens": 10, "completion_tokens": 1290, "total_tokens": 1300, "cost": 0.04, "is_byok": False}})

    def _chat(self, body):
        s = self.server
        self._record(stripped_chat(body))
        if not self._authorised():
            return
        with s.lock:
            s.chats.append({"body": stripped_chat(body), "image": has_image(body), "auth": self.headers.get("Authorization")})
        model = str(body.get("model") or "")
        if model not in CHAT_MODELS:
            self._send(404, {"error": {"code": 404, "message": f"No endpoints found for {model}."}})
            return
        image = has_image(body)
        words = " ".join((instruction_of(body) or "").split()[:5])
        text = f"{words} UPSAMPLED, image: {'yes' if image else 'no'}"
        self._send(200, {
            "id": "gen-mock-1", "object": "chat.completion", "created": 1789000000, "model": model, "provider": "Mock US",
            "choices": [{"index": 0, "finish_reason": "stop", "native_finish_reason": "STOP", "message": {"role": "assistant", "content": text, "refusal": None, "reasoning": None}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2, "cost": 0.0001},
        })


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8797
    server = Mock(port)
    print("mock OpenRouter on", server.url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
