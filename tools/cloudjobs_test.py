"""A Comfy Cloud job back after a crash (docs/PLAN_COMFY_SDK.md S6), in the app itself: the gate "cloudjobs".

    python tools/cloudjobs_test.py            (bash tools/run_gates.sh <label> --offline cloudjobs)

Starts its own instances (port 9576, profiles of their own, --no-comfy) against a loopback mock of the Comfy API v2 (the
jobs of an earlier run, read by id, and their outputs). One profile gets a test key and the mock as
settings.comfycloud.base; then notes are written into its cloudjobs.json as a crash would leave them, and a start shows:
the job that finished opens as a document of its own (its picture, its status line), the one still running stays noted,
the one older than a day goes unread, nothing is submitted again, the key goes as a bearer to the mock only; a second
ask answers what the first found. A headless start of the same profile asks nothing. A profile without a key asks
nothing and keeps its notes. Nothing reaches the network but the loopback mock.
"""
import asyncio
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import aiohttp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from cdp import HOOK, Cdp  # noqa: E402

ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
PORT = 9576
TEST_KEY = "test-cloudjobs-gate-0123456789"
HOUR = 3600 * 1000
RESULTS = []


def check(what, ok, detail=""):
    RESULTS.append(bool(ok))
    print(f"[{'ok' if ok else 'FAIL'}] {what}{': ' + str(detail) if detail not in ('', None) else ''}", flush=True)


def png_bytes(w, h, rgb):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), rgb).save(buf, format="PNG")
    return buf.getvalue()


PICTURE = png_bytes(96, 64, (40, 160, 90))


class Mock:
    """The Comfy API v2 of an earlier run's jobs: GET /api/v2/jobs/<id>, GET /api/v2/assets/<id>/content."""

    def __init__(self, jobs):
        self.jobs = jobs
        self.calls = []
        mock = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # noqa: D401
                pass

            def _send(self, status, body, ctype="application/json"):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _any(self):
                mock.calls.append({"method": self.command, "path": self.path, "auth": self.headers.get("Authorization"), "xkey": self.headers.get("X-API-Key")})
                p = self.path.split("?")[0]
                if self.command == "GET" and p.startswith("/api/v2/jobs/"):
                    jid = p[len("/api/v2/jobs/"):]
                    spec = mock.jobs.get(jid)
                    if spec is None:
                        return self._send(404, {"error": {"code": "job_not_found", "message": "no such job"}})
                    outs = []
                    if spec == "succeeded":
                        outs = [{"node_id": "9", "name": "rec.png", "type": "image", "content_type": "image/png", "size_bytes": len(PICTURE), "id": "asset-" + jid,
                                 "hash": None, "url": "", "url_expires_at": "2026-10-18T11:00:00Z", "job_id": jid}]
                    return self._send(200, {"id": jid, "status": spec, "created_at": "2026-10-18T10:00:00Z", "started_at": None, "completed_at": None,
                                            "expires_at": "2026-10-25T10:00:00Z", "queue_position": None, "progress": None, "outputs": outs, "error": None,
                                            "urls": {"self": f"/api/v2/jobs/{jid}", "events": f"/api/v2/jobs/{jid}/events", "cancel": f"/api/v2/jobs/{jid}/cancel"}})
                if self.command == "GET" and p.startswith("/api/v2/assets/") and p.endswith("/content"):
                    return self._send(200, PICTURE, "image/png")
                return self._send(404, {"error": {"code": "not_found", "message": "no route " + p}})

            do_GET = _any
            do_POST = _any
            do_PUT = _any
            do_HEAD = _any

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()


class App:
    def __init__(self, profile, label, extra=()):
        self.profile, self.label, self.extra = profile, label, list(extra)
        self.proc = self.session = self.ws = self.c = None

    def start(self):
        cmd = [ELECTRON, ".", f"--remote-debugging-port={PORT}", f"--user-data-dir={self.profile}", "--no-comfy", *self.extra]
        self.log = open(os.path.join(self.profile, f"..\\app_{self.label}.log"), "w", encoding="utf-8", errors="replace")
        self.proc = subprocess.Popen(cmd, cwd=ROOT, stdout=self.log, stderr=subprocess.STDOUT)
        return self

    async def connect(self, timeout=120):
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                if self.session is None:
                    self.session = aiohttp.ClientSession()
                async with self.session.get(f"http://127.0.0.1:{PORT}/json") as r:
                    targets = await r.json()
                page = next((t for t in targets if t.get("type") == "page" and str(t.get("url", "")).startswith("scumble://app")), None)
                if page:
                    self.ws = await self.session.ws_connect(page["webSocketDebuggerUrl"], max_msg_size=64 * 1024 * 1024)
                    self.c = Cdp(self.ws)
                    if await asyncio.wait_for(self.c.eval("(async () => { await import('./shell.js'); return 'ready'; })()", timeout=90), 95) == "ready":
                        await self.c.eval(HOOK)
                        return self
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(0.5)
        raise RuntimeError(f"the app ({self.label}) did not come up on port {PORT}")

    async def ev(self, js, timeout=120):
        return await self.c.eval(js, timeout=timeout)

    async def close(self):
        try:
            if self.ws is not None and not self.ws.closed:
                await self.ws.close()
        except Exception:  # noqa: BLE001
            pass
        if self.session is not None:
            await self.session.close()
        env = dict(os.environ, SCUMBLE_CDP_PORT=str(PORT))
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "close_app.py")], env=env, cwd=ROOT, capture_output=True, timeout=60)
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()


def notes_file(profile):
    return os.path.join(profile, "cloudjobs.json")


def write_notes(profile, jobs):
    with open(notes_file(profile), "w", encoding="utf-8", newline=chr(10)) as f:
        json.dump({"version": 1, "jobs": jobs}, f)


def read_notes(profile):
    try:
        with open(notes_file(profile), encoding="utf-8") as f:
            return [e["jobId"] for e in json.load(f).get("jobs", [])]
    except FileNotFoundError:
        return []


async def main():
    work = tempfile.mkdtemp(prefix="scumble-cloudjobs-gate-")
    mock = Mock({"done": "succeeded", "running": "running", "old": "succeeded"})
    now = int(time.time() * 1000)
    seeded = [
        {"jobId": "done", "model": "Z-Image Turbo", "node": "recipe graph", "saveId": "9", "started": now - HOUR},
        {"jobId": "running", "model": "Klein", "node": "recipe graph", "saveId": "9", "started": now - HOUR},
        {"jobId": "old", "model": "Klein", "node": "recipe graph", "saveId": "9", "started": now - 25 * HOUR},
    ]
    try:
        # 1. a profile with a test key and the mock as the Comfy Cloud host
        prof = os.path.join(work, "keyed")
        os.makedirs(prof)
        a = await App(prof, "setup").start().connect()
        await a.ev(f"(async () => {{ await window.scumble.settings.set({{ comfycloud: {{ base: {json.dumps(mock.base)} }} }}); await window.scumble.keys.set('comfycloud', {json.dumps(TEST_KEY)}); return 1; }})()")
        first = await a.ev("(async () => JSON.stringify(await window.scumble.providers.recoverCloudJobs()))()")
        await a.close()
        check("a start without notes: nothing asked of the mock", len(mock.calls) == 0 and json.loads(first).get("again") is True, first)

        # 2. the notes a crash left, then a start
        write_notes(prof, seeded)
        b = await App(prof, "recover").start().connect()
        got = None
        for _ in range(60):
            got = await b.ev("""(async () => { const { host } = await import('./editor/host.js');
                const ed = host.editors().find((e) => /A Comfy Cloud result that came in after Scumble closed/.test(e.status || ''));
                return ed ? JSON.stringify({ w: ed.width, h: ed.height, status: ed.status, docs: host.editors().length }) : null; })()""")
            if got:
                break
            await asyncio.sleep(0.5)
        g = json.loads(got) if got else {}
        check("the job that finished opens as a document of its own: its picture (96 x 64) and a status line naming the model", bool(got) and g.get("w") == 96 and g.get("h") == 64 and "Z-Image Turbo" in (g.get("status") or ""), got)
        paths = [f"{c['method']} {c['path']}" for c in mock.calls]
        check("the noted jobs were read by id, the finished one's picture fetched; nothing submitted again; the old note unread",
              "GET /api/v2/jobs/done" in paths and "GET /api/v2/jobs/running" in paths and any(p.endswith("/content") for p in paths)
              and not any(c["method"] == "POST" for c in mock.calls) and not any("/jobs/old" in p for p in paths), paths)
        check("the key went as a bearer to the mock, never as X-API-Key", all(c["auth"] == "Bearer " + TEST_KEY and not c["xkey"] for c in mock.calls), [c["auth"] and c["auth"][:12] for c in mock.calls])
        front = json.loads(await b.ev("""(async () => { const { host } = await import('./editor/host.js'); const ed = host.editor;
            return JSON.stringify({ recovered: /A Comfy Cloud result that came in after/.test(ed.status || ''), status: ed.status || '', docs: host.editors().length }); })()"""))
        check("the recovered document opened in the background: the document in front stays in front and names the new tab and the job still running",
              not front["recovered"] and "opened in a tab of its own" in front["status"] and "still running" in front["status"] and front["docs"] == 2, front)
        for _ in range(20):
            if read_notes(prof) == ["running"]:
                break
            await asyncio.sleep(0.25)
        check("the window acked the picture it opened: the note left is the job still running", read_notes(prof) == ["running"], read_notes(prof))
        again = json.loads(await b.ev("(async () => JSON.stringify(await window.scumble.providers.recoverCloudJobs()))()"))
        check("a second ask answers what the first found and reads nothing", again.get("again") is True and again.get("brought") == 1 and again.get("kept") == 1 and len(again.get("pictures") or []) == 0, again)
        # the job that still ran at the start finishes: the window's later ask (recheck) reads that one alone and brings it
        mock.jobs["running"] = "succeeded"
        n_re = len(mock.calls)
        re = json.loads(await b.ev("(async () => { const r = await window.scumble.providers.recoverCloudJobs({ recheck: true }); return JSON.stringify({ n: r.pictures.length, id: r.pictures[0] && r.pictures[0].jobId, kept: r.kept }); })()"))
        re_paths = [c["path"] for c in mock.calls[n_re:]]
        check("a later ask reads only the job that still ran at the start, and brings its picture once it is done", re.get("n") == 1 and re.get("id") == "running" and re.get("kept") == 0 and "/api/v2/jobs/running" in re_paths and "/api/v2/jobs/done" not in re_paths, {"answer": re, "paths": re_paths})
        mock.jobs["running"] = "running"
        await b.close()

        # 3. a headless start of the same profile asks nothing
        n0 = len(mock.calls)
        c = await App(prof, "headless", ["--headless"]).start().connect()
        await asyncio.sleep(3)
        h = json.loads(await c.ev("(async () => JSON.stringify(await window.scumble.providers.recoverCloudJobs()))()"))
        await c.close()
        check("a headless start: nothing asked, the note kept", len(mock.calls) == n0 and read_notes(prof) == ["running"] and h.get("skipped") == "agent start", {"calls": len(mock.calls) - n0, "answer": h})

        # 4. a profile without a key asks nothing and keeps its notes
        bare = os.path.join(work, "bare")
        os.makedirs(bare)
        # the mock as its Comfy Cloud host, so a request would be seen; no key
        s0 = await App(bare, "bare-setup").start().connect()
        await s0.ev(f"(async () => {{ await window.scumble.settings.set({{ comfycloud: {{ base: {json.dumps(mock.base)} }} }}); return 1; }})()")
        await s0.close()
        write_notes(bare, seeded[:2])
        n1 = len(mock.calls)
        d = await App(bare, "nokey").start().connect()
        await asyncio.sleep(3)
        k = json.loads(await d.ev("(async () => JSON.stringify(await window.scumble.providers.recoverCloudJobs()))()"))
        docs = await d.ev("(async () => { const { host } = await import('./editor/host.js'); return host.editors().filter((e) => /A Comfy Cloud result/.test(e.status || '')).length; })()")
        await d.close()
        check("no key: nothing asked, no document opened, the notes kept", len(mock.calls) == n1 and docs == 0 and read_notes(bare) == ["done", "running"] and k.get("skipped") == "no key", {"calls": len(mock.calls) - n1, "answer": k, "docs": docs})
    finally:
        mock.stop()
        shutil.rmtree(work, ignore_errors=True)
    failed = RESULTS.count(False)
    print(f"\n{len(RESULTS) - failed} of {len(RESULTS)} checks passed")
    print("FAIL" if failed or not RESULTS else "PASS")
    return 1 if failed or not RESULTS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
