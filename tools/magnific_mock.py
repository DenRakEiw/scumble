"""A mock of Magnific's API (api.magnific.com) for tools/magnific_test.py (the pattern of tools/comfyrouter_mock.py).

Answers the routes electron/main/providers/magnific.js talks to, on 127.0.0.1 (the only base besides api.magnific.com
that the adapter accepts, through settings.magnific.base, and the only one a "test-" key goes to):

    POST /v1/ai/<route>            401 { message: "Missing API key" } without x-magnific-api-key; the body checked
                                   against the route's request schema (tools/refs/magnific/<route>.json: no unknown
                                   field, the required ones, enums, bounds, base64 that decodes, and all four edges on
                                   Image Expand), 400 application/problem+json { problem: { message: "Validation
                                   error", invalid_params: [{ name, reason }] } } on a violation; else
                                   { data: { task_id, status: "CREATED", generated: [] } }
    GET  /v1/ai/<route>/<task id>  IN_PROGRESS on the first read, then COMPLETED with generated [<mock>/asset/<id>.png]
                                   (Mystic adds has_nsfw: [false])
    GET  /asset/<id>.png           the answer: an edit gets its first picture back as it went out (Ideogram its
                                   `image`), a text run a PNG of the shape it asked for (FLUX width x height, a preset
                                   at its tier, Z-Image its image_size), Image Expand a PNG of the kept part plus the
                                   four margins whose rightmost 8 px column is magenta (255, 0, 255)
    POST /v1/ai/uploads/request-url   not served: the uploads (M1b) are not built

Prompt triggers: `mock-400` the problem answer, `mock-402` 402 { message: "Not enough credits" }, `mock-429` a first
POST 429 with Retry-After: 1, `mock-503-long` 503 with Retry-After: 120, `mock-failed` FAILED, `mock-empty` COMPLETED
with no picture, `mock-poll-500` two 500s on the status reads, `mock-download-500` one 500 on the asset, `mock-nsfw`
has_nsfw [true], `mock-aspect` the Image Expand answer 1.024 times wider.

Every request is recorded with its method, path, all its headers (names lowercased) and its JSON body, the pictures
summarised (format, size, bytes; a PNG mask also its centre and corner values). Every answer closes its connection.

    python tools/magnific_mock.py [port]     runs it standalone for poking at by hand
"""
import base64
import json
import os
import re
import struct
import sys
import threading
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PNG_SIGNATURE = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
REFS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "refs", "magnific")
PICTURE_FIELDS = ("image", "mask", "input_image", "input_image_2", "input_image_3", "input_image_4")
LIST_FIELDS = ("reference_images", "style_reference_images")
EXPAND = ("image-expand/flux-pro", "image-expand/ideogram", "image-expand/seedream-v4-5")
SEEDREAM_SIZES = {"square_1_1": (2048, 2048), "widescreen_16_9": (2730, 1536), "social_story_9_16": (1536, 2730), "portrait_2_3": (1664, 2496),
                  "traditional_3_4": (1792, 2390), "standard_3_2": (2496, 1664), "classic_4_3": (2390, 1792), "cinematic_21_9": (3062, 1312)}
ZIMAGE_SIZES = {"square": (512, 512), "square_hd": (1024, 1024), "portrait_3_4": (768, 1024), "portrait_9_16": (576, 1024), "landscape_4_3": (1024, 768), "landscape_16_9": (1024, 576)}
TIERS = {"1k": 1024, "1.5k": 1536, "2k": 2048, "4k": 4096}


def load_schemas():
    out = {}
    for name in os.listdir(REFS):
        if name.endswith(".json"):
            with open(os.path.join(REFS, name), encoding="utf-8") as f:
                doc = json.load(f)
            out[doc["route"]] = doc["schema"]
    return out


SCHEMAS = load_schemas()


# ---- pictures ---------------------------------------------------------------------------------------------------

def png_bytes(w, h, rgb=(60, 120, 90), marker=0):
    """A plain RGB PNG of w x h in one colour; `marker` > 0 paints that many columns on the right magenta."""
    left = bytes(rgb) * max(0, w - marker)
    right = bytes((255, 0, 255)) * min(marker, w)
    row = b"\x00" + left + right
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


def jpeg_size(data):
    """[w, h] from a JPEG's SOF marker, else None."""
    if not data or data[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        m = data[i + 1]
        if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return [w, h]
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
    return None


def fmt_of(data):
    if png_size(data):
        return "png"
    if data[:2] == b"\xff\xd8":
        return "jpeg"
    if len(data) > 12 and data[8:12] == b"WEBP":
        return "webp"
    return "other"


def dims_of(data):
    return png_size(data) or jpeg_size(data)


def pixels_at(data, points):
    """Channel 0 of an 8-bit grey, grey+alpha, RGB or RGBA PNG (no interlace) at each (x, y) of `points`, else None.
    A pixel's filter reads only what lies left of it and above it, so only that part of the rows is unfiltered."""
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
    if depth != 8 or not ch or interlace:
        return None
    raw = zlib.decompress(b"".join(idat))
    stride = w * ch
    xmax = min(stride, (max(x for x, _ in points) + 1) * ch)
    ymax = min(h, max(y for _, y in points) + 1)
    rows, prev = [], bytearray(xmax)
    for y in range(ymax):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:y * (stride + 1) + 1 + xmax])
        for x in range(xmax):
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
    return [rows[y][x * ch] for x, y in points]


def b64decode(value):
    try:
        return base64.b64decode(str(value or ""), validate=True)
    except ValueError:
        return None


def summary(field, data):
    s = {"field": field, "format": fmt_of(data), "size": len(data), "dims": dims_of(data)}
    if field == "mask" and s["dims"]:
        w, h = s["dims"]
        got = pixels_at(data, [(w // 2, h // 2), (2, 2)])
        if got:
            s["centre"], s["corner"] = got
    return s


def pictures_of(body):
    out = []
    for k in PICTURE_FIELDS:
        if isinstance(body.get(k), str):
            out.append((k, b64decode(body[k])))
    for k in LIST_FIELDS:
        for v in body.get(k) or []:
            out.append((k, b64decode(v)))
    return out


# ---- the request schemas ----------------------------------------------------------------------------------------

def flat(s):
    if not isinstance(s, dict) or "allOf" not in s:
        return s
    out = {"type": "object", "properties": {}, "required": []}
    for p in s["allOf"]:
        p = flat(p)
        out["properties"].update(p.get("properties") or {})
        out["required"] += p.get("required") or []
    return out


def validate(s, v, at="body"):
    s = flat(s)
    if not isinstance(s, dict):
        return []
    out = []
    for k in ("anyOf", "oneOf"):
        if k in s and not any(not validate(x, v, at) for x in s[k]):
            out.append({"name": at, "reason": "matches none of " + k})
    t = s.get("type")
    is_t = {"string": isinstance(v, str), "integer": isinstance(v, int) and not isinstance(v, bool), "number": isinstance(v, (int, float)) and not isinstance(v, bool),
            "boolean": isinstance(v, bool), "array": isinstance(v, list), "object": isinstance(v, dict)}
    if t and not is_t.get(t, True):
        return out + [{"name": at, "reason": "must be of type " + t}]
    if "enum" in s and v not in s["enum"]:
        out.append({"name": at, "reason": "must be one of " + ", ".join(map(str, s["enum"]))})
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if "minimum" in s and v < s["minimum"]:
            out.append({"name": at, "reason": "must be at least %s" % s["minimum"]})
        if "maximum" in s and v > s["maximum"]:
            out.append({"name": at, "reason": "must be at most %s" % s["maximum"]})
    if isinstance(v, str):
        if "maxLength" in s and len(v) > s["maxLength"]:
            out.append({"name": at, "reason": "too long"})
        if "minLength" in s and len(v) < s["minLength"]:
            out.append({"name": at, "reason": "too short"})
    if isinstance(v, list):
        if "minItems" in s and len(v) < s["minItems"]:
            out.append({"name": at, "reason": "at least %d items" % s["minItems"]})
        if "maxItems" in s and len(v) > s["maxItems"]:
            out.append({"name": at, "reason": "at most %d items" % s["maxItems"]})
        for i, x in enumerate(v):
            out += validate(s.get("items") or {}, x, "%s[%d]" % (at, i))
    if isinstance(v, dict) and (s.get("properties") or t == "object"):
        props = s.get("properties") or {}
        for r in s.get("required") or []:
            if r not in v:
                out.append({"name": at + "." + r, "reason": "is required"})
        for k, x in v.items():
            if k in props:
                out += validate(props[k], x, at + "." + k)
            elif s.get("additionalProperties") is not True:
                out.append({"name": at + "." + k, "reason": "unknown field"})
    return out


def problems(route, body):
    bad = validate(SCHEMAS[route], body)
    if route in EXPAND:
        for edge in ("left", "right", "top", "bottom"):
            if edge not in body:
                bad.append({"name": "body." + edge, "reason": "Scumble always sends all four edges"})
    for field, data in pictures_of(body):
        if data is None or not data:
            bad.append({"name": "body." + field, "reason": "not base64 of a picture"})
    return bad


# ---- the server -------------------------------------------------------------------------------------------------

class Mock(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.lock = threading.Lock()
        self.calls = []
        self.every_call = []
        self.tasks = {}       # task id -> { route, body, reads, poll500, download500 }
        self.busy = set()
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
            self.tasks.clear()
            self.busy.clear()


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

    def _authorised(self):
        if not (self.headers.get("x-magnific-api-key") or "").strip():
            self._send(401, {"message": "Missing API key"})
            return False
        return True

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

    def do_POST(self):
        path = self.path.split("?")[0]
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            body = None
        route = path[len("/v1/ai/"):] if path.startswith("/v1/ai/") else ""
        pics = pictures_of(body) if isinstance(body, dict) else []
        self._record(self._shown(body) if isinstance(body, dict) else {"size": len(raw)}, [summary(f, d) for f, d in pics if d])
        if route not in SCHEMAS:
            self._send(404, {"message": "Not found: POST " + path})
            return
        if not self._authorised():
            return
        if not isinstance(body, dict):
            self._send(400, {"message": "The body is not JSON."})
            return
        prompt = str(body.get("prompt") or "")
        if "mock-402" in prompt:
            self._send(402, {"message": "Not enough credits"})
            return
        if "mock-503-long" in prompt:
            self._send(503, {"message": "Service Unavailable. Please try again later."}, headers={"Retry-After": "120"})
            return
        if "mock-429" in prompt:
            with self.server.lock:
                first = "429" not in self.server.busy
                self.server.busy.add("429")
            if first:
                self._send(429, {"message": "Too many requests"}, headers={"Retry-After": "1"})
                return
        bad = problems(route, body)
        if "mock-400" in prompt:
            bad = bad or [{"name": "prompt", "reason": "mock-400 was asked for"}]
        if bad:
            self._send(400, {"problem": {"message": "Validation error", "invalid_params": bad[:10]}}, ctype="application/problem+json")
            return
        tid = str(uuid.uuid4())
        with self.server.lock:
            self.server.tasks[tid] = {"route": route, "body": body, "reads": 0, "poll500": 2 if "mock-poll-500" in prompt else 0, "download500": 1 if "mock-download-500" in prompt else 0}
        self._send(200, {"data": {"task_id": tid, "status": "CREATED", "generated": []}})

    def do_GET(self):
        path = self.path.split("?")[0]
        self._record()
        m = re.match(r"^/asset/([0-9a-f-]{36})\.png$", path)
        if m:
            with self.server.lock:
                t = self.server.tasks.get(m.group(1))
                fail = bool(t and t["download500"] > 0)
                if fail:
                    t["download500"] -= 1
            if not t:
                self._send(404, {"message": "no such asset"})
            elif fail:
                self._send(500, {"message": "Internal Server Error"})
            else:
                data = self._answer(t["route"], t["body"])
                self._send(200, data, ctype={"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}.get(fmt_of(data), "application/octet-stream"))
            return
        m = re.match(r"^/v1/ai/(.+)/([0-9a-f-]{36})$", path)
        if not m or m.group(1) not in SCHEMAS:
            self._send(404, {"message": "Not found: GET " + path})
            return
        if not self._authorised():
            return
        with self.server.lock:
            t = self.server.tasks.get(m.group(2))
            if t and t["route"] == m.group(1):
                t["reads"] += 1
                reads = t["reads"]
                poll500 = t["poll500"] > 0
                if poll500:
                    t["poll500"] -= 1
        if not t or t["route"] != m.group(1):
            self._send(404, {"message": "Task not found"})
            return
        if poll500:
            self._send(500, {"message": "Internal Server Error"})
            return
        prompt = str(t["body"].get("prompt") or "")
        data = {"task_id": m.group(2), "status": "IN_PROGRESS", "generated": []}
        if reads > 1:
            if "mock-failed" in prompt:
                data["status"] = "FAILED"
            else:
                data["status"] = "COMPLETED"
                data["generated"] = [] if "mock-empty" in prompt else ["%s/asset/%s.png" % (self.server.url, m.group(2))]
        if t["route"] == "mystic":
            data["has_nsfw"] = [True] if "mock-nsfw" in prompt else [False]
        self._send(200, {"data": data})

    def do_PUT(self):
        self._record()
        self._send(404, {"message": "Not found: PUT " + self.path})

    def _answer(self, route, body):
        """The picture a finished task links to."""
        prompt = str(body.get("prompt") or "")
        if route in EXPAND:
            img = b64decode(body.get("image")) or b""
            w, h = dims_of(img) or (256, 256)
            W = w + int(body.get("left") or 0) + int(body.get("right") or 0)
            H = h + int(body.get("top") or 0) + int(body.get("bottom") or 0)
            if "mock-aspect" in prompt:
                W = round(W * 1.024)
            return png_bytes(W, H, marker=8)
        if route == "ideogram-image-edit":
            return b64decode(body.get("image"))
        pics = pictures_of(body)
        if pics and pics[0][1]:
            return pics[0][1]
        if route.startswith("text-to-image/flux-2-"):
            return png_bytes(int(body.get("width") or 1024), int(body.get("height") or 768))
        if route == "text-to-image/z-image":
            return png_bytes(*ZIMAGE_SIZES.get(body.get("image_size"), (1024, 1024)))
        aspect = str(body.get("aspect_ratio") or "square_1_1")
        if route.startswith("text-to-image/seedream-"):
            w, h = SEEDREAM_SIZES.get(aspect, (2048, 2048))
            if body.get("resolution") == "1.5k":
                w, h = round(w * 0.75), round(h * 0.75)
            return png_bytes(w, h)
        mm = re.search(r"_(\d+)_(\d+)$", aspect)
        a, b = (int(mm.group(1)), int(mm.group(2))) if mm else (1, 1)
        long = TIERS.get(str(body.get("resolution") or "1k").lower(), 1024)
        w, h = (long, round(long * b / a)) if a >= b else (round(long * a / b), long)
        return png_bytes(w, h)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8798
    server = Mock(port)
    print("mock Magnific on", server.url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
