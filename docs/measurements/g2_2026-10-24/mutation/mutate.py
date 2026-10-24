"""G2's mutation round. Module mutations run tools/filesaves_test.js on a scratch copy of the three files; wiring
mutations patch F:/canvas in place (a backup each, restored in finally), start a fresh offline instance and run
`python tools/export_test.py saves` against it. Every mutation must turn its test red.

    python mutate.py module|wiring [name ...]
"""
import os
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = r"F:\canvas"
HERE = os.path.dirname(os.path.abspath(__file__))
FS = "electron/main/filesaves.js"
MAIN = "electron/main/main.js"
HOST = "renderer/editor/host.js"
PRE = "electron/preload.js"

MODULE = [
    ("offset_check", FS, "if (offset !== s.pos) throw", "if (false) throw"),
    ("size_check", FS, "if (s.pos + buf.length > s.size) throw", "if (false) throw"),
    ("short_finish", FS, "if (s.pos !== s.size) throw", "if (false) throw"),
    ("owner_check", FS, "if (!s || s.owner !== owner || s.dead) throw", "if (!s || s.dead) throw"),
    ("abort_owner", FS, "if (!s || s.owner !== owner) return false;", "if (!s) return false;"),
    ("drop_unlink", FS, "    try { await fsp.unlink(p); return true; } catch (err) { return err.code === \"ENOENT\"; }", "    return true;"),
    ("drop_unregister", FS, "        if (await removeTemp(s.temp)) { try { docfile.unregisterTemp(this.registry, s.temp); } catch (_) { /* the sweep deletes it */ } }", "        await removeTemp(s.temp);"),
    ("drop_keeps_held", FS, "        if (await removeTemp(s.temp)) { try { docfile.unregisterTemp(this.registry, s.temp); } catch (_) { /* the sweep deletes it */ } }", "        await removeTemp(s.temp); try { docfile.unregisterTemp(this.registry, s.temp); } catch (_) { /* the sweep deletes it */ }"),
    ("drop_close", FS, "        if (s.fh) { const fh = s.fh; s.fh = null; try { await fh.close(); } catch (_) { /* closed */ } }\n", ""),
    ("gen_after_open", FS, "        if (this.genOf(owner) !== gen) { await this.drop(s); throw failure(\"the window reloaded during the save\"); }\n", ""),
    ("gen_bump", FS, "        else this.gens.set(owner, (this.gens.get(owner) || 0) + 1);\n", ""),
    ("hardlink_in_place", FS, "inPlace: !!(st && st.nlink > 1)", "inPlace: false"),
    ("symlink_through", FS, "if ((await fsp.lstat(file)).isSymbolicLink()) real = await fsp.realpath(file);", "if (false) real = file;"),
    ("copy_fallback", FS, "                    if (!docfile.BUSY.has(err.code)) throw err;\n", "                    throw err;\n"),
    ("temp_name_cap", "electron/main/docfile.js", "    let n = Math.max(1, 255 - tail.length);", "    let n = 100000;"),
    ("no_register", FS, "docfile.registerTemp(this.registry, temp);", ""),
    ("no_rename", FS, "await docfile.renameRetry(s.temp, s.target, { rename: this.ops.rename });", "await docfile.renameRetry(s.temp, s.temp + '.x', { rename: this.ops.rename });"),
    ("readonly_check", FS, "if (st && !(st.mode & 0o200)) throw", "if (false) throw"),
    ("folder_check", FS, "if (st && st.isDirectory()) throw", "if (false) throw"),
    ("free_check", FS, "if (free < size + 1048576) throw", "if (false) throw"),
    ("size_arg", FS, "if (!Number.isSafeInteger(size) || size < 0) throw", "if (false) throw"),
    ("step_chain", FS, "        s.chain = run.catch(() => {});\n", ""),
    ("step_drop", FS, "return run.catch(async (err) => { await this.drop(s); throw err; });", "return run;"),
    ("abortall_owner", FS, "(s) => owner === undefined || s.owner === owner", "() => true"),
    ("busy_message", FS, "throw docfile.BUSY.has(err.code) ? failure(`${path.basename(s.shown)} is in use by another program, or its folder does not allow replacing it`, err.code) : err;", "throw err;"),
]

WIRING = [
    ("one_message", HOST,
     "        const file = window.scumble.file;\n        const open = await file.saveStart(",
     "        if (blob) return window.scumble.file.save({ name, data: new Uint8Array(await blob.arrayBuffer()), path: this.exportPath || undefined });\n        const file = window.scumble.file;\n        const open = await file.saveStart("),
    ("piece_bounds", HOST, "blob.slice(at, Math.min(blob.size, at + SAVE_PIECE))", "blob.slice(at, Math.min(blob.size, at + SAVE_PIECE - 1))"),
    ("no_finish", HOST, "            return await file.saveFinish({ id: open.id });", "            return { path: this.exportPath, bytes: blob.size };"),
    ("reload_drop", MAIN, "        if (reload) fileSaves.abortAll(win.webContents.id).catch((err) => console.warn(\"file saves:\", err.message));\n", ""),
    ("reload_gate", MAIN, "        if (reload) fileSaves.abortAll(win.webContents.id)", "        fileSaves.abortAll(win.webContents.id)"),
    ("abort_ipc", MAIN, "    ipcMain.handle(\"file:saveAbort\", (e, args) => fileSaves.abort(e.sender.id, args));", "    ipcMain.handle(\"file:saveAbort\", () => true);"),
    ("abort_preload", PRE, "saveAbort: (args) => ipcRenderer.invoke(\"file:saveAbort\", args),", "saveAbort: async () => true,"),
]


def patch(text, old, new, name):
    assert text.count(old) == 1, "%s: the text occurs %d times" % (name, text.count(old))
    return text.replace(old, new)


def run_module(names):
    tree = os.path.join(HERE, "mtree")
    out = []
    for name, rel, old, new in MODULE:
        if names and name not in names:
            continue
        shutil.rmtree(tree, ignore_errors=True)
        for f in (FS, "electron/main/docfile.js", "tools/filesaves_test.js"):
            os.makedirs(os.path.dirname(os.path.join(tree, f)), exist_ok=True)
            shutil.copy(os.path.join(ROOT, f), os.path.join(tree, f))
        p = os.path.join(tree, rel)
        s = open(p, encoding="utf-8").read()
        open(p, "w", encoding="utf-8", newline=chr(10)).write(patch(s, old, new, name))
        r = subprocess.run(["node", os.path.join(tree, "tools", "filesaves_test.js")], capture_output=True, text=True, timeout=300)
        red = [l for l in r.stdout.splitlines() if l.startswith("[FAIL]")]
        out.append((name, "RED" if r.returncode else "survived", red[:2]))
    shutil.rmtree(tree, ignore_errors=True)
    return out


def up():
    try:
        urllib.request.urlopen("http://127.0.0.1:9555/json/version", timeout=1).read()
        return True
    except Exception:  # noqa: BLE001
        return False


def run_wiring(names):
    out = []
    for name, rel, old, new in WIRING:
        if names and name not in names:
            continue
        p = os.path.join(ROOT, rel)
        orig = open(p, "rb").read()
        prof = os.path.join(HERE, "mprof_" + name)
        shutil.rmtree(prof, ignore_errors=True)
        os.makedirs(prof)
        try:
            open(p, "w", encoding="utf-8", newline=chr(10)).write(patch(orig.decode("utf-8"), old, new, name))
            log = open(os.path.join(HERE, "mapp_%s.log" % name), "w")
            app = subprocess.Popen([os.path.join(ROOT, r"node_modules\electron\dist\electron.exe"), ".", "--remote-debugging-port=9555",
                                    "--user-data-dir=" + prof, "--no-comfy"], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            for _ in range(120):
                if up():
                    break
                time.sleep(0.5)
            time.sleep(6)
            try:
                r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "export_test.py"), "saves"], cwd=ROOT, capture_output=True, text=True, timeout=900)
                text = r.stdout
            except subprocess.TimeoutExpired as e:
                text = (e.stdout or b"").decode("utf-8", "replace") + "\n(timed out)"
                r = None
            red = [l for l in text.splitlines() if l.startswith("[FAIL]")]
            out.append((name, "RED" if (r is None or r.returncode) else "survived", [l[:200] for l in red[:3]]))
            subprocess.run([sys.executable, os.path.join(ROOT, "tools", "close_app.py")], cwd=ROOT, env=dict(os.environ, SCUMBLE_CDP_PORT="9555"), capture_output=True, timeout=60)
            try:
                app.wait(timeout=60)
            except subprocess.TimeoutExpired:
                app.kill()
            log.close()
        finally:
            open(p, "wb").write(orig)
    return out


if __name__ == "__main__":
    kind, names = sys.argv[1], sys.argv[2:]
    res = run_module(names) if kind == "module" else run_wiring(names)
    for name, verdict, red in res:
        print("%-16s %s  %s" % (name, verdict, " | ".join(red)))
    print("ALL RED" if all(v == "RED" for _, v, _ in res) else "SOME SURVIVED")
