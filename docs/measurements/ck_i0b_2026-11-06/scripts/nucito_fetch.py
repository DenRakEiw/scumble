"""I0b: Nucito/corridorkey-web@1ae72ca into the scratch folder, every file verified before it is moved into place.

    python -I nucito_fetch.py <tree.json> <dest dir> <log.json>

Each file: https://huggingface.co/Nucito/corridorkey-web/resolve/<rev>/<path> -> <dest>/incoming/<path>.part (resumed
with Range), then size and hash checked (LFS files: the sha256 of the tree listing's lfs.oid; small files: the git blob
sha1 of the listing's oid), then renamed to <dest>/set/<path>. No token is sent (the repo is public, not gated).
"""
import hashlib
import json
import os
import sys
import time
import urllib.request

REPO = "Nucito/corridorkey-web"
REV = "1ae72ca7270b4fb2f64e98b5c3cc6e6ee4103957"


def digest(path, kind, size):
    h = hashlib.sha256() if kind == "sha256" else hashlib.sha1()
    if kind == "sha1":
        h.update(b"blob %d\0" % size)
    with open(path, "rb") as f:
        while True:
            b = f.read(1 << 22)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def fetch(url, part, size):
    have = os.path.getsize(part) if os.path.exists(part) else 0
    if have > size:
        os.remove(part)
        have = 0
    if have == size:
        return 0
    req = urllib.request.Request(url, headers={"User-Agent": "scumble-ck-spike/1"})
    if have:
        req.add_header("Range", "bytes=%d-" % have)
    with urllib.request.urlopen(req, timeout=120) as r:
        if have and r.status != 206:
            have = 0
        with open(part, "ab" if have else "wb") as f:
            while True:
                b = r.read(1 << 22)
                if not b:
                    break
                f.write(b)
    return have


def main():
    tree = json.load(open(sys.argv[1], encoding="utf-8"))
    dest = sys.argv[2]
    log_path = sys.argv[3]
    inc = os.path.join(dest, "incoming")
    out = os.path.join(dest, "set")
    os.makedirs(inc, exist_ok=True)
    os.makedirs(out, exist_ok=True)
    rows = []
    files = [e for e in tree if e["type"] == "file"]
    files.sort(key=lambda e: e["size"])
    t_all = time.time()
    for e in files:
        p = e["path"]
        size = e["size"]
        lfs = e.get("lfs")
        kind, want = ("sha256", lfs["oid"]) if lfs else ("sha1", e["oid"])
        final = os.path.join(out, p)
        url = "https://huggingface.co/%s/resolve/%s/%s" % (REPO, REV, p)
        row = {"path": p, "url": url, "revision": REV, "size": size, "hash_kind": kind, "expected": want}
        if os.path.exists(final) and os.path.getsize(final) == size and digest(final, kind, size) == want:
            row.update(status="already in place", got=want)
            rows.append(row)
            continue
        part = os.path.join(inc, p + ".part")
        t0 = time.time()
        for attempt in range(4):
            try:
                resumed = fetch(url, part, size)
                break
            except Exception as ex:  # noqa: BLE001
                print("retry", p, attempt, ex, file=sys.stderr, flush=True)
                time.sleep(5)
        else:
            row.update(status="failed")
            rows.append(row)
            continue
        got_size = os.path.getsize(part)
        got = digest(part, kind, got_size)
        row.update(got_size=got_size, got=got, seconds=round(time.time() - t0, 1), resumed_from=resumed)
        if got_size == size and got == want:
            os.replace(part, final)
            row["status"] = "verified, in place"
        else:
            os.remove(part)
            row["status"] = "MISMATCH, deleted"
        rows.append(row)
        print(row["status"], p, size, row.get("seconds"), flush=True)
    json.dump({"repo": REPO, "revision": REV, "seconds": round(time.time() - t_all, 1), "files": rows},
              open(log_path, "w", encoding="utf-8"), indent=1)
    bad = [r for r in rows if not r["status"].startswith(("verified", "already"))]
    print("files", len(rows), "bad", len(bad), "total bytes", sum(r["size"] for r in rows))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
