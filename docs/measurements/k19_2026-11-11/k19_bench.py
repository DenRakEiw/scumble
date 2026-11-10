"""K19 of docs/PLAN_WASM_BUILD.md (4.6): one TIFF export A/B row at 15,000 x 10,000.

    python k19_bench.py <tree> <arm> <variant> <out_dir> <photo> <result.json>

<tree> is the scratch tree the running instance was started from (its tools/tiff_test.py is used, so the page code
and the harness match); <arm> "rust" (deflate_part at level 2, the app's default), "rust6" (deflate_part at level 6
through the harness route `tiffDeflateLevel`, the level CompressionStream runs) or "native" (the harness route
`tiffDeflate: "js"` of native_deflate.patch: the same wasm gather and tiff_predict_rgba, then the browser's
CompressionStream("deflate") per strip in the workers); <variant> "own" (the photo) or "noise".

It runs tiff_test.py's 15k MEASURE (load, export as TIFF, open the TIFF in a new tab, one row per band and the
whole-picture SHA-256 compared against the source tab) with the route set in the window before the export and removed
after it, then reads the written file here: its exact size, its strip count, and the SHA-256 of every strip
zlib-decompressed by Python and joined (the predicted bytes before the deflate: equal on both arms when both encoders
wrote the same picture) and each strip's zlib header and Adler-32 checked by zlib itself.
"""
import asyncio
import hashlib
import importlib.util
import json
import os
import sys
import zlib

tree, arm, variant, out_dir, photo, result = sys.argv[1:7]
if arm not in ("rust", "rust6", "native"):
    raise SystemExit("arm must be rust, rust6 or native")

spec = importlib.util.spec_from_file_location("tiff_test", os.path.join(tree, "tools", "tiff_test.py"))
mod = importlib.util.module_from_spec(spec)
SIZE = os.environ.get("K19_SIZE", "15000x10000")
sys.argv = ["tiff_test.py", "--size", SIZE, "--variant", variant, "--image", photo, "--out", out_dir]
sys.path.insert(0, os.path.join(tree, "tools"))
spec.loader.exec_module(mod)

ANCHOR = "const E = ed.constructor;\n"
assert mod.MEASURE.count(ANCHOR) == 1, "MEASURE changed: the route anchor is not there once"
ROUTE = json.dumps("js" if arm == "native" else "rust")
# the route set before the export (the pool copies the window's overrides into every job message) and dropped right
# after it, so the open of the TIFF that follows runs with no override on both arms
# (the native arm's tiff_part timings carry nativeDeflate: 1, so exportJobs.tiff_part.nativeDeflate counts its strips)
SET = "E.setRoute(\"tiffDeflate\", " + ROUTE + ");\n"
UNSET = "E.setRoute(\"tiffDeflate\", null);\n"
if arm == "rust6":   # (only this arm names tiffDeflateLevel: the first patch version had no such route)
    SET += "E.setRoute(\"tiffDeflateLevel\", 6);\n"
    UNSET += "E.setRoute(\"tiffDeflateLevel\", null);\n"
mod.MEASURE = mod.MEASURE.replace(ANCHOR, ANCHOR + SET, 1)
EXPORT_LINE = "const exportMs = performance.now() - t1;\n"
assert mod.MEASURE.count(EXPORT_LINE) == 1, "MEASURE changed: the export line is not there once"
mod.MEASURE = mod.MEASURE.replace(EXPORT_LINE, EXPORT_LINE + UNSET, 1)

lines = []
orig_print = print


def capture(*a, **k):
    s = " ".join(str(x) for x in a)
    lines.append(s)
    orig_print(*a, **k)


mod.print = capture
sys.stdout.reconfigure(encoding="utf-8")
ok = asyncio.run(mod.session(mod.run_all))   # run_all imports the page modules, then measure() (SIZE is set)

row = None
for s in lines:
    for tag in ("[ok] variant %s: " % variant, "[FAIL] variant %s: " % variant):
        if s.startswith(tag):
            try:
                row = json.loads(s[len(tag):])
            except ValueError:
                row = {"raw": s[len(tag):][:2000]}
            row["ok"] = tag.startswith("[ok]")

tif = os.path.join(out_dir, "noise_%s.tif" % SIZE if variant == "noise" else "%s_own.tif" % os.path.splitext(os.path.basename(photo))[0])
check = {"tif": os.path.basename(tif)}
try:
    import tifffile
    with tifffile.TiffFile(tif) as tf:
        page = tf.pages[0]
        offs, counts = page.dataoffsets, page.databytecounts
        check.update(compression=int(page.compression), predictor=int(page.predictor), strips=len(offs),
                     shape=list(page.shape))
    h = hashlib.sha256()
    raw = 0
    with open(tif, "rb") as f:
        for o, n in zip(offs, counts):
            f.seek(o)
            z = f.read(n)
            d = zlib.decompress(z)   # checks the zlib header and the Adler-32 of each strip
            raw += len(d)
            h.update(d)
    check.update(fileBytes=os.path.getsize(tif), stripBytes=int(sum(counts)), decodedBytes=raw, decodedSha256=h.hexdigest())
    # the zlib header of the first and last strip (78 9C from deflate_part's frame, 78 9C or another level byte native)
    with open(tif, "rb") as f:
        heads = set()
        for o in (offs[0], offs[-1]):
            f.seek(o)
            heads.add(f.read(2).hex())
    check["zlibHeaders"] = sorted(heads)
except Exception as err:  # noqa: BLE001
    check["error"] = str(err)[:600]
    ok = False

rec = {"arm": arm, "variant": variant, "ok": bool(ok) and bool(row and row.get("ok")) and "error" not in check, "row": row, "file": check}
with open(result, "w", encoding="utf-8", newline=chr(10)) as f:
    json.dump(rec, f, indent=1)
orig_print("K19 %s %s: ok=%s fileBytes=%s decodedSha256=%s" % (arm, variant, rec["ok"], check.get("fileBytes"), (check.get("decodedSha256") or "")[:16]))
sys.exit(0 if rec["ok"] else 1)
