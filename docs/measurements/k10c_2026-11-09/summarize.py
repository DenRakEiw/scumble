"""Summarize K10c's 3-round alternating before/after 15000 x 10000 runs:
- native_test (Stack + Match)
- native_test (Filter band)
- export_test --perf (default, --blend=dissolve, --clipped)
- retention probes (px_probe.py --retention and retention_psd_wand.py).
"""
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


def gather_native(arm, sub="native"):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for f in sorted(glob.glob(os.path.join(HERE, arm, sub, "r*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        rows = j.get("rows") or {}
        b = (rows.get("build_the_file") or {}).get("row") or {}
        if b:
            put("build_the_file encodeMs", b.get("encodeMs"))
        for name in (
            "open_the_file",
            "add_the_paint_layer",
            "wand_whole_picture",
            "export_png",
            "export_psd",
            "export_ora",
            "match_export_png",
            "match_wand",
            "filter_export_png",
            "filter_wand",
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
            for k in ("jobs", "composeWasm", "kernel", "compose", "rows", "pack", "copyIn", "copyOut"):
                if k in psp:
                    put(f"{name} psd_part {k}", psp.get(k))
            si = jobs.get("stack_into") or {}
            for k in ("jobs", "composeWasm", "kernel", "copyIn", "copyOut"):
                if k in si:
                    put(f"{name} stack_into {k}", si.get(k))
            marks = r.get("marks") or {}
            for mop in ("program",):
                runs = marks.get(mop) or []
                if runs and isinstance(runs[0], dict):
                    for mk in ("pool", "upload", "filter", "read", "total"):
                        if mk in runs[0]:
                            put(f"{name} {mop} {mk}", runs[0].get(mk))
            wpx = (r.get("pxCalls") or {}).get("workers") or {}
            for k in ("composite_tile", "match_pixels", "clip_coverage", "dissolve_rows", "psd_pack_channel", "png_filter_rows", "deflate_part"):
                if k in wpx:
                    put(f"{name} worker {k} calls", wpx.get(k))
    return out


def gather_exportperf(arm, sub="exportperf"):
    out = {}
    put = lambda k, v: out.setdefault(k, []).append(v)
    for f in sorted(glob.glob(os.path.join(HERE, arm, sub, "r*.json"))):
        txt = open(f, encoding="utf-8").read().strip()
        if not txt:
            continue
        j = json.loads(txt)
        for step in ("composite_bands", "layer_from_tiles", "psd", "psd_masked"):
            s = j.get(step) or {}
            if not s:
                continue
            put(f"{sub} {step} wall", s.get("ms"))
            put(f"{sub} {step} longest block", s.get("blocked"))
            pp = ((s.get("jobs") or {}).get("png_part")) or {}
            for k in ("jobs", "composeWasm", "kernel", "compose", "rows", "prev", "filter", "deflate", "adler", "chunk", "copyIn", "copyOut"):
                if k in pp:
                    put(f"{sub} {step} png_part {k}", pp.get(k))
            pp_px = pp.get("pxCalls") or {}
            for k in ("clip_coverage", "dissolve_rows", "composite_tile"):
                if k in pp_px:
                    put(f"{sub} {step} png_part px.{k}", pp_px.get(k))
            psp = ((s.get("jobs") or {}).get("psd_part")) or {}
            for k in ("jobs", "composeWasm", "kernel", "compose", "rows", "pack", "copyIn", "copyOut"):
                if k in psp:
                    put(f"{sub} {step} psd_part {k}", psp.get(k))
            psp_px = psp.get("pxCalls") or {}
            for k in ("clip_coverage", "dissolve_rows", "composite_tile", "psd_pack_channel"):
                if k in psp_px:
                    put(f"{sub} {step} psd_part px.{k}", psp_px.get(k))
            si = ((s.get("jobs") or {}).get("stack_into")) or {}
            for k in ("jobs", "composeWasm", "kernel", "copyIn", "copyOut"):
                if k in si:
                    put(f"{sub} {step} stack_into {k}", si.get(k))
            si_px = si.get("pxCalls") or {}
            for k in ("clip_coverage", "dissolve_rows", "composite_tile"):
                if k in si_px:
                    put(f"{sub} {step} stack_into px.{k}", si_px.get(k))
    return out


def print_table(title, b, a, before_label="before (3359cb0f)", after_label="after (K10c)"):
    keys = list(dict.fromkeys(list(b) + list(a)))
    if not keys:
        return
    w = max(len(k) for k in keys) + 2
    print(f"\n=== {title} ===")
    print("row".ljust(w) + before_label.ljust(30) + after_label.ljust(30) + "before / after (medians)")
    for k in keys:
        mb = med(b.get(k, []))
        ma = med(a.get(k, []))
        ratio = ""
        if mb and ma and ma[0]:
            ratio = f"{mb[0] / ma[0]:.2f}x"
        print(k.ljust(w) + fmt(mb).ljust(30) + fmt(ma).ljust(30) + ratio)


def main():
    print_table(
        "15000 x 10000 native_test.py Stack + Match (3 alternating rounds, median [min-max] ms)",
        gather_native("before", "native"),
        gather_native("after", "native"),
    )
    print_table(
        "15000 x 10000 native_test.py Filter band (3 alternating rounds, median [min-max] ms)",
        gather_native("before", "native_filter"),
        gather_native("after", "native_filter"),
    )
    print_table(
        "15000 x 10000 export_test.py --perf default (3 alternating rounds, median [min-max] ms)",
        gather_exportperf("before", "exportperf"),
        gather_exportperf("after", "exportperf"),
    )
    print_table(
        "15000 x 10000 export_test.py --perf --blend=dissolve (3 alternating rounds, median [min-max] ms)",
        gather_exportperf("before", "exportperf_dissolve"),
        gather_exportperf("after", "exportperf_dissolve"),
        before_label="dissolveRows=js",
        after_label="dissolveRows=rust",
    )
    print_table(
        "15000 x 10000 export_test.py --perf --clipped (3 alternating rounds, median [min-max] ms)",
        gather_exportperf("before", "exportperf_clipped"),
        gather_exportperf("after", "exportperf_clipped"),
        before_label="clipCoverage=js",
        after_label="clipCoverage=rust",
    )
    for fname, title in (
        ("px_probe.jsonl", "px_probe.py --retention 15000x10000"),
        ("psd_wand.jsonl", "retention_psd_wand.py 15000x10000 (export_psd & wand_whole_picture)"),
    ):
        ret_file = os.path.join(HERE, "retention", fname)
        if os.path.exists(ret_file):
            print(f"\n=== {title} ===")
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
                    ms = j.get("exportMs", j.get("opMs", 0))
                    op = j.get("op", "export_png")
                    print(
                        f"op={op} routes={json.dumps(routes)} ms={ms:.1f} MB={j.get('MB', 0):.2f} "
                        f"workersMaxAfterMB={max_after:.2f} workersMaxLaterMB={max_later:.2f} "
                        f"totalAfterMB={tot_after:.2f} totalLaterMB={tot_later:.2f} "
                        f"releases={rels} idles={idles} focused={j.get('focused')}"
                    )


if __name__ == "__main__":
    main()
