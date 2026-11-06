"""Generate the five stills through the Scumble dev instance on port 9571 (one at a time), then hash them.

    SCUMBLE_CDP_PORT=9571 python make_stills.py [name ...]
"""
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
cfg = json.load(open(os.path.join(HERE, "stills.json"), encoding="utf-8"))
tpl = open(os.path.join(HERE, "still.js.tpl"), encoding="utf-8").read()
only = set(sys.argv[1:])
results = []
for s in cfg["stills"]:
    if only and s["name"] not in only:
        continue
    path = cfg["out_dir"] + "/" + s["name"] + ".png"
    params = {"recipe": cfg["recipe"], "aspect": cfg["aspect"], "resolution": cfg["resolution"], "megapixels": cfg["megapixels"],
              "seed": s["seed"], "prompt": s["prompt"], "name": s["name"], "path": path}
    body = tpl.replace("__PARAMS__", json.dumps(params))
    bp = os.path.join(HERE, "run_%s.js" % s["name"])
    open(bp, "w", encoding="utf-8", newline=chr(10)).write(body)
    r = subprocess.run([sys.executable, os.path.join(HERE, "drive.py"), bp, "1000"], capture_output=True, text=True, encoding="utf-8")
    outp = os.path.join(HERE, "run_%s.out" % s["name"])
    open(outp, "w", encoding="utf-8", newline=chr(10)).write(r.stdout + "\n--stderr--\n" + r.stderr)
    sha = None
    if os.path.isfile(path):
        sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
    results.append({"name": s["name"], "rc": r.returncode, "path": path, "sha256": sha, "bytes": os.path.getsize(path) if sha else None})
    print(json.dumps(results[-1]), flush=True)
json.dump(results, open(os.path.join(HERE, "stills_done.json"), "w"), indent=1)
