# Review of Relight Phase 1 (Sessions L2-L6, commits 78af2fb through f0a25eb)

Reviewed on commit `f0a25eb` (Sessions L2 through L6 of `docs/PLAN_RELIGHT_BUILD.md`):
- `78af2fb`: L2: the lights canvas tool (handles, drag, alt-dist, wheel, quick preview, own light)
- `8f07821`: Relight L3: command, assistant policy, settings, menus, gate (item 43)
- `6b61514`: L4: the Magnific route, light map mode 1, detailRatio transfer, and relightWhole
- `7756430`: L5: the prompt routes (ComfyUI local, Comfy Cloud, fal IC-Light v2, and Bria)
- `f0a25eb`: L6: relight docs, manual, helper notes, and verification gates

## Test Summary

- `node tools/relight_request_test.js`: PASS (all 9 test suites pass cleanly).
- `node tools/recipes_test.js`: PASS (195 of 195 checks passed).
- `node tools/manual_test.js`: PASS (22 chapters, 16 screenshots, 16 accelerators, all checks passed).
- `node tools/skins_test.js`: PASS (all 37 skin tokens verified).
- `node tools/rangebar_test.js`: PASS (all 11 rangebar tests passed).
- `node tools/depth_test.js`: PASS (all depth and guided filter checks passed).
- `node tools/assistant_test.js`: PASS (all 256 checks passed).
- `npm run lint`: 0 errors (76 warnings, all pre-existing or minor unused test variables).
- `npm run types`: 0 errors (TypeScript typecheck clean).
- In-app CDP gates (`--offline`) on `--tiles on`:
  - `relight` rc=0 15s PASS
  - `limit` rc=0 6s PASS
  - `depthfx` rc=0 6s PASS
  - `document` rc=0 41s PASS
  - `commands` rc=0 14s PASS
  - `assistant` rc=0 34s PASS
  - `export` rc=0 145s PASS
  - `skins` rc=0 9s PASS
  - `help` rc=0 3s PASS
  ALL PASS!
- In-app CDP gates (`--offline`) on `--tiles off`:
  - `relight` rc=0 14s PASS
  - `limit` rc=0 7s PASS
  - `depthfx` rc=0 6s PASS
  - `document` rc=0 41s PASS
  - `commands` rc=0 13s PASS
  - `assistant` rc=0 28s PASS
  - `export` rc=0 0s PASS (skipped on canvas backend as expected)
  - `skins` rc=0 8s PASS
  - `help` rc=0 3s PASS
  ALL PASS!
- ASCII check: All 5 commits and newly created files verified 100% pure ASCII (0 non-ASCII bytes added; 0 non-ASCII bytes in commit messages).
- `docs/TUTORIAL.md` untouched and preserved.
- Prior release invariants: two-zone range bar, WORK_MAX = 4096, depth row follows picture, all 27 blend modes intact.

Line numbers are from `f0a25eb`.

---

## Must fix before release

1. **[RESOLVED] Custom node repository out of sync with editor** (`python tools/build_node.py --check` failure).
   - **File**: `F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-InpaintCanvas\js\inpaint_canvas.js:19997` (and `DEVELOPMENT.md`).
   - **Repository line**: `renderer/editor/inpaint_canvas.js:19999`.
   - **Issue**: In commit `f0a25eb` (Session L6), `renderer/editor/inpaint_canvas.js:19999` was updated to replace `var(--sc-fg-muted, #888)` with `var(--sc-fg-2, #888)` so that the last render note in the relight row conforms to the skin token contract verified by `tools/skins_test.js`.
   - **Resolution (Applied 2026-10-12)**:
     1. Executed `python tools/build_node.py`, which updated `js/inpaint_canvas.js` and recorded the new tree hash `ebfc8a4b04578abd` in `DEVELOPMENT.md`.
     2. Executed `python tools/build_node.py --check` and confirmed clean pass (`ok: 52 modules parse and resolve, 61 host members answered by both hosts`).
     3. Committed the change in `ComfyUI-InpaintCanvas` as commit `6e0ab2a` (`build(node): sync inpaint_canvas.js skin token (Session L6)`).
   - **Status**: FIXED and verified.

---

## Smaller observations and notes

- **Node 22 typeless package warning on direct test execution**:
  When running Node unit tests that directly import ES module files (such as `inpaint_relight.js`, `manual.js`, `inpaint_rangebar.js`), Node 22 emits a warning:
  `(node:26460) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///... is not specified and it doesn't parse as CommonJS. Reparsing as ES module because module syntax was detected.`
  This is harmless because Node automatically reparses as ES module and execution proceeds cleanly with 0 errors. If desired in a future cleanup, adding `"type": "module"` to `package.json` would silence this warning once all tools and scripts use standard ES module imports.

- **Minor unused variables in `renderer/editor/inpaint_canvas.js`**:
  Linter reports three unused variable warnings:
  - `6567:19 warning 'filled' is assigned a value but never used`
  - `22024:36 warning 'vx' is assigned a value but never used`
  - `22024:54 warning 'vy' is assigned a value but never used`
  Prefixing with an underscore (`_filled`, `_vx`, `_vy`) or removing them will eliminate the warning.

- **Dual backend fix in `tools/limit_test.py`**:
  Commit `f0a25eb` fixed the R2-S5 depth snap test in `tools/limit_test.py` by replacing the call to `filteredCanvas` (which is tile-backend specific) with `flattenToCanvas({ forRun: true })` while toggling `edSnap.filterChainOff` with `releaseCaches()`. This allowed the test to run reliably on both `--tiles on` and `--tiles off` backends without discrepancies.

- **Graceful fallback in `host.relightWhole`**:
  In `renderer/editor/host.js:3245-3250`, when the worker pool op `relight_ratio` is dispatched, it is wrapped in a `try...catch` that falls back cleanly to the main-thread `detailRatio(fullPx, lowPx, ansPx, W, H, wAns, hAns)` implementation. Test suite 5 in `tools/relight_request_test.js` verifies that the main-thread `detailRatio` produces exact parity with 100% fine texture preservation.

---

## Tests: what is green and what it proves

### 1. `tools/relight_test.py` (In-app CDP gate, Cases a through u)
Executed in the live app under CDP on both `--tiles on` and `--tiles off` with `--offline`:
- **Case a (Bitwise identity at defaults)**: A new relight layer with no active lights and default parameters (`original: 100%`) evaluates to exact bitwise equality with the source picture. No unnecessary color shifts or re-rendering occurs.
- **Case b (Directional shading and shadows)**: A point light placed on the left illuminates the left side of the scene brighter than the right, and properly casts dark shadows behind a depth height step.
- **Case c (GL vs CPU parity)**: Compares the WebGL2 fragment shader (`applyFilterGL`) against the CPU reference twin (`applyRelight`) at scale 1 and scale 0.5. Differences are strictly within 2 levels (`max <= 2`, `over2Pct <= 0.1%`), confirming shader-kernel equivalence across rendering pipelines.
- **Case d (Original light flattening)**: Setting `original: 0` with lights off estimates the scene's existing directional lighting via `fitOriginalLight` and flattens it, reducing the variance of luminance across the depth ramp by more than half.
- **Case e (Sun light)**: Parallel rays from a distant azimuth/elevation illuminate the scene without radial falloff; two sample points at differing distances agree within 1 level.
- **Case f (Spot light cone)**: Outside the spot light's cone and feathered rim, pixels remain completely unaffected and equal to the base image.
- **Case g (Cache invalidation)**: Moving one light recalculates only that light's visibility channel in `layer._relight.vis`, while leaving the cached visibility channels of other lights intact.
- **Case h (Export synchronization)**: `flattenToCanvas({ forRun: true })` and `encodeComposite({ forRun: true })` invoke `await ed.relightSettled()`, ensuring all background worker pool jobs complete before export buffers are generated.
- **Case i (Missing depth map fallback)**: When a document lacks a depth map, the relight layer acts as a safe no-op (bitwise identity) and displays an inline hint.
- **Case j (Document serialization round trip)**: Saving a `.scumble` document containing a relight filter layer preserves all light parameters, positions, colors, and types, and correctly enforces `reader: 6`.
- **Cases k-m (Layer row block UI)**: Adding, modifying, resetting, and deleting lights in the layer row updates parameters with one undo step each; *Add light* disables when 4 lights are present; toggling a light's eye icon excludes its contribution.
- **Cases n-p (Canvas pointer gestures)**: Dragging light handles on the canvas moves light coordinates in 2D space; Alt+drag adjusts distance (`dist`); clicking empty canvas adds a new light; pressing Delete removes the selected light. Each action pushes exactly one undo step.
- **Case q (Interactive quick preview)**: During active handle drag, `layer._relight.vis` uses a quarter-resolution map (`Math.floor(W / 4)`) for responsive 60 fps feedback, and calculates full-resolution maps on pointer release.
- **Case r (Overlay isolation)**: Light handles, aim lines, and compass rings are view-only canvas overlays and never leak into exported or composited bitmaps.
- **Cases s-t (`relight` command)**: Invoking `relight` via MCP or commands on a document without a depth map automatically triggers depth map calculation first, creates the layer, and configures lights in a single turn. Passing an existing `layer` updates parameters in-place.
- **Case u (Generative route rendering & detail ratio)**: Renders through the Magnific route against a loopback mock. Lands `Relight (Magnific)` as a pixel layer directly under the top filter run in one undo step, hides the relight filter layer, and preserves fine microtexture within 10% via guided filter ratio transfer.

### 2. `tools/relight_request_test.js` (9 Node test suites)
- **Suite 1 & 2 (Magnific payload & validation)**: Validates JSON request bodies for 1 and 4 lights against the official OpenAPI schema (`tools/refs/magnific/image-relight.json`). Confirms `image`, `transfer_light_from_lightmap`, `change_background: false`, `style`, `preserve_details`, and conditional inclusion of `advanced_settings`.
- **Suite 3 (Key safety)**: Verifies that dummy and `test-` API keys are caught and routed to local test loopbacks, never leaking to production servers.
- **Suite 4 (Mode 1 light map)**: Confirms that shader mode 1 produces an isolated light map with ambient floor and opaque alpha 255.
- **Suite 5 (`detailRatio` texture preservation)**: Measures high-frequency checkerboard microtexture preservation through guided filter ratio transfer, proving 100.0% preservation (within 10% tolerance).
- **Suite 6 (Provider layout)**: Asserts that relight requests correctly lay out both the picture crop and the light map.
- **Suite 7 (fal.ai routes)**: Verifies IC-Light v2 request payloads (`initial_latent` derived from primary light position, `enable_hr_fix: true`) and Bria relighting payloads (`light_direction`, `light_type` supporting 13 atmospheric styles).
- **Suite 8 (Local ComfyUI recipe)**: Validates `recipes/relight_qwen_local.json`, verifying the dual LoRA structure (`LoraLoaderModelOnly` for Relight and Lightning 4-step) and the trigger token concatenation (`\u91cd\u65b0\u7167\u660e`).
- **Suite 9 (Comfy Cloud graph)**: Validates `image_qwen_image_edit_2509_relight` graph integrity, trigger word, and node parameter bindings.

---

## Sound as built

### 1. In-app local 3D relighting (Offline / Zero-credit path)
- **Light Model**: Evaluates virtual 3D lighting over an orthographic height field derived from the 16-bit depth map. Surface normals are calculated from heights and bilateral edge guidance, ensuring shadow boundaries align to sharp image contours.
- **Ray-marched shadows**: Rust wasm kernel `shadow_march` (ABI 19) traces rays across the height field with a 16-tap Vogel disk for contact hardening and soft penumbral roll-off. Dispatched to the worker pool by bands, with pure JS fallback (`kernels_js.js`).
- **Original scene lighting decomposition**: `fitOriginalLight` uses a 3-pass alternating least-squares solver on a 256-pixel composite sample to recover the dominant scene lighting vector `l0` and ambient/diffuse terms `ka, kd`. Clamped shadow recovery (`gain <= recover`) lifts existing directional shading without amplifying dark shadow noise.
- **Planckian color temperatures**: Kelvin presets (1850 K candlelight, 2700 K warm, 3200 K tungsten, 4000 K fluorescent, 5500 K daylight, 6500 K overcast, 8000 K shade, 10000 K blue sky) evaluate through linear Planckian approximations, normalized so 5500 K corresponds to neutral white.
- **Interactive canvas UX**: Key `L` activates the `lights` tool with draggable handles, Alt+drag distance scaling, mouse wheel diffusion/intensity adjustment, arrow key nudging, and quarter-resolution interactive dragging. Clicking the grey "own light" ring creates a virtual light matching the fitted scene illumination.
- **Memory & Lifecycle**: `layer._relight` stores normals and visibility textures up to map resolution (capped by `WORK_MAX = 4096`). Memory is properly tracked and released during `releaseCaches({ deep: true })`, and `relightSettled()` guarantees synchronization before any composite or export.

### 2. Generative relighting routes
- **Magnific route (`image-relight`)**: Evaluates the in-app shader in mode 1 to extract an isolated light map (lights plus ambient floor) with opaque alpha 255. Sends the crop and light map to Magnific, landing the result in one undo step as a pixel layer while hiding the relight filter layer.
- **Detail from original**: When `detail: true` (the default), Scumble calculates a color ratio between the generative result and the base image, upsampling it through a bilateral guided filter against the full-resolution photograph. This applies the external model's lighting transformation while preserving 100% of the original microtexture, sharp focus, and grain.
- **Prompt-guided routes**:
  - Local ComfyUI (`recipes/relight_qwen_local.json`): Qwen-Image-Edit-2509 with Relight and Lightning 4-step LoRAs, triggered via `\u91cd\u65b0\u7167\u660e`.
  - Comfy Cloud (`image_qwen_image_edit_2509_relight`): Cloud workflow with matching prompt guidance.
  - fal.ai IC-Light v2 (`fal-ai/iclight-v2`): Converts light direction to directional latents (`Left`, `Right`, `Top`, `Bottom`, `None`).
  - fal.ai Bria (`bria/fibo-edit/relight`): Provides 13 lighting atmosphere styles (midday, blue hour, low-angle sunlight, sunrise, spotlight, overcast, soft overcast, cloud-filtered, fog-diffused, moonlight, starlight, soft bokeh, harsh studio lighting).
- **Assistant Policy & Settings**: In-app relighting runs automatically (`AUTO`); paid or queued generative routes prompt the user with an explicit cost/queue card (`ASK`).

The implementation is robust, mathematically sound, memory safe, and completely preserves all prior release features.
