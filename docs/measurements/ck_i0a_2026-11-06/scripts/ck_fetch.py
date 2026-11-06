"""I0a: fetch pack A's model files at the pinned revisions into staging folders, verify every file.

Run with python -I from the scratchpad (never from a download folder):
    python -I ck_fetch.py fetch      download into ck_dl/<group>/ (curl, .part files, resume), verify
    python -I ck_fetch.py verify     verify only (staging)
    python -I ck_fetch.py place DST  copy the verified files into DST (models/corridorkey2) in pack A's layout,
                                     verify the copies again, write a JSON record
No token is sent anywhere (all three HF repos are public, gated false).
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.path.dirname(HERE)
META = os.path.join(SCRATCH, "ck_dl_meta")
STAGE = os.path.join(SCRATCH, "ck_dl")

REPOS = {
    "ck2": ("nikopueringer/CorridorKey2.0", "cf44a8db3f024bb49fd59daa408848ccf05f7477"),
    "cradio": ("nvidia/C-RADIOv4-SO400M", "c0457f5dc26ca145f954cd4fc5bb6114e5705ad8"),
    "moge": ("Ruicheng/moge-2-vitb-normal", "ca5f0e07ff01d3e5a364c1d954ed12ee1814b368"),
}
RVM_URL = "https://storage.googleapis.com/representations4d/checkpoints/pretrain_rvm_small16_256_204031069.npz"
RVM_MD5_B64 = "ZJb6kj8+tasiJbVeplXu7Q=="
RVM_SIZE = 270086372


def tree(group):
    with open(os.path.join(META, group + "_tree.json"), encoding="utf-8") as f:
        return {e["path"]: e for e in json.load(f) if e["type"] == "file"}


def plan():
    """(group, name, url, size, check kind, expected, destination relative to models/corridorkey2)."""
    out = []
    t = tree("ck2")
    repo, rev = REPOS["ck2"]
    for name in ("corridorkey_v2.safetensors", "foundation_stats.safetensors"):
        e = t[name]
        out.append(("ck2", name, f"https://huggingface.co/{repo}/resolve/{rev}/{name}", e["lfs"]["size"],
                    "sha256", e["lfs"]["oid"], name))
    t = tree("cradio")
    repo, rev = REPOS["cradio"]
    base = "foundations/cradio/C-RADIOv4-SO400M/"
    for name in sorted(t):
        if name.endswith(".pth.tar"):
            continue  # pack A's snapshot ignores *.pth.tar (download.py:238-241)
        e = t[name]
        if e.get("lfs"):
            kind, exp, size = "sha256", e["lfs"]["oid"], e["lfs"]["size"]
        else:
            kind, exp, size = "gitsha1", e["oid"], e["size"]
        out.append(("cradio", name, f"https://huggingface.co/{repo}/resolve/{rev}/{name}", size, kind, exp, base + name))
    t = tree("moge")
    repo, rev = REPOS["moge"]
    e = t["model.pt"]
    out.append(("moge", "model.pt", f"https://huggingface.co/{repo}/resolve/{rev}/model.pt", e["lfs"]["size"],
                "sha256", e["lfs"]["oid"], "foundations/moge/model.pt"))
    out.append(("rvm", "pretrain_rvm_small16_256_204031069.npz", RVM_URL, RVM_SIZE, "md5b64", RVM_MD5_B64,
                "foundations/rvm/pretrain_rvm_small16_256_204031069.npz"))
    return out


def digests(path):
    s, m, n = hashlib.sha256(), hashlib.md5(), 0
    size = os.path.getsize(path)
    g = hashlib.sha1(b"blob %d\0" % size)
    with open(path, "rb") as f:
        while True:
            b = f.read(1 << 22)
            if not b:
                break
            s.update(b)
            m.update(b)
            g.update(b)
            n += len(b)
    return {"size": n, "sha256": s.hexdigest(), "md5b64": base64.b64encode(m.digest()).decode(), "gitsha1": g.hexdigest()}


def check(path, size, kind, exp):
    d = digests(path)
    ok = d["size"] == size and d[kind] == exp
    return ok, d


def fetch(items):
    for group, name, url, size, kind, exp, _dst in items:
        folder = os.path.join(STAGE, group)
        os.makedirs(folder, exist_ok=True)
        final = os.path.join(folder, name)
        if os.path.isfile(final):
            ok, _ = check(final, size, kind, exp)
            if ok:
                print(f"have {group}/{name}", flush=True)
                continue
            os.remove(final)
        part = final + ".part"
        for attempt in range(1, 6):
            t0 = time.time()
            r = subprocess.run(["curl", "-fsSL", "--retry", "5", "--retry-delay", "5", "--connect-timeout", "30",
                                "--speed-limit", "1024", "--speed-time", "60", "-C", "-", "-o", part, url])
            got = os.path.getsize(part) if os.path.isfile(part) else 0
            print(f"curl {group}/{name} rc={r.returncode} {got}/{size} bytes {time.time() - t0:.1f} s", flush=True)
            if r.returncode == 0 and got == size:
                break
            if got > size:
                os.remove(part)
        ok, d = check(part, size, kind, exp)
        if not ok:
            os.rename(part, part + ".bad")
            raise SystemExit(f"MISMATCH {group}/{name}: want {kind}={exp} size={size}, got {d}")
        os.replace(part, final)
        print(f"ok {group}/{name} {kind}", flush=True)


def verify(items, root=None):
    rows, bad = [], 0
    for group, name, url, size, kind, exp, dst in items:
        path = os.path.join(root, dst) if root else os.path.join(STAGE, group, name)
        ok, d = check(path, size, kind, exp)
        bad += not ok
        rows.append({"group": group, "file": name, "dest": dst, "url": url, "check": kind, "expected": exp,
                     "ok": ok, **d})
        print(("ok  " if ok else "BAD ") + f"{dst} {d['size']} {d['sha256']}", flush=True)
    return rows, bad


def place(items, root):
    for group, name, _url, _size, _kind, _exp, dst in items:
        target = os.path.join(root, dst)
        if os.path.exists(target):
            raise SystemExit(f"refusing to overwrite {target}")
    for group, name, _url, _size, _kind, _exp, dst in items:
        src = os.path.join(STAGE, group, name)
        target = os.path.join(root, dst)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp = target + ".copying"
        shutil.copyfile(src, tmp)
        os.replace(tmp, target)
    rows, bad = verify(items, root)
    with open(os.path.join(SCRATCH, "ck_placed.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump({"root": root, "revisions": REPOS, "rvm_url": RVM_URL, "files": rows}, f, indent=1)
    return bad


def main():
    items = plan()
    cmd = sys.argv[1]
    if cmd == "list":
        for it in items:
            print(it)
        print(len(items), "files", sum(it[3] for it in items), "bytes")
        return 0
    if cmd == "fetch":
        fetch(items)
        return 1 if verify(items)[1] else 0
    if cmd == "verify":
        return 1 if verify(items)[1] else 0
    if cmd == "place":
        return 1 if place(items, sys.argv[2]) else 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
