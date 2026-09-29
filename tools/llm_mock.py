"""A mock OpenAI-compatible server for tools/llm_test.py.

Answers the two routes electron/main/llm.js talks to:

    GET  /v1/models             {"data": [{"id": "mock-vision"}, {"id": "mock-text"}, {"id": "mock-one"}]}
    POST /v1/chat/completions   the instruction's first five words + " UPSAMPLED, image: yes|no, images: N",
                                then the distinct @img tokens of the instruction (" @img1 @img2")

N is the number of `image_url` parts (the crop and the reference pictures, item 26 step 26d2);
echoing the tokens keeps them in the rewrite, so the editor's token check stays quiet.
Model `mock-text` refuses a request that carries an `image_url` part with HTTP 400, the way
a text-only model does, so the adapter's retry-without-image can be tested. Model `mock-one`
takes one picture per request and refuses more with HTTP 400 ("only one image per request is
supported"), so the steps all pictures -> crop only can be tested; it echoes no tokens. The
three ToAPIs upsample models (electron/main/llm.js) answer like `mock-vision`, so the same
server plays ToAPIs' Chat Completions. Every request body is appended to `requests`, its
Authorization header to `auths`, so the test can assert what was sent and with which key.

    python tools/llm_mock.py [port]     runs it standalone for poking at by hand
"""
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = ["mock-vision", "mock-text", "mock-one"]
TOAPIS_MODELS = ["gemini-3.8-flash", "claude-haiku-4-5", "gpt-5.6-terra"]


class Mock(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.requests = []          # every POST body, in order
        self.auths = []             # the Authorization header of each, or None
        self.lock = threading.Lock()
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

    def record(self, body, auth=None):
        with self.lock:
            self.requests.append(body)
            self.auths.append(auth)

    def posts(self):
        with self.lock:
            return list(self.requests)

    def post_auths(self):
        with self.lock:
            return list(self.auths)


def has_image(body):
    return images_of(body) > 0


def images_of(body):
    """The number of `image_url` parts of a request: the crop and the reference pictures."""
    n = 0
    for m in body.get("messages") or []:
        content = m.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    n += 1
    return n


def tokens_of(text):
    """The distinct @img tokens of a text, in the order they first appear."""
    out = []
    for t in re.findall(r"@img\d+", text or ""):
        if t not in out:
            out.append(t)
    return out


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


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_a):
        pass

    def _send(self, code, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        # no keep-alive: a pooled connection would outlive stop() and the offline step of
        # llm_test.py would still be served by the handler thread that is already running
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/") == "/v1/models":
            self._send(200, {"object": "list", "data": [{"id": m, "object": "model"} for m in MODELS]})
        else:
            self._send(404, {"error": {"message": "no route " + self.path}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            self._send(400, {"error": {"message": "body is not JSON"}})
            return
        self.server.record(body, self.headers.get("Authorization"))
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._send(404, {"error": {"message": "no route " + self.path}})
            return
        model = body.get("model") or ""
        n = images_of(body)
        image = n > 0
        if model == "mock-text" and image:
            self._send(400, {"error": {"message": "image input is not supported by this model"}})
            return
        if model == "mock-one" and n > 1:
            self._send(400, {"error": {"message": "only one image per request is supported"}})
            return
        if model not in MODELS and model not in TOAPIS_MODELS:
            self._send(404, {"error": {"message": f"model '{model}' not found"}})
            return
        instruction = instruction_of(body) or ""
        words = " ".join(instruction.split()[:5])
        text = f"{words} UPSAMPLED, image: {'yes' if image else 'no'}, images: {n}"
        tokens = [] if model == "mock-one" else tokens_of(instruction)
        if tokens:
            text += " " + " ".join(tokens)
        self._send(200, {
            "id": "mock-1", "object": "chat.completion", "model": model,
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": text}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    server = Mock(port)
    print("mock OpenAI-compatible server on", server.url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
