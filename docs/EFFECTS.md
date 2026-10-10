# Effects pack

The Effects pack is Scumble's second built-in plugin (`plugins/effects/`, enabled by default,
phase R3-S9 of `docs/PLAN_NIK9_BUILD.md`). It provides creative optical, distortion, and
lens effects on the plugin API of `docs/PLUGINS.md`.

Every filter in the Effects pack has an accelerated WebGL2 shader path and an identical CPU
twin (within 1 to 2 levels of rounding, verified by `tools/effects_test.py`). The CPU path
executes when WebGL2 is unavailable, when `info.cpu` is requested, and in headless tests.

## Filters

### Chromatic shift (`effects.chromatic_shift`)

Simulates dispersion and chromatic aberration by shifting colour channels independently:

| Style | Description | Behaviour |
|---|---|---|
| `plates` | Colour plates out of register | Red, green, and blue channels shift at angles 120 degrees apart around `angle`. Offsets sum to `(0, 0)`. |
| `lateral` | Lateral (transverse) aberration | Red shifts radially outward from picture centre, blue shifts radially inward, green stays centred. Offsets are 0 at centre and scale linearly to `amount` at the picture corners. |
| `linear` | Directional dispersion | Red shifts along `angle`, blue shifts in the opposite direction (`-angle`), green stays centred. Offsets sum to `(0, 0)`. |

Parameters:

| Parameter | Type | Range / Options | Default | Description |
|---|---|---|---|---|
| `style` | select | `plates`, `lateral`, `linear` | `plates` | Dispersion geometry pattern. |
| `amount` | number | 0 .. 60 px | 6 px | Maximum channel displacement in image pixels. |
| `angle` | number | -180 .. 180 deg | 30 deg | Dispersion orientation angle for plates and linear styles. |
| `strength` | number | 0 .. 100 % | 100 % | Blend factor between the original and shifted pixels. |

Reach:
- When `amount > 0` and `strength > 0`: `Math.ceil(amount) + 2` pixels padding.
- When `amount === 0` or `strength === 0`: `0` (the filter acts as an identity pass).

### Mathematical foundation and bilinear interpolation

Because WebGL texture samplers use `NEAREST` filtering for exact pixel pipelines, sub-pixel
displacement requires manual bilinear sampling:
- `bilin(vec2 p)` in `plugins/effects/common.js`: performs 4 `texelFetch` reads with edge clamping.
- Channels are interpolated in **premultiplied alpha** space (`vec4(c.rgb * c.a, c.a)`) and
  subsequently unpremultiplied (`rgb / a`) to eliminate dark fringes at transparent or
  semi-transparent boundaries.
- JavaScript twin `bilinAt(d, W, H, x, y)` implements identical premultiplied clamping and weighting.

## Actions and menu integration

The plugin adds actions under the *Plugins* menu:
- `effects.add_chromatic`: "Chromatic shift layer" - creates a new filter layer with type `effects.chromatic_shift`.

## Documents and compatibility

Documents containing Effects pack filter layers declare the `effects-filters` feature row:
- Minimum reader version: 4.
- Introduced in version: `0.1.45`.
- Verified in `tools/document_test.js` and `tools/effects_test.py`.

## Testing

1. `tools/effects_math_test.js`:
   - Fast Node.js unit test of dispersion offsets and bilinear interpolation.
   - Verifies plates and linear offsets sum to `(0, 0)`.
   - Verifies lateral offset is 0 at picture centre and equals `amount` at corners.
   - Verifies `bilinAt` whole-position identity, half-pixel mean, clamping, and premultiplied alpha.
2. `tools/effects_test.py`:
   - In-app test gate (`effects`) over CDP on both `--tiles on` and `--tiles off`.
   - GPU vs CPU parity for all three styles (`max <= 2`).
   - Bitwise identity for `amount: 0` and `strength: 0`.
   - Single-pixel column test: black image with 1 px white column at x = 100 under linear angle 0 amount 3 produces pure red at x = 97, pure green at x = 100, and pure blue at x = 103.
   - Scale 0.5 verification: offsets halve accurately against downscaled full-resolution output (`mean <= 2`).
   - Document round-trip: save, close, open preserving all parameters intact.
