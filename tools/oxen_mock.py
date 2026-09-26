"""A mock of Oxen.ai's inference API (hub.oxen.ai/api/ai) for tools/oxen_test.py (the pattern of tools/magnific_mock.py).

Answers the routes electron/main/providers/oxen.js and llm.js talk to, on 127.0.0.1 (the only base besides
https://hub.oxen.ai that the adapter accepts, through settings.oxen.base, and the only one a "test-" key goes to):

    POST /api/ai/images/edit, /api/ai/images/generate
        401 Oxen's envelope { error: { type: "unauthenticated", title, detail }, status: "error", status_message } without
        a Bearer key. A known model (tools/refs/oxen/<id>.json): the body without `model` and `response_format` checked
        against its request_schema (no unknown field, the required ones, enums, types, bounds, maxItems), 400
        invalid_params naming the field on a violation; a picture field (input_image, input_images, mask_url) that is not
        data:image/(png|jpeg);base64,... answers 400 "403 Client Error: Forbidden for url: ..." (what Oxen says when it
        cannot fetch a URL). An unknown model that is not a mock-* name: 404 { error: { message: "Model not found: ..." } }.
        An edit gets its first picture back; a text run a PNG at its tier and aspect (or preset); an upscaler a PNG of the
        picture's size times the factor with a magenta one-pixel frame. `response_format` absent or "url": the answer
        is images[0].url = <mock>/api/repos/mock/files/<n>.png?sig=x, served without a key.
    POST /api/ai/chat/completions
        the three llm.js Oxen ids: the instruction's first five words + " UPSAMPLED, image: yes|no"; 404 "Model not found"
        for any other id. /api/ai/v1/chat/completions answers 404, so a /v1 in the path is red.

Synthetic models: mock-402 (402, type insufficient_credits: the real shape is not documented), mock-429 (a first 429
with Retry-After: 1, then OK), mock-429-long (429 with Retry-After: 120), mock-503 (a first 503 without a header, then
OK), mock-502, mock-500 (unknown_error), mock-200-error (200 { error: { message: "generation failed" } }), mock-url (a
url even when b64_json was asked), mock-url-auth (a url whose file answers 401 without the Bearer key), mock-empty
({ images: [] }), mock-no-dataurl (the 400 "403 Client Error" answer).

Every request is recorded with its method, path, headers (names lowercased) and its JSON body with the pictures cut
short; the pictures are summarised (field, format, size, dims; a PNG mask also whether it has alpha and its centre and
corner values). Every answer closes its connection.

    python tools/oxen_mock.py [port]     runs it standalone for poking at by hand
"""
import base64
import json
import os
import re
import struct
import sys
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PNG_SIGNATURE = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
REFS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "refs", "oxen")
PICTURE_FIELDS = ("input_image", "input_images", "mask_url")
TIERS = {"512": 512, "1K": 1024, "2K": 2048, "3K": 3072, "4K": 4096, "1k": 1024, "2k": 2048}
AREA_TIERS = {"0.5 MP": 500000, "1 MP": 1000000, "2 MP": 2000000}
PRESETS = {"square_hd": (1024, 1024), "square": (512, 512), "portrait_4_3": (768, 1024), "portrait_16_9": (576, 1024),
           "landscape_4_3": (1024, 768), "landscape_16_9": (1024, 576)}
UPSCALERS = {"topazlabs-image-upscale": "upscale_factor", "topazlabs-wonder-3-5-image": "scale", "topazlabs-bloom-2-image": None}
CHAT_MODELS = ("gemini-3-8-flash", "gpt-5-6-luna", "gemma-4-31b-it")
DATA_URL = re.compile(r"^data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)$")


def load_schemas():
    out = {}
    for name in os.listdir(REFS):
        if name.endswith(".json"):
            with open(os.path.join(REFS, name), encoding="utf-8") as f:
                doc = json.load(f)
            out[doc["id"]] = doc["request_schema"]
    return out


SCHEMAS = load_schemas()


# ---- pictures ---------------------------------------------------------------------------------------------------

def png_bytes(w, h, rgb=(60, 120, 90), frame=False):
    """A plain RGB PNG of w x h in one colour; `frame` paints a one-pixel magenta frame (the upscale gate's marker)."""
    mag = bytes((255, 0, 255))
    inner = bytes(rgb)
    full = b"\x00" + mag * w
    mid = b"\x00" + (mag + inner * max(0, w - 2) + mag if w > 1 else mag) if frame else b"\x00" + inner * w
    z = zlib.compressobj(6)
    parts = []
    for y in range(h):
        parts.append(z.compress(full if frame and (y == 0 or y == h - 1) else mid))
    idat = b"".join(parts) + z.flush()

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def png_size(data):
    if not data or data[:8] != PNG_SIGNATURE or len(data) < 24:
        return None
    return list(struct.unpack(">II", data[16:24]))


def png_colour(data):
    return data[25] if png_size(data) else None


def fmt_of(data):
    if png_size(data):
        return "png"
    if data[:2] == b"\xff\xd8":
        return "jpeg"
    return "other"


def pixels_at(data, points, channel):
    """One channel of an 8-bit grey, grey+alpha, RGB or RGBA PNG (no interlace) at each (x, y), else None."""
    if not png_size(data):
        return None
    i, idat, ihdr = 8, [], None
    while i + 8 <= len(data):
        n = struct.unpack(">I", data[i:i + 4])[0]
        kind = data[i + 4:i + 8]
        body = data[i + 8:i + 8 + n]
        if kind == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        i += 12 + n
    if not ihdr:
        return None
    w, h, depth, colour, _c, _f, interlace = ihdr
    ch = {0: 1, 4: 2, 2: 3, 6: 4}.get(colour)
    if depth != 8 or not ch or interlace or channel >= ch:
        return None
    raw = zlib.decompress(b"".join(idat))
    stride = w * ch
    rows, prev = [], bytearray(stride)
    for y in range(min(h, max(py for _, py in points) + 1)):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for x in range(stride):
            a = line[x - ch] if x >= ch else 0
            b = prev[x]
            c = prev[x - ch] if x >= ch else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line)
        prev = line
    return [rows[y][x * ch + channel] for x, y in points]


def decode(value):
    """(bytes, None) for a data URL the mock takes, else (None, reason)."""
    m = DATA_URL.match(str(value or ""))
    if not m:
        return None, str(value or "")[:40]
    try:
        return base64.b64decode(m.group(2), validate=True), None
    except ValueError:
        return None, str(value)[:40]


def pictures_of(body):
    """[(field, value)] of every picture the body carries."""
    out = []
    for k in PICTURE_FIELDS:
        v = body.get(k)
        if isinstance(v, str):
            out.append((k, v))
        elif isinstance(v, list):
            out += [(k, x) for x in v]
    return out


def summary(field, data):
    s = {"field": field, "format": fmt_of(data), "size": len(data), "dims": png_size(data)}
    if field == "mask_url" and s["dims"]:
        w, h = s["dims"]
        colour = png_colour(data)
        s["alpha"] = colour in (4, 6)
        channel = {4: 1, 6: 3}.get(colour, 0)
        got = pixels_at(data, [(w // 2, h // 2), (2, 2)], channel)
        if got:
            s["centre"], s["corner"] = got
    return s


# ---- the request schemas ----------------------------------------------------------------------------------------

def validate(s, v, at="body"):
    out = []
    if v is None:
        return [] if s.get("nullable") else [at + ": null"]
    t = s.get("type")
    is_t = {"string": isinstance(v, str), "integer": isinstance(v, int) and not isinstance(v, bool), "number": isinstance(v, (int, float)) and not isinstance(v, bool),
            "boolean": isinstance(v, bool), "array": isinstance(v, list), "object": isinstance(v, dict)}
    if t and not is_t.get(t, True):
        return [at + ": must be of type " + t]
    if "enum" in s and v not in s["enum"]:
        out.append(at + ": must be one of " + ", ".join(map(str, s["enum"])))
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if "minimum" in s and v < s["minimum"]:
            out.append("%s: must be at least %s" % (at, s["minimum"]))
        if "maximum" in s and v > s["maximum"]:
            out.append("%s: must be at most %s" % (at, s["maximum"]))
    if isinstance(v, list):
        if "maxItems" in s and len(v) > s["maxItems"]:
            out.append("%s: at most %d items" % (at, s["maxItems"]))
        for i, x in enumerate(v):
            out += validate(s.get("items") or {}, x, "%s[%d]" % (at, i))
    if isinstance(v, dict) and s.get("properties"):
        props = s["properties"]
        for r in s.get("required") or []:
            if r not in v:
                out.append(at + "." + r + ": is required")
        for k, x in v.items():
            if k in props:
                out += validate(props[k], x, at + "." + k)
            else:
                out.append(at + "." + k + ": unknown field")
    return out


def aspect_of(value):
    m = re.match(r"^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$", str(value or ""))
    return (float(m.group(1)), float(m.group(2))) if m else (1.0, 1.0)


def text_size(body):
    """The size a text run answers at: a preset, or the tier's long side (an area for FLUX) at the asked aspect."""
    if body.get("image_size") in PRESETS:
        return PRESETS[body["image_size"]]
    a, b = aspect_of(body.get("aspect_ratio"))
    tier = str(body.get("resolution") or body.get("size") or "1K")
    if tier in AREA_TIERS:
        area = AREA_TIERS[tier]
        w = round((area * a / b) ** 0.5)
        return w, round(area / w)
    long = TIERS.get(tier, 1024)
    return (long, round(long * b / a)) if a >= b else (round(long * a / b), long)


# ---- the server -------------------------------------------------------------------------------------------------

class Mock(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.lock = threading.Lock()
        self.calls = []
        self.every_call = []
        self.chats = []
        self.files = {}       # n -> (bytes, needs the key)
        self.seen = set()     # the synthetic models that already refused once
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
            return {"calls": json.loads(json.dumps(self.calls)), "chats": json.loads(json.dumps(self.chats))}

    def all_calls(self):
        with self.lock:
            return json.loads(json.dumps(self.every_call))

    def reset(self):
        with self.lock:
            self.calls.clear()
            self.chats.clear()
            self.seen.clear()


def envelope(type_, detail):
    return {"error": {"type": type_, "title": type_.replace("_", " "), "detail": detail}, "status": "error", "status_message": type_}


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

    def _record(self, body=None, pictures=None):
        c = {"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}}
        if body is not None:
            c["json"] = body
        if pictures is not None:
            c["pictures"] = pictures
        with self.server.lock:
            self.server.calls.append(c)
            self.server.every_call.append(c)
        return c

    def _bearer(self):
        auth = (self.headers.get("Authorization") or "").strip()
        return auth[7:].strip() if auth.lower().startswith("bearer ") else ""

    @staticmethod
    def _shown(body):
        def cut(v):
            if isinstance(v, str):
                return v if len(v) < 300 else v[:40] + "...(%d chars)" % len(v)
            if isinstance(v, list):
                return [cut(x) for x in v]
            if isinstance(v, dict):
                return {k: cut(x) for k, x in v.items()}
            return v
        return cut(body)

    def _once(self, name):
        with self.server.lock:
            first = name not in self.server.seen
            self.server.seen.add(name)
        return first

    def do_POST(self):
        path = self.path.split("?")[0]
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            body = None
        if path == "/api/ai/chat/completions":
            return self._chat(body)
        if path not in ("/api/ai/images/edit", "/api/ai/images/generate"):
            self._record({"size": len(raw)})
            self._send(404, {"error": {"message": "Not found: POST " + path}})
            return
        pics = pictures_of(body) if isinstance(body, dict) else []
        decoded = [(f, decode(v)) for f, v in pics]
        self._record(self._shown(body) if isinstance(body, dict) else {"size": len(raw)}, [summary(f, d) for f, (d, _) in decoded if d])
        if not self._bearer():
            self._send(401, envelope("unauthenticated", "Missing or invalid API key"))
            return
        if not isinstance(body, dict):
            self._send(400, envelope("invalid_params", "The body is not JSON."))
            return
        model = str(body.get("model") or "")
        if model.startswith("mock-"):
            if self._synthetic(model):
                return
        elif model not in SCHEMAS:
            self._send(404, {"error": {"message": "Model not found: " + model}})
            return
        else:
            rest = {k: v for k, v in body.items() if k not in ("model", "response_format")}
            bad = validate(SCHEMAS[model], rest)
            if bad:
                self._send(400, envelope("invalid_params", "; ".join(bad[:5])))
                return
        refused = [why for _f, (d, why) in decoded if d is None]
        if refused or model == "mock-no-dataurl":
            self._send(400, envelope("invalid_params", "403 Client Error: Forbidden for url: " + (refused[0] if refused else "data:image/png;base64,iVBORw0KGgo")))
            return
        data = self._answer(model, body, [d for _f, (d, _) in decoded if d and _f != "mask_url"])
        as_url = body.get("response_format") in (None, "url") or model in ("mock-url", "mock-url-auth")
        if model == "mock-empty":
            self._send(200, {"model": model, "created": 1789000000, "images": []})
        elif as_url:
            with self.server.lock:
                n = len(self.server.files) + 1
                self.server.files[n] = (data, model == "mock-url-auth")
            self._send(200, {"model": model, "created": 1789000000, "images": [{"url": "%s/api/repos/mock/files/%d.png?sig=x" % (self.server.url, n)}]})
        else:
            self._send(200, {"model": model, "created": 1789000000, "images": [{"b64_json": base64.b64encode(data).decode("ascii")}]})

    def _synthetic(self, model):
        """True when a synthetic model answered with a failure."""
        if model == "mock-402":
            self._send(402, envelope("insufficient_credits", "Insufficient credits"))
        elif model == "mock-429" and self._once(model):
            self._send(429, envelope("rate_limited", "Too many requests"), headers={"Retry-After": "1"})
        elif model == "mock-429-long":
            self._send(429, envelope("rate_limited", "Too many requests"), headers={"Retry-After": "120"})
        elif model == "mock-503" and self._once(model):
            self._send(503, envelope("service_unavailable", "Busy"))
        elif model == "mock-502":
            self._send(502, envelope("bad_gateway", "The model's host failed"))
        elif model == "mock-500":
            self._send(500, envelope("unknown_error", "Something went wrong"))
        elif model == "mock-200-error":
            self._send(200, {"error": {"message": "generation failed"}})
        else:
            return False
        return True

    def _answer(self, model, body, pictures):
        if model in UPSCALERS:
            dims = png_size(pictures[0]) if pictures else None
            w, h = dims or (256, 256)
            key = UPSCALERS[model]
            f = str(body.get(key) or "2x").rstrip("x") if key else "2"
            k = int(float(f)) if f else 2
            return png_bytes(w * k, h * k, frame=True)
        if pictures:
            return pictures[0]
        w, h = text_size(body)
        return png_bytes(w, h)

    def _chat(self, body):
        c = self._record(self._shown(body) if isinstance(body, dict) else None)
        if not self._bearer():
            self._send(401, envelope("unauthenticated", "Missing or invalid API key"))
            return
        if not isinstance(body, dict):
            self._send(400, envelope("invalid_params", "The body is not JSON."))
            return
        model = str(body.get("model") or "")
        msgs = body.get("messages") or []
        content = msgs[0].get("content") if msgs and isinstance(msgs[0], dict) else ""
        image = isinstance(content, list) and any(isinstance(p, dict) and p.get("type") == "image_url" for p in content)
        text = content if isinstance(content, str) else " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
        with self.server.lock:
            self.server.chats.append({"auth": c["headers"].get("authorization"), "image": image, "body": c.get("json")})
        if model not in CHAT_MODELS:
            self._send(404, {"error": {"message": "Model not found: " + model}})
            return
        words = " ".join((text or "").split()[:5])
        self._send(200, {
            "id": "mock-1", "object": "chat.completion", "model": model,
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": f"{words} UPSAMPLED, image: {'yes' if image else 'no'}"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })

    def do_GET(self):
        path = self.path.split("?")[0]
        self._record()
        m = re.match(r"^/api/repos/mock/files/(\d+)\.png$", path)
        with self.server.lock:
            f = self.server.files.get(int(m.group(1))) if m else None
        if not f:
            self._send(404, {"error": {"message": "Not found: GET " + path}})
            return
        data, needs_key = f
        if needs_key and not self._bearer():
            self._send(401, envelope("unauthenticated", "This file needs a key"))
            return
        self._send(200, data, ctype="image/png")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    server = Mock(port)
    print("mock Oxen.ai on", server.url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
