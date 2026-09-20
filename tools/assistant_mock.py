"""A scripted mock model server for tools/assistant_test.py (the `assistant` gate).

It plays the four API families the assistant speaks (docs/PLAN_ASSISTANT.md, A4 "tools/assistant_mock.py"
and section 6 "The mock") and every Chat Completions dialect, on 127.0.0.1:0 with `Connection: close`,
like tools/llm_mock.py, which stays byte-identical so the `llm` gate does. Routes, by the END of the path
(the assistant keeps each provider's own path under the loopback base):

    POST .../v1/messages                                  Anthropic Messages
    POST .../chat/completions                             Chat Completions; the dialect is the row named
                                                          in the Bearer key (test-gate-<row>-0000), no
                                                          Authorization header is the local server
    POST .../v1/responses                                 OpenAI Responses
    POST .../v1beta/models/<m>:streamGenerateContent      Gemini generateContent
    GET  /api/v1/models[?supported_parameters=tools]      OpenRouter's model list (`models`)
    GET  .../models                                       the local server's list (`compat_models`)
    GET  .../providers                                    OpenRouter's hosts (`providers`)

A POST pops the next scripted `Turn` and answers it as the family's SSE stream in the dialect's shape,
with a reasoning part that must come back (a `thinking` block with `sig-<n>`, `encrypted_content`
`enc-<n>`, `thoughtSignature` `ts-<n>`, `reasoning_content` `rc-<n>` or OpenRouter's
`reasoning_details`), written in chunks cut at arbitrary byte offsets, inside event lines and inside
UTF-8 sequences. Every request is recorded raw (`raw()`), with its headers (`post_headers()`) and in a
normalised shape that is the same for all four families (`transcript()`), so the gate can assert what
was sent, and to whom, without reading each family's own JSON.

    from assistant_mock import Mock, Turn
    m = Mock().start()
    m.push(Turn(expect=lambda r: r["tools"] == ["select_rect"], answer={"tool_calls": [{"name": "select_rect", "args": {...}}]}))

    python tools/assistant_mock.py --selftest       exercises every route against itself
    python tools/assistant_mock.py [port]           runs it standalone (default 8798) for trying the panel
                                                    by hand; an empty queue then echoes the user's text
"""
import json
import re
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

CHUNK_SIZES = [1, 3, 7, 40, 200, 5]     # the stream is written in chunks of these sizes, cycled
CHAT_DIALECTS = ("openrouter", "deepseek", "moonshot", "zai", "toapis", "wavespeed", "compat")
DIALECTS = ("anthropic",) + CHAT_DIALECTS + ("responses", "gemini")
FAMILY_OF_DIALECT = {"anthropic": "messages", "responses": "responses", "gemini": "gemini"}   # the rest: "chat"

# The eight curated ids of the openrouter entry in electron/main/assistant/providers.js (2026-09-19).
CURATED_OPENROUTER = [
    ("anthropic/claude-sonnet-5", "Claude Sonnet 5"),
    ("anthropic/claude-opus-5", "Claude Opus 5"),
    ("openai/gpt-5.6-terra", "GPT-5.6 Terra"),
    ("google/gemini-3.8-flash", "Gemini 3.8 Flash"),
    ("deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
    ("moonshotai/kimi-k3", "Kimi K3"),
    ("moonshotai/kimi-k2.6", "Kimi K2.6"),
    ("z-ai/glm-5.3-flash", "GLM-5.3-Flash"),
]


def openrouter_row(model_id, name=None, modalities=("text", "image"), params=("tools", "reasoning", "max_tokens")):
    """One row of OpenRouter's GET /api/v1/models, as the assistant reads it."""
    return {
        "id": model_id,
        "name": name or model_id,
        "architecture": {"input_modalities": list(modalities), "output_modalities": ["text"]},
        "pricing": {"prompt": "0.000002", "completion": "0.00001"},
        "supported_parameters": list(params),
        "context_length": 200000,
    }


def default_models():
    rows = [openrouter_row(i, n) for i, n in CURATED_OPENROUTER]
    rows.append(openrouter_row("free/blind-model", "Blind Model (free)", modalities=("text",), params=("tools", "max_tokens")))
    rows.append(openrouter_row("free/no-tools", "No Tools (free)", params=("max_tokens",)))
    return rows


def default_providers():
    return [
        {"slug": "alibaba", "headquarters": "CN", "datacenters": ["SG", "CN"]},
        {"slug": "mockhost-cn", "headquarters": "CN", "datacenters": []},
        {"slug": "fine-host", "headquarters": "US", "datacenters": ["US"]},
    ]


class Turn:
    """One scripted answer.

    answer      {"text": "..."} and/or {"tool_calls": [{"name", "args", "id"?}, ...]}; an id defaults to
                call_<n>_<i> (n the 1-based POST number, i the 0-based position)
    expect      a callable on the normalised request: None / True is ok, False or a string is a failure
                (recorded in failures(); the answer is served anyway)
    status      answer this HTTP status with `body` (a dict as JSON, a str as is) and `headers` instead
                of a stream
    delay_ms    sleep before the first byte
    dialect     force the rendering (one of DIALECTS); None derives it from the request
    reasoning   whether the stream carries the reasoning part that must come back
    usage       an override of the usage object (merged over the family's default)
    """

    def __init__(self, expect=None, answer=None, status=None, delay_ms=0, headers=None, body=None,
                 dialect=None, reasoning=True, usage=None):
        if dialect is not None and dialect not in DIALECTS:
            raise ValueError(f"unknown dialect {dialect!r}; one of {', '.join(DIALECTS)}")
        self.expect = expect
        self.answer = answer or {}
        self.status = status
        self.delay_ms = delay_ms or 0
        self.headers = dict(headers or {})
        self.body = body
        self.dialect = dialect
        self.reasoning = bool(reasoning)
        self.usage = usage


class Mock(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=0):
        super().__init__(("127.0.0.1", port), Handler)
        self.lock = threading.Lock()
        self._thread = None
        self._queue = deque()
        self._transcript = []       # normalised requests, in order
        self._raw = []              # the parsed JSON bodies
        self._headers = []          # {lowercase name: value} per POST
        self._gets = []             # GET paths with their query
        self._failures = []
        self.models = default_models()
        self.compat_models = ["mock-agent"]
        self.providers = default_providers()
        # A Turn, or a callable(normalised request) -> Turn, used when the queue is empty. None (the
        # default, and what the gate wants) answers HTTP 500 and records a failure. The standalone
        # server sets an echo, so the panel can be tried by hand.
        self.fallback = None

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

    def push(self, *turns):
        with self.lock:
            for t in turns:
                if isinstance(t, (list, tuple)):
                    for u in t:
                        self._push_one(u)
                else:
                    self._push_one(t)

    def _push_one(self, t):
        if not isinstance(t, Turn):
            raise TypeError("push() takes Turn objects")
        self._queue.append(t)

    def transcript(self):
        with self.lock:
            return list(self._transcript)

    def raw(self):
        with self.lock:
            return list(self._raw)

    def post_headers(self):
        with self.lock:
            return list(self._headers)

    def gets(self):
        with self.lock:
            return list(self._gets)

    def failures(self):
        with self.lock:
            return list(self._failures)

    def pending(self):
        """How many scripted turns are still queued."""
        with self.lock:
            return len(self._queue)

    def reset(self):
        """Forget the scripted turns and what was sent; the failures stay.

        A step resets the mock between two turns of its own (`families` does it per provider).
        The failures are what the runner reads to fail that step, and it reads them by the index
        it saw at the step's start: clearing them here made every failure after the first one in
        the run invisible.
        """
        with self.lock:
            self._queue.clear()
            self._transcript.clear()
            self._raw.clear()
            self._headers.clear()
            self._gets.clear()

    # ---- used by the handler ----------------------------------------------------------------

    def fail(self, text):
        with self.lock:
            self._failures.append(text)

    def record_get(self, path):
        with self.lock:
            self._gets.append(path)

    def record_post(self, path, headers, body, family, dialect):
        """Normalise and record one POST; returns the normalised request (with its number)."""
        with self.lock:
            n = len(self._transcript) + 1
            req = normalise(n, path, headers, body, family, dialect)
            self._transcript.append(req)
            self._raw.append(body)
            self._headers.append(headers)
            return req

    def take_turn(self, req):
        with self.lock:
            if self._queue:
                return self._queue.popleft()
            fb = self.fallback
        if fb is None:
            return None
        return fb(req) if callable(fb) else fb


# ---- routing ------------------------------------------------------------------------------------

def _path_only(path):
    return urlsplit(path).path


def route_post(path, headers):
    """(family, dialect) of a POST, or (None, None) for a path the mock does not serve."""
    p = _path_only(path)
    if p.endswith("/v1/messages"):
        return "messages", "anthropic"
    if p.endswith(":streamGenerateContent") or p.endswith(":generateContent"):
        return "gemini", "gemini"
    if p.endswith("/v1/responses"):
        return "responses", "responses"
    if p.endswith("/chat/completions"):
        return "chat", chat_dialect(p, headers)
    return None, None


def chat_dialect(path, headers):
    """The row a gate key names (test-gate-<row>-0000); no key is the local server; else by the path."""
    auth = headers.get("authorization") or ""
    if not auth.strip():
        return "compat"
    key = auth.split(None, 1)[1].strip() if " " in auth.strip() else auth.strip()
    m = re.match(r"^test-gate-([a-z0-9]+)-", key)
    if m and m.group(1) in CHAT_DIALECTS:
        return m.group(1)
    for d in CHAT_DIALECTS:
        if d in key:
            return d
    if path.endswith("/api/v1/chat/completions"):
        return "openrouter"
    if path.endswith("/api/paas/v4/chat/completions"):
        return "zai"
    if path == "/chat/completions":
        return "deepseek"
    return "compat"


def key_of(headers):
    auth = headers.get("authorization")
    if auth:
        a = auth.strip()
        return a.split(None, 1)[1].strip() if a.lower().startswith("bearer ") else a
    return headers.get("x-api-key") or headers.get("x-goog-api-key") or None


# ---- normalisation ------------------------------------------------------------------------------

def _message(role):
    return {"role": role, "text": "", "images": 0, "tool_calls": [], "tool_results": [], "reasoning": {}}


def _args_of(value):
    """function.arguments: an object as it is, a JSON string parsed, a broken string kept as it is."""
    if isinstance(value, dict):
        return value
    if value is None or value == "":
        return {}
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _chat_parts(content):
    """(joined text, count of image_url parts) of a Chat Completions content: a string or parts."""
    if content is None:
        return "", 0
    if isinstance(content, str):
        return content, 0
    texts, images = [], 0
    for part in content:
        if not isinstance(part, dict):
            continue
        t = part.get("type")
        if t == "text":
            texts.append(part.get("text") or "")
        elif t == "image_url":
            images += 1
    return "\n".join(texts), images


def normalise_messages(body):
    system = body.get("system")
    if isinstance(system, list):
        system = "\n".join(b.get("text") or "" for b in system if isinstance(b, dict) and b.get("type") == "text")
    elif system is None:
        system = ""
    else:
        system = str(system)
    tools = [t.get("name") for t in body.get("tools") or [] if isinstance(t, dict)]
    messages = []
    for m in body.get("messages") or []:
        if not isinstance(m, dict):
            continue
        msg = _message(m.get("role"))
        content = m.get("content")
        if isinstance(content, str):
            msg["text"] = content
        else:
            texts = []
            for b in content or []:
                if not isinstance(b, dict):
                    continue
                t = b.get("type")
                if t == "text":
                    texts.append(b.get("text") or "")
                elif t == "image":
                    msg["images"] += 1
                elif t == "tool_use":
                    inp = b.get("input")
                    msg["tool_calls"].append({"id": b.get("id"), "name": b.get("name"), "args": inp if isinstance(inp, dict) else (inp or {})})
                elif t == "thinking":
                    msg["reasoning"].setdefault("thinking", []).append({"text": b.get("thinking") or "", "signature": b.get("signature")})
                elif t == "redacted_thinking":
                    msg["reasoning"].setdefault("redacted_thinking", []).append(b.get("data"))
                elif t == "tool_result":
                    c = b.get("content")
                    if isinstance(c, str):
                        rtext, image = c, False
                    else:
                        parts = [p for p in c or [] if isinstance(p, dict)]
                        rtext = "\n".join(p.get("text") or "" for p in parts if p.get("type") == "text")
                        image = any(p.get("type") == "image" for p in parts)
                    msg["tool_results"].append({"id": b.get("tool_use_id"), "text": rtext, "is_error": bool(b.get("is_error")), "image": image})
            msg["text"] = "\n".join(texts)
        messages.append(msg)
    return system, tools, messages


def normalise_chat(body):
    system = None
    tools = []
    for t in body.get("tools") or []:
        if isinstance(t, dict):
            fn = t.get("function") if isinstance(t.get("function"), dict) else t
            tools.append(fn.get("name"))
    messages = []
    for m in body.get("messages") or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        text, images = _chat_parts(m.get("content"))
        if role == "system" and system is None:
            system = text          # the first system message; a later one stays in the list
            continue
        msg = _message(role)
        msg["text"] = text
        msg["images"] = images
        if role == "assistant":
            for tc in m.get("tool_calls") or []:
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
                msg["tool_calls"].append({"id": tc.get("id"), "name": fn.get("name"), "args": _args_of(fn.get("arguments"))})
            for k in ("reasoning_content", "reasoning_details", "reasoning"):
                if k in m:
                    msg["reasoning"][k] = m[k]
        elif role == "tool":
            msg["tool_results"].append({"id": m.get("tool_call_id"), "text": text, "is_error": text.startswith("Error:"), "image": images > 0})
        messages.append(msg)
    return system if system is not None else "", tools, messages


def _responses_parts(content):
    """(joined text, count of input_image parts) of a Responses content or output: a string or parts."""
    if content is None:
        return "", 0
    if isinstance(content, str):
        return content, 0
    texts, images = [], 0
    for part in content:
        if not isinstance(part, dict):
            continue
        t = part.get("type")
        if t in ("input_text", "output_text", "text"):
            texts.append(part.get("text") or "")
        elif t == "refusal":
            texts.append(part.get("refusal") or "")
        elif t == "input_image":
            images += 1
    return "\n".join(texts), images


def normalise_responses(body):
    system = body.get("instructions") or ""
    tools = [t.get("name") for t in body.get("tools") or [] if isinstance(t, dict)]
    items = body.get("input")
    if isinstance(items, str):
        items = [{"type": "message", "role": "user", "content": items}]
    messages = []
    open_assistant = [None]     # the assistant message the model's consecutive output items merge into

    def assistant():
        if open_assistant[0] is None:
            open_assistant[0] = _message("assistant")
            messages.append(open_assistant[0])
        return open_assistant[0]

    for it in items or []:
        if not isinstance(it, dict):
            continue
        t = it.get("type") or ("message" if "role" in it else None)
        if t == "message":
            role = it.get("role")
            text, images = _responses_parts(it.get("content"))
            if role == "assistant":
                msg = assistant()
                msg["text"] = f"{msg['text']}\n{text}" if msg["text"] and text else (msg["text"] or text)
                msg["images"] += images
            else:
                open_assistant[0] = None
                msg = _message(role)
                msg["text"] = text
                msg["images"] = images
                messages.append(msg)
        elif t == "function_call":
            assistant()["tool_calls"].append({"id": it.get("call_id"), "name": it.get("name"), "args": _args_of(it.get("arguments"))})
        elif t == "reasoning":
            assistant()["reasoning"].setdefault("encrypted_content", []).append(it.get("encrypted_content"))
        elif t == "function_call_output":
            open_assistant[0] = None
            text, images = _responses_parts(it.get("output"))
            msg = _message("tool")
            msg["text"] = text
            msg["images"] = images
            msg["tool_results"].append({"id": it.get("call_id"), "text": text, "is_error": text.startswith("Error:"), "image": images > 0})
            messages.append(msg)
    return system, tools, messages


def normalise_gemini(body):
    si = body.get("systemInstruction")
    if isinstance(si, str):
        system = si
    elif isinstance(si, dict):
        system = "\n".join(p.get("text") or "" for p in si.get("parts") or [] if isinstance(p, dict) and "text" in p)
    else:
        system = ""
    tools = []
    for t in body.get("tools") or []:
        if isinstance(t, dict):
            for fd in t.get("functionDeclarations") or []:
                if isinstance(fd, dict):
                    tools.append(fd.get("name"))
    messages = []
    for c in body.get("contents") or []:
        if not isinstance(c, dict):
            continue
        role = c.get("role") or "user"
        msg = _message("assistant" if role == "model" else role)
        texts = []
        for p in c.get("parts") or []:
            if not isinstance(p, dict):
                continue
            if "thoughtSignature" in p:
                msg["reasoning"].setdefault("thoughtSignature", []).append(p["thoughtSignature"])
            if "functionCall" in p:
                fc = p["functionCall"] or {}
                msg["tool_calls"].append({"id": fc.get("id"), "name": fc.get("name"), "args": fc.get("args") or {}})
            elif "functionResponse" in p:
                fr = p["functionResponse"] or {}
                resp = fr.get("response")
                image = any(isinstance(q, dict) and "inlineData" in q for q in fr.get("parts") or [])
                msg["tool_results"].append({
                    "id": fr.get("id"), "text": json.dumps(resp, ensure_ascii=False),
                    "is_error": isinstance(resp, dict) and "error" in resp, "image": image,
                })
            elif "inlineData" in p:
                msg["images"] += 1
            elif "text" in p:
                texts.append(p.get("text") or "")
        msg["text"] = "\n".join(texts)
        messages.append(msg)
    return system, tools, messages


def normalise(n, path, headers, body, family, dialect):
    body = body if isinstance(body, dict) else {}
    model = body.get("model")
    if family == "messages":
        system, tools, messages = normalise_messages(body)
    elif family == "chat":
        system, tools, messages = normalise_chat(body)
    elif family == "responses":
        system, tools, messages = normalise_responses(body)
    elif family == "gemini":
        system, tools, messages = normalise_gemini(body)
        m = re.search(r"/models/([^/:?]+):", _path_only(path))
        model = m.group(1) if m else model
    else:
        system, tools, messages = "", [], []
    return {
        "n": n, "family": family, "dialect": dialect, "path": path, "headers": headers,
        "key": key_of(headers), "model": model, "system": system, "tools": tools, "messages": messages,
    }


# ---- rendering ----------------------------------------------------------------------------------

def _dumps(obj):
    return json.dumps(obj, ensure_ascii=False)


def _event(name, data):
    return f"event: {name}\ndata: {_dumps(data)}\n\n"


def _data(obj):
    return f"data: {_dumps(obj)}\n\n"


def _pieces(text, n=3):
    """Up to n non-empty pieces of a text, for deltas."""
    text = text or ""
    if not text:
        return []
    step = max(1, -(-len(text) // n))
    return [text[i:i + step] for i in range(0, len(text), step)]


def _split_json(s):
    if len(s) < 4:
        return [s]
    at = len(s) // 2
    return [s[:at], s[at:]]


def calls_of(turn, n):
    """The turn's tool calls with their ids filled in."""
    out = []
    for i, c in enumerate(turn.answer.get("tool_calls") or []):
        out.append({
            "id": c.get("id") or f"call_{n}_{i}",
            "name": c.get("name") or "",
            "args": c.get("args") if isinstance(c.get("args"), dict) else (c.get("args") or {}),
        })
    return out


def render_anthropic(turn, n, model):
    text = turn.answer.get("text") or ""
    calls = calls_of(turn, n)
    start_usage = {"input_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 1}
    delta_usage = {"output_tokens": 20, "output_tokens_details": {"thinking_tokens": 0}}
    if turn.usage:
        start_usage.update(turn.usage)
        delta_usage.update(turn.usage)
    out = []
    out.append(_event("message_start", {"type": "message_start", "message": {
        "id": f"msg_{n}", "type": "message", "role": "assistant", "model": model, "content": [],
        "stop_reason": None, "stop_sequence": None, "usage": start_usage}}))
    index = 0
    if turn.reasoning:
        out.append(_event("content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "thinking", "thinking": ""}}))
        out.append(_event("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "thinking_delta", "thinking": f"thinking {n}"}}))
        out.append(_event("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "signature_delta", "signature": f"sig-{n}"}}))
        out.append(_event("content_block_stop", {"type": "content_block_stop", "index": index}))
        index += 1
    if text:
        out.append(_event("content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}))
        for piece in _pieces(text):
            out.append(_event("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": piece}}))
        out.append(_event("content_block_stop", {"type": "content_block_stop", "index": index}))
        index += 1
    for call in calls:
        out.append(_event("content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "tool_use", "id": call["id"], "name": call["name"], "input": {}}}))
        for piece in _split_json(_dumps(call["args"])):
            out.append(_event("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": piece}}))
        out.append(_event("content_block_stop", {"type": "content_block_stop", "index": index}))
        index += 1
    out.append(_event("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use" if calls else "end_turn", "stop_sequence": None}, "usage": delta_usage}))
    out.append(_event("message_stop", {"type": "message_stop"}))
    return "".join(out)


def render_chat(turn, n, model, dialect):
    text = turn.answer.get("text") or ""
    calls = calls_of(turn, n)
    created = int(time.time())

    def wrap(delta, finish=None):
        return {"id": f"chatcmpl-{n}", "object": "chat.completion.chunk", "created": created, "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}

    chunks = [_data(wrap({"role": "assistant", "content": ""}))]
    if turn.reasoning:
        if dialect == "openrouter":
            chunks.append(_data(wrap({"reasoning_details": [{"type": "reasoning.text", "text": f"rd-{n}", "id": f"rd-{n}", "format": "unknown"}]})))
        else:
            chunks.append(_data(wrap({"reasoning_content": "rc-"})))
            chunks.append(_data(wrap({"reasoning_content": str(n)})))
    for piece in _pieces(text):
        chunks.append(_data(wrap({"content": piece})))
    for i, call in enumerate(calls):
        chunks.append(_data(wrap({"tool_calls": [{"index": i, "id": call["id"], "type": "function", "function": {"name": call["name"], "arguments": ""}}]})))
        for piece in _split_json(_dumps(call["args"])):
            chunks.append(_data(wrap({"tool_calls": [{"index": i, "function": {"arguments": piece}}]})))
    finish = "tool_calls" if calls else "stop"
    usage = {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
    if dialect == "openrouter":
        usage["cost"] = 0.0012
    if turn.usage:
        usage.update(turn.usage)
    if dialect == "moonshot":
        chunks.append(_data(wrap({}, finish)))
        chunks.append(_data({"id": f"chatcmpl-{n}", "object": "chat.completion.chunk", "created": created, "model": model, "choices": [], "usage": usage}))
    else:
        last = wrap({}, finish)
        last["usage"] = usage
        chunks.append(_data(last))
    if dialect == "deepseek":
        chunks = [c + ": keep-alive\n\n" for c in chunks]
    chunks.append("data: [DONE]\n\n")
    return "".join(chunks)


def render_responses(turn, n, model):
    text = turn.answer.get("text") or ""
    calls = calls_of(turn, n)
    usage = {"input_tokens": 100, "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
             "output_tokens": 20, "output_tokens_details": {"reasoning_tokens": 0}}
    if turn.usage:
        usage.update(turn.usage)
    out = []
    seq = [0]

    def ev(name, data):
        data = dict(data)
        data["type"] = name
        data["sequence_number"] = seq[0]
        seq[0] += 1
        out.append(_event(name, data))

    ev("response.created", {"response": {"id": f"resp_{n}", "object": "response", "status": "in_progress", "model": model, "output": []}})
    items = []
    if turn.reasoning:
        item = {"type": "reasoning", "id": f"rs_{n}", "encrypted_content": f"enc-{n}", "summary": []}
        ev("response.output_item.added", {"output_index": len(items), "item": item})
        ev("response.output_item.done", {"output_index": len(items), "item": item})
        items.append(item)
    if text:
        at = len(items)
        item_id = f"msg_{n}"
        ev("response.output_item.added", {"output_index": at, "item": {"type": "message", "id": item_id, "status": "in_progress", "role": "assistant", "content": []}})
        for piece in _pieces(text):
            ev("response.output_text.delta", {"item_id": item_id, "output_index": at, "content_index": 0, "delta": piece})
        ev("response.output_text.done", {"item_id": item_id, "output_index": at, "content_index": 0, "text": text})
        item = {"type": "message", "id": item_id, "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": text, "annotations": []}]}
        ev("response.output_item.done", {"output_index": at, "item": item})
        items.append(item)
    for i, call in enumerate(calls):
        at = len(items)
        item_id = f"fc_{n}_{i}"
        args = _dumps(call["args"])
        ev("response.output_item.added", {"output_index": at, "item": {"type": "function_call", "id": item_id, "call_id": call["id"], "name": call["name"], "arguments": "", "status": "in_progress"}})
        for piece in _split_json(args):
            ev("response.function_call_arguments.delta", {"item_id": item_id, "output_index": at, "delta": piece})
        ev("response.function_call_arguments.done", {"item_id": item_id, "output_index": at, "arguments": args})
        item = {"type": "function_call", "id": item_id, "call_id": call["id"], "name": call["name"], "arguments": args, "status": "completed"}
        ev("response.output_item.done", {"output_index": at, "item": item})
        items.append(item)
    ev("response.completed", {"response": {"id": f"resp_{n}", "object": "response", "status": "completed", "model": model, "output": items, "usage": usage}})
    return "".join(out)


def render_gemini(turn, n, model):
    text = turn.answer.get("text") or ""
    calls = calls_of(turn, n)
    usage = {"promptTokenCount": 100, "candidatesTokenCount": 20, "thoughtsTokenCount": 5, "totalTokenCount": 125}
    if turn.usage:
        usage.update(turn.usage)
    parts = []
    if turn.reasoning:
        parts.append({"text": "", "thoughtSignature": f"ts-{n}"})
    for piece in _pieces(text):
        parts.append({"text": piece})
    for call in calls:
        parts.append({"functionCall": {"id": call["id"], "name": call["name"], "args": call["args"]}})
    chunks = []
    slots = parts or [None]
    for k, part in enumerate(slots):
        candidate = {"content": {"role": "model", "parts": [part] if part is not None else []}, "index": 0}
        resp = {"candidates": [candidate], "modelVersion": model, "responseId": f"r{n}"}
        if k == len(slots) - 1:
            candidate["finishReason"] = "STOP"
            resp["usageMetadata"] = usage
        chunks.append(_data(resp))
    return "".join(chunks)


def render(turn, req):
    """The SSE text of a turn, in the family and dialect the turn forces or the request implies."""
    dialect = turn.dialect or req["dialect"]
    family = FAMILY_OF_DIALECT.get(dialect, "chat")
    n = req["n"]
    model = req.get("model") or "mock-agent"
    if family == "messages":
        return render_anthropic(turn, n, model)
    if family == "responses":
        return render_responses(turn, n, model)
    if family == "gemini":
        return render_gemini(turn, n, model)
    return render_chat(turn, n, model, dialect)


# ---- the handler --------------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_a):
        pass

    def _send(self, code, payload, headers=None, content_type="application/json"):
        if isinstance(payload, (bytes, bytearray)):
            data = bytes(payload)
        elif isinstance(payload, str):
            data = payload.encode("utf-8")
        else:
            data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, str(v))
        # no keep-alive: a pooled connection would outlive stop() (the rule of llm_mock.py)
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(data)

    def _stream(self, text):
        """Write an SSE body in chunks cut at arbitrary byte offsets, a flush after each."""
        data = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        at = 0
        k = 0
        try:
            while at < len(data):
                size = CHUNK_SIZES[k % len(CHUNK_SIZES)]
                k += 1
                self.wfile.write(data[at:at + size])
                self.wfile.flush()
                at += size
        except OSError:
            pass    # the client went away; nothing to do

    def do_GET(self):
        server = self.server
        server.record_get(self.path)
        parts = urlsplit(self.path)
        p = parts.path.rstrip("/")
        if p.endswith("/models"):
            if p.startswith("/api/v1"):
                rows = list(server.models)
                wanted = parse_qs(parts.query).get("supported_parameters")
                if wanted:
                    names = [w for item in wanted for w in item.split(",") if w]
                    rows = [r for r in rows if all(w in (r.get("supported_parameters") or []) for w in names)]
                self._send(200, {"data": rows})
            else:
                self._send(200, {"object": "list", "data": [{"id": m, "object": "model"} for m in server.compat_models]})
        elif p.endswith("/providers"):
            self._send(200, {"data": list(server.providers)})
        else:
            self._send(404, {"error": {"message": "no route " + self.path}})

    def do_POST(self):
        server = self.server
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send(400, {"error": {"message": "body is not JSON"}})
            return
        headers = {k.lower(): v for k, v in self.headers.items()}
        family, dialect = route_post(self.path, headers)
        req = server.record_post(self.path, headers, body, family, dialect)
        if family is None:
            server.fail(f"no route for POST {self.path}")
            self._send(404, {"error": {"message": "no route " + self.path}})
            return
        turn = server.take_turn(req)
        if turn is None:
            server.fail(f"no turn scripted for {self.path}")
            self._send(500, {"error": {"message": "the mock has no turn scripted"}})
            return
        if turn.expect is not None:
            try:
                verdict = turn.expect(req)
            except Exception as err:       # noqa: BLE001 - the gate reads failures(), not a traceback
                verdict = f"expect raised on request {req['n']}: {err!r}"
            if verdict is False:
                server.fail(f"expect failed on request {req['n']}")
            elif isinstance(verdict, str):
                server.fail(verdict)
        if turn.delay_ms:
            time.sleep(turn.delay_ms / 1000.0)
        if turn.status is not None:
            body_out = turn.body if turn.body is not None else {"error": {"message": f"mock answered {turn.status}"}}
            self._send(int(turn.status), body_out, headers=turn.headers)
            return
        try:
            text = render(turn, req)
        except Exception as err:           # noqa: BLE001 - a bad answer script is the gate's bug
            server.fail(f"render failed on request {req['n']}: {err!r}")
            self._send(500, {"error": {"message": f"the mock could not render the turn: {err!r}"}})
            return
        self._stream(text)


# ---- the selftest -------------------------------------------------------------------------------

def parse_sse(text):
    """[(event name or 'message', joined data)] and the comment lines of an SSE body."""
    events, comments = [], []
    name, data = "", []
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if not line:
            if data:
                events.append((name or "message", "\n".join(data)))
            name, data = "", []
            continue
        if line.startswith(":"):
            comments.append(line)
            continue
        colon = line.find(":")
        field, value = (line, "") if colon < 0 else (line[:colon], line[colon + 1:])
        if value.startswith(" "):
            value = value[1:]
        if field == "event":
            name = value
        elif field == "data":
            data.append(value)
    if data:
        events.append((name or "message", "\n".join(data)))
    return events, comments


def selftest():
    import urllib.error
    import urllib.request

    server = Mock().start()
    seen = []
    checks = [0]

    def ok(label):
        checks[0] += 1
        print(f"[ok] {label}")

    def check(cond, label):
        if not cond:
            raise AssertionError(label)

    def expect(req):
        seen.append(req)
        return req["tools"] == ["select_rect"]

    dash = chr(0x2013)
    answer = {"text": "Auswahl gesetzt " + dash + " fertig", "tool_calls": [{"name": "select_rect", "args": {"x": 10, "y": 20, "w": 100, "h": 80}}]}

    def post(path, body, headers=None):
        req = urllib.request.Request(server.url + path, data=json.dumps(body).encode("utf-8"), method="POST")
        req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, dict((k.lower(), v) for k, v in r.getheaders()), r.read().decode("utf-8")

    def get(path):
        with urllib.request.urlopen(server.url + path, timeout=10) as r:
            return r.status, json.loads(r.read().decode("utf-8"))

    def datas(text):
        events, comments = parse_sse(text)
        out = []
        for name, data in events:
            if data == "[DONE]":
                out.append((name, "[DONE]"))
            else:
                out.append((name, json.loads(data)))     # every data line but [DONE] is JSON
        return out, comments

    tool_chat = [{"type": "function", "function": {"name": "select_rect", "description": "", "parameters": {"type": "object", "properties": {}}}}]
    chat_body = {"model": "m", "stream": True, "max_tokens": 100,
                 "messages": [{"role": "system", "content": "You drive Scumble."},
                              {"role": "user", "content": [{"type": "text", "text": "state note"}, {"type": "text", "text": "select the sky"}]}],
                 "tools": tool_chat}

    try:
        # 1: Anthropic
        server.push(Turn(expect=expect, answer=answer))
        body = {"model": "claude-sonnet-5", "max_tokens": 100, "stream": True,
                "system": [{"type": "text", "text": "You drive Scumble."}],
                "tools": [{"name": "select_rect", "description": "", "input_schema": {"type": "object", "properties": {}}}],
                "messages": [{"role": "user", "content": [{"type": "text", "text": "state note"}, {"type": "text", "text": "select the sky"}]}]}
        status, headers, text = post("/v1/messages", body, {"x-api-key": "test-gate-anthropic-0000", "anthropic-version": "2023-06-01"})
        check(status == 200 and headers.get("content-type", "").startswith("text/event-stream"), "anthropic: not an event stream")
        check(headers.get("connection") == "close", "anthropic: Connection is not close")
        events, _ = datas(text)
        names = [e[0] for e in events]
        check(names[0] == "message_start" and names[-1] == "message_stop", f"anthropic: event order {names}")
        starts = [d for n_, d in events if n_ == "content_block_start"]
        check(starts[0]["content_block"]["type"] == "thinking", "anthropic: no thinking block first")
        sigs = [d["delta"]["signature"] for n_, d in events if n_ == "content_block_delta" and d["delta"]["type"] == "signature_delta"]
        check(sigs == ["sig-1"], f"anthropic: signatures {sigs}")
        joined_text = "".join(d["delta"]["text"] for n_, d in events if n_ == "content_block_delta" and d["delta"]["type"] == "text_delta")
        check(joined_text == answer["text"], f"anthropic: text {joined_text!r}")
        tool_starts = [d["content_block"] for d in starts if d["content_block"]["type"] == "tool_use"]
        check(tool_starts and tool_starts[0]["id"] == "call_1_0" and tool_starts[0]["name"] == "select_rect", "anthropic: tool_use block")
        frags = "".join(d["delta"]["partial_json"] for n_, d in events if n_ == "content_block_delta" and d["delta"]["type"] == "input_json_delta")
        check(json.loads(frags) == answer["tool_calls"][0]["args"], "anthropic: input_json_delta pieces")
        stop = [d for n_, d in events if n_ == "message_delta"][0]
        check(stop["delta"]["stop_reason"] == "tool_use" and stop["usage"]["output_tokens"] == 20, "anthropic: message_delta")
        t = server.transcript()[-1]
        check(t["family"] == "messages" and t["dialect"] == "anthropic" and t["n"] == 1, "anthropic: family/dialect")
        check(t["key"] == "test-gate-anthropic-0000" and t["model"] == "claude-sonnet-5", "anthropic: key/model")
        check(t["system"] == "You drive Scumble." and t["messages"][0]["role"] == "user", "anthropic: system/messages")
        check(t["messages"][0]["text"] == "state note\nselect the sky", "anthropic: joined text parts")
        ok("anthropic stream and transcript")

        # 2: OpenRouter
        server.push(Turn(expect=expect, answer=answer))
        status, headers, text = post("/api/v1/chat/completions", chat_body, {"Authorization": "Bearer test-gate-openrouter-0000"})
        events, _ = datas(text)
        chunks = [d for _n, d in events if d != "[DONE]"]
        check(events[-1][1] == "[DONE]", "openrouter: no [DONE]")
        check(chunks[0]["choices"][0]["delta"] == {"role": "assistant", "content": ""}, "openrouter: first chunk")
        rd = [c["choices"][0]["delta"]["reasoning_details"] for c in chunks if "reasoning_details" in c["choices"][0]["delta"]]
        check(rd and rd[0][0]["text"] == "rd-2", f"openrouter: reasoning_details {rd}")
        joined_text = "".join(c["choices"][0]["delta"].get("content") or "" for c in chunks)
        check(joined_text == answer["text"], f"openrouter: text {joined_text!r}")
        tcs = [tc for c in chunks for tc in c["choices"][0]["delta"].get("tool_calls") or []]
        check(tcs[0]["id"] == "call_2_0" and tcs[0]["function"]["name"] == "select_rect", "openrouter: tool call head")
        check(json.loads("".join(tc["function"]["arguments"] for tc in tcs)) == answer["tool_calls"][0]["args"], "openrouter: arguments")
        last = chunks[-1]
        check(last["choices"][0]["finish_reason"] == "tool_calls" and last["usage"]["cost"] == 0.0012, "openrouter: last chunk")
        t = server.transcript()[-1]
        check(t["family"] == "chat" and t["dialect"] == "openrouter" and t["system"] == "You drive Scumble.", "openrouter: transcript")
        check(server.post_headers()[-1]["authorization"] == "Bearer test-gate-openrouter-0000", "openrouter: header record")
        ok("openrouter stream and transcript")

        # 3: DeepSeek
        server.push(Turn(expect=expect, answer=answer))
        status, headers, text = post("/chat/completions", chat_body, {"Authorization": "Bearer test-gate-deepseek-0000"})
        events, comments = datas(text)
        check(comments and all(c == ": keep-alive" for c in comments), f"deepseek: comments {comments[:3]}")
        chunks = [d for _n, d in events if d != "[DONE]"]
        rc = "".join(c["choices"][0]["delta"].get("reasoning_content") or "" for c in chunks)
        check(rc == "rc-3", f"deepseek: reasoning_content {rc!r}")
        check(server.transcript()[-1]["dialect"] == "deepseek", "deepseek: dialect")
        ok("deepseek stream with keep-alive lines")

        # 4: Moonshot
        server.push(Turn(expect=expect, answer=answer))
        status, headers, text = post("/v1/chat/completions", chat_body, {"Authorization": "Bearer test-gate-moonshot-0000"})
        events, _ = datas(text)
        chunks = [d for _n, d in events if d != "[DONE]"]
        check(chunks[-1]["choices"] == [] and chunks[-1]["usage"]["prompt_tokens"] == 100, "moonshot: usage chunk")
        check(chunks[-2]["choices"][0]["finish_reason"] == "tool_calls" and "usage" not in chunks[-2], "moonshot: finish chunk")
        check(server.transcript()[-1]["dialect"] == "moonshot", "moonshot: dialect")
        ok("moonshot stream with the choices: [] usage chunk")

        # 5: the local server, no key
        server.push(Turn(expect=expect, answer={"text": "plain"}))
        status, headers, text = post("/v1/chat/completions", chat_body)
        events, _ = datas(text)
        chunks = [d for _n, d in events if d != "[DONE]"]
        check(chunks[-1]["choices"][0]["finish_reason"] == "stop", "compat: finish stop")
        rc = "".join(c["choices"][0]["delta"].get("reasoning_content") or "" for c in chunks)
        check(rc == "rc-5", f"compat: reasoning_content {rc!r}")
        t = server.transcript()[-1]
        check(t["dialect"] == "compat" and t["key"] is None, "compat: dialect/key")
        ok("compat stream without a key")

        # 6: Responses
        server.push(Turn(expect=expect, answer=answer))
        body = {"model": "gpt-5.6-terra", "stream": True, "store": False, "instructions": "You drive Scumble.",
                "tools": [{"type": "function", "name": "select_rect", "parameters": {"type": "object", "properties": {}}, "strict": False}],
                "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "select the sky"}]},
                          {"type": "reasoning", "id": "rs_0", "encrypted_content": "enc-0", "summary": []},
                          {"type": "function_call", "id": "fc_0_0", "call_id": "call_0_0", "name": "select_rect", "arguments": "{\"x\": 1}"},
                          {"type": "function_call_output", "call_id": "call_0_0",
                           "output": [{"type": "input_text", "text": "ok"}, {"type": "input_image", "image_url": "data:image/jpeg;base64,AAAA", "detail": "auto"}]}]}
        status, headers, text = post("/v1/responses", body, {"Authorization": "Bearer test-gate-openai-0000"})
        events, _ = datas(text)
        names = [e[0] for e in events]
        check(names[0] == "response.created" and names[-1] == "response.completed", f"responses: order {names}")
        done_items = [d["item"] for n_, d in events if n_ == "response.output_item.done"]
        check(done_items[0]["type"] == "reasoning" and done_items[0]["encrypted_content"] == "enc-6", "responses: reasoning item")
        check(done_items[1]["type"] == "message" and done_items[1]["content"][0]["text"] == answer["text"], "responses: message item")
        check(done_items[2]["type"] == "function_call" and done_items[2]["call_id"] == "call_6_0" and json.loads(done_items[2]["arguments"]) == answer["tool_calls"][0]["args"], "responses: call item")
        deltas = "".join(d["delta"] for n_, d in events if n_ == "response.function_call_arguments.delta")
        check(deltas == done_items[2]["arguments"], "responses: argument deltas")
        completed = events[-1][1]["response"]
        check(completed["status"] == "completed" and completed["usage"]["input_tokens"] == 100, "responses: completed")
        t = server.transcript()[-1]
        check(t["family"] == "responses" and t["system"] == "You drive Scumble." and t["tools"] == ["select_rect"], "responses: transcript head")
        m = t["messages"]
        check(m[0]["role"] == "user" and m[0]["text"] == "select the sky", "responses: user item")
        check(m[1]["role"] == "assistant" and m[1]["reasoning"] == {"encrypted_content": ["enc-0"]} and m[1]["tool_calls"] == [{"id": "call_0_0", "name": "select_rect", "args": {"x": 1}}], "responses: assistant items merged")
        check(m[2]["role"] == "tool" and m[2]["tool_results"] == [{"id": "call_0_0", "text": "ok", "is_error": False, "image": True}], "responses: function_call_output")
        ok("responses stream and transcript")

        # 7: Gemini
        server.push(Turn(expect=expect, answer=answer))
        body = {"systemInstruction": {"parts": [{"text": "You drive Scumble."}]},
                "contents": [{"role": "user", "parts": [{"text": "select the sky"}]},
                             {"role": "model", "parts": [{"text": "", "thoughtSignature": "ts-0"}, {"functionCall": {"id": "call_0_0", "name": "select_rect", "args": {"x": 1}}}]},
                             {"role": "user", "parts": [{"functionResponse": {"id": "call_0_0", "name": "select_rect", "response": {"result": "ok"},
                                                                              "parts": [{"inlineData": {"mimeType": "image/jpeg", "displayName": "shot", "data": "AAAA"}}]}}]}],
                "tools": [{"functionDeclarations": [{"name": "select_rect", "parametersJsonSchema": {"type": "object"}}]}],
                "generationConfig": {"maxOutputTokens": 100}}
        status, headers, text = post("/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse", body, {"x-goog-api-key": "test-gate-gemini-0000"})
        events, _ = datas(text)
        parts = [d["candidates"][0]["content"]["parts"][0] for _n, d in events]
        check(parts[0] == {"text": "", "thoughtSignature": "ts-7"}, f"gemini: signature part {parts[0]}")
        joined_text = "".join(p.get("text") or "" for p in parts)
        check(joined_text == answer["text"], f"gemini: text {joined_text!r}")
        check(parts[-1]["functionCall"] == {"id": "call_7_0", "name": "select_rect", "args": answer["tool_calls"][0]["args"]}, "gemini: functionCall part")
        last = events[-1][1]
        check(last["candidates"][0]["finishReason"] == "STOP" and last["usageMetadata"]["thoughtsTokenCount"] == 5, "gemini: last chunk")
        check(all("finishReason" not in d["candidates"][0] for _n, d in events[:-1]), "gemini: finishReason only on the last chunk")
        t = server.transcript()[-1]
        check(t["family"] == "gemini" and t["model"] == "gemini-3.8-flash" and t["key"] == "test-gate-gemini-0000", "gemini: head")
        check(t["path"].endswith("?alt=sse") and t["tools"] == ["select_rect"], "gemini: path/tools")
        m = t["messages"]
        check(m[1]["role"] == "assistant" and m[1]["reasoning"] == {"thoughtSignature": ["ts-0"]} and m[1]["tool_calls"][0]["args"] == {"x": 1}, "gemini: model content")
        check(m[2]["tool_results"] == [{"id": "call_0_0", "text": "{\"result\": \"ok\"}", "is_error": False, "image": True}], "gemini: functionResponse")
        ok("gemini stream and transcript")

        # 8: a Chat replay: tool_calls, reasoning_content, a tool error, a screenshot in a user message
        server.push(Turn(expect=expect, answer={"text": "done"}, reasoning=False))
        body = dict(chat_body)
        body["messages"] = chat_body["messages"] + [
            {"role": "assistant", "content": "", "reasoning_content": "rc-3",
             "tool_calls": [{"id": "call_3_0", "type": "function", "function": {"name": "select_rect", "arguments": "{\"x\": 10}"}}]},
            {"role": "tool", "tool_call_id": "call_3_0", "content": "Error: no document"},
            {"role": "user", "content": [{"type": "text", "text": "Screenshot from call call_3_0"}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}}]},
        ]
        status, headers, text = post("/chat/completions", body, {"Authorization": "Bearer test-gate-deepseek-0000"})
        events, _ = datas(text)
        chunks = [d for _n, d in events if d != "[DONE]"]
        check(not any("reasoning_content" in c["choices"][0]["delta"] for c in chunks), "replay: reasoning=False sent reasoning")
        m = server.transcript()[-1]["messages"]
        check(m[1]["role"] == "assistant" and m[1]["tool_calls"] == [{"id": "call_3_0", "name": "select_rect", "args": {"x": 10}}], "replay: tool_calls")
        check(m[1]["reasoning"] == {"reasoning_content": "rc-3"}, "replay: reasoning field")
        check(m[2]["role"] == "tool" and m[2]["tool_results"] == [{"id": "call_3_0", "text": "Error: no document", "is_error": True, "image": False}], "replay: tool result")
        check(m[3]["role"] == "user" and m[3]["images"] == 1 and m[3]["text"] == "Screenshot from call call_3_0", "replay: screenshot message")
        ok("chat replay normalised")

        # 9: an Anthropic replay: thinking + tool_use, a tool_result with an image and is_error
        server.push(Turn(expect=expect, answer={"text": "done"}))
        body = {"model": "claude-sonnet-5", "max_tokens": 100, "stream": True, "system": [{"type": "text", "text": "s"}],
                "tools": [{"name": "select_rect", "input_schema": {"type": "object"}}],
                "messages": [{"role": "user", "content": [{"type": "text", "text": "go"}]},
                             {"role": "assistant", "content": [{"type": "thinking", "thinking": "thinking 1", "signature": "sig-1"},
                                                               {"type": "tool_use", "id": "call_1_0", "name": "select_rect", "input": {"x": 10}}]},
                             {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call_1_0", "is_error": True,
                                                           "content": [{"type": "text", "text": "Error: nope"}, {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "AAAA"}}]}]}]}
        status, headers, text = post("/v1/messages", body, {"x-api-key": "test-gate-anthropic-0000"})
        m = server.transcript()[-1]["messages"]
        check(m[1]["reasoning"] == {"thinking": [{"text": "thinking 1", "signature": "sig-1"}]}, "anthropic replay: thinking")
        check(m[1]["tool_calls"] == [{"id": "call_1_0", "name": "select_rect", "args": {"x": 10}}], "anthropic replay: tool_use")
        check(m[2]["role"] == "user" and m[2]["tool_results"] == [{"id": "call_1_0", "text": "Error: nope", "is_error": True, "image": True}], "anthropic replay: tool_result")
        ok("anthropic replay normalised")

        # the GETs
        status, j = get("/api/v1/models?supported_parameters=tools")
        ids = [r["id"] for r in j["data"]]
        check(all(i in ids for i, _ in CURATED_OPENROUTER) and "free/blind-model" in ids and "free/no-tools" not in ids, f"models: filtered list {ids}")
        blind = [r for r in j["data"] if r["id"] == "free/blind-model"][0]
        check(blind["architecture"]["input_modalities"] == ["text"] and "reasoning" not in blind["supported_parameters"], "models: blind row")
        status, j = get("/api/v1/models")
        check("free/no-tools" in [r["id"] for r in j["data"]], "models: unfiltered list lacks free/no-tools")
        status, j = get("/v1/models")
        check(j == {"object": "list", "data": [{"id": "mock-agent", "object": "model"}]}, f"compat models: {j}")
        status, j = get("/api/v1/providers")
        check([p["slug"] for p in j["data"]] == ["alibaba", "mockhost-cn", "fine-host"], "providers: rows")
        check(server.gets() == ["/api/v1/models?supported_parameters=tools", "/api/v1/models", "/v1/models", "/api/v1/providers"], f"gets: {server.gets()}")
        try:
            get("/nowhere")
            check(False, "an unknown GET answered 200")
        except urllib.error.HTTPError as e:
            check(e.code == 404, "an unknown GET is not 404")
        ok("GET routes")

        # every expect ran and none failed
        check(len(seen) == 9 and server.failures() == [], f"expects: {len(seen)} ran, failures {server.failures()}")
        check(len(server.transcript()) == 9 and len(server.raw()) == 9 and len(server.post_headers()) == 9, "records misaligned")
        check([r["n"] for r in server.transcript()] == list(range(1, 10)), "numbering")
        ok("every expect ran, records aligned")

        # an empty queue
        try:
            post("/v1/messages", {"model": "m", "messages": []}, {"x-api-key": "test-gate-anthropic-0000"})
            check(False, "an empty queue answered 200")
        except urllib.error.HTTPError as e:
            check(e.code == 500, f"empty queue: HTTP {e.code}")
            check(json.loads(e.read().decode("utf-8"))["error"]["message"] == "the mock has no turn scripted", "empty queue: body")
        check(server.failures() == ["no turn scripted for /v1/messages"], f"empty queue: failures {server.failures()}")
        ok("an empty queue answers 500 and records a failure")

        # a failing expect, a string verdict, and a raw error answer with headers
        server.push(Turn(expect=lambda r: False, status=429, headers={"retry-after": "1"}, body={"error": {"message": "slow down"}}))
        try:
            post("/api/v1/chat/completions", chat_body, {"Authorization": "Bearer test-gate-openrouter-0000"})
            check(False, "the 429 turn answered 200")
        except urllib.error.HTTPError as e:
            check(e.code == 429 and e.headers.get("retry-after") == "1", f"429: code {e.code}, headers {dict(e.headers)}")
            check(e.headers.get("content-type") == "application/json", "429: content type")
            check(json.loads(e.read().decode("utf-8")) == {"error": {"message": "slow down"}}, "429: body")
        check(server.failures()[-1] == "expect failed on request 11", f"429: failures {server.failures()}")
        server.push(Turn(expect=lambda r: "the key went to the wrong place", status=401, body="not json at all"))
        try:
            post("/api/v1/chat/completions", chat_body, {"Authorization": "Bearer test-gate-openrouter-0000"})
        except urllib.error.HTTPError as e:
            check(e.code == 401 and e.read().decode("utf-8") == "not json at all", "401: raw string body")
        check(server.failures()[-1] == "the key went to the wrong place", "a string verdict is recorded as is")
        ok("status/body/headers turns and expect verdicts")

        # a forced dialect, a delay, and a usage override
        server.push(Turn(answer={"text": "x"}, dialect="moonshot", delay_ms=120, usage={"prompt_tokens": 7}))
        t0 = time.time()
        status, headers, text = post("/v1/chat/completions", chat_body)      # no key: compat by the request
        check(time.time() - t0 >= 0.1, "delay_ms was not waited")
        events, _ = datas(text)
        chunks = [d for _n, d in events if d != "[DONE]"]
        check(chunks[-1]["choices"] == [] and chunks[-1]["usage"]["prompt_tokens"] == 7 and chunks[-1]["usage"]["completion_tokens"] == 20, "forced moonshot dialect / usage override")
        check(server.transcript()[-1]["dialect"] == "compat", "the transcript keeps the request's own dialect")
        ok("forced dialect, delay and usage override")

        # bad JSON
        req = urllib.request.Request(server.url + "/v1/messages", data=b"{not json", method="POST")
        try:
            urllib.request.urlopen(req, timeout=10)
            check(False, "bad JSON answered 200")
        except urllib.error.HTTPError as e:
            check(e.code == 400, "bad JSON is not 400")
        ok("bad JSON answers 400")

        # reset: the scripted turns and the records go, the failures stay (the runner reads
        # them by the index it saw when the step started)
        server.push(Turn(answer={"text": "x"}))
        server.fail("a failure the step must still see")
        had = len(server.failures())
        server.reset()
        check(server.pending() == 0 and server.transcript() == [] and server.raw() == [] and server.post_headers() == [] and server.gets() == [], "reset left something")
        check(len(server.failures()) == had and server.failures()[-1] == "a failure the step must still see", "reset dropped a failure")
        ok("reset clears the queue and every record")

        # the fallback (standalone mode)
        server.fallback = lambda r: Turn(answer={"text": "echo: " + r["messages"][-1]["text"]}, reasoning=False)
        had = len(server.failures())
        status, headers, text = post("/v1/chat/completions", chat_body)
        events, _ = datas(text)
        joined_text = "".join(d["choices"][0]["delta"].get("content") or "" for _n, d in events if d != "[DONE]")
        check(joined_text == "echo: state note\nselect the sky" and len(server.failures()) == had, "fallback answer")
        server.fallback = None
        ok("fallback turn for standalone use")
    except AssertionError as err:
        print(f"FAIL: {err}")
        server.stop()
        return 1
    except Exception as err:      # noqa: BLE001
        print(f"FAIL: {type(err).__name__}: {err}")
        server.stop()
        return 1
    server.stop()
    print(f"PASS ({checks[0]} groups)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        sys.exit(selftest())
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8798
    server = Mock(port)
    server.fallback = lambda r: Turn(answer={"text": "(mock) you said: " + (r["messages"][-1]["text"] if r["messages"] else "")}, reasoning=False)
    print("mock model server on", server.url, "(every family; an empty queue echoes the user's text)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
