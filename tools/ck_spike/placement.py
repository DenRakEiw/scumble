"""CorridorKey spike (I0b): the node placement per graph from ORT's verbose session log (main.js --task placement).

    python -I tools/ck_spike/placement.py <run dir> [--out placement.txt] [--json placement.json]

Per label and graph: the providers' node counts after ORT's optimisations ("Node placements", session_state.cc), the
CPU share, the CPU-placed nodes by op type (and whether any sits inside an attention block: a node name with "attn"),
and a load error with the log lines just before it.
"""
import glob
import json
import os
import re
import sys
from collections import Counter

MARK = re.compile(r"===== CK_SPIKE graph (\w+) (\S+) (\w+)")
SUMMARY = re.compile(r"(All nodes|Node\(s\)) placed on \[(\w+)\]\. Number of nodes: (\d+)")
NODE = re.compile(r"\]\s+ (\S+) \(([^)]*)\)\s*$")


def parse(path):
    graphs = {}
    cur = None
    in_block = False
    ep = None
    tail = []
    for line in open(path, encoding="utf-8", errors="replace"):
        m = MARK.search(line)
        if m:
            cur = {"graph": m.group(1), "bucket": m.group(2), "provider": m.group(3), "eps": {}, "cpu_nodes": [], "error": None}
            graphs[m.group(1)] = cur
            in_block = False
            tail = []
            continue
        if cur is None:
            continue
        tail.append(line.rstrip()[:300])
        tail = tail[-6:]
        if "Node placements" in line:
            in_block = True
            continue
        s = SUMMARY.search(line)
        if s and in_block:
            ep = s.group(2)
            cur["eps"][ep] = cur["eps"].get(ep, 0) + int(s.group(3))
            continue
        if in_block and ep and "VerifyEachNodeIsAssignedToAnEp" in line:
            n = NODE.search(line)
            if n and "CPU" in ep:
                cur["cpu_nodes"].append({"op": n.group(1), "name": n.group(2)})
            continue
        if in_block and "VerifyEachNodeIsAssignedToAnEp" not in line:
            in_block = False
        if ("Exception during initialization" in line or "[E:onnxruntime" in line) and not cur["error"]:
            cur["error"] = {"line": line.strip()[:600], "before": tail[:-1]}
    return graphs


def main():
    run = sys.argv[1]
    out_txt = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else None
    out_json = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    res = {}
    lines = []
    for p in sorted(glob.glob(os.path.join(run, "placement_*.stderr.log"))):
        label = os.path.basename(p)[: -len(".stderr.log")]
        g = parse(p)
        res[label] = g
        for name, r in g.items():
            total = sum(r["eps"].values())
            cpu = sum(v for k, v in r["eps"].items() if "CPU" in k)
            ops = Counter(n["op"] for n in r["cpu_nodes"])
            attn = [n["name"] for n in r["cpu_nodes"] if "attn" in n["name"].lower()]
            r.update(total=total, cpu=cpu, cpu_share=(cpu / total if total else None), cpu_ops=dict(ops), cpu_in_attention=len(attn))
            eps = ", ".join("%s %d" % kv for kv in r["eps"].items()) or "-"
            err = (" ERROR: " + r["error"]["line"][:200]) if r["error"] else ""
            share = ("%.1f %%" % (100 * r["cpu_share"])) if r["cpu_share"] is not None else "-"
            lines.append("%-26s %-7s nodes %5s  %s  CPU %s%s%s" % (label, name, total or "-", eps, share,
                         (" cpu ops " + json.dumps(dict(ops.most_common(8)))) if ops else "", err))
    text = "\n".join(lines)
    print(text)
    if out_txt:
        open(out_txt, "w", encoding="utf-8", newline=chr(10)).write(text + "\n")
    if out_json:
        json.dump(res, open(out_json, "w", encoding="utf-8"), indent=1)


if __name__ == "__main__":
    main()
