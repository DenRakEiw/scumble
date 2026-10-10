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

### Glass displacement (`effects.glass`)

Simulates patterned architectural glass, fluting, and distortion tiles computed purely in
the shader with no image assets (phase R3-S10 of `docs/PLAN_NIK9_BUILD.md`):

| Style | Description | Behaviour |
|---|---|---|
| `ribbed` | Sine wave ridges | Continuous smooth displacement along `angle`. $s = (P \cdot \text{dir}) / \text{size}$, $d = \sin(2\pi s) \cdot \text{dir}$. At $s = k/2$, $d = 0$. |
| `reeded` | Fluted lens per rib | Linear fluted lens profile along `angle` with discontinuous transitions between adjacent ribs. $d = (2 \cdot \text{fract}(s) - 1) \cdot \text{dir}$. |
| `wavy` | 2D orthogonal waves | Cross-corrugated surface displacement. $d = 0.7071 \cdot R(\text{angle}) \cdot (\sin(2\pi r_y / \text{size}), \sin(2\pi r_x / \text{size}))$. |
| `blocks` | Hash-based glass tiles | Flat square tile facets with pseudo-random displacement per tile cell. $d = 0.7071 \cdot (2 \cdot \text{hash2}(\text{cell}) - 1)$. |
| `frosted` | Fractal value noise | Continuous fine-grained glass roughness from three octaves of value noise. Clamped to $\|d\| \le 1.0$. |
| `pebbled` | Voronoi-like lens cells | Organic rounded pebble facets with jittered cell centers ($[0.15, 0.85]$ margin) and radial lens displacement $d = (P - F) / (0.7 \cdot \text{size})$ clamped to $\|d\| \le 1.0$. At jittered centers, $d = 0$ exactly. |

Parameters:

| Parameter | Type | Range / Options | Default | Description |
|---|---|---|---|---|
| `style` | select | `ribbed`, `reeded`, `wavy`, `blocks`, `frosted`, `pebbled` | `ribbed` | Glass surface pattern geometry. |
| `size` | number | 4 .. 400 px | 40 px | Rib, wave period, block, or pebble size in image pixels. |
| `amount` | number | 0 .. 100 px | 12 px | Maximum glass displacement reach in image pixels. |
| `frost` | number | 0 .. 20 px | 0 px | Radius of pre-displacement blur simulating internal glass scattering. |
| `angle` | number | -90 .. 90 deg | 0 deg | Glass rib or tile rotation angle. |
| `sheen` | number | 0 .. 100 % | 15 % | Specular surface highlight reflection intensity. |
| `seed` | number | 0 .. 99 | 0 | Variation seed for block, frosted, and pebbled patterns. |

Reach:
- When `amount > 0`: `Math.ceil(amount) + 2` pixels padding.
- When `frost > 0`: `Math.ceil(3 * frost) + 2` pixels padding.
- Total reach is the sum of displacement padding and frost blur padding.
- When `amount === 0` and `frost === 0`: `0`.

Skip:
- When `amount <= 0 && sheen <= 0 && frost <= 0`: skipped (returns source canvas unmodified).

Frost blur:
- When `frost * scale > 0.05`, the source image is pre-blurred via `blur(src, frost * scale)` before glass displacement is evaluated.
- Edge clamping uses mirrored padding (`edgePad = ceil(3 * sigma) + 2`) so blurred boundaries remain clean and artefact-free across image borders.
- When `amount === 0` and `sheen === 0`, only the frost blur is rendered, producing identical output on both CPU and GPU paths ($\pm 1$).

Specular sheen:
- Fixed directional light source $L = \text{normalize}(-1.0, -1.0, 0.75)$.
- Displaced surface normal $\vec{N} = \text{normalize}(-d_{\text{unit}}.x, -d_{\text{unit}}.y, 1.0)$.
- Specular term $k = \text{sstep}(0.55, 1.0, \vec{N} \cdot L) \cdot \text{sheen}$.
- Highlights blended via screen blending: $\text{screen}(c, k) = 1 - (1 - c)(1 - k)$.
- For undisplaced regions ($d = 0$), $\vec{N} = (0, 0, 1)$, giving $\vec{N} \cdot L \approx 0.4685 < 0.55$, ensuring 0 sheen artifacts on flat glass.

### Mathematical foundation and bilinear interpolation

Because WebGL texture samplers use `NEAREST` filtering for exact pixel pipelines, sub-pixel
displacement requires manual bilinear sampling:
- `bilin(vec2 p)` in `plugins/effects/common.js`: performs 4 `texelFetch` reads with edge clamping.
- Channels are interpolated in **premultiplied alpha** space (`vec4(c.rgb * c.a, c.a)`) and
  subsequently unpremultiplied (`rgb / a`) to eliminate dark fringes at transparent or
  semi-transparent boundaries.
- JavaScript twin `bilinAt(d, W, H, x, y)` implements identical premultiplied clamping and weighting.
- Coordinates evaluate at continuous pixel center `(ox + x + 0.5) / scale` to match GLSL `gl_FragCoord.xy + u_tile`.

## Actions and menu integration

The plugin adds actions under the *Plugins* menu:
- `effects.add_chromatic`: "Chromatic shift layer" - creates a new filter layer with type `effects.chromatic_shift`.
- `effects.add_glass`: "Glass layer" - creates a new filter layer with type `effects.glass`.

## Documents and compatibility

Documents containing Effects pack filter layers declare the `effects-filters` feature row:
- Minimum reader version: 4.
- Introduced in version: `0.1.45`.
- Verified in `tools/document_test.js` and `tools/effects_test.py`.

## Testing

1. `tools/effects_math_test.js`:
   - Fast Node.js unit test of dispersion offsets, glass fields, and bilinear interpolation.
   - Verifies plates and linear offsets sum to `(0, 0)`.
   - Verifies lateral offset is 0 at picture centre and equals `amount` at corners.
   - Verifies `bilinAt` whole-position identity, half-pixel mean, clamping, and premultiplied alpha.
   - Verifies $|d| \le 1.0$ across 100,000 samples for all 4 glass styles (`ribbed`, `reeded`, `wavy`, `blocks`).
   - Verifies ribbed displacement $d = 0$ at $s = k/2$.
   - Verifies block displacements are strictly constant within each cell.
   - Verifies differing seeds alter > 90% of block cells.
2. `tools/effects_test.py`:
   - In-app test gate (`effects`) over CDP on both `--tiles on` and `--tiles off`.
   - GPU vs CPU parity for all chromatic shift styles (`max <= 2`).
   - GPU vs CPU parity for all 4 glass styles (ribbed & wavy `max <= 4`, `over2 <= 0.1%`; reeded & blocks `over2 <= 0.1%`, `over4 <= 0.02%`). Measured max difference: 1 level.
   - Bitwise identity for `amount: 0` and `sheen: 0` on both paths.
   - Single-pixel column test: black image with 1 px white column at x = 100 under linear angle 0 amount 3 produces pure red at x = 97, pure green at x = 100, and pure blue at x = 103.
   - Ribbed displacement on an x-ramp unchanged $\pm 1$ where $\sin = 0$.
   - Scale 0.5 verification: offsets halve accurately against downscaled full-resolution output (`mean <= 2` for chromatic shift, `mean <= 3` for glass). Measured glass mean difference: 0.2127 levels.
   - Document round-trip: save, close, open preserving all chromatic shift and glass parameters intact.

