"""Summarize K10b's 3-round alternating before/after 15000 x 10000 runs (native_test, exportperf, tiffperf, retention)."""
import glob
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))


def med(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return None
    return (statistics.median(vals), min(vals), max(vals), len(vals))


def fmt(m):
    if m is None:
        return "-"
    v, lo, hi, n = m
    return f"{v:,.1f} [{lo:,.1f}-{hi:,.1f}]" + ("" if n == 3 else f" (n={n})")


def gather_native(arm):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for f in sorted(glob.glob(os.path.join(HERE, arm, "native", "r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        rows = j.get("rows") or {}
        b = (rows.get("build_the_file") or {}).get("row") or {}
        put("build_the_file encodeMs", b.get("encodeMs"))
        for name in (
            "open_the_file",
            "add_the_paint_layer",
            "wand_whole_picture",
            "export_png",
            "export_psd",
            "export_ora",
            "open_psd",
            "open_ora",
            "match_export_png",
        ):
            r = (rows.get(name) or {}).get("row") or {}
            if not r:
                continue
            put(f"{name} wall", r.get("wall"))
            put(f"{name} longest block", r.get("blocked"))
            jobs = r.get("jobs") or {}
            pp = jobs.get("png_part") or {}
            for k in ("jobs", "composeWasm", "kernel", "compose", "rows", "prev", "filter", "deflate", "adler", "chunk", "copyIn", "copyOut"):
                if k in pp:
                    put(f"{name} png_part {k}", pp.get(k))
            psp = jobs.get("psd_part") or {}
            for k in ("jobs", "kernel", "rows", "pack"):
                if k in psp:
                    put(f"{name} psd_part {k}", psp.get(k))
            si = jobs.get("stack_into") or {}
            for k in ("jobs", "kernel"):
                if k in si:
                    put(f"{name} stack_into {k}", si.get(k))
            marks = r.get("marks") or {}
            for mop in ("psd_open", "ora_open"):
                runs = marks.get(mop) or []
                if runs and isinstance(runs[0], dict):
                    for mk in ("stored", "total", "layers", "merged"):
                        if mk in runs[0]:
                            put(f"{name} {mop} {mk}", runs[0].get(mk))
            wpx = (r.get("pxCalls") or {}).get("workers") or {}
            for k in ("composite_tile", "match_pixels", "png_filter_rows", "deflate_part", "adler32", "png_chunk_frame"):
                if k in wpx:
                    put(f"{name} worker {k} calls", wpx.get(k))
    return out


def gather_exportperf(arm):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for f in sorted(glob.glob(os.path.join(HERE, arm, "exportperf", "r*.json"))):
        txt = open(f, encoding="utf-8").read().strip()
        if not txt:
            continue
        j = json.loads(txt)
        for step in ("composite_bands", "layer_from_tiles", "psd", "psd_masked"):
            s = j.get(step) or {}
            if not s:
                continue
            put(f"exportperf {step} wall", s.get("ms"))
            put(f"exportperf {step} longest block", s.get("blocked"))
            pp = ((s.get("jobs") or {}).get("png_part")) or {}
            for k in ("jobs", "composeWasm", "kernel", "compose", "rows", "prev", "filter", "deflate", "adler", "chunk", "copyIn", "copyOut"):
                if k in pp:
                    put(f"exportperf {step} png_part {k}", pp.get(k))
            psp = ((s.get("jobs") or {}).get("psd_part")) or {}
            for k in ("jobs", "kernel", "rows", "pack"):
                if k in psp:
                    put(f"exportperf {step} psd_part {k}", psp.get(k))
    return out


def gather_tiffperf(arm):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for f in sorted(glob.glob(os.path.join(HERE, arm, "tiffperf", "r*.log"))):
        with open(f, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                for vname in ("noise", "own"):
                    prefix = f"[ok] variant {vname}: "
                    if line.startswith(prefix):
                        j = json.loads(line[len(prefix):])
                        put(f"tiffperf {vname} exportMs", j.get("exportMs"))
                        put(f"tiffperf {vname} openMs", j.get("openMs"))
                        os_steps = j.get("openSteps") or {}
                        for mk in ("stored", "pixels", "writeMs", "total"):
                            if mk in os_steps:
                                put(f"tiffperf {vname} openSteps {mk}", os_steps.get(mk))
                        oj = ((j.get("openJobs") or {}).get("png_part")) or {}
                        for k in ("jobs", "composeWasm", "kernel", "rows", "prev", "filter", "deflate", "adler", "chunk", "copyIn", "copyOut"):
                            if k in oj:
                                put(f"tiffperf {vname} open png_part {k}", oj.get(k))
    return out


def print_table(title, b, a):
    keys = list(dict.fromkeys(list(b) + list(a)))
    if not keys:
        return
    w = max(len(k) for k in keys) + 2
    print(f"\n=== {title} ===")
    print("row".ljust(w) + "before (3fd8bda7)".ljust(30) + "after (K10b)".ljust(30) + "before / after (medians)")
    for k in keys:
        mb = med(b.get(k, []))
        ma = med(a.get(k, []))
        ratio = ""
        if mb and ma and ma[0]:
            ratio = f"{mb[0] / ma[0]:.2f}x"
        print(k.ljust(w) + fmt(mb).ljust(30) + fmt(ma).ljust(30) + ratio)


def main():
    print_table(
        "15000 x 10000 native_test.py (3 alternating rounds, median [min-max] ms)",
        gather_native("before"),
        gather_native("after"),
    )
    print_table(
        "15000 x 10000 export_test.py --perf (3 alternating rounds, median [min-max] ms)",
        gather_exportperf("before"),
        gather_exportperf("after"),
    )
    print_table(
        "15000 x 10000 tiff_test.py --size (3 alternating rounds, median [min-max] ms)",
        gather_tiffperf("before"),
        gather_tiffperf("after"),
    )
    ret_file = os.path.join(HERE, "retention", "px_probe.jsonl")
    if os.path.exists(ret_file):
        print("\n=== px_probe.py --retention 15000x10000 ===")
        with open(ret_file, encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                j = json.loads(line)
                routes = j.get("routes") or {}
                aft = [t for t in (j.get("after") or []) if t.get("thread", "").startswith("pool ")]
                lat = [t for t in (j.get("later") or []) if t.get("thread", "").startswith("pool ")]
                max_after = max((t.get("bytes", 0) for t in aft), default=0) / 1048576
                max_later = max((t.get("bytes", 0) for t in lat), default=0) / 1048576
                tot_after = sum(t.get("bytes", 0) for t in (j.get("after") or [])) / 1048576
                tot_later = sum(t.get("bytes", 0) for t in (j.get("later") or [])) / 1048576
                rels = sum(t.get("release", 0) for t in (j.get("later") or []))
                idles = sum(t.get("idle", 0) for t in (j.get("later") or []))
                print(
                    f"routes={json.dumps(routes)} exportMs={j.get('exportMs', 0):.1f} MB={j.get('MB', 0):.2f} "
                    f"workersMaxAfterMB={max_after:.2f} workersMaxLaterMB={max_later:.2f} "
                    f"totalAfterMB={tot_after:.2f} totalLaterMB={tot_later:.2f} "
                    f"releases={rels} idles={idles} focused={j.get('focused')}"
                )


if __name__ == "__main__":
    main()
