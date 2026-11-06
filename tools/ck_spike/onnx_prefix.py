"""CorridorKey spike (I0b): write the first K nodes of an ONNX graph as a graph of its own (the outputs of node K-1 as its
outputs, everything else byte for byte), to find the node a provider refuses by bisection (DirectML's stage 1).

    python -I tools/ck_spike/onnx_prefix.py <graph.onnx> <K> <out.onnx>      -> prints node K-1's op, name and outputs
    python -I tools/ck_spike/onnx_prefix.py <graph.onnx> --count             -> the number of nodes

The initializers keep their external-data references (relative to the graph's folder), so <out.onnx> goes into a folder
that holds the same <component>.weights (a hard link). The new outputs carry their name only; ORT infers their types.
"""
import sys


def varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        if c < 0x80:
            return r, i
        s += 7


def enc_varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def fields(b):
    """(field, wire type, value, raw record bytes) for each top-level record of a message."""
    i, n = 0, len(b)
    while i < n:
        st = i
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
            raise ValueError(wt)
        yield f, wt, v, b[st:i]


def ld(field, payload):
    return enc_varint((field << 3) | 2) + enc_varint(len(payload)) + payload


def node_info(v):
    op, name, outs = "", "", []
    for f, _, x, _ in fields(v):
        if f == 4:
            op = bytes(x).decode()
        elif f == 3:
            name = bytes(x).decode()
        elif f == 2:
            outs.append(bytes(x).decode())
    return op, name, outs


def main():
    b = open(sys.argv[1], "rb").read()
    top = list(fields(b))
    graph = next(v for f, _, v, _ in top if f == 7)
    gf = list(fields(graph))
    nodes = [(v, raw) for f, _, v, raw in gf if f == 1]
    if sys.argv[2] == "--count":
        print(len(nodes))
        return
    k = int(sys.argv[2])
    op, name, outs = node_info(nodes[k - 1][0])
    keep = bytearray()
    seen_nodes = 0
    for f, _, v, raw in gf:
        if f == 1:
            if seen_nodes < k:
                keep += raw
            seen_nodes += 1
        elif f in (12, 13):   # outputs and value_info dropped
            continue
        else:
            keep += raw
    for o in outs:
        keep += ld(12, ld(1, o.encode()))
    model = bytearray()
    for f, _, v, raw in top:
        model += ld(7, bytes(keep)) if f == 7 else raw
    open(sys.argv[3], "wb").write(bytes(model))
    print("%d %s %s %s" % (k, op, name, outs))


if __name__ == "__main__":
    main()
