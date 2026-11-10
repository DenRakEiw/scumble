"""Focused reversal round on an isolated copy of the tree for fix-main Pack 3
(main/MAIN-2, main/MAIN-4, main/MAIN-5, main/MAIN-6, shell/F7).

Usage:
    python docs/measurements/fix_main_p3_2026-11-10/reversals.py --tree <scratch_dir> [--port 9637] [--lock <lock_file>]
"""
import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "tools"))
import mutation_round as mr  # noqa: E402

TITLE = "fix-main-p3"
WORKING = [
    "electron/main/bridge.js",
    "electron/main/comfyview.js",
    "electron/main/filesaves.js",
    "electron/main/main.js",
    "electron/main/providers/cloudjobs.js",
    "electron/main/providers/index.js",
    "renderer/shell.js",
    "tools/cloudjobs_test.js",
    "tools/cloudjobs_test.py",
    "tools/comfyview_test.py",
    "tools/filesaves_test.js",
    "tools/local_test.js",
    "tools/mcp_test.py",
]
GATES = []
TILES = "on"

COMFY_STEP_CODE = (
    "import asyncio, os, sys; sys.path.insert(0, 'tools'); import comfyview_test as cv\n"
    "async def run():\n"
    "    out = os.path.join('dist', 'gates', 'comfyview_rev')\n"
    "    os.makedirs(out, exist_ok=True)\n"
    "    stub = cv.Stub(); await stub.start()\n"
    "    try:\n"
    "        async def inner(c):\n"
    "            g = cv.Gate(c, stub, out)\n"
    "            try:\n"
    "                return await g.save_tab_guard()\n"
    "            finally:\n"
    "                await g.close(); await g.cleanup_recipes()\n"
    "        print('OK:', await cv.session(inner))\n"
    "    finally:\n"
    "        await stub.runner.cleanup()\n"
    "asyncio.run(run())\n"
)

TAKEOVER_STEP_CODE = (
    "import sys; sys.path.insert(0, 'tools'); import mcp_test\n"
    "print('OK:', mcp_test.proxy_takeover_check())\n"
)

# Each tuple: (name, rel_file, [(old, new), ...], runner_kind, expect_substr, description)
REVERSALS = [
    # ---- main/MAIN-6 (electron/main/filesaves.js) -----------------------------------------------------------
    (
        "filesaves_drop_temp_on_copy_error",
        "electron/main/filesaves.js",
        [(
            "                    keepAndFail((err && err.message) || String(err), err && err.code);",
            "                    throw err;",
        )],
        "filesaves",
        "mid-copy ENOSPC",
        "MAIN-6: non-BUSY copyFile error drops fsynced temp instead of keeping and naming it",
    ),
    (
        "filesaves_busy_partial_deletes_temp",
        "electron/main/filesaves.js",
        [(
            "                    if (untouched && docfile.BUSY.has(err && err.code)) {",
            "                    if (docfile.BUSY.has(err && err.code)) {",
        )],
        "filesaves",
        "mid-copy EBUSY after target changed",
        "MAIN-6: EBUSY copyFile failure after target already changed drops fsynced temp instead of keeping it",
    ),
    (
        "filesaves_kept_temp_stays_registered",
        "electron/main/filesaves.js",
        [(
            "                    try { docfile.unregisterTemp(this.registry, s.temp); } catch (_) { /* kept for the user */ }",
            "                    /* kept temp left in registry */",
        )],
        "filesaves",
        "the kept temporary file stayed in the registry",
        "MAIN-6: kept export temp stays registered and gets deleted by next start's sweep",
    ),
    (
        "filesaves_fallback_no_space_check",
        "electron/main/filesaves.js",
        [(
            "                if (free < s.size - oldSize + 1048576) {",
            "                if (false && free < s.size - oldSize + 1048576) {",
        )],
        "filesaves",
        "busy fallback low space",
        "MAIN-6: busy rename fallback starts copyFile without checking remaining free space",
    ),
    (
        "filesaves_abort_deletes_kept_temp",
        "electron/main/filesaves.js",
        [(
            "        if (s.keepTemp) return;",
            "        /* keepTemp ignored */",
        )],
        "filesaves",
        "the fsynced temporary file was deleted or damaged",
        "MAIN-6: drop() removes the temp file even when keepTemp is set",
    ),
    (
        "filesaves_no_hardlink_extra_space",
        "electron/main/filesaves.js",
        [(
            "        const need = inPlace ? Math.max(size, 2 * size - st.size) : size;",
            "        const need = size;",
        )],
        "filesaves",
        "hard-linked extra space",
        "MAIN-6: start() checks only size + 1 MB on hard-linked targets",
    ),
    # ---- shell/F7 (electron/main/bridge.js) -----------------------------------------------------------------
    (
        "bridge_ignore_default_timeout",
        "electron/main/bridge.js",
        [(
            "        const timeoutSec = explicitTimeout !== null ? explicitTimeout : (this._timeouts && this._timeouts.get(cmd)) || 0;",
            "        const timeoutSec = explicitTimeout !== null ? explicitTimeout : 0;",
        )],
        "local",
        "[FAIL] Bridge extends BASE_TIMEOUT by params.timeout.default when args.timeout is omitted",
        "shell/F7: Bridge ignores params.timeout.default when args.timeout is absent",
    ),
    (
        "bridge_default_overrides_zero",
        "electron/main/bridge.js",
        [(
            "        const timeoutSec = explicitTimeout !== null ? explicitTimeout : (this._timeouts && this._timeouts.get(cmd)) || 0;",
            "        const timeoutSec = explicitTimeout ? explicitTimeout : (this._timeouts && this._timeouts.get(cmd)) || 0;",
        )],
        "local",
        "[FAIL] an explicit args.timeout = 0 is honoured without falling back to the default",
        "shell/F7: explicit args.timeout = 0 falls back to params.timeout.default",
    ),
    (
        "bridge_no_changed_invalidation",
        "electron/main/bridge.js",
        [(
            '        ipcMain.on("commands:changed", () => { this._timeouts = null; this.emit("changed"); });',
            '        ipcMain.on("commands:changed", () => { this.emit("changed"); });',
        )],
        "local",
        "[FAIL] commands:changed refreshes Bridge's timeout defaults for new commands",
        "shell/F7: commands:changed leaves stale _timeouts cache in Bridge",
    ),
    # ---- main/MAIN-2 (cloudjobs.js, providers/index.js, main.js, shell.js) ----------------------------------
    (
        "cloudjobs_drop_provider_and_file",
        "electron/main/providers/cloudjobs.js",
        [(
            '                if (entry.provider) item.provider = String(entry.provider);\n'
            '                const clean = cleanFile(entry.file);\n'
            '                if (clean) {\n'
            '                    item.file = clean;\n'
            '                    item.mime = typeof entry.mime === "string" && entry.mime ? entry.mime : "image/png";\n'
            '                }',
            "                /* provider and file omitted */",
        )],
        "cloudjobs_node",
        "[FAIL] a non-Comfy provider run whose page went away writes <userData>/results/<generatedId>.png",
        "MAIN-2: cloudjobs.add strips provider and file fields",
    ),
    (
        "providers_discard_noncomfy_pagegone",
        "electron/main/providers/index.js",
        [(
            '    if (out && out.bytes && hooks && typeof hooks.pageGone === "function" && hooks.pageGone()) {\n'
            "        if (ctx.jobNote && ctx.jobs) {",
            '    if (out && out.bytes && ctx.jobNote && ctx.jobs && hooks && typeof hooks.pageGone === "function" && hooks.pageGone()) {\n'
            "        if (true) {",
        )],
        "cloudjobs_node",
        "[FAIL] a non-Comfy provider run whose page went away writes <userData>/results/<generatedId>.png",
        "MAIN-2: providers.edit discards non-Comfy result when pageGone() is true",
    ),
    (
        "providers_use_untrusted_runid_filename",
        "electron/main/providers/index.js",
        [(
            "                    const savedId = crypto.randomUUID();",
            "                    const savedId = runId || crypto.randomUUID();",
        )],
        "cloudjobs_node",
        "[FAIL] a non-Comfy provider run whose page went away writes <userData>/results/<generatedId>.png",
        "MAIN-2: providers.edit uses untrusted request.runId as kept file stem",
    ),
    (
        "providers_send_local_to_comfy_recover",
        "electron/main/providers/index.js",
        [(
            "    const localEntries = entries.filter((e) => Boolean(e.file));\n"
            "    const remoteEntries = entries.filter((e) => !e.file);",
            "    const localEntries = [];\n"
            "    const remoteEntries = entries;",
        )],
        "cloudjobs_node",
        "[FAIL] recoverCloudJobs with no Comfy Cloud key brings the kept OpenAI picture",
        "MAIN-2: recoverCloudJobs skips local results/ reading and treats local entries as remote",
    ),
    (
        "providers_send_local_to_comfy_with_key",
        "electron/main/providers/index.js",
        [(
            "    const remoteJobs = { ...jobs, list: () => jobs.list().filter((e) => !e.file) };",
            "    const remoteJobs = jobs;",
        )],
        "cloudjobs_node",
        "[FAIL] with a Comfy Cloud key set, recoverCloudJobs queries Comfy only for the remote job id",
        "MAIN-2: recoverCloudJobs passes unfiltered store to comfycloud.recoverJobs when a Comfy key is set",
    ),
    (
        "providers_drop_aged_local_file",
        "electron/main/providers/index.js",
        [(
            "        // local files under <userData>/results/ do not expire after 24 h (unlike Comfy Cloud's server-side outputs)\n"
            "        const clean = cloudjobs.cleanFile(e.file);",
            "        if (now - (+e.started || 0) >= cloudjobs.MAX_AGE_MS) { localDropped.push(e.jobId); cloudjobs.unlinkResult(dir, e.file); continue; }\n"
            "        const clean = cloudjobs.cleanFile(e.file);",
        )],
        "cloudjobs_node",
        "[FAIL] a local picture older than 24 h is brought back as an earlier result",
        "MAIN-2: recoverCloudJobs deletes unopened local pictures after 24 h",
    ),
    (
        "cloudjobs_sweep_disabled",
        "electron/main/providers/index.js",
        [(
            "    if (!sweptDirs.has(dir) && cloudjobs.sweepResults(dir) !== null) sweptDirs.add(dir);",
            "    /* sweepResults disabled */",
        )],
        "cloudjobs_node",
        "[FAIL] recoverCloudJobs with no Comfy Cloud key brings the kept OpenAI picture, respects skip, and sweeps unnoted files",
        "MAIN-2: first recoverCloudJobs ask leaves unnoted crash files and *.tmp in results/",
    ),
    (
        "providers_count_inapp_as_paid",
        "electron/main/providers/index.js",
        [(
            '    running.set(runSlot, { ac, counted: id !== "inapp" });',
            "    running.set(runSlot, { ac, counted: true });",
        )],
        "cloudjobs_node",
        "[FAIL] a free in-app fill is not counted in runningCount",
        "MAIN-2: free local in-app helper run is counted in runningCount",
    ),
    (
        "providers_ack_keeps_result_file",
        "electron/main/providers/index.js",
        [(
            "        if (entry && entry.file) cloudjobs.unlinkResult(dir, entry.file);",
            "        /* file left behind on ack */",
        )],
        "cloudjobs_node",
        "[FAIL] ackCloudJob removes the local picture's note and deletes its file from <userData>/results/",
        "MAIN-2: ackCloudJob leaves <userData>/results/<file> on disk",
    ),
    (
        "main_reload_no_running_ask",
        "electron/main/main.js",
        [(
            "    if (n > 0 && windowVisible()) {",
            "    if (false && n > 0 && windowVisible()) {",
        )],
        "cloudjobs_app",
        "[FAIL] View > Reload while a provider run is in flight asks first",
        "MAIN-2: reloadWindow reloads without asking while provider runs are in flight",
    ),
    (
        "shell_hardcode_comfy_cloud_words",
        "renderer/shell.js",
        [(
            '        const isComfy = !p.provider || p.provider === "comfycloud";',
            "        const isComfy = true;",
        )],
        "cloudjobs_app",
        "[FAIL] Reload keeps the finished non-Comfy picture with no Comfy key, opens it under the provider's name",
        "MAIN-2: openCloudResults names non-Comfy pictures and status lines as Comfy Cloud",
    ),
    # ---- main/MAIN-4 (electron/main/comfyview.js) -----------------------------------------------------------
    (
        "comfyview_cansave_without_loaded",
        "electron/main/comfyview.js",
        [
            (
                "        if (!asNew && (heldLoaded !== held.id || lostHeld())) return wrongTab();",
                "        /* loaded check omitted */",
            ),
            (
                '            canSaveNew: this.phase === "page", canSave: this.phase === "page" && recipeLoaded,',
                '            canSaveNew: this.phase === "page", canSave: this.phase === "page" && !!r,',
            ),
        ],
        "comfyview_step",
        "failed load left Save to recipe open",
        "MAIN-4: Save to recipe stays enabled and allowed when recipeLoaded is false",
    ),
    (
        "comfyview_save_ignores_active_tab",
        "electron/main/comfyview.js",
        [(
            "        if (!asNew && (lostHeld() || r.tabChanged || curTab !== heldTab)) return wrongTab();",
            "        if (!asNew && lostHeld()) return wrongTab();",
        )],
        "comfyview_step",
        "other workflow tab overwrote or did not refuse",
        "MAIN-4: Save to recipe overwrites held recipe with another ComfyUI workflow tab's graph",
    ),
    (
        "comfyview_broken_extension_manager_arm",
        "electron/main/comfyview.js",
        [(
            "const ACTIVE_WF_JS = `(() => { const a = window.app; const wm = (a && a.extensionManager && a.extensionManager.workflow) || (a && a.workflowManager) || null;",
            "const ACTIVE_WF_JS = `(() => { const a = window.app; const wm = (a && a.workflowManager) || null;",
        )],
        "comfyview_step",
        "other workflow tab overwrote or did not refuse",
        "MAIN-4: broken extensionManager.workflow arm disables tab guard on current ComfyUI frontends",
    ),
    (
        "comfyview_tab_by_key_instead_of_object",
        "electron/main/comfyview.js",
        [
            (
                '    return `(() => { const wf = ${ACTIVE_WF_JS}; if (!wf) return null;\n'
                '        try { Object.defineProperty(wf, "__scumbleTab", { value: ${tok}, configurable: true, writable: true }); }\n'
                "        catch (_) { try { wf.__scumbleTab = ${tok}; } catch (_) {} }\n"
                '        return typeof wf.__scumbleTab === "string" ? wf.__scumbleTab.slice(0, 80) : null; })()`;',
                '    return `(() => { const wf = ${ACTIVE_WF_JS}; const k = wf && (wf.key || wf.path); return typeof k === "string" ? k.slice(0, 80) : null; })()`;',
            ),
            (
                '    const tab0 = wf0 && typeof wf0.__scumbleTab === "string" ? wf0.__scumbleTab.slice(0, 80) : null;\n'
                "    const p = await window.app.graphToPrompt();\n"
                "    const wf1 = ${ACTIVE_WF_JS};\n"
                '    const tab1 = wf1 && typeof wf1.__scumbleTab === "string" ? wf1.__scumbleTab.slice(0, 80) : null;',
                '    const tab0 = wf0 && typeof (wf0.key || wf0.path) === "string" ? (wf0.key || wf0.path).slice(0, 80) : null;\n'
                "    const p = await window.app.graphToPrompt();\n"
                "    const wf1 = ${ACTIVE_WF_JS};\n"
                '    const tab1 = wf1 && typeof (wf1.key || wf1.path) === "string" ? (wf1.key || wf1.path).slice(0, 80) : null;',
            ),
        ],
        "comfyview_step",
        "same-named replacement tab passed the guard",
        "MAIN-4: comparing workflow key/path instead of workflow object lets a same-named tab overwrite and refuses a renamed tab",
    ),
    (
        "comfyview_late_held_id_after_await",
        "electron/main/comfyview.js",
        [(
            "        const objectInfo = await this.objectInfo();\n"
            "        if (!asNew && lostHeld()) return wrongTab();\n"
            "        try {\n"
            '            const saved = await this.saveRecipe({ output, workflow, objectInfo, heldId: held ? held.id : null, name: asNew ? name : "" });',
            "        const objectInfo = await this.objectInfo();\n"
            "        try {\n"
            '            const saved = await this.saveRecipe({ output, workflow, objectInfo, heldId: this.recipe ? this.recipe.id : null, name: asNew ? name : "" });',
        )],
        "comfyview_step",
        "recipe switch during objectInfo overwrote or passed",
        "MAIN-4: reading this.recipe after objectInfo() writes the previous recipe's graph into a newly opened recipe",
    ),
    # ---- main/MAIN-5 (electron/main/main.js) ----------------------------------------------------------------
    (
        "main_ensure_not_singleflight",
        "electron/main/main.js",
        [
            (
                "        this.starting ??= this._ensure().finally(() => { this.starting = null; });\n"
                "        return this.starting;",
                "        return this._ensure();",
            ),
            (
                "            } catch (_) { /* nobody listens */ }\n"
                "            if (this.own) return bridge;\n"
                "            if (this.client && !this.client.closed) return this.client;\n"
                "            if (ARGS.attachOnly) throw new Error(\"Scumble is not running: start it, then try again (this registration only attaches to a running Scumble, --attach-only)\");\n"
                "            if (app.requestSingleInstanceLock()) {\n"
                "                bindSecondInstance();\n"
                "                await app.whenReady();\n"
                "                if (this.own) return bridge;",
                "            } catch (_) { /* nobody listens */ }\n"
                "            if (ARGS.attachOnly) throw new Error(\"Scumble is not running: start it, then try again (this registration only attaches to a running Scumble, --attach-only)\");\n"
                "            if (app.requestSingleInstanceLock()) {\n"
                "                app.on(\"second-instance\", onSecondInstance);\n"
                "                await app.whenReady();",
            ),
        ],
        "takeover_step",
        "Failed to register protocol: scumble",
        "MAIN-5: concurrent AgentBackend.ensure() calls without single-flight or post-await this.own rechecks fail protocol registration",
    ),
    (
        "main_second_instance_shows_agent_window",
        "electron/main/main.js",
        [(
            "    if (a.mcp || a.cmd || a.run !== null) return;",
            "    /* agent second-instance guard omitted */",
        )],
        "takeover_step",
        "second-instance agent probe showed hidden window",
        "MAIN-5: probing agent second-instance (--mcp/--cmd/--run) brings headless window up",
    ),
]

# Populate MUTANTS so mutation_round.load_mutants / make can inspect WORKING cleanly
MUTANTS = [(name, rel, edits, f"killed: {desc}", {"gates": ["lint"]}) for (name, rel, edits, _k, _s, desc) in REVERSALS]


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", int(port))) == 0


def wait_port_free(port, limit_s=60):
    deadline = time.time() + limit_s
    while port_busy(port) and time.time() < deadline:
        time.sleep(1.0)
    if port_busy(port):
        raise RuntimeError(f"port {port} is busy")


def wait_lock(lock_path):
    if not lock_path or not os.path.exists(lock_path):
        return
    while os.path.exists(lock_path):
        time.sleep(5.0)


def run_comfyview_step(tree, port):
    wait_port_free(port)
    exe = os.path.join(tree, "node_modules", "electron", "dist", "electron.exe" if os.name == "nt" else "electron")
    prof = tempfile.mkdtemp(prefix="scumble-cv-rev-")
    env = {k: v for k, v in os.environ.items() if k != "ELECTRON_RUN_AS_NODE"}
    env["SCUMBLE_CDP_PORT"] = str(port)
    app = subprocess.Popen(
        [exe, tree, f"--user-data-dir={prof}", "--no-comfy", f"--remote-debugging-port={port}"],
        cwd=tree, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(80):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as r:
                    targets = json.loads(r.read().decode("utf-8", "replace"))
                if any(t.get("type") == "page" and "scumble://" in t.get("url", "") and "comfybar.html" not in t.get("url", "") for t in targets):
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.25)
        time.sleep(1.0)
        res = subprocess.run(
            [sys.executable, "-c", COMFY_STEP_CODE],
            cwd=tree, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90,
        )
        return res.returncode, (res.stdout or "") + (res.stderr or "")
    finally:
        subprocess.run([sys.executable, os.path.join(tree, "tools", "close_app.py")], cwd=tree, env=env, capture_output=True, timeout=20)
        try:
            app.wait(timeout=10)
        except subprocess.TimeoutExpired:
            app.kill()
        shutil.rmtree(prof, ignore_errors=True)


def run_kind(tree, kind, port, lock_path):
    wait_lock(lock_path)
    env = dict(os.environ)
    env["SCUMBLE_CDP_PORT"] = str(port)
    if kind == "filesaves":
        cmd, timeout = ["node", "tools/filesaves_test.js"], 60
    elif kind == "local":
        cmd, timeout = ["node", "tools/local_test.js"], 60
    elif kind == "cloudjobs_node":
        wait_port_free(9576)
        cmd, timeout = ["node", "tools/cloudjobs_test.js"], 60
    elif kind == "cloudjobs_app":
        wait_port_free(port)
        wait_port_free(9576)
        cmd, timeout = [sys.executable, "tools/cloudjobs_test.py"], 120
    elif kind == "takeover_step":
        cmd, timeout = [sys.executable, "-c", TAKEOVER_STEP_CODE], 120
    elif kind == "comfyview_step":
        return run_comfyview_step(tree, port)
    else:
        raise ValueError(f"unknown kind: {kind}")
    r = subprocess.run(cmd, cwd=tree, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", required=True, help="Scratch directory outside the repository for the isolated copy")
    ap.add_argument("--port", type=int, default=int(os.environ.get("SCUMBLE_CDP_PORT", "9637")))
    ap.add_argument("--lock", default=os.environ.get("SCUMBLE_BUSY_LOCK", ""))
    args = ap.parse_args()

    tree = os.path.abspath(args.tree)
    mr.make(tree, os.path.abspath(__file__), REPO)
    out_lines = []

    def record(s):
        print(s, flush=True)
        out_lines.append(s)

    try:
        head = subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        record(f"# {TITLE} focused reversal round (base HEAD {head[:10]}, {len(REVERSALS)} mutants)")

        # Verify every target string occurs exactly once before running anything
        orig_bytes = {}
        for name, rel, edits, _kind, _sub, _desc in REVERSALS:
            p = os.path.join(tree, rel)
            if rel not in orig_bytes:
                with open(p, "rb") as f:
                    orig_bytes[rel] = f.read()
            txt = orig_bytes[rel].decode("utf-8")
            for old, _new in edits:
                n = txt.count(old)
                if n != 1:
                    raise SystemExit(f"mutant {name}: target occurs {n} times in {rel} (expected 1)")

        # 1. Untouched copy (orig) must pass all 6 runner kinds
        t0 = time.time()
        for kind in ("filesaves", "local", "cloudjobs_node", "cloudjobs_app", "comfyview_step", "takeover_step"):
            kt = time.time()
            rc, out = run_kind(tree, kind, args.port, args.lock)
            dt = time.time() - kt
            if rc != 0:
                record(f"[FAIL] orig ({kind}) rc={rc} in {dt:.1f}s:\n{out[-800:]}")
                raise SystemExit(1)
            record(f"[orig] {kind:16s} PASS ({dt:.1f}s)")
        record(f"[orig] all 6 checks green in {time.time() - t0:.1f}s\n")

        # 2. Run each reversal mutant and assert it dies with its expected failure substring
        killed = 0
        mt0 = time.time()
        for name, rel, edits, kind, expect_sub, desc in REVERSALS:
            p = os.path.join(tree, rel)
            txt = orig_bytes[rel].decode("utf-8")
            for old, new in edits:
                txt = txt.replace(old, new, 1)
            with open(p, "wb") as f:
                f.write(txt.encode("utf-8"))
            kt = time.time()
            try:
                rc, out = run_kind(tree, kind, args.port, args.lock)
            finally:
                with open(p, "wb") as f:
                    f.write(orig_bytes[rel])
                with open(p, "rb") as f:
                    if sha256_bytes(f.read()) != sha256_bytes(orig_bytes[rel]):
                        raise SystemExit(f"restore mismatch on {rel}")
            dt = time.time() - kt
            if rc == 0:
                record(f"[SURVIVED] {name} ({rel}, {kind}, {dt:.1f}s) — {desc}")
                raise SystemExit(1)
            if expect_sub not in out:
                tail = " | ".join(line.strip() for line in out.strip().splitlines()[-6:])
                record(f"[WRONG-REASON] {name} ({rel}, {kind}, rc={rc}, {dt:.1f}s) wanted {expect_sub!r}, got: {tail}")
                raise SystemExit(1)
            killed += 1
            record(f"[killed] {name:40s} {kind:15s} rc={rc} {dt:5.1f}s  matched {expect_sub!r}")

        record(f"\nSUMMARY: {killed} / {len(REVERSALS)} reversal mutants killed on expected assertions in {time.time() - mt0:.1f}s (0 survived, 0 wrong-reason)")
        res_path = os.path.join(HERE, "results.txt")
        with open(res_path, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(out_lines) + "\n")
    finally:
        for attempt in range(10):
            try:
                mr.remove_tree(tree)
                break
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.5)


if __name__ == "__main__":
    main()
