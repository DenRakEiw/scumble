"""A mutation round on a copy of the tree, never on the checkout (docs/TESTING.md "Mutation rounds").

    python tools/mutation_round.py make TREE MUTANTS.py [--repo DIR]
        TREE = the tracked files of the checkout's HEAD (git archive) plus the mutants file's WORKING files (the session's
        uncommitted ones), node_modules as a junction to the checkout's (real) node_modules. TREE must not lie inside
        F:/canvas or the checkout; an existing TREE is only replaced when an earlier `make` made it.
    python tools/mutation_round.py run TREE OUT MUTANTS.py [names...] [--port N] [--lock PATH]
        The untouched copy first ("orig": both wasm builds rebuilt and byte-identical to the checkout's, the full
        px_test, every gate a survivor would run, and every focused kill set below, each green), then each mutant on its
        focused kill set; a mutant that survives it runs the full px_test and its gates whole before it counts as a
        survivor (the re-check: a kill there says the focused set was too narrow). A Rust mutant is rebuilt on both
        builds and its file restored after, with the untouched copy's wasm put back; at the end the restored copy is
        rebuilt, compared and px_test run once more. Names given: only those mutants, and "orig" only when named.
        Writes OUT/results.txt (appended) and OUT/logs/<mutant>.txt; the gates' logs under OUT/gates.
        --port: the DevTools port of the gates' instances (default $SCUMBLE_CDP_PORT or 9555); --lock: a busy-lock file
        to wait out before every test (default $SCUMBLE_BUSY_LOCK), so a measurement elsewhere runs on a quiet machine.

The mutants file is Python:

    TITLE = "K26"                        # the results' header (optional)
    WORKING = ["crates/px/src/stroke.rs", ...]   # files copied from the checkout over HEAD's (optional)
    GATES = ["editor"]                   # the gates a survivor of its focused set runs whole (default: none)
    TILES = "on"                         # the gates' backend, "on" or "off" (default "on")
    MUTANTS = [
        (name, file, [(old, new), ...], expected, kill),
        ...
    ]

`old` must occur exactly once in `file` (checked before anything runs); `expected` starting with "killed" means the
mutant should die, anything else (e.g. "equivalent: ...") that it should survive; a verdict against it is flagged.
`kill` is the focused kill set, a dict with any of
    "px": ["mask", "dab"]                px_test's case groups (PX_ONLY; the names in tools/px_test.js GROUPS)
    "editor": ["step", ...]              the editor gate with SCUMBLE_EDITOR_ONLY (its first step, those, the cleanup)
    "gates": ["edges"]                   gates run whole as part of the focused set
    "full_gates": ["editor"]             this mutant's re-check gates instead of GATES
    "tiles": "off"                       this mutant's gates on the canvas backend
They run in that order and the first red one kills. A 4-tuple (no `kill`) runs the full px_test and GATES, as the
rounds before this tool did.
"""
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time

CHECKOUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARK = ".mutation_tree"
WASM = ("px.wasm", "px_scalar.wasm")
KILL_KEYS = {"px", "editor", "gates", "full_gates", "tiles"}


def fwd(p):
    return os.path.abspath(p).replace("\\", "/")


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def safe(name):
    return "".join(ch if ch.isalnum() else "_" for ch in name)


def inside(child, parent):
    c, p = os.path.normcase(os.path.realpath(child)), os.path.normcase(os.path.realpath(parent))
    return c == p or c.startswith(p.rstrip("\\/") + os.sep)


def load_mutants(path):
    spec = importlib.util.spec_from_file_location("mutants_" + safe(os.path.basename(path)), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    cfg = {
        "title": getattr(mod, "TITLE", os.path.splitext(os.path.basename(path))[0]),
        "working": list(getattr(mod, "WORKING", [])),
        "gates": list(getattr(mod, "GATES", [])),
        "tiles": getattr(mod, "TILES", "on"),
        "mutants": [],
    }
    seen = set()
    for m in mod.MUTANTS:
        if len(m) == 4:
            name, rel, edits, expected = m
            kill = None
        elif len(m) == 5:
            name, rel, edits, expected, kill = m
        else:
            sys.exit(f"mutant {m[0] if m else m!r}: (name, file, [(old, new)], expected[, kill]) expected")
        if name in seen or name == "orig":
            sys.exit(f"mutant name {name!r} used twice (or 'orig', which names the untouched copy)")
        seen.add(name)
        if kill is not None:
            bad = set(kill) - KILL_KEYS
            if bad or not (kill.get("px") or kill.get("editor") or kill.get("gates")):
                sys.exit(f"mutant {name!r}: kill needs px, editor or gates (keys {sorted(KILL_KEYS)}); got {sorted(kill)}")
            if kill.get("tiles", "on") not in ("on", "off"):
                sys.exit(f"mutant {name!r}: tiles is 'on' or 'off'")
        cfg["mutants"].append({"name": name, "file": rel.replace("\\", "/"), "edits": edits, "expected": expected, "kill": kill})
    if cfg["tiles"] not in ("on", "off"):
        sys.exit("TILES is 'on' or 'off'")
    return cfg


# ---- make -------------------------------------------------------------------------------------------------------

def remove_tree(tree):
    """A tree an earlier `make` made: its node_modules junction goes first (rmdir removes the link, never the target)."""
    if not os.path.exists(tree):
        return
    if not os.path.exists(os.path.join(tree, MARK)):
        sys.exit(f"{tree} exists and was not made by mutation_round.py make (no {MARK}): not removed")
    nm = os.path.join(tree, "node_modules")
    if os.path.lexists(nm):
        subprocess.run(["cmd", "/c", "rmdir", nm.replace("/", "\\")], capture_output=True)
        if os.path.lexists(nm):
            sys.exit(f"the node_modules junction in {tree} did not go: the tree is left as it is")
    shutil.rmtree(tree)


def make(tree, mutants_path, repo):
    for bad in (r"F:\canvas", repo):
        if inside(tree, bad):
            sys.exit(f"the tree goes to a scratch folder, never inside {bad}")
    cfg = load_mutants(mutants_path)
    remove_tree(tree)
    os.makedirs(tree)
    head = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    arch = subprocess.run(["git", "-C", repo, "archive", "--format=tar", "HEAD"], capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(arch)) as t:
        t.extractall(tree, filter="tar")
    for rel in cfg["working"]:
        dst = os.path.join(tree, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(repo, rel), dst)
    nm = os.path.realpath(os.path.join(repo, "node_modules"))
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    f"New-Item -ItemType Junction -Path '{os.path.join(tree, 'node_modules')}' -Target '{nm}' | Out-Null"], check=True)
    with open(os.path.join(tree, MARK), "w", encoding="utf-8") as f:
        json.dump({"repo": os.path.abspath(repo), "head": head, "working": cfg["working"], "made": time.strftime("%Y-%m-%d %H:%M")}, f)
    print(f"tree made: {tree} (HEAD {head[:10]} of {repo}, {len(cfg['working'])} working files, node_modules -> {nm})")


# ---- run --------------------------------------------------------------------------------------------------------

class Round:
    def __init__(self, tree, out, cfg, port, lock):
        self.tree, self.out, self.cfg, self.port, self.lock = tree, out, cfg, str(port), lock
        meta = json.load(open(os.path.join(tree, MARK), encoding="utf-8"))
        self.repo = meta["repo"]
        os.makedirs(os.path.join(out, "logs"), exist_ok=True)
        self.res = open(os.path.join(out, "results.txt"), "a", encoding="utf-8", newline=chr(10))
        self.px_dir = os.path.join(tree, "renderer", "editor", "px")
        self.want = {n: sha(os.path.join(self.repo, "renderer", "editor", "px", n)) for n in WASM}
        self.saved_wasm = os.path.join(out, "orig_wasm")

    def line(self, s):
        print(s, flush=True)
        self.res.write(s + "\n")
        self.res.flush()

    def wait_lock(self):
        if not self.lock or not os.path.exists(self.lock):
            return
        print(f"  waiting for the busy lock {self.lock}", flush=True)
        while os.path.exists(self.lock):
            time.sleep(10)

    def run(self, cmd, log, timeout, env=None):
        self.wait_lock()
        t = time.time()
        try:
            r = subprocess.run(cmd, cwd=self.tree, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, env=env)
            out, rc = (r.stdout or "") + (r.stderr or ""), r.returncode
        except subprocess.TimeoutExpired as e:
            got = e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
            out, rc = f"TIMEOUT after {timeout} s\n{got}", 124
        dt = time.time() - t
        extra = "".join(f", {k}={env[k]}" for k in ("PX_ONLY", "SCUMBLE_EDITOR_ONLY") if env and env.get(k))
        with open(log, "a", encoding="utf-8", newline=chr(10)) as f:
            f.write(f"$ {' '.join(cmd)}  (rc {rc}, {dt:.0f} s{extra})\n")
            lines = out.splitlines()
            keep = [x for x in lines if x.startswith(("FAIL", "not ok", "PASS", "error", "[FAIL]"))] + lines[-12:]
            f.write("\n".join(keep[:80]) + "\n")
        return rc, out, dt

    def env(self, **over):
        e = dict(os.environ)
        for k in ("PX_ONLY", "SCUMBLE_EDITOR_ONLY", "PX_BENCH", "PX_TIMES"):
            e.pop(k, None)
        e.update({k: v for k, v in over.items() if v is not None})
        return e

    # one test of a kill set: (green, text, seconds)
    def build(self, log):
        rc, out, dt = self.run([sys.executable, "tools/build_px.py"], log, 900)
        hashes = {n: sha(os.path.join(self.px_dir, n))[:12] for n in WASM} if rc == 0 else None
        return rc == 0, hashes, dt

    def px(self, log, groups=None):
        env = self.env(PX_ONLY=",".join(groups) if groups else None)
        rc, out, dt = self.run(["node", "tools/px_test.js"], log, 600 if groups else 900, env)
        what = f"px_test (only: {', '.join(groups)})" if groups else "the full px_test"
        if rc == 0:
            return True, what, dt
        fails = [x for x in out.splitlines() if x.startswith(("FAIL", "not ok"))]
        first = fails[0] if fails else (out.strip().splitlines() or ["no output"])[-1]
        return False, f"{what} ({len(fails)} failing lines; first: {first[:150]})", dt

    def gate(self, log, label, gates, tiles, steps=None):
        gdir = os.path.join(self.out, "gates")
        env = self.env(SCUMBLE_GATES=fwd(gdir), SCUMBLE_CDP_PORT=self.port, SCUMBLE_EDITOR_ONLY=",".join(steps) if steps else None)
        rc, out, dt = self.run(["bash", "tools/run_gates.sh", label, "--offline", "--tiles", tiles] + gates, log, 2400, env)
        shutil.rmtree(os.path.join(gdir, "profiles"), ignore_errors=True)
        names = " and ".join(f"the {g} gate" for g in gates)
        what = f"the editor gate (only: {len(steps)} step{'s' if len(steps) > 1 else ''})" if steps else names
        if rc == 0 and "SOME FAILED" not in out:
            return True, what, dt
        why = []
        for g in gates:
            p = os.path.join(gdir, "gates", label, f"{g.split(':')[0]}.log")
            if os.path.exists(p):
                why += [x.strip() for x in open(p, encoding="utf-8", errors="replace") if x.startswith(("[FAIL]", "FAIL", "not ok"))][:1]
        tail = [x for x in out.splitlines() if " rc=" in x]
        return False, f"{what} ({'; '.join(why)[:200] or '; '.join(tail)[:200] or 'no summary'})", dt

    def focused(self, m, log, tiles):
        """The mutant's focused kill set in order; (killed, [step texts], seconds by step)."""
        k = m["kill"]
        steps = []
        if k.get("px"):
            steps.append(lambda: self.px(log, k["px"]))
        if k.get("editor"):
            steps.append(lambda: self.gate(log, "mut-" + safe(m["name"])[:50] + "-ed", ["editor"], tiles, k["editor"]))
        for g in k.get("gates", []):
            steps.append(lambda g=g: self.gate(log, "mut-" + safe(m["name"])[:50] + "-" + safe(g)[:12], [g], tiles))
        return self.chain(steps)

    def full(self, m, log, tiles, skip_gates=()):
        gates = (m["kill"] or {}).get("full_gates", self.cfg["gates"]) if m["kill"] else self.cfg["gates"]
        steps = [lambda: self.px(log)]
        for g in gates:
            if g not in skip_gates:
                steps.append(lambda g=g: self.gate(log, "mut-" + safe(m["name"])[:50] + "-full-" + safe(g)[:12], [g], tiles))
        return self.chain(steps)

    @staticmethod
    def chain(steps):
        texts, times = [], []
        for s in steps:
            ok, text, dt = s()
            texts.append(text)
            times.append(dt)
            if not ok:
                return True, texts, times
        return False, texts, times

    def check_edits(self, mutants):
        origs = {}
        for m in mutants:
            p = os.path.join(self.tree, m["file"])
            if m["file"] not in origs:
                if not os.path.exists(p):
                    sys.exit(f"mutant {m['name']!r}: {m['file']} is not in the tree")
                origs[m["file"]] = open(p, encoding="utf-8").read()
            s = origs[m["file"]]
            for old, new in m["edits"]:
                n = s.count(old)
                if n != 1:
                    sys.exit(f"mutant {m['name']!r}: its old text occurs {n} times in {m['file']} (must be once): {old[:80]!r}")
                s = s.replace(old, new)
        return origs

    def check_names(self, mutants):
        src = open(os.path.join(self.tree, "tools", "px_test.js"), encoding="utf-8").read()
        g = re.search(r"const GROUPS = \[(.*?)\];", src, re.S)
        groups = set(re.findall(r'"([A-Za-z]+)"', g.group(1))) if g else set()
        steps = None
        for m in mutants:
            k = m["kill"] or {}
            if k.get("px") and not groups:
                sys.exit("the tree's tools/px_test.js has no GROUPS (PX_ONLY): its px kill sets cannot run")
            bad = [x for x in k.get("px", []) if x not in groups]
            if bad:
                sys.exit(f"mutant {m['name']!r}: px_test has no group {', '.join(bad)} (GROUPS: {', '.join(sorted(groups))})")
            if k.get("editor"):
                if steps is None:
                    r = subprocess.run([sys.executable, "-c", "import json, editor_test as e; print(json.dumps([n for n, _ in e.STEPS]))"],
                                       cwd=os.path.join(self.tree, "tools"), capture_output=True, text=True, encoding="utf-8")
                    steps = set(json.loads(r.stdout.strip().splitlines()[-1])) if r.returncode == 0 else set()
                bad = [x for x in k["editor"] if x not in steps]
                if bad:
                    sys.exit(f"mutant {m['name']!r}: the editor gate has no step {', '.join(bad)}")

    def orig(self, mutants):
        """The untouched copy on everything a mutant is judged on: green, and the builds the checkout's bytes."""
        log = os.path.join(self.out, "logs", "orig.txt")
        t = time.time()
        ok, hashes, dt = self.build(log)
        same = ok and all(sha(os.path.join(self.px_dir, n)) == self.want[n] for n in WASM)
        parts, red = [f"build {dt:.0f} s, both builds identical to the checkout's: {same}"], not same
        if same:
            os.makedirs(self.saved_wasm, exist_ok=True)
            for n in WASM:
                shutil.copyfile(os.path.join(self.px_dir, n), os.path.join(self.saved_wasm, n))
        sets = {"px": [], "editor": [], "gates": []}
        for m in mutants:
            k = m["kill"] or {}
            tiles = k.get("tiles", self.cfg["tiles"])
            if k.get("px") and sorted(k["px"]) not in sets["px"]:
                sets["px"].append(sorted(k["px"]))
            if k.get("editor") and (tiles, sorted(k["editor"])) not in sets["editor"]:
                sets["editor"].append((tiles, sorted(k["editor"])))
            whole = list(k.get("gates", [])) + list(k.get("full_gates", self.cfg["gates"]) if k else self.cfg["gates"])
            for g in whole:
                if (tiles, g) not in sets["gates"]:
                    sets["gates"].append((tiles, g))
        tests = [lambda: self.px(log)] + [lambda s=s: self.px(log, s) for s in sets["px"]]
        tests += [lambda tg=tg: self.gate(log, "mut-orig-" + safe(tg[1])[:12] + "-" + tg[0], [tg[1]], tg[0]) for tg in sets["gates"]]
        tests += [lambda ts=ts: self.gate(log, f"mut-orig-ed{i}-{ts[0]}", ["editor"], ts[0], ts[1]) for i, ts in enumerate(sets["editor"])]
        for test in tests:
            if red:
                break
            good, text, dt = test()
            parts.append(f"{'green' if good else 'RED'}: {text} {dt:.0f} s")
            red = not good
        self.line(f"orig (the untouched copy): {'; '.join(parts)}; {time.time() - t:.0f} s")
        return not red

    def go(self, only):
        cfg = self.cfg
        mutants = [m for m in cfg["mutants"] if not only or m["name"] in only]
        unknown = [n for n in only if n != "orig" and n not in {m["name"] for m in cfg["mutants"]}]
        if unknown:
            sys.exit(f"no mutant named {', '.join(map(repr, unknown))}")
        origs = self.check_edits(mutants)
        self.check_names(mutants)
        self.line(f"== {cfg['title']} mutation round {time.strftime('%Y-%m-%d %H:%M')} on {self.tree} (tools/mutation_round.py; "
                  f"{len(mutants)} mutants, port {self.port}, re-check gates {', '.join(cfg['gates']) or 'none'})")
        if not only or "orig" in only:
            if not self.orig(mutants):
                self.line("the untouched copy is not green: no mutant is believed; stopping")
                return
        else:
            self.line("orig skipped (names given without 'orig'): the verdicts lean on an earlier orig run of this tree")
            if not all(os.path.exists(os.path.join(self.saved_wasm, n)) for n in WASM):
                ok, hashes, dt = self.build(os.path.join(self.out, "logs", "orig.txt"))
                if not ok or not all(sha(os.path.join(self.px_dir, n)) == self.want[n] for n in WASM):
                    self.line("the untouched copy's builds differ from the checkout's; stopping")
                    return
                os.makedirs(self.saved_wasm, exist_ok=True)
                for n in WASM:
                    shutil.copyfile(os.path.join(self.px_dir, n), os.path.join(self.saved_wasm, n))
        kills = late = surv = flagged = 0
        rust_ran = False
        t_round = time.time()
        for m in mutants:
            name, rel = m["name"], m["file"]
            log = os.path.join(self.out, "logs", safe(name) + ".txt")
            path = os.path.join(self.tree, rel)
            s = origs[rel]
            for old, new in m["edits"]:
                s = s.replace(old, new)
            rust = rel.endswith(".rs")
            tiles = (m["kill"] or {}).get("tiles", cfg["tiles"])
            t = time.time()
            hashes, how, recheck = None, [], False
            try:
                open(path, "w", encoding="utf-8", newline=chr(10)).write(s)
                red = False
                if rust:
                    rust_ran = True
                    ok, hashes, dt = self.build(log)
                    how.append(f"build {dt:.0f} s")
                    if not ok:
                        red, texts = True, ["build failed"]
                if not red:
                    if m["kill"]:
                        red, texts, times = self.focused(m, log, tiles)
                        how += [f"{x.split(' (')[0]} {d:.0f} s" for x, d in zip(texts, times)]
                        if not red:
                            recheck = True
                            ran_whole = set(m["kill"].get("gates", []))
                            red, more, times = self.full(m, log, tiles, ran_whole)
                            how += [f"re-check {x.split(' (')[0]} {d:.0f} s" for x, d in zip(more, times)]
                            texts = texts + more
                    else:
                        red, texts, times = self.full(m, log, tiles)
                        how += [f"{x.split(' (')[0]} {d:.0f} s" for x, d in zip(texts, times)]
            finally:
                open(path, "w", encoding="utf-8", newline=chr(10)).write(origs[rel])
                if rust:
                    for n in WASM:
                        shutil.copyfile(os.path.join(self.saved_wasm, n), os.path.join(self.px_dir, n))
            dt = time.time() - t
            if red:
                kills += 1
                late += recheck
                verdict = (f"red on the re-check: {texts[-1]} (green before it: {', '.join(texts[:-1])})" if recheck
                           else f"red: {texts[-1]}" + (f" (after green: {', '.join(texts[:-1])})" if len(texts) > 1 else ""))
            else:
                surv += 1
                verdict = "green: " + ", ".join(texts) + (" (the focused set, then the re-check)" if m["kill"] else "")
            want_red = m["expected"].lower().startswith("killed")
            flag = "" if red == want_red else "  <-- NOT AS EXPECTED"
            if red and recheck:
                flag += "  <-- THE FOCUSED KILL SET MISSED IT: widen it"
            flagged += bool(flag)
            self.line(f"{'KILLED  ' if red else 'SURVIVED'} {name}: {verdict}; builds {hashes}; {dt:.0f} s ({', '.join(how)}); expected {m['expected']}{flag}")
        log = os.path.join(self.out, "logs", "restored_copy.txt")
        back = all(open(os.path.join(self.tree, rel), encoding="utf-8").read() == txt for rel, txt in origs.items())
        parts = [f"every mutated file back: {back}"]
        if rust_ran:
            ok, hashes, dt = self.build(log)
            parts.append(f"rebuilt, both builds identical to the checkout's: {ok and all(sha(os.path.join(self.px_dir, n)) == self.want[n] for n in WASM)}")
        if mutants:
            good, text, dt = self.px(log)
            parts.append(f"{'green' if good else 'RED'}: {text}")
        self.line(f"restored copy: {'; '.join(parts)}")
        self.line(f"mutants: {kills} killed ({late} of them only on the re-check), {surv} survived of {kills + surv}; "
                  f"{flagged} not as expected; {time.time() - t_round:.0f} s for the mutants")


def main(argv):
    args, opts = [], {"--repo": CHECKOUT, "--port": os.environ.get("SCUMBLE_CDP_PORT", "9555"), "--lock": os.environ.get("SCUMBLE_BUSY_LOCK")}
    i = 0
    while i < len(argv):
        if argv[i] in opts:
            opts[argv[i]] = argv[i + 1]
            i += 2
        else:
            args.append(argv[i])
            i += 1
    if len(args) >= 3 and args[0] == "make":
        make(os.path.abspath(args[1]), args[2], os.path.abspath(opts["--repo"]))
    elif len(args) >= 4 and args[0] == "run":
        tree, out = os.path.abspath(args[1]), os.path.abspath(args[2])
        if not os.path.exists(os.path.join(tree, MARK)):
            sys.exit(f"{tree} was not made by mutation_round.py make")
        Round(tree, out, load_mutants(args[3]), opts["--port"], opts["--lock"]).go(args[4:])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(sys.argv[1:])
