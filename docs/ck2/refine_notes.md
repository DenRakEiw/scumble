# The key matte's refine: notes for the integration (CorridorKey 2.0, item 49, session I6)

Branch `ck-refine` (from `corridorkey` at `6e9c0cf`), 2026-11-06, two rounds: the first built the module and chose the
method; the second, after a review, added **the guards** (the same-picture requirement and its check, the zone, the
noise guard) and re-measured. What is built, the measurements that chose it, the timing, the call the integration
(keyworker.js, host.js, the `key` gate) has to make, and the texts for the shared files (MANUAL, CHANGELOG, TESTING,
CLAUDE.md), which this branch does not touch. Every number is from synthetic scenes; the real engine's matte is not in
it (Stop A runs in parallel), see "Unverified".

## What was built

- `renderer/editor/keymatte.js`: pure, app-only (imported by no shipped file; no FILES change, no node build). It
  imports `boxBlurs` from `px/kernels.js` (Rust once loaded in a window or worker, the JS twin under Node) and
  `guidedFilter` from `inpaint_depth.js`; neither file changed.
- `tools/keymatte_test.js`: the tests (`node tools/keymatte_test.js`, 93 checks, about 5 s), `--measure` (the edge
  measurement, about 2 min), `--time` (the module alone at 4k, 8k, 15k).
- `docs/measurements/ck_i6_2026-11-06/`: round 1 `edges.txt`, `timing.txt`; round 2 `edges_r2.txt`, `timing_r2.txt`,
  `readcost.txt` (the app's read per band, `readcost.py`); `summary.txt` for both. `edges_r2.txt` was run before the
  last change (the box sums skip what no box reaches), which leaves every byte as it was (the test "skipping the pixels
  no box reaches changes nothing", and the same float operations per pixel).

## The method the measurement chose (round 1; it is not the plan's first design)

PLAN §4.7 point 3 described: upsample the alpha bilinearly to full resolution, run the guided filter of
`inpaint_depth.js` at full resolution with r from the upscale factor, in bands with a halo of at least 2r, trimmed. That
is built (`method: "full"`) and measured, and it is **barely better than no refine**: mean MAE 21.6-22.9 levels against
the bilinear matte's 25.4-26.7, the edge still 50-60 levels wrong 1.5 px away from it. It regresses a blurred matte on a
sharp guide, and a regression of a blurred quantity comes out shallow.

**The default (`method: "fast"`):** the guided filter's linear model fitted **at the bucket**, where the engine's matte
and the picture it was keyed from describe the same pixels, then applied at full resolution (the fast guided filter of
He and Sun, 2015): `q = A . I + B + (1 - C) p`, with A, B, C the window-averaged coefficients upsampled bilinearly, I the
full-resolution pixel's guide, p the bilinear matte. Three parts of it are Scumble's and each was measured:

1. **The three-channel guide** (the colour guided filter, `(Sigma + eps U)^-1 cov(I, p)` per window). A mixed pixel is
   `alpha F + (1 - alpha) B`, so alpha is an affine function of the colour exactly, for one subject colour and for two
   or three as long as they and the screen are affinely independent. The chroma distance the plan named measured 2-4x
   worse (mean MAE 3.0-4.4 against 0.5-1.4), worst on a shadow cast on the screen. Luminance fails as the plan expected
   (an edge between green and a skin tone of equal luminance leaks 91-121 levels with it).
2. **Confidence-weighted windows:** each window's fit counts by `c = var / (var + flat)`, and what a window does not
   claim passes the matte through, `(1 - C) p`: a flat picture leaves the matte exactly as the bilinear upsample has it.
3. **The engine's softness matched** (`soft: "auto"`): the fit runs against the bucket guide blurred by k passes of
   [1 2 1] and the coefficients apply to the sharp full-resolution guide; "auto" keeps the k whose fit predicts the matte
   best over its transition. It picked the engine's own k in all 32 cases, in both rounds.

**The guide on the sRGB bytes** (`linear: false`): the bucket picture is a byte average of the full-resolution one (the
tile levels average bytes), so only in sRGB is the bucket guide the area average that the transfer between the scales
assumes; sRGB measured better on the mean of all five conditions. **The parameters:** r = 4 bucket pixels, eps = 3e-6,
flat = 2e-5; they do not follow the upscale factor (`refineParams(scale)` returns r in bucket pixels; "full" keeps
r = round(1.5 x factor) full-resolution pixels).

## The guards (round 2, from the review)

The fit is a map from **the bucket's colours** to the matte, and its gains are fitted where averaging has removed the
sensor noise. Applied blindly at full resolution it breaks in two ways the review found and measured: a full-resolution
read that is not the bucket's picture (a filter layer composited into one read only), and full-resolution noise
multiplied by a large gain (a subject 12-24 levels from the screen's colour, green spill). Three guards, all in
keymatte.js:

1. **The same picture, and a check of it.** The full-resolution read **must be the picture the bucket was read from**:
   the same source, the same filter flags, the same background under transparent pixels; only the scale differs (the
   integration's step 4 below says which call). The module checks it on its noise sample: each bucket pixel the strip
   covers whole is compared with the mean of its full-resolution pixels, and the largest per-channel median difference
   is `guideDiff`; above `guideTol` (3 levels) the whole matte **falls back to the bilinear upsample** and the answer
   says so (`fallback`, a sentence). The faithful read measured 0 levels (0.81 with zero-mean grain of +-8 on the read
   only, which is noise, not a different picture); saturation 50 %, gamma 0.8, green x0.85 and +15 levels measured
   15-31 and fell back. The fallback is a net under a caller's bug, never a mode: it is the unrefined matte, so it is
   never worse than no refine (unguarded, saturation 50 % gave MAE 50-58 on the skin and stripe scenes against the
   bilinear 27-29), but a mildly
   different read that the refine would have survived (gamma 0.8: unguarded MAE 7-17) falls back too.
2. **The zone.** The correction `q - p` acts only where the engine's matte is in transition (`min(p, 1 - p)` above
   0.06, smoothly from 0.02), dilated by `gate` = 1 bucket pixel and counted from half the upsampled weight up; where the
   engine is sure over the whole neighbourhood the answer **is the bilinear matte**, whatever the full-resolution pixels
   hold. More than 3 bucket pixels from the edge the refine now adds 0 levels in every noisy and near-screen scene (the
   first round's default: up to 141).
3. **The noise.** One estimate per matte from a strip across the middle of the matte's box (`sampleRows`: at least 48
   rows and four bucket pixels): the median within-bucket-pixel variance per guide plane (the sensor noise where most
   of the strip is screen or plain subject; texture the fit cannot see where it is not). The noise a pixel's correction
   carries is `|A sigma|`; where it exceeds `tau` = 0.04 (about 10 levels) the correction is box-smoothed over
   `rho = (|A sigma| / tau - 1) / 2` full-resolution pixels, at most `rhoMax` = min(8, floor(factor / 2)), and shrunk by
   `1 / x^2` when even that is not enough. The box sums are integers (the correction in 1/65536), so a band sums exactly
   what the whole box would: **banded equals unbanded byte for byte**. A band therefore reads a halo of rhoMax rows (2 at
   a 4k box, 7 at 15k). Noise-free (sigma 0) nothing is smoothed.

The estimate: +-3 levels of sensor noise (sigma 1.78) came out 1.78-1.93, +-6 (3.5) 3.5-3.8, a clean picture 0.

### The measurement of the guards (`edges_r2.txt`, the last three sections)

MAE / leak (the largest error beyond 1.5 px from the true edge) / far (the largest change from the unrefined matte more
than 3 bucket px from the edge), levels of 255; the near-screen subjects on the screen [60, 170, 70]:

| s = 15, +-6 levels of noise | near [60,158,82] | near [60,164,76] | near [50,150,80] | skin | teal | fold | hair (MAE) |
|---|---|---|---|---|---|---|---|
| bilinear (no refine) | 28.8/120/0 | 28.8/120/0 | 28.8/120/0 | 28.8/120/0 | 28.8/120/0 | 28.8/120/0 | 22.8 |
| round 1's default (unguarded) | 19.1/127/84 | 33.8/224/141 | 13.8/103/68 | 2.7/15/11 | 3.5/27/19 | 3.4/23/16 | 4.3 |
| **the defaults** | **7.1/71/0** | **12.3/107/0** | **5.5/45/0** | **2.1/15/0** | **2.7/27/0** | **2.6/23/0** | **4.1** |

| s = 4, +-6 levels of noise | near [60,158,82] | near [60,164,76] | near [50,150,80] | skin | teal | fold | hair (MAE) |
|---|---|---|---|---|---|---|---|
| bilinear | 26.7/91/0 | 26.7/91/0 | 26.7/91/0 | 26.7/91/0 | 26.7/91/0 | 26.7/91/0 | 45.1 |
| round 1's default | 20.3/122/81 | 35.6/220/136 | 14.5/90/59 | 3.3/17/13 | 3.6/22/15 | 3.9/23/14 | 6.0 |
| **the defaults** | **12.6/62/0** | **22.3/87/0** | **9.3/36/0** | **2.7/17/0** | **2.8/22/0** | **3.1/23/0** | **5.7** |

The hardest case (8.5 levels between subject and screen, +-6 levels of noise, a 4k box: one level of colour for every
level of noise is all the pixel tells) stays SNR-limited: it is better than no refine (22.3 against 26.7, leak 87
against 91) and no longer worse, but far from the clean 7.2. **The parameters** (`edges_r2.txt` "the guards'
parameters", mean MAE / worst leak / worst far over clean, noisy and near-screen sets): `gate` 0 costs the clean edges
(MAE 5.1-5.6 against 0.8-1.4: the transition needs its neighbourhood), `gate` 2 lets 14-50 levels through more than 3
bucket px out, `tau` 0.04 had the lowest near-screen MAE at 15k (7.74) and at 4k the 0.06 one was lower (10.8 against
12.2) with a higher leak and a far of 0 either way: 0.04 kept. **What the guards cost on noise-free edges:** the
defaults' mean MAE 1.41 / 0.81 at s = 4 / 15 against round 1's 1.4 / 0.7 (hair at 15k 2.0 -> 2.5), worst leak 8 / 4,
crossing 0.36 / 0.37 px, all unchanged otherwise.

### Round 1's table, for the method choice (`edges.txt`; the guards changed only the defaults' row, above)

| s = 4 / s = 15 | mean MAE | worst leak | worst crossing | hair MAE |
|---|---|---|---|---|
| bilinear (no refine) | 26.7 / 25.4 | 91 / 120 | 0.15 / 0.59 | 45.1 / 22.8 |
| full, chroma, K 1.5 (the plan's first design) | 22.9 / 21.6 | 63 / 76 | 0.37 / 0.40 | 43.9 / 21.3 |
| fast, chroma, r 1, eps 1e-6 (its best) | 3.1 / 3.0 | 29 / 28 | 0.35 / 0.36 | 4.8 / 5.8 |
| fast, rgb, r 4, eps 1e-6 | 1.2 / 0.6 | 6 / 3 | 0.35 / 0.36 | 3.3 / 1.9 |
| round 1's defaults (fast, rgb, sRGB, r 4, eps 3e-6, soft auto) | 1.4 / 0.7 | 8 / 4 | 0.36 / 0.37 | 3.7 / 2.0 |

## Timing

**The module alone** (`node tools/keymatte_test.js --time`, `timing_r2.txt`; Node 24.18, Ryzen 9 7900X3D, one thread,
the lock free; a 1,024 x 683 bucket; the picture rows a view with +-3 levels of noise so the smoothing runs as on a
photo):

| Box | bilinear | **fast rgb (default)**, noise +-3, JS / px.wasm boxes | fast rgb, clean picture, px.wasm | full chroma (plan's first design), px.wasm |
|---|---|---|---|---|
| 4,096 x 2,731 (11.2 MP, 1 band) | 52 | **807 / 719** (fit 527 / 412) | 618 | 707 |
| 8,192 x 5,461 (44.7 MP, 11 bands) | 246 | **1,873 / 1,506** (fit 671 / 572) | 997 | 2,434 |
| 15,000 x 10,000 (150 MP, 36 bands) | 588 | **3,536 / 3,464** (fit 563 / 464) | 2,460 | 10,580 |

ms of the module in all. The machine ran slower than in round 1 (the full method, whose code did not change, took
10.6 s at 15k against 7.8 s), so compare within the table: the clean fast run is 0.23 of the full method as in round 1
(0.24). **At 15k: the bucket fit 0.46 s once, then 83 ms per band of about 4.2 MP on a noisy picture (55 ms clean)**,
the smoothing's two passes over the band and its integer box table (35 MB, kept between bands) being the difference;
the pixels outside the zone cost the bilinear lerp only. A band belongs in the worker (the plan's option b), as planned.

**The app's read per band** (`readcost.txt`, `readcost.py`; a dev instance on tiles, a 15,000 x 10,000 document with a
paint layer and a grey fill filter layer at 50 %, a band of 279 rows plus 7 halo rows above and below, 4.4 MP):

| Read (each band once, as a refine reads them) | sample (60 rows) | median band | slowest band | 36 bands + sample |
|---|---|---|---|---|
| `sampleRegionSettled("image", box, 1, { forRun, skipFilters: true })` + `getImageData` (the bucket's picture) | 87-89 | 78-80 | 158 | 2,350-2,373 |
| `readBoxBytes(box, { forRun, held })` (the first notes' call; filters composited) | 50-61 | 50-71 | 85-2,502 | 1,859-4,907 |

ms, two runs. **Indicative only:** both overlapped another workflow's timed run (its lock appeared seconds after the
instance started); the key gate's refine step records the clean figures. The two reads differ by up to 48 levels there
(the grey fill is in the composite only). The right read costs about 80 ms per 4.4 MP band, about 2.4 s for a whole 15k
box, more than the worker's apply (83 ms per band): the window should post the next band's read while the worker
applies the last.

## The interface (exact)

```js
import { REFINE, prepareRefine, noteSample, sampleRows, refineBand, bandPlan, refineMatte, refineParams,
         upsampleRows, geometry, toFloatAlpha, screenColor } from "./keymatte.js";

// once per matte (in the worker: its first message)
const st = prepareRefine({
    alpha,              // the engine's alpha at the bucket: Float32Array 0..1, Uint16Array 0..65535 or Uint8Array
    aw, ah,             // the bucket's size
    small,              // { data: RGBA bytes, width: aw, height: ah }: the very picture sent to keyPrepare
    src,                // optional { x, y, w, h } in bucket pixels: the part of the bucket that covers the key box
                        //   (default all of it; leave the reflect-101 padding out)
    full,               // { w, h }: the key box at full resolution (picture pixels)
    out,                // optional { x, y, w, h } inside the key box: the matte's box, the layer (default the key box)
    // optional: method "fast" | "full" | "bilinear", guide "rgb" | "chroma" | "dist" | "luma", linear, screen [r,g,b],
    // r, eps, flat, soft (number | "auto"), softs, fullK, gate (number | false), tau, rhoMax, guideTol,
    // noise (levels per RGB channel: skips the sample and its check), box (a boxBlurs-shaped function)
});
// st.halo (the fast method: rhoMax rows; "full": 2r), st.sample = [y0, y1) (rows of the matte's box), st.soft,
// st.residual, st.fitMs

// the noise sample, once, before the first band ("fast" only; refineBand refuses a band before it)
noteSample(st, rgbaOfSampleRows);          // straight RGBA of rows st.sample of the matte's box, out.w wide
// -> st.noise (levels per channel), st.guideDiff (levels, or null when the strip covered too few bucket pixels),
//    st.fallback (null, or the reason: then every band answers the bilinear rows and needs no picture)

// per band
const bands = bandPlan(out.w, out.h, { halo: st.halo });            // [{ y0, y1, ry0, ry1 }] in out's own rows
const bytes = refineBand(st, band, rgba);  // rgba: straight RGBA of rows [ry0, ry1) of the matte's box, out.w wide
                                           // (null when st.fallback) -> Uint8Array of exactly (y1 - y0) * out.w

// or all in one thread (tests, a small box in the window): the sample read first, then the bands
const res = await refineMatte({ ...sameOptions, read: (box) => /* [x0, y0, x1, y1] in out's coordinates */ rgbaOrPromise,
                                onBand: (y0, y1, bytes) => { /* write the mask rows */ }, cancelled: () => false });
// res: { alpha (whole w*h when no onBand), w, h, bands, method, guide, r, eps, halo, soft, scale,
//        sample, noise, guideDiff, fallback, ms: { all, fit, read } }
```

`read`'s box is in the matte box's own coordinates (whole rows: x0 = 0, x1 = w); the caller adds the layer's picture
position. A `{ data }` answer (a view on a SharedArrayBuffer included) is taken as well as a typed array. Refusals
(thrown): an empty bucket or box, the matte's box outside the key box, the alpha or the bucket picture at another size,
"full" with the three-channel guide, "chroma" / "dist" with no screen colour and no bucket picture to find it in, no
`read` callback, a fast band before `noteSample`, a sample or band picture shorter than its rows. The default needs **no
screen colour**.

## What the integration has to do

**Merge order:** `ck-refine` touches only its own files (keymatte.js, keymatte_test.js, this file,
`docs/measurements/ck_i6_2026-11-06/`), so it merges into `corridorkey` in any order against `ck-i2`; **before `ck-ui`**
or with it, since ck-ui's keyworker.js imports keymatte.js. No conflicts are expected.

1. **Keep the bucket picture.** The fit needs `small`, the exact RGBA sent to `helpers:keyPrepare` (2.8 MB at
   1,024 x 683). Keep it in the session-only `key` record beside `hash`, so a Re-key whose features the engine still
   holds can refine; after a restart the Re-key's own `keyPrepare` read gives it again.
2. **The geometry:** `full` = the key box at full resolution (§4.7 point 1); `src` = where it lies in the bucket (the
   bucket minus the reflect-101 padding); `out` = the matte's box from §4.5 step 1, relative to the key box.
3. **`keyworker.js`** (a module worker owned by host.js, started like `stitch_worker.js`; importing keymatte.js loads
   px.wasm there): `refine:prepare` { alpha, aw, ah, small, src, full, out } -> `prepareRefine` -> answer { halo,
   sample, soft, residual, fitMs }; `refine:sample` { rgba } -> `noteSample` -> answer { noise, guideDiff, fallback };
   `refine:band` { band, rgba } -> `refineBand` -> the u8 rows (transfer the buffer); `refine:free` drops the state. One
   prepare and one sample per key, then the bands in order.
4. **The window's reads: the same picture as the bucket, at scale 1.** Whatever call built `small` decides the read:
   - *Visible picture* (the bucket from `pictureInputBox`, filters skipped): on tiles
     `editor.sampleRegionSettled("image", [X0, Y0 + ry0, X0 + out.w, Y0 + ry1], 1, { forRun: true, skipFilters: true })`
     then `getImageData` (as `inpaint_canvas.js:7383` reads its rows), with (X0, Y0) the layer's picture position; on
     the canvas backend `flattenToCanvas({ forRun: true, skipFilters: true })` once, cropped per band. **Not
     `readBoxBytes` / `holdRunStack`** (they composite filter layers: `stackPlan({ forRun, filters: true })`) and **not
     `readBox`** (no `skipFilters`): the first notes said so, and a filter layer over the box (a grade, curves, film,
     relight, the base key's grey fill) then made the refine worse than none; now it falls back instead (guard 1).
   - *Re-key*: the same call with `upTo` (the grey layer's or the key layer's index, whichever is lower), as I4 gives
     `pictureInputBox` its `upTo`.
   - *Active layer*: the layer's own level-0 pixels with its mask applied and the same background under them as the
     bucket had (`objectInput` draws a layer over #808080; whatever I4's bucket does, the band read does too).
   - First the sample's rows (`st.sample`), posted as `refine:sample`; if the answer has `fallback`, log it (it is a bug
     in the reads) and post the bands with no picture; else per band of `bandPlan(out.w, out.h, { halo: st.halo })` read
     rows [ry0, ry1) and post them. Write each answer with `combine(bytesSource(bytes, 0, band.y0, out.w,
     band.y1 - band.y0), "add", MASK_RGB)` (never "replace" per band).
5. **Cancel** between bands (the token): stop posting, `refine:free`; nothing is landed.
6. **The foreground** is not the refine's: it stays bilinear in band canvases (§4.5 step 2).
7. **Until I6 is wired**, `method: "bilinear"` is the same call and answers the bilinear rows (no `small`, no `read`).
8. **The status sentence** may say "refined" once the integration's own 15k measurement is in `ck_i6_<date>/`; with a
   `fallback` the key's status says "not refined: <reason>" (plain, it is not the user's error) and the log has the line.
9. **The `key` gate's refine step** (Normal, both backends): with the engine stubbed (`host.keyEngine`, a fixture), a
   15k document, a 4k box and the whole picture: the layer's mask equals `refineMatte`'s answer for the same inputs run
   in Node from the fixture (bytes exactly, both backends); **a second document with a filter layer over the box (a
   curves or the grey fill at 50 %): the answer has no `fallback`, `guideDiff` at most 1 level, and the mask equals the
   one without the filter layer** (the reads skip it as the bucket did); the reads cover every row once plus the sample;
   a cancel mid-bands lands nothing; the seconds per band, `guideDiff` and the estimated noise go into
   `docs/measurements/ck_i6_<date>/`. `pxjobs` untouched.

## The review's findings (round 2)

- **must, the full-resolution read not the bucket's picture: fixed.** The notes' step 4 named `readBoxBytes` with
  `holdRunStack` and `readBox`, which composite filter layers that the bucket skips. Step 4 now names the same call as
  the bucket at scale 1 for each source, the module's header and `refineMatte`'s doc state the requirement, the module
  checks it on the noise sample and falls back to the bilinear matte (tested with saturation, gamma, a channel gain and
  an offset, and against zero-mean grain, which must not fall back), the key gate's step has a filter layer over the
  box, and the read per band was measured in the app (`readcost.txt`; indicative, the machine was busy with another
  workflow's timed runs).
- **should, full-resolution noise through the bucket's gains: fixed** by the zone and the noise guard; the near-screen
  subjects (the review's [60,158,82] and [60,164,76], one more) at +-3 and +-6 levels are in `--measure` and in the
  tests (nothing added more than 3 bucket px from the edge, better than unrefined in MAE and leak); the default was
  re-chosen over gate 0 / 1 / 2 and tau 0.02-0.06 (gate 1, tau 0.04). Not taken from the review's suggestions: raising
  eps (the review measured it: it costs the clean edges and does not remove the holes) and a per-band noise estimate
  (it would make bands differ at their seams; one estimate per matte from a fixed strip keeps banded equal to unbanded).
- **nice, the halo trim untested: taken.** Test 4 compares the full method's streamed bands with the unbanded bytes
  (the review's mutation `skip = 0` is red now); 4b does the same for the fast method, whose smoothing now has a halo,
  with the reads checked, a no-halo run that must show seams, and a flip test that the box is centred.
- **The mutation round** (a copy of the tree, `scratchpad/ckfix/mutate.sh`): red for the full trim, the fast halo, the
  zone, the smoothing, the shrink, the fallback, the median noise estimate and both box clamps. Three survive, by
  design: the box sums in floats instead of fixed point (it differs only in the last bits; the fixed point makes the
  exactness a construction, not luck) and two cuts of the reach the box sums are computed over (to the gate's own
  support or to the zone: the skipped corrections are within rounding of 0 there; the default reach of 2 bucket
  pixels makes the skip exact by construction, which the test "skipping the pixels no box reaches changes nothing" holds).

## Unverified, and what would change it

- **Synthetic only.** No CK2 matte was refined: the engine's real softness, its noise, its behaviour on hair and motion
  blur are I0a's reference keys' and Stop B's to show. When I0a's references are in `dist/ck_ref/`, run the defaults on
  them against the native key of the same still.
- **The app's bucket against the band read:** the check assumes the bucket pixel is about the mean of its
  full-resolution pixels where the picture is smooth (tile levels averaged, then the resample to the bucket). The key
  gate's step records `guideDiff` on real reads; if it is above about 1 level, `guideTol` and this assumption need a look.
- **Camera noise varies with brightness** (more in the shadows) and JPEG concentrates it at edges; one estimate per
  matte from the middle strip is a first cut. A subject whose texture fills most of the strip raises the estimate, which
  only smooths more (a softer, never a noisier refine).
- **Sub-bucket texture** crossing the edge (stripes finer than a bucket pixel) and **a subject whose colour equals the
  screen's** stay as in round 1: the bucket cannot see the one, no guide sees the other (the confidence keeps the
  engine's matte there).

## Texts for the shared files (the integration places them)

- **docs/TESTING.md** (the tools table): "`node tools/keymatte_test.js`: the key matte's refine (keymatte.js) under
  plain Node: an equal-luminance edge snapped to within 1 px, a flat picture left alone, banded equal to unbanded (both
  methods' halos read and trimmed), sensor noise and subjects near the screen's colour (nothing added where the engine
  was sure), a read that is not the bucket's picture falling back, the noise estimate, the geometry, the refusals;
  `--measure` the edge measurement, `--time` the module at 4k, 8k, 15k. Light (a pure module)."
- **docs/MANUAL.md** (the key chapter, the resolution paragraph): "The matte is keyed at the working size and brought up
  to your picture's full resolution against the picture itself: where the picture shows an edge (the subject against
  the screen, in colour, not only in brightness) the matte follows it to the pixel; where the picture shows none, or
  where CorridorKey 2.0 was sure, the matte stays as it made it. On a noisy photo, or a subject close to the screen's
  colour, the edge is followed less closely rather than made grainy."
- **CHANGELOG.md**: nothing of its own; the key's line (I4 / I5) says "refined against the full-resolution picture" once
  the integration's 15k measurement is recorded.
- **CLAUDE.md** (item 49's block, the hand-over): "I6 built on `ck-refine` (2026-11-06, two rounds):
  `renderer/editor/keymatte.js` pure and app-only, the fast guided fit with a three-channel guide on the sRGB bytes,
  confidence-weighted, the engine's softness matched by the fit's residual; guarded: the full-resolution read must be
  the bucket's picture (checked, else the bilinear matte), the correction only in the matte's transition zone, the noise
  estimated per matte and smoothed out with an exact integer box; the plan's full-resolution guided filter kept as a
  method and measured barely better than none; `docs/ck2/refine_notes.md`, `docs/measurements/ck_i6_2026-11-06/`. The
  wiring into keyworker.js and the key gate's refine step are the integration's."
