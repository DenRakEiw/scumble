"""A Comfy Cloud job back after a crash (docs/PLAN_COMFY_SDK.md S6), in the app itself: the gate "cloudjobs".

    python tools/cloudjobs_test.py            (bash tools/run_gates.sh <label> --offline cloudjobs)

Starts its own instances (port 9576, profiles of their own, --no-comfy) against a loopback mock of the Comfy API v2 (the
jobs of an earlier run, read by id, and their outputs). One profile gets a test key and the mock as
settings.comfycloud.base; then notes are written into its cloudjobs.json as a crash would leave them, and a start shows:
the job that finished opens as a document of its own (its picture, its status line), the document in front names the
new tab and says, in the window's own words, that the other job is still running; the one older than a day goes
unread, nothing is submitted again, the key goes as a bearer to the mock only. Every later ask reads the notes again:
the running job is read again, the picture of a job that finished meanwhile comes once to the page (not again while the
page has not acked it), and a reload of the page brings it to the new page, which opens it. A headless start of a
profile asks nothing ("agent start"); a second start of Scumble that shows its window makes the window ask, and the
picture opens. A profile without a key asks nothing and keeps its notes. Nothing reaches the network but the loopback
mock.
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

# the window's words (renderer/shell.js recoverCloudResults, the fix contract's section 2)
EARLIER = "A Comfy Cloud result that came in after Scumble closed ("
ONE_RUNNING = "1 Comfy Cloud job is still running: Scumble opens its picture when it is done."


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

    def paths(self, since=0):
        return [f"{c['method']} {c['path']}" for c in self.calls[since:]]


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

    async def ask(self, opts=""):
        """The window's own ask, from the test (the page is the one that asked); `opts` "{ recheck: true }" means the same."""
        return json.loads(await self.ev("(async () => { const r = await window.scumble.providers.recoverCloudJobs(" + opts + "); return JSON.stringify({ ...r, pictures: (r.pictures || []).map((p) => ({ jobId: p.jobId, model: p.model, earlier: p.earlier, bytes: p.bytes ? p.bytes.length : 0 })) }); })()"))

    async def recovered(self, model, tries=60):
        """The document the window opened for a picture of `model`, or None."""
        for _ in range(tries):
            try:
                got = await self.ev(f"""(async () => {{ const {{ host }} = await import('./editor/host.js');
                    const ed = host.editors().find((e) => (e.status || '').startsWith({json.dumps(EARLIER + model)}));
                    return ed ? JSON.stringify({{ w: ed.width, h: ed.height, status: ed.status, docs: host.editors().length }}) : null; }})()""")
                if got:
                    return json.loads(got)
            except Exception:  # noqa: BLE001 (a page that is reloading)
                pass
            await asyncio.sleep(0.5)
        return None

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


async def notes_become(profile, want, tries=40):
    for _ in range(tries):
        if read_notes(profile) == want:
            return True
        await asyncio.sleep(0.25)
    return read_notes(profile) == want


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
        first = await a.ask()
        await a.close()
        check("a start without notes: nothing asked of the mock, an answer with every count at 0",
              len(mock.calls) == 0 and first.get("pictures") == [] and first.get("kept") == 0 and first.get("skipped") is None
              and all(first.get(k) == 0 for k in ("running", "unanswered", "unread")), first)

        # 2. the notes a crash left, then a start
        write_notes(prof, seeded)
        b = await App(prof, "recover").start().connect()
        g = await b.recovered("Z-Image Turbo") or {}
        check("the job that finished opens as a document of its own: its picture (96 x 64) and the window's line naming the model", g.get("w") == 96 and g.get("h") == 64, g)
        paths = mock.paths()
        check("the noted jobs were read by id, the finished one's picture fetched; nothing submitted again; the old note unread",
              "GET /api/v2/jobs/done" in paths and "GET /api/v2/jobs/running" in paths and any(p.endswith("/content") for p in paths)
              and not any(c["method"] == "POST" for c in mock.calls) and not any("/jobs/old" in p for p in paths), paths)
        check("the key went as a bearer to the mock, never as X-API-Key", all(c["auth"] == "Bearer " + TEST_KEY and not c["xkey"] for c in mock.calls), [c["auth"] and c["auth"][:12] for c in mock.calls])
        front = json.loads(await b.ev("""(async () => { const { host } = await import('./editor/host.js'); const ed = host.editor;
            return JSON.stringify({ recovered: /A Comfy Cloud result that came in after/.test(ed.status || ''), status: ed.status || '', docs: host.editors().length }); })()"""))
        check("the recovered document opened in the background: the document in front stays in front, names the new tab and says the other job still runs, in the window's words",
              not front["recovered"] and "opened in a tab of its own" in front["status"] and ONE_RUNNING in front["status"] and front["docs"] == 2, front)
        check("the window acked the picture it opened: the note left is the job still running", await notes_become(prof, ["running"]), read_notes(prof))
        n_again = len(mock.calls)
        again = await b.ask()
        check("a later ask reads the notes again: the running job is read again and counted as running, nothing handed out twice",
              mock.paths(n_again) == ["GET /api/v2/jobs/running"] and again.get("running") == 1 and again.get("kept") == 1 and again.get("keptIds") == ["running"]
              and again.get("pictures") == [] and again.get("unanswered") == 0 and again.get("unread") == 0, {"answer": again, "paths": mock.paths(n_again)})
        # the job that still ran finishes: the next ask brings its picture to this page
        mock.jobs["running"] = "succeeded"
        n_re = len(mock.calls)
        re1 = await b.ask("{ recheck: true }")
        pics = re1.get("pictures") or []
        check("the job finished meanwhile: the next ask brings its picture once (earlier: noted before this process), nothing kept",
              len(pics) == 1 and pics[0].get("jobId") == "running" and pics[0].get("earlier") is True and pics[0].get("bytes", 0) > 0 and re1.get("kept") == 0
              and "GET /api/v2/jobs/running" in mock.paths(n_re), {"answer": re1, "paths": mock.paths(n_re)})
        n_held = len(mock.calls)
        re2 = await b.ask()
        check("an ask while the page holds that picture unacked: not handed out again, its job not read", (re2.get("pictures") or []) == [] and mock.paths(n_held) == [] and read_notes(prof) == ["running"],
              {"answer": re2, "paths": mock.paths(n_held)})
        # the page goes away before it opened the picture (a reload): the new page gets it and opens it
        await b.c.call("Page.reload")
        await asyncio.sleep(1.0)
        k = await b.recovered("Klein") or {}
        check("after a reload the new page gets the picture the old one never acked, and opens it as a document of its own", k.get("w") == 96 and k.get("h") == 64, k)
        check("the new page acked it: no note is left", await notes_become(prof, []), read_notes(prof))
        mock.jobs["running"] = "running"
        await b.close()

        # 3. a headless start asks nothing; a second start of Scumble that shows the window makes the window ask
        write_notes(prof, [{"jobId": "shown", "model": "Klein shown", "node": "recipe graph", "saveId": "9", "started": now - HOUR}])
        mock.jobs["shown"] = "succeeded"
        n0 = len(mock.calls)
        c = await App(prof, "headless", ["--headless"]).start().connect()
        await asyncio.sleep(3)
        h = await c.ask()
        check("a headless start: nothing asked, the note kept, the answer says agent start", len(mock.calls) == n0 and read_notes(prof) == ["shown"] and h.get("skipped") == "agent start", {"calls": mock.paths(n0), "answer": h})
        second = subprocess.run([ELECTRON, ".", f"--user-data-dir={prof}", "--no-comfy"], cwd=ROOT, capture_output=True, timeout=60)
        s = await c.recovered("Klein shown") or {}
        check("a second start shows the window: the window asks, the finished job's picture opens as a document of its own, its note goes",
              second.returncode == 0 and s.get("w") == 96 and "GET /api/v2/jobs/shown" in mock.paths(n0) and await notes_become(prof, []), {"exit": second.returncode, "doc": s, "paths": mock.paths(n0)})
        await c.close()

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
        kk = await d.ask()
        docs = await d.ev("(async () => { const { host } = await import('./editor/host.js'); return host.editors().filter((e) => /A Comfy Cloud result/.test(e.status || '')).length; })()")
        await d.close()
        check("no key: nothing asked, no document opened, the notes kept", len(mock.calls) == n1 and docs == 0 and read_notes(bare) == ["done", "running"] and kk.get("skipped") == "no key", {"calls": len(mock.calls) - n1, "answer": kk, "docs": docs})
    finally:
        mock.stop()
        shutil.rmtree(work, ignore_errors=True)
    failed = RESULTS.count(False)
    print(f"\n{len(RESULTS) - failed} of {len(RESULTS)} checks passed")
    print("FAIL" if failed or not RESULTS else "PASS")
    return 1 if failed or not RESULTS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
