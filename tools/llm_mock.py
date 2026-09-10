"""A mock OpenAI-compatible server for tools/llm_test.py.

Answers the two routes electron/main/llm.js talks to:

    GET  /v1/models             {"data": [{"id": "mock-vision"}, {"id": "mock-text"}]}
    POST /v1/chat/completions   the instruction's first five words + " UPSAMPLED, image: yes|no"

Model `mock-text` refuses a request that carries an `image_url` part with HTTP 400, the way
a text-only model does, so the adapter's retry-without-image can be tested. Every request
body is appended to `requests` so the test can assert what was sent.

    python tools/llm_mock.py [port]     runs it standalone for poking at by hand
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = ["mock-vision", "mock-text"]


class Mock(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.requests = []          # every POST body, in order
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

    def record(self, body):
        with self.lock:
            self.requests.append(body)

    def posts(self):
        with self.lock:
            return list(self.requests)


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
        self.server.record(body)
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._send(404, {"error": {"message": "no route " + self.path}})
            return
        model = body.get("model") or ""
        image = has_image(body)
        if model == "mock-text" and image:
            self._send(400, {"error": {"message": "image input is not supported by this model"}})
            return
        if model not in MODELS:
            self._send(404, {"error": {"message": f"model '{model}' not found"}})
            return
        words = " ".join((instruction_of(body) or "").split()[:5])
        text = f"{words} UPSAMPLED, image: {'yes' if image else 'no'}"
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
