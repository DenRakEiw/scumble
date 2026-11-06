# The key matte's refine: notes for the integration (CorridorKey 2.0, item 49, session I6)

Branch `ck-refine` (from `corridorkey` at `6e9c0cf`), 2026-11-06. What I6 built as a pure module, what the edge
measurement chose and why, the timing of the module alone, and the call the integration (keyworker.js, host.js, the
`key` gate) has to make. The texts for the shared files (MANUAL, CHANGELOG, TESTING, CLAUDE.md) are at the end, for
the integration to place; this branch does not touch them. Every number here is from synthetic scenes; the real
engine's matte is not in it (Stop A runs in parallel), see "Unverified".

## What was built

- `renderer/editor/keymatte.js`: pure, app-only (imported by no shipped file; no FILES change, no node build). It
  imports `boxBlurs` from `px/kernels.js` (Rust once loaded in a window or worker, the JS twin under Node) and
  `guidedFilter` from `inpaint_depth.js`; neither file changed.
- `tools/keymatte_test.js`: the tests (`node tools/keymatte_test.js`, 52 checks, under a second), `--measure` (the edge
  measurement below, about 3.5 min; output `docs/measurements/ck_i6_2026-11-06/edges.txt`), `--time` (the module alone at
  4k, 8k, 15k; output `docs/measurements/ck_i6_2026-11-06/timing.txt`).

## The method the measurement chose (it is not the plan's first design)

PLAN §4.7 point 3 described: upsample the alpha bilinearly to full resolution, run the guided filter of
`inpaint_depth.js` at full resolution with r from the upscale factor, in bands with a halo of at least 2r, trimmed. That
is built (`method: "full"`) and measured, and it is **barely better than no refine**: mean MAE 21.6-22.9 levels against
the bilinear matte's 25.4-26.7, the edge still 50-60 levels wrong 1.5 px away from it. The reason is structural: it
regresses a blurred matte on a sharp guide, and a regression of a blurred quantity comes out shallow (the soft ramp is
spread over the windows; a larger r only trades that for lost detail).

**What ships as the default (`method: "fast"`):** the guided filter's linear model fitted **at the bucket**, where the
engine's matte and the picture it was keyed from describe the same pixels, then applied at full resolution (the fast
guided filter of He and Sun, 2015): `q = A . I + B + (1 - C) p`, with A, B, C the window-averaged coefficients
upsampled bilinearly, I the full-resolution pixel's guide, p the bilinear matte. Three parts of it are Scumble's and
each was measured:

1. **The three-channel guide** (the colour guided filter, `(Sigma + eps U)^-1 cov(I, p)` per window). A mixed pixel is
   `alpha F + (1 - alpha) B`, so alpha is an affine function of the colour exactly, for one subject colour and for two
   or three (a striped shirt, a fold in the skin) as long as they and the screen are affinely independent. The chroma
   distance the plan named is exact only for one subject colour and needs the screen colour; it measured 2-4x worse
   (mean MAE 3.0-4.4 against 0.5-1.4), worst on a shadow cast on the screen (MAE 7-12 against 0.4-1.4) and a fold
   (3.4 against 1.2). Luminance fails as the plan expected: an edge between green and a skin tone of equal luminance
   leaks 91-121 levels with it, and on the fold and shade scenes it is worse than nothing (MAE 31-74 against the
   bilinear matte's 27-29).
2. **Confidence-weighted windows:** each window's fit counts by `c = var / (var + flat)` (`flat` 2e-5 on the [0, 1]
   guide, minus a floor of 5 % of it for the rounding of a flat window's means), and what a window does not claim
   passes the matte through: `(1 - C) p`. A flat picture therefore leaves the matte exactly as the bilinear upsample
   has it (0 levels, every method and guide; the test), where a plain guided filter would blur it by 2r.
3. **The engine's softness matched** (`soft: "auto"`): a model's matte is softer than the picture it was keyed from,
   and fitting a softer matte against the sharper bucket guide is the same shallow regression again (with no match on a
   one-pass engine: MAE 10-13 on the edges and 28 on hair, leaks 16-82). The model is linear, so `blur(alpha) = A blur(I) + B` with the same A and B: the fit
   runs against the bucket guide blurred by k passes of [1 2 1] and the coefficients then apply to the sharp
   full-resolution guide. "auto" fits k = 0..4 and keeps the k whose fit predicts the matte best over its transition
   (0.02 < p < 0.98) at the bucket. On engines of 0, 1, 2 and 3 passes it picked the engine's own k in all 32 cases
   (4 scenes, 2 factors, 4 engines; `edges.txt` "the engine's softness"). A pass more is better on some scenes
   (hair) and worse on others (the fold on a sharp engine: MAE 6.3 against 1.3); two more break the stripes finer than
   a bucket pixel (MAE 3-10, leaks 35-144). The residual's pick is kept.

**The guide on the sRGB bytes** (`linear: false`). A camera mixes in linear light, but the bucket picture is a byte
average of the full-resolution one (the tile levels average bytes), so only in sRGB is the bucket guide the area average
of the full-resolution guide that the fit's transfer between the scales assumes. sRGB measured better on the mean
of every one of the five conditions (1.51 against 2.09 at the defaults' r and eps, the best linear 1.97; the scenes are
mixed in linear light, sensor noise included). Per scene it is mixed: linear is better on some one-coloured sharp edges
(skin 0.5 against 1.1 levels at s = 4) and on the motion blur (0.5 against 0.8) and places the 0.5 crossing about
0.1 px closer; sRGB on the shaded screen, the stripes and the hair (shade 1.5 against 3.4, hair 3.7 against 5.7).

**The parameters:** r = 4 bucket pixels, eps = 3e-6 (1e-6 measured best by 0.07 levels; kept a step above it as a
margin for real pictures' structure, which the synthetic scenes do not have), flat = 2e-5 (5e-6 was 0.09 levels better,
1e-4 0.33 worse). r costs nothing at full resolution (the apply is pointwise) and almost nothing at the bucket (running
sums). **The radius and eps do not follow the upscale factor** in this method: the transition the windows must
straddle is about the same number of bucket pixels whatever the factor (`refineParams(scale)` returns r in bucket
pixels; the "full" method keeps r = round(1.5 x factor) full-resolution pixels, 22 at 15k / 1,024).

**Bands:** the apply is pointwise, so a band needs **no halo** and banded equals unbanded byte for byte (the test, 37-row
bands). The halo of at least 2r, read and trimmed exactly, is built for the "full" method (and tested: the read boxes,
the trim, and that without it the seams differ by 22 levels). Boxes up to 16 MP run as one band; above, bands of about
4 MP (279 rows at 15,000 wide).

### The measurement (`node tools/keymatte_test.js --measure`, `docs/measurements/ck_i6_2026-11-06/edges.txt`)

Synthetic scenes made as a camera and the engine would: the truth alpha at full resolution (4 x 4 supersampled), subject
and screen mixed in linear light and encoded to sRGB bytes; the bucket picture the byte average of s x s blocks; the
engine's matte the area average of the truth softened by one [1 2 1] pass (more in the softness part). Eight scenes,
40 x 40 bucket pixels each: `skin` (green against a skin tone of equal relative luminance, an edge at 7 degrees),
`blue` (the same on a blue screen), `teal` (a subject close to the screen's colour), `fold` (a dark fold half a bucket
pixel inside the edge), `shade` (a shadow cast on the screen beside the edge), `stripes` (navy and white stripes 1.5
bucket pixels apart crossing the edge), `blur` (a soft truth: a 3-bucket-pixel motion blur), `hair` (strands of 0.8-2.2
full-resolution pixels over the screen). At s = 4 (a 4k box keyed at 1,024) and s = 15 (a 15k box). Metrics in levels
of 255 over the edge region (2s from the crop's borders): MAE, p99, the **leak** (the largest error farther than 1.5 px
from the true edge: what is left of the transition outside +-1 px) and the **crossing** (the largest distance of a
row's 0.5 crossing from the true edge, px).

| s = 4 / s = 15 | mean MAE | worst leak | worst crossing | hair MAE |
|---|---|---|---|---|
| bilinear (no refine) | 26.7 / 25.4 | 91 / 120 | 0.15 / 0.59 | 45.1 / 22.8 |
| full, luma, K 1.5 | 31.9 / 29.9 | 107 / 128 | 0.68 / 1.72 | 44.0 / 21.4 |
| full, chroma, K 1.5 (the plan's first design) | 22.9 / 21.6 | 63 / 76 | 0.37 / 0.40 | 43.9 / 21.3 |
| fast, chroma, r 1, eps 1e-6 (its best) | 3.1 / 3.0 | 29 / 28 | 0.35 / 0.36 | 4.8 / 5.8 |
| fast, rgb, r 4, eps 1e-6 | 1.2 / 0.6 | 6 / 3 | 0.35 / 0.36 | 3.3 / 1.9 |
| **the defaults** (fast, rgb, sRGB, r 4, eps 3e-6, soft auto) | **1.4 / 0.7** | **8 / 4** | **0.36 / 0.37** | **3.7 / 2.0** |

(The defaults row is `edges.txt` "the defaults ... sRGB", noise 0.) With +-0.02 noise on the engine's matte the
defaults stay at MAE 1.2-1.4 on the edges (hair 2.5-3.5) and leak 5-8; with +-3 levels of sensor noise on the picture at s = 15 the rgb grid's mean
is 2.07-2.20.

## Timing of the module alone (`node tools/keymatte_test.js --time`, `docs/measurements/ck_i6_2026-11-06/timing.txt`)

Node 24.18 on the dev machine (Ryzen 9 7900X3D), one thread, the lock free; a 1,024 x 683 bucket; the picture rows a
view (the read is the caller's cost, not in these numbers); ms of the module in all, of it the bucket fit:

| Box | bilinear | **fast rgb (default)**, JS / px.wasm boxes | fast chroma, JS / px.wasm | full chroma (plan's first design), JS / px.wasm |
|---|---|---|---|---|
| 4,096 x 2,731 (11.2 MP, 1 band) | 49 | **592 / 483** (fit 456 / 339) | 355 / 293 | 596 / 486 |
| 8,192 x 5,461 (44.7 MP, 11 bands) | 195 | **1,162 / 863** (fit 620 / 393) | 663 / 575 | 2,657 / 2,081 |
| 15,000 x 10,000 (150 MP, 36 bands) | 544 | **2,076 / 1,860** (fit 473 / 369) | 1,750 / 1,588 | not run in JS / 7,837 |

The default costs the bucket fit once (0.34-0.62 s: five fits for the softness, 18 box means each, on 0.7 MP; the first
4k row carries the JIT's warm-up) and then about 10 ns a full-resolution pixel: **41 ms per band of about 4 MP at 15k,
1.86 s for a whole 15k box in all**, a quarter of the plan's full-resolution filter (7.8 s with Rust boxes) and far
more accurate. A band's 40-60 ms is a dropped frame or three on the window's thread, so the bands belong in the worker
(the plan's option b) as planned; a box of a few MP could run in the window. If the fit's 0.35 s matters (the live
loop does not refine; only Apply does), the softness choice can run on the transition's rows of the bucket alone, or
on the one-channel fit first: not done, not measured.

## The interface (exact)

```js
import { REFINE, prepareRefine, refineBand, bandPlan, refineMatte, refineParams, upsampleRows, geometry,
         toFloatAlpha, screenColor } from "./keymatte.js";

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
    // r, eps, flat, soft (number | "auto"), softs, fullK, box (a boxBlurs-shaped function)
});
// st.halo (0 for "fast"), st.soft (the engine softness auto chose), st.residual, st.fitMs

// per band
const bands = bandPlan(out.w, out.h, { halo: st.halo });            // [{ y0, y1, ry0, ry1 }] in out's own rows
const bytes = refineBand(st, band, rgba);  // rgba: straight RGBA of rows [ry0, ry1) of the matte's box, out.w wide
                                           // -> Uint8Array of exactly (y1 - y0) * out.w: the mask rows

// or all in one thread (tests, a small box in the window)
const res = await refineMatte({ ...sameOptions, read: (box) => /* [x0, y0, x1, y1] in out's coordinates */ rgbaOrPromise,
                                onBand: (y0, y1, bytes) => { /* write the mask rows */ }, cancelled: () => false });
// res: { alpha (whole w*h when no onBand), w, h, bands, method, guide, r, eps, halo, soft, scale, ms: { all, fit, read } }
```

`read`'s box is in the matte box's own coordinates (whole rows: x0 = 0, x1 = w); the caller adds the layer's picture
position. A `{ data }` answer (what `editor.readBoxBytes` gives, a view on a SharedArrayBuffer included) is taken as
well as a typed array. Refusals (thrown): an empty bucket or box, the matte's box outside the key box, the alpha or the
bucket picture at another size, "full" with the three-channel guide, "chroma" / "dist" with no screen colour and no
bucket picture to find it in, no `read` callback. The default needs **no screen colour** (only "chroma" and "dist" do;
`screenColor(small, alpha)` finds it from the bucket where the matte is below 0.02).

## What the integration has to do (I4's step 2, the app-only `keyworker.js`, the `key` gate)

1. **Keep the bucket picture.** The fit needs `small`, the exact RGBA sent to `helpers:keyPrepare` (2.8 MB at
   1,024 x 683, 16 MB at 2,048 square). Keep it in the session-only `key` record beside `hash`, so a Re-key whose
   features the engine still holds (nothing read) can refine; after a restart the Re-key's own `keyPrepare` read gives
   it again.
2. **The geometry:** `full` = the key box (the box planned by §4.7 point 1, at full resolution); `src` = where that box
   lies in the bucket (the bucket minus the reflect-101 padding that the picture's edge left short); `out` = the
   matte's box from §4.5 step 1 (the bucket alpha's bounding box, scaled, grown, clamped), relative to the key box.
3. **`keyworker.js`** (a module worker owned by host.js, started like `stitch_worker.js`; it imports keymatte.js, so
   `px/kernels.js` loads px.wasm there and the bucket fit's box blurs are Rust): message `refine:prepare` { alpha, aw,
   ah, small, src, full, out } -> `prepareRefine` -> answer { soft, residual, fitMs, halo }; message `refine:band`
   { band, rgba } -> `refineBand` -> answer the u8 rows (transfer the buffer); `refine:free` drops the state. One
   prepare per key; the bands in order.
4. **The window's loop:** hold the stack once for the whole key (`holdRunStack`), then per band of
   `bandPlan(out.w, out.h, { halo: st.halo })`: `editor.readBoxBytes([X0, Y0 + band.ry0, X0 + out.w, Y0 + band.ry1],
   { forRun: true, held })` with (X0, Y0) the layer's picture position, post the bytes, and write the answer with
   `combine(bytesSource(bytes, 0, band.y0, out.w, band.y1 - band.y0), "add", MASK_RGB)` (never "replace" per band).
   Re-key reads the picture **under the key layer**: the read goes through `readBox(box, { forRun: true, upTo })` (or the
   `upTo` that `pictureInputBox` gains in I4) instead of `readBoxBytes`, which has no `upTo`.
5. **Cancel** between bands (the token): stop posting, `refine:free`; nothing is landed.
6. **The foreground** is not the refine's: it stays bilinear in band canvases (§4.5 step 2).
7. **Until I6 is wired**, `method: "bilinear"` is the same call and answers the bilinear rows (no `small`, no `read`).
8. **The status sentence** may say "refined" once the integration's own 15k measurement is in `ck_i6_<date>/` (the
   key gate's refine step, below): this file's timing is the module alone.
9. **The `key` gate's refine step** (Normal, both backends): with the engine stubbed (`host.keyEngine`, a fixture),
   a 15k document, a 4k box and the whole picture: the layer's mask equals `refineMatte`'s answer for the same inputs run
   in Node from the fixture (bytes exactly, both backends), the band reads cover every row once, a cancel mid-bands
   lands nothing, and the seconds per band and in all go into `docs/measurements/ck_i6_<date>/`. `pxjobs` untouched.

## Unverified, and what would change it

- **Synthetic only.** No CK2 matte was refined: the engine's real softness, its noise, its behaviour on hair and on
  motion blur are I0a's reference keys' and Stop B's to show. `soft: "auto"` covers engines of 0-4 [1 2 1] passes; a
  softer engine shows as auto picking 4 every time (add counts to `REFINE.softs`). When I0a's references are in
  `dist/ck_ref/`, run the defaults on them against the native key of the same still (Stop B's hand check; a script
  beside `--measure` reading the float16 arrays is a short job).
- **Sub-bucket texture** (stripes finer than a bucket pixel crossing the edge) is the hardest case: the bucket cannot
  see it, so its coefficients are a guess there (MAE 1.4 at s = 4, 0.4 at s = 15; p99 47 levels at s = 4 for r 6, eps 1e-6).
- **A subject whose colour equals the screen's** has no edge in any guide: the confidence keeps the engine's matte
  there, as it should.
- **Linear light:** a motion-blurred or out-of-focus edge (many mixed pixels) is about 0.3 levels better with
  `linear: true`; the sharp edges are better in sRGB. Not switched per picture.
- **Timing in the app:** measured in Node with the JS twin and px.wasm loaded from the file; the worker's own numbers
  and the window's read (`readBoxBytes` per band) are the integration's.

## Texts for the shared files (the integration places them)

- **docs/TESTING.md** (the tools table): "`node tools/keymatte_test.js`: the key matte's refine (keymatte.js) under
  plain Node: an equal-luminance edge snapped to within 1 px, a flat picture left alone, banded equal to unbanded, the
  full method's halo read and trimmed, the geometry, the refusals; `--measure` the edge measurement, `--time` the
  module at 4k, 8k, 15k. Light (a pure module)."
- **docs/MANUAL.md** (the key chapter, the resolution paragraph): "The matte is keyed at the working size and brought up
  to your picture's full resolution against the picture itself: where the picture shows an edge (the subject against
  the screen, in colour, not only in brightness) the matte follows it to the pixel; where the picture shows none, the
  matte stays as CorridorKey 2.0 made it."
- **CHANGELOG.md**: nothing of its own; the key's line (I4 / I5) says "refined against the full-resolution picture" once
  the integration's 15k measurement is recorded.
- **CLAUDE.md** (item 49's block, the hand-over): "I6 built on `ck-refine` (2026-11-06): `renderer/editor/keymatte.js`
  pure and app-only, the fast guided fit with a three-channel guide on the sRGB bytes, confidence-weighted, the engine's
  softness matched by the fit's residual; the plan's full-resolution guided filter kept as a method and measured barely
  better than none; `docs/ck2/refine_notes.md`, `docs/measurements/ck_i6_2026-11-06/`. The wiring into keyworker.js and
  the key gate's refine step are the integration's."
