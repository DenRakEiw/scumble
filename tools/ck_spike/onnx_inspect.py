"""A minimal ONNX protobuf reader (no onnx package here): opsets, inputs / outputs with dtype and shape, external data
locations, the op histogram, and the first and last nodes of a graph.

    python -I tools/ck_spike/onnx_inspect.py <graph.onnx> [--first N] [--last N] [--json out.json]
"""
import json
import struct
import sys
from collections import Counter

DT = {1: "float32", 2: "uint8", 3: "int8", 5: "int16", 6: "int32", 7: "int64", 9: "bool", 10: "float16", 11: "float64",
      16: "bfloat16"}


def varint(b, i):
    r = 0
    s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        if c < 0x80:
            return r, i
        s += 7


def fields(b):
    i = 0
    n = len(b)
    while i < n:
        key, i = varint(b, i)
        f, wt = key >> 3, key & 7
        if wt == 0:
            v, i = varint(b, i)
        elif wt == 1:
            v = b[i:i + 8]
            i += 8
        elif wt == 2:
            ln, i = varint(b, i)
            v = b[i:i + ln]
            i += ln
        elif wt == 5:
            v = b[i:i + 4]
            i += 4
        else:
            raise ValueError("wire type %d" % wt)
        yield f, wt, v


def s(v):
    return bytes(v).decode("utf-8", "replace")


def value_info(b):
    name, et, shape = None, None, []
    for f, _, v in fields(b):
        if f == 1:
            name = s(v)
        elif f == 2:
            for f2, _, v2 in fields(v):
                if f2 == 1:
                    for f3, _, v3 in fields(v2):
                        if f3 == 1:
                            et = DT.get(v3, v3)
                        elif f3 == 2:
                            for f4, _, v4 in fields(v3):
                                if f4 == 1:
                                    d = None
                                    for f5, _, v5 in fields(v4):
                                        d = v5 if f5 == 1 else s(v5)
                                    shape.append(d)
    return {"name": name, "dtype": et, "shape": shape}


def attr(b):
    a = {}
    for f, wt, v in fields(b):
        if f == 1:
            a["name"] = s(v)
        elif f == 2:
            a["f"] = struct.unpack("<f", v)[0]
        elif f == 3:
            a["i"] = v - (1 << 64) if v >= 1 << 63 else v
        elif f == 4:
            a["s"] = s(v)
        elif f == 7:
            a.setdefault("floats", []).append(struct.unpack("<f", v)[0]) if wt == 5 else a.setdefault("floats", []).extend(
                struct.unpack("<%df" % (len(v) // 4), v))
        elif f == 8:
            if wt == 0:
                a.setdefault("ints", []).append(v - (1 << 64) if v >= 1 << 63 else v)
            else:
                j = 0
                while j < len(v):
                    x, j = varint(v, j)
                    a.setdefault("ints", []).append(x - (1 << 64) if x >= 1 << 63 else x)
        elif f == 20:
            a["type"] = v
    return a


def node(b):
    n = {"in": [], "out": [], "attrs": []}
    for f, _, v in fields(b):
        if f == 1:
            n["in"].append(s(v))
        elif f == 2:
            n["out"].append(s(v))
        elif f == 3:
            n["name"] = s(v)
        elif f == 4:
            n["op"] = s(v)
        elif f == 5:
            n["attrs"].append(attr(v))
        elif f == 7:
            n["domain"] = s(v)
    return n


def tensor(b):
    t = {"dims": []}
    for f, wt, v in fields(b):
        if f == 1:
            t["dims"].append(v)
        elif f == 2:
            t["dtype"] = DT.get(v, v)
        elif f == 8:
            t["name"] = s(v)
        elif f == 13:
            kv = {}
            for f2, _, v2 in fields(v):
                if f2 == 1:
                    kv["k"] = s(v2)
                elif f2 == 2:
                    kv["v"] = s(v2)
            t.setdefault("external", {})[kv.get("k")] = kv.get("v")
        elif f == 14:
            t["data_location"] = v
        elif f == 9:
            t["raw_bytes"] = len(v)
    return t


def read(path):
    b = open(path, "rb").read()
    m = {"opsets": [], "producer": None}
    graph = None
    for f, _, v in fields(b):
        if f == 1:
            m["ir_version"] = v
        elif f == 2:
            m["producer"] = s(v)
        elif f == 3:
            m["producer_version"] = s(v)
        elif f == 7:
            graph = v
        elif f == 8:
            o = {}
            for f2, _, v2 in fields(v):
                if f2 == 1:
                    o["domain"] = s(v2)
                elif f2 == 2:
                    o["version"] = v2
            m["opsets"].append(o)
    nodes, inits, ins, outs, vi = [], [], [], [], 0
    for f, _, v in fields(graph):
        if f == 1:
            nodes.append(node(v))
        elif f == 5:
            inits.append(tensor(v))
        elif f == 11:
            ins.append(value_info(v))
        elif f == 12:
            outs.append(value_info(v))
        elif f == 13:
            vi += 1
    init_names = {t.get("name") for t in inits}
    m["inputs"] = [x for x in ins if x["name"] not in init_names]
    m["outputs"] = outs
    m["value_info_count"] = vi
    m["nodes"] = nodes
    m["initializers"] = inits
    return m


def main():
    path = sys.argv[1]
    first = int(sys.argv[sys.argv.index("--first") + 1]) if "--first" in sys.argv else 12
    last = int(sys.argv[sys.argv.index("--last") + 1]) if "--last" in sys.argv else 6
    m = read(path)
    ops = Counter((n.get("domain") or "") + "::" + n.get("op", "?") for n in m["nodes"])
    locs = Counter(t.get("external", {}).get("location") for t in m["initializers"])
    dtypes = Counter(t.get("dtype") for t in m["initializers"])
    summary = {"file": path, "ir_version": m.get("ir_version"), "producer": m["producer"],
               "producer_version": m.get("producer_version"), "opsets": m["opsets"], "inputs": m["inputs"],
               "outputs": m["outputs"], "nodes": len(m["nodes"]), "initializers": len(m["initializers"]),
               "initializer_dtypes": dict(dtypes), "external_locations": {str(k): c for k, c in locs.items()},
               "value_info": m["value_info_count"], "ops": dict(ops.most_common())}
    print(json.dumps(summary, indent=1))
    inputs = {x["name"] for x in m["inputs"]}
    print("--- first nodes")
    for n in m["nodes"][:first]:
        print(n.get("op"), n["in"], "->", n["out"], [a for a in n["attrs"] if "type" not in a or True][:4])
    print("--- nodes reading a graph input")
    for n in m["nodes"]:
        if any(x in inputs for x in n["in"]):
            print(n.get("op"), n["in"], "->", n["out"], n["attrs"][:4])
    print("--- last nodes")
    for n in m["nodes"][-last:]:
        print(n.get("op"), n["in"], "->", n["out"], n["attrs"][:4])
    if "--json" in sys.argv:
        json.dump(summary, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1)


if __name__ == "__main__":
    main()
