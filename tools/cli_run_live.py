"""`Scumble --run` on the real app (the gate `cli`; electron/main/cli_run.js, docs/MCP.md "Batches: --run").

    python tools/cli_run_live.py [--exe dist/win-unpacked/Scumble.exe] [--out DIR] [--port N] [--lock FILE]

Runs tools/cli_run_test.js (plain Node, the fake backend) first, then starts the app headless on a profile of its own,
--no-comfy, once per run (each run starts and quits its own instance; nothing else may hold that profile):

 1. direct: `electron . --user-data-dir=... --no-comfy --run good.json` from the output folder: two fixture PNGs by a
    glob, per file new_document, load_image {file}, add_image_layer {file}, flip_layer, export to a path relative to
    the current folder, close_document. Exit 0, every non-empty stdout line JSON (Electron's CR LF before any JS is
    the empty line a reader skips), 12 step lines all ok, the summary; both PNGs exist and are the mirror of their
    source; the autosave the quit wrote holds no picture (the run's tabs were closed before the window saved).
 2. the launcher with the steps on stdin (`launch.js ... --run -`): stdout starts with `{`, the same lines and files.
 3. a bad command after load_image: exit 1, the first file's steps up to it, its clean-up close_document, then the run
    stops (no line of the second file, its PNG not written).
 4. a broken picture first (load_image fails for it only) with --keep-going: exit 1, the other file is exported.
 5. the same without --keep-going: exit 1, the other file is not exported.
 6. docs/examples/look_folder.json as it is, from a folder holding photos/*.jpg: both graded JPEGs written; the same
    steps without the look export a baseline, which is the photo within re-encode noise, and each graded file differs
    from its baseline by a mean of 4 levels or more.
 7. every command docs/examples/*.json names is in the app's command table (list_commands through --run).

--port: a DevTools port for the instances (only to close the rest of one that hangs; default none: a run that does not
end in --timeout seconds is killed). --lock: a busy-lock file to wait out before every start (default
$SCUMBLE_BUSY_LOCK). Prints PASS or FAIL last.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

from PIL import Image, ImageChops, ImageOps, ImageStat

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe" if os.name == "nt" else "electron")

results = []


def check(what, ok, detail=""):
    results.append(bool(ok))
    print(f"[{'ok' if ok else 'FAIL'}] {what}{'' if ok or not detail else ': ' + str(detail)[:600]}", flush=True)
    return ok


def wait_lock(lock):
    if not lock:
        return
    said = False
    while os.path.exists(lock):
        if not said:
            print(f"  waiting for the busy lock {lock}", flush=True)
            said = True
        time.sleep(30)


def fixture(path, seed):
    """An asymmetric picture: a gradient, a bright block near the left edge, a dark bar at the bottom right."""
    w, h = 96, 64
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = ((x * 255) // (w - 1), (y * 255) // (h - 1), (seed * 70) % 256)
    for y in range(8, 22):
        for x in range(6, 26):
            px[x, y] = (255, 250, 240)
    for y in range(50, 60):
        for x in range(60, 92):
            px[x, y] = (10, 20, 30)
    im.save(path)


class Runner:
    def __init__(self, args):
        self.args = args
        self.exe = os.path.abspath(args.exe) if args.exe else ELECTRON
        self.dev = "electron" in os.path.basename(self.exe).lower()
        self.launcher = os.path.join(ROOT, "electron", "main", "mcp", "launch.js") if self.dev else \
            os.path.join(os.path.dirname(self.exe), "resources", "app.asar", "electron", "main", "mcp", "launch.js")
        self.out = os.path.abspath(args.out)
        self.profile = os.path.join(self.out, "profile")

    def app_args(self, extra):
        # the profile switch first (a value after --run is its steps file); --no-comfy: never the user's ComfyUI
        port = [f"--remote-debugging-port={self.args.port}"] if self.args.port else []
        return [f"--user-data-dir={self.profile}", "--no-comfy"] + port + extra

    def run(self, extra, *, launcher=False, stdin=None, label="run"):
        wait_lock(self.args.lock)
        env = {**os.environ, "SCUMBLE_STRICT": os.environ.get("SCUMBLE_STRICT", "0")}
        if launcher:
            cmd = [self.exe, self.launcher] + self.app_args(extra)
            env["ELECTRON_RUN_AS_NODE"] = "1"
        else:
            cmd = [self.exe] + ([ROOT] if self.dev else []) + self.app_args(extra)
            env.pop("ELECTRON_RUN_AS_NODE", None)
        t0 = time.time()
        try:
            p = subprocess.run(cmd, cwd=self.out, env=env, input=stdin.encode("utf-8") if stdin is not None else None,
                               stdin=None if stdin is not None else subprocess.DEVNULL, capture_output=True, timeout=self.args.timeout)
        except subprocess.TimeoutExpired as e:
            self.close()   # subprocess.run has killed the main process; a DevTools port closes the rest
            raise RuntimeError(f"{label} did not end in {self.args.timeout} s; stdout {e.stdout[-400:] if e.stdout else b''!r}")
        dt = time.time() - t0
        with open(os.path.join(self.out, f"{label}.stdout.txt"), "wb") as f:
            f.write(p.stdout)
        with open(os.path.join(self.out, f"{label}.stderr.txt"), "wb") as f:
            f.write(p.stderr)
        lines, bad = [], []
        for raw in p.stdout.decode("utf-8", "replace").splitlines():
            if not raw.strip():
                continue
            try:
                lines.append(json.loads(raw))
            except ValueError:
                bad.append(raw)
        print(f"  {label}: exit {p.returncode} in {dt:.1f} s, {len(lines)} lines", flush=True)
        return p, lines, bad

    def close(self):
        if not self.args.port:
            return
        env = {**os.environ, "SCUMBLE_CDP_PORT": str(self.args.port)}
        subprocess.run([sys.executable, os.path.join(HERE, "close_app.py")], env=env, capture_output=True, timeout=60)


def same_as_mirror(src, out):
    """max channel difference of out against the mirrored source, and against the source as it is."""
    a = Image.open(src).convert("RGB")
    b = Image.open(out).convert("RGB")
    if a.size != b.size:
        return None, None
    flipped = max(hi for _, hi in ImageChops.difference(ImageOps.mirror(a), b).getextrema())
    plain = max(hi for _, hi in ImageChops.difference(a, b).getextrema())
    return flipped, plain


def autosave_pictures(profile):
    """How many documents of the profile's autosave hold a picture, its open tabs and its closed ones (Reopen Closed
    Tab's list): None when there is no autosave."""
    p = os.path.join(profile, "autosave.json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        outer = json.load(f)
    bundle = json.loads(outer.get("state") or "{}")
    n = 0
    for d in list(bundle.get("docs") or []) + list(bundle.get("closed") or []):
        try:
            s = json.loads(d.get("state") or "{}")
        except ValueError:
            continue
        if isinstance(s, dict) and s.get("base"):
            n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "cli_run_live"))
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--lock", default=os.environ.get("SCUMBLE_BUSY_LOCK"))
    ap.add_argument("--timeout", type=int, default=240)
    args = ap.parse_args()

    unit = subprocess.run(["node", os.path.join(HERE, "cli_run_test.js")], cwd=ROOT, capture_output=True, text=True, timeout=120)
    tail = unit.stdout.strip().splitlines()[-2:] if unit.stdout.strip() else []
    if not check("tools/cli_run_test.js (plain Node, the fake backend)", unit.returncode == 0, " / ".join(tail) + unit.stderr[-300:]):
        print(unit.stdout)

    r = Runner(args)
    shutil.rmtree(r.out, ignore_errors=True)
    os.makedirs(os.path.join(r.out, "in"))
    os.makedirs(r.profile)
    srcs = [os.path.join(r.out, "in", n) for n in ("plate_1.png", "plate_2.png")]
    for i, s in enumerate(srcs):
        fixture(s, i + 1)
    steps = [
        {"cmd": "new_document"},
        {"cmd": "load_image", "args": {"path": "{file}"}},
        {"cmd": "add_image_layer", "args": {"path": "{file}", "name": "{stem} copy"}},
        {"cmd": "flip_layer", "args": {"axis": "x"}},
        {"cmd": "export", "args": {"path": "OUTDIR/{stem}_flipped.png", "metadata": False}},
        {"cmd": "close_document"},
    ]

    def plan(outdir, files=None, extra=None):
        s = [dict(x, args={k: (v.replace("OUTDIR", outdir) if isinstance(v, str) else v) for k, v in x.get("args", {}).items()}) if "args" in x else dict(x) for x in steps]
        if extra:
            s.insert(2, extra)
        return {"comment": "tools/cli_run_live.py", "files": files or [os.path.join(r.out, "in", "plate_*.png")], "steps": s}

    def write(name, obj):
        p = os.path.join(r.out, name)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2)
        return name

    def good_checks(label, p, lines, bad, outdir):
        stepl = [x for x in lines if "cmd" in x]
        summ = lines[-1] if lines else {}
        check(f"{label}: exit 0", p.returncode == 0, p.stderr.decode("utf-8", "replace")[-400:])
        check(f"{label}: every non-empty line is JSON", not bad, bad[:3])
        check(f"{label}: 12 step lines, all ok", len(stepl) == 12 and all(x.get("ok") for x in stepl),
              [(x.get("cmd"), x.get("error")) for x in stepl if not x.get("ok")] or len(stepl))
        check(f"{label}: the lines name their file and step", [x.get("index") for x in stepl] == [1, 2, 3, 4, 5, 6] * 2
              and stepl[0].get("file") == srcs[0] and stepl[6].get("file") == srcs[1], [(x.get("index"), x.get("file")) for x in stepl[:7]])
        check(f"{label}: the summary", summ.get("done") is True and summ.get("steps") == 12 and summ.get("failed") == 0 and summ.get("files") == 2, summ)
        ex = [x for x in stepl if x.get("cmd") == "export"]
        check(f"{label}: export answered with the file it wrote", len(ex) == 2 and all(isinstance(x.get("result"), dict) and x["result"].get("file") for x in ex), ex[:1])
        for s in srcs:
            o = os.path.join(r.out, outdir, os.path.basename(s).replace(".png", "_flipped.png"))
            if not check(f"{label}: {os.path.basename(o)} exists", os.path.exists(o)):
                continue
            flipped, plain = same_as_mirror(s, o)
            check(f"{label}: {os.path.basename(o)} is the mirror of its source", flipped is not None and flipped <= 3 and plain > 100, f"against the mirror {flipped}, against the source {plain}")

    # 1. direct
    try:
        p, lines, bad = r.run(["--run", write("good.json", plan("png"))], label="direct")
        check("direct: stdout may start with Electron's CR LF, nothing else before the first line", p.stdout.lstrip(b"\r\n ")[:1] == b"{", p.stdout[:20])
        good_checks("direct", p, lines, bad, "png")
        pics = autosave_pictures(r.profile)
        check("direct: the autosave the quit wrote holds no picture (the run's tabs were closed first)", pics == 0, pics)
    except Exception as e:  # noqa: BLE001 - every run reports and the next one goes on
        check("direct run", False, e)

    # 2. the launcher, the steps on stdin
    try:
        p, lines, bad = r.run(["--run", "-"], launcher=True, stdin=json.dumps(plan("png_stdin")), label="launcher_stdin")
        check("launcher: stdout starts with {", p.stdout[:1] == b"{", p.stdout[:20])
        good_checks("launcher", p, lines, bad, "png_stdin")
    except Exception as e:  # noqa: BLE001
        check("launcher run", False, e)

    # 3. a bad command: the run stops after the first file's clean-up
    try:
        p, lines, bad = r.run(["--run", write("bad.json", plan("bad", extra={"cmd": "no_such_command", "args": {"x": "{stem}"}}))], label="bad_command")
        stepl = [x for x in lines if "cmd" in x]
        seq = [(x.get("cmd"), x.get("ok")) for x in stepl]
        check("bad command: exit 1", p.returncode == 1, p.returncode)
        check("bad command: the first file up to it, then its clean-up close, then stop",
              seq == [("new_document", True), ("load_image", True), ("no_such_command", False), ("close_document", True)], seq)
        check("bad command: the error names the command", stepl[2:3] and "no_such_command" in str(stepl[2].get("error")), stepl[2:3])
        check("bad command: no line of the second file", all(x.get("file") == srcs[0] for x in stepl), [x.get("file") for x in stepl])
        check("bad command: the summary says stopped", lines and lines[-1].get("stopped") is True and lines[-1].get("failed") == 1, lines[-1:])
        check("bad command: nothing exported", not os.path.exists(os.path.join(r.out, "bad")) or not os.listdir(os.path.join(r.out, "bad")))
    except Exception as e:  # noqa: BLE001
        check("bad command run", False, e)

    # 4. / 5. a broken picture first: --keep-going goes on with the next file, without it the run stops
    broken = os.path.join(r.out, "in", "broken.png")
    with open(broken, "wb") as f:
        f.write(b"this is no PNG")
    files = [broken, srcs[0]]
    for keep, label, outdir in ((True, "keep_going", "kept"), (False, "stop", "stopped")):
        try:
            p, lines, bad = r.run(["--run", write(f"{label}.json", plan(outdir, files=files))] + (["--keep-going"] if keep else []), label=label)
            stepl = [x for x in lines if "cmd" in x]
            first = [(x.get("cmd"), x.get("ok")) for x in stepl if x.get("file") == broken]
            check(f"{label}: exit 1", p.returncode == 1, p.returncode)
            check(f"{label}: the broken file fails at load_image, its tab closed after", first == [("new_document", True), ("load_image", False), ("close_document", True)], first)
            o = os.path.join(r.out, outdir, "plate_1_flipped.png")
            if keep:
                second = [x for x in stepl if x.get("file") == srcs[0]]
                check("keep_going: the other file ran whole", len(second) == 6 and all(x.get("ok") for x in second), [(x.get("cmd"), x.get("error")) for x in second])
                check("keep_going: the other file exported", os.path.exists(o))
            else:
                check("stop: the other file never started", not any(x.get("file") == srcs[0] for x in stepl) and not os.path.exists(o))
        except Exception as e:  # noqa: BLE001
            check(f"{label} run", False, e)

    # 6. docs/examples/look_folder.json as it is, from a folder that holds photos/ (the film pack is built in)
    examples = os.path.join(ROOT, "docs", "examples")
    try:
        photos = os.path.join(r.out, "photos")
        os.makedirs(photos)
        for i in (1, 2):
            fixture(os.path.join(r.out, f"tmp_{i}.png"), i + 2)
            Image.open(os.path.join(r.out, f"tmp_{i}.png")).save(os.path.join(photos, f"shot_{i}.jpg"), quality=95)
        p, lines, bad = r.run(["--run", os.path.join(examples, "look_folder.json")], label="look_example")
        stepl = [x for x in lines if "cmd" in x]
        check("look example: exit 0, 10 step lines all ok", p.returncode == 0 and len(stepl) == 10 and all(x.get("ok") for x in stepl),
              [(x.get("cmd"), x.get("error")) for x in stepl if not x.get("ok")] or (p.returncode, len(stepl)))
        # the baseline: the same photos through the same export without the look (a JPEG re-encode alone differs from
        # its source by a mean of about 1 to 1.7 levels, so the look has to stand clearly above that)
        with open(os.path.join(examples, "look_folder.json"), encoding="utf-8") as f:
            base_plan = json.load(f)
        base_plan["steps"] = [s for s in base_plan["steps"] if s["cmd"] != "film.apply_look"]
        for s in base_plan["steps"]:
            if s["cmd"] == "export":
                s["args"]["path"] = "plain/{stem}.jpg"
        p2, lines2, _ = r.run(["--run", write("look_baseline.json", base_plan)], label="look_baseline")
        check("look baseline: exit 0", p2.returncode == 0, [x.get("error") for x in lines2 if x.get("ok") is False])

        def mean_diff(x, y):
            a, b = Image.open(x).convert("RGB"), Image.open(y).convert("RGB")
            if a.size != b.size:
                return None
            return sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3

        for i in (1, 2):
            src = os.path.join(photos, f"shot_{i}.jpg")
            o, plain = os.path.join(r.out, "graded", f"shot_{i}.jpg"), os.path.join(r.out, "plain", f"shot_{i}.jpg")
            if check(f"look example: graded/shot_{i}.jpg and plain/shot_{i}.jpg exist", os.path.exists(o) and os.path.exists(plain)):
                noise, look = mean_diff(src, plain), mean_diff(plain, o)
                check(f"look example: plain/shot_{i}.jpg is the photo within re-encode noise (mean < 2.5)", noise is not None and noise < 2.5, noise)
                check(f"look example: graded/shot_{i}.jpg has the look (mean difference from the plain export 4 or more)", look is not None and look >= 4, f"{look} (re-encode noise {noise})")
    except Exception as e:  # noqa: BLE001
        check("look example run", False, e)

    # 7. every command the other examples name is in the real command table (an MCP tool name resolves as --run does)
    try:
        p, lines, bad = r.run(["--run", write("table.json", [{"cmd": "list_commands"}])], label="table")
        table = lines[0].get("result", {}).get("commands", []) if lines and lines[0].get("ok") else []
        names = {c.get("name") for c in table}
        names |= {n.replace(".", "_") for n in names}
        for n in ("cutout_folder.json", "key_folder.json", "look_folder.json"):
            with open(os.path.join(examples, n), encoding="utf-8") as f:
                cmds = [s["cmd"] for s in json.load(f)["steps"]]
            missing = [c for c in cmds if c not in names]
            check(f"{n}: every command exists", table and not missing, missing or "no command table")
    except Exception as e:  # noqa: BLE001
        check("command table run", False, e)

    pics = autosave_pictures(r.profile)
    check("after every run the autosave holds no picture", pics == 0, pics)
    n_ok = sum(results)
    print(f"{n_ok} ok, {len(results) - n_ok} failed")
    print("PASS" if all(results) else "FAIL")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
