"""K20b review (K20b-T1): open one PSD file in a running Scumble instance and time it as native_test.py's rows do.

    SCUMBLE_CDP_PORT=9621 python psd_open.py FILE.psd [--set route=value ...] [--reps N] [--json OUT.json]

Per open (a new tab, closed after): wall (load_image to mips settled), blocked (the longest gap of a setTimeout(0) beat,
native_test.py's `row`), the psd_read job's timing (kernel, channels, interleave, deliver, wait, bands, window), the
layered_open step marks, and band timestamps: for every progress message of the job, when the window began and ended
handling it (the pool's `_reply`), and the beats in between, so a run of bands handled back to back with no beat between
them (the window's timers waiting behind queued messages) is measured, not inferred. The first open of an instance is
reported apart (`reps[0]`), the rest are the warm opens. No ComfyUI, no network: start the app with --no-comfy.
"""
import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "tools"))
from cdp import session  # noqa: E402

ARGS = sys.argv[1:]
ROUTES = {}
while "--set" in ARGS:
    i = ARGS.index("--set")
    k, _, v = ARGS[i + 1].partition("=")
    del ARGS[i:i + 2]
    v = v.strip().lower()
    ROUTES[k.strip()] = v if v in ("js", "rust") else int(float(v))
REPS = 2
if "--reps" in ARGS:
    i = ARGS.index("--reps")
    REPS = int(ARGS[i + 1])
    del ARGS[i:i + 2]
JSON_OUT = None
if "--json" in ARGS:
    i = ARGS.index("--json")
    JSON_OUT = ARGS[i + 1]
    del ARGS[i:i + 2]
FILE = os.path.abspath(ARGS[0]).replace("\\", "/")

OPEN = r"""(async () => {
    const commands = window.__cmds.commands, host = window.__host, shell = window.__shell;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const E = host.editors()[0].constructor;
    const d = await run("new_document");
    const ed = ednow(d.id);
    shell.activate(ed);
    await wait(300);
    ed.resizeCanvas();
    await wait(80);
    E.jobTimings(true);
    if (typeof E.stepMarks === "function") E.stepMarks(true);
    // band timestamps: the pool's handling of each progress message of the psd_read job
    const P = E.parts.pool(), reply0 = P._reply, bands = [], beats = [];
    P._reply = function (s, msg) {
        if (!msg || !msg.progress || !s.job || s.job.op !== "psd_read") return reply0.call(this, s, msg);
        const t0 = performance.now();
        try { return reply0.call(this, s, msg); } finally { bands.push([+t0.toFixed(2), +performance.now().toFixed(2), msg.mask ? 1 : 0, msg.index | 0]); }
    };
    let held = 0, last = performance.now(), on = true;
    const beat = () => { const n = performance.now(); held = Math.max(held, n - last); last = n; beats.push(+n.toFixed(2)); if (on) setTimeout(beat, 0); };
    setTimeout(beat, 0);
    const t0 = performance.now();
    let error = null, loaded = 0;
    try {
        await run("load_image", { doc: d.id, path: __FILE__ });
        loaded = performance.now() - t0;
        ed.fitView(); ed.draw();
        await ed.mipsSettled();
    } catch (err) { error = String((err && err.message) || err).slice(0, 300); }
    on = false;
    held = Math.max(held, performance.now() - last);
    const wall = performance.now() - t0;
    delete P._reply;   // the prototype's again
    const jobs = E.jobTimings(true).filter((t) => t.op === "psd_read").map((t) => { const o = {}; for (const [k, v] of Object.entries(t)) if (typeof v !== "object") o[k] = v; o.pxCalls = t.pxCalls; return o; });
    const marks = typeof E.stepMarks === "function" ? E.stepMarks(true).filter((m) => m.op === "layered_open") : [];
    // runs of bands handled with no beat between them: the longest such run, its bands and its span
    let bi = 0, runStart = 0, best = { bands: 0, ms: 0 };
    for (let i = 0; i < bands.length; i++) {
        if (i > 0) {
            while (bi < beats.length && beats[bi] < bands[i][0]) bi++;
            const beatBetween = bi > 0 && beats[bi - 1] > bands[i - 1][1];
            if (beatBetween) runStart = i;
        }
        const n = i - runStart + 1, ms = bands[i][1] - bands[runStart][0];
        if (ms > best.ms) best = { bands: n, ms: +ms.toFixed(1), from: runStart };
    }
    const layers = ed.layers.length, size = [ed.width, ed.height], status = ed.status;
    await run("close_document", { doc: d.id, force: true });
    return { wall: Math.round(wall), blocked: Math.round(held), loadImageMs: Math.round(loaded), error, layers, size, status, jobs, marks, bandRun: best, bandCount: bands.length, bands, beatCount: beats.length, focused: document.hasFocus() };
})()"""


async def main(c):
    await c.call("Page.bringToFront")
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); const h = await import('./editor/host.js'); window.__host = h.host; window.__shell = await import('./shell.js'); return 1; })()")
    if ROUTES:
        print(await c.eval(f"(async () => {{ const E = window.__host.editors()[0].constructor; const r = {json.dumps(ROUTES)}; for (const [k, v] of Object.entries(r)) E.setRoute(k, v); return 'routes: ' + JSON.stringify(r); }})()"))
    out = {"file": FILE, "routes": ROUTES, "reps": []}
    try:
        for i in range(REPS):
            r = await c.eval(OPEN.replace("__FILE__", json.dumps(FILE)), timeout=1800)
            j = (r.get("jobs") or [{}])[0]
            print(f"open {i}: wall {r['wall']} ms, blocked {r['blocked']} ms, layers {r['layers']}, psd_read kernel {j.get('kernel', 0):.0f} ms"
                  f" (window {j.get('window')}, wait {j.get('wait', 0):.0f} ms, bands {j.get('bands')}), longest band run with no beat:"
                  f" {r['bandRun']['bands']} bands / {r['bandRun']['ms']} ms, focused {r['focused']}" + (f"  ERROR {r['error']}" if r.get("error") else ""))
            out["reps"].append(r)
    finally:
        if ROUTES:
            await c.eval(f"(async () => {{ const E = window.__host.editors()[0].constructor; for (const k of {json.dumps(list(ROUTES))}) {{ try {{ E.setRoute(k, null); }} catch (_) {{}} }} return 1; }})()")
    if JSON_OUT:
        with open(JSON_OUT, "w", encoding="utf-8", newline="\n") as f:
            json.dump(out, f, indent=1)
    ok = all(not r.get("error") for r in out["reps"])
    print("RESULT " + ("measured" if ok else "error"))
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(main)) else 1)
