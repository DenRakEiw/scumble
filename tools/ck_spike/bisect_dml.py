"""CorridorKey spike (I0b): find the first node of a graph that DirectML refuses (stage 1's 80070057), by bisection over
the graph's node prefixes (onnx_prefix.py), each loaded by try_load.js in a fresh Node process.

    python -I tools/ck_spike/bisect_dml.py <graph.onnx> <component.weights> <work dir> <node_modules dir> [nofusion|fusion]

The work dir gets a hard link of the weights and the prefix graphs; only an error with 80070057 counts as the refusal.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    graph, weights, work, ort = sys.argv[1:5]
    mode = sys.argv[5] if len(sys.argv) > 5 else "nofusion"
    os.makedirs(work, exist_ok=True)
    wl = os.path.join(work, os.path.basename(weights))
    if not os.path.exists(wl):
        os.link(weights, wl)
    n = int(subprocess.check_output([sys.executable, "-I", os.path.join(HERE, "onnx_prefix.py"), graph, "--count"]).decode())
    steps = []

    def test(k):
        out = os.path.join(work, "prefix_%d.onnx" % k)
        info = subprocess.check_output([sys.executable, "-I", os.path.join(HERE, "onnx_prefix.py"), graph, str(k), out]).decode().strip()
        r = subprocess.run(["node", os.path.join(HERE, "try_load.js"), ort, out, "dml", mode], capture_output=True, text=True, timeout=600)
        res = (r.stdout.strip() or r.stderr.strip()).splitlines()[-1] if (r.stdout.strip() or r.stderr.strip()) else "?"
        os.remove(out)
        verdict = "OK" if res.startswith("OK") else ("REFUSED" if "80070057" in res else "OTHER")
        steps.append({"k": k, "node": info, "verdict": verdict, "result": res[:300]})
        print(json.dumps(steps[-1]), flush=True)
        return verdict

    full = test(n)
    if full != "REFUSED":
        print(json.dumps({"stop": "the whole graph is not refused with 80070057", "verdict": full}))
        return
    lo, hi = 0, n   # prefix lo builds, prefix hi is refused
    while hi - lo > 1:
        mid = (lo + hi) // 2
        v = test(mid)
        if v == "OK":
            lo = mid
        elif v == "REFUSED":
            hi = mid
        else:
            print(json.dumps({"stop": "another error at %d" % mid}))
            break
    first = next((s for s in steps if s["k"] == hi), None)
    print(json.dumps({"first_refused_prefix": hi, "last_node_of_it": first and first["node"], "mode": mode, "nodes": n}))


if __name__ == "__main__":
    main()
