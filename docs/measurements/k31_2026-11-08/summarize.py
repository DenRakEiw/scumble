import json
import pathlib
import statistics

base = pathlib.Path(__file__).resolve().parent / "ab"
before_runs = [json.loads((base / "before" / f"liquify_r{r}.json").read_text()) for r in (1, 2, 3)]
after_runs = [json.loads((base / "after" / f"liquify_r{r}.json").read_text()) for r in (1, 2, 3)]

def fmt(vals, d=1):
    vals = [v for v in vals if v is not None]
    if not vals:
        return "None"
    med = statistics.median(vals)
    lo, hi = min(vals), max(vals)
    return f"{med:.{d}f} [{lo:.{d}f}-{hi:.{d}f}]"

def row_by(run, name):
    for row in run["rows"]:
        if row.get("row") == name:
            return row
    raise KeyError(name)

lines = []
lines.append(f"{'row':<64} {'before (js)':>22} {'after (rust)':>22}")
lines.append(f"  {'route.liquifyDab':<62} {str([r['routes'].get('liquifyDab') for r in before_runs]):>22} {str([r['routes'].get('liquifyDab') for r in after_runs]):>22}")

for view in ("fit", "1:1"):
    for size in (200, 1000):
        tag = f"push {view} size {size}"
        b_rows = [row_by(r, tag) for r in before_runs]
        a_rows = [row_by(r, tag) for r in after_runs]
        for stat_k in ("p50", "p95", "worst"):
            lines.append(f"  {tag} dab {stat_k} (ms){'':<{62-len(f'{tag} dab {stat_k} (ms)')}} {fmt([x['dab'][stat_k] for x in b_rows], 1):>22} {fmt([x['dab'][stat_k] for x in a_rows], 1):>22}   n=3/3")
        for lap_k in ("nodes", "kernel", "write"):
            lines.append(f"  {tag} lap {lap_k} p50 (ms){'':<{62-len(f'{tag} lap {lap_k} p50 (ms)')}} {fmt([x['dabLaps'][lap_k]['p50'] for x in b_rows], 2):>22} {fmt([x['dabLaps'][lap_k]['p50'] for x in a_rows], 2):>22}   n=3/3")
        lines.append(f"  {tag} preview p50 (ms){'':<{62-len(f'{tag} preview p50 (ms)')}} {fmt([x['preview']['p50'] for x in b_rows], 1):>22} {fmt([x['preview']['p50'] for x in a_rows], 1):>22}   n=3/3")
        lines.append(f"  {tag} frame p50 (ms){'':<{62-len(f'{tag} frame p50 (ms)')}} {fmt([x['frame']['p50'] for x in b_rows], 1):>22} {fmt([x['frame']['p50'] for x in a_rows], 1):>22}   n=3/3")
        lines.append(f"  {tag} frame p95 (ms){'':<{62-len(f'{tag} frame p95 (ms)')}} {fmt([x['frame']['p95'] for x in b_rows], 1):>22} {fmt([x['frame']['p95'] for x in a_rows], 1):>22}   n=3/3")
        lines.append(f"  {tag} land (ms){'':<{62-len(f'{tag} land (ms)')}} {fmt([x['land'] for x in b_rows], 1):>22} {fmt([x['land'] for x in a_rows], 1):>22}   n=3/3")
        lines.append(f"  {tag} land upSync (ms){'':<{62-len(f'{tag} land upSync (ms)')}} {fmt([x['landSplit']['upSync'] for x in b_rows], 1):>22} {fmt([x['landSplit']['upSync'] for x in a_rows], 1):>22}   n=3/3")
        lines.append(f"  {tag} land commit (ms){'':<{62-len(f'{tag} land commit (ms)')}} {fmt([x['landSplit']['commit'] for x in b_rows], 1):>22} {fmt([x['landSplit']['commit'] for x in a_rows], 1):>22}   n=3/3")
        lines.append(f"  {tag} heapMB0{'':<{62-len(f'{tag} heapMB0')}} {fmt([x['landSplit']['heapMB0'] for x in b_rows], 1):>22} {fmt([x['landSplit']['heapMB0'] for x in a_rows], 1):>22}   n=3/3")
        lines.append(f"  {tag} heapMB1{'':<{62-len(f'{tag} heapMB1')}} {fmt([x['landSplit']['heapMB1'] for x in b_rows], 1):>22} {fmt([x['landSplit']['heapMB1'] for x in a_rows], 1):>22}   n=3/3")
        lines.append(f"  {tag} blockedMax (ms){'':<{62-len(f'{tag} blockedMax (ms)')}} {fmt([x['blockedMax'] for x in b_rows], 1):>22} {fmt([x['blockedMax'] for x in a_rows], 1):>22}   n=3/3")
        lines.append(f"  {tag} pxCalls.liquify_dab{'':<{62-len(f'{tag} pxCalls.liquify_dab')}} {str([x['pxCalls'].get('liquify_dab', 0) for x in b_rows]):>22} {str([x['pxCalls'].get('liquify_dab', 0) for x in a_rows]):>22}")

tag = "shrink held 150 ticks size 1000"
b_rows = [row_by(r, tag) for r in before_runs]
a_rows = [row_by(r, tag) for r in after_runs]
for lap_k in ("nodes", "kernel", "write"):
    lines.append(f"  {tag} lap {lap_k} p50 (ms){'':<{62-len(f'{tag} lap {lap_k} p50 (ms)')}} {fmt([x['dabLaps'][lap_k]['p50'] for x in b_rows], 2):>22} {fmt([x['dabLaps'][lap_k]['p50'] for x in a_rows], 2):>22}   n=3/3")
for stat_k in ("p50", "p95", "worst"):
    lines.append(f"  {tag} tick {stat_k} (ms){'':<{62-len(f'{tag} tick {stat_k} (ms)')}} {fmt([x['tick'][stat_k] for x in b_rows], 1):>22} {fmt([x['tick'][stat_k] for x in a_rows], 1):>22}   n=3/3")
lines.append(f"  {tag} land (ms){'':<{62-len(f'{tag} land (ms)')}} {fmt([x['land'] for x in b_rows], 1):>22} {fmt([x['land'] for x in a_rows], 1):>22}   n=3/3")
lines.append(f"  {tag} land upSync (ms){'':<{62-len(f'{tag} land upSync (ms)')}} {fmt([x['landSplit']['upSync'] for x in b_rows], 1):>22} {fmt([x['landSplit']['upSync'] for x in a_rows], 1):>22}   n=3/3")
lines.append(f"  {tag} land commit (ms){'':<{62-len(f'{tag} land commit (ms)')}} {fmt([x['landSplit']['commit'] for x in b_rows], 1):>22} {fmt([x['landSplit']['commit'] for x in a_rows], 1):>22}   n=3/3")
lines.append(f"  {tag} heapMB0{'':<{62-len(f'{tag} heapMB0')}} {fmt([x['landSplit']['heapMB0'] for x in b_rows], 1):>22} {fmt([x['landSplit']['heapMB0'] for x in a_rows], 1):>22}   n=3/3")
lines.append(f"  {tag} heapMB1{'':<{62-len(f'{tag} heapMB1')}} {fmt([x['landSplit']['heapMB1'] for x in b_rows], 1):>22} {fmt([x['landSplit']['heapMB1'] for x in a_rows], 1):>22}   n=3/3")
lines.append(f"  {tag} blockedMax (ms){'':<{62-len(f'{tag} blockedMax (ms)')}} {fmt([x['blockedMax'] for x in b_rows], 1):>22} {fmt([x['blockedMax'] for x in a_rows], 1):>22}   n=3/3")
lines.append(f"  {tag} pxCalls.liquify_dab{'':<{62-len(f'{tag} pxCalls.liquify_dab')}} {str([x['pxCalls'].get('liquify_dab', 0) for x in b_rows]):>22} {str([x['pxCalls'].get('liquify_dab', 0) for x in a_rows]):>22}")

for area in ("pushed", "empty"):
    tag = f"restore 1:1 size 1000 {area}"
    b_rows = [row_by(r, tag) for r in before_runs]
    a_rows = [row_by(r, tag) for r in after_runs]
    for stat_k in ("p50", "p95", "worst"):
        lines.append(f"  {tag} dab {stat_k} (ms){'':<{62-len(f'{tag} dab {stat_k} (ms)')}} {fmt([x['dab'][stat_k] for x in b_rows], 1):>22} {fmt([x['dab'][stat_k] for x in a_rows], 1):>22}   n=3/3")
    for lap_k in ("nodes", "kernel", "write"):
        lines.append(f"  {tag} lap {lap_k} p50 (ms){'':<{62-len(f'{tag} lap {lap_k} p50 (ms)')}} {fmt([x['dabLaps'][lap_k]['p50'] for x in b_rows], 2):>22} {fmt([x['dabLaps'][lap_k]['p50'] for x in a_rows], 2):>22}   n=3/3")
    lines.append(f"  {tag} preview p50 (ms){'':<{62-len(f'{tag} preview p50 (ms)')}} {fmt([x['preview']['p50'] for x in b_rows], 1):>22} {fmt([x['preview']['p50'] for x in a_rows], 1):>22}   n=3/3")
    lines.append(f"  {tag} frame p50 (ms){'':<{62-len(f'{tag} frame p50 (ms)')}} {fmt([x['frame']['p50'] for x in b_rows], 1):>22} {fmt([x['frame']['p50'] for x in a_rows], 1):>22}   n=3/3")
    lines.append(f"  {tag} frame p95 (ms){'':<{62-len(f'{tag} frame p95 (ms)')}} {fmt([x['frame']['p95'] for x in b_rows], 1):>22} {fmt([x['frame']['p95'] for x in a_rows], 1):>22}   n=3/3")
    lines.append(f"  {tag} land (ms){'':<{62-len(f'{tag} land (ms)')}} {fmt([x['land'] for x in b_rows], 1):>22} {fmt([x['land'] for x in a_rows], 1):>22}   n=3/3")
    if area == "pushed":
        lines.append(f"  {tag} land upSync (ms){'':<{62-len(f'{tag} land upSync (ms)')}} {fmt([x['landSplit']['upSync'] for x in b_rows], 1):>22} {fmt([x['landSplit']['upSync'] for x in a_rows], 1):>22}   n=3/3")
        lines.append(f"  {tag} land commit (ms){'':<{62-len(f'{tag} land commit (ms)')}} {fmt([x['landSplit']['commit'] for x in b_rows], 1):>22} {fmt([x['landSplit']['commit'] for x in a_rows], 1):>22}   n=3/3")
    lines.append(f"  {tag} blockedMax (ms){'':<{62-len(f'{tag} blockedMax (ms)')}} {fmt([x['blockedMax'] for x in b_rows], 1):>22} {fmt([x['blockedMax'] for x in a_rows], 1):>22}   n=3/3")
    lines.append(f"  {tag} pxCalls.liquify_dab{'':<{62-len(f'{tag} pxCalls.liquify_dab')}} {str([x['pxCalls'].get('liquify_dab', 0) for x in b_rows]):>22} {str([x['pxCalls'].get('liquify_dab', 0) for x in a_rows]):>22}")

    if area == "pushed":
        ra_b = [row_by(r, "restore all") for r in before_runs]
        ra_a = [row_by(r, "restore all") for r in after_runs]
        lines.append(f"  {'restore all wall (ms)':<62} {fmt([x['ms'] for x in ra_b], 1):>22} {fmt([x['ms'] for x in ra_a], 1):>22}   n=3/3")
        lines.append(f"  {'restore all blockedMax (ms)':<62} {fmt([x['blockedMax'] for x in ra_b], 1):>22} {fmt([x['blockedMax'] for x in ra_a], 1):>22}   n=3/3")

tag = "pause 2s 1:1 size 1000"
b_rows = [row_by(r, tag) for r in before_runs]
a_rows = [row_by(r, tag) for r in after_runs]
lines.append(f"  {tag} dab (ms){'':<{62-len(f'{tag} dab (ms)')}} {fmt([x['dab'] for x in b_rows], 1):>22} {fmt([x['dab'] for x in a_rows], 1):>22}   n=3/3")
lines.append(f"  {tag} midDab (ms){'':<{62-len(f'{tag} midDab (ms)')}} {fmt([x['midDab'] for x in b_rows], 1):>22} {fmt([x['midDab'] for x in a_rows], 1):>22}   n=3/3")
for lap_k in ("nodes", "kernel", "write"):
    lines.append(f"  {tag} lap {lap_k} (ms){'':<{62-len(f'{tag} lap {lap_k} (ms)')}} {fmt([x['dabLaps'][lap_k] for x in b_rows], 2):>22} {fmt([x['dabLaps'][lap_k] for x in a_rows], 2):>22}   n=3/3")
for lap_k in ("nodes", "kernel", "write"):
    lines.append(f"  {tag} midLap {lap_k} (ms){'':<{62-len(f'{tag} midLap {lap_k} (ms)')}} {fmt([x['midDabLaps'][lap_k] for x in b_rows], 2):>22} {fmt([x['midDabLaps'][lap_k] for x in a_rows], 2):>22}   n=3/3")
lines.append(f"  {tag} land (ms){'':<{62-len(f'{tag} land (ms)')}} {fmt([x['land'] for x in b_rows], 1):>22} {fmt([x['land'] for x in a_rows], 1):>22}   n=3/3")
lines.append(f"  {tag} pxCalls.liquify_dab{'':<{62-len(f'{tag} pxCalls.liquify_dab')}} {str([x['pxCalls'].get('liquify_dab', 0) for x in b_rows]):>22} {str([x['pxCalls'].get('liquify_dab', 0) for x in a_rows]):>22}")

out_path = base.parent / "summary_rows.txt"
out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("\n".join(lines))
