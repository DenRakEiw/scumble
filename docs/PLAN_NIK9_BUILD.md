# Nik 9 parity: the build plan (Umbauplan)

**Status: building since 2026-10-08 against `b6c5238` (0.1.41 is Latest); F1-F8, R1-S1-S4 built and gated.** The research and the shape are in
`docs/PLAN_NIK9.md` (2026-09-25); this is CLAUDE.md "What comes next" item 22. Five agents re-read the code on
2026-10-04 (nothing was run), one designed the shared foundations, four planned a release each; this file joins them,
removes the overlaps and makes the ids and cross references agree. Every effort figure is **inferred, not measured**.
Every line number is from `b6c5238`.

## 1. How to use this plan

- **One session per sitting.** A session is one row of the table in §3: build it, make its one local commit, write the
  hand-over line in CLAUDE.md "Where things stand", add its CHANGELOG `## Unreleased` line, then `/clear` (the user's
  rule since 2026-09-30). A session that runs out of context stops at a committed state; several sessions name their
  split point.
- **Anchors drift.** Each anchor names a function or constant as well as a line. Grep the name before editing and treat
  the number as a hint: earlier sessions of this plan move them.
- **Foundations first, then releases.** §4 holds the foundations F1-F12 (shared pieces that make the releases smaller
  and safer). A release session that builds a foundation points to it (R1-S4 is F9, R2-S1 and R3-S1 are F10, R4-S1 is
  F11, R4-S2 is F12) instead of repeating it.
- **Split sessions.** A session of about 1.5 d or more is built in two sittings that keep its id with a letter (F4a /
  F4b, F8a / F8b, R1-S3a / S3b, R1-S5a / S5b, R1-S7a / S7b; the optional R2-S15a-c and R4-S9a / S9b). A reference to
  the plain id (R1-S3) means all its parts; a dependency on one part names the letter. Sessions of 1-1.5 d name a split
  point instead (R1-S6, R1-S9, R2-S7, R1-S3b).
- **Questions.** Where a session needs the user's answer it names a question of §6 (G1-G8 general, R1-D1 ... per
  release). Ask before the session starts, not halfway.
- **Session layout.** Goal (and what the user sees), preconditions, changes, tests (with the tier), docs, risks,
  effort.

### 1.1 Rules for every session (from CLAUDE.md and the readers)

- Commit as DenRakEiw (`git -c user.name=DenRakEiw -c user.email=89697885+DenRakEiw@users.noreply.github.com`), no
  Claude trailer. Push only with the release or on the user's word.
- **Every app gate runs `--offline`.** An upload (layer pixels, the depth map PNGs, the guide PNGs) lands in the mirror
  and is forwarded to a connected ComfyUI, and the user's ComfyUI on 8188 is a production machine. Never queue or
  restart anything there. Before a model benchmark, read `GET /queue` (read only); freeing the card (`/free`) only with
  the user's OK.
- **New gate steps go into new gates** (`selection`, `limit`, `maps`, `depth`, `maskview`, `edges`, `depthfx`,
  `grading`, `masks`, `effects`, `blendmodes`), each picked up by `tools/run_gates.sh`'s `*)` rule (:127, timeout 420 s
  at :61). `editor_test.py` already runs about 370 of its 420 s.
- **No gate needs a real model.** Gates replace `host.helperCall` (`renderer/editor/host.js:2614`) and the model getter
  with a stand-in, as `tools/editor_test.py:3426-3443` does, and put both back at the end. The real model runs only in
  `tools/helpers_test.js`, in the measurement tools and by hand.
- **Downloads need the user's yes** (the 99 MB depth model is a file download), or the user clicks *Download* in
  *Settings › Helpers*.
- **Text rule.** No other product's name as a feature's model in the CHANGELOG, the manual, the README, the blog or
  CLAUDE.md. Model names (Depth Anything V2, SAM2, BiRefNet) stay where a text is about running them. This plan may name
  products.
- **Tests by risk** (CLAUDE.md Working rules): **Full** (both backends, a mutation round, a 15k measurement where it
  applies) for the `.scumble` format, autosave, Rust kernels, the compositor and export writers; **Normal** (one gate
  step per feature on tiles plus the gates the change touches; the canvas backend when a pixel path changes);
  **Light** (plain-Node tests, `lint`, `types`, one look) for models built from docs, looks and docs.
- Dev instance for measurements: `./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir=<scratch>
  --no-comfy`, closed with `SCUMBLE_CDP_PORT=9555 python tools/close_app.py`. Never the user's own profile.
- Write scripts and JS with the Write tool, not a heredoc; check written files for stray non-ASCII where escapes were
  meant (`grep -nP "[^\x00-\x7F]"`); edit with Edit rather than long patch scripts. Scratch files go to the session
  scratchpad.
- New editor modules go into `tools/build_node.py` FILES (:39-45); a new host member goes into the `EditorHost` typedef
  (`host.js:257-305`) and the node's own `js/host.js` (`F:\Comfyui\...\ComfyUI-InpaintCanvas\js\host.js`, its own repo:
  a local commit there, no push until a node version ships), or `build_node.py --check` and `types` fail.
- Check the usage window between steps and stop at a committed state around 70-80 %.

### 1.2 Reader and version numbers

F1 turns the `.scumble` versioning into a table (`FEATURES` in `electron/main/docfile.js`). Each release takes the
next free `minReader` number at its first picture-changing row, and every picture-changing row of that release uses
the same number: one bump per release. In the default order (release 1, 2, 3, 4) that is 3 (release 1's filter
limits), 4 (release 2), 5 (release 3), 6 (release 4). A release built in another order takes the next free number; the
sessions call it R. A field an older reader only carries (the `maps` resource) raises the per-document `version`
instead (F1, F8). The question of accepting the bumps is G5.

### 1.3 The release session (R1-S12, R2-S16, R3-S13, R4-S10)

Only on the user's word (CLAUDE.md; G6). Read `docs/RELEASING.md` first and check `gh release list`. The chain:

1. CHANGELOG `## Unreleased` becomes `## 0.1.N — <date>`; merge the per-session lines into a few items; check that no
   line names another product as a feature's model; say which documents need 0.1.N or newer. Version in
   `package.json` (edit from Python with `newline=chr(10)` and no BOM).
2. `npm run dist`.
3. Exe gates `--offline --exe dist/win-unpacked/Scumble.exe`, each run on its own profile: on `--tiles on` the 0.1.41
   list (`dist/gates/gates/rel41-exe/summary.txt`, 35 gates) plus `fill clip groups` (missing from 0.1.41's lists) plus
   the release's own gates; on `--tiles off` the 0.1.41 canvas list (`rel41-exe-canvas`, 21 gates) plus the release's
   pixel gates. Re-run a failing step listed in `docs/TESTING.md` "Known flakes" before believing it.
4. A look with the user on `docs/images/tutorial/scene.jpg`, `skin.jpg` and the user's 15k file where the release
   changes pictures.
5. Push, tag `v0.1.N`, `gh run watch` (CI runs lint, types, `python tools/build_px.py --check`), publish the draft
   (`gh release edit v0.1.N --draft=false`).
6. `node tools/manual_sync.js`; the manual's new paragraphs may need screenshots (mask the last four key characters if
   *Settings › API providers* shows).
7. The blog post in `F:\portfolio_web` (`lib/scumble-posts.ts`, slug `v0-1-NN`, `time` from `publishedAt` in German
   time): commit with the website's own identity, never the DenRakEiw noreply address, no `Co-Authored-By`, only the
   post's files; `npx tsc --noEmit -p .` and `npx next build` first; read the deploy's status afterwards.
8. The Store update (`npm run dist:store`), clicked through in the user's Chrome; *Submit for certification* only after
   the user's yes.
9. The portable zip asset if item 36 is built by then.
10. The node repo only if a node version ships with it.
11. Hand-over in CLAUDE.md and `docs/HISTORY.md`.

Effort: 0.5-1 d per release (inferred).

## 2. What changed since the research of 2026-09-25

The research's code references were read on 2026-09-25. Since then: the tile engine work, plugin API 3, the Boxes
plugin, clipping, groups, fill layers, the canvas-only view, item 35 (ComfyUI window, Comfy Cloud recipes), releases
0.1.26-0.1.41. What matters here:

**Corrections to `docs/PLAN_NIK9.md`**

- **17 blend modes are missing, not 18.** Linear light shipped in 0.1.32 (56a76f7). `BLEND_MODES` is at
  `inpaint_canvas.js:305` (10 modes), `EMULATED_BLENDS` at :307, and `blendEmulated` (:12073) already emulates a mode
  Canvas 2D lacks (a GPU shader on screen, `compositeTile` off screen). Its GPU branch is hard-wired to linear light
  (:12109). The px ABI is 14.
- **Line numbers moved** by 235 lines and more: `boxBlurs` is at `px/kernels.js:97`, `distTransform` at :76; the run
  path's hard thresholds are `stitch.js:237`, `:255`, `:532`, and also `electron/main/providers/inapp.js:32` (> 127)
  and `providers/util.js:178` (>= 128).
- **film.points follows the geometry now** (23b, d72925e): a `geometry` event `{kind, m, from, to}` moves its points
  through crop, extend, resize, upscale, turns and straighten. Other filters' pixel radii (blur, sharpen, halation,
  glow, structure) still stay in pixels after a resize.
- **The `control_image` anchor is gone**: the word appears only in a role tooltip (:15037); glb still creates its depth
  layer hidden with role control (`plugins/glb/main.js:150-158`). The finding must be read again before "depth as a
  layer" relies on it.
- **The DPT size rule** checked against `preprocessor_config.json` at the pinned commit: short side 518, keep aspect,
  multiple of 14 with Python's `round()` (half to even), bicubic, ImageNet mean and std. Sizes as width x height: a
  3:2 picture of 6000 x 4000 becomes 784 x 518 (777 / 14 = 55.5 rounds to 56), a small 400 x 300 becomes 518 x 392
  (`keep_aspect_ratio` keeps the scale nearer to 1: shrinking puts the short side at 518, enlarging the long side), and
  763 x 518 becomes 756 x 518 (54.5 rounds to 54). JS `Math.round` differs at .5.
- **The pinned model** was checked on 2026-10-04: `onnx-community/depth-anything-v2-small` at commit
  `4472b7362082ad9968fee890ca0f1e5aca36b93d`, `onnx/model.onnx` 99,060,839 B, sha256
  `afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c` (fp16 49,642,442 B, sha256
  `2df6223f206b5164e21f664ace61dabeb9bb6a49b8b5a3e00510b4807d0f5b04`; int8 27,258,801 B). The resolve URL redirects to
  the xet CDN; the Downloader follows redirects.

**Code that grew around the plan**

- **LaMa (2026-09-28)** set two precedents: a model in its own Electron utility process (`electron/main/onnx/lama.js`,
  `lama_process.js`; SAM2 and matting still block the main thread), and a commit-pinned URL with an exact `size` in
  the registry (the Downloader refuses a size mismatch). `SUBDIRS` gained `inpaint` and `lama`.
- **`.scumble` documents exist** (`electron/main/docfile.js`: `FORMAT_VERSION` 1, `READER_VERSION` 2, `readerFor` with
  `READER_2_BLENDS`). Any `{filename, subfolder, type}` anywhere in `getValue()` travels in a document and survives
  mirror pruning without docfile code (`collectRefs` :79, `host.referencedFileKeys` :2195, autosave `walkRefs`).
  `host.js` `STATE_KEYS` (:63) must list every top-level field, or an opened document carries a stale copy in
  `header.extra`; **`groups` is missing from it today** (written by `getValue` since 0.1.31).
- **Whole-picture geometry** (0.1.31/0.1.32): turns, flips, straighten, crop, extend, resize. Document-level marks keep
  an `xf` composed in `mapExtras(A, kind)` (:4583) and mapped back by `restoreGeometry` (:4642) on undo; nothing is
  resampled. A depth map that only had an input hash would read as stale after every turn.
- **Clipping, groups, fill layers.** A filter layer can be clipped (`clipCoverage`); groups are pass-through folders;
  fill layers (`FILTERS[id].over`: fill, gradient) make their own pixels, so a limit there multiplies alpha.
- **More tile-native selection writers**: `selectRectangle` (:6194), `TileMaskPixels.invert` (`inpaint_tiles.js:2507`)
  with its canvas twin, `selectionOverTiles` (:6286; a pool job, but it reads the whole box into one buffer: 600 MB for
  a whole-image box at 15k).
- **W x H paths still exist**: `applyMaskToSelection` (:6185, a W x H colour canvas), `select_point` (about 750 MB at
  15000 x 10000, nothing above 268 MP), the in-app `findObjects` upsample to a full-size Uint16Array (300 MB at 15k).
- **Plugin API 3** (`renderer/plugins.js:18`). `registerFilter` (:257-295) copies only label, params, apply, plugin,
  chain, control and reach: `wholeStats` never reaches a plugin filter although `docs/PLUGINS.md:275` promises it, and
  plugin params have no `color` type.
- **Texture units clash twice.** `renderToTexture` binds unit 6 (`inpaint_filters_gl.js:202`, above about 33 MP), where
  film.points' `u_blur` lives; `createSurface` and `surfaceFromBytes` bind unit 7 (:325, :482), where a third plugin
  sampler would live, so a three-sampler shader breaks only some of the time.
- **A helper stand-in pattern** exists in `editor_test.py` (:3391-3570, :7127-7419, :7840-8441): `host.helperCall`
  replaced, `memoryReport()` checks mirrors, the original put back.

**New findings (read, not run)**

- **Escape never reaches a plugin tool**: `inpaint_canvas.js:3041` handles Escape and returns before
  `host.pluginKey` (:3101). The Escape branches of film.points (`points.js:287`) and the Boxes tool
  (`plugins/boxes/tool.js:281`) are dead in the app; the gates call `H.pluginKey` directly and hide it. Fixed in R3-S5.
- **The LUT filter's GPU and CPU paths are untested** (no `lutFromCube` in any test), and `lutTextures` (:621) never
  deletes a texture explicitly. R3-S4 avoids baking a LUT per slider frame for that reason.
- **The manual claims an HSL filter** (`docs/MANUAL.md:248`); only the global `hue_sat` exists. R3-S4 makes it true.
- **`stackPlan`'s option `filters`** (:6554) means "filter layers may be stack entries"; the research's "leave filter
  layers out" option must have another name (F5 calls it `skipFilters`).
- **The curves histogram is probably missing on the tile backend's view passes** (it reads `_fxCache`, view passes
  write `_fxCacheView`). A range bar must not copy that path (F9).
- `docs/DOCUMENTS.md` (:93, :278, :388-389) still says the format is 1 / 1.
- `docs/BUGS.md:152` (film look "None" still adds grain) and `:336` (halation exports a 20000 x 14000 document in
  67 s) sit in the area of releases 2 and 3.
- **`\` is taken.** Held, it peeks at the base picture under every layer (`onKey`, `inpaint_canvas.js:3098`, before
  `host.pluginKey`; MANUAL.md:523). R1-S10 therefore gives the mask overlay no default key.
- **The perf gates cannot pass a JSON value.** `tools/run_gates.sh` turns every comma of `exportperf:*` (:119) and
  `mem:*` (:121) into a space, and `perf:*` (:103) and `docperf:*` (:126) pass their rest unquoted without that split:
  `--limit={"source":"depth",...}` arrives in pieces. Options in this plan are comma-free (`--limit=depth:0:0.5:0:0.05`,
  `--filter-params=style:frosted+amount:10`, `--map=4096x2731`), parsed with `split("=", 1)` (`export_test.py:1160`
  uses `split("=")[1]` today), and `perf:*` / `docperf:*` get the same comma split as `exportperf:*` the first time a
  session gives them an option (R1-S7b, F8b, R4-S3).
- **Not only the Node test pins the format numbers**: `tools/document_test.py:1233` crafts `version: 2, minReader: 1`
  as the "newer" case beside :1208's `3 / 3`; once F8b makes `FORMAT_VERSION` 2 that case stops being newer (F1 moves
  both).

**Process changes**

- On 2026-09-26 two review packages were folded into item 22 that `docs/PLAN_NIK9.md` does not mention (their text is
  only in `docs/HISTORY.md:1495-1504`): **masks and selections** (refine edge, soft selection from alpha with add /
  subtract / intersect, Bezier selection and paths, commands for saved selections, a black-and-white mask view;
  6.5-12.5 d) and **grading and panels** (a dither at the filter chain's final 8-bit write, a histogram / info panel, a
  navigator, filter presets with .cube export, colour match on luminance or a chosen region, vibrance, selective
  colour, channel mixer, gradient map, surface blur, median; 11-19.5 d). This plan covers the parts that overlap (the
  soft add and Intersect for every writer, the black-and-white mask view, refine edge as R2-S9's option) and leaves the
  rest to G4. Not covered, although F4 makes it cheap: the soft *selection from a layer's alpha* (`selectionFromLayer`,
  :10504, still cuts at 127 through a W x H canvas); on F4 it is one `AlphaSource` over the layer's store rows, about
  0.5 d, a candidate to fold into R1-S9 if the user says so (G4).
- Every release now also gets a Store update (`docs/RELEASING.md:18-29`) and, after 0.1.41, a portable zip (item 36).
- MCP's read-only hint comes from a name regex (`electron/main/mcp/server.js:36`); a command missing from the
  assistant's `POLICY` asks every time (`policy.js:334-335`); nothing checks `docs/COMMANDS.md` against `describe()`.
  F2 turns all three into gate failures.
- The 0.1.41 exe gate lists left out `fill`, `clip` and `groups`.
- Item 36 (the portable zip) is next on the list, the Comfy Dev Platform Challenge runs 2026-10-05 to 10-19, and
  CLAUDE.md suggests item 22 after B3. This plan assumes no start date (G2).

**Licences (checked 2026-10-04; the app takes MIT, Apache, BSD and OFL only)**

| What | Where in this plan | Licence | Ships or downloads? |
|---|---|---|---|
| Depth Anything V2 Small, ONNX (`onnx-community/depth-anything-v2-small`) | R1-S1 on | Apache-2.0 (the HF API's `cardData.license` and its base model `depth-anything/Depth-Anything-V2-Small`); the pinned `4472b736…` is that repo's last commit (2026-04-14). Open: issue #320 about the training data | the user's *Download* in *Settings › Helpers* (R1-D1) |
| SAM2 (box prompt, R1-S9) | R1-S9 | Apache-2.0 (in the registry today) | as today |
| BiRefNet / BiRefNet lite (the matte in the band) | R2-S9 | MIT (`models.js:35, :41`) | as today |
| RMBG-1.4 / RMBG-2.0 | R2-S9 only if the user picked one as the cutout model | non-commercial (BRIA) | the user's own download, as today; never a default |
| DA3Mono-Large | R1-S2 checkpoint only (R1-D2) | Apache-2.0; its ONNX export runs third-party code | not shipped, not in the registry |
| DA2 Base / Large / Giant, user depth maps | R2-S11 reads any grey layer | CC BY-NC 4.0 | never downloaded by the app: the user's own files |
| npm / Rust crates | - | none added by this plan | - |
| `transformers` (Apache-2.0), `onnxruntime` (MIT), `numpy` (BSD-3), Pillow (MIT-CMU) | `tools/depth_ref.py`, `tools/depth_probe.py`, `tools/depth_bench.py` | permissive | dev tools, never in the app |
| Methods: guided filter, dark channel prior, joint bilateral sample, van Herk / Gil-Werman, Kovesi radii, W3C blend formulas, lowbias32, Vogel disc | R1-S3, R2-S2, R2-S13/14, R4 | papers and specs, no code copied | the dark channel prior's US patent (US8340461, Microsoft) is listed as "Expired - Fee Related" by Google Patents (no EP family found); no patent found for the guided filter in one search (OpenCV and MATLAB ship it). A check before a sale (G8) |
| PSD blend keys, OpenRaster names | R4 | Adobe's public file-format spec; the OpenRaster spec | identifiers only |

## 3. The order at a glance

The default order follows the research: release 1, 2, 3, 4 (G1). Release 2 needs release 1. Releases 3 and 4 need
neither and may move first; then their foundations move with them (release 3: F1, F2, F3 for F7's twin, F7, F10;
release 4: F11, F12, and F1, F2 recommended). R1-S1 and R1-S2 need no foundation and are best done first (G3): the checkpoint on the user's
pictures decides how big release 2 is.

The "Order" column is the build order; release 2's session ids follow its topics (edges, then filters), so its order
differs from its numbering. Tier: F = full, N = normal, L = light. Effort in days, inferred.

### 3.1 Phase 0 and the foundations before release 1

| Order | Session | Title | Depends on | Tier | Effort |
|---|---|---|---|---|---|
| 1 | R1-S1 | The depth model in main (registry, `depth.js`, IPC, measurements) | R1-D1 | L | 1-1.5 |
| 2 | R1-S2 | Checkpoint on the user's pictures; constants for release 1 and 2 | R1-S1, model on disk, the user | L | 0.5 |
| 3 | F1 | Document feature table (`FEATURES`), the `STATE_KEYS` fix | - | F | 1 |
| 4 | F2 | Command surface checks (`readOnly`, policy coverage, COMMANDS.md freshness) | - | L | 0.5 |
| 5 | F3 | Pure weights module `inpaint_weights.js` | - | L | 0.5 |
| 6 | F4a | Selection combine, the core on both backends | - | N | 0.75 |
| 7 | F4b | Selection combine at the call sites; Intersect | F4a | N | 0.75 |
| 8 | F5 | Picture input without filter layers (`skipFilters`, `host.pictureInput`) | - | N | 0.5 |
| 9 | F6 | Filter pass context (`filterInfo`, `filterKey`) and `params.limit` | F3 | N | 1 |
| 10 | F7 | GL infrastructure: scratch unit, static samplers, packed u16 sampling | F3 | N | 1 |
| 11 | F8a | Document maps: the module, the store, geometry, undo | F5 | F | 1 |
| 12 | F8b | Document maps: persistence, staleness, the `maps` row | F8a, F1 | F | 1 |

F2 and F3 may share one session (both light and independent, about 1 d together). F5 and F6 together would be 1.5 d,
over the size this plan splits at (F4, F8): F5 stays alone and creates the `maps` gate its tests need. Foundations
before release 1: about 8 days in 10 sessions.

Conditional and not counted in §3.6: **R1-S1b**, the depth model in an Electron utility process (`depth_process.js`,
0.5 d), built right after R1-S1 when its decision rule picks the process route, or before R2-S7 when R2-S3 finds the
tiled detail pass blocking the main thread for over 1 s (R2-D1). R1-S1 itself never grows by it.

### 3.2 Release 1 (masks)

| Order | Session | Title | Depends on | Tier | Effort |
|---|---|---|---|---|---|
| 13 | R1-S3a | Depth maths and the `depth_guide` job (pure, Node tests; nothing calls them) | R1-S1, R1-S2 | L | 0.5 |
| 14 | R1-S3b | The depth map on the document; `depth_map`, `sample_depth` | R1-S3a, F2, F3, F5, F8 | N | 1-1.5 |
| 15 | R1-S4 | = F9: range bar and whole-picture histograms | F3, F8a | L | 1 |
| 16 | R1-S5a | Select by range: the writer, the depth source, `select_range` (every mode) | R1-S3b, F3, F4, F8 | N | 1 |
| 17 | R1-S5b | Select by range: the luminosity and colour sources | R1-S5a | N | 0.5 |
| 18 | R1-S6 | Select by range: the panel, preview tint, *Show depth map* | R1-S4, R1-S5b | N | 1-1.5 |
| 19 | R1-S7a | Limit on filter layers: the post-stage (GL and CPU), reader 3 | R1-S3b, F1, F3, F6, F7, F8 | N (both backends; F for its row) | 1 |
| 20 | R1-S7b | Limit on fill and clipped layers; the 15k export measurement | R1-S7a | N (both backends) | 0.5 |
| 21 | R1-S8 | Limit on filter layers: the row | R1-S4, R1-S6, R1-S7b | N | 1 |
| 22 | R1-S9 | Object tool box drag; `select_point` without W x H; Intersect hints | R1-S5a, F4 | N | 1-1.5 |
| 23 | R1-S10 | Layer-mask overlay, black-and-white view, effect view | R1-S7a | N | 1 |
| 24 | R1-S11 | Checkpoint in the app, 15k measurements, docs pass | R1-S1 to S10 | L | 1 |
| 25 | R1-S12 | The release (§1.3) | the user's word | - | 0.5-1 |

Release 1: 12.5-15 days in 15 sessions (with R1-S1/S2 and F9), plus the 8 days of F1-F8. R1-S3, R1-S5 and R1-S7
(1.5 d each) are split in two by the plan's own rule (F4 and F8 are split at that size); their sections say what goes
into each half. R1-S3a needs no foundation and may follow R1-S2 directly.

### 3.3 Release 2 (edges and depth filters)

| Order | Session | Title | Depends on | Tier | Effort |
|---|---|---|---|---|---|
| 26 | R2-S1 | = F10 with its release 2 extension (skip what is built) | G7 | N | 0.5-1 |
| 27 | R2-S2 | Edge maths `inpaint_edges.js` (snap, fit, fuse, edge tiles) | F3, F7 | L | 1 |
| 28 | R2-S3 | The bench on the user's pictures; constants and decisions | R2-S2, R1-D3 | L | 0.5-1 |
| 29 | R2-S4 | Guide and snap setting in the document; `depth-snap` row | R2-S2, R2-S3, F1, F8 | F | 1 |
| 30 | R2-S5 | Snap in the Limit stage and the effect view; *Edges* slider | R2-S4, R1-S6, R1-S7, R1-S10, F7 | N (both) | 1 |
| 31 | R2-S6 | Snap in Select by depth | R2-S5, R1-S5 | N (both) | 1 |
| 32 | R2-S12 | `haze` built-in filter; conditional params; `mapsOf`; the `skip` hook | R2-S1, R2-S5, F6, F7, F8 | N (both; F for its row) | 1 |
| 33 | R2-S13 | Dehaze maths `inpaint_haze.js` | R2-S2 | L | 1 |
| 34 | R2-S14 | `dehaze` built-in filter | R2-S12, R2-S13 | N (both; F for its row) | 1 |
| 35 | R2-S8 | Depth edits inside the selection; `depth_edit` | R2-S4 | N | 1 |
| 36 | R2-S7 | Detail pass (conditional, R2-D1) | R2-S2, R2-S3, R2-S4 | N | 1-1.5 |
| 37 | R2-S9 | Matte in the band (conditional, R2-D3, R2-D6) | R2-S8 (R2-S7's `pictureInputBox`, or builds it) | N | 1 |
| 38 | R2-S10 | Depth refine brush (conditional, R2-D3) | R2-S8 | N | 1 |
| 39 | R2-S11 | Depth from a layer (conditional, R2-D8) | R2-S4 | N | 0.5 |
| 40 | R2-S15 | Lens blur (only on the user's word, R2-D7) | R2-S5 | N | 2-3 |
| 41 | R2-S16 | The release (§1.3) | the user's word | - | 1 |

Release 2: core (S1-S6, S8, S12-S14, S16) 10-11 days in 11 sessions; with S7, S9, S10, S11 13.5-15 days; lens blur
2-3 more. The research said 8-13.

### 3.4 Release 3 (filters and control points)

| Order | Session | Title | Depends on | Tier | Effort |
|---|---|---|---|---|---|
| 42 | R3-S1 | = F10 (skipped when release 2 built it) | - | N | 0.5 |
| 43 | R3-S2 | Colour grading: the filter `color_grade` | F1, F2 | N (F for its row) | 1 |
| 44 | R3-S3 | Colour grading: the wheel control | R3-S2, F10 | N | 0.75 |
| 45 | R3-S4 | HSL in 8 channels (`hsl`); the `skip` hook if not built | R3-S2, R3-S3, F1, F10 | N (F for its row) | 1.25 |
| 46 | R3-S5 | Control points v2: texture v2, softness, ellipse, Escape routing | F1, F2, F7 | N (F for its row) | 1.25 |
| 47 | R3-S6 | Polygon and line control points | R3-S5 | N | 1.25 |
| 48 | R3-S7 | Preset hover preview | R3-S2 (the `grading` gate), F10 | N | 0.75 |
| 49 | R3-S8 | Paste a mask (and optional points copy / paste) | F2 | N (both) | 0.75-1 |
| 50 | R3-S9 | Effects plugin and chromatic shift | R3-D1, R3-D2, F1 | N (F for its row if R3-D2 is a bump) | 1 |
| 51 | R3-S10 | Glass I | R3-S9, R3-D9 | N | 1 |
| 52 | R3-S11 | Glass II, 15k measurement | R3-S10 | N | 1 |
| 53 | R3-S12 | Docs pass, measurements, the user's look | R3-S2 to S11 | L | 0.5 |
| 54 | R3-S13 | The release (§1.3) | the user's word | - | 0.5-1 |

Release 3: 11-12 days in 12 sessions when F10 is built, 11.5-12.5 days in 13 when not. The research said 8-10.

### 3.5 Release 4 (blend modes)

| Order | Session | Title | Depends on | Tier | Effort |
|---|---|---|---|---|---|
| 55 | R4-S1 | = F11: blend registry `blend_modes.js` (no new mode) | (F1 if built) | F | 1 |
| 56 | R4-S2 | = F12: per-pixel kernel structure, one emulated shader (no new mode) | R4-S1 | F | 1 |
| 57 | R4-S3 | The `blendmodes` gate and the baseline | R4-S1, R4-S2 | N | 0.5-1 |
| 58 | R4-S4 | Tier A: exclusion, linear dodge, linear burn, subtract, pin light, hard mix (ABI 15) | R4-S3, R4-D2, R4-D9 | F | 1 |
| 59 | R4-S5 | Tier B: colour dodge, colour burn, vivid light, divide (ABI 16) | R4-S4 | F | 1 |
| 60 | R4-S6 | Tier C, the kernel: hue, saturation, colour, luminosity, darker / lighter colour (ABI 17) | R4-S5 (ops 20-23, ABI 16), R4-S2, R4-D3 | F | 1 |
| 61 | R4-S7 | Tier C, the paths | R4-S6 | F | 0.5-1 |
| 62 | R4-S8 | Grouped list, references, docs, the live PSD check | R4-S7, R4-D5 to R4-D8 | N / L | 0.5-1 |
| 63 | R4-S9 | Dissolve (optional, R4-D1) | R4-S8 | F (worker stack, PSD / ORA, a row) | 1.5 |
| 64 | R4-S10 | The release (§1.3) | the user's word | - | 0.5-1 |

Release 4: 7-9 days in 9 sessions; dissolve 1.5 more. The research said 5-7 without the two foundations, the gate,
the live check or the release.

### 3.6 Totals (inferred)

| Part | Sessions | Days |
|---|---|---|
| Phase 0 and F1-F8 | 12 | 9.5-10 |
| Release 1 (R1-S3a to S12, F9 included) | 13 | 11-13 |
| Release 2 core | 11 | 10-11 |
| Release 2 conditional (S7, S9, S10, S11) | 4 | 3.5-4 |
| Release 3 (F10 already built) | 12 | 11-12 |
| Release 4 | 9 | 7-9 |
| **All four releases, core** | **57** | **48.5-55** |
| With release 2's conditional sessions | 61 | 52-59 |
| With lens blur (R2-S15a-c) and dissolve (R4-S9a/b) as well | 66 | 55.5-63.5 |

Not in these totals: R1-S1b (0.5 d, conditional, §3.1), R2-S9b (0.5 d, the generic refine edge, only on R2-D6) and the
four release sessions' waiting time for the user.

The research's 34-46 days counted neither the foundations nor the gates, the measurements and four release chains. The
folded packages (G4, 17.5-32 days) are not in these totals. About 6-7 of the foundation sessions replace work the
releases would otherwise have done themselves (the depth store, the selection combine, the filter plumbing, the blend
registry); the rest (F1, F2, F7, the unknown-op fix in F12) is safety the readers' traps call for.

### 3.7 Coverage of the research's feature table

Every row of `docs/PLAN_NIK9.md` "What Nik 9 has, and where Scumble stands", with the sessions that build it:

| Nik 9 feature | Sessions |
|---|---|
| Depth masks | R1-S1 to R1-S3 (model, map), R1-S5a (select), R1-S7 (limit), R1-S6 / R1-S8 (UI); edges R2-S2 to R2-S11 |
| AI masks (click / box) | R1-S9 (box drag, `select_point` without W x H) |
| Mask overlays | R1-S10 (overlay, black and white, effect view) |
| Luminosity masks | R1-S5b (select), R1-S7a (limit), on F9's range bar |
| Colour masks | R1-S5b, R1-S7a (F3's `colourSimilarity`) |
| Control lines | R3-S6 (line points) |
| Elliptical / polygonal control points | R3-S5 (ellipse), R3-S6 (polygon) |
| Control point diffusion | R3-S5 (softness) |
| 18 blend modes (17 missing) | R4-S1 to R4-S8; dissolve R4-S9 |
| Halation | exists (`film.halation`, `film.look`) |
| Chromatic shift | R3-S9 |
| Glass effect | R3-S10, R3-S11 |
| Colour grading wheel | R3-S2 (filter, with the global range), R3-S3 (wheels) |
| ClearView (dehaze) | R2-S13, R2-S14 |
| HSL, 8 channels | R3-S4 |
| Preset hover preview | R3-S7 |
| Copy / paste local adjustments | R3-S8 (paste a mask; control points on R3-D10) |

The research's release 2 extras are covered too: haze by depth (R2-S12), lens blur (R2-S15, on R2-D7), depth from any
grey layer (R2-S11). Not built, as the research says: depth as a layer (the control-layer finding first), a ComfyUI depth
route, limits in presets.

### 3.8 As built records (2026-10-08)

- **R1-S1** (2026-10-08): Depth model in main (`electron/main/onnx/depth.js`, `models.js` entry for `da2_small`, IPC `helpers:depth`, `host.js` wiring).
- **R1-S2** (2026-10-08): Checkpoint; decisions confirmed (`WORK_MAX = 2048` user decision per R1-D5, keeping 4096 as an option; `GUIDE = { r: 2, eps: 1e-3 }`).
- **F1** (2026-10-08): Document feature table (`FEATURES` in `docfile.js`), `STATE_KEYS` fix in `host.js` for `"groups"` and `"maps"`.
- **F2** (2026-10-08): Command surface checks (`readOnly`, assistant policy coverage, `commands_doc.py` GROUPS updated, `COMMANDS.md` refreshed with 108 commands).
- **F3** (2026-10-08): Pure weights calculation module `renderer/editor/inpaint_weights.js` with `rangeWeight`, `normalizeLimit`, `limitWeight`, and `WEIGHTS_GLSL`.
- **F4a / F4b** (2026-10-08): Selection combine core (`combineAlpha`, `combineRows`, `tilesSource` with ArrayBuffer fix, `bytesSource`, `rectSource`, `TileMaskPixels.combine`) and call sites; Intersect mode.
- **F5** (2026-10-08): Picture input without filter layers (`skipFilters`, `host.pictureInput`, `passStores` and `drawComposite`).
- **F6** (2026-10-08): Filter pass context (`filterInfo`, `filterKey`) and `params.limit`.
- **F7** (2026-10-08): GL infrastructure: scratch unit allocation, static sampler caching, packed u16 sampling.
- **F8a / F8b** (2026-10-08): Document maps store `ed.maps`, `setMap`, geometry following, persistence, and staleness fingerprinting from filter-free source.
- **R1-S3a / R1-S3b** (2026-10-08): Depth maths, `depth_guide` worker job, `depth_map` and pure read `sample_depth` commands, stored on `ed.maps.depth` with 0.5/99.5 percentiles.
- **R1-S4** (2026-10-08): Range bar control `renderer/editor/inpaint_rangebar.js` and whole-picture histograms.
- **Review Must-Fix 1-7** (2026-10-08): All 7 review findings resolved; gates `pixels selection limit maps film editor` ALL PASS on both `--tiles on` and `--tiles off` with `--offline`.
- **R1-S5a** (2026-10-08): Select by range depth source: banded combine rule, worker `range_select` op, `ed.selectRange`, `cancelRange`, `select_range` command (auto policy, 109 commands in COMMANDS.md), selection gate cases 1–5, 9, 10, 12 passing on both backends.
- **R1-S5b** (2026-10-08): Select by range luminosity and colour sources: worker `range_select` luma/color band processing, `ed.selectRange` with `holdRunStack` and `fillBoxFromStack` (at most 2 bands in flight), `SharedArrayBuffer` transport, float precision epsilon in `rangeWeight`/`WEIGHTS_GLSL`, all 12 selection gate cases passing on `--tiles on` (including 15k luma case 11) and `--tiles off`. All 6 gates passing 100% on both backends.
- **R1-S6** (2026-10-09): Selection panel *Select by range* block: Depth (guarded by `host.depthSupported`), Luminosity and Colour sources, integrated range bar with live preview tint (`_rangeTint`, WebGL shader with CPU twin, cached screen-scale sample honoring acceleration latch), eyedropper `pickOnce`, Show depth map toggle (`mapView = "depth"`), Enter key commitment in range bar, full panel cases in `selection_test.py`. Gates `pixels`, `selection`, `limit`, `maps`, `film`, `editor` pass 100% on both `--tiles on` and `--tiles off` with `--offline`.

## 4. Foundations

Each foundation is built once, in its own session (F4 and F8 in two), before the first release session that needs it.
None of them changes a picture by itself unless it says so; the proof is in its tests. Where a foundation answers a
reader's open design question, the answer is stated here and the release sessions follow it.

What is deliberately **not** a foundation, because the evidence does not carry it:

- Moving `ed.objects` into the maps store: its full-resolution upsample is the pattern to avoid.
- A generator for built-in GLSL filters: release 3's grading and HSL reuse mode 2's offset tables and a direct shader,
  and the new effects use the plugin `shade()` contract with film's `makeRunner`.
- A table of parameter types: only `color` and `hidden` are added (F10), and two edits beat refactoring five switch
  sites (`plugins.js:262-274`, `inpaint_canvas.js:15330-15445`, `commands.js:1316-1336`, `:1003-1007`,
  `inpaint_filters.js:1104`).
- A control-point shape module in core before release 3: R3-S5 builds `plugins/film/shapes.js` on F7's units.

### F1: Document feature table (`FEATURES` in docfile.js), plus the STATE_KEYS fix

**Why.** Item 22 raises the `.scumble` versions about five times: release 1 adds the `maps` field (version 2, F8) and
filter limits (reader 3, R1-S7); release 2 adds edge snap, haze and dehaze; release 3 adds built-in filter ids
(`color_grade`, `hsl`) and point shapes that an older reader would show differently; release 4 adds 16-17 blend modes.
Today every bump rewrites `readerFor`'s logic and breaks literal "newer" fixtures in two test files; linear light
needed exactly that edit in 56a76f7. With the table each bump is one row and the test loop over the rows covers it with
no fixture edit: a later bump drops from 1-2 h to about 10 min, and the document gate never fails for the wrong reason.

**Today.** `electron/main/docfile.js:21-29`: `FORMAT_VERSION` 1, `READER_VERSION` 2, `READER_2_BLENDS =
{linear-light}`, a hard-coded `readerFor()` that returns 2 or 1. `buildHeader` (:105-112) writes `version:
FORMAT_VERSION` into every document. `checkHeader` (:115-126) notes `h.version > FORMAT_VERSION` and refuses `minReader
> READER_VERSION`. `renderer/editor/host.js:63` `STATE_KEYS` lacks `groups` (written by `getValue` since 0.1.31,
`inpaint_canvas.js:18181`), so an opened document carries a stale groups copy in `docExtra` and `header.extra`
(host.js:2430-2431). `tools/document_test.js:313` (version 3, minReader 3) and `:315` (version 2, minReader 1) are
the literal "newer" cases; `:320` asserts `READER_VERSION === 2`; `tools/document_test.py` step 11 crafts version 3 /
minReader 3 (:1208, messages :1215-1219) and version 2 / minReader 1 (:1233, the "opens with a note" case; summary
:1265, docstring :36). `docs/DOCUMENTS.md:93, 278, 388-389` still say 1 / 1.

**Change.**

- `docfile.js`: replace `READER_2_BLENDS` and `readerFor` with a `FEATURES` table; derive `FORMAT_VERSION` and
  `READER_VERSION` from it. `buildHeader` writes `version: versionFor(document)` per document (a document with no new
  feature stays at 1 and 0.1.41 opens it with no "newer" note) and `minReader: readerFor(document)`. Export `FEATURES`,
  `featuresOf`, `readerFor`, `versionFor`.
- `host.js:63`: add `"groups"` to `STATE_KEYS` (`maps` follows in F8b).
- `tools/document_test.js`: the "newer" cases become `doc.FORMAT_VERSION + 1` and `doc.READER_VERSION + 1`; a loop over
  `FEATURES` builds each row's `sample` and asserts its reader and version; an empty document gives 1 / 1. Hash
  `buildHeader` of the existing fixtures before and after: no written byte may change. **One explicit case per row**
  beside the loop (here: `readerFor({ layers: [{ blend: "linear-light" }] }) === 2`), because a loop over the rows
  cannot notice a deleted row; every later session that adds a row adds its explicit case (`readerFor` or `versionFor`
  of the row's sample equals the number written down).
- `tools/document_test.py`: :1208 becomes version 99 / minReader 99 and :1233 version 99 / minReader 1 (a "newer"
  version that stays newer after F8b), with the messages (:1215-1219, :1265) and the docstring (:36).
- `docs/DOCUMENTS.md` §8: "a new feature is a FEATURES row", the table; fix the 1 / 1 drift.

**Interface.**

```js
// electron/main/docfile.js (CommonJS)
const layersOf = (d) => (d && Array.isArray(d.layers) ? d.layers : []);
/** One row per document feature: an older reader shows it wrongly (reader) or only carries it (version).
 *  sample: the smallest document that has it (for tests). */
const FEATURES = [
  { id: "linear-light", since: "0.1.32", reader: 2, sample: { layers: [{ blend: "linear-light" }] },
    test: (d) => layersOf(d).some((l) => l && l.blend === "linear-light") },
  // F8b:   { id: "maps", version: 2, sample: { maps: { depth: {} } }, test: (d) => !!(d && d.maps && Object.keys(d.maps).length) }
  // R1-S7: { id: "filter-limit", reader: 3, test: (d) => layersOf(d).some((l) => l && l.kind === "filter" && l.params && l.params.limit) }
  // R4-S1: one row per entry of READER_OF_BLEND, kept equal to renderer/editor/blend_modes.js by document_test.js (F11)
];
const FORMAT_VERSION = Math.max(1, ...FEATURES.map((f) => f.version || 1));
const READER_VERSION = Math.max(1, ...FEATURES.map((f) => f.reader || 1));
function featuresOf(document) -> string[]   // a row whose test throws counts as present (the safe side)
function readerFor(document) -> integer      // the highest reader among present rows, else 1
function versionFor(document) -> integer     // the highest version among present rows, else 1
// module.exports adds FEATURES, featuresOf, readerFor, versionFor
```

**Risk.** Low. Per-document versioning is intended: 0.1.41 opens a document with maps with its "newer" note and asks
before saving over it (DOCUMENTS.md §8). The `groups` fix changes what an opened document carries in `extra`: check
that `restore()` (host.js:2432) never takes groups from `extra` over the document's own.

**Tier and tests (full).** `node tools/document_test.js`: the FEATURES loop; the derived "newer" cases are refused or
opened with a note; fixture headers byte-identical before and after. The `document` gate `--offline` on `--tiles on`
and `--tiles off`, `docux` once. Mutation round: delete the linear-light row; turn its `reader` into a `version`; make
`readerFor` return 1. Each must fail `document_test.js`; `git diff --stat` after the round.

**Sessions.** 1.

### F2: Command surface checks (a readOnly flag, policy coverage, COMMANDS.md freshness)

**Why.** Release 1 adds `depth_map`, `sample_depth`, `select_range` and the intersect mode; release 2 adds
`depth_edit` and maybe `depth_from_layer`; release 3 extends `film.add_point` and `set_mask`; release 4 widens
`set_layer`'s enum. Today three things fail quietly per new command: a missing `POLICY` row makes the assistant ask
every time, a read is announced to MCP clients as a write because of the name regex, and `docs/COMMANDS.md` goes stale
until a review notices (V6 step 2's review caught exactly that). F2 makes all three gate failures.

**Today.** `electron/main/mcp/server.js:36` `READ_ONLY = /^(ping|list_|status$|get_|filter_types|screenshot|describe)/`
is the only source of `readOnlyHint` (:69). `policy.js:334-335` answers a command missing from `POLICY` with ASK "not
in the assistant's table"; `READS` is at :14-18. `tools/assistant_test.js:1137-1256` checks only the rows it lists.
`describe()` (`renderer/commands.js:1355-1360`) emits name, description, scope, needsImage, plugin and params, no
read-only flag; plugin commands pass their def through as `{...def}` (`plugins.js:647`). `tools/commands_doc.py`
needs a running instance; a name missing from `GROUPS` (:19-28) lands in "Other"; nothing compares the result with
`docs/COMMANDS.md`.

**Change.**

- `commands.js`: a Command may carry `readOnly: true`; `describe()` emits it. Mark the existing reads: `ping`, the
  `list_*` commands, `status`, `get_state`, `filter_types`, `read_log`, `sample_mean_color`, `screenshot`, `compare`,
  `film_looks`, `glb_info`, `boxes_list`.
- `server.js:69`: `readOnlyHint = c.readOnly === true || READ_ONLY.test(c.name)`.
- `tools/commands_doc.py`: factor `main()` into `render(session) -> str`.
- `tools/commands_test.py`, a new last step: render COMMANDS.md against the gate instance; fail when it differs from
  `docs/COMMANDS.md` ("stale: run python tools/commands_doc.py") or when any name lands in "Other".
- `tools/assistant_test.py`, a new step `every_command_has_a_policy_row`: write `describe()`'s `[{name, readOnly}]`
  into the log folder and run `node tools/assistant_test.js --cover <file>`, which fails on any name not in `EXCLUDED`
  whose `decide()` reason is "not in the assistant's table", and on any `readOnly` name missing from `READS`.
- Every command that asks today by omission gets an explicit ASK row with a reason. Regenerate COMMANDS.md in the same
  commit.

**Interface.**

```js
// renderer/commands.js
/** @typedef {{ description: string, params: Record<string, CommandParam>, scope?: "doc"|"app",
 *              needsImage?: boolean, readOnly?: boolean, run: Function }} Command */
// describe() -> [{ name, description, scope, needsImage, plugin, readOnly: !!c.readOnly, params }]
// electron/main/mcp/server.js toTool(): annotations.readOnlyHint = c.readOnly === true || READ_ONLY.test(c.name)
// tools/assistant_test.js --cover <names.json>   names.json: [{ name: string, readOnly: boolean }]; exit 1 listing uncovered names
// tools/commands_doc.py: def render(s) -> str (GROUPS, INTRO, outro); main() writes render(session()) to OUT
```

**Risk.** COMMANDS.md may already be stale: regenerate it first. Plugin commands show only for loaded plugins; gate
profiles are fresh and load the built-ins, so the comparison is stable there. Commands that ask by omission on purpose
get an explicit ASK row, not an exclusion.

**Tier and tests (light).** Mutate by hand once: delete a `POLICY` row (the assistant gate must fail and name it);
add a word to a description (the commands gate must fail as stale); give a write command `readOnly` (`--cover` must
fail: not in READS). Gates `--offline`: `lint`, `types` (commands.js is checked), `mcp` (`list_layers` keeps
`readOnlyHint` true), `commands`, `assistant`.

**Every later session that adds or changes a command** then does four things the gates enforce: a `POLICY` row (and
`READS` for a read), `readOnly` where it applies, its name in `commands_doc.py` `GROUPS`, and COMMANDS.md regenerated.

**Sessions.** 0.5.

### F3: Pure weights module (`inpaint_weights.js`)

**Why.** One formula serves four consumers that would otherwise drift: the range selection writer (R1-S5, CPU and
pool worker), the filter Limit stage (R1-S7, GLSL and CPU), the range bar's preview (R1-S6), and in release 3
possibly film.points, which can import the same colour metric so that a colour range and a control point agree. The
twins are tested once in plain Node, and R1-S5 and R1-S7 drop their own maths and its tests.

**Today.** No range-to-weight function exists. The falloff and the colour similarity exist only inside the film pack:
`plugins/film/points.js:13-36` (GLSL) and :139-151 (CPU), with `sigma = 0.04 + tol * 0.6` (:44) and `sstep` in the
film PRELUDE (`plugins/film/common.js:6-35`); the luma constants are 0.299 / 0.587 / 0.114 there and `LR / LG / LB` in
`inpaint_filters.js`. Plugins may import core modules by absolute path (`plugins/boxes/main.js:22`,
`plugins/film/looks.js:7`).

**Change.** New `renderer/editor/inpaint_weights.js` (`// @ts-check`, no DOM at import), listed in `build_node.py`
FILES. It holds JS functions and one GLSL string with the same maths, the `Limit` typedef and its normaliser, and the
u16 bilinear twin that F7's GLSL mirrors. New `tools/weights_test.js` (plain Node). Nothing calls the module yet.

**Interface.**

```js
// renderer/editor/inpaint_weights.js
export const LUMA = [0.299, 0.587, 0.114];
export function sstep(a, b, x)   // b <= a: hard step (x >= b ? 1 : 0); else t = clamp((x - a) / (b - a)), t*t*(3 - 2t)
/** @typedef {{ source: "depth"|"luma"|"color", lo: number, hi: number, fLo: number, fHi: number, invert: boolean,
 *              color?: string, tol?: number }} Limit   lo, hi, fLo, fHi in 0..1 of the source value; color '#rrggbb'; tol 0..100 */
export function rangeWeight(v, r)   // w = sstep(r.lo - r.fLo, r.lo, v) * (1 - sstep(r.hi, r.hi + r.fHi, v)); r.invert ? 1 - w : w
export function opp(r, g, b) -> [L, r - L, b - L]   // film.points' opponent space, inputs 0..1
export function colourSimilarity(r, g, b, ref /* opp */, tol)   // exp(-d2 / (2 s^2)), d2 = dL^2 + 4 (da^2 + db^2), s = 0.04 + tol / 100 * 0.6
export function sourceValue(limit, r, g, b, mapValue)   // luma: dot(LUMA); color: colourSimilarity(..., hex(limit.color), limit.tol); depth: mapValue (0..1)
export function limitWeight(limit, r, g, b, mapValue) -> 0..1   // rangeWeight(sourceValue(...), limit)
export function weightTable(r) -> Uint8Array(256)   // round(255 * rangeWeight(i / 255, r)) for 8-bit luma sources
export function normalizeLimit(v) -> Limit | null   // null / false -> null; clamps; swaps lo > hi;
                                                    // throws "limit.source must be depth, luma or color"; always a new object
export function u16Bilinear(data /* Uint16Array */, w, h, px, py) -> 0..1   // pixel centres at +0.5, edge clamp (F7's GLSL twin)
export const WEIGHTS_GLSL   // float w_sstep(float a, float b, float x); float w_range(float v, vec4 r /* lo,hi,fLo,fHi */, bool inv);
                            // vec3 w_opp(vec3 c); float w_colour(vec3 c, vec3 ref, float tol);
                            // float w_limit(int source, vec3 c, float mapV, vec4 r, bool inv, vec3 ref, float tol)
```

The `Limit` object is the one shape for `select_range` (R1-S5), `params.limit` (F6, R1-S7) and the UI (R1-S6, R1-S8).

**Risk.** The film PRELUDE already defines `sstep`, so the core GLSL names carry a `w_` prefix and both can sit in one
shader. The colour metric must stay byte-identical to film.points, or a later import into `points.js` moves pictures:
the test compares against `points.js`' CPU formula. `fLo = 0` must be a hard step at `lo` in both twins.

**Tier and tests (light).** `node tools/weights_test.js`. With lo .3, hi .6, f .1: w(.3) = 1, w(.2) = 0, w(.25) = .5,
w(.6) = 1, w(.65) = .5, w(.7) = 0; invert gives 1 - w; fLo 0 gives 0 at .2999 and 1 at .3. `colourSimilarity` equals
`points.js` :147-151 on 10,000 random pairs to 1e-12. `normalizeLimit` refuses source "x", swaps lo > hi and returns a
new object every call. `u16Bilinear` on a 3 x 2 map: corners exact, edges clamped, the centre equal to the mean. The
in-app GLSL check (`WEIGHTS_GLSL` through `runShader` on a 256 x 1 ramp, within 1 level of `weightTable`) runs in F6.
`lint`, `types`.

**Sessions.** 0.5.

### F4: One selection write path (`combine` with alpha sources, a soft add rule, Intersect)

**Why.** Release 1 has five new writers into the selection: Select by depth, by luminosity and by colour (R1-S5), the
Object tool's box drag with SAM2's logits (R1-S9), a soft Load (add and intersect); release 3's "paste a mask" can use
it for a layer mask. With `combine` each writer is an `AlphaSource` (a `read(x, y, w, h)` function) and no new tile or
canvas code; Intersect lands once for all of them; no new path builds a W x H mask, the failure `applyMaskToSelection`
(a W x H canvas, nothing above 268 MP) and `select_point` (about 750 MB at 15k) still have. The research's "decide the
soft add rule once" is decided here: **add = a + w - a·w/255** (what canvas `source-over` gives today), subtract =
a - a·w/255, intersect = a·w/255, replace = w.

**Today.** `applyTilesToSelection` (`inpaint_canvas.js:7146-7172`) is soft only in replace mode: add overwrites with
the source pixel wherever source alpha > 0 (a soft wand tile lowers an existing selection), subtract clears on any
alpha. `applyShapeToSelection` (:6217-6234) and five more sites switch `mode === "subtract" ? "destination-out" :
"source-over"` by hand (:5747, :5775, :5875, :7381, :10990). `selectRectangle` (:6194-6209) fills or clears.
`applyMaskToSelection` (:6185) builds `maskToColorCanvas` at W x H. The modes come from the keys at :5277, :5596 and
:5639 (Alt subtracts, Shift adds); `boundsAfter` is at :14319. The commands repeat the enum at `commands.js:532, 551,
575, 582, 596`; the segment-mode buttons are at `inpaint_modal.js:614-622`. `TileMaskPixels.invert`
(`inpaint_tiles.js:2507`, class at :2498) and `MaskPixels.invert` (`inpaint_pixels.js:590`, class at :583) are the
both-backend template.
`drawInto` clips on canvases (`inpaint_pixels.js:219`) and is a scratch of the rect on tiles (`inpaint_tiles.js:1487`).
`destination-in` is in `WHOLE_CANVAS_OPS` (`inpaint_pixels.js:136`).

**Interface (both sessions).**

```js
// renderer/editor/inpaint_raster.js
export const SEL_MODES = ["replace", "add", "subtract", "intersect"];
export const mul255 = (x, y) => { const t = x * y + 128; return (t + (t >> 8)) >> 8; };   // round(x*y/255) exact (the kernels' formula)
export function combineAlpha(a, w, mode)   // replace: w | add: a + w - mul255(a, w) | subtract: a - mul255(a, w) | intersect: mul255(a, w)
export function combineRows(dst /* RGBA8 */, dOff, dStride /* bytes */, src /* alpha u8 */, sOff, sStride, w, h, mode, color /* [r,g,b] */)
                                          // out = a ? [...color, a] : [0,0,0,0] (a transparent pixel carries no colour, as invert)
export function selModeOf(e, fallback = "replace")   // Shift+Alt -> intersect, Alt -> subtract, Shift -> add
export function selectionGco(mode) -> { op: "source-over"|"destination-out"|"destination-in", clearOutside: boolean }   // clearOutside for replace and intersect
/** @typedef {{ box: number[] /* [x0,y0,x1,y1] image px where it may be non-zero */,
 *              read(x: number, y: number, w: number, h: number): Uint8Array /* w*h alpha, 0 outside */ }} AlphaSource */
export function rectSource(box) -> AlphaSource
export function tilesSource(tiles /* [{tx,ty,data: RGBA 256*256*4} | {tx,ty,alpha: Uint8Array(65536)} | {tx,ty,full:true} | {tx,ty,empty:true}] */,
                            at /* [x,y] of tile 0,0 */, box) -> AlphaSource      // `full` reads as 255 without an allocation
export function bytesSource(alpha, x0, y0, w, h) -> AlphaSource
// renderer/editor/inpaint_pixels.js (canvas) and inpaint_tiles.js (override)
MaskPixels.prototype.combine(src /* AlphaSource */, mode, color = [255, 0, 0])   // a layer mask passes [255, 255, 255]
// renderer/editor/inpaint_canvas.js
combineSelection(src, mode = "replace", { label = "Selection", box = src.box } = {})   // one 'selection' undo step,
                                          // markSelectionChanged(boundsAfter(mode, box), touched), draw
// renderer/commands.js
P.enum = (description, values, def) => ({ type: "string", description, enum: values.slice(), ...(def !== undefined ? { default: def } : {}) });
P.selMode = () => P.enum("replace, add, subtract or intersect", SEL_MODES, "replace");
```

**Rule for banded writers** (R1-S5, R1-S9): `combine` clears outside its source's box for replace and intersect. A
writer that calls it once per band therefore never passes replace or intersect per band: replace = `sel.clear()` once,
then add per band; intersect = subtract with the inverted weight per band (the identity `a - mul255(a, 255 - w) ===
mul255(a, w)` holds for all bytes, because a·w/255 never ends in .5 with 255 odd); a writer whose bands cover only a
box first calls `combine(rectSource(box), "intersect")` once, which clears outside the box and keeps the inside.

#### F4a: the core on both backends (0.75 session)

- `inpaint_raster.js`: `SEL_MODES`, `mul255`, `combineAlpha`, `combineRows`, `selModeOf`, `selectionGco`, the three
  sources.
- `inpaint_pixels.js`: `MaskPixels.combine`: `readRect` / `writeRect` per 256-row band inside `src.box`; outside the
  box it clears for replace and intersect.
- `inpaint_tiles.js`: `TileMaskPixels.combine`, modelled on `invert`: for each tile that touches the box,
  `writable(tx, ty)`, `combineRows` on the part inside the image, `_dropTile` when it ends up empty. Tiles outside the
  box are dropped for replace and intersect and left alone for add and subtract; absent tiles are skipped for subtract
  and intersect and allocated for add only where the source is non-zero. Bump `_version` and the mirror's `_dispVer`.
- **Measure first:** Skia's own 8-bit rounding of `source-over`, `destination-out` and `destination-in` on alpha over all
  65,536 (a, w) pairs on a CPU canvas, against `mul255`; write the worst into `docs/PLAN_NIK9.md`. Both backends still
  agree, because every path runs the same code on both.
- Tests: `tools/pixels_test.js` new `both(...)` case `mask_combine`: a 601 x 501 mask (partial last tile row and
  column); per mode, a soft source with whole-pixel steps (0, 37, 128, 200, 255) crossing tile edges gives alpha
  exactly equal to `combineAlpha` (worst 0), backends byte-equal. Spot checks add(128,128) = 192, subtract(255,128) =
  127, intersect(255,128) = 128. Intersect with an empty source leaves `tileCount` 0. A box starting at x = 256 drops
  every tile to its left for intersect and keeps them for add. Colour [255,255,255] works for a layer mask. A `full`
  tile reads as 255. Gates `pixels`, `lint`, `types`.

#### F4b: the call sites and Intersect (0.75 session)

- `inpaint_canvas.js`: `combineSelection`; `boundsAfter` learns intersect (`{within: known ∩ box}`);
  `applyTilesToSelection` becomes `combineSelection(tilesSource(...))`, so the soft add is a + w(1 - a);
  `selectRectangle`'s intersect clears the four strips outside the box; `applyShapeToSelection` and the five gco sites
  use `selectionGco(mode)`, where intersect is `sel.clear()` of the outside strips and then `drawInto(box)` with
  `destination-in` (the `WHOLE_CANVAS_OPS` trap stays inside the box on both backends); :5277, :5596 and :5639 use
  `selModeOf(e)`.
- `inpaint_modal.js`: an Intersect button in the segment-mode buttons (:614); Load (:593) takes Shift+Alt.
- `commands.js`: `P.enum` and `P.selMode()` at the five sites and in `select_by_text`'s list (:582).
- Not here: the 11 hint strings and the manual (R1-S9), the depth, range and box sources (R1-S5, R1-S9).
- Tests: new gate `tools/selection_test.py`, `--offline`, `--tiles on` and `off`: `select_rect` intersect of
  [0,0,400,400] with [200,200,600,600] gives bounds [200,200,400,400]; lasso and polygon with Shift+Alt through real
  pointer events; the wand in add mode over a selection feathered to 200 keeps >= 200 (today it drops); Load with
  Shift+Alt; undo and redo restore each step. `commands_test`: `select_rect`, `select_mask` and `select_point` accept
  "intersect", a bad mode names the four. Gates `pixels`, `editor` (its selection steps), `selection`, `commands`,
  `lint`, `types`.

**Risk.** The soft add changes the wand's result where a feathered wand tile meets an existing selection; that is the
fix, but an `editor_test` step that pinned the old bytes moves its expectation. Twelve call paths change in F4b: give
each one gate step on tiles. Intersect at 15k on the canvas backend is the escape hatch only.

**Tier.** Normal (both backends: a selection write is a pixel path).

### F5: Picture input without filter layers (`skipFilters`, `host.pictureInput`)

**Why.** Without it the depth model (R1-S3) reads the filter layers' output, so a depth-limited haze feeds its own map
("the model input leaves filter layers out" in the research). The map's freshness fingerprint (F8b), release 2's guide
and detail tiles, and any later photo-derived input need the same. Fixing the two-walk trap once here keeps R1-S3 out
of the compositor walk, and R1-S3 gets an aspect-kept input at the DPT size in one call instead of SAM2's 1024 squash.

**Today.** `drawLayersInto` (`inpaint_canvas.js:16148`) and `passStores` (:7193) take only `forRun`, `upTo`,
`baseOnly`, `controlOnly`; `forRun` drops control and reference layers but keeps filter layers. `drawComposite`
(:16128) builds a W x H `flatCanvas` when any shown layer below is a filter (outside a region pass). `sampleRegion`
(:6431) passes `opts` to `drawComposite`; `sampleRegionSettled` (:7258) primes `passStores` first (`primePass`, :7238).
`host.objectInput` (`host.js:2693`) is SAM2's 1024 x 1024 squash with `forRun`. Plugin `Document.flatten` passes
`forRun` too (`plugins.js:95`).

**Name.** The option is **`skipFilters`** (default false). The readers proposed `filters` (default true), but
`stackPlan` (:6554) already has an option `filters` with another meaning ("filter layers may be stack entries");
one name for two senses would be a trap.

**Change.**

- `inpaint_canvas.js`: `opts.skipFilters` in `drawLayersInto` (skip kind `filter` before `applyFilterLayer`, about
  :16173) and the same branch in `passStores`' loop (CLAUDE.md's two-walk trap: both walks or neither).
  `drawComposite`'s `hasFilters` ignores filter layers when `skipFilters` is set (colour-matched layers still count).
  `sampleRegion` and `primePass` pass the option through unchanged. `stackPlan` (the third walk) gets **no** such
  option: a filter-free picture is taken through the region pass only, never through `holdStack` / `fillBoxFromStack`.
- `renderer/editor/host.js` (app side only): `pictureInput(editor, w, h, opts)`. On tiles: one `sampleRegionSettled`
  pass over the whole picture at `s = min(1, max(w / W, h / H))` with `forRun: true` and the options, drawn into a
  `w x h` canvas (a squash of at most a few pixels, since the DPT sizes keep the aspect to the nearest 14), then RGBA
  bytes; on canvases a plain draw. The shared editor does not call it, so the node's `js/host.js` and the typedef stay
  unchanged until R1-S3 adds `depthInput`.
- A layer clipped to a filter layer is skipped with its base, as the walk already does for a base it did not draw.

**Interface.**

```js
// renderer/editor/inpaint_canvas.js
drawLayersInto(ctx, { forRun = false, controlOnly = false, upTo = null, baseOnly = false, skipFilters = false } = {})
passStores(source, box, scale, { forRun = false, upTo = null, baseOnly = false, controlOnly = false, skipFilters = false } = {})
// drawComposite / sampleRegion / sampleRegionSettled / primePass: opts.skipFilters passed on unchanged
// renderer/editor/host.js
async pictureInput(editor, w, h, { skipFilters = true, background = null } = {}) -> { image: Uint8Array /* w*h*4 RGBA */, width: w, height: h }
```

**Risk.** Forgetting the `passStores` branch only primes chains the pass does not read (slow, not wrong). A filter-free
sample must not land in a cache the screen reads; the sample slots are separate (`_fcacheSample`), and nothing of a
filter layer is drawn.

**Tier and tests (normal).** F5 creates the gate `tools/maps_test.py` (picked up by the `*)` rule; skeleton from
`tools/fill_test.py`) with a first group "picture_input"; F8a adds the map steps and the Node pre-step (the `limit`
gate comes only with F6). `--tiles on` and `off`: a document with an image layer under a strong filter layer (levels
to black). `pictureInput(ed, 512, 341, { skipFilters: true })`
equals the same call with the filter layer hidden, byte for byte, and differs with `skipFilters: false`. `passStores`
with `skipFilters` names no store the pass does not draw (count the stores). At 15000 x 10000 (`new_canvas`), a
784 x 523 input leaves no mirror over 64 MB (`memoryReport`). The `editor` gate's `objectInput` steps are unchanged.

**Sessions.** 0.5 (alone: with F6 it would be 1.5 d, §3.1).

### F6: Filter pass context (one info builder and key for both call sites) and `params.limit`

**Why.** Release 1's Limit (R1-S7) and release 2's depth filters need new inputs at both `applyFilter` call sites (the
maps, the limit stage) and in the cache key. Today the eleven-field info literal is written twice and the key once
inline, so each addition is two edits that can drift. Storing the limit **inside `params`** under the reserved key
`limit`, not as a new layer field, makes almost everything free: params already travel through the undo snapshot,
`getValue` / `setValue`, `applyParams`, the assistant's undo step and its test rows, `layerSummary` and the cache key.
(A layer field would have needed about ten touch points.) Release 2's haze can even start as a fill layer plus a depth
limit.

**Today.** `applyFilter` (`renderer/editor/inpaint_filters.js:1114-1121`) is the single entry for built-in and plugin
filters (GL first, then CPU; `plugins.js:276` wraps plugin `apply`). Its info object is written twice with the same
fields: `filteredCanvas` (`inpaint_canvas.js:12436`, cached under the key at :12408, slots `_fcache` / `_fcacheView` /
`_fcacheSample`) and `bandFilter` (:6753, the band and held-program path that `programFinish` calls at :6848; cache in
`layer._fxCacheSample`). The key is an inline literal holding `layer.params`. Params already travel: the undo snapshot
copies them shallowly (:11464), `getValue` writes them (:18186), `setValue` merges them over the defaults (:18288),
`set_filter` writes them through `applyParams` (`commands.js:1317`, which refuses unknown keys), the assistant pushes a
"filter" step for `set_filter` with params (`policy.js:356`), `layerSummary` reports them. `setFilterType` replaces
params with the defaults (:12306); `setFilterParams` and film's `applyLook` use `Object.assign` (`plugins.js:215`). In
the held program a filter step stays "plain" (the GPU chain goes on) only without mask, opacity, blend, clip or
`over` (`holdStackNow`, about :6655-6665): a pointwise post-stage inside `applyFilter` keeps it plain.

**Change.**

- `inpaint_canvas.js`: `filterInfo(layer, pass)` builds the info, and both call sites use it. `filterKey(...)`
  replaces the literal at :12408 and produces today's string exactly for layers without a limit (F8a appends
  `mapsVersion` for layers that read a map). `setFilterType` keeps `prev.limit`.
- `commands.js` `applyParams`: handles `k === "limit"` before the spec lookup (`normalizeLimit` from F3, always a new
  object, `null` removes it). `filter_types` answers `common: { limit: ... }`.
- `inpaint_filters.js`: export `setLimitStage(fn)`. After the filter, `applyFilter` runs `if (params && params.limit &&
  limitStage) out = limitStage(src, out, params.limit, info, f)`. The stage stays null until R1-S7's
  `inpaint_limit.js` sets it, so this foundation changes no pixel. No FEATURES row yet: R1-S7 adds `filter-limit`
  together with the picture change.
- `docs/PLUGINS.md`: `params.limit` is reserved.

**Interface.**

```js
// renderer/editor/inpaint_canvas.js
/** @typedef {{ scale: number, origin: number[], full: number[], forRun: boolean, cache: object, chain: boolean|"bands" }} FilterPass */
filterInfo(layer, pass) -> { scale, origin, full, stats, seed: layer.id, lut, plate, plateKey, plateMean, plateStd, cache, chain,
                             maps /* F8a: this.maps */ }
filterKey(layer, below, forRun, preview, vp) -> string
// renderer/editor/inpaint_filters.js
export function setLimitStage(fn /* (src, out, limit, info, def) => canvas | GLSurface */)
// renderer/commands.js applyParams, before the spec lookup:
if (k === "limit") { const lim = normalizeLimit(v); const next = { ...l.params }; if (lim) next.limit = lim; else delete next.limit; l.params = next; continue; }
// filter_types -> { filters: [...], common: { limit: { source: ["depth","luma","color"], lo: "0..1", hi: "0..1", fLo: "0..1",
//                   fHi: "0..1", invert: "bool", color: "#rrggbb", tol: "0..100" } } }
// rule (the undo snapshot is shallow): params.limit is always replaced, never mutated in place
```

**Risk.** `filterKey` must keep today's key for layers without a limit, or every cache drops once (harmless; the
composite references prove it). A plugin filter whose `apply()` iterates its params would now see `limit`; none does
today (film reads named keys). Fill layers with a limit need alpha multiplication and a bake in `fillLayerCanvas` /
`fillLayerRows` (:12321-12335): R1-S7 does that for a depth source only.

**Tier and tests (normal).** New gate `tools/limit_test.py`, `--tiles on`, `--offline`: `set_filter {params: {limit:
{...}}}` then `list_layers` shows it; undo removes it in one step and redo restores it; `setFilterType` keeps it; a
`.scumble` save and open keep it, and so does an autosave restore; a test hook records the last info object per call
site, and `filteredCanvas` and `bandFilter` agree apart from `cache` and `chain`; F3's `WEIGHTS_GLSL` ramp check.
`composite` on `--tiles on` and `off` with references byte-identical. `commands_test`: a bad limit gives "limit.source
must be ...". `lint`, `types`.

**Sessions.** 1.

### F7: GL infrastructure (a scratch unit off the sampler range, static sampler cache, packed u16 sampling)

**Why.** From release 1 on every new GPU stage needs two to four samplers and some need a big static texture: R1-S7's
limit stage takes the filter input and the map (and from R2-S5 the guide), release 2's dehaze takes four, release 3's
polygon points stay at two only because of this layout. Today a second sampler on unit 6 reads the render target above
about 33 MP, and a third on unit 7 loses its binding whenever a surface is created, so such shaders break only
sometimes. With the fix the stages simply use plugin units 5, 6, 7 and on (the readers' idea of special units 8 and 9
is not needed). The static cache stops re-uploading a 22 MB map for every band and frame; the RG8 view needs no float
conversion and no second copy of a map. It also fixes the known film.points bug.

**Today.** `inpaint_filters_gl.js`: `renderToTexture` binds its target on TEXTURE6 (:202; the tiled path above the
drawing buffer); `createSurface` and `surfaceFromBytes` bind on TEXTURE7 (:325, :482). Plugin and `runShader` samplers
take units 5, 6, 7 ... (`PLUGIN_TEX_UNIT` :938, assignment :997). `uploadSampler` (:1006-1024) re-uploads every value
on every run, knows only RGBA8 and RGBA32F, and allows `linear` only for 8-bit data (RGBA32F is always NEAREST). The
cached-texture pattern exists once: `lutTextures`, a WeakMap (:621, :846). Built-in units are 0-4 (:683-687).

**Change.**

- `context()` reads `MAX_TEXTURE_IMAGE_UNITS` (at least 16 in WebGL2) and sets `G.scratchUnit = units - 1`. Lines :202,
  :325 and :482 bind `gl.TEXTURE0 + g.scratchUnit`. `pluginProgram` throws "too many samplers" when `PLUGIN_TEX_UNIT +
  n >= scratchUnit`; the CPU path then runs, as for any GL error.
- `uploadSampler`: a value with `static: true` is uploaded once per (data object, key, context gen) through a WeakMap
  like `lutTextures`, and only bound afterwards. `channels: 2` with a Uint8Array (the bytes of a little-endian
  Uint16Array) uploads as RG8; `channels: 1` with a Float32Array as R32F; both NEAREST, read with `texelFetch`. Both
  UNPACK switches are set before every typed-array upload (the premultiply trap).
- Export `SAMPLE_GLSL` (`u16At`, `u16Bilinear`; JS twin: F3's `u16Bilinear`). Add a `G.uploads` counter and a
  `glTestLimits({ maxDraw })` switch so tests can force `renderTiled` at small sizes.

**Interface.**

```js
// sampler values for runShader and plugin glsl samplers:
// canvas | ImageData | GLSurface | { data: Uint8Array|Uint8ClampedArray|Float32Array, width, height, channels?: 1|2|4,
//                                   linear?: boolean /* 8-bit RGBA only */, static?: boolean, key?: string }
export const SAMPLE_GLSL = `float u16At(sampler2D t, ivec2 p) { vec2 v = texelFetch(t, clamp(p, ivec2(0), textureSize(t, 0) - 1), 0).rg * 255.0; return (v.x + 256.0 * v.y) / 65535.0; }
float u16Bilinear(sampler2D t, vec2 px) { vec2 q = px - 0.5; ivec2 i = ivec2(floor(q)); vec2 f = q - floor(q); return mix(mix(u16At(t, i), u16At(t, i + ivec2(1, 0)), f.x), mix(u16At(t, i + ivec2(0, 1)), u16At(t, i + ivec2(1, 1)), f.x), f.y); }`;
export function glTestLimits(limits /* { maxDraw?: number } | null */)   // tests only
// G.scratchUnit: number; G.uploads: number (incremented per texImage2D of a sampler)
```

**Risk.** A driver with exactly 16 units leaves plugin samplers 5-14, which is plenty. RG8 from a SharedArrayBuffer
view: Electron's Chromium takes SAB views in `texImage2D` / `texSubImage2D` (CLAUDE.md). A static value changed in
place without a new key would show stale: document maps are immutable (F8), and the rule goes into PLUGINS.md.
Big-endian is not a target.

**Tier and tests (normal).** The `film` gate, `--tiles on` and `off`, `--offline`:

- New step `points_structure_above_the_drawing_buffer`: `glTestLimits({ maxDraw: 1e6 })` forces `renderTiled`; a
  film.points layer with structure on a 1600 x 1200 picture, GPU against `applyFilter(..., { cpu: true })` within
  `gpu_vs_cpu`'s tolerance (max <= 4, over2 <= 0.1 %). Before the fix it reads its own target.
- An ad-hoc `runShader` with three constant-colour samplers, run after `glReleasePool()` so that `createSurface`
  happens between bind and draw, returns their sum exactly.
- The same static value twice adds 1 to `G.uploads`; a new key adds 1 more; a `WEBGL_lose_context` round re-uploads.
- `SAMPLE_GLSL` against F3's `u16Bilinear` on a 5 x 3 map at 1,000 random points, within 1 level after 8-bit
  quantisation.
- `composite` on both backends, unchanged.

**Sessions.** 1.

### F8: Document maps (`ed.maps`: immutable, geometry-following, undoable, persisted)

**Why.** The depth map is the first document-level derived picture. The same store later takes a depth map made from a
grey layer (R2-S11), release 2's guide, edits and detail passes as new versions of the same kind, and other kinds (a
sky mask). Built and tested with a synthetic ramp, without the model, it covers the whole full-tier part of the
research's "where the map lives": the `.scumble` format, autosave, geometry, undo. R1-S3 then only produces the map
(model call, guided upsample, `setMap`, the freshness threshold on the user's pictures), and no later map kind repeats
the format work.

**Design decisions (answering the readers).**

- **Follow the geometry by an `xf`, not by an input hash.** A map carries `xf` (the map's unit square to document
  pixels), composed in `mapExtras` like a history entry's; it is never resampled on a turn, and undo maps back through
  `restoreGeometry` for free. A plain input hash would call every turned map stale.
- **Freshness by a fingerprint in the map's frame:** a 64 x 64 grey picture of the model input, compared with the
  current picture drawn through the map's `xf`; threshold measured on the user's pictures (R1-S3, R1-S11).
- **Persist the working map**, not only the raw one (R1-S3 decides the size; release 2's edits change the working map,
  so it must be stored). The raw model output lives in memory only.
- **u16 packed into R (high byte) and G (low byte) of an opaque RGBA8 PNG**: `readPng` keeps only the high byte of a
  16-bit PNG (`inpaint_png.js:201`), while a canvas `getImageData` at alpha 255 and `readPng`'s fast path are exact.
- **Weight outside the map's footprint** (after an extend or a crop past the map): edge clamp, the same rule in the
  shader, the CPU twins and the workers (`sampleMap`, `u16Bilinear`).

**Today.** Nothing document-level holds a derived picture. `ed.objects` (`inpaint_canvas.js:1951`; dropped in
`dropCompositeCaches` :4680-4684) is a cache upsampled to a full-resolution Uint16Array: not the model. The persistence
pattern is `layer.lut` / `layer.plate`: `uploadCanvas(canvas, prefix)` (`inpaint_upload.js:42`, hash-named,
forwarded to a connected ComfyUI), then `loadImageEl(viewUrl(ref))` in `setValue` (:18273-18294). Geometry: saved
selections and history entries carry an `xf` `[a,b,c,d,e,f]` composed in `mapExtras(A, kind)` (:4583) and mapped back
by `restoreGeometry` (:4642); `followGeometry` (:4663) emits the plugins' event; `xfMul` / `xfInv` are in
`inpaint_resample.js:80-107`. A new picture resets document state at :15575 and :15628 (beside `savedSelections = []`).

**Interface.**

```js
// renderer/editor/inpaint_maps.js (new, in FILES; pure apart from mapFromJSON's loader)
/** @typedef {{ kind: string, w: number, h: number, data: Uint16Array /* never written after makeMap */,
 *   xf: number[] /* the map's unit square -> document px, as a history entry's xf; a fresh whole-picture map: [W, 0, 0, H, 0, 0] */,
 *   meta: object /* the kind's own; depth: { model, label, lo, hi, fp, time, provider, seconds, input, guide } */,
 *   ref: {filename, subfolder, type} | null, version: number, dataVersion: number }} DocMap */
export function makeMap(kind, w, h, data, xf, meta) -> DocMap   // copies data onto a SharedArrayBuffer when crossOriginIsolated
                                                                // (workers read it without a copy); version = dataVersion = ++seq
export function packRG16(map) -> HTMLCanvasElement   // opaque RGBA8: R = v >> 8, G = v & 255, B = 0, A = 255
export function unpackRG16(rgba, w, h) -> Uint16Array
export function rg8View(map) -> { data: Uint8Array /* map.data's bytes, little-endian: R low, G high */, width, height, channels: 2,
                                  static: true, key: `${map.kind}:${map.dataVersion}` }   // F7's sampler value
export function mapToJSON(map) -> { ref, w, h, xf, enc: "u16rg", meta }
export async function mapFromJSON(kind, j, loadImage /* (ref) => Promise<HTMLImageElement> */) -> DocMap | null
export function passToMap(map, scale) -> number[6]   // a pass's input pixel (origin included) at `scale` -> map pixel:
                                                     // S(w, h) * xfInv(xf) * S(1 / scale); the same matrix in GLSL (u_m0 vec4, u_m1 vec2),
                                                     // the CPU twins and the workers
export function sampleMap(map, docX, docY) -> 0..1   // bilinear, edge clamp
export function fingerprint(rgba, w, h) -> string    // 64 x 64 grey, box-averaged, base64 (4,096 bytes)
export function fingerprintDiff(a, b) -> number      // mean |a - b|, 0..255
// renderer/editor/inpaint_canvas.js
this.maps /* { [kind]: DocMap } */; this.mapsVersion /* number */; this.geometrySeq /* number, ++ in followGeometry */
geometryToken() -> number                             // this.geometrySeq
async setMap(kind, map /* DocMap | null */, { label = "Depth map", token = null } = {}) -> boolean
                                                      // false when token !== geometryToken() or the tab closed meanwhile
async mapStale(kind) -> { stale: boolean, diff: number }   // F5's pictureInput drawn through the map's xf into 64 x 64 against meta.fp; never recomputes
// getValue: maps: { depth: { ref, w, h, xf, enc: "u16rg", meta } } (omitted when empty)
```

`passToMap` in GLSL: `u_m0 = vec4(a, c, b, d)`, `u_m1 = vec2(e, f)`; with `pp = pictureUv(uv) * u_pictureSize`
(= `u_pictureOrigin + uv * u_size`, the pass pixel with its origin; `inpaint_filters_gl.js:972`), the map pixel is
`vec2(dot(u_m0.xy, pp) + u_m1.x, dot(u_m0.zw, pp) + u_m1.y)`. CPU twins sample at `origin + (x + 0.5, y + 0.5)`.

#### F8a: the module, the store, geometry, undo (1 session)

- `inpaint_maps.js` complete (all functions above; `mapFromJSON` and `packRG16` are used from F8b on).
- `inpaint_canvas.js`: `this.maps = {}`, `this.mapsVersion = 0`, `this.geometrySeq = 0` in the constructor (about
  :1951). `setMap` without persistence yet (`ref` stays null): push undo `{ kind: "maps", map: kind, prev }`, commit,
  bump `mapsVersion`, `markFilterChanged` every filter layer that reads the map (until R2-S12's `mapsOf`: every layer
  whose `params.limit.source` is `"depth"`). `mapExtras` composes `A` into every map's `xf` and bumps `mapsVersion`;
  `followGeometry` increments `geometrySeq`. `snapshot`, `applySnapshot` and `UNDO_LABELS` learn `maps`
  (:11404-11470, :11628+; `releaseSnapshot` :11224 has nothing to free). The resets at :15575 and :15628 clear
  `maps`. `memoryReport` (:18480) counts map bytes. `filterInfo` (F6) passes `maps`; `filterKey` appends `mapsVersion`
  for a layer with `params.limit.source === "depth"`.
- Tests: new `tools/maps_test.js` (plain Node): pack / unpack round trip of 65,536 values; `passToMap` against a
  direct composition for scale 1 and 0.25 under a 90° xf and a crop offset; `sampleMap` at corners (exact), edges
  (clamp) and centres (mean); `fingerprint` of a constant picture is constant, `fingerprintDiff` of two equal is 0.
  The `maps` gate (`tools/maps_test.py`, created by F5) gains a Node pre-step (`node tools/maps_test.js`, as
  `help_test.py:52-57` runs `manual_test.js`) and a "maps" group, `--offline`, `--tiles on` and `off` (F8a's undo and
  geometry are data paths of a full-tier foundation; the mutation round of F8b covers F8a's lines), with a synthetic ramp
  `setMap("depth", makeMap(...))` and no model: `rotate_canvas 90` and undo (xf turns and turns back, data untouched,
  `sampleMap` at a document point follows the turn); crop, then extend (points outside the footprint read the edge
  value); `setMap`, undo and redo swap the object; `load_image` clears maps. `lint`, `types`.

#### F8b: persistence and staleness (1 session, full tier)

- `setMap` uploads first: `uploadCanvas(packRG16(map), `n${node.id}_depth`)` (hash-named, written once, never
  overwritten), with the token check before the commit.
- `getValue` writes `maps` (refs and numbers only); `setValue` loads it with `mapFromJSON` (`readPng`'s exact path or
  `<img>` plus `getImageData`); a missing file drops that map with a status note.
- `host.js:63`: `STATE_KEYS` gets `"maps"`.
- `docfile.js`: FEATURES row `maps`, `version: 2` (F1).
- `mapStale` and the fingerprint check.
- `docs/DOCUMENTS.md` §4: the field.
- Tests (full tier), the `maps` gate on `--tiles on` and `off`, `--offline`: a `.scumble` save and open returns the
  map's bytes exactly (unpack equals the original) and its xf; so does an autosave restore (the `quit` gate's restart
  pattern); a removed map's file drops out of `referencedFileKeys` on the next save; a document with a map writes
  version 2 and minReader 1, one without writes 1 / 1. Mutation round: skip `mapExtras`' map line; drop `"maps"` from
  `STATE_KEYS`; swap R and G in `packRG16` (each must fail). `docperf:15000x10000,--map=4096x2731` within 10 % of
  `docperf:15000x10000`: `tools/document_perf.py` gets a `--map=<w>x<h>` option (a synthetic ramp through `setMap`
  before the save) and `run_gates.sh`'s `docperf:*` (:126) the comma split of `exportperf:*` (:119). Also the
  `document` and `quit` gates.

**Risk.** Undo holds maps by reference, so `data` must never be written after `makeMap`; a recompute or an edit makes
a new map. The `xf` is changed in place on the live map only, which is right because a step is undone only when the
document is back in that step's frame (traced: compute, turn, recompute, undo, undo). Uploads are forwarded to a
connected ComfyUI: `--offline` only. A 4096 x 2731 packed PNG costs a few MB per recompute and old ones stay until
mirror pruning. The freshness threshold needs the user's pictures.

### F9: Range bar control and whole-picture histograms (built as R1-S4)

**Why.** R1-S6's Select by range panel and R1-S8's Limit row use the same control. With a shared module the two UIs
are mostly wiring, and both read the same histograms (`belowStats` for luma and colour, the map for depth), so every
pass shows the same numbers. Curves can later take its histogram from the same place.

**Today.** No two-handle control exists. The filter row's custom-param contract is `buildCurvesControl`
(`inpaint_curves.js:95`), with begin / preview / commit / stop from `buildFilterControls` (`inpaint_canvas.js`
~15330-15340); canvas-drawn chrome reads `THEME` (`inpaint_theme.js:1-15`). `colourStats` (`inpaint_filters.js:617-641`)
builds three 256-bin histograms and drops them. `belowStats` (`inpaint_canvas.js:12455`) caches `colourStats` of a
256 px pass of the layers below a filter layer, per composite version, for `wholeStats` filters only. Curves reads
`layer._fxCache.histogram` (`inpaint_filters.js:827`), which only the full-flatten slot writes.

**Change.**

- `inpaint_filters.js`: `colourStats` also returns `hist: { r, g, b, luma }` (Float64Array(256) each, alpha-weighted,
  luma by F3's `LUMA`). No consumer changes.
- `inpaint_canvas.js`: `belowHistogram(layer, forRun)` returns `belowStats(...).hist` for any filter layer on demand;
  `mapHistogram(kind)` returns a map's 256 bins, cached by its `dataVersion`; `pictureHistogram(forRun = true)` returns
  `{ r, g, b, luma }` of a 256 px sampled pass of the whole stack (`belowStats`' pattern with `upTo =
  layers.length`), cached per `compositeVersion` in slot `_picStats`. Both slots also keep their sample's RGBA bytes
  (`bytes`, at most 256 x 256 x 4) for the colour-similarity histograms of R1-S6 (`pictureSample()`) and R1-S8
  (`belowSample(layer)`); `colourStats` itself drops nothing it does not drop today.
- `mapHistogram` needs F8a's `this.maps` (R1-S4 comes after F8 in every order; built alone before F8 it returns null).
- New `renderer/editor/inpaint_rangebar.js` (FILES): the control plus its pure geometry for Node tests. Its CSS goes
  in the editor's style string on `--sc-*` tokens with fallbacks. The depth gradient runs light (near) to dark (far);
  the user judges it in the look.
- Moving curves to `belowHistogram` is a later one-line step, after a look.

**Interface.**

```js
// renderer/editor/inpaint_rangebar.js
/** @typedef {{ lo: number, hi: number, fLo: number, fHi: number, invert: boolean }} Range */
export function buildRangeBar(range, { gradient /* "luma" | "depth" | "color" | ((t) => cssColour) */,
    histogram /* () => Float64Array(256) | null, read once per begin() */, begin, preview /* (range) */, commit /* (range) */, stop,
    pick /* optional () => Promise<number|null>: the eyedropper's value 0..1 */,
    hover /* optional (on: boolean): Alt held, show the weight on the canvas */, title }) -> { el: HTMLElement, set(range), refresh() }
export function hitTest(range, x01, tol01) -> "lo" | "hi" | "fLo" | "fHi" | "box" | null
export function dragTo(range, handle, x01, startRange, startX01) -> Range   // lo <= hi, feathers >= 0, a box drag keeps hi - lo
// renderer/editor/inpaint_filters.js
colourStats(src) -> { mean, lo, hi, hist: { r, g, b, luma } }
// renderer/editor/inpaint_canvas.js
belowHistogram(layer, forRun = false) -> { r, g, b, luma } | null;  belowSample(layer, forRun = false) -> { bytes, w, h } | null
pictureHistogram(forRun = true) -> { r, g, b, luma };  pictureSample(forRun = true) -> { bytes, w, h }   // the 256 px samples
mapHistogram(kind) -> Float64Array(256) | null
```

**Risk.** Skins: every new `var(--sc-*)` needs a contract token and a fallback (`skins_test` rules 1-2). A histogram
read per drag frame would be a sampled pass per frame: read it once per `begin()`. The user judges the looks; no
screenshot gate.

**Tier and tests (light).** `node tools/rangebar_test.js`: hit order (a feather handle wins over the box edge within
tol); `dragTo` keeps lo <= hi and the width on a box drag; feathers never go negative. `colourStats`' hist sums to the
alpha-weighted pixel count. Gates `skins`, `lint`, `types`; one look. No manual text (R1-S6 adds it).

**Sessions.** 1.

### F10: Plugin API 4 (wholeStats and colour params for plugin filters, hidden params, cancelFilterParams)

Built as R2-S1, or as R3-S1 when release 3 comes first; whichever comes second skips it.

**Why.** Release 2's dehaze and haze need a whole-picture value that is the same in every band (built in, they need
`wholeStats` as a function; as plugins today they would silently get `info.stats = null` and show band seams).
Release 3's HSL and grading keep flat parameters that MCP can set but the row draws through one custom control
(`hidden`). R3-S7's hover preview needs a preview that can be taken back. R3-S9's effects plugin may need colour
parameters. It also closes a promise `docs/PLUGINS.md:275` and CHANGELOG 0.1.17 break today.

**Today.** `renderer/plugins.js:18` is `API_VERSION` 3. `registerFilter` (:257-295) copies only label, params, apply,
plugin, chain, control and reach into `FILTERS[id]`. Plugin param types are number, select, bool and custom
(:262-274): no `color` (built-ins have it since 2026-09-30; validation at `commands.js:1329`) and no `hidden`.
`Document.setFilterParams` with `preview` takes a pending undo snapshot (`plugins.js:210-221`) that cannot be
cancelled. `belowStats` only calls `colourStats`.

**Change.**

- `plugins.js`: `API_VERSION = 4` with a comment. `registerFilter` copies `wholeStats` (true or a function) and
  `wholeStatsSize`, accepts param type `color` (default validated `#rrggbb`, lower case) and the flag `hidden`.
- `InpaintEditor.cancelFilterParams(layer)`: when `layer._undoPending` exists, `layer.params = {
  ...layer._undoPending.params }` (a new object), `layer._undoPending = null`, `this.filterPreview = null`,
  `markFilterChanged(layer, { soon: true })`, `draw()`. No undo step and no `changed` event, so the Film looks panel
  does not re-render. `Document.cancelFilterParams(layerKey)` calls it.
- `inpaint_canvas.js` `belowStats(layer, forRun)` (:12455): `const def = FILTERS[layer.filter]; const n =
  Math.max(64, Math.min(1024, def.wholeStatsSize || 256)); const s = Math.min(1, n / Math.max(W, H));`. The slot
  version is `${compositeVersion}:${reads a map ? mapsVersion : 0}:${n}` ("reads a map" is R2-S12's `mapsOf`; until
  then 0). For a function: `entry.stats = def.wholeStats(small, { width: W, height: H }, { maps: this.maps, sampleMap
  })`; a throw gives null, `console.warn` and the plugin report. `wholeStats === true` keeps `colourStats(small)` at
  256 px exactly as today (normalise's bytes stay).
- `buildFilterControls` (:15327-15446) skips `hidden` params; `filter_types` reports `hidden: true`; `applyParams`
  still clamps them.
- `docs/PLUGINS.md`: the filter section and an API 4 note: `wholeStats(small, size, ctx)`, where `ctx.maps.depth` is
  read only (`{ w, h, data, xf, meta }`, never written) and `ctx.sampleMap(map, docX, docY) -> 0..1`; `wholeStatsSize`
  64-1024, default 256; the function runs on the main thread once per composite version. CHANGELOG Unreleased:
  "Plugin filters can take statistics of the whole picture below them, at a size they choose, and read the document's
  depth map (plugin API 4)."

The `wholeStatsSize` and `ctx` parts are the release 2 extension the planners added to the readers' F10 (G7). They are
cheap and harmless; built with the rest unless the user says no. When release 3 builds F10 without them, R2-S1 adds
them.

**Interface.**

```js
// scumble.filters.register(def):
//   def.wholeStats?: true | ((small: HTMLCanvasElement /* <= wholeStatsSize px of the picture below */,
//                             size: { width: number, height: number }, ctx: { maps, sampleMap }) => any)   -> info.stats in every pass
//   def.wholeStatsSize?: number (64..1024, default 256)
//   def.params[i]: { key, label, type: "number"|"select"|"bool"|"custom"|"color", hidden?: boolean, ... }
// Document.cancelFilterParams(layerKey) -> layerSummary   (only while a preview is pending; otherwise a no-op)
// InpaintEditor.cancelFilterParams(layer) -> boolean
```

**Risk.** A `wholeStats` function runs on the main thread once per composite version per layer, so it must stay on the
small canvas it gets. At 768-1024 px on tiles the sampled pass may read levels that are not primed yet: R2-S14 measures
whether the stats are byte-stable between a freshly opened and a settled document. Hidden params must still clamp
(`applyParams` sees them in the spec). Plugin ids are permanent (R3-D1).

**Tier and tests (normal).** `commands_test`, with a test plugin like posterize (:159): a filter whose `wholeStats` is
a function is called once per composite version, and an export in bands equals the whole flatten (no seams, export
gate tolerance); with `wholeStatsSize: 512` on a 2000 x 1000 document it gets `info.stats.w === 512` in the view pass
and every band; after a `setMap` with a synthetic map it is called again only if the filter reads maps. A `color` param
refuses "red" and stores "#ff0000". A `hidden` param is missing from the row's controls and present in `filter_types`;
a built-in test filter with one hidden number param clamps through `set_filter`. `cancelFilterParams`: preview then
cancel leaves params, the undo length and `_undoPending` as before; a commit after a cancel pushes one step whose old
state is the state before the preview. Gates `film` (plugin filters unchanged), `lint`, `types`, `help`.

**Sessions.** 0.5 (plus 0.5 if the extension comes as its own step).

### F11: Blend-mode registry (`blend_modes.js`) driving every table, with one numbering (built as R4-S1)

**Why.** Release 4 adds 16 modes (17 with dissolve). Today one mode touches 24 code places in 11 files plus 9 test lists
(linear light needed 31 files). With the registry each new mode is one row, a kernel arm (Rust and the JS twin) and a
GLSL branch; the UI select, the `set_layer` enum, `EMULATED_BLENDS`, the op table, the PSD / ORA writers (written twice
today) and reader, and the docfile reader table (cross-checked) all follow, and the export and layered tests loop over
the rows. It also closes three silent wrong-picture paths: an unknown `globalCompositeOperation` is ignored by Canvas
(the layer draws in the previous layer's mode), `BLEND_INDEX[x] || 0` draws normal in GL, and an unknown op is drawn as
COPY by the kernel.

**Today.** `BLEND_MODES` (`inpaint_canvas.js:305`, re-exported at :18660), `EMULATED_BLENDS` (:307), the `set_layer`
enum (`commands.js:18`, :843, :851). GL `BLEND_INDEX` (`inpaint_compositor.js:29-32`) numbers normal 0 .. linear light
9, unlike the kernel's ops 5..13 (`px/kernels_js.js` `OPS` :15-31, Rust `composite.rs:44-57`); :845 and :1110 use
`BLEND_INDEX[x] || 0`. The JS dispatch hard-codes `op >= 5 && op <= 13` (`kernels_js.js:390`) and sends any other op to
`copyOp`. The PSD / ORA maps are written twice (`inpaint_export.js:22-23`, `inpaint_bands.js:231-232`) and read once
(`inpaint_layered.js:28-38`). `docfile.js` has `READER_2_BLENDS`. Canvas 2D sites assign `layer.blend` directly
(`blendEmulated`'s native branch ~12104, `applyFilterLayer` ~12567, `mergeDownNow` ~13362, `mergeInto` ~13470,
`drawLayersInto` ~16188). `glCompositeUsable` (:15964-15976) has no blend guard. Tests list modes by hand
(`composite_test.py:66`, `export_test.py:924`, `layered_test.js:594-595`, `px_test.js:386/428/1398`).

**Change.**

1. **`renderer/editor/blend_modes.js`** (new, `// @ts-check`, no imports, nothing from the DOM: workers import it; in
   FILES). `BLENDS` frozen, the ten rows in **today's order** (normal, multiply, screen, overlay, darken, lighten,
   soft-light, hard-light, linear-light, difference): normal op 0 `source-over` `norm` `svg:src-over`; multiply 5
   `mul `; screen 6 `scrn`; overlay 7 `over`; darken 8 `dark`; lighten 9 `lite`; soft-light 10 `sLit`; hard-light 11
   `hLit`; linear-light 13, canvas `null`, `lLit`, `scumble:linear-light`, oraRead `["krita:linear_light", "krita:linear
   light"]`, reader 2; difference 12 `diff`. Native rows use `canvas` = their own id and ORA `svg:<id>`. Groups:
   normal; darken and multiply → darken; lighten and screen → lighten; overlay, soft, hard and linear light →
   contrast; difference → inversion. Derived exports below.
2. **`inpaint_canvas.js`**: import from `./blend_modes.js` and keep `BLEND_MODES` in the export list (`commands.js:18`
   imports it from here). `canvasOp` at the five Canvas 2D sites (in `drawLayersInto` as `controlOnly ? "source-over" :
   canvasOp(layer.blend)`). `glCompositeUsable`: `const b = l.blend || "normal"; if (b !== "normal" && !(b in
   BLEND_OPS)) return false;`. `normalBlend` in `addLayer` (~14731), in `setValue`'s three layer builders (~18287,
   ~18301, ~18323) and in the PSD / ORA import `addLayer` calls (~13069, ~14669).
3. **`inpaint_compositor.js`**: delete `BLEND_INDEX` (no other importer) and import `BLEND_OPS`, so `u_mode` = the
   kernel op; :845 and :1110 use `BLEND_OPS[blend] || 0` (the guard sits upstream); renumber `blend1`'s branches
   1→5 (multiply), 2→6, 3→7, 4→8, 5→9, 6→10, 7→11, 8→12 (difference), 9→13 (linear light). Same maths, same bytes.
4. **`px/kernels_js.js`**: `OPS = Object.freeze({ "source-over": 0, "destination-out": 1, "source-atop": 2,
   "destination-in": 3, copy: 4, ...BLEND_OPS })`, importing `../blend_modes.js`; the dispatch at :390 becomes `op >= 5
   && op <= LAST_BLEND`.
5. **`inpaint_export.js:22-23`, `inpaint_bands.js:231-232`**: import `PSD_BLEND`, `ORA_BLEND`; delete the local maps;
   keep the `|| "norm"` / `|| "svg:src-over"` fallbacks. **`inpaint_layered.js:28-38`**: import `PSD_BLENDS`,
   `ORA_BLENDS`; `ADJUSTMENTS` stays local (its `hue ` is an additional-info key, another namespace than the blend key
   `hue `).
6. **`electron/main/docfile.js`** (CommonJS): `const READER_OF_BLEND = { "linear-light": 2 };`, commented "kept equal to
   renderer/editor/blend_modes.js by tools/document_test.js"; F1's FEATURES rows are generated from it (`{ id: "blend:"
   + id, reader, sample: { layers: [{ blend: id }] }, test }`). Without F1: `readerFor = max(1, ...layers.map(l =>
   READER_OF_BLEND[l.blend] || 1))` and `READER_VERSION = Math.max(2, ...Object.values(READER_OF_BLEND))`. Export
   `READER_OF_BLEND`.
7. **Tests.** New `tools/blend_table_test.js` (plain Node): every row round-trips id→psd→id and id→ora→id; PSD keys
   are four characters and unique; ids unique; `BLEND_MODES` equals today's list in order; it parses `composite.rs`'
   `pub const X: u8 = N;` and the compositor's `mode == N` branches and asserts every row with op >= 5 has both (rows ⊆
   kernel ∩ shader) and that Rust's last op >= the largest row op (so R4-S6 may put the kernel ahead of the rows);
   `canvasOp("nonsense") === "source-over"`, `normalBlend("x") === "normal"`. `export_test.py:924` loops
   `(await import("./editor/blend_modes.js")).BLEND_MODES.filter(m => m !== "normal")`. `layered_test.js:594-595`
   builds its lists from `BLENDS`, adds an ORA round trip of every row, and moves its unknown-key case from `vLit` to
   `xxxx` (**`vLit` becomes vivid light in R4-S5**). `px_test.js` derives `BLEND_NAMES` from `BLENDS` by op.
   `document_test.js` `await import()`s the ESM table and deep-equals it with `doc.READER_OF_BLEND`. `composite_test.py`
   gets a step `every_mode_is_native_or_emulated` (for each row, the `canvas` value assigned to a 2D context reads back
   unchanged, or the id is in `EMULATED_BLENDS`); **its ten-mode document list stays literal**, because the references
   depend on it.

**Interface.**

```js
// renderer/editor/blend_modes.js
/** @typedef {{ id: string, label: string, group: "normal"|"darken"|"lighten"|"contrast"|"inversion"|"component",
 *              op: number, canvas: string|null /* native gco, null = emulated */, psd: string /* 4 chars */,
 *              ora: string, oraRead: string[], reader: number }} BlendRow */
export const BLENDS = Object.freeze([ /* the layer row's order */ ]);
export const BLEND_MODES /* ids in row order */, EMULATED_BLENDS /* Set: canvas === null */,
             BLEND_OPS /* { id: op } for op > 0 */, LAST_BLEND /* max op */, BLEND_GROUPS /* [{ id, label }] */;
export const PSD_BLEND, PSD_BLENDS, ORA_BLEND, ORA_BLENDS /* oraRead included */, READER_OF_BLEND /* { id: reader } for reader > 1 */;
export function canvasOp(id) -> string    // a valid gco or "source-over", never an unknown string
export function normalBlend(id) -> string // id when known, else "normal" (with a console.warn)
export function blendLabel(id) -> string
```

**Risk.** Renumbering the GL `u_mode` is the one real shader edit; a missed branch draws one mode as another, and the
composite references catch it only on the path that draws it, so run both backends. New modes default to `canvas: null`
(emulated everywhere, R4-D4): the canvas backend uses the same kernel or shader as tiles. `node --check` reports nothing
for ES modules; an import error shows only in the app, so run an app gate early. `px/kernels_js.js` now imports
`../blend_modes.js`: the worker module graph and the node copy need it (`nodecopy`).

**Tier and tests (full).** `composite --strict` on `--tiles on` and `off`, `tools/refs/composite_*.png`
byte-identical; `export`, `layered`, `document`, `clip`, `fill`, `groups`, `pixels`, `editor`, `commands`, `mcp`,
`nodecopy`, `node` (`build_node.py --check`), `lint`, `types`, all `--offline`; `node tools/px_test.js`, `node
tools/blend_table_test.js`. Mutation round on a copy of the tree (scratchpad copy, `node_modules` as a junction, PASS on
the untouched copy first, a fresh instance per mutant): drop multiply's `psd` (layered fails); swap GLSL branch numbers
8 and 9 (composite fails on the view, tiles); make `canvasOp` pass an emulated id through (composite's new step fails);
delete docfile's linear-light entry (document fails). Then `git diff --stat`. Docs: `DOCUMENTS.md` §8 (blend readers
come from `READER_OF_BLEND`). Optional CHANGELOG line: "A layer in a blend mode this version does not know draws as
normal everywhere."

**Sessions.** 1.

### F12: Per-pixel blend structure in the kernel and its twin, one emulated-blend shader, safe unknown ops (built as R4-S2)

**Why.** Tier C (hue, saturation, colour, luminosity, darker and lighter colour) needs the whole pixel, and tier B's
division modes need explicit scalar-only routing. If the restructure lands first with no new op, the existing
references prove byte identity, and each tier session adds only formulas and their exhaustive tests. The generic shader
removes the hard-coded linear-light branch, so every emulated mode gets the GPU path on screen (without it a new
emulated mode would read the view canvas back on the CPU every frame: the acceleration-latch trap). An unknown op
composited as source-over instead of COPY (or DIFFERENCE in `px.wasm`) removes the worst silent failure.

**Today.** `crates/px/src/composite.rs`: `apply()` (:107-119) sends `MULTIPLY..=LINEAR_LIGHT` to `simd::blend` plus
`blend_from`; any other op goes to `scalar_layer`, whose `_` arm is COPY (:301-307). `blend_of` (:132-151) and
`blend_from` (:154-166) end in `_ => DIFFERENCE`. `scalar_blend` (:169-220) calls `blend_of` per channel inside two
branches (`da == 255`, or translucent with `cb` unpremultiplied). The SIMD `blend_pixel` (:426-437) also falls back to
DIFFERENCE, and only SOFT_LIGHT is excluded (:451). The JS twin's `blendOf` / `blendOp` (`kernels_js.js:559-604`) mirror
this, with `default:` difference. The compositor's `blend1` reads the global `u_mode` (`inpaint_compositor.js:61-72`).
The emulated screen path is `LINEAR_LIGHT_SHADER` / `_CLIP` (`inpaint_canvas.js:314-332`), gated by `mode ===
"linear-light"` in `blendEmulated` (:12109). `PX_ABI` 14 (`px.js:14`, `lib.rs:42-47`).

**Measure first, before any edit:** in `px_test.js`, a SHA-256 of `compositeTile` outputs over the exhaustive opaque
(b, s) pairs plus 2^16 random translucent cases for ops 0-13 on the twin, `px.wasm` and `px_scalar.wasm`; and
`px_test`'s megapixel timing row for ops 5, 7, 10 and 13. Write both into the session's notes.

**Change.**

1. `composite.rs`: `pub const LAST_BLEND: u8 = LINEAR_LIGHT;`, `const SIMD_BLENDS: [u8; 8] = [MULTIPLY, SCREEN,
   OVERLAY, DARKEN, LIGHTEN, HARD_LIGHT, DIFFERENCE, LINEAR_LIGHT];`, `#[inline(always)] fn blend3<const OP: u8>(b:
   [u32; 3], s: [u32; 3]) -> [u32; 3]` (separable ops map `blend_of` over the channels). `scalar_blend` computes the
   straight backdrop `cb[3]` once (`d[c]` when `da == 255`, else today's unpremultiply), then `let bl =
   blend3::<OP>(cb, s3)`, then the existing per-channel formulas with `bl[c]`: the same bytes. `blend_from` and
   `blend_of` get an explicit DIFFERENCE arm. `apply()`: an op above `LAST_BLEND` composites as SOURCE_OVER through
   `scalar_layer`, never COPY. `simd::blend`: `if !SIMD_BLENDS.contains(&op) { return 0; }` (replaces the SOFT_LIGHT
   special case at :451).
2. `lib.rs`: comments only. **No ABI bump** (no new op, no new signature). Rebuild with `python tools/build_px.py`,
   then `--check` (a comment edit in `.rs` changes the wasm bytes too).
3. `kernels_js.js`: `blend3(op, b0, b1, b2, s0, s1, s2, out /* Int32Array(3) */)` in the same order of operations;
   `blendOp` restructured the same way in the `da === 255` and the translucent branch; the dispatch sends `op >
   LAST_BLEND` to `over()`.
4. `inpaint_compositor.js`: `export const BLEND_FN_GLSL` with the `bm_*` helpers (§5.4.2), `float blend1(int mode,
   float b, float s)` and `vec3 blendRGB(int mode, vec3 b, vec3 s)`; `blendOver` calls `blendRGB(u_mode, B.rgb,
   S.rgb)`.
5. `inpaint_canvas.js`: `EMULATED_BLEND_SHADER = { label: "emulated blend", uniforms: { u_layer: "sampler2D",
   u_opacity: "float", u_mode: "int" }, code: BLEND_FN_GLSL + shade() }`, where `shade()` is `LINEAR_LIGHT_SHADER`'s
   body with `vec3 bl = blendRGB(u_mode, B.rgb, S.rgb);`; `EMULATED_BLEND_CLIP_SHADER` adds `u_clip` (the same
   `replace` trick as today); delete the `LINEAR_LIGHT_*` constants; `blendEmulated` tests `screen &&
   EMULATED_BLENDS.has(mode)` and passes `u_mode: BLEND_OPS[mode]`; the warning becomes "the blend shader failed,
   blending on the CPU".

**Interface.**

```rust
// crates/px/src/composite.rs
pub const LAST_BLEND: u8 = LINEAR_LIGHT;
const SIMD_BLENDS: [u8; 8] = [MULTIPLY, SCREEN, OVERLAY, DARKEN, LIGHTEN, HARD_LIGHT, DIFFERENCE, LINEAR_LIGHT];
#[inline(always)] fn blend3<const OP: u8>(b: [u32; 3], s: [u32; 3]) -> [u32; 3]   // 255 * B per channel, 0..65025
```

```js
// renderer/editor/px/kernels_js.js
function blend3(op, b0, b1, b2, s0, s1, s2, out /* Int32Array(3) */)   // the twin, same order of operations
// renderer/editor/inpaint_compositor.js
export const BLEND_FN_GLSL   // float blend1(int mode, float b, float s); vec3 blendRGB(int mode, vec3 b, vec3 s)
```

**Risk.** The wasm bytes change, so CI's `build_px --check` on the tag needs the rebuilt binaries committed. The
restructure might slow the scalar path (SIMD untouched): accept no more than 5 % on the timing row. The generic shader
must keep linear light's screen bytes (identical expression; `GL_VS_2D` proves it). The clipped shader's `u_clip` sits
on unit 6, which `renderToTexture` binds only above about 33 MP (a screen canvas never reaches it; F7 removes the clash
for good). GLSL compiles at runtime only: run `composite` early.

**Tier and tests (full).** `node tools/px_test.js`: after the change the SHA is identical on all three builds, and op 14
equals op 0 on all three (R4-S4 moves this to `LAST_BLEND + 1`). `python tools/build_px.py` then `--check`, the
`pxjobs` gate. `composite --strict` on both backends with references byte-identical (including `GL_VS_2D` for linear
light), `clip` (linear light clipped on screen), `export`, `fill`. The timing row before and after. Mutation round
(Rust kernels are full tier; a copied tree, a fresh instance per mutation): swap b and s in overlay's `blend3` arm
(px_test fails); a wrong `u_mode` passed to the shader (composite fails); drop SOFT_LIGHT from the SIMD exclusion
(px_test fails on `px.wasm` only).

**Sessions.** 1.

## 5. The releases

### 5.1 Release 1: masks

What the user gets: a depth map of the picture computed in the app, selections by depth, brightness and colour in every
mode (Intersect is new for every tool), filter layers limited by depth, brightness or colour, the Object tool's box
drag, and a view of any layer mask. This is the release that serves "editing the final picture" (the user's answer of
2026-09-25).

Foundations F1-F8 are built before R1-S3 (§3.1); F9 is R1-S4. R1-S1 and R1-S2 need no foundation (G3).

#### 5.1.1 Shared definitions of release 1

- **Depth convention.** The map stores **far**: `v = 0` is nearest, `v = 1` farthest. `far = 1 - clamp((d - lo) / (hi
  - lo))`, where `d` is the model's relative disparity and `lo` / `hi` are its 0.5 / 99.5 percentiles. On every bar
  near is left, far right. Stored as u16 `round(v * 65535)`.
- **DocMap `depth`** (F8): `{ kind: "depth", w, h, data: Uint16Array, xf, meta, ref, version, dataVersion }`. `w x h`
  is the working size `workSize(W, H, WORK_MAX)`; `xf` is `[W, 0, 0, H, 0, 0]` for a fresh map; `meta = { model,
  label, lo, hi, fp, time, provider, seconds, input: [mw, mh], guided: { r, eps } }`. Only this working map is
  persisted (`maps.depth = { ref, w, h, xf, enc: "u16rg", meta }`); the raw model output stays in memory
  (`ed._depthRaw`).
- **Limit** (F3's `Limit`): `{ source: "depth" | "luma" | "color", lo, hi, fLo, fHi, invert, color?: "#rrggbb", tol?:
  0..100 }`, all ranges 0..1. One shape for `select_range`, `params.limit` (F6) and the UI.
- **Constants** in `renderer/editor/inpaint_depth.js` (R1-S3): `WORK_MAX = 4096` (R1-S2 decides 4096 or 2048, R1-D5);
  `STALE_DIFF = 6` (mean absolute grey difference on 64 x 64; R1-S3 measures, R1-S11 confirms, R1-D11); `GUIDE = { r:
  2 model px at working scale, eps: 1e-3 }` (R1-S2); `LONG_CAP = 2058` (the long side of a panorama's model input);
  `RANGE_BAND_ROWS = 1024` (4 tile rows).
- **Worker op `range_select`** (R1-S5; R1-S9 adds the `logit` source). The foundations' order text called it
  `field_select`; this plan uses `range_select` everywhere.

  ```
  { op: "range_select", W, H, y0, y1 /* tile-aligned band */, source: "depth"|"luma"|"color"|"logit",
    limit /* normalised Limit */, invert: boolean /* weight -> 255 - weight, for the intersect identity */,
    map?: { data: Uint16Array (on SAB when crossOriginIsolated), w, h, m: number[6] /* image px -> map px */ },
    logits?: { data: Float32Array(65536), n: 256, m: number[6] /* image px -> logit px */ },
    sab?: SharedArrayBuffer /* RGBA of the band, W x (y1-y0) x 4: luma / color */,
    clip?: storeArgs(layerSnap...) /* logit mode, layer source */ }
  -> { tiles: [{ tx, ty, alpha: ArrayBuffer(65536) } | { tx, ty, full: true }], bounds: [x0,y0,x1,y1] | null, timing }
  ```

- **Banded combine rule**: F4's rule for banded writers (one undo step, `sel.combine` per band with add or subtract
  only; replace = clear once then add; intersect = subtract with the inverted weight; a box-limited writer first
  intersects with `rectSource(box)`). R1-S5 checks the identity on all 65,536 pairs.

#### R1-S1: the depth model in main

**Goal.** Depth Anything V2 Small runs in the app through ONNX Runtime from one IPC call; it appears in *Settings ›
Helpers* with *Download*; its timings are measured, and whether it runs on the main thread or in a process of its own
is decided. The user sees the new row in *Settings › Helpers* and nothing else.

**Preconditions.** None. R1-D1 (the download: `depth_anything_v2_small.onnx` from huggingface.co
`onnx-community/depth-anything-v2-small` at commit `4472b736…`, 99,060,839 bytes; clicked by the user or a yes for
Claude; licence Apache-2.0 with issue #320 about the training data still open).

**Changes.**

- `electron/main/onnx/models.js`: a MODELS row after `lama`:

  ```js
  { id: "da2_small", kind: "depth", label: "Depth Anything V2 Small", note: "depth maps (Select by depth, Limit by depth)",
    source: "onnx-community/depth-anything-v2-small", sourceUrl: `${HF}/onnx-community/depth-anything-v2-small`, license: "Apache-2.0",
    input: 518, multiple: 14, ...IMAGENET,
    files: [{ name: "depth_anything_v2_small.onnx", role: "model", size: 99060839,
      url: `${HF}/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx` }] }
  ```

  With a comment: sha256 `afb6a5c2…df10c`; the repo is deprecated and its successor `-ONNX` uses external data. `SUBDIRS`
  gets `"depth"`. `ONNX_ALIASES.da2_small =
  /depth[-_]anything[-_]v2[-_]small(?![-_]onnx)[^/]*\/onnx\/model\.onnx$/` (the 127 KB external-data stub of the new
  repo also fails the size match). `OTHER_WEIGHTS.da2_small =
  /depth[_-]anything[_-]v2[_-]vits[^/]*\.(?:safetensors|pth|pt|bin)$/` (the ComfyUI depth nodes' files: reported, never
  loaded).
- `electron/main/onnx/sam2.js`: `normaliseRect(rgba, w, h, mean = MEAN, std = STD)`; `normalise(rgba, mean, std, size)`
  calls `normaliseRect(rgba, size, size, mean, std)` with byte-identical output; export it.
- `electron/main/onnx/depth.js` (new, shaped like `matting.js:9-43`):

  ```js
  class Depth { constructor(runtime, model, file)
    async run(rgba, w, h) -> { depth: Float32Array(w*h), width: w, height: h, min, max, provider, ms } }
  ```

  Input `[1, 3, h, w]` float32 from `normaliseRect` with the model's ImageNet mean and std. The output is picked by
  element count `w*h`: expected `[1, h, w]` (`predicted_depth`), `[1, 1, h, w]` accepted, otherwise a throw naming the
  dims. Record the input and output names and dims in a header comment on the first real run. On the process route
  (below): also `depth_process.js` and an `engine(ort)` split, copying `lama.js` `spawn` / `_fallBack` / `kill`
  (lama.js:75-176, `lama_process.js`) with messages `{ id, type: "warm" | "run", file, image, width, height }`, killed on
  folder change, scan, remove and `will-quit` as for LaMa.
- `electron/main/onnx/index.js`: `DEFAULTS.depth = "da2_small"` (:19); `MISSING.depth = "No depth model is downloaded
  (Settings › Helpers)."`; a `depthInstances` map cleared in `clearInstances()` and `remove()`; `depthFor(id)` modelled
  on `mattingFor` (:175); the job:

  ```js
  async function depth(req /* { model?, image: Uint8Array RGBA w*h*4, width, height } */)
    -> { depth: Float32Array, width, height, min, max, seconds, runMs, provider, model, label }
  ```

  with its own check (not `checkImage`): integer width and height, multiples of 14 within [14, 2058], `image.length ===
  w*h*4`, otherwise `the depth model needs RGBA at multiples of 14 (got …)`; `busy.add("depth")` around the run;
  `status()` reports `depth: c.depth`; exports grow by `depth` (and `warmDepth` on the process route).
- `electron/main/main.js:1095`: `ipcMain.handle("helpers:depth", (_e, req) => helpers.depth(req));`.
  `electron/preload.js:175`: `depth: (req) => ipcRenderer.invoke("helpers:depth", req),`.
- `renderer/shell.js:1634`: `depth: "depth maps (Select by depth, Limit by depth)"` in the kind tooltip map. No model
  select while one depth model ships.
- `tools/helpers_test.js`: `--depth <id>` (default `da2_small`) and `--time`. A synthetic perspective floor at
  784 x 518: horizon at `y_h = 0.35 H`; below it `z = f / (y - y_h)`, `X = (x - cx) z / f`, checker `(⌊X/s⌋ + ⌊z/s⌋) &
  1` fogged to grey; above it a sky gradient. Skipped when the model is absent.
- `tools/depth_ref.py` (new): the Python reference. `DPTImageProcessor(do_resize=True, size={"height": 518, "width":
  518}, keep_aspect_ratio=True, ensure_multiple_of=14, resample=3, do_rescale=True, rescale_factor=1/255,
  do_normalize=True, image_mean=IMAGENET_MEAN, image_std=IMAGENET_STD)` built from these values with no config download,
  plus `onnxruntime` on the CPU over the same `.onnx`. `--write <dir>` writes `input_<w>x<h>.rgba` (its own resized
  RGBA) and `ref_<w>x<h>.f32`; `helpers_test.js --depth-ref <dir>` runs the Node path on that RGBA and compares. The
  tools' Python has transformers 4.57.0, onnxruntime 1.23.2 and Pillow.

**Measure first** (by hand; the numbers go into this plan's checkpoint section in R1-S2 and into HELPERS.md in R1-S11):

1. Plain Node, `helpers_test.js --depth da2_small --time` on DML and on CPU (`--cpu`): cold create, first run per shape
   (784 x 518, 924 x 518, 518 x 686, 518 x 518), warm run.
2. In a dev instance, the main-thread block, over CDP: `p = window.scumble.helpers.depth(req)`; while not done, `t =
   now(); await window.scumble.helpers.status(); pings.push(now() - t)`. The worst ping is the block.
3. **Decision rule.** Cold create plus first run on DML ≤ about 1 s and a CPU run ≤ about 1.5 s: stay on the main
   thread like SAM2. Otherwise the process route; try DML in the process first (untested in a utility process), and if
   it fails there run the process on the CPU and record it (R1-D4 only if both are bad).
4. The cost of a new aspect under DML (a recompile per shape). Above about 1 s: size buckets in R1-S3 (fixed shapes,
   the output resampled back).

**The process route is its own session (R1-S1b, 0.5 d).** When the decision rule picks it, R1-S1 commits the
main-thread module first; R1-S1b then adds `depth_process.js`, the `engine(ort)` split and `warmDepth`, and repeats
measurement 2 (proposed bound: the worst ping below 50 ms). R2-S7 names the same session if R2-S3 finds the detail pass
blocking.

**Tests (light).** `node tools/helpers_test.js --depth da2_small` by hand: the output is 784 x 518; the floor's 20 row
bins have mean disparity decreasing upwards (Spearman ρ ≥ 0.95); the sky's mean disparity is below the floor's 10th
percentile. `python tools/depth_ref.py --write <scratch>` then `node tools/helpers_test.js --depth-ref <scratch>`, both
on the CPU: Pearson ≥ 0.99999 and max |Δ| ≤ 1e-4 × (max − min) (the ORT versions differ, so no tighter bound); on DML
Pearson ≥ 0.9999. `node tools/depth_test.js` (new, plain Node, no model): `normaliseRect(rgba, n, n)` byte-equal to
`normalise(rgba, …, n)` for n = 64; with a fake runtime returning `[1,1]` (decoy) and `[1,h,w]`, `Depth.run` picks the
second and throws naming the dims when neither fits; `depth()` refuses 518 x 777 ("multiples of 14") and a short
buffer. `node tools/scan_test.js`: a registered-size `depth_anything_v2_small.onnx` is found; an HF layout
`depth-anything-v2-small/onnx/model.onnx` of that size is linked; `depth-anything-v2-small-ONNX/onnx/model.onnx` of
127 KB is not; `depth_anything_v2_vits.safetensors` is reported under other weights. Gates `lint`, `types`, `help` (if
the manual names the Settings row). One look at *Settings › Helpers*.

**Docs.** CHANGELOG: "**Depth model.** Settings › Helpers offers Depth Anything V2 Small (99 MB, Apache-2.0) for the
depth tools; it runs in the app on the GPU or the processor." HELPERS.md: the models-table and modules-table rows
(`depth.js`); timings follow in R1-S11.

**Risks.** The deprecated repo could disappear; the fallback (not built) is a `data` role in `models.js`, with the
external-data file kept under its recorded name `model.onnx_data` beside the model in a folder per model.
onnxruntime-node's create and run hold the main thread (HELPERS.md:239): measure before choosing. fp16 stays out (its
input dtype was never checked).

**Effort.** 1-1.5 d; the process route is R1-S1b (0.5 d, conditional).

#### R1-S2: checkpoint on the user's pictures (early)

**Goal.** The user sees the raw and guided depth maps of `docs/images/tutorial/scene.jpg` (2000 x 1125, model input
924 x 518), `skin.jpg` (1500 x 2000, model input 518 x 686) and a 15k file of the user's, and decides how much of
release 2's edge work is needed, the working-map size and the guide parameters. Afterwards `docs/PLAN_NIK9.md` has a
"Checkpoint (date)" section with the verdicts.

**Preconditions.** R1-S1, the model on disk, the user present. R1-D3 (the 15k file's path). DA3Mono-Large only on
R1-D2.

**Changes.**

- `tools/depth_probe.py` (new; reuses `depth_ref.py`'s processor; `PIL.Image.MAX_IMAGE_PIXELS = None` for the 15k file).
  Per picture, to `dist/depth_checkpoint/<name>/` (untracked): `raw16.png` (16-bit grey of `far`), `raw_colour.jpg`
  (near warm, far cool), `guided_<2048|4096>_r<r>_e<eps>.png` for r ∈ {1, 2, 4} model px and eps ∈ {1e-4, 1e-3, 1e-2}
  (a numpy box filter with clamped edges like `crates/px/src/maskf.rs` `box_rows` / `box_cols`: the reference for
  R1-S3's JS), `packed_rg.png` (u16 as R high / G low at 2048 and 4096, to measure PNG sizes), `sheet.jpg` (photo, raw
  and best guided map side by side), `numbers.json` (times, sizes, percentiles).
- `docs/PLAN_NIK9.md`, a "Checkpoint" section: per picture the input size, the run time (DML / CPU), the user's verdict
  on edges (hair, foliage, glass, sky); the chosen `WORK_MAX`, `GUIDE.r`, `GUIDE.eps`, the long-side cap; the PNG size
  per map; the decision on release 2's detail pass and edge snap (input for R2-D1, R2-D3); DA3Mono-Large beside DA2-S
  if allowed; the R1-S1 timings.

**Tests (light).** `python tools/depth_probe.py --self-test` checks the sizing against the table: (6000,4000) →
784 x 518; (2000,1125) → 924 x 518; (1500,2000) → 518 x 686; (400,300) → 518 x 392; (763,518) → 756 x 518 (the
half-even case, 54.5 → 54); (15000,10000) → 784 x 518; (6000,1000) → 3108 x 518 (uncapped DPT). No gates; the session
commits the tool and the PLAN section.

**Risks.** A 6:1 panorama gives 3108 x 518 by the DPT rule: measure it and decide the cap for R1-S3 (proposed: scale
down so the long side ≤ 2058). DML contention: check `/queue` and note whether ComfyUI held VRAM during the timings.

**Effort.** 0.5 d plus the user's looking time.

#### R1-S3: the depth map on the document (R1-S3a and R1-S3b)

**Two sittings.** **R1-S3a** (light, 0.5 d; needs R1-S1 and R1-S2 only, so it may follow R1-S2 before any
foundation): the first two bullets of *Changes* (`inpaint_depth.js` in `build_node.py` FILES, the worker op
`depth_guide`) and the `node tools/depth_test.js` paragraph of *Tests*; nothing calls the module yet, the user sees
nothing, gates `lint`, `types`, `node`. **R1-S3b** (normal, 1-1.5 d): everything else (host, the node's host, the
producer, the Depth row, the commands, the policy, the `depth` gate, the docs).

**Goal.** *Selection › Depth: Compute* (and `depth_map`) computes the map from the picture without filter layers:
model input at the DPT size, the model, a guided upsample in a pool worker. The map lands as `ed.maps.depth` (F8):
undoable, following turns, crops and resizes, saved in `.scumble` and the autosave. The row shows the time, the provider
and a "Picture changed: Recompute" badge. `sample_depth` reads a value. The user sees the Depth row and its status line;
no selection by depth yet.

**Preconditions.** R1-S3a: R1-S1 (and its decision), R1-S2 (the constants and the numpy reference). R1-S3b: R1-S3a,
F2, F3 (`LUMA` for the guide's grey), F5 (`host.pictureInput`), F8 (`makeMap`, `setMap`, `geometryToken`, `mapStale`,
`passToMap`, `sampleMap`, `fingerprint`, the `maps` row).

**Changes.**

- `renderer/editor/inpaint_depth.js` (new, FILES, `// @ts-check`, no DOM at import):

  ```js
  export const WORK_MAX = 4096, STALE_DIFF = 6, GUIDE = { r: 2, eps: 1e-3 }, LONG_CAP = 2058, RANGE_BAND_ROWS = 1024;
  export function roundHalfEven(x)                    // Python round(): 54.5 -> 54, 55.5 -> 56
  export function modelSize(W, H, { short = 518, multiple = 14, cap = LONG_CAP } = {}) -> [mw, mh]   // DPT keep_aspect_ratio + constrain_to_multiple_of; then the long-side cap
                                                      // (the scale nearer to 1 wins: shrinking puts the short side at 518, enlarging the long side)
  export function workSize(W, H, max = WORK_MAX) -> [gw, gh]
  export function disparityRange(d /* Float32Array */, pLo = 0.005, pHi = 0.995) -> { lo, hi }   // 4096-bin histogram
  export function farU16(d, lo, hi) -> Uint16Array    // round(65535 * (1 - clamp((d - lo) / (hi - lo))))
  export function bilinearResize(src /* f32 */, w, h, W2, H2) -> Float32Array   // pixel centres, edge clamp
  export function guidedFilter(I, p, w, h, r, eps, box /* (f32, w, h, [r]) => f32 */) -> Float32Array   // He et al.: means by `box`, q = mean_a*I + mean_b
  export function guidedFar({ raw, rw, rh, grey /* Uint8 gw*gh */, gw, gh, r, eps, lo, hi }, box) -> Uint16Array
  ```

- `renderer/editor/inpaint_worker.js` `run()` (:797): `if (msg.op === "depth_guide") return depthGuide(msg);` calling
  `guidedFar(msg, boxBlurs)` and returning `{ u16: buffer, transfer: [buffer], timing }` (the worker already imports
  `px/kernels.js`).
- `renderer/editor/host.js` (app):

  ```js
  depthSupported: true,
  depthModel() { const all = this.presentHelpers("depth"); return all.find((m) => m.id === this.helpers.depth) || all[0] || null; },
  async depthInput(editor, w, h) { return this.pictureInput(editor, w, h, { skipFilters: true, background: "#808080" }); },   // F5
  async computeDepth(editor, req /* { image, width, height } */) { const m = this.depthModel(); if (!m) throw new Error("No depth model is downloaded (Settings › Helpers)."); editor.helperUsed = true; return this.helperCall("depth", { model: m.id, ...req }); },
  ```

  The typedef rows (host.js:257-305) and `depth` in `helperCall`'s doc list.
- The node's own `js/host.js` (:156): `depthSupported: false, depthModel() { return null; }, async depthInput() {
  return null; }, async computeDepth() { throw new Error("depth maps are a Scumble feature"); },` (local commit in the
  node repo).
- `renderer/editor/inpaint_canvas.js`: `this.depthPending = null`; `async computeDepthMap({ recompute = false } = {}) ->
  DocMap | null`:
  1. If `depthPending`, return it. 2. `token = this.geometryToken()`. 3. `[mw, mh] = modelSize(W, H)`; `input = await
  host.depthInput(this, mw, mh)`; `fp = fingerprint(input, mw, mh)`. 4. `res = await host.computeDepth(this, { image:
  input, width: mw, height: mh })`. 5. `{ lo, hi } = disparityRange(res.depth)`. 6. `[gw, gh] = workSize(W, H)`; `guide
  = await host.depthInput(this, gw, gh)`, turned to grey with F3's `LUMA`. 7. `u16 = await editorPool().run("depth_guide",
  …, { priority: INTERACTIVE })`; without a pool or on the canvas backend, `guidedFar` on this thread. 8. `map =
  makeMap("depth", gw, gh, u16, [W,0,0,H,0,0], meta)`; `ok = await this.setMap("depth", map, { label: recompute ?
  "Recompute depth map" : "Depth map", token })`; when `ok` is false (the picture was turned or cropped meanwhile, or
  the tab closed), status "The depth map was dropped: the picture was turned or cropped meanwhile". 9. Status `Depth map
  784×518 → 4096×2731 with Depth Anything V2 Small in 0.4 s (DirectML).` plus `host.slowHelperHint(res)`.
  `depthAt(x, y)` is `sampleMap(this.maps.depth, x, y)` or null. `async depthStale()` is `mapStale("depth")` against
  `STALE_DIFF`, checked lazily 1 s after a `compositeVersion` change, only while the Depth row is visible.
- `renderer/editor/inpaint_modal.js` `buildSelection` (:540): a "Depth" row after the saved selections, only when
  `host.depthSupported`: `ed.depthBtn` (*Compute* / *Recompute*), `ed.depthState` ("No depth map" | "4096×2731 · DA2
  Small · 0.4 s" | "Picture changed: Recompute"), and with no model "Download the depth model in Settings › Helpers".
- `renderer/commands.js`: `busy()` (:55) adds `ed.depthPending`; the status `pending` (:255) adds `depth:
  !!ed.depthPending`. New commands:

  ```js
  depth_map: { needsImage: true, description: "The picture's depth map (in-app model): computes it when missing or with recompute; reports size, model, whether the picture changed since, and the depth at a point (0 near .. 1 far).",
    params: { recompute: P.bool("compute again even if a map exists", { default: false }), at: P.obj("optional [x, y]: report depth_at there"), timeout: P.timeout(300) },
    run -> { w, h, model, computed, stale, diff, depth_at? } },
  sample_depth: { needsImage: true, readOnly: true, description: "The depth (0 near .. 1 far) at image pixel x, y; needs a depth map (depth_map).",
    params: { x: P.num("x", { required: true }), y: P.num("y", { required: true }) }, run -> { depth, x, y } },
  ```

  Errors: no map → `no depth map: run depth_map first`; no model → the MISSING text.
- `electron/main/assistant/policy.js`: `depth_map: AUTO` (in-app GPU model, no ComfyUI, no cost; pushes its own `maps`
  step); `sample_depth: AUTO` and in `READS`; `TIMEOUT_DEFAULTS.depth_map = 300` (the 125 s VRAM case fits).
  `tools/assistant_test.js`: rows `["depth_map", {}, "auto"]`, `["sample_depth", {x:1,y:1}, "auto"]`; steps
  `["depth_map", {}, null]`. `tools/commands_doc.py` GROUPS: both under Selection; COMMANDS.md regenerated.

**Tests (normal).** `node tools/depth_test.js`, extended: the `modelSize` table of R1-S2, `roundHalfEven(54.5) = 54`,
`(55.5) = 56`; `disparityRange` on a 1..1000 ramp gives lo ≈ 5.995 and hi ≈ 995.005 (±1 bin); `farU16`: `d = hi` → 0,
`d = lo` → 65535, monotonic; `guidedFilter`: constant `p` gives `p` (|Δ| ≤ 1e-6), `eps = 1e6` equals the box mean
(≤ 1e-5), a step edge in `I` with a box-blurred step in `p` (r = 8, eps = 1e-4) gives a 10-90 % width ≤ 2 px against ≥ 8
for the plain box; `guidedFar` against R1-S2's numpy reference on `scene.jpg`'s 2048 map within 64/65535.

New gate `tools/depth_test.py` (runs `node tools/depth_test.js` first, like `help_test.py:52-57`), `--offline`,
`--tiles on`, once `--tiles off` for the canvas input path. Stand-in: `host.depthModel = () => ({ id: "fake", label:
"fake" })`; `host.helperCall("depth", a)` records `a` and returns `d(x, y) = 1 + 9 * y / h` (the bottom is near).

| # | Case | Expected |
|---|---|---|
| 1 | `depth_map` without a model | the MISSING error; no undo step |
| 2 | 1500 x 1000 picture | helper called with 784 x 518 (`image.length = 784*518*4`); map `workSize`; `xf = [1500,0,0,1000,0,0]` |
| 3 | The same plus a levels-to-black filter layer | helper input byte-identical to case 2 (filters left out) |
| 4 | `sample_depth` at (750, 990) and (750, 10) | ≤ 0.02 and ≥ 0.98 |
| 5 | undo, then redo | `maps.depth` absent, then the same object |
| 6 | `rotate_canvas 90` | `depthStale().stale` false |
| 7 | An opaque black rectangle over 40 % | stale true |
| 8 | A 0.5 % dab | stale false; record both diffs to set `STALE_DIFF` |
| 9 | Two `depth_map` calls at once | helper called once |
| 10 | Stand-in delayed 1 s, `rotate_canvas` meanwhile | map dropped; status says why; undo stack unchanged |
| 11 | `new_canvas 15000x10000` + `depth_map` | no mirror over 64 MB during it (`memoryReport`); input 784 x 518; map 4096 x 2731; time and worker peak recorded |
| 12 | Save `.scumble`, reopen | `depth_at` equal (bytes are F8's test); `meta.model` kept |

Gates `depth`, `maps` (unchanged), `commands`, `assistant`, `mcp`, `lint`, `types`, `nodecopy` (FILES and host
members).

**Docs.** CHANGELOG: "**Depth map of the picture.** *Selection › Depth* computes a depth map in the app (Depth Anything
V2 Small, on the GPU or the processor). It is saved with the document, follows turns, crops and resizes, and the panel
says when the picture has changed enough to compute it again; it never recomputes by itself." MANUAL *Selecting*: a
paragraph on the Depth row. COMMANDS.md regenerated.

**Risks.** Async: push the `maps` step only when the map lands (the token). Never pass the depth input's opts into
`stackPlan`. No `crypto.subtle` or `ImageData` over arena views (the tile trap): `fingerprint` works on the
`pictureInput` copy. The guided filter at 4096 in a worker holds about ten f32 arrays of 45 MB at peak: if case 11 shows
over 1.5 s or 400 MB, `WORK_MAX = 2048` (R1-D5). `rAF` stops in a hidden window: scripted waits use `setTimeout`.
**Split point** of R1-S3b if the context runs high: commit after the commands and the gate, and move the Depth row to
R1-S6.

**Effort.** R1-S3a 0.5 d, R1-S3b 1-1.5 d.

#### R1-S4: the range bar and the histograms (F9)

Build F9 exactly as §4 specifies, including `pictureHistogram`. Tier light; 1 d.

#### R1-S5: Select by range, the writer and the command (R1-S5a and R1-S5b)

**Two sittings.** **R1-S5a** (1 d): the worker op `range_select` with the depth source, `selectRange` with the
banded combine rule, `cancelRange`, the canvas-backend loop, `select_range` with `source` limited to `"depth"` (its
enum lists one value), `busy()`, the policy row (its `assistant_test.js` row uses `{ source: "depth", lo: .2, hi: .8 }`),
the plain-Node tests and the `selection` gate's cases 1-5, 9, 10 and 12. **R1-S5b** (0.5 d): the luma and colour
sources in the worker, the held-stack band reads with the `readBoxBytes` fallback, the enum widened to the three
sources, cases 6, 7, 8 and 11, the CHANGELOG line. COMMANDS.md regenerated in both.

**Goal.** `select_range` selects by depth, luminosity or colour in every mode, Intersect included. It is soft (the
feathers) and never builds a W x H mask or canvas on tiles. The user can use it through MCP and the assistant; the panel
follows in R1-S6.

**Preconditions.** R1-S3b, F3 (`normalizeLimit`, `limitWeight`, `u16Bilinear`, `opp`, `colourSimilarity`), F4
(`sel.combine`, `tilesSource`, `bytesSource`, `SEL_MODES`, `P.selMode`), F8 (`passToMap`). R1-D8 (one command
`select_range` instead of the research's `select_depth`).

**Changes.**

- `renderer/editor/inpaint_worker.js`: op `range_select` (§5.1.1) for `depth | luma | color`. **depth**: per pixel
  centre `(x + 0.5, y + 0.5)`, `mp = m · p`, `v = u16Bilinear(map, w, h, mp)`. **luma**: `v = LUMA · rgb / 255` from
  `sab`. **color**: `v = colourSimilarity(rgb / 255, opp(limit.color), limit.tol)`. Then `w = rangeWeight(v, limit)`,
  `alpha = round(255 · (invert ? 1 - w : w))`. A tile whose 65,536 alphas are all 0 is not sent; all 255 is sent as
  `{ full: true }`. The worker never writes an arena tile.
- `renderer/editor/inpaint_canvas.js`:

  ```js
  async selectRange(limitIn, mode = "replace", { label = "Select by range" } = {}) -> { bounds, seconds, tiles }
  cancelRange()
  ```

  1. `limit = normalizeLimit(limitIn)`; a depth source without `this.maps.depth` throws `no depth map: compute it first
  (Selection › Depth)`. 2. Refuse while `rangePending`; set it. 3. `pushUndo({ kind: "selection", label })` once; for
  replace `this.sel.clear()`. 4. Band loop over `[0, H)` in `RANGE_BAND_ROWS` steps: **depth**: every band a pool job
  at once (INTERACTIVE, `group = "range" + seq`), `map.data` passed (shared on a SAB), `m = passToMap(map, 1)`; **luma /
  colour** on tiles: `held = await this.holdRunStack({ forRun: true })`, per band a `SharedArrayBuffer(W*rows*4)` filled
  by `fillBoxFromStack(held, [0, y0, W, y1], sab)` (:7074), at most two bands in flight; when `held` is null (or a band
  is wider than `glMaxSide`, where `fillBoxFromStack` returns false) `readBoxBytes`. 5. Each answer goes to
  `this.sel.combine(tilesSource(tiles, [0, y0], bandBox), bandMode)` by the banded combine rule (intersect = subtract with
  `invert` set in the job). 6. At the end `markSelectionChanged(boundsAfter(...))` (replace: the union of band bounds;
  add: `boundsAfter("add", union)`; subtract / intersect: `{ within: old }`), `draw()`, status "Selected 34 % of the
  picture by depth (near 0.10 – far 0.35) in 0.8 s". 7. `cancelRange()` (Escape while pending): `pool.cancel(group)`,
  restore the pushed step and drop it with no redo entry, status "Selection by range cancelled". `held.release()` in
  `finally`.

  **Canvas backend** (the escape hatch): the same loop on the main thread: one `flattenToCanvas({ forRun: true })`,
  `getImageData` per 256-row band, weights by F3 on this thread, `bytesSource` per band.
- `renderer/commands.js`:

  ```js
  select_range: { needsImage: true, description: "Select by depth (0 near .. 1 far; needs depth_map), luminosity (0 black .. 1 white) or colour similarity (1 = the colour): between lo and hi, softened over fLo below and fHi above.",
    params: { source: P.enum("depth, luma or color", ["depth", "luma", "color"], "depth"), lo: P.num("0..1", { required: true }), hi: P.num("0..1", { required: true }),
      fLo: P.num("feather below lo, 0..1", { default: 0 }), fHi: P.num("feather above hi, 0..1", { default: 0 }), invert: P.bool("select outside the range", { default: false }),
      color: P.str("#rrggbb, for source color"), tol: P.num("0..100, colour tolerance", { default: 30 }), mode: P.selMode() },
    run -> { selection: bounds(ed), seconds, status } }
  ```

  `busy()` adds `ed.rangePending`.
- `policy.js`: `select_range: AUTO`. `assistant_test.js` row `["select_range", { source: "depth", lo: .2, hi: .8 },
  "auto"]` (R1-S5a; R1-S5b adds the same row with `source: "luma"`), step `null`. COMMANDS.md regenerated.

**Tests (normal).** Plain Node (`tools/weights_test.js` or a new `tools/range_test.js`): for all `a, w ∈ 0..255`,
`combineAlpha(a, 255 - w, "subtract") === combineAlpha(a, w, "intersect")` (all 65,536 pairs); the worker's band
function on a synthetic 600 x 300 ramp map equals a direct per-pixel `limitWeight` loop byte for byte.

The `selection` gate (F4b) gains a "range" group, `--offline`, `--tiles on` for all of it and `--tiles off` for cases
1, 4 and 9. Fixture: 1600 x 1200 with `makeMap("depth", 1024, 768, rampX(0..65535), [1600,0,0,1200,0,0], {})` and
`setMap`.

| # | Case | Expected |
|---|---|---|
| 1 | depth lo .25 hi .5, no feathers | at columns where v = .2 / .3 / .45 / .6 → 0 / 255 / 255 / 0, exact (9 columns, middle row) |
| 2 | fLo .1 at v = .2 | `round(255 · sstep(.15, .25, .2)) = 128` (±1, bilinear map) |
| 3 | add over a rect selection [0,0,400,1200] | 255 inside the rect whatever w; outside equals w |
| 4 | intersect over a selection feathered to 200, at a pixel with w = 128 | `mul255(200, 128) = 100` exactly |
| 5 | subtract | `a - mul255(a, w)` exactly at 5 probes |
| 6 | luma on 16 grey stripes 0, 17, …, 255; lo .4 hi .6 | stripes 102, 119, 136, 153 → 255; others 0 |
| 7 | colour `#ff0000` tol 20 lo .5 hi 1 over red / green / blue patches | red 255; green and blue 0 |
| 8 | the same picture with a levels-to-black filter layer on top, luma lo .5 | nothing selected (it reads the shown picture) |
| 9 | undo, then redo | bytes before and after equal at the probes |
| 10 | 15000 x 10000 + ramp map, depth with fLo = fHi = .5 (every tile soft) | no mirror over 64 MB, `flattenToCanvas` count 0, time recorded |
| 11 | the same size, luma | as case 10, through the held stack |
| 12 | a stand-in pool delay (a hook on `editorPool().run`), then `cancelRange()` | selection bytes and undo length as before |

`commands_test.py`: `select_range` refuses source "x" (naming the sources it takes), refuses a depth source without a map, accepts
`mode: "intersect"`. Gates `selection`, `pixels`, `commands`, `assistant`, `mcp`, `lint`, `types`, `nodecopy`.

**Docs.** CHANGELOG: "**Select by depth, brightness or colour.** `select_range` (and next the Selection panel) selects
what lies between two depths, two brightness levels or near a colour, softened at each end as far as you set it;
replace, add, subtract or intersect." COMMANDS.md regenerated.

**Risks.** Bands start on the tile grid (`tilesSource`'s origin). No `ImageData` over SAB views in the worker. The
selection itself is 600 MB of RGBA tiles at 15k when fully selected: the store's cost, not this writer's. Transient
memory per band: 61 MB per luma band at 15k.

**Effort.** R1-S5a 1 d, R1-S5b 0.5 d.

#### R1-S6: Select by range, the panel

**Goal.** The Selection panel gets a "Select by range" block: a source select (Depth when supported, Luminosity,
Colour), the range bar with histogram and gradient, a colour swatch and tolerance for Colour, an eyedropper, Invert,
the mode buttons (Replace / Add / Subtract / Intersect), *Select*, a live red preview tint while the handles move or
Alt is held over the bar, and *Show depth map*. R1-S3's Depth row becomes the block's head.

**Preconditions.** R1-S4 (F9), R1-S5.

**Changes.**

- `inpaint_modal.js`: `buildRangeSelect(ed, d)`, called from `buildSelection` after the saved selections:
  `ed.rangeSourceSel` (`selectInput`; Depth only when `host.depthSupported`); `ed.rangeBar =
  buildRangeBar(ed.rangeLimit, { gradient: source, histogram: () => source === "depth" ? ed.mapHistogram("depth") :
  source === "luma" ? ed.pictureHistogram().luma : ed.similarityHistogram(ed.rangeLimit), begin: () =>
  ed.setRangePreview(ed.rangeLimit), preview: (r) => ed.setRangePreview({ ...ed.rangeLimit, ...r }), commit: (r) => {
  ed.rangeLimit = { ...ed.rangeLimit, ...r }; }, stop: () => ed.setRangePreview(null), pick: () => ed.pickOnce(source),
  hover: (on) => ed.setRangePreview(on ? ed.rangeLimit : null), title })`; `ed.rangeMode` buttons copying the
  segment-mode buttons (:613-622) with four modes; `ed.rangeSelectBtn` → `ed.selectRange(ed.rangeLimit, ed.rangeMode)`;
  `ed.depthViewBtn` (*Show map*, a toggle); the colour swatch (`input type=color`) and tolerance (`numberInput
  0..100`). Per-document state `ed.rangeLimit` defaults to `{ source: "depth" or "luma", lo: 0, hi: .3, fLo: .05,
  fHi: .05, invert: false, color: "#ffffff", tol: 30 }`; not saved with the document (ranges are per picture).
- `inpaint_canvas.js`:
  - `similarityHistogram(limit)`: 256 bins of `colourSimilarity` over the whole picture's 256 px sample (F9's
    `pictureSample()`; `belowStats` belongs to a filter layer and the panel has none), cached per `(compositeVersion,
    color, tol)`. R1-S8's Limit row uses the same function over `belowSample(layer)`.
  - `setRangePreview(limit | null)` builds `this._rangeTint`: **depth** from a map proxy (≤ 1024 px long side, F3
    weights per call) drawn through `xf`; **luma / colour** from a screen-scale sample of the visible region
    (`sampleRegion("image", viewportBox, view.scale, { forRun: true })`, cached per `compositeVersion` + view box), with
    weights through `runShader` on `WEIGHTS_GLSL` and the CPU twin as fallback; then `drawSoon()`.
  - `pickOnce(source)` arms a one-shot click before the tool dispatch in the pointer-down handler (:5277 area), status
    "Click the picture to pick … (Esc cancels)": depth `v = depthAt(ix, iy)`, recentre lo / hi on `v` keeping the
    width; luma: the composite's luma at the pixel (`readBoxBytes` of 1 x 1); colour: `limit.color` = that pixel's hex.
  - `this.mapView = null | "depth"`. In `drawSceneOverlays` (:17541): with `mapView === "depth" && this.maps.depth`,
    `ctx.save(); ctx.transform(...xf); ctx.drawImage(depthProxy, 0, 0, 1, 1); ctx.restore()`, opaque, `depthProxy`
    being near-white grey at ≤ 2048 px per map `dataVersion`; with `this._rangeTint`, draw it at 0.4 alpha as the
    selection tint is (:17551). Clear `_rangeTint` and `mapView` on `setValue` and a new picture.
  - Keys: Enter while the range bar has focus runs *Select*; Escape cancels a pick or a pending range.

**Tests (normal).** `selection_test.py` "panel" group, `--tiles on`: (1) the block exists; with `host.depthSupported =
false` and the modal rebuilt the Depth option and row are absent. (2) `ed.rangeBar.set({ lo: .25, hi: .5, fLo: 0, fHi:
0 })` and *Select* clicked give the bytes of R1-S5 case 1 at its 9 probes. (3) begin, preview and stop set and clear
`ed._rangeTint` (a state check); no `getImageData` on a GPU canvas per preview call: count the calls with a hook, at most
one per `compositeVersion` (the acceleration latch). (4) `pickOnce("depth")` plus a real click at (800, 1100)
recentres the range on `depthAt(800, 1100)` ±0.002. (5) `mapView = "depth"` changes no `export` bytes. Gates
`selection`, `skins`, `help`, `lint`, `types`, `nodecopy`; one look by the user.

**Docs.** MANUAL *Selecting*: a paragraph and a step "Something by distance or by brightness"; a note that ranges are
per picture (a range from one picture means nothing in another) and that a soft selection is cut at half strength when
it becomes an inpainting mask (the run path's thresholds). *Keyboard shortcuts*: Enter in the range bar. CHANGELOG: "the
Selection panel's *Select by range* block with a live preview and *Show depth map*".

**Risks.** Skins rules 1-2. Canvas `destination-in` / `copy` act on the whole canvas: the tint scratch uses
`source-over` only. Previews never exceed 33 MP: proxies ≤ 2048, screen samples ≤ the viewport.

**Effort.** 1-1.5 d. **Split point** if it runs long: commit after the block and *Select* (tests 1, 2); the preview
tint, `pickOnce` and *Show depth map* (tests 3-5) follow in the next sitting.

#### R1-S7: Limit on filter layers, the stage (R1-S7a and R1-S7b)

**Two sittings.** **R1-S7a** (1 d): `inpaint_limit.js` without `limitAlphaRows` (the stage, GL and CPU), the import,
`filterInfo` / `filterKey`, the `set_filter` description, the FEATURES row with its explicit `document_test.js` case
(`readerFor` of the row's sample is 3), the `limit` gate's cases 1-6, 8, 9, 10 and 12. **R1-S7b** (0.5 d):
`limitAlphaRows` and the fill path (`fillLayerCanvas`, `fillLayerRows`, the PSD / ORA alpha, the fill rule in
`add_filter` / `set_filter`, `setFilterType`'s note), case 7 (fills), case 11 (clipped), case 13 (15k export), and the
measurement options: `tools/export_test.py` and `tools/perf_test.py` take `--limit=<source>:<lo>:<hi>:<fLo>:<fHi>[:inv]`
(comma-free, §2), and `run_gates.sh`'s `perf:*` (:103) gets the comma split of `exportperf:*`.

**Goal.** `params.limit` on any filter layer (F6's reserved key) changes the picture everywhere it is drawn, through one
post-stage inside `applyFilter`: the view, the 1024 preview, export bands, the held program and the GPU chain. GL first,
CPU twin second. `out = mix(in, filtered, w)` for filters, `alpha *= w` for fill layers (depth source only). The painted
mask multiplies on top, as today. A document with a limit writes minReader 3. Limits can be set over MCP (`set_filter
{ params: { limit } }`); the row follows in R1-S8.

**Preconditions.** R1-S3b, F1, F3, F6 (`setLimitStage`, `filterInfo` / `filterKey` with `mapsVersion`, `applyParams`
for `limit`), F7 (scratch unit, static RG8 sampler, `SAMPLE_GLSL`), F8 (`passToMap`, `rg8View`). R1-D6 (a depth limit
without a map), R1-D7 (fills take a depth limit only), G5 (the reader bump).

**Changes.**

- `renderer/editor/inpaint_limit.js` (new, FILES):

  ```js
  export const LIMIT_SHADER = { label: "limit", uniforms: { u_in: "sampler2D", u_map: "sampler2D", u_hasMap: "int", u_source: "int", u_r: "vec4", u_inv: "int",
      u_ref: "vec3", u_tol: "float", u_m0: "vec4", u_m1: "vec2", u_over: "int", u_view: "int" },
    code: WEIGHTS_GLSL + SAMPLE_GLSL + `vec4 shade(vec4 c, vec2 uv) {
      vec4 i = texture(u_in, uv);
      vec2 pp = pictureUv(uv) * u_pictureSize;                 // pass px, origin included
      vec2 mp = vec2(dot(u_m0.xy, pp) + u_m1.x, dot(u_m0.zw, pp) + u_m1.y);   // passToMap(map, info.scale)
      float mv = u_hasMap == 1 ? u16Bilinear(u_map, mp) : 0.0;
      float w = (u_source == 0 && u_hasMap == 0) ? 0.0 : w_limit(u_source, i.rgb, mv, u_r, u_inv == 1, u_ref, u_tol);
      if (u_view == 1) return vec4(vec3(w), 1.0);
      return u_over == 1 ? vec4(c.rgb, c.a * w) : mix(i, c, w); }` };
  export function limitStage(src, out, limit, info, def) -> canvas | GLSurface
  export function limitStageCPU(srcCanvas, outCanvas, limit, info, over) -> canvas
  export function limitAlphaRows(rgba, x0, y0, w, h, limit, map)   // fills' bake, in place
  setLimitStage(limitStage);   // at import
  ```

  - **Names.** The uniform is `u_source`, never `u_src`: `u_src`, `u_size`, `u_tile`, `u_scale`, `u_seed`, `u_dstTop`,
    `u_pictureSize` and `u_pictureOrigin` are reserved (`inpaint_filters_gl.js:960-967`). `u_in` is sampled at the
    `uv` that `shade` gets, as film's halation samples its `u_blur`.
  - **Shortcuts.** `out === src`: return `src` (never release the caller's input). A limit that is 1 everywhere (`lo ≤
    0`, `hi ≥ 1`, no invert): return `out`. A depth source without `info.maps.depth`: return `src` (no effect, R1-D6)
    and set `info.limitMissing = true`.
  - **GL.** `runShader(LIMIT_SHADER, out, { u_in: src, u_map: map ? rg8View(map) : null, ... }, info)` inside the
    caller's `beginScope` / `endScope`; samplers on plugin units 5 and 6 (F7 moved the scratch binds off 6 and 7).
  - **CPU.** When GL throws or `info.cpu`: `limitStageCPU(glToCanvas(src), glToCanvas(out), …)`, per pixel with F3's
    `limitWeight` and `u16Bilinear` at pixel centres `origin + (x + 0.5, y + 0.5)`; mix in 0..255 floats, then round
    (q8, as the GL path stores).
  - `info.limitView` sets `u_view` (R1-S10).
- `inpaint_canvas.js`: `import "./inpaint_limit.js"`. `fillLayerCanvas` (:12321) and `fillLayerRows` (:12331): with
  `l.params.limit`, `limitAlphaRows(rows, 0, y0, W, y1 - y0, limit, this.maps.depth)` per band, so PSD and ORA carry the
  limit in the fill layer's alpha. `filterInfo` carries `maps`; `filterKey` already appends `mapsVersion` for depth
  limits. `setFilterType` keeping the limit for a fill type drops a luma or colour limit with a status note.
- `renderer/commands.js`: `add_filter` / `set_filter` on a fill with `limit.source !== "depth"` throws `a fill layer
  takes a depth limit only`; a sentence in the `set_filter` description; `layerSummary` shows the limit (it is in
  params).
- `electron/main/docfile.js` FEATURES: `{ id: "filter-limit", since: "0.1.N", reader: 3, sample: { layers: [{ kind:
  "filter", params: { limit: { source: "luma", lo: 0, hi: 1 } } }] }, test: (d) => layersOf(d).some((l) => l && l.kind
  === "filter" && l.params && l.params.limit) }` (the reader number per §1.2).
- `tools/export_test.py` exportperf: `--limit=<source>:<lo>:<hi>:<fLo>:<fHi>[:inv]` beside `--filter=<id>` (:1096,
  :1160; parse with `split("=", 1)`): a JSON value cannot pass the runner (§2). A depth source installs a synthetic
  ramp map (`--map=<w>x<h>`, default 4096 x 2731) through `setMap` first, or the limit has no effect (R1-D6).
  `tools/perf_test.py`: the same two options on its filter layer (R1-S11's in-view measurement).

**Tests (normal, both backends: a pixel path changes).** The `limit` gate, `--offline`, `--tiles on` and `off`:

| # | Case | Expected |
|---|---|---|
| 1 | No limit anywhere | composite references byte-identical (`composite --strict` on both backends) |
| 2 | `levels` with limit luma .3-.7, f .1, on a grey ramp; then depth on the ramp map; then colour | `compareFilterPaths` max ≤ 2, over2 ≤ 0.1 % for each source |
| 3 | Box [400,300,800,600] of a 1600 x 1200 document: region pass at 1:1, whole flatten, PNG export in bands (`glTestLimits({ maxDraw: 1e6 })`) | the three agree ≤ 1 (pointwise stage, origin right) |
| 4 | Depth limit, no map | output equals the picture without the layer; `limitMissing` reported |
| 5 | Case 4, then `setMap` | the effect appears with no manual refresh (the key moved) |
| 6 | `rotate_canvas 90` | the weight at two probes equals the pre-turn weight at the turned points (±2) |
| 7 | Fill layer + depth limit | fill alpha = `round(255 w)` ±1; the PSD layer's alpha ±1 (`layered` reader); ORA too |
| 8 | Two filter layers, the first limited, `FILTER_CHAIN` on against off | ≤ 2 |
| 9 | Painted mask hiding the left half + limit | the effect only in the right half where w > 0 |
| 10 | `film.look` with a luma limit | GPU against CPU within `gpu_vs_cpu`'s tolerance (max ≤ 4, over2 ≤ 0.1 %), in the `film` gate |
| 11 | Clipped filter layer with a limit | `mix(in, filtered·w, baseAlpha)` at 3 probes ±2, in the `clip` gate |
| 12 | `.scumble` with a limit | header `minReader 3`; an empty document 1 / 1 (F1's loop covers it through the row's sample; the explicit `readerFor` case in `document_test.js` catches a deleted row) |
| 13 | `exportperf:15000x10000,--filter=levels,--limit=depth:0:0.5:0:0.05` with a 4096 map | within 10 % of the same export without the limit; recorded |

Gates `limit`, `composite` (both backends), `film`, `export`, `fill`, `clip`, `groups`, `document`, `commands`,
`assistant`, `lint`, `types`, `nodecopy`. No mutation round (normal tier); the parity steps are written so that each of
these slips fails one of them: `mapsVersion` dropped from `filterKey` (case 5), `maps` missing from `bandFilter`'s info
(case 3), `fLo` / `fHi` swapped in the GLSL (case 2).

**Docs.** CHANGELOG: "**Limit a filter layer by depth, brightness or colour.** A filter layer acts only where the
picture lies in a chosen range, with soft ends, and its painted mask still refines it. A colour or haze that grows with
distance is a fill or filter layer with a depth limit. Documents with a limit open in Scumble 0.1.N and newer."
DOCUMENTS.md: §4.1 filter row (`params.limit`) and §8 (F1's table). MANUAL *Filter layers*: the stage in a sentence.

**Risks.** Above 33 MP `renderTiled` runs: case 3 forces it with `glTestLimits`. A context loss drops the map texture:
F7's cache re-uploads per gen. A backtick inside the GLSL template's comments ends the JS string; check the written
file for stray non-ASCII. `fillLayerCanvas` is W x H already; the limit adds no canvas. The node gets the module through
FILES; a host without it passes `out` through.

**Effort.** R1-S7a 1 d, R1-S7b 0.5 d.

#### R1-S8: Limit on filter layers, the row

**Goal.** Every filter layer's row (`buildFilterControls`, `inpaint_canvas.js:15270`) ends with a "Limit" block: a
source select (Off | Depth | Luminosity | Colour; fills Off | Depth); the range bar with a histogram of what lies below
(depth `mapHistogram`; luma `belowHistogram(layer).luma`; colour R1-S6's similarity histogram over F9's
`belowSample(layer)`); invert, a colour
swatch and tolerance, an eyedropper; for Depth without a map an inline *Compute depth map*; a "needs a depth map" note
while `limitMissing`. Drags preview live; one undo step per drag ("Filter limit").

**Preconditions.** R1-S4, R1-S6 (`pickOnce`, `similarityHistogram`), R1-S7.

**Changes.** `buildFilterControls`: after the param loop (:15327-15446), `buildLimitBlock(layer)` with the curves
pattern's callbacks (:15330-15340): begin `layer._undoPending = this.snapshot({ kind: "filter", id: layer.id })`,
`stepLabel = "Filter limit"`; preview `layer.params = { ...layer.params, limit: normalizeLimit({ ...cur, ...r }) }`
(always a new object: the snapshot is shallow), `this.filterPreview = layer.id`, `markFilterChanged(layer, { soon: true
})`; commit `pushUndoSnapshot(layer._undoPending)`; stop `filterPreview = null`, `markFilterChanged(layer)`. Source Off
removes `params.limit` (`delete` on a copy). The eyedropper reuses R1-S6's `pickOnce` with a target callback.

**Tests (normal).** `limit_test.py` "row" group, `--tiles on`: the block exists for a filter layer, a fill layer lists
Off and Depth only; `bar.set` through begin, preview ×3, commit gives one undo step, `params.limit` is a new object at
each preview (identity check), undo restores the old limit object; Off removes it and `list_layers` shows no limit.
Gates `limit`, `skins`, `help`, `lint`, `types`, `nodecopy`; one look.

**Docs.** MANUAL *Filter layers and the film pack*: a paragraph on the Limit row with a step "darken the far half" (a
curves layer with a depth limit of .5-1, feather .1). CHANGELOG: extend R1-S7's line with "set in the layer's Limit
row".

**Risks.** `filterPreview` gives the 1024 px preview on the full-size path only (region passes already run at screen
resolution). Read the histogram once per begin, never per drag frame.

**Effort.** 1 d.

#### R1-S9: Object tool box drag, `select_point` without W x H masks, Intersect hints

**Goal.** Dragging a box with the Object tool selects the object in it through SAM2 with a box prompt, with no
automask first; Shift adds, Alt subtracts, Shift+Alt intersects, and a plain drag adds like the click (R1-D9). The click
on an empty spot and `select_point` use the same path: logits from main mapped per tile, never a W x H `Uint8Array` or
canvas (fixes about 750 MB at 15k). Every "Shift adds, Alt subtracts" hint mentions Shift+Alt (the rest of F4's
Intersect). The user sees a rubber band while dragging and the object selected on release.

**Preconditions.** R1-S5a (the `range_select` op and the banded rule), F4.

**Changes.**

- `electron/main/onnx/index.js` `segment` (:217): with `req.raw === true` return `{ logits: Float32Array(65536) /*
  sam.predict's best */, n: 256, score, provider, model, label }` without `logitsToMask`.
- `inpaint_worker.js` `range_select`: `source: "logit"`. Per pixel `lp = m · (x + .5, y + .5)` with `m` mapping image
  px to the 256 grid (`256/W`, `256/H`, −0.5), bilinear with edge clamp, `alpha = v > 0 ? 255 : 0`; with `clip`,
  multiplied by the layer's `alpha > 0` read from its store rows. Bands only over the box of positive logits plus one
  cell; for intersect the writer first runs `sel.combine(rectSource(box), "intersect")` (F4's rule) so the outside is
  cleared.
- `renderer/editor/host.js`:

  ```js
  async segmentKey(editor, layer) -> { key, image | null }   // reuses editor.objects.hash when it matches; else `${editor.node.id}:` + (layer ? `layer:${layer.id}:` : "image:") + inputHash(objectInput(editor, layer)); cached per compositeVersion
  async segmentLogits(editor, points /* image px */, box /* image px | null */, layer) -> { logits, n, score }   // helpers:segment { raw: true, key, points/box in 1024 space }, the image sent only when main lost the embedding (the catch at :2864)
  async selectBox(editor, box, { mode }) -> void
  ```

  `selectPoint` (:2885) → `segmentLogits` + `editor.selectLogits`, keeping the toggle rule (subtract when the clicked
  pixel is already selected and no modifier). `segmentPoint` stays only if something else calls it (grep); otherwise it
  leaves host and typedef. The node's `js/host.js`: `async selectBox() {}`.
- `inpaint_canvas.js`: pointer down (:5322) `{ kind: "object", start, startImg: [ix, iy], curImg: [ix, iy], moved:
  false, mode: selModeOf(e, "add"), shift, alt }`; move (:5542) `p.curImg = [ix, iy]`; up (:5792): moved and ≥ 4 image
  px each side → `host.selectBox(this, box, { mode: p.mode })`, else `toggleObjectAt` as today; `drawSceneOverlays`: a
  dashed rectangle from `startImg` to `curImg` (`#4a90d9`, `setLineDash([6/s, 4/s])`) while `p.kind === "object" &&
  p.moved`; `async selectLogits(res, { mode, label = "Object selection", layer })`: the banded combine of R1-S5 with
  `source: "logit"`, status "Selected what SAM2 sees in the box (12 % of the picture, score 0.93)".
- `renderer/commands.js` `select_point` (:594): drop the `ensureObjects` wait; `mode: P.selMode()`; needs only
  `host.objectsInApp()`; uses `segmentLogits` + `selectLogits`; returns `{ selection, score }`. Policy unchanged
  (AUTO); the clamp line (`policy.js:299`) stays (an embedding under VRAM pressure can take long).
- Intersect hints: the 11 strings `Shift adds, Alt subtracts` in `renderer/` (grep at `b6c5238`: 6 in
  `inpaint_modal.js`, 3 in `inpaint_canvas.js`, 2 in `host.js`) become "Shift adds, Alt subtracts,
  Shift+Alt intersects", and the Load button title (`inpaint_modal.js:591`).

**Tests (normal).** `selection_test.py` "object" group, `--tiles on`. Stand-in: `host.sam2Model` and
`host.helperCall("segment", { raw: true })` return a logit disc (+8 inside a circle of radius 40 grid cells around the
box centre in 256 space, −8 outside) and record the box.

| # | Case | Expected |
|---|---|---|
| 1 | Real-pointer drag from (400,300) to (1200,900) on 1600 x 1200 | stand-in box ≈ [256,256,768,768] in 1024 space (±1); `objects` not called; 255 inside the disc's image circle and 0 outside at 8 probes (2 px off the edge) |
| 2 | A second drag | no image sent (key reused) |
| 3 | Shift+Alt drag over an existing selection | intersect at the probes, and the outside of the box cleared |
| 4 | Plain click on an empty spot | still selects through `segmentLogits`; the `editor` gate's object steps stay green |
| 5 | 15000 x 10000 + `select_point` | no `Uint8Array` ≥ W·H and no canvas over 64 MB (hooks on `makeCanvas`, `memoryReport`); time recorded |
| 6 | Embedding lost (the stand-in throws once without an image) | retried with the image |

Gates `selection`, `editor` (object steps), `commands`, `assistant`, `mcp`, `help` (the hint strings in the manual),
`lint`, `types`, `nodecopy`.

**Docs.** CHANGELOG: "**Drag a box with the Object tool** to select the object in it (Shift adds, Alt subtracts,
Shift+Alt keeps only the overlap); a click or a box on a very large picture no longer builds a full-size mask in
memory. **Shift+Alt** intersects with every selection tool." MANUAL *Selecting* (box drag, Intersect) and *Keyboard
shortcuts* (Shift+Alt). HELPERS.md: "Not done" loses "Box prompts in the object tool"; `segment`'s `raw` answer.
COMMANDS.md regenerated (`select_point` no longer runs the object finder first).

**Risks.** A hard edge at logit 0, evaluated bilinearly at image resolution, is crisper than today's nearest from a 2048
grid but not identical: the click's look changes slightly (R1-D9). Layer mode: the old path clipped to
`layerAlpha(layer)` (a W x H read); the `clip` store read keeps that rule without one.

**Effort.** 1-1.5 d. **Split point** if it runs long: commit after main's raw logits, `segmentLogits`,
`selectLogits` and `select_point` (cases 4-6); the box drag, its overlay and the hints (cases 1-3) follow.

#### R1-S10: layer-mask overlay, black-and-white view, a filter's effect view

**Goal.** A layer's mask can be seen as a red overlay on the picture (red where the mask hides, R1-D10), alone in black
and white, and for a filter layer with a limit as its effect (mask × weight, grey). Controls: Alt+click on the mask
label (black and white) and the mask menu (all three). No default key: `\` is taken (held, it peeks at the base
picture, `onKey` :3098), and R1-D10 may name a free one. The view never changes an export.

**Preconditions.** R1-S7a (the stage's `u_view`).

**Changes.** `inpaint_canvas.js`:

- `drawMaskInto(ctx, layer, scale, region, display = true)`, modelled on `drawSelectionInto` (:2094): `regionCanvas` of
  the layer's `maskPx` at `tileLevel`, placed at the layer's rect (paint / image: `layer.x, y, w, h` scaled by `w /
  maskPx.width`; filter: the whole image); `displaySource` on canvases. `applyFilterLayer`'s own mask draw is left
  alone: this is screen-only code.
- `this.maskView = null | { id, mode: "overlay" | "alone" | "effect" }`. `drawSceneOverlays`: `overlay` = a
  `passScratch("maskOverlay", vw, vh)` filled red, `destination-out` the mask, drawn at 0.5 (the scratch is the
  viewport's size, so the whole-canvas op is intended); `alone` = black over the layer rect, then white × mask (a
  scratch filled white, `destination-in` the mask), opaque.
- `effect`: `filterInfo` sets `info.limitView = true` when `!forRun && this.viewPass && this.maskView &&
  this.maskView.mode === "effect" && this.maskView.id === layer.id`, and `filterKey` includes the flag;
  `applyFilterLayer` fills black under the layer's region first in that case only.
- `maskView` clears when its layer goes or loses its mask. The mask label (:15187): Alt+click toggles `alone`; it reads
  "mask ◐" while viewed. `openMaskMenu`: "Show as overlay", "Show alone", "Show the effect" (filter layer with a
  limit), "Hide the view". A key only if R1-D10 names one (check `onKey` and the MANUAL's key table for a free one;
  the `help` gate checks menu accelerators).

**Tests (normal).** New gate `tools/maskview_test.py`, `--tiles on`, plus `--tiles off` once: (1) a paint layer with its
left half masked, overlay on: a screen probe in the left half has R − G ≥ 40, one in the right half equals the view
without the overlay ±2 (state and pixel probes, no screenshot reference); (2) `alone`: probes 0 and 255 ±2; (3)
`effect` on a depth-limited levels layer: grey at two probes = `round(255 w)` ±2; (4) a PNG export with each view on
is byte-equal to the export with none; (5) 15000 x 10000 with the overlay on: no mirror over 64 MB; (6) removing the
layer clears `maskView`. Gates `maskview`, `limit`, `composite` (`--tiles on`, unchanged), `help`, `skins`, `lint`,
`types`.

**Docs.** MANUAL *Layers, masks and colour match*: a paragraph; *Keyboard shortcuts*: Alt+click on the mask label.
CHANGELOG: "**See a layer's mask.** Alt+click on its mask label shows it alone in black and white; the mask menu shows
it as a red overlay; a filter layer with a limit can show where it acts."

**Risks.** The effect view touches `applyFilterLayer`: guard on `!forRun && this.viewPass`; case 4 proves exports are
untouched. The mask label's click handler already uses Shift (mask off and on, :15190): Alt+click is free there.

**Effort.** 1 d.

#### R1-S11: checkpoint in the app, 15k measurements, docs pass

**Goal.** The release's features run on the user's pictures with the real model, the numbers are measured and written
down, and the docs agree. Nothing new is built.

**Preconditions.** R1-S1 to R1-S10. The user present. ComfyUI's `/queue` checked.

**Work.**

1. In the app (dev instance, own profile, `--no-comfy`) with the user, on `scene.jpg`, `skin.jpg` and the 15k file:
   compute depth (cold and warm, DML and CPU: time, provider); Select by depth near and far; a curves layer with a depth
   limit; a fill with a depth limit as haze; the box drag; the mask views. The user judges.
2. Staleness (R1-D11): `depthStale().diff` for a Remove stroke (2 % of the area), a pasted picture over 40 %, a colour
   grade of the whole picture, a crop plus extend. Set `STALE_DIFF`; the table goes into PLAN_NIK9.
3. 15k numbers (restart before each run): `docperf:15000x10000,--map=4096x2731` (F8b's synthetic ramp packs smaller
   than a real map, so also save and open the user's 15k document with its real map by hand and record size and
   time); `exportperf:15000x10000,--filter=levels,--limit=depth:0:0.5:0:0.05`;
   `perf:15000x10000,--limit=depth:0:0.5:0:0.05` (R1-S7b's options); `mem:15000x10000,--rounds,4,--map=4096x2731`
   (this session adds the `--map` option to `tools/mem_test.py`, test tooling only). Each against the same run
   without depth.
4. Docs. HELPERS.md: the depth module and model rows, the timings, the main-thread / process decision, the licence note
   (Apache-2.0; issue #320 open), "Not done" updated. DOCUMENTS.md: §4 `maps`, §4.1 `params.limit`, §8 table. MANUAL: a
   final pass over *Selecting*, *Layers, masks*, *Filter layers*, *Large pictures* (the depth map is at most 4096 px;
   edges stay soft at 15k until release 2), *Keyboard shortcuts* and *Settings* (the Helpers depth row). TESTING.md: the
   gates `selection`, `limit`, `maps`, `depth`, `maskview` and any flakes seen (date and what was ruled out). CLAUDE.md:
   the gate list and the hand-over. COMMANDS.md regenerated. The About dialog if it lists helper models' licences.

**Tests (light).** `help`, `lint`, `types`, `commands` (COMMANDS.md freshness), `assistant` (policy coverage).

**Effort.** 1 d.

#### R1-S12: the release

The release session of §1.3. Release-specific parts: the CHANGELOG section merges the session lines into five or six
items (depth map, select by range, Intersect, limit, box drag, mask views); exe gates on `--tiles on` add `depth
selection limit maps maskview document docux composite export film`, on `--tiles off` `selection limit composite fill`;
the look covers depth on the user's 15k file. 0.5-1 d.

Not in release 1, as planned: depth as a layer (gated on the control-layer finding, §2); the detail pass, edge snap,
haze and dehaze filters (release 2; haze can already be a fill plus a depth limit); limits in presets (ranges are per
picture); a ComfyUI depth route (the production server; `comfyui-depthanythingv2` auto-downloads a missing model).

### 5.2 Release 2: edges and depth filters

What the user gets (the research's release 2): the edge recipe's steps 2 and 4-6 (a detail pass, a full-resolution
edge snap, object snap by editing the map inside a selection, a refine brush), haze by depth, dehaze; lens blur only on
the user's word.

**Three changes to the research's design, each with its reason.**

1. **The edge snap is a joint bilateral sample, not a guided filter over a full-resolution mask.** One pure function,
   `snapField`, with a GLSL twin, reads the depth map at working resolution together with a **guide** (the photo on the
   map's grid). At each full-resolution pixel it weighs the 4 x 4 map texels around it by distance and by how close
   their guide colour is to the pixel's colour, and only where the map changes within those 16 texels (threshold `tau`:
   the research's "only inside a band where the depth changes"); everywhere else it is release 1's bilinear sample, byte
   for byte. The stage stays pointwise (reach 0, the chain stays plain), the sliders stay live, nothing full-size is
   stored at 15k (a full-resolution snapped mask would be 150 MB a layer), and the same function serves the Limit stage,
   Select by depth, haze, dehaze and lens blur. The research's guided filter stays as the reference in the bench
   (R2-S3); if it is clearly better on the user's pictures, that is R2-D3.
2. **Dehaze never runs a spatial filter at full resolution.** A whole-picture transmission field is computed once per
   composite version on a picture of at most 768 px (dark channel, airlight, guided filter in f32 over `boxBlurs`),
   handed in through F10's `wholeStats` function, and sampled per full-resolution pixel with the same `snapField`.
   Dehaze has reach 0, no band seams, no float GL surfaces, and avoids the halation export slowness (BUGS.md:336).
3. **Haze is its own built-in filter** `haze` (exponential transmission, a start depth, an automatic air colour). A
   colour fill plus a depth Limit gives a cruder haze with no new type (R2-D4).

**Preconditions for the whole release.** Release 1 is built (R1-S1 to R1-S11 with F1-F9): `this.maps.depth`, `setMap`,
`mapsVersion`, `passToMap`, `sampleMap`, `rg8View`, `mapToJSON` / `mapFromJSON`, `params.limit` and
`inpaint_limit.js` (R1-S7), the `range_select` job (R1-S5), F4's `combine`, F5's `pictureInput` and `skipFilters`, F7's
`SAMPLE_GLSL`, static cache, `G.uploads` and scratch unit, F1's rows, F2's checks, F9's range bar, `helpers:depth` and
`host.depthSupported` (R1-S1, R1-S3), the `depth_guide` job (R1-S3). The model is downloaded on the user's machine.
R1-S2's checkpoint exists. Release 1 persists the working map (R1-S3), which release 2's edits change.

**Gate rules.** Every gate `--offline` (the map and guide PNGs are uploads). No gate needs the real model. New steps go
into two new gates, `edges` and `depthfx`.

#### 5.2.1 Shared design of release 2

**The DocMap after release 2** (extends F8):

```js
/** @typedef {{
 *   kind: "depth", w, h, data: Uint16Array /* never written after makeMap; "far": 0 near .. 65535 far */,
 *   guide: Uint8Array | null   /* NEW: RGBA8 w*h*4, the picture without filter layers on the map's grid (alpha 255), never written */,
 *   xf: number[6], ref, guideRef /* NEW: {filename, subfolder, type} of the guide PNG */, version, dataVersion, guideVersion /* NEW */,
 *   meta: { model, label, lo, hi, fp, time, provider, seconds, input, guided,
 *           snap?: { strength: 0..100 },                  // NEW (R2-S4): 0 or absent = release 1's bilinear, byte for byte
 *           detail?: { route: "standard"|"large"|"tiles", grid: 1|2|3, size: [wf, hf], tiles: n, dropped: n },   // NEW (R2-S7)
 *           edits?: number,                                // NEW (R2-S8 to S10): count, informational
 *           source?: "model" | "layer", layer?: string }   // NEW (R2-S11)
 * }} DocMap */
```

- JSON in `getValue`: `maps: { depth: { ref, guide /* NEW ref */, w, h, xf, enc: "u16rg", genc: "rgba8" /* NEW */, meta
  } }`. Refs need no docfile code (`collectRefs`, `referencedFileKeys` find any ref anywhere in the state).
- New in `inpaint_maps.js`: `deriveMap(map, { meta, data, guide })` returns a new DocMap sharing every array it is not
  given; `ref` / `dataVersion` carry over when `data` carries over, `guideRef` / `guideVersion` when `guide` does. A
  meta-only change therefore uploads nothing and keeps F7's static texture keys (`rg8View` keys on `dataVersion`,
  `guideView` on `guideVersion`).
- `setMap` uploads only what has no ref yet.
- Undo bytes: a `maps` step reports as `bytes` the previous map's arrays the live map does not share; a meta-only step
  is 0, an edit step `data.byteLength` (the existing `snap.bytes` / `maxUndoBytes` accounting, `inpaint_canvas.js`
  :11494-11503).

**The snap sample** (R2-S2's pure module; used by R2-S5, S6, S12, S14, S15):

```glsl
// renderer/editor/inpaint_edges.js -> export const SNAP_GLSL (needs F7's SAMPLE_GLSL and F3's w_sstep)
vec3 snapRgb(sampler2D g, ivec2 p) { return texelFetch(g, clamp(p, ivec2(0), textureSize(g, 0) - 1), 0).rgb; }
// mpx: continuous map pixels (centres at +0.5, F3's convention); c: the full-resolution pixel's colour 0..1;
// snap.x = sigmaR (<= 0: off, the bilinear sample), snap.y = tau (depth range that counts as an edge)
float snapField(sampler2D map, sampler2D guide, vec2 mpx, vec3 c, vec2 snap) {
    float bil = u16Bilinear(map, mpx);
    if (snap.x <= 0.0) return bil;
    vec2 q = mpx - 0.5; ivec2 i0 = ivec2(floor(q));
    float lo = 1.0, hi = 0.0;
    for (int j = -1; j <= 2; j++) for (int i = -1; i <= 2; i++) { float d = u16At(map, i0 + ivec2(i, j)); lo = min(lo, d); hi = max(hi, d); }
    float k = w_sstep(snap.y, 2.0 * snap.y, hi - lo);
    if (k <= 0.0) return bil;
    float sw = 0.0, sd = 0.0, inv = 0.5 / (snap.x * snap.x);
    for (int j = -1; j <= 2; j++) for (int i = -1; i <= 2; i++) {
        ivec2 p = i0 + ivec2(i, j); vec2 dd = vec2(p) - q;        // unclamped offset, clamped fetch
        vec3 e = c - snapRgb(guide, p);
        float w = exp(-0.5 * dot(dd, dd)) * exp(-dot(e, e) * inv);  // sigmaS = 1 map px
        sw += w; sd += w * u16At(map, p);
    }
    return mix(bil, sw > 1e-6 ? sd / sw : bil, k);
}
```

JS twin `snapField(map /* {data: Uint16Array, w, h} */, guide /* Uint8Array RGBA */, mx, my, r, g, b, sigmaR, tau)`:
the same loop order in f64; with `sigmaR <= 0` it returns F3's `u16Bilinear(...)` exactly. `snapParams(strength) ->
[sigmaR, tau] | null`: `sigmaR = mix(0.25, 0.04, strength / 100)`, `tau = SNAP_TAU` (0.02 proposed, R2-S3 measures).
**The constants are frozen at the release**: changing them later changes saved documents' pictures and needs a reader
bump.

**Pass pixel to map pixel.** F8's `passToMap` and its GLSL form (§4 F8): `pp = pictureUv(uv) * u_pictureSize` (=
`u_pictureOrigin + uv * u_size`), `mpx = vec2(dot(u_m0.xy, pp) + u_m1.x, dot(u_m0.zw, pp) + u_m1.y)`; CPU twins at
`(origin[0] + x + 0.5, origin[1] + y + 0.5)`.

**Texture units (after F7).** Plugin-path samplers start at 5; the scratch unit is the top one. Limit stage: `u_in` 5,
`u_map` 6, `u_guide` 7. haze: `u_map` 5, `u_guide` 6. dehaze: `u_t` 5, `u_tguide` 6, `u_map` 7, `u_guide` 8.

**Filter definitions read maps** (R2-S12): `FILTERS[id].maps?: (params) => string[]` names the map kinds a filter reads
(haze `() => ["depth"]`; dehaze `(p) => p.mode === "depth" ? ["depth"] : []`). `InpaintEditor.mapsOf(layer)` returns
the union of `def.maps(params)` and `params.limit.source === "depth" ? ["depth"] : []`, and is used by `filterKey`
(appends `mapsVersion` when non-empty), `setMap`'s change marking, `belowStats`' slot version (F10), and the type select
(skips types whose `maps({})` holds "depth" unless `host.depthSupported` or it is the layer's current type).

**The `skip` hook** (R2-S12 or R3-S4, whichever comes first): a built-in registered through `registerGLFilter` may have
`skip(params, info) -> boolean`; the first line of `applyPluginGL` (`inpaint_filters_gl.js:1026`) becomes `if
(pg.def.skip && pg.def.skip(params || {}, info)) return isGLSurface(src) ? src : copyCanvas(src);` (mirroring `ok ===
false` at :1104). Internal, not documented for plugins.

**FEATURES rows of release 2** (F1), all at the release's reader number R (§1.2):

```js
{ id: "depth-snap", since: "0.1.N", reader: R, sample: { maps: { depth: { meta: { snap: { strength: 50 } } } } },
  test: (d) => { const m = d && d.maps && d.maps.depth; return !!(m && m.meta && m.meta.snap && m.meta.snap.strength > 0); } },
{ id: "haze",   since: "0.1.N", reader: R, sample: { layers: [{ kind: "filter", filter: "haze" }] },   test: (d) => layersOf(d).some((l) => l && l.kind === "filter" && l.filter === "haze") },
{ id: "dehaze", since: "0.1.N", reader: R, sample: { layers: [{ kind: "filter", filter: "dehaze" }] }, test: (d) => layersOf(d).some((l) => l && l.kind === "filter" && l.filter === "dehaze") },
// R2-S15 only on the user's word: { id: "lens-blur", ... }
```

The detail pass, edits and depth from a layer change only the map's data, which an older reader shows correctly: no
row. The guide alone (snap 0) is an optional field: no row.

#### R2-S1: F10 with its release 2 extension

Build F10 (§4) if it is not built, including `wholeStatsSize` and the `ctx` argument (G7). If release 3 built F10
without the extension, add only `wholeStatsSize`, the `ctx` argument and the slot version, with F10's tests for them.
0.5-1 d.

#### R2-S2: the edge maths as a pure module

**Goal.** `renderer/editor/inpaint_edges.js` (`// @ts-check`, no DOM at import, FILES) holds the snap sample (JS and
GLSL), the least-squares fit and tile fusion of the detail pass, and the edge-tile finder, all testable in plain Node.
Nothing calls it yet; the user sees nothing.

**Preconditions.** F3 (`w_sstep`, `u16Bilinear`), F7 (`SAMPLE_GLSL`).

**Changes.**

```js
export const SNAP_TAU = 0.02;                  // set by R2-S3
export const SNAP_DEFAULT = 50;                // R2-D2
export function snapParams(strength) -> [sigmaR, tau] | null
export function snapField(map, guide, mx, my, r, g, b, sigmaR, tau) -> 0..1      // the twin of SNAP_GLSL
export const SNAP_GLSL
/** detail pass (R2-S7) */
export function tileBoxes(W, H, grid /* 2|3 */, overlap = 0.25) -> [{ x0, y0, x1, y1 }]
//   equal boxes (Tw = W / (g - (g-1)·o), likewise Th), x_i = round(i·(W - Tw)/(g - 1)): every tile has the picture's
//   aspect, so the model input has the global pass's shape (one DirectML compile)
export function fusedSize(W, H, boxes, modelShort = 518) -> [wf, hf]   // sf = min(1, modelShort / min(Tw, Th)), long side capped at 4096
export function fitScaleShift(t /* f32 */, g /* f32 */, n, mask = null) -> { a, b, r2, used }
//   least squares of a·t + b ≈ g; a second pass drops the residuals above the 90th percentile
export function fuseTiles(global /* {data f32, w, h} */, tiles /* [{ box, data f32, w, h }] */, W, H, wf, hf, { sigmaLow } = {}) -> { data: Float32Array(wf·hf), fits: [{a, b, r2, dropped}] }
//   Gf = bilinear(global → wf×hf); per tile: Ti = bilinear(tile → its box on the fused grid); fit on gauss(Ti, sigmaLow) against Gf;
//   a <= 0 or r2 < 0.5 → dropped (weight 0); Hi = (a·Ti + b) − gauss(a·Ti + b, sigmaLow) on the box (clamped edges);
//   weight = rampX·rampY (raised cosine over the overlap; 1 on sides that touch the picture's edge);
//   out = gauss(Gf, sigmaLow) + Σ w·Hi / max(Σ w, 1e-6); sigmaLow default 1.5 · (sf / sg) fused px (the global map's texel)
export function rangeMax(map /* {data u16, w, h} */) -> Uint16Array(w·h)   // max − min over each texel's 4×4 block (i0−1 .. i0+2), separable max/min: edgeTiles' cached input
export function edgeTiles(map, rmax, xfInvToMap /* doc px → map px affine */, W, H, tau, tile = 256) -> Uint8Array(ceil(W/256)·ceil(H/256))
//   1 where any texel under the tile (plus 2 texels) has rmax > tau·65535
```

Gaussian blurs use Kovesi radii over `px/kernels.js` `boxBlurs` (:97): factor `gaussRadii(sigma)` out of `stitch.js`
`gaussBlur` (:111-121) (preferred: one twin) or copy it with a comment. New `tools/edges_test.js` (plain Node).

**Tests (light).** `node tools/edges_test.js`, `lint`, `types`, `python tools/build_node.py --check` (FILES).

| Case | Input | Expected |
|---|---|---|
| off equals bilinear | 1,000 random points on a 37 x 23 random map, `sigmaR = 0` | `=== u16Bilinear` |
| flat map | every texel 30000, any colour, strength 100 | 30000 / 65535 within 1e-12 (k = 0) |
| step snaps by colour | 16 x 16 map: x < 8 → 0.2, x ≥ 8 → 0.8; guide red for x < 8, blue for x ≥ 8; strength 100 | at mx = 8.3 with blue ≥ 0.79; at mx = 7.7 with red ≤ 0.21 (bilinear gives 0.38 / 0.62) |
| monotone in strength | the step, mx = 8.3, blue, strengths 0 / 25 / 50 / 100 | \|v − 0.8\| strictly decreasing |
| fit exact | t random, g = 0.4 t − 0.12 | \|a − 0.4\|, \|b + 0.12\| < 1e-9 |
| fit robust | the same with 10 % outliers (+0.5) | errors < 1e-2 |
| fuse better than global | ground truth 1200 x 800: three planes, an 8 px pole, sine texture; global = GT blurred (σ 6) to 300 x 200, × 1.7 + 0.2; tiles (2 x 2) = GT blurred (σ 2) per box at fused scale, each with its own scale and shift | MAE (after a least-squares fit to GT) ≤ 0.6 × the global's; pole contrast ≥ 50 % of GT's |
| no seams | the fused map above | max \|∂x\| on the overlap borders ≤ 1.5 × the median \|∂x\| within 8 px |
| dropped tile | one tile with a = −1 | `fits[k].dropped`; fused equals the upsampled lowpass global where only that tile covers, within 1e-6 |
| edge tiles | a 400 x 300 map with one vertical step, doc 1600 x 1200, identity xf | only the tile column of the step's doc x (± 1 column) is 1; under a 90° xf the flagged set is a row |
| tileBoxes | W = 6000, H = 4000, g = 2, o = 0.25 | 4 boxes 3429 x 2286, all equal, union = the picture |

**Risks.** The Write tool's `\u0080` trap (check for stray non-ASCII); a backtick inside the GLSL template's comments;
`node --check` on an ES module reports nothing (the test's import is the real check); `boxBlurs` uses clamped edges with
a fixed n, so every brute-force reference uses the same edge rule.

**Effort.** 1 d.

#### R2-S3: the bench on the user's pictures (the decision session)

**Goal.** Measure which detail route is worth building, the snap's constants (`SNAP_TAU`, the sigmaR range, 4 x 4
against 3 x 3 taps), whether snap is enough against the research's full-resolution guided filter, and the costs at
15k. The results go into `docs/PLAN_NIK9.md`; the user decides R2-D1, R2-D2 and R2-D3 from side-by-side crops
delivered as files.

**Preconditions.** R2-S2, the model downloaded, R1-D3 (the user's 15k file and whether crops may go into the plan), an
empty `GET /queue` on 8188 before any model run (read only).

**Changes.**

- New `tools/depth_bench.py` (a dev tool, not a gate) driving a dev instance (`--no-comfy`, own scratch profile, never
  the user's), its *Settings › Helpers* folder pointed read only at the folder R1-S1 downloaded into.
- Per picture (`scene.jpg`, `skin.jpg`, the 15k file): (1) the global pass, raw model ms and the DirectML cold-compile
  ms per new shape; (2) the large input at long side 1036, 1400 and 1568 (multiples of 14 inside R1-S1's bound of
  14..2058 per side, so `helpers:depth` takes them unchanged and no product code changes); (3) tiles 2 x 2 and 3 x 3
  through `fuseTiles`; (4) snap at
  strengths 0, 25, 50, 100 and tau 0.01, 0.02, 0.04, with 4 x 4 against 3 x 3 taps, through `runShader` with
  `SNAP_GLSL` over a synthetic limit (`levels` to black, a near range); (5) the reference: the research's colour guided
  filter on the bilinear mask at full resolution inside the edge band, CPU f32 code in the bench only, on crops.
- Costs: the GL ms of a 1:1 view pass of 2560 x 1440; an export of the 15k file with a limited layer
  (`exportperf:15000x10000,--filter=levels,--limit=depth:0:0.5:0:0.05`, R1-S7b's options); the edge-tile share at 15k;
  guide bytes and the memory report (`mem:15000x10000,--rounds,4,--map=4096x2731`, R1-S11's option).
- Output: `<scratch>/bench/<picture>/{routes,snap}_*.png` (3 crops per picture at the strongest depth edges, side by
  side), `bench.json`, and a section "Release 2 checkpoint (measured <date>)" in `docs/PLAN_NIK9.md` with the table and
  the user's answers.

**Tests.** A measurement; `lint` and `types` if `export_test.py` changed. For the synthetic scenes the bench reports
R2-S5's edge-band metric.

**Risks and what to measure first.** The cold DirectML compile for each new shape (tiles share the global pass's shape
only at the picture's aspect, which `tileBoxes` guarantees). The model on the main thread (R1-S1's decision): with 9
tile runs on the CPU fallback the window could block 10-30 s, so if R1-S1 kept the main thread, R2-S7 must not ship 3 x 3
without moving `depth.js` into a utility process first (R1-S1b). Snap copying texture into flat depth where the guide is busy:
the `tau` gate should prevent it; measure the false-edge share (edge tiles in flat regions). The guide at 15k is about
45 MB of JS memory plus a 45 MB texture (R2-D10).

**Effort.** 0.5-1 d, mostly runs and the user's look.

#### R2-S4: the guide and the snap setting in the document (full tier)

**Goal.** A depth map carries its guide (the photo on the map's grid) and `meta.snap`. Both persist in `.scumble` and
the autosave, follow geometry and undo, and raise the reader through the `depth-snap` row. `depth_map` takes `edges`.
Nothing changes visually yet; `depth_map` reports `edges`.

**Preconditions.** R2-S2, R2-S3 (constants fixed), F1, F8, R1-S3. R2-D2 (the default strength), R2-D10 (the guide's
memory), G5.

**Changes.**

- `inpaint_maps.js`: `makeMap(kind, w, h, data, xf, meta, guide = null)` puts the guide on a SharedArrayBuffer like
  `data` when `crossOriginIsolated`; `deriveMap`; `mapToJSON` writes `guide: map.guideRef, genc: "rgba8"`;
  `mapFromJSON` loads the guide by `loadImageEl(viewUrl(ref))` and `getImageData` (exact at alpha 255); a missing guide
  file gives `guide = null` with `meta.snap` kept (consumers fall back to bilinear; status "the depth map's guide is
  missing; Recompute restores the edges"); `guideView(map) -> { data: map.guide, width: map.w, height: map.h, channels:
  4, static: true, key: `${map.kind}:${map.guideVersion}:guide` }` (F7's sampler value).
- R1-S3's producer (`computeDepthMap`): the guide is the same `host.depthInput(this, gw, gh)` (F5's `pictureInput` with
  `skipFilters`) that the guided upsample reads; keep its RGBA bytes and pass them to `makeMap(..., guide)`. New maps
  get `meta.snap = { strength: SNAP_DEFAULT }`.
- `setMap`: upload the packed map only if `!map.ref`, the guide only if `map.guide && !map.guideRef`, through
  `uploadCanvas(guideCanvas, `n${node.id}_depthguide`)` (hash-named, never overwritten). One `maps` step whose `bytes`
  counts only the arrays not shared.
- `setMapMeta(kind, patch, { preview = false, label = "Depth map edges" })`: `deriveMap(map, { meta: { ...map.meta,
  ...patch } })`. With `preview` it pushes no step: it keeps `this._mapUndoPending = prev` and bumps `mapsVersion`, as
  filter sliders do with `_undoPending`; without it one `maps` step from the pending previous map.
- `docfile.js` FEATURES: the `depth-snap` row.
- `commands.js` `depth_map`: `edges: P.int("edge snap strength 0..100; 0 keeps the plain sample", { minimum: 0,
  maximum: 100 })`; with `recompute` it seeds the new map, without it calls `setMapMeta`; the answer adds `edges:
  (meta.snap && meta.snap.strength) || 0, guide: !!map.guide`. COMMANDS.md regenerated.
- `docs/DOCUMENTS.md` §4: `guide`, `genc`, `meta.snap`; §8 the row.

**Tests (full: both backends plus a mutation round).** The `maps` gate, `--offline`, `--tiles on` and `off`:

1. A synthetic map 300 x 200 (ramp) with a synthetic guide (an RGB gradient), set with snap 50; save `.scumble` and
   open: unpacked data equal, guide bytes equal (every byte), `meta.snap.strength === 50`.
2. The same through an autosave restore (the `quit` gate's restart pattern).
3. `depth_map { edges: 0 }` then `{ edges: 70 }`: `map.data` and the guide are the same objects (`===`), no upload
   (`uploadCanvas` calls: 0), one `maps` step each, undo restores 0 then the original 50, `undoBytes` unchanged.
4. `rotate_canvas 90` then undo: the guide object unchanged (`===`), xf turns back.
5. A recompute: after the next save, the old guide's file key drops out of `host.referencedFileKeys`.
6. Headers: snap 50 writes `minReader === R`, snap 0 release 1's reader, a document without maps 1 / 1.

The `document` gate on both backends (F1's loop picks up the row; the row's explicit case in `document_test.js`,
`readerFor(sample) === R`, catches its deletion); `docux` once; `quit`; `docperf:15000x10000,--map=4096x2731,--guide`
(this session adds `--guide` to `tools/document_perf.py`) within 10 % of `docperf:15000x10000`. Mutation round (a
copied tree, a fresh instance per mutation): drop `guide` from `mapToJSON` (step 1 fails); make `deriveMap` copy `data`
(step 3's upload count fails); delete the `depth-snap` row (its explicit case and step 6 fail); swap R and B in the
guide upload (step 1 fails). Then `git diff --stat`.

**Docs.** HELPERS.md: the guide's size (`4 · w · h` bytes, 44.7 MB at 4096 x 2731). CHANGELOG with R2-S5's visible
effect.

**Risks.** The guide must be the picture without filter layers (F5), or a depth-limited filter feeds its own guide.
The guide PNG of a 4096 px map is a few MB per recompute and stays until mirror pruning. Never write `data` or `guide`
after `makeMap`.

**Effort.** 1 d.

#### R2-S5: the snap in the Limit stage and the effect view; the *Edges* slider

**Goal.** A depth-limited filter layer follows the picture's edges at full resolution, live, on the GPU, with an exact
CPU twin. An *Edges* slider in the depth map row sets the strength. A Limit by depth no longer leaves a soft, map-sized
halo along a person in front of a far background; *Edges* at 0 gives release 1's picture.

**Preconditions.** R2-S4, R1-S6, R1-S7, R1-S10, F7.

**Changes.**

- `inpaint_limit.js` (R1-S7): the program gains `u_guide: "sampler2D"` and `u_snap: "vec2"`, `SNAP_GLSL` prepended, and
  `float far = snapField(u_map, u_guide, mp, i.rgb, u_snap);` in place of `u16Bilinear(u_map, mp)`. Values `u_guide:
  map.guide ? guideView(map) : null`, `u_snap: snapParams(meta.snap && meta.snap.strength) || [0, 0]` (a missing guide
  gives `[0, 0]`). The CPU twin calls `snapField(map, map.guide, mx, my, r, g, b, ...)` with the input pixel's colour.
  The module comment says: the colour is **the filter's input** (the picture below the layer, lower filter layers
  included); the guide is the picture without filters.
- R1-S10's effect view goes through the limit stage and shows the snap by itself. R1-S6's *Show depth map* draws a map
  proxy image and stays bilinear (a preview; the Limit shows the snap).
- `inpaint_modal.js` (the Select by range block of R1-S6): in the depth source's map row an *Edges* range 0..100;
  `input` → `ed.setMapMeta("depth", { snap: { strength } }, { preview: true })` plus `drawSoon`, `change` → the same
  without preview; title "How closely depth follows the picture's edges; 0 is the smooth map"; hidden when
  `!host.depthSupported`.
- `filterKey` already appends `mapsVersion` for depth limits, so a slider move drops the caches.

**Tests (normal; both backends).** The `limit` gate, `--offline`, `--tiles on` and `off`. Scene 1200 x 800: left half
red (200, 40, 40), right half blue (40, 60, 200), edge at x = 600, 3 % noise; map 300 x 200, far 0.2 / 0.8 split at map
x = 150, blurred σ 2 map px; guide = the picture area-sampled to 300 x 200; layer `levels` (out white 0) with `limit {
source: "depth", lo: 0, hi: 0.5, fLo: 0, fHi: 0.05 }`.

- a. GL against CPU (`applyFilter(..., { cpu: true })` against the GL path, F6's hook): max ≤ 2, over2 ≤ 0.1 %.
- b. Edge accuracy against the true weight (1 for x < 600): within x ∈ [592, 608], the count of pixels with |w − GT| >
  0.25 with snap 50 ≤ ⅓ of the count with snap 0. Again with a `hue_sat` (hue 90) layer below: ≤ ½.
- c. Snap 0 against release 1: bytes identical to a run with `meta.snap` deleted, in the same session.
- d. Views agree: a 1:1 region pass, `flattenToCanvas`, and the banded `encodeComposite` (stack program): worst ≤ 3,
  and `export_test.py`'s `seamRows` shows no rows on the seams.
- e. Static cache: dragging *Edges* over 10 preview frames grows `G.uploads` by 0 (a preview changes `meta`, not the
  arrays; `deriveMap` keeps `dataVersion` and `guideVersion`).
- f. 15k: `new_canvas 15000x10000`, a 4096 x 2731 map plus guide, a limited layer; 10 view frames timed against snap 0
  (expected ≤ 1.3×, measured first); `memoryReport` shows no mirror over 64 MB.
- g. `G.scratchUnit > 8` asserted; one step with `glTestLimits({ maxDraw: 1e6 })` forcing `renderTiled`.

`composite` on both backends (FILTER_CHAIN on and off), `film` (plugin filters under a Limit), `lint`, `types`, `skins`
(the slider's CSS), `help`.

**Docs.** MANUAL *Selecting* (the depth part): "*Edges* sets how closely the depth follows the picture's own edges. At
0 the map is smooth, as the model made it; higher values let the transition snap to the edge between a subject and what
is behind it, which matters most at full size. It changes every filter limited by depth and every new selection by
depth." CHANGELOG: "**Depth edges.** A filter limited by depth now follows the picture's edges at full resolution: the
transition between near and far sits on the edge between a subject and its background instead of a soft band. *Edges*
in the depth map row sets how closely; 0 keeps the smooth map. A document using it needs 0.1.N or newer."

**Risks.** Unit 7 for `u_guide` is safe only once F7 has moved `createSurface` off it (case g). Both UNPACK switches
before the RGBA8 guide upload (F7 does it; check the guide path uses it). A strong colour filter below the limited layer
weakens the snap, because the guide is unfiltered (case b measures it).

**Effort.** 1 d.

#### R2-S6: the snap in Select by depth

**Goal.** `select_range { source: "depth" }` and the panel's *Select* write the selection with the same snapped depth
at full resolution; picture bytes are read only for tiles that hold a depth edge. A selection by depth hugs the
subject's edge with the transition the Limit shows.

**Preconditions.** R2-S4, R2-S5, R1-S5 (`range_select`, `combine`, `tilesSource`).

**Changes.**

- `inpaint_worker.js` op `range_select`, args extended: `snap: [sigmaR, tau] | null`; `guide: { sab, w, h } | null`
  (RGBA8 on the map grid); `picture: { sab, x0, y0, w, h } | null` (RGBA8 of this band's edge columns, the picture
  without filter layers). Inside `picture`: `snapField(...)` with that pixel's colour; elsewhere `u16Bilinear`. The
  worker never writes an arena tile.
- `inpaint_canvas.js` `selectRange` (R1-S5), depth source: `rmax` from a WeakMap keyed by `map.data` (`rangeMax(map)`,
  computed once; the map is immutable); `edgeTiles(map, rmax, inv, W, H, tau)`; per tile row with edge tiles `box =
  [minX, ty·256, maxX, min(H, ty·256 + 256)]` → `await this.sampleRegionSettled("image", box, 1, { forRun: true,
  skipFilters: true })` → drawn into **one reused** `willReadFrequently` scratch canvas → `getImageData` → copied into a
  SAB → that row's job. Rows without edge tiles get `picture: null`.
- The canvas backend runs the same twin on the main thread per 256-row band (`readRect` / `writeRect`), as R1-S5 does.

**Tests (normal; both backends).** New gate `tools/edges_test.py`, which runs `node tools/edges_test.js` first (a
`node_step` as in `help_test.py:52-57`), `--offline`, `--tiles on` and `off`, on R2-S5's scene:

- a. `select_range { source: "depth", lo: 0, hi: 0.5, fHi: 0.05 }`: the band error count with snap 50 ≤ ⅓ of snap 0's.
- b. The selection's alpha equals the CPU twin's weight of R2-S5's limited layer at every pixel within 1 level (one
  function, two writers).
- c. Outside the edge tiles, byte-identical to snap 0.
- d. 15k: `new_canvas 15000x10000` with the synthetic map: edge-tile share and ms recorded; no mirror over 64 MB;
  `sampleRegionSettled` calls ≤ the number of tile rows (40); at most 1 scratch canvas created.
- e. Tiles and canvas backends give byte-equal selections (hashes written to the log).
- f. `mode: "intersect"` over a rectangle: alpha = `combineAlpha(intersect)` of both.

`selection` (regression), `lint`, `types`.

**Docs.** MANUAL *Selecting*: "Select by depth uses the same edges as the filters." CHANGELOG: R2-S5's line gains "...and
so does a selection by depth". TESTING.md: a paragraph on the `edges` gate.

**Risks.** The acceleration latch: many `getImageData` on fresh canvases; use one reused CPU scratch,
`willReadFrequently: true` from creation. The selection's guide colour is the picture without filters while the
Limit's is its input: they agree when no filter layer sits below (case b has none); documented. A 15000 x 256 region
pass at scale 1 is 3.8 MP per row; do not widen to 8 rows (30 MP canvases).

**Effort.** 1 d.

#### R2-S7: the detail pass (conditional on R2-D1)

**Goal.** *Detail* in the depth map row (*Standard*, *Fine*, *Finest*) computes the map from several overlapping model
runs fused to the global pass, or from one larger input, whichever R2-S3 chose; the guided upsample to the working map
follows unchanged. Thin structures (poles, branches, hair masses) and small subjects get their own depth on large
pictures; *Finest* takes longer and shows progress; *Cancel* keeps the old map.

**Preconditions.** R2-S2 (`tileBoxes`, `fuseTiles`), R2-S3's decision, R2-S4, R1-S1, R1-S3 (`depth_guide`, the
normalise). If R2-S3 found the model run blocks the main thread for over 1 s and R1-S1 kept the main thread,
`depth.js` first moves into a utility process (`lama_process.js`'s pattern): that is R1-S1b (§3.1, 0.5 d), built
before this session.

**Changes.**

- No change in main: R1-S1's bound (each side a multiple of 14 in 14..2058) already takes the large route's inputs.
  The renderer's `DEPTH_LARGE = 1568` (14 × 112) in `inpaint_depth.js` is the large route's long side.
- `renderer/editor/host.js` (app side; the node stub `depthDetail() { return null; }` goes into the node's `js/host.js`
  and the `EditorHost` typedef):

  ```js
  async depthDetail(editor, { grid /* 2|3 */, route /* "tiles"|"large" */, onProgress, signal }) -> { data: Float32Array, w, h, fits, route, grid } | null
  // tiles: boxes = tileBoxes(W, H, grid); for each box: image = await this.pictureInputBox(editor, box, ...modelSize(bw, bh), { skipFilters: true })
  //        raw = await this.helperCall("depth", { model, image, width, height }); editor.helperUsed = true; onProgress(i + 1, n); if (signal.aborted) return null;
  //        fused = await editorPool().run("depth_fuse", { global, tiles, W, H, wf, hf }, transfer, { priority: INTERACTIVE, timeout: 300000 })
  // large: one run at modelSize scaled so that the long side is DEPTH_LARGE (a multiple of 14, half-even as in modelSize)
  async pictureInputBox(editor, box, w, h, opts)   // F5's pictureInput over a box: sampleRegionSettled("image", box, s, { forRun: true, skipFilters: true })
  ```

- `inpaint_worker.js`: op `depth_fuse` → `fuseTiles(...)` from `inpaint_edges.js`, result transferred (the worker
  imports `inpaint_edges.js`).
- The producer: with `detail !== "standard"`, R1-S3's normalise and `depth_guide` take the fused map in place of the
  raw global one; `meta.detail = { route, grid, size: [wf, hf], tiles, dropped }`.
- UI, the depth map row: `Detail [Standard | Fine | Finest]` (stored in `settings.depth.detail` per app, not per
  document); Recompute uses it; a status line "Depth: tile 3 of 9" with *Cancel* (the status bar's cancel or an
  `AbortController` on the button).
- `commands.js` `depth_map`: `detail: P.enum("standard, fine (2×2) or finest (3×3)", ["standard", "fine", "finest"],
  "standard")`; the answer adds `detail: meta.detail`.
- `policy.js`: `depth_map` stays AUTO; `clamp` gets `if (name === "depth_map") args.timeout = 900;` beside
  `select_point`'s line (:299); a row in `assistant_test.js` §6.

**Tests (normal).** The `edges` gate:

- a. A stand-in `helperCall("depth")` returns as disparity the input's red channel × a random scale and shift per call
  (box-consistent, so the fit is exercised); the document's red channel encodes the true depth plus fine poles.
  `finest`: MAE against the truth ≤ 0.7 × `standard`'s.
- b. `fine` → 4 + 1 calls, `finest` → 9 + 1; one input shape across all calls (the stand-in records `[width, height]`;
  set size 1).
- c. Cancel after call 3: no `maps` step, the old map object unchanged.
- d. The stand-in throws on call 3: status "Depth detail failed: …", old map kept.
- e. `meta.detail` round-trips through save and open.
- f. Progress events 1..n in order.

`commands`, `assistant`, `mcp`, `lint`, `types`, `node` (`--check`: FILES and the host stub).

**Docs.** MANUAL: "*Detail* in the depth map row: *Fine* and *Finest* run the depth model over overlapping parts of the
picture and fit them to the whole, so small and thin things get their own depth on large pictures; they take four and
nine times as long." CHANGELOG: "**Finer depth maps** for large pictures: *Detail* › *Fine* / *Finest*." HELPERS.md: the
route, the times measured in R2-S3, the DirectML shape note. COMMANDS.md regenerated.

**Risks.** DirectML recompiles per shape: keep the tiles at the picture's aspect (R2-S2 proves it). VRAM against a
running ComfyUI (`slowHelperHint` applies). A tile over a featureless area (sky) fits badly: the `r2 < 0.5` drop rule;
R2-S3 measures how often it fires. The CPU fallback × 9 on the main thread (see Preconditions). `helperUsed = true`
frees the sessions before a local run.

**Effort.** 1-1.5 d; 0.5 d if R2-S3 picks the large input only. **Split point** if it runs long: commit after
`depthDetail`, `depth_fuse` and tests a-d; the row's *Detail* select, the command and tests e-f follow.

#### R2-S8: depth edits inside the selection (the object snap)

**Goal.** *Flatten*, *Nearer*, *Farther* and *Smooth* act on the depth map inside the current (soft) selection. With the
Object tool (a SAM2 click or R1-S9's box drag), *Flatten* is the research's semantic snap: the depth inside an object
becomes its median, so a cut never splits a person. A command does the same for agents. Select a person, press
*Flatten*: the person is one depth, and a Limit or haze no longer cuts through their shoulder. Ctrl+Z undoes it.

**Preconditions.** R2-S4 (`deriveMap`, undo bytes). F4 / R1-S9 (a soft selection to work from).

**Changes.**

- `inpaint_maps.js`:

  ```js
  export function selectionOnMap(selCanvas /* doc-frame alpha at scale s */, s, map) -> Float32Array(map.w·map.h)   // per texel: its doc centre through xf → bilinear in selCanvas' alpha / 255
  export function editMap(map, weight /* f32 per texel */, op, value) -> Uint16Array   // a new array, never the old one
  //   flatten: v' = mix(v, m, w) with m = value ?? weighted median of v under w (weights ≥ 0.5 count)
  //   offset:  v' = clamp(v + w·value·65535)      (value -1..1)
  //   smooth:  v' = mix(v, gauss(v, 3 texels), w·value)   (value 0..1, gauss over boxBlurs on an f32 copy)
  ```

- `inpaint_canvas.js`: `async editDepth(op, value, { label })`: the selection at map resolution through
  `selectionCanvasSettled([0, 0, W, H], s, w, h)` (:7275; it reads tile levels, no W x H mask) with `s = min(1, 2 ·
  max(map.w, map.h) / max(W, H))` → `selectionOnMap` → `editMap` → `setMap("depth", deriveMap(map, { data, meta: {
  ...meta, edits: (meta.edits || 0) + 1 } }), { label: "Depth: " + op })`; the guide is shared and unchanged; no
  selection → status "Select what to change first."
- UI (the depth map row): *Flatten*, *Nearer*, *Farther*, *Smooth*; Nearer and Farther step ±0.05 per click; enabled
  with a selection and a map.
- `renderer/commands.js`:

  ```js
  depth_edit: { needsImage: true, description: "Change the document's depth map inside the selection (soft edges count partly): flatten to the median (or to `value`, 0 near .. 1 far), offset by `value` (-1..1, + is farther), or smooth by `value` (0..1). One undo step.",
    params: { op: P.enum("flatten, offset or smooth", ["flatten", "offset", "smooth"]), value: P.num("see op") },   // R2-S9 adds `matte`
    → { op, median?, texels_changed, map: { w, h, version } } }
  ```

- `policy.js`: `depth_edit: AUTO` (it pushes its own `maps` step, so `undoStep` returns null); the `assistant_test.js`
  row; COMMANDS.md GROUPS: the depth group.

**Tests (normal).** The `edges` gate, `--tiles on`:

- a. A 1200 x 800 document, a map ramp 0..1 left to right, a rectangle selection over x 300-600: `flatten` → texels
  inside the footprint equal the median (±1 u16), outside unchanged (byte-equal).
- b. A soft selection at alpha 128 → halfway (±1).
- c. Undo, then redo: `ed.maps.depth` is the very object before and after (identity).
- d. `offset 0.5` clamps at 65535.
- e. `smooth 1`: variance inside drops by ≥ 50 %, outside byte-equal.
- f. A limited layer re-renders: its `filteredCanvas` miss counter grows by 1.
- g. 15k: no mirror over 64 MB.
- h. A map turned 90° (`rotate_canvas`) then `flatten`: the edited texels are those under the selection in the turned
  frame.

`commands`, `assistant`, `mcp`, `lint`, `types`; `maps` (save and open after an edit, data exact).

**Docs.** MANUAL: "Correct the depth map where the model was wrong: select a subject (the Object tool's click or box
is quickest) and press *Flatten*, and it becomes one depth; *Nearer*, *Farther* and *Smooth* work in the selection the
same way." CHANGELOG: "**Fix the depth map by hand**: *Flatten*, *Nearer*, *Farther* and *Smooth* inside the
selection."

**Risks.** Undo memory: each edit holds the previous 22 MB array; check that `undoBytes` grows by `data.byteLength`. The
selection read at map scale is approximate at the edge; the map is that coarse anyway.

**Effort.** 1 d.

#### R2-S9: the matte in the band (conditional on R2-D3 and R2-D6)

**Goal.** `depth_edit { op: "flatten", matte: true }` and *Flatten (refine edge)* first replace the selection's weight
inside a band around its edge with the matting model's alpha (BiRefNet), so hair and fur get a soft, right edge in the
map. If R2-D6 says so, the same core becomes a generic `select_refine_edge` (the folded masks-and-selections package's
refine edge).

**Preconditions.** R2-S8; a matting model downloaded (*Settings › Helpers*). `host.pictureInputBox` comes from R2-S7;
when R2-D1 skipped R2-S7, this session adds it first (R2-S7's one-line definition, about an hour; app host only, the
shared editor does not call it).

**Changes.**

- `commands.js` `depth_edit`: `matte: P.bool("flatten only: refine the selection's edge with the matting model inside
  a band first", { default: false })`; COMMANDS.md regenerated.
- `host.js`: `async matteBox(editor, box) -> { alpha: Uint8Array(1024²), box }`: `pictureInputBox(editor, box, 1024,
  1024, { skipFilters: true })` (squashed, as `objectInput` does) → `helperCall("cutout", { model, image })`, with
  `editor.helperUsed = true` and the `cutoutBackends` model choice (BiRefNet by default, MIT; a non-commercial RMBG only
  if the user chose it, as today).
- `inpaint_maps.js`: `matteBand(weight, map, matte, box, bandTexels) -> Float32Array`: the band from `distTransform`
  (`px/kernels.js:76`) over `weight >= 0.5` and its complement, both at map resolution; texels within `bandTexels` of
  the 0.5 contour take the matte's alpha (bilinear through box → 1024²), the rest keep the weight.
- The generic variant (R2-D6): `select_refine_edge { band: px, model? }` writes the matte inside the band at full
  resolution through F4 (`bytesSource` over the box), no W x H canvas; its own POLICY row. It is a sitting of its own
  (R2-S9b, 0.5 d, not in §3.6's totals), after this one.

**Tests (normal).** The `edges` gate with a stand-in `helperCall("cutout")` returning a radial alpha: inside the band the
weight equals the matte (±1/255), outside it equals the selection; no matting model → the error names *Settings ›
Helpers*.

**Docs.** MANUAL one sentence; CHANGELOG folded into R2-S8's line ("...with the edge refined by the matting model").

**Risks.** The 1024² squash of a wide box loses detail on the long axis (R2-S3's crops judge it). The model runs over
the whole box, not just the band: one cutout run.

**Effort.** 1 d.

#### R2-S10: the depth refine brush (conditional on R2-D3)

**Goal.** A brush that paints on the depth map: *Nearer*, *Farther*, *Smooth* and *Pick and paint* (Alt-click samples a
depth, then paint it). Live, one undo step per stroke. A *Depth brush* in the tool row (no default shortcut); strokes
change every depth-limited filter as they go.

**Preconditions.** R2-S8 (`editMap`'s ops), F7 (`G.uploads`).

**Changes.** `inpaint_canvas.js`: `setTool("depthbrush")` (:2989); a pointer kind `depthbrush` beside `object` (:5321,
:5542, :5792). The stroke works on a **copy** of `map.data` made once at pointer down; dabs go in map space (centre via
`passToMap(map, 1)`, radius scaled by the map's texels per document px) with a smoothstep profile. Each frame
(`drawSoon`; tests never wait on rAF): `this._mapPreview = deriveMap(map, { data: copy })` shown through
`mapsVersion++`, while `this.maps.depth` stays the old one until release. Pointer up → `setMap("depth", deriveMap(map, {
data: copy, meta: { ...meta, edits: n + 1 } }), { label: "Depth brush" })`. The options bar: size, strength, mode. The
overlay shows the dab circle (`drawSceneOverlays` :17541).

**Tests (normal).** The `edges` gate: (a) a synthetic stroke (`H.pointer` events) "farther" across the map raises texels
under the path by the profile (centre +strength, outside 0); (b) one `maps` step per stroke; (c) `G.uploads` grows by at
most 1 per frame during the stroke and by 1 at release; (d) on a turned document the change lands under the pointer
(sample the map at the document point before and after).

**Docs.** MANUAL (tools) and the Keys chapter if a key is given (the `help` gate checks menu accelerators). CHANGELOG
folded into R2-S8's line.

**Risks.** A 22 MB re-upload per frame (the static key changes with every preview): measure the upload ms at
4096 x 2731; over 8 ms → `texSubImage2D` of the dab's rect in F7's cache as `{ dirty: [x, y, w, h] }` (a small F7
extension, decided here). Synthetic pointer events fail with a real mouse over the window (a TESTING.md flake).

**Effort.** 1 d.

#### R2-S11: depth from a layer (conditional on R2-D8)

**Goal.** *From layer…* in the depth map row (and `depth_from_layer`) makes the document's depth map from any grey
layer: the user's own depth maps from ComfyUI (Depth Anything V2 Large, whose licence is the user's call as with
RMBG-2.0), glb's depth layer, a Z pass. Everything depth-based uses it.

**Preconditions.** R2-S4.

**Changes.** `inpaint_canvas.js` `depthFromLayer(layer, { invert = false /* white = near, the usual convention of
depth renderers */ })`: the layer drawn into a document-frame canvas at `s = min(1, 4096 / max(W, H))` through the
existing layer draw (`drawLayerFitted`; on tiles `sampleRegionSettled("layer", ...)`); luma to u16 (8-bit layers give
256 steps, smoothed by R1-S3's `depth_guide` with the picture as guide); `far = invert ? luma : 1 − luma`; guide
`pictureInput(..., { skipFilters: true })`; `meta = { source: "layer", layer: layer.name, time, snap: { strength:
SNAP_DEFAULT } }`; a layer that does not cover the whole picture is refused ("the layer must cover the whole picture").
`commands.js` `depth_from_layer { layer: P.layer(), invert: P.bool() }` → `{ w, h, source }`; `policy.js` AUTO plus the
test row.

**Tests (normal).** The `edges` gate: a layer with a vertical grey ramp → the map is monotone and equals the ramp ±1
after quantisation; `invert` flips it; a partial layer is refused; undo restores the previous map.

**Docs.** MANUAL one paragraph; CHANGELOG: "**Your own depth map**: any grey layer can become the document's depth map
(*From layer…*)."

**Risks.** 8-bit layers band in haze: measure with a haze at density 100 on a ramp (no step over 2 levels).

**Effort.** 0.5 d.

#### R2-S12: the `haze` filter (R2-D4)

**Goal.** A built-in filter layer *Haze by depth*: atmosphere that grows with distance (exponential transmission, a
start depth, a falloff, an automatic colour from the farthest part of the picture or a custom one, colours fading with
distance). Pointwise, reach 0, snapped at the edges. Hidden in the node and without depth support. Without a depth map
the layer passes the picture through and its row says "Needs a depth map: compute it under *Selection › Depth*".

**Preconditions.** R2-S1 (F10 with `ctx` and `wholeStatsSize`), R2-S5 (snap), F6, F7, F8.

**Changes.**

- New `renderer/editor/inpaint_depthfx.js` (FILES). It imports `registerGLFilter` (`inpaint_filters_gl.js:941`),
  `SAMPLE_GLSL`, `SNAP_GLSL`, `passToMap`, `rg8View`, `guideView`, `snapField`, `snapParams`; it does **not** import
  `inpaint_filters.js` (no import cycle).

  ```js
  export function hazeStats(small, size, ctx) -> { air: [r, g, b] }   // 0..1; with no map: [0.78, 0.82, 0.86]
  //   per small pixel: far = ctx.sampleMap(map, (i + 0.5) / sx, (j + 0.5) / sy) (no snap: statistics); threshold = 98th percentile of far (256-bin histogram);
  //   air = alpha-weighted mean colour where far >= threshold; if luma(air) < 0.35: air = mix(air, [0.78, 0.82, 0.86], 0.5)
  export function applyHaze(src, p, info)   // the CPU twin (open() / loop-style pixels); passes the input through when !info.maps?.depth
  // GL: registerGLFilter("haze", { uniforms: { u_map: "sampler2D", u_guide: "sampler2D", u_m0: "vec4", u_m1: "vec2", u_snap: "vec2", u_air: "vec3",
  //       u_s: "float", u_k: "float", u_curve: "float", u_desat: "float" }, code, values, skip: (p, info) => !(info && info.maps && info.maps.depth) || num(p.amount) <= 0 })
  // shade(c, uv): pp = pictureUv(uv) * u_pictureSize; mpx = passToMap; far = snapField(u_map, u_guide, mpx, c.rgb, u_snap);
  //   x = clamp((far − u_s) / max(1e-3, 1 − u_s), 0, 1); t = exp(−u_k · pow(x, u_curve));
  //   rgb = mix(c.rgb, vec3(dot(c.rgb, LUMA)), u_desat · (1 − t)); return vec4(rgb · t + u_air · (1 − t), c.a)
  //   with u_s = start/100, u_k = 4 · amount/100, u_desat = desaturate/100
  ```

  ```js
  // inpaint_filters.js FILTERS (after vignette)
  haze: { label: "Haze by depth",
    params: [
      { key: "amount", label: "Density", min: 0, max: 100, step: 1, default: 50, unit: "%" },
      { key: "start", label: "Start", min: 0, max: 100, step: 1, default: 20, unit: "%" },
      { key: "curve", label: "Falloff", min: 0.3, max: 3, step: 0.05, default: 1 },
      { key: "color_mode", label: "Colour", type: "select", default: "auto", options: [{ id: "auto", label: "From the far distance" }, { id: "custom", label: "Custom" }] },
      { key: "color", label: "Haze colour", type: "color", default: "#c9d3dd", when: { color_mode: "custom" } },
      { key: "desaturate", label: "Fade colours", min: 0, max: 100, step: 1, default: 30, unit: "%" },
    ],
    maps: () => ["depth"], wholeStats: hazeStats, wholeStatsSize: 256, reach: 0, apply: applyHaze },
  ```

- The `skip` hook in `applyPluginGL` (§5.2.1), if R3-S4 has not added it.
- `inpaint_canvas.js`: `mapsOf(layer)` (§5.2.1); `setMap` marks `mapsOf(l).includes(kind)` layers changed; `filterKey`
  uses `mapsOf`; `buildFilterControls` (:15327) skips a param whose `when` does not match `layer.params`, and a select
  whose key a `when` names calls `this.renderLayers()` after its change (the select handler at :15359); the type select
  (:15278) skips depth-reading types when `!host.depthSupported` unless current; a hint row `el("div", "ipc-hint", ...)`
  when `mapsOf(layer).includes("depth") && !this.maps.depth`.
- `commands.js` `filter_types` (:1003): entries add `needs: f.maps ? f.maps({}) : []` and per param `when`.
- `docfile.js`: the `haze` row, and its explicit case in `tools/document_test.js` (F1's rule).
- `tools/export_test.py` `special` (:242): `"haze": [{ amount: 80, start: 0 }, 2, "depthRamp"]`; the third field names a
  setup that installs `ed.setMap("depth", makeMap("depth", 512, 341, ramp, unitXf, meta, guide))` before the case and
  removes it after; the loop at :251 learns that third element.

**Tests (normal; both backends).** New gate `tools/depthfx_test.py` (no Node pre-step yet: `tools/haze_test.js`
arrives with R2-S13, the next session, which adds the step):

- a. GL against CPU on a 600 x 400 document with a ramp map: max ≤ 2, over2 ≤ 0.1 %.
- b. No map → output bytes equal the input (GL and CPU); the hint row shows.
- c. `amount 0` → identity.
- d. At far = 1, amount 100, start 0, custom colour (200, 210, 230): |out − colour| ≤ 4 levels; at far = 0 unchanged
  (±1).
- e. Auto colour: a document whose far 2 % is (200, 210, 230) → `stats.air` within 2/255.
- f. `when`: switching `color_mode` to custom shows the colour picker (`.ipc-fxcolor` count 1), auto hides it (0).
- g. `filter_types` lists haze with `needs: ["depth"]`.
- h. `set_filter` / undo / save-open of a haze layer.
- i. A document with haze writes reader R.

`export` (the band test with the new special: worst ≤ 2, no seams, `moved > 0`), `limit` (a haze plus a depth Limit),
`document`, `commands`, `mcp`, `assistant` (`add_filter` is AUTO already), `lint`, `types`, `node`, `skins` (the hint
row), `help`.

**Docs.** MANUAL *Filter layers*: "*Haze by depth* adds air between you and the distance: *Density* is how thick it
gets at the far end, *Start* where on the near-to-far range it begins, *Falloff* how quickly it builds up, *Fade
colours* how much colour the distance loses. The colour comes from the farthest part of the picture unless you pick
one. It needs the document's depth map." CHANGELOG: "**Haze by depth**, a filter layer that adds atmosphere growing with
distance, its colour taken from the far distance or picked." COMMANDS.md regenerated.

**Risks.** The id `haze` goes through the plugin GL path as a built-in and must never clash with a plugin id (plugin
ids are prefixed). Fill layers with a depth Limit (R1-S7) are the other way to a haze; the manual names the filter.
`hazeStats` reads `sampleMap` 65k times per composite version (about 5 ms, inferred).

**Effort.** 1 d.

#### R2-S13: the dehaze maths

**Goal.** `renderer/editor/inpaint_haze.js` (FILES; pure; f32 on `boxBlurs`) holds the dark channel, the airlight, the
raw transmission, a grey guided filter and the whole-picture stats function dehaze uses, tested against brute-force
references in plain Node. The user sees nothing.

**Preconditions.** R2-S2 (`gaussRadii`, the conventions), R2-S1.

**Changes.**

```js
// renderer/editor/inpaint_haze.js
export function minFilter(src /* f32 */, w, h, r) -> Float32Array       // separable van Herk / Gil-Werman, replicate edges
export function darkChannel(rgba /* u8 */, w, h, r, A = [1, 1, 1]) -> Float32Array   // minFilter(min_c(I_c / A_c), r)
export function airlight(rgba, dark, w, h, frac = 0.001) -> [r, g, b]  // mean of I over the top max(16, ceil(frac·n)) dark-channel pixels, each channel clamped to [0.2, 1]
export function guidedFilter(I /* f32 guide */, p /* f32 */, w, h, r, eps) -> Float32Array   // R1-S3a's, with boxBlurs bound as `box`; no second copy
//   mean_I = box(I), mean_p = box(p), corr_I = box(I·I), corr_Ip = box(I·p); a = (corr_Ip − mean_I·mean_p) / (corr_I − mean_I² + eps);
//   b = mean_p − a·mean_I; q = box(a)·I + box(b)   (box = boxBlurs(.., [r]))
export function dehazeStats(small, size, ctx) -> { air, t: Uint16Array, guide: Uint8Array, w, h, seq }
//   rgba from small (getImageData once); r = max(2, round(0.012·max(w, h))); dark = darkChannel(rgba, w, h, r); A = airlight(...);
//   t̃ = 1 − 0.95·darkChannel(rgba, w, h, r, A); t = guidedFilter(luma, t̃, w, h, 4r, 1e-3) clamped to [0.05, 1]; quantised to u16
//   (both paths read the same values); guide = rgba of small (alpha forced 255); seq = a counter for the static sampler key
```

R1-S3's `guidedFilter` in `inpaint_depth.js` has the same maths: import it from there with `boxBlurs` as its `box`
argument instead of writing a second copy (check the signatures agree). Plus `tools/haze_test.js` (plain Node).

**Tests (light).** `node tools/haze_test.js`, which this session also adds as the `depthfx` gate's Node pre-step (the
`help_test.py:52-57` pattern), `lint`, `types`, `build_node.py
--check`.

| Case | Expected |
|---|---|
| `minFilter` on a random 50 x 40, r = 3, against brute force | exact |
| `darkChannel` of a constant image | the min channel everywhere |
| `airlight` on synthetic I = J·t + A(1 − t), A = (0.8, 0.85, 0.9), J textured, t a horizontal ramp 0.2..1 | within 0.03 per channel |
| transmission recovered | Pearson corr(t_est, t_true) ≥ 0.9 |
| `guidedFilter` against a brute-force double loop on 64 x 48 | within 1e-4 |
| eps → 1e9 / p = I with eps → 1e-9 | ≈ box(p) within 1e-4 / ≈ I within 1e-3 |
| determinism | the same canvas twice → byte-equal `t` |
| cost | 768 x 512 in < 60 ms under Node with the JS kernels (recorded; wasm is faster in the app) |

**Risks.** `boxBlurs` normalises by a fixed `2r + 1` with replicated edges: the brute force uses the same rule. Test r ≥
w.

**Effort.** 1 d.

#### R2-S14: the `dehaze` filter

**Goal.** A built-in filter layer *Dehaze* that removes haze from the picture below: *auto* (from the picture itself,
by the dark channel at ≤ 768 px, snapped at full resolution) or *depth* (from the depth map, exponential by distance),
plus *Protect sky*. Pointwise, reach 0, the same in every pass. A dull, hazy landscape gets contrast and colour back in
the distance with no halo at the skyline; the sky does not turn grey or noisy.

**Preconditions.** R2-S13, R2-S12 (`mapsOf`, `when`, `skip`), R2-S5. R2-D5 (dehaze in the node).

**Changes.**

- `inpaint_depthfx.js`: `applyDehaze` (CPU twin) and `registerGLFilter("dehaze", ...)` with `uniforms: { u_t, u_tguide,
  u_map, u_guide: "sampler2D", u_m0, u_m1, u_snap, u_air, u_amount, u_beta, u_protect, u_mode }`. `u_t` / `u_tguide` are
  static sampler values keyed by the stats object: `{ data: stats.t's bytes, width, height, channels: 2, static: true,
  key: "dehaze:" + stats.seq }` and the RGBA guide likewise.

  ```
  shade(c, uv):
    smallPx = pictureUv(uv) · vec2(textureSize(u_t, 0))
    t = (u_mode == 0) ? snapField(u_t, u_tguide, smallPx, c.rgb, vec2(0.08, 0.03))
                      : exp(−u_beta · snapField(u_map, u_guide, mpx, c.rgb, u_snap))           // u_beta = 2.5·density/100
    K = 0.25·u_protect; dm = max3(abs(c.rgb − u_air)); t = min(1, max(K / max(dm, 1e-3), 1) · t); t = max(t, 0.1)
    J = (c.rgb − u_air) / t + u_air; return vec4(mix(c.rgb, clamp(J, 0, 1), u_amount), c.a)
  ```

  `skip`: amount 0, or the depth mode without a map. In depth mode the airlight still comes from `dehazeStats`, so both
  modes share A.

  ```js
  dehaze: { label: "Dehaze",
    params: [
      { key: "amount", label: "Amount", min: 0, max: 100, step: 1, default: 50, unit: "%" },
      { key: "mode", label: "Haze from", type: "select", default: "auto", options: [{ id: "auto", label: "The picture" }, { id: "depth", label: "The depth map", needs: "depth" }] },
      { key: "density", label: "Density", min: 0, max: 200, step: 1, default: 100, unit: "%", when: { mode: "depth" } },
      { key: "protect", label: "Protect sky", min: 0, max: 100, step: 1, default: 40, unit: "%" },
    ],
    maps: (p) => (p.mode === "depth" ? ["depth"] : []), wholeStats: dehazeStats, wholeStatsSize: 768, reach: 0, apply: applyDehaze },
  ```

  Without depth support the `depth` option of `mode` is hidden (the option flag `needs: "depth"`, filtered in the
  select build).
- `docfile.js`: the `dehaze` row, and its explicit case in `tools/document_test.js` (F1's rule).
- `export_test.py` `special`: `"dehaze": [{ amount: 80 }, 2]` and `["dehaze#depth", { mode: "depth", amount: 80 }, 2,
  "depthRamp"]`; the loop allows `id#variant` keys.

**Tests (normal; both backends).** The `depthfx` gate:

- a. GL against CPU, both modes: max ≤ 2, over2 ≤ 0.1 %.
- b. A synthetic hazy document (J textured, A = (0.8, 0.85, 0.9), t ramp): amount 100 → mean |out − J| ≤ 0.5 × mean
  |hazy − J|.
- c. amount 0 → identity.
- d. Protect sky: a flat region equal to A stays within 3 levels at protect 100.
- e. Stats computed once per composite version (a counter): not per band, not per frame, not during a gesture below
  (`applyFilterLayer` :12481-12489 skips the filter then).
- f. Byte-stable stats: a freshly opened document's first export against a settled second one → identical bytes (F10's
  open risk; if it fails, prime the pass with `primePass` before the first band).
- g. Header reader R.

`export` (the band test with both specials, worst ≤ 2, no seams), `exportperf:15000x10000,--filter=dehaze` recorded
against `--filter=levels` (expected within 1.3×: reach 0; measured, not assumed), `document`, `commands`, `lint`,
`types`, `node`, `help`.

**Docs.** MANUAL *Filter layers*: "*Dehaze* takes haze out of what is below it. *The picture* finds the haze in the
picture itself; *The depth map* takes it from the distance, which keeps near things untouched. *Protect sky* holds back
where the picture is close to the haze colour, so a clear sky does not turn grey or noisy." (and that a *Levels* layer
above lifts the overall darkening). CHANGELOG: "**Dehaze**, a filter layer that clears haze from the distance, found in
the picture itself or taken from the depth map, with *Protect sky*."

**Risks.** `wholeStats` at 768 px runs on the main thread: a sampled pass plus about 40 ms of maths per composite
version; measure the first view after a change. Dehaze darkens overall (J < I where A is bright): expected. It ships to
the node with the next node version (auto works there, depth is hidden): R2-D5.

**Effort.** 1 d.

#### R2-S15: lens blur (only on the user's word, R2-D7)

**Goal.** A built-in `lens_blur`: blur that grows away from a focus depth, with a disc aperture and an optional
highlight boost, using the snapped depth so the subject's edge stays sharp against a blurred background. Planned in full
only after the yes; the shape:

- Params: focus (0..100 far; an eyedropper `pick` via F9 / `sample_depth`), depth of field, aperture (maximum radius in
  % of the long side, **cap 1.5 %**), highlights.
- Circle of confusion: `coc(p) = Rmax · clamp((|far(p) − focus| − dof/2) / (1 − dof/2), 0, 1)`.
- Gather: a 64-tap Vogel disc; a tap counts when its own coc ≥ its distance (scatter as gather); taps farther than an
  in-focus centre get weight 0, so the background never bleeds over the subject.
- Reach `ceil(Rmax_px) + 2` (picture-relative, as film.look's reach at `plugins/film/filters.js:371`). CPU twin: a loop,
  fallback only. A FEATURES row.
- Sessions: R2-S15a the maths, the twin and tests; R2-S15b GL, the UI and the export specials; R2-S15c
  `exportperf:15000x10000,--filter=lens_blur` against BUGS.md:336 (halation's 67 s at 20k) and a cap decision.

**Risks.** Halos at depth edges are where the research said they show most; a large reach means export slowness.

**Effort.** 2-3 d.

#### R2-S16: the release

The release session of §1.3. Release-specific parts: the CHANGELOG section (depth edges, finer maps, fixing the map by
hand, own depth map, haze, dehaze, plugin API 4, and "a document using edge snap, haze or dehaze needs 0.1.N or
newer"); no Nik, DxO, ClearView, Photoshop or Lightroom in it; exe gates add `fill clip groups maps limit selection
edges depthfx document docux composite export`; the look covers snap, haze and dehaze on the user's pictures; the
manual's screenshots: the depth map row, haze, dehaze. 1 d.

### 5.3 Release 3: filters and control points

**Scope.** The eight items of the research's release 3: colour grading wheels; HSL in 8 channels; control-point
diffusion (softness); elliptical, polygonal and line control points (colour-aware control lines); the preset hover
preview; paste a mask onto another layer (and optionally copy and paste control points); chromatic shift and glass as a
new built-in effects plugin. Out of scope: the folded "grading and panels" package (vibrance, selective colour, channel
mixer, gradient map, filter presets with .cube export, the dither, histogram and navigator panels; G4) and releases 1,
2 and 4.

**Dependencies.** Nothing from releases 1, 2 or 4. Foundations: F1 (every picture-changing addition is a row at the
release's reader number R), F2 (extended `film.add_point` and `set_mask`, new film commands), F7 (R3-S5 rewrites the
points shader, and `u_blur` sits on unit 6 today), F10 (hidden flat params, the hover preview's cancel), and F3 only
because F7 tests `SAMPLE_GLSL` against F3's `u16Bilinear` (when release 3 comes first, F3 is built with F7). F4-F6,
F8, F9, F11 and F12 are not used; `points.js` keeps its own colour formula (switching it to F3's `colourSimilarity`
buys nothing and risks moving pixels). Inside the release: R3-S4 adds to `inpaint_grade.js` (R3-S2) and
`inpaint_wheels.js` (R3-S3), and R3-S7 tests in the `grading` gate (R3-S2).

**What matters here from §2:** the live `gradient` fill layer already gives a graduated adjustment (colour-aware lines
are still missing: R3-S6); film.points follows the geometry event, so every new shape field in image pixels must follow
that matrix (R3-S5, R3-S6); the unit 6 and 7 clashes (F7; release 3 keeps every shader at two samplers); plugin filters'
missing `wholeStats`, `color`, `hidden` (F10); the manual's HSL claim (R3-S4); BUGS:152 (R3-S7, R3-D8); the existing
mask operations (`maskOp` :12816, `MASK_OPS` and `set_mask` `commands.js:297, 980`), which paste joins; Escape never
reaching a plugin tool (R3-S5); the untested LUT path (why R3-S4 uses a direct shader); a built-in filter can register a
`shade()` shader through `registerGLFilter(id, def)` (:941), and `applyFilterGL` falls through to `PLUGIN_GL` for any id
not in `SUPPORTED` (:1094), so HSL needs no change to the shared fragment shader (:23-130); the screen pass pads only 4
screen pixels (`viewportRegion`, `inpaint_canvas.js` ~16120), so a displacement filter shows clamped pixels at the
viewport's edge when zoomed in, as blur and halation do today (exports are exact through `reach`; noted, not fixed).

**New gates**, picked up by the `*)` rule and listed in CLAUDE.md and `docs/TESTING.md`: `grading`
(`tools/grading_test.py`, running `tools/grade_test.js` first as a `node_step`), `masks` (`tools/masks_test.py`),
`effects` (`tools/effects_test.py`, running `tools/effects_math_test.js` first). `tools/points_shapes_test.js` runs
from `film_test.py`. None of these goes into `editor_test.py`.

#### R3-S1: plugin API 4 (F10), only when release 2 has not built it

Build F10 (§4). Skip this session when `API_VERSION` is already 4. The release 3 parts F10 must provide, checked at the
end: `hidden` params skipped by the row and still listed and clamped; `InpaintEditor.cancelFilterParams` with
`markFilterChanged(l, { soon: true })` and no `changed` event; the `color` param type; the `wholeStats` passthrough
(release 2 uses it). One release 3 case in the `commands` gate: a built-in test filter with one hidden number param (no
slider, `hidden: true` in `filter_types`, `set_filter` clamps). 0.5 d.

#### R3-S2: colour grading, the filter

**Goal.** A built-in filter layer type **Colour grading** (`color_grade`): four ranges (shadows, midtones, highlights,
and the whole picture as "global"), each with hue, strength and brightness, plus *Balance* and *Blending*. This session
shows 14 plain sliders; R3-S3 replaces 12 of them with wheels. It works through `add_filter` / `set_filter` and ships to
the node (all its files are shared).

**Preconditions.** F1, F2. R3-D5 (the layout), G5.

**Changes.**

- New `renderer/editor/inpaint_grade.js` (`// @ts-check`, no imports, no DOM at import; FILES):

  ```js
  export const LUMA_601 = [0.299, 0.587, 0.114];
  export const GRADE_RANGES = ["sh", "mid", "hi", "glob"];
  export const K_TINT = 0.35 * 255, K_LUM = 0.25 * 255;
  export function hueRgb(hue) -> [r, g, b]        // a copy of inpaint_filters.js hueToRgb (:874); no import, to avoid a cycle
  export function gradeIdentity(p) -> boolean      // every *_sat and *_lum is 0
  export function gradeWeights(l, balance, blending) -> [ws, wm, wh]
  //   w = 0.02 + 0.146 * blending / 100        (0.02..0.166, always < 1/6, so wm >= 0)
  //   b = balance / 100 * 0.2; p1 = 1/3 + b; p2 = 2/3 + b
  //   ws = 1 - sstep(p1 - w, p1 + w, l); wh = sstep(p2 - w, p2 + w, l); wm = 1 - ws - wh
  export function tintOf(hue, sat) -> [r, g, b]    // (hueRgb(hue) - luma(hueRgb(hue))) * sat / 100 * K_TINT  (zero luma)
  export function colorGradeTables(p) -> { dR, dG, dB }   // Float32Array(256) each, in 0..255 units, the shape of colorBalanceTables
  //   d(l) = ws * (tint_sh + L_sh) + wm * (tint_mid + L_mid) + wh * (tint_hi + L_hi) + tint_glob + L_glob,  L_x = lum_x / 100 * K_LUM on all three channels
  ```

- `renderer/editor/inpaint_filters.js`: factor `applyOffsets(src, dR, dG, dB)` out of `applyColorBalance` (:794-806;
  the same loop and luma index `(LR*r + LG*g + LB*b + 0.5) | 0`); `applyColorGrade(src, p)` returns `copyCanvas(src)`
  for `gradeIdentity(p)` and `applyOffsets(src, ...colorGradeTables(p))` otherwise; `FILTERS.color_grade` after
  `color_balance` (:1000), label "Colour grading", `reach: 0`, params `sh_hue`, `mid_hue`, `hi_hue`, `glob_hue` (0..360,
  step 1, unit "°", defaults 220 / 30 / 40 / 0), `sh_sat` ... `glob_sat` (0..100, default 0, "%"), `sh_lum` ...
  `glob_lum` (-100..100, default 0), `balance` (-100..100, default 0), `blending` (0..100, default 50); re-export
  `colorGradeTables` on the table-builder line (:1102).
- `renderer/editor/inpaint_filters_gl.js`: factor `setOffsets(g, dR, dG, dB)` out of `SETUP.color_balance` (:813-819);
  `SETUP.color_grade(g, p)` returns `false` for `gradeIdentity(p)` and otherwise `setOffsets(g, ...)` with `u_mode 2`;
  `"color_grade"` in `SUPPORTED` (:132). The fragment shader needs no change (mode 2, :97-100, is the offset lookup).
- `electron/main/docfile.js`: `{ id: "color-grade", since: "0.1.N", reader: R, sample: { layers: [{ kind: "filter",
  filter: "color_grade", params: {} }] }, test: (d) => layersOf(d).some((l) => l && l.kind === "filter" && l.filter ===
  "color_grade") }`. `tools/document_test.js`: one explicit case beside F1's loop, so deleting the row fails:
  `readerFor({ layers: [{ kind: "filter", filter: "color_grade" }] }) === R`.
- `tools/export_test.py` `special` (:242): `color_grade: [{ mid_hue: 200, mid_sat: 60, hi_lum: 20, sh_sat: 40 }, 1]`.
- Commands, MCP and assistant need nothing new (`add_filter: AUTO`, `set_filter` with params AUTO plus a "filter" undo
  step; `policy.js:51, :66, :356`).

**Tests (normal; full for the format row).** `tools/grade_test.js` (plain Node): identity params give all-zero tables;
for every `l = i/255` and balance in {-100, 0, 100} × blending in {0, 50, 100}, `ws + wm + wh = 1` within 1e-12 and each
weight ≥ 0; `tintOf(h, 100)` has `LR*r + LG*g + LB*b = 0` within 1e-9 for h = 0..359; `glob_lum: 40` gives the
constant 25.5 on all channels at every l; shadows only gives `d(255) = 0`, highlights only `d(0) = 0`; `hueRgb` matches
a literal table of 12 hues.

New gate `grading` (`tools/grading_test.py`, skeleton copied from `tools/fill_test.py`), `--tiles on` and `off`:

1. GPU against CPU: `GL.compareFilterPaths((s,p,i) => F.FILTERS.color_grade.apply(s,p,i), "color_grade", src, params,
   {})` for five param sets, `max <= 2`; `color_balance` recorded as the baseline in the same step (mode 2 has `.5` ties
   in the luma index it already lives with; measure this first).
2. Expected pixels on a 640 x 400 grey 128: `mid_hue: 0, mid_sat: 100` gives (191, 101, 101) ±1 on both paths (wm(128/255)
   = 1 at blending 50); `hi_sat: 100` alone leaves 128 exactly; `glob_lum: 36` gives 151 ±1 (36 avoids a .5 tie).
3. Commands: `add_filter {type: "color_grade", params: {mid_sat: 40, mid_hue: 200}}` then `list_layers` shows them;
   `set_filter {params: {nope: 1}}` names the 14 keys; `filter_types` lists 14 params.
4. Document round trip: `save_document` to the scratch path, `open_document`: params equal.

The `document` gate on both backends with one hand mutation (drop the row: `document_test.js` fails; `git diff --stat`
after), `export` on tiles, `node`, `nodecopy`, `lint`, `types`.

**Docs.** CHANGELOG: "Colour grading: a filter layer that tints the shadows, midtones, highlights and the whole picture
separately, each with a hue, a strength and a brightness, with Balance and Blending for where the ranges meet." MANUAL
Filter layers (:248): "colour grading" in the built-in list. DOCUMENTS.md §8: the row.

**Risks.** The identity fast path must return `false` on GL and a copy on the CPU, or an identity layer costs a pass.
Inserting into FILTERS changes the order of `FILTER_IDS`, which only the type select uses.

**Effort.** 1 d.

#### R3-S3: colour grading, the wheel control

**Goal.** The grading row shows four colour wheels in a 2 x 2 grid (Shadows, Midtones, Highlights, Global), each with a
puck for hue and strength and a brightness slider under it, followed by the visible *Balance* and *Blending* sliders.
Dragging a puck is one undo step ("Colour grading: Wheels"); double-click resets a wheel's strength.

**Preconditions.** R3-S2, F10 (`hidden`).

**Changes.**

- New `renderer/editor/inpaint_wheels.js` (FILES; DOM only; imports `THEME` from `inpaint_theme.js` and the helpers
  from `inpaint_grade.js`):

  ```js
  export function puckToHueSat(dx, dy, R) -> { hue, sat }   // hue = atan2(-dy, dx) in degrees (0..360, counter-clockwise, red to the right), sat = min(100, |d| / R * 100)
  export function hueSatToPuck(hue, sat, R) -> [dx, dy]
  export function buildWheelsControl(layer, param, callbacks) -> HTMLElement
  //   a 2x2 grid: per range a <canvas> (72 CSS px, dpr <= 2) and an <input type=range> for *_lum
  //   pointerdown -> callbacks.begin(); move -> layer.params[`${r}_hue`], [`${r}_sat`] = ...; callbacks.preview(); up -> callbacks.commit()
  //   dblclick -> begin, `${r}_sat` = 0, commit;  lum range: input -> begin + preview, change -> commit
  //   draws: the hue ring from hueRgb, a radial fade to THEME.curveBg, the rim THEME.curveGrid, the puck THEME.curvePoint, the label THEME.curveHint
  ```

  (Reusing the curve keys of `THEME` needs no change to the skin contract.)
- `inpaint_filters.js` `FILTERS.color_grade`: the 12 `*_hue`, `*_sat`, `*_lum` params `hidden: true`; prepend `{ key:
  "wheels", label: "Wheels", type: "custom", default: null }`; `control: (layer, p, cb) => buildWheelsControl(layer, p,
  cb)` (the curves pattern, callbacks at `inpaint_canvas.js:15333-15338`).
- CSS in the editor's style string next to `.ipc-fx` (`inpaint_canvas.js:1459`):
  `.ipc-wheels{display:grid;grid-template-columns:1fr 1fr;gap:6px}`,
  `.ipc-wheel{display:flex;flex-direction:column;align-items:center;gap:2px}`, `.ipc-wheel
  span{color:var(--sc-muted,#888)}`.

**Tests (normal, light for looks).** `grade_test.js`: `puckToHueSat` / `hueSatToPuck` round trip within 1e-9 on a grid;
the puck at (R/2, 0) gives hue 0, sat 50; at (0, -R/2) hue 90, sat 50. `grading` gate on both backends: the row has 4
`.ipc-wheels canvas` and 6 `input[type=range]` and no slider for the hidden keys; pointer events on the midtones canvas
from its centre to (0, -R/2) give `mid_hue` 90 ±1 and `mid_sat` 50 ±1 with `undo.length` +1 labelled "Colour grading:
Wheels", and undo gives sat 0; double-click resets; `set_filter {params: {sh_hue: 10}}` still works. `skins`, `lint`,
`types`, `nodecopy`; one look by the user.

**Docs.** MANUAL Filter layers: one sentence on the wheels.

**Risks.** Pointer capture inside the side panel: stop propagation on `pointerdown`, `click`, `dblclick` and `keydown`,
as the curves control does. Flat keys only: the undo snapshot copies params shallowly (:11464), fine for top-level keys.
dpr scaling.

**Effort.** 0.75 d.

#### R3-S4: HSL in 8 channels

**Goal.** A built-in **HSL** filter layer (`hsl`): hue, saturation and luminance for red, orange, yellow, green, aqua,
blue, purple and magenta; greys stay grey. The row offers a Hue / Saturation / Luminance switch, 8 swatched sliders and
*Reset* (Shift resets all three modes). It ships to the node. The manual's line 248 becomes true.

**Preconditions.** R3-S2 (`inpaint_grade.js`, the `grading` gate, `grade_test.js`), R3-S3 (`inpaint_wheels.js`, where
`buildHslControl` goes), F1, F10. R3-D3 (the implementation), R3-D4 (the looks, after the look).

**Measure first, before any UI:** the parity of `hslPixel` against `HSL_GLSL` on a sweep of 4096 colours including
near-greys and the channel borders, through `compareFilterPaths`; expected `max <= 2`; if worse, find the float32
hotspot first.

**The maths per pixel** (c in 0..1):

1. `mx = max(c)`, `mn = min(c)`, `C = mx - mn`, `amt = sstep(0, 0.25, C)`; when `amt == 0`, return c.
2. HSV hue h in degrees.
3. Channel centres H = [0, 30, 60, 120, 180, 240, 270, 300], wrapping at 360; k with `H[k] <= h < H[k+1]`, `t = (h -
   H[k]) / (H[k+1] - H[k])`, `s = t²(3 - 2t)`, `w_k = 1 - s`, `w_{k+1} = s` (a partition of unity).
4. `dh = (Σ w·hue_ch) / 100 · 30 · amt` degrees; `ds = (Σ w·sat_ch) / 100 · amt`; `dl = (Σ w·lum_ch) / 100 · amt`.
5. `c1 = hsv2rgb(h + dh, S, V)` (an exact hue shift; dh 0 gives c).
6. `Y1 = luma601(c1)`; `c2 = Y1 + (c1 - Y1) · max(0, 1 + ds)` (saturation keeps luma).
7. `Y3 = dl >= 0 ? Y1 + (1 - Y1)·dl·0.5 : Y1·(1 + dl·0.5)`; `c3 = c2 + (Y3 - Y1)`; clamp to 0..1.

**Changes.**

- `inpaint_grade.js`: `HSL_CHANNELS = [{ id: "red", hue: 0 }, ..., { id: "magenta", hue: 300 }]`; `hslWeights(h) -> [k,
  k1, w0, w1]`; `hslIdentity(p)`; `hslPixel(r, g, b, p) -> [r, g, b]` in double precision; `HSL_UNIFORMS = { u_h0:
  "vec4", u_h1: "vec4", u_s0: "vec4", u_s1: "vec4", u_l0: "vec4", u_l1: "vec4" }`; `hslUniforms(p)` (red to green in the
  `*0` vectors, aqua to magenta in `*1`, each divided by 100); `HSL_GLSL`, a `vec4 shade(vec4 c, vec2 uv)` with the same
  steps (no array uniforms in `PLUGIN_TYPES`, hence six vec4s; no `sample`, `half` or `filter` names; no backtick in the
  template).
- `inpaint_filters.js`: `applyHsl(src, p)` (an `openPixels` loop over `hslPixel`; `copyCanvas` for identity);
  `FILTERS.hsl` after `hue_sat` (:990), label "HSL": `{ key: "channels", type: "custom", default: null }`, 24 hidden
  params `red_h, red_s, red_l, ..., magenta_l` (-100..100, default 0), `control: buildHslControl`, `reach: 0`.
- `inpaint_filters_gl.js`: at module end `registerGLFilter("hsl", { code: HSL_GLSL, uniforms: HSL_UNIFORMS, values: (p)
  => hslUniforms(p), skip: (p) => hslIdentity(p) })`; the `skip` hook in `applyPluginGL` (§5.2.1, signature `skip(params,
  info)`) if R2-S12 has not added it.
- `inpaint_wheels.js`: `buildHslControl(layer, param, callbacks)`: three mode buttons styled like the curves buttons;
  8 rows of a swatch (`hueRgb(centre)`), a range and a value; Reset (Shift for all modes); each range `input` → begin
  and preview, `change` → commit with the step label "HSL: <Colour> <mode>".
- `docfile.js`: the row `hsl` at reader R and an explicit case in `document_test.js`.
- `export_test.py` `special`: `hsl: [{ red_h: 40, blue_s: -60, green_l: 30 }, 1]`.

**Tests (normal; full for the format row).** `grade_test.js`: for h = 0..360 in steps of 0.01 `w0 + w1 = 1` within
1e-12, each weight in [0, 1], exactly 1 at every centre; random greys unchanged for random params, exactly; colours with
C < 0.02 move by ≤ 1 level; (255, 0, 0) with `red_h: 100` gives (255, 128, 0) ±1; `red_*` params move pure orange
(255, 128, 0) by ≤ 1 level; (255, 0, 0) with `red_s: -100` gives (76, 76, 76) ±1; for 10,000 random unclipped colours
with only `*_s` set, luma before the clamp is kept within 1e-9. `grading` gate on both backends: `compareFilterPaths` for
`hsl` with six param sets (`max <= 2`, `over2 == 0`); identity leaves the input's bytes; on a picture with a sky-blue half
and a red half, `set_filter {params: {blue_s: -100}}` brings the sky half's chroma below 3 and leaves the red half within
1; the row has 8 ranges and 3 mode buttons; `filter_types` lists 25 params, 24 hidden. `export` (tiles), `document` (both
backends, the hand mutation: drop the row), `node`, `nodecopy`, `lint`, `types`.

**Docs.** CHANGELOG: "HSL: hue, saturation and luminance for eight colour ranges (red, orange, yellow, green, aqua, blue,
purple, magenta); greys stay grey." MANUAL:248 stays and is now correct. DOCUMENTS §8: the row.

**Risks.** The float32 HSV hue at `mx == r` boundaries (guarded by amt for greys). Clamping after a large `dl` loses
luma preservation (expected, documented). The `skip` hook must not swallow a filter whose identity check is wrong (the
identity test proves it). Why not a LUT: §2 (untested path, no texture freed per slider frame).

**Effort.** 1.25 d.

#### R3-S5: control points v2 (softness, ellipse, texture v2, Escape routing)

**Goal.** Every control point gets *Softness* (diffusion, 0..100, default 75 = exactly today's falloff); a new
*ellipse* shape with its own second radius and angle, placed by dragging along its long axis, with a handle per axis;
the layer row's control shows "New: circle / ellipse" and the Softness, Height and Angle sliders of the selected point;
Escape now deselects a point (and lets go of a box in the Boxes tool). Old documents render byte-identically.

**Preconditions.** F1, F2, F7. R3-D6 (circles under a non-uniform resize).

**Measure first:** (1) in the dev instance with `film.point` active and a point selected, a real Escape through CDP
`Input.dispatchKeyEvent` (with `Emulation.setFocusEmulationEnabled` on, the occluded-window trap) leaves `_fpSel` set
(the dead branch); (2) the SHA-256 of the CPU bytes of `film_test.py`'s three `film.points` cases with the old code,
before any edit.

**Changes.**

- New `plugins/film/shapes.js` (imports only `./common.js`; no DOM at import):

  ```js
  export const SHAPES = ["circle", "ellipse", "polygon", "line"];      // polygon and line refused until R3-S6
  export const TEXELS = 14;                                            // RGBA32F texels per point row
  export function normalisePoint(q) -> point   // defaults, clamps (r >= 1, ry >= 1, soft 0..100), refuses an unknown shape
  export function innerOf(q, scale)            // q.soft == null ? 0.25 : clamp(1 - soft / 100, 0, 1 - 1 / max(1, r * scale))
  export function pointsTexture2(points, scale) -> { data: Float32Array(14 * 4 * n), width: 14, height: max(1, n), n }
  export function pointWeight(d, o, px, py) -> 0..1   // the JS twin of shapeWeight(), reading the same float32 row at offset o
  export function pointsPixel(c, px, py, d, n, useBlur, g) -> void    // the adjust step of points.js:139-162, moved here unchanged
  export const SHAPE_GLSL                      // float shapeWeight(vec2 p, int i)  (circle and ellipse here)
  export function ellipseFollow(q, m) -> { r, ry, angle }   // closed-form 2x2 SVD of L·R(A)·diag(r, ry)
  export function mapShape(q, m, s) -> point   // circle: centre mapped, r * s (unchanged rule); ellipse: ellipseFollow; a new object
  export function handlesOf(q) -> [{ id: "move" | "r" | "ry", x, y }]
  export function hitShape(q, x, y, tol) -> null | "move" | "ring" | "r" | "ry"
  ```

  Texture v2: one row of 14 RGBA32F texels per point, every length and coordinate multiplied by `info.scale`:

  | Texel | Content |
  |---|---|
  | t0 | x, y, r, sigma |
  | t1 | L, cr, cb, kind (0 circle, 1 ellipse, 2 polygon, 3 line) |
  | t2 | ev, con, sat, warm |
  | t3 | structure, inner, nVerts, 0 |
  | t4 | cosA, sinA, ry, T (the polygon and line transition, R3-S6) |
  | t5 | polygon bbox x0, y0, x1, y1, expanded by T (R3-S6) |
  | t6..t13 | polygon vertices, two per texel (R3-S6) |

  Weights: circle `1 - sstep(inner, 1, |p - c| / r)` (with inner 0.25 bit for bit today's code, `points.js:26, 147`);
  ellipse `q = R(-A)(p - c) / (r, ry)`, `1 - sstep(inner, 1, |q|)`. Keeping the vertices in the same sampler avoids a
  third sampler.
- `plugins/film/points.js`: the POINTS shader (:13-41) reads t0..t4 and calls `shapeWeight`, colour weight and
  adjustments unchanged; `pointsTexture` → `pointsTexture2`; the CPU loop (:139-163) calls `pointWeight` and
  `pointsPixel`; `mapPoint` (:106) → `mapShape`; `addPoint` (:182) takes `soft`, `shape`, `ry`, `angle`. The tool: a
  module-level `newShape` (circle or ellipse) set by the row buttons; ellipse placement by press and drag (`r =
  |drag|`, `angle = atan2(drag)`, `ry = round(0.6 r)`); handles "move" (the point), "r" (r and angle), "ry" (ry by
  projection on the minor axis); hit order handles, ring, centre; drawn with `ctx.ellipse`, the selected point with its
  handles and its inner ring at `inner`. `buildControl` (:328): the New row; for the selected point Softness (0..100),
  Height (ry, ellipses only) and Angle (-180..180, ellipses only). `add_point` (:377) new params: `shape: { type:
  "string", enum: ["circle", "ellipse"] }` (R3-S6 widens it), `softness: { type: "number" }`, `height: { type: "number",
  description: "ellipse: the second radius in px (default 60 % of radius)" }`, `angle: { type: "number", description:
  "degrees, clockwise from +x in image coordinates" }`. `apply()` and `follow()` call `normalisePoint`, because
  `set_filter` writes custom params verbatim (`commands.js:1329`).
- `renderer/editor/inpaint_canvas.js:3041`: `if (e.key === "Escape") { e.preventDefault(); if (this.pending)
  this.cancelPending(); else if (!host.pluginKey(this, e, k)) host.onEscape(this); return; }` (both hosts answer
  `pluginKey`, in the `EditorHost` typedef at `host.js:272`).
- `docfile.js`: a row `point-shapes` at reader R: present when any `film.points` layer has a point whose `shape` is not
  circle, or whose `soft` is set and is not 75; an explicit case in `document_test.js`.
- The assistant: `film_add_point` stays AUTO; a row with `shape: "ellipse"` in `tools/assistant_test.js` (:1175).

**Tests (normal, both backends: the pixel path changes; full for the format row).** `tools/points_shapes_test.js`
(plain Node, run first by `film_test.py`): old points bit-identical (a frozen copy of the old per-pixel code,
`points.js:139-162` at `b6c5238`, against `pointWeight` and `pointsPixel` on 200,000 random pixels, colours and sets of up
to 8 old-format points: every result `===`); ellipse weights (1 at the centre; 0 at `c + r(cosA, sinA)` and at `c +
ry(-sinA, cosA)`; soft 100 gives exactly 0.5 at |q| = 0.5; soft 0 with r = 100 gives 1 at 0.98 and 0 at 1.0); follow
(for m in {scale (0.5, 0.75), quarter turn, flip h, a 10° straighten}: 64 boundary points of the original, mapped by m,
lie on the new ellipse within 1e-9 of |q| = 1; a circle keeps `r·sqrt|det m|`); `normalisePoint` fills defaults,
refuses "blob", clamps ry to ≥ 1.

`film_test.py` on both backends: `gpu_vs_cpu` gains an ellipse (angle 30, ry 0.5 r, soft 40) and two circles at soft 0
and 100 (`max <= 4`, `over2 <= 0.1 %`, `changed > 0`); the three old cases' CPU bytes equal the SHA recorded first;
`points_in_a_box_away_from_the_origin` (:188) with an ellipse (box read equals the whole flatten exactly);
`points_follow_crop_resize_and_turn` (:282) with an ellipse through `extend_canvas`, `resizeImage(365, 420)`,
`rotate_canvas 90` and `flip_canvas` (8 boundary points from the events' matrices read |q| ≤ 1e-6 off 1 after each step;
undo and redo restore exactly); `point_tool` (:350): pick the ellipse with the row button and drag 80 px at 30° (r 80,
angle 30 ±0.5, ry 48), drag the ry handle, and **a real Escape** through CDP deselects (`_fpSel === null`); the
`film.add_point` ellipse case and an unknown shape's error; F7's `points_structure_above_the_drawing_buffer` re-run with
an ellipse. Also `boxes` (Escape now reaches its tool), `document` on both backends (the hand mutation), `commands`,
`mcp` (the `film_add_point` schema), `assistant`, `lint`, `types`.

**Docs.** FILM.md Control points (:65-93): softness, the ellipse, the new `add_point` params. MANUAL film-pack
paragraph. CHANGELOG: "Control points: a softness slider for every point, and an elliptical point with its own second
radius and angle; Escape now deselects a point." COMMANDS.md regenerated.

**Risks.** A wrong texel offset breaks every old document (the frozen-reference test guards it). `sstep(1, 1, x)`
divides by zero, so inner is clamped below 1 whenever soft is set. The Escape routing changes the Boxes tool's
behaviour (the documented intent of `boxes/tool.js:4`). The GLSL traps (reserved names, a backtick in a template
comment, the Write tool and `\u0080`). The tool rounds x, y and r to whole pixels and ry and angle to 0.1; MCP keeps
exact values.

**Effort.** 1.25 d.

#### R3-S6: polygon and line control points

**Goal.** **Polygon points**: click corners, close with Enter, a double-click or a click on the first corner; Escape
cancels; Backspace drops the last corner; corners can be dragged afterwards; a *Feather*. **Line points**, a
colour-aware graduated adjustment: drag from where the effect is zero to where it is full; both ends are handles. Both
weigh by the colour under their anchor, like every point.

**Preconditions.** R3-S5.

**Measure first:** the GPU time of one 24 MP band through `film.points` with 64 polygons of 16 corners each on a
15000 x 10000 document (a CDP eval of `ed.bandFilter` on a band); budget ≤ 150 ms (inferred; compare with the film look's
band); the CPU fallback reported only.

**Changes.**

- `shapes.js`:

  ```js
  export function polySigned(pts, px, py) -> number   // the min segment distance, negative inside (even-odd crossing count: winding does not matter)
  export function polyBox(pts, T) -> [x0, y0, x1, y1]
  export function interiorAnchor(pts) -> [x, y]       // the centroid if inside, else the middle of the first inside run on the centroid's row
  // weights: polygon 1 - sstep(-T, T, sd); line sstep(-T, T, dot(p - c, n)); T = max(0.5, r * scale * soft / 100), stored in t4.w
  // GLSL: an early 0 outside t5 (the bbox expanded by T), then a loop of up to 16 corners from t6..t13
  // mapShape: polygon -> every corner and the anchor mapped, r * s
  //           line    -> anchor mapped, n' = normalize(L^-T n), r' = r / |L^-T n|  (exact: an affine map keeps every point's weight)
  export function lineFromDrag(A, B) -> { x, y, angle, r }   // c = (A + B) / 2, n = normalize(B - A), r = |B - A| / 2
  ```

- `points.js`: the `newShape` buttons gain polygon and line. Drawing state `drawing = { pts: [] }` in the tool's
  closure: each click adds a corner; Enter closes with at least 3 corners (it reaches `onKey`: the editor's own Enter
  cases at `inpaint_canvas.js:3043-3046` do not apply to this tool); Escape cancels (routed since R3-S5); Backspace
  drops the last corner (reaches `onKey`: :3047 applies only to the lasso's `polyPoints`); a double-click detected in
  the tool by time (< 300 ms, < 4 px), not from the `dblclick` event; a click within 8 screen px of the first corner
  closes. Closing calls `addPoint` with `pts` and `interiorAnchor`, then one `setFilterParams`: one undo step;
  cancelling pushes nothing. Corner handles; a centre drag moves all corners. The line: a drag creates it via
  `lineFromDrag`; end handles A = c - r·n, B = c + r·n. Overlay: the polygon path and the rubber band to the cursor; for
  a line the centre line and two dashed parallels at ±T, clipped to the picture. Row control: Feather (r) for polygons
  and lines, Angle for lines. `add_point` params: `vertices: { type: "array", items: { type: "array" }, description:
  "polygon: 3 to 16 [x, y] corners in image px" }`, `angle` for lines (the direction the effect grows towards), `radius`
  as the feather for lines and polygons.
- Data: `shape: "polygon", pts: [[x, y], ...]` (3..16) or `shape: "line", angle`; `x, y` is always the anchor and the
  colour sample (a polygon samples at the anchor, defaulting to the vertex mean moved inside a concave shape).

**Tests (normal, both backends).** `points_shapes_test.js`: unit square (0,0)-(100,100): `sd` -50 at the centre, +50 at
(150, 50), 0 at (0, 0); a concave L: a point in the notch is outside; reversed winding gives the same; a bow-tie is
even-odd; the weight is 1 at sd ≤ -T, 0 at sd ≥ T, 0.5 at 0; the bbox early-out agrees with the full computation on
10,000 random points; a line's weight is 0.5 on the line, 1 at +T, 0 at -T; for m in {turn, flip, non-uniform scale,
straighten} `w'(m p) == w(p)` within 1e-9 for 1000 random p; polygon corners map exactly; `interiorAnchor` lands inside a
C shape. `film_test.py`: `gpu_vs_cpu` with a 16-corner concave polygon (soft 50, feather 30) and a line (angle 120, r 60)
(`max <= 4`, `over2 <= 0.1 %`); the tool (5 clicks plus Enter → one undo step and 5 corners; Escape halfway → no point
and no step; Backspace drops a corner; a double-click closes; a line drag gives the expected angle and r); the follow and
box-read steps with both shapes; `add_point` with 2 or 17 vertices errors. `document` (covered by R3-S5's row),
`commands`, `mcp`, `lint`, `types`.

**Docs.** FILM.md, the MANUAL film-pack paragraph, CHANGELOG ("...and polygonal and line points: a line grades the
picture from one side to the other and still follows the colour under it"), COMMANDS.md.

**Risks.** Per-pixel cost (64 × 16 segments at worst): the bbox early-out and the measurement come first. float32
against double near corners shows as tiny weight differences (covered by `over2`). A pending transform or an open
lasso takes Enter first (fine: the tool is not active then). Corners outside the picture are kept, as a crop keeps
pixels.

**Effort.** 1.25 d.

#### R3-S7: preset hover preview

**Goal.** **Film looks panel:** holding the pointer over a stock for 120 ms previews it on the active film-look layer;
leaving the grid puts the layer back; a click applies it as one undo step whose "before" is the state before the
hover. **Every select in a filter row** (grain presets, the film-look stock, black-and-white filters, later glass
styles) gets a small list button whose list previews each entry while hovered and applies it on click (R3-D7).

**Preconditions.** F10 (`cancelFilterParams`), R3-S2 (its tests go into the `grading` gate). R3-D8 (BUGS:152)
optional.

**Changes.**

- `inpaint_canvas.js`:
  - `applyChoice(layer, p, id, { rename = true })`, factored out of the select's change handler (:15362-15374), with the
    preset semantics for `p.key === "preset"` (copy the entry's fields; `look` set to null).
  - `previewChoice(layer, p, id)`: the first call stores `layer._hoverSnap = this.snapshot({ kind: "filter", id:
    layer.id })`; then `applyChoice(..., { rename: false })`, `this.filterPreview = layer.id`,
    `markFilterChanged(layer, { soon: true })`.
  - `cancelChoicePreview(layer)`: with `_hoverSnap`, restore `layer.params = { ...snap.params }`, clear `_hoverSnap`
    and `filterPreview`, `markFilterChanged(layer, { soon: true })`, `draw()`; no `notifyChanged`, so the Film looks
    panel does not re-render.
  - `commitChoice(layer, p, id)`: cancel the preview first, then the select's own path (`pushUndo` filter,
    `applyChoice` with `rename: true`).
  - `openChoiceList(layer, p, anchor)`: its own `.ipc-flyout.ipc-choices` (max-height 60vh, scrolling, optgroup
    headings from `o.group`), held in `this.flyout` with an `onClose`; rows: `pointerenter` starts a 120 ms timer then
    `previewChoice`, `click` runs `commitChoice` and closes; leaving the list cancels.
  - `closeFlyout` (:3945) calls `this.flyout.onClose` when present; `undoStep` and `redoStep` close any flyout first, so
    a hover cannot outlive an undo.
  - `buildFilterControls`: each select gets `gridColumn "2 / 3"` plus a mini button in column 3 titled "Preview the
    entries on the picture".
- `plugins/film/main.js` panel (:76-88): cell `pointerenter` (120 ms dwell): with a `film.look` layer active,
  `doc.setFilterParams(active.id, { preset: s.id }, { preview: true })`; grid `pointerleave`: `doc.cancelFilterParams(id)`;
  moving between cells only re-previews; `click`: the existing `applyLook` (its non-preview `setFilterParams` pushes
  `_undoPending`, the state before the hover). Without a film-look layer the hover does nothing (the thumbnails are the
  preview).
- R3-D8, optional: `plugins/film/filters.js:387` becomes `const g = stock ? stock.grain : null;` and `if (g && gp >
  0)`, fixing BUGS:152 and changing the picture of documents saved with "None".

**Tests (normal; light for looks).** `grading` gate, on a grain layer: open the list through its button and dispatch
`pointerenter` on a preset row; after a 200 ms `setTimeout`, `params.preset` is the hovered one, `filterPreview ===
layer.id`, `undo.length` and `name` unchanged; `pointerleave` on the list: the params JSON equals the state before the
hover, `filterPreview` and `_hoverSnap` null; hover then click: `undo.length` +1, the layer renamed, the params JSON
equal to what the native select's `change` gives on a twin layer, undo gives the state before the hover; Escape and an
outside click also cancel. `film` gate: a hover on a Slide cell with a look layer active changes the preset and pushes no
step; leaving restores it with `_undoPending` null; hover plus click pushes one step whose undo gives the state before
the hover; without a look layer the hover changes nothing. On a 15000 x 10000 document one hover shows within 250 ms
(measured and reported, not gated).

**Docs.** CHANGELOG: "Hold the pointer over a film stock in the Film looks panel, or over an entry of a filter's list,
to see it on the picture before you pick it." MANUAL Filter layers notes; FILM.md panel paragraph; BUGS.md:152 if R3-D8.

**Risks.** An autosave during a hover stores the hovered state, as a slider drag does today (accepted). The thumbnails'
re-render loop is avoided by the `soon` cancel. Native `<select>` options get no hover events in Chromium, hence the
list.

**Effort.** 0.75 d.

#### R3-S8: paste a mask (plus optional control-point copy and paste)

**Goal.** The mask menu (the "..." button and a right-click on "mask", `inpaint_canvas.js:15183-15192`) gains *Copy
mask* and *Paste mask from <name>*; `set_mask {op: "from_layer", source}` does the same for agents. The pasted mask is
placed by image position: where the source mask covers the picture it carries over; outside the source layer's area
the target is hidden. One undo step. Optional (R3-D10): film *Copy points* / *Paste points* across tabs.

**Preconditions.** F2.

**Measure first:** `transformedAsync` of a full 15000 x 10000 filter-layer mask on tiles; a paste between two
equal-geometry layers uses `clone()` (copy-on-write) and should be well under 0.5 s.

**Changes.**

- `inpaint_canvas.js`:

  ```js
  async maskFromLayer(target, source) -> boolean
  //   refuses: the same layer, a source without a mask, maskBlocked(target) (:12765), a layer gone after the await
  //   same = sm.width === target.px.width && sm.height === target.px.height && x, y, w, h equal  ->  m = source.maskPx.clone()
  //   else: srcToImg = [source.w / sm.width, 0, 0, source.h / sm.height, source.x, source.y]
  //         dstToImg = [target.w / tw, 0, 0, target.h / th, target.x, target.y]
  //         m = await sm.transformedAsync(pixelMap(xfMul(xfInv(srcToImg), dstToImg)), tw, th, { color: MASK_RGB })   // edge "transparent": outside = hidden
  //   token check (a new this._maskOpToken, incremented per mask op), then pushUndo({ kind: "mask", id: target.id, label: "Mask from layer" });
  //   target.maskPx = m; maskOff = false; maskEdit = false; markMaskChanged; renderLayers; draw
  ```

  `maskOp(layer, op, opts = {})` (:12816) gets `case "from_layer": return this.maskFromLayer(layer, opts.source);` and
  returns a promise for that op. `this.maskClip = null | { id }` set by *Copy mask*; the source is read when pasting, the
  label names it, a removed source disables the entry. `openMaskMenu` (:12838) gains the two actions.
- `renderer/commands.js`: `MASK_OPS` (:297) adds `"from_layer"`; `set_mask` (:980) adds `source: P.layer("from_layer:
  the layer whose mask is copied", { default: undefined })`; `run`: `from_layer` needs `source` ("from_layer needs
  source"), `await ed.maskOp(l, op, { source: findLayer(ed, a.source) })`; one sentence more in the description.
- `electron/main/assistant/policy.js`: `maskCard` (:202) adds `{ field: "source", to: <source name> }` for `op ===
  "from_layer"`; the row (:81) unchanged (AUTO on the assistant's own layer, ASK otherwise); `resolveLayer` already
  turns `source` into an id (`assistant/index.js:963`).
- R3-D10, `plugins/film/points.js`: commands `copy_points({ ids? })` (`readOnly: true`, a module clipboard `{ points,
  width, height }`) and `paste_points({ resample_color = true })` (positions scaled by the target size over the source
  size, radii by `sqrt` of the area ratio, colours sampled again under each pasted anchor, one undo step through
  `setFilterParams`); policy `film_copy_points: AUTO` (plus READS), `film_paste_points: AUTO`; `idsNamedBy`
  (`assistant/index.js:952`) adds `film_paste_points` → `result.layer`.

**Tests (normal, both backends: `clone` and `transformed` differ by backend).** New gate `masks`:

1. Equal geometry: filter layer A with a left-half mask from `select_rect`, filter layer B without one; `set_mask B
   from_layer source A`: B's mask bytes equal A's, `B.maskPx !== A.maskPx`; undo leaves B without a mask, redo brings it
   back.
2. Offset: paint layer P at (100, 50), 300 x 200, with a circle mask; pasting onto a filter layer gives exactly P's mask
   inside (100, 50, 300, 200) (a whole-pixel offset copies bytes, per the resampler's contract) and alpha sums to 0
   outside.
3. Scaled: P at `w: 600, h: 400` (px 300 x 200): the result equals an explicit `transformed` call with the same map,
   exactly; the circle's centre is white and the far corner 0.
4. Refusals: a source without a mask ("has no mask"); source equal to target; `from_layer` without `source` names the
   parameter.
5. 15k: `new_canvas 15000x10000`, two filter layers, a paste under 0.5 s; `memoryReport()` shows no mirror over 64 MB.
6. Menu: *Copy mask* on A then *Paste mask from A* on B gives the same as 1.
7. Locks: a pending transform on the target refuses.

`editor` (its `set_mask` steps, :10046-10140, unchanged), `commands` and `mcp` (the enum and `source`), `assistant`
(`tools/assistant_test.js` rows for `set_mask` with `from_layer`, owned → auto, not owned → ask with the source in the
card); `film` if R3-D10 (copy two points from an 800 x 600 tab, paste into a 400 x 300 tab: positions and radii halved,
colours sampled again, one step).

**Docs.** MANUAL Layers notes: one sentence on Copy and Paste mask. CHANGELOG: "Copy a layer's mask and paste it onto
another layer (the mask menu, or set_mask with from_layer)." COMMANDS.md; FILM.md if R3-D10.

**Risks.** An async op racing a change: the token check, and `pushUndo` only after the await. Never write into the
clone (it is assigned as a new mask; painting later writes through `writable()` tiles). Never assign another document's
`maskPx` (`docs/PLUGINS.md:210`). On the canvas backend a pasted mask of a different geometry reads the source canvas
whole (`transformed`, `inpaint_pixels.js:446`): the escape hatch, accepted. `selectionFromLayer` (:10504) builds a W x H
canvas and cuts at alpha 127: not reused here.

**Effort.** 0.75 d, plus 0.25 d for R3-D10.

#### R3-S9: the effects plugin and chromatic shift

**Goal.** A second built-in plugin, the **Effects pack** (id per R3-D1; proposed `effects`, so filter ids `effects.*`),
on by default. Its first filter is **Chromatic shift** with three styles: *Plates* (the three colour plates out of
register, 120° apart), *Lateral* (red outward, blue inward from the picture's centre), *Linear* (red and blue opposite
along an angle). Plugins menu: *Chromatic shift layer*.

**Preconditions.** R3-D1. F7 recommended (one sampler only, so not required). R3-D2 (the reader for plugin ids).

**Changes.**

- `plugins/<id>/plugin.json`: `{ "name": "Effects pack", "version": "1.0.0", "author": "Scumble", "entry": "main.js",
  "registers": ["filter", "action"], "enabledByDefault": true }`; `main.js` registers each filter with `chain: true`
  plus the actions.
- `common.js`, a copied subset of `plugins/film/common.js` (plugins do not import each other): `PRELUDE` with `luma`,
  `sstep`, `screen3`, `ihash`, `hash2`, `vnoise` and `vec4 bilin(vec2 p)` (4 `texelFetch` reads of `u_src` with edge
  clamp, interpolating **premultiplied** values, then unpremultiplying); JS twins `open`, `loop`, a premultiplied
  `bilinAt(d, W, H, x, y)`, `makeRunner`, `shader`.
- `chromatic.js`:

  ```js
  params: style select [plates | lateral | linear] (default plates), amount 0..60 px (default 6), angle -180..180 (default 30), strength 0..100 % (default 100)
  export function offsets(p, scale) -> { oR, oG, oB }   // input px; plates: amount at angle, angle + 120, angle + 240; linear: +dir, 0, -dir
  reach: (p) => (num(p.amount, 6) > 0 && pct(p.strength, 100) > 0 ? Math.ceil(num(p.amount, 6)) + 2 : 0)
  // shader: p = uv * u_size; lateral: d = (pictureUv(uv) - 0.5) * u_pictureSize; oR = d / (0.5 * length(u_pictureSize)) * amount * u_scale, oB = -oR, oG = 0
  //         o = vec3(bilin(p + oR).r, bilin(p + oG).g, bilin(p + oB).b); return vec4(mix(c.rgb, o, u_strength), c.a);
  ```

- With R3-D2 = bump: a FEATURES row `effects-filters` at reader R (`l.filter.startsWith("<id>.")`) and its explicit
  case in `tools/document_test.js` (F1's rule); then this session is full tier for the row (the `document` gate on both
  backends, the hand mutation: drop the row).
- The px params (`amount` here, glass's `size` and `amount`) stay in image pixels after a resize, as blur and halation
  do today (§2: only film.points follows the geometry). Accepted for this release; a `follow()` that scales them is the
  later fix for every such filter together.

**Tests (normal, both backends).** `tools/effects_math_test.js`: plates offsets sum to (0, 0); lateral is 0 at the
centre and `amount` at a corner; `bilinAt` at whole positions copies exactly and at (0.5, 0) gives the mean. New gate
`effects`: `gpu_vs_cpu` for all three styles (`max <= 2`); `amount: 0` returns the input's bytes on both paths; linear,
angle 0, amount 3, on black with a 1 px white column at x = 100: red at x = 97, blue at 103, green at 100, exactly; at
scale 0.5 the offsets halve (against the downscaled full-resolution result, mean ≤ 2); `add_filter {type:
"<id>.chromatic_shift"}` and `filter_types` lists it; `export_test.py` `special`: `"<id>.chromatic_shift": [{ style:
"lateral", amount: 8 }, 1]` (the export gate enumerates plugin filters by itself; only `lut`, `film.points` and
`sample.*` are excluded, :251). `commands`, `document`, `lint`, `types`.

**Docs.** New `docs/EFFECTS.md` (the shape of FILM.md: filters, params, files, testing). MANUAL Filter layers: "Two
plugins ship with the app: the film pack and the effects pack." CHANGELOG: "A second built-in plugin, the effects pack,
starting with chromatic shift (the colour plates out of register, or colour fringes that grow towards the edges)."

**Risks.** The plugin id is permanent (stored documents carry it). Source textures are NEAREST, hence the manual
bilinear with an identical twin. Premultiplied interpolation at transparent edges. The viewport-edge clamp when zoomed
in (§5.3 intro).

**Effort.** 1 d.

#### R3-S10: glass I

**Goal.** The **Glass** filter (`<id>.glass`), a displacement computed in the shader with no image assets. Styles in
this session: *ribbed*, *reeded*, *wavy*, *blocks*; params *size*, *amount*, *angle*, *sheen*, *seed*. Plugins menu:
*Glass layer*.

**Preconditions.** R3-S9, R3-D9 (the style list).

**Changes.** New `plugins/<id>/glass.js`:

```js
params: style [ribbed | reeded | wavy | blocks] (R3-S11 adds frosted, pebbled), size 4..400 px (40), amount 0..100 px (12),
        angle -90..90 (0), sheen 0..100 % (15), seed 0..99 (0)
export function glassField(style, Px, Py, size, angle, seed) -> [dx, dy]   // |d| <= 1, image px of the full picture
//   ribbed: s = dot(P, dir) / size; d = sin(2 pi s) * dir
//   reeded: d = (2 fract(s) - 1) * dir          (a lens per rib, edges discontinuous)
//   wavy:   d = (sin(2 pi Py / size), sin(2 pi Px / size)) * 0.7071
//   blocks: cell = floor(R(-angle) P / size); d = (2 hash2(cell, seed) - 1, 2 hash2(cell + (17, 31), seed) - 1) * 0.7071
// shader: P = (u_pictureOrigin + uv * u_size) / u_scale; d = glassField(P) * amount * u_scale;
//         o = bilin(uv * u_size + d); sheen: k = sstep(0.55, 1.0, dot(normalize(vec3(-d_unit, 1.0)), L)) * sheen; o = screen3(o, vec3(k))
reach: (p) => (num(p.amount, 12) > 0 ? Math.ceil(num(p.amount, 12)) + 2 : 0)
```

**Tests (normal, both backends).** `effects_math_test.js`: |d| ≤ 1 on 100,000 samples per style; ribbed d = 0 at s =
k/2; blocks constant inside a cell, a new seed changes over 90 % of cells. `effects` gate: `gpu_vs_cpu` per style
(ribbed and wavy `max <= 4`, `over2 <= 0.1 %`; reeded and blocks, which have discontinuities, `over2 <= 0.1 %` and
pixels more than 4 levels apart ≤ 0.02 %); `amount 0, sheen 0` identity; ribbed on an x-ramp unchanged ±1 where sin =
0; the preview at scale 0.5 against the downscaled full resolution, mean ≤ 3; `export_test.py` `special`:
`"<id>.glass": [{ style: "ribbed", amount: 20, size: 60 }, 2]`.

**Docs.** EFFECTS.md; CHANGELOG (the glass line, completed in R3-S11).

**Risks.** float32 against double at `floor` and `fract` edges (the over2 rule). Large amounts make a large reach;
amount is capped at 100.

**Effort.** 1 d.

#### R3-S11: glass II (frosted, pebbled, frost blur, the 15k measurement)

**Goal.** Styles *frosted* (three octaves of value noise) and *pebbled* (cells with jittered centres, a lens per cell);
a *frost* blur (0..20 px) before the displacement; the export speed at 15k measured and written down.

**Changes.** `glass.js`: frosted `d = (2 fbm(P/size, seed) - 1, 2 fbm(P/size + 17.3, seed + 1) - 1)` clamped to |d| ≤ 1;
pebbled: the nearest jittered point f among 3 x 3 cells, `d = clamp((P - f) / (0.7 size))`; `frost > 0`: `b = blur(src,
frost * scale)` (one canvas round trip) and the displacement runs on `b` (still one sampler); `reach += frost > 0 ?
ceil(3 * frost) + 2 : 0`. `tools/export_test.py`: `--filter-params=<key>:<value>+<key>:<value>` beside `--filter=<id>`
(:1096, :1160; comma-free, because the runner splits `exportperf:*` at every comma, §2; parsed with `split("=", 1)`,
numbers as numbers), and CLAUDE.md's gate syntax
`exportperf:15000x10000,--filter=<id>.glass,--filter-params=style:frosted+amount:10+frost:4`.

**Tests.** `effects_math_test.js`: frosted |d| ≤ 1; pebbled d = 0 at the cell points. `effects` gate: `gpu_vs_cpu`
frosted (`max <= 4`, `over2 <= 0.1 %`) and pebbled (the over2 rule); frost with amount 0: GPU and CPU equal ±1 (they share
the canvas blur); a band `special` for frost `[{ style: "frosted", amount: 10, frost: 3 }, 3]` (Skia blurs smaller
canvases 1-3 levels apart). **Measured, not gated:** `exportperf:15000x10000` with glass at its defaults and with frosted
frost 4, and the film look with halation at the same size for comparison; the numbers go into this plan and, if slow, into
BUGS.md beside :336.

**Effort.** 1 d.

#### R3-S12: docs pass, measurements, the user's look

**Goal.** Everything written down. The user looks at the grading, HSL, point shapes and glass on `scene.jpg` and
`skin.jpg` and judges by eye; constants (`K_TINT`, `K_LUM`, the ±30° hue range, the glass defaults) change only on the
user's word (R3-D4).

**Changes.** MANUAL: the Filter layers chapter (colour grading, HSL, the effects pack, hover), the film-pack paragraph
(softness and the four shapes), the Layers notes (copy and paste mask). FILM.md, EFFECTS.md, PLUGINS.md (API 4 if not
done). DOCUMENTS.md §8 rows and §4.1 (`film.points` fields point to FILM.md). TESTING.md: the gates `grading`, `masks`,
`effects` and the Node tests `grade_test.js`, `points_shapes_test.js`, `effects_math_test.js`. CLAUDE.md: the gate list
and the hand-over. BUGS.md: :152 if fixed, the Escape routing as fixed, :336 if glass is slow. COMMANDS.md regenerated.

**Tests (light).** `help` (`tools/manual_test.js`: every "Plugins › X" and "Settings › X" the manual names exists),
`skins`, `lint`, `types`, and one full pass on tiles of `grading effects masks film export composite document commands
mcp assistant` as a dry run of R3-S13.

**Effort.** 0.5 d.

#### R3-S13: the release

The release session of §1.3. Release-specific parts: the CHANGELOG section says "A document with a colour grading, HSL
or effects layer, or a control point of the new shapes, needs Scumble 0.1.N or newer to open" (reader R; adjusted by
R3-D2); exe gates add `grading effects masks fill clip groups` on tiles and `grading effects masks` on the canvas run; the
blog's story: wheels and HSL, points that take any shape, glass and fringes, paste a mask, hover to preview (no other
product named as a model). 0.5-1 d.

### 5.4 Release 4: blend modes

**Count.** The research said 18 missing; linear light shipped in 0.1.32, so **17 are missing**: 16 with a closed
formula and dissolve, which depends on pixel position and is optional (R4-D1).

**Tiers are drawn by the shape of the kernel, not by what Canvas 2D has.** Every new mode is emulated in Canvas 2D
(F11's rows use `canvas: null`, R4-D4), so the canvas backend draws the new modes with the same kernel (CPU) and shader
(screen) as tiles, and Skia's native colour dodge and friends no longer decide correctness. **A**: six integer-exact
modes the SIMD path can take. **B**: four division modes, scalar only. **C**: six whole-pixel modes, scalar only, exact
integer W3C.

**Paths each mode reaches:** the Rust kernel (SIMD and scalar, `crates/px/src/composite.rs`); the JS twin
(`px/kernels_js.js`); the GL compositor (`BLEND_FN_GLSL` after F12); the Canvas 2D emulation (`blendEmulated`: GPU
shader on screen, `compositeTile` off screen); the worker stack (`stackPlan`'s `OPS[l.blend]`; `rowsOfStack`,
`boxstack` and `stackPoints` follow); the PSD writer (twice) and reader; the ORA writer (twice) and reader;
`.scumble` (the id plus `minReader`); `set_layer` (its enum, the MCP schema, COMMANDS.md). TIFF needs no table:
`writeTiff` (`inpaint_bands.js:183`) writes only the flattened picture, and the TIFF reader reads no layers
(`inpaint_tiff.js:239`); it gets a test that the paths agree.

**Dependencies.** F11 and F12 open the release (R4-S1, R4-S2). F1 and F2 are used when built (recommended first if this
release comes first; each session says what to do without them). Nothing from releases 1-3 (G1).

**What stays.** Groups stay pass-through folders with no blend of their own (item 27 parked). The assistant keeps
`blend` in `SET_LAYER_SOFT` (`policy.js:24`). A blend change makes no undo step (the layer row's handler, ~15033).
`composite_test.py`'s ten-column document and its references (`tools/refs/composite_full.png`, `composite_view.png`)
never change in this release.

**The reader number.** R per §1.2, taken at R4-S4; all new modes share it, because they ship together.

#### 5.4.1 The mode table (the one source for R4-S4 to R4-S9)

Notation: b and s are the straight backdrop and source bytes, 0..255. `B16 = 255·255·B`, an integer in 0..65025; this
is what `blend_of` / `blend3` return, and it enters `composite.rs`' composite formulas unchanged (opaque backdrop:
`(dp·inv·255 + sa·B16 + 32512) / 65025`; otherwise the 16581375 form). `R(N, M) = ⌊(2N + M) / (2M)⌋` for N ≥ 0, M > 0
(round half up). "Float B" is what `px_test.js` `blendFloat` and the GLSL branch compute, on 0..1 values. Every row has
`canvas: null` (emulated) and `reader: R`.

| op | id | label (R4-D5) | group | tier | B16 (kernel, integers) | float B (px_test, GLSL) | SIMD | PSD | ORA write | ORA read extra (unverified unless noted) |
|---|---|---|---|---|---|---|---|---|---|---|
| 14 | `exclusion` | Exclusion | inversion | A | `b(255−s) + s(255−b)` (no u32 underflow) | `b + s − 2bs` | yes | `smud` | `scumble:exclusion`, or `svg:exclusion` if the OpenRaster spec lists it (R4-D9) | `svg:exclusion`, `krita:exclusion` |
| 15 | `linear-dodge` | Linear dodge (add) | lighten | A | `255·min(255, b+s)` | `min(1, b+s)` | yes | `lddg` | `scumble:linear-dodge` | `krita:linear_dodge`, `krita:add`; **not** `svg:plus` (Porter-Duff plus adds alpha) |
| 16 | `linear-burn` | Linear burn | darken | A | `255·(max(255, b+s) − 255)` | `max(0, b+s−1)` | yes | `lbrn` | `scumble:linear-burn` | `krita:linear_burn` |
| 17 | `subtract` | Subtract | inversion | A | `255·(max(b,s) − s)` | `max(0, b−s)` | yes | `fsub` | `scumble:subtract` | `krita:subtract` |
| 18 | `pin-light` | Pin light | contrast | A | `s ≤ 127 ? 255·min(b, 2s) : 255·max(b, 2s−255)` | `s ≤ ½ ? min(b,2s) : max(b, 2s−1)` | yes | `pLit` | `scumble:pin-light` | `krita:pin_light` |
| 19 | `hard-mix` | Hard mix | contrast | A | `b + s ≥ 255 ? 65025 : 0` (tie: R4-D2) | the same on rounded bytes (GLSL) | yes | `hMix` | `scumble:hard-mix` | `krita:hard mix`, `krita:hard_mix_photoshop` |
| 20 | `color-dodge` | Colour dodge | lighten | B | `b=0 → 0; s=255 → 65025; else min(65025, R(65025·b, 255−s))` | `b=0 → 0; s=1 → 1; else min(1, b/(1−s))` | no | `div ` | `svg:color-dodge` | - |
| 21 | `color-burn` | Colour burn | darken | B | `b=255 → 65025; s=0 → 0; else 65025 − min(65025, R(65025·(255−b), s))` | `b=1 → 1; s=0 → 0; else 1 − min(1, (1−b)/s)` | no | `idiv` | `svg:color-burn` | - |
| 22 | `vivid-light` | Vivid light | contrast | B | `s ≤ 127 ? burn16(b, 2s) : dodge16(b, 2s−255)` | `s ≤ ½ ? burn(b,2s) : dodge(b, 2s−1)` | no | `vLit` | `scumble:vivid-light` | `krita:vivid_light` |
| 23 | `divide` | Divide | inversion | B | `s=0 → (b=0 ? 0 : 65025); else min(65025, R(65025·b, s))` | `s=0 → (b=0 ? 0 : 1); else min(1, b/s)` | no | `fdiv` | `scumble:divide` | `krita:divide` |
| 24 | `hue` | Hue | component | C | §5.4.2: P = SetSat(S, Sat(B)), L = Lum(B) | W3C `SetLum(SetSat(Cs, Sat(Cb)), Lum(Cb))` | no | `hue ` | `svg:hue` | - |
| 25 | `saturation` | Saturation | component | C | §5.4.2: P = SetSat(B, Sat(S)), L = Lum(B) | W3C | no | `sat ` | `svg:saturation` | - |
| 26 | `color` | Colour | component | C | §5.4.2: P = S, D = 1, L = Lum(B) | W3C | no | `colr` | `svg:color` | - |
| 27 | `luminosity` | Luminosity | component | C | §5.4.2: P = B, D = 1, L = Lum(S) | W3C | no | `lum ` | `svg:luminosity` | - |
| 28 | `darker-color` | Darker colour | darken | C | `ΣS < ΣB ? 255·S : 255·B`; a tie keeps B (R4-D3) | the same on rounded bytes | no | `dkCl` | `scumble:darker-color` | `krita:darker color` |
| 29 | `lighter-color` | Lighter colour | lighten | C | `ΣS > ΣB ? 255·S : 255·B` | the same on rounded bytes | no | `lgCl` | `scumble:lighter-color` | `krita:lighter color` |
| - | `dissolve` | Dissolve | normal | R4-S9 | not a kernel op | - | - | `diss` | `scumble:dissolve` | `krita:dissolve` |

Checks: the R form of dodge is `⌊(130050·b + d)/(2d)⌋` with `d = 255 − s`, every numerator below 2^25. The PSD keys are
the blend keys of Adobe's file-format spec; `hue ` here is the blend key, another namespace than `ADJUSTMENTS`' `hue `
(an additional-info key) in `inpaint_layered.js`. OpenRaster names (from memory, to confirm by reading the spec page in
R4-S4): `svg:color-dodge`, `color-burn`, `hue`, `saturation`, `color`, `luminosity`; `svg:exclusion` probably not
listed.

**Grouped order for R4-S8** (the row order of `BLENDS` from then on; until R4-S8 new rows are appended after
`difference`):

| Group | Modes |
|---|---|
| Normal | normal, dissolve |
| Darken | darken, multiply, color-burn, linear-burn, darker-color |
| Lighten | lighten, screen, color-dodge, linear-dodge, lighter-color |
| Contrast | overlay, soft-light, hard-light, vivid-light, linear-light, pin-light, hard-mix |
| Inversion | difference, exclusion, subtract, divide |
| Component | hue, saturation, color, luminosity |

#### 5.4.2 Shared rules of release 4

**Tier C in exact integers** (f64 only as a fallback if a measurement fails; exact integers make Rust and JS equal by
construction and let the px_test reference demand zero difference):

```
Lum100(c) = 30·c0 + 59·c1 + 11·c2            // W3C 0.3 / 0.59 / 0.11, exact over 100
Sat(c)    = max(c) − min(c)
pre-lum colour P / D and target L:
  hue:        D = max(s) − min(s); D = 0 → P = (0,0,0), D = 1; else P_i = (s_i − min(s))·Sat(b);  L = Lum100(b)
  saturation: the same with b for s and Sat(s) for Sat(b);                                       L = Lum100(b)
  color:      P = s, D = 1;  L = Lum100(b)        luminosity: P = b, D = 1;  L = Lum100(s)
U_i = 100·P_i + L·D − Lum100(P);  Un = min U;  Ux = max U;  Lu = L·D
  Un < 0:            B16_i = R(255·L·(U_i − Un), 100·(Lu − Un))
  else Ux > 25500·D: B16_i = R(255·(L·(Ux − Lu) + (U_i − Lu)·(25500 − L)), 100·(Ux − Lu))
  else:              B16_i = R(255·U_i, 100·D)
```

Why it is exact: it equals 255·255 times W3C's `SetLum` / `ClipColor` / `SetSat`, rounded once, half up; D cancels out
of the two clip branches; the Lum of the shifted colour equals L exactly (the weights sum to 100); the two clip branches
cannot both apply (the range of U is at most 25500·D), so this is `else if` where W3C writes two `if`s; every numerator
is ≥ 0; the largest intermediate is about 3.4·10^14 < 2^53, so JS `Number` plus `Math.floor` is exact (the gap to the
next integer is ≥ 1/(2M) ≥ 1.25·10^-10 against an ulp of about 1.4·10^-11). Rust uses i64; in JS no `| 0` on the large
numerators.

**GLSL rules.** Helpers in `BLEND_FN_GLSL` carry a `bm_` prefix (`bm_lum`, `bm_clip`, `bm_setLum`, `bm_sat`,
`bm_setSat`, `bm_dodge`, `bm_burn`, `bm_q8`): the film PRELUDE already has `sstep`, `luma`, `sat3`, and `pluginSource`
reserves `u_src` and the rest. Never `filter`, `half` or `sample` as names; never a backtick inside a GLSL comment.
Thresholds on sums compare **rounded bytes** (`floor(x*255.0+0.5)`): hard mix, darker and lighter colour do this,
because `k1/255 + k2/255` is not exactly 1.0 in float32. `bm_setSat(c, s) = mx > mn ? (c − mn)·s/(mx − mn) : vec3(0)`
is W3C's Cmid algorithm in closed form.

**Tests live in the new `blendmodes` gate** (R4-S3). `editor_test.py` stays as it is. The gate takes its mode list from
`blend_modes.js` in the page, so every later row enters it by itself.

#### R4-S1: the blend registry (F11)

Build F11 (§4) exactly. Nothing changes on screen; afterwards a blend id this version does not know draws as normal on
every path, and the GL view refuses a mode it lacks instead of drawing it as normal. Without F1, fix the 1 / 1 drift in
DOCUMENTS.md (:93, :278, :388-389) here. 1 d.

#### R4-S2: per-pixel structure, one emulated shader, safe unknown ops (F12)

Build F12 (§4) exactly, its "measure first" before any edit. Nothing changes on screen; afterwards a whole-pixel mode
fits the kernel and every emulated mode gets the GPU path on screen. Record the timing in `docs/PERFORMANCE.md` only if
it moved. 1 d.

#### R4-S3: the `blendmodes` gate and the baseline (test tooling only)

**Goal.** A reference-free gate that holds every mode to the kernel on every path, run first on the nine existing
modes, whose numbers set the tolerance classes; performance flags for blend stacks. Nothing changes in the app.

**Preconditions.** R4-S1, R4-S2. Ask the user now for R4-D6 (a PSD with every mode from another editor), so it is there
by R4-S8.

**Changes.**

1. **`tools/blendmodes_test.py`** (new; `run_gates.sh`'s `*)` rule; a case line with a larger timeout if it measures
   above about 300 s). Shaped like `composite_test.py`: a cdp session, steps as JS strings, a last line PASS / FAIL. A
   node pre-step runs `node tools/blend_table_test.js` (as `help_test.py:52-57`). In the page `MODES =
   BLENDS.filter(r => r.op >= 5)`; Python's `BOUNDS = { id: { "gl_translucent": n, "flips": f } }` holds dated, measured
   values with a default. Every step closes its documents with `force: true`. Steps:
   - a. **`pairs_document`.** `new_canvas` 256 x 256. Base from ImageData: R = x, G = y, B = (7x + 3y) & 255, A = 255;
     layer "mode": R = y, G = x, B = (11x + 5y + 17) & 255, A = 255 (R and G cover all 65,536 (b, s) pairs each way, B
     gives 65,536 distinct triplets for tier C). The kernel's own answer per mode: `kernels_js.compositeTile(base,
     [layer], [op], [255])`.
   - b. **`the_export_is_the_kernel`.** Tiles: `encodeComposite({ forRun: true }, { hash: false })` with `r.stack` set
     (written from the stack), decoded, equals the kernel (0 bytes differ); canvas backend: the flatten, 0 bytes.
   - c. **`the_flatten_is_the_kernel`** (both backends): `flattenToCanvas({ forRun: true })`; emulated modes 0 bytes;
     native modes (Skia) reported and gated ≤ 3 as export_test does.
   - d. **`the_gpu_compositor_is_the_kernel`.** View scale 1 at integer offsets, `compositorOff = false`,
     `glCompositeUsable({})` true; the document's rectangle read from `ed.canvas`: opaque ≤ 1 level.
   - e. **`the_canvas_view_is_the_kernel`.** `compositorOff = true` (Canvas 2D on screen: the emulated shader or Skia):
     emulated ≤ 1; native reported.
   - f. **`translucent_masked_clipped`.** Layer A = (x ^ (y << 1)) & 255, opacity 0.75: (b) equals the kernel with alpha
     191 (0 bytes); (d) and (e) max, mean and count over 2 per mode, gated by `BOUNDS`; a gradient mask, then the mode
     layer clipped onto a half-transparent base: worker against flatten ≤ 3 with over2 ≤ 10^-4 (export_test's
     tolerance).
   - g. **`a_fill_layer_in_every_mode`.** `addFilterLayer("fill")`, `#806040`, opacity 0.6: worker stack (the filter
     entry's `fop`) against flatten ≤ 3.
   - h. **`psd_and_ora_keep_every_mode`.** One 32 x 32 layer per mode; `run("export", { format: "psd" / "ora", path })`,
     then open it (the `layered_test.py:62-95` pattern): every blend comes back.
   - i. **`documents_ask_for_the_right_reader`.** `save_document` holding every mode: the header's `minReader` equals the
     highest `READER_OF_BLEND` present; reopening keeps every blend.
   - j. **`set_layer_takes_every_mode`.** Each id accepted; `"colour-dodge"` (British spelling) refused with the list.
   - k. **`tiff_png_and_merge_agree`.** `encodeTiff` against the `encodeComposite` PNG, decoded: 0 bytes; merging the
     mode layer into the base: the base bytes equal the export before it (0; opaque).
2. **`tools/export_test.py` PERF:** `__BLEND__` from `--blend=<id>` goes onto the paint layers
   (`exportperf:15000x10000,--blend=multiply`).
3. **`tools/perf_test.py`:** `--blend=<id>` onto its paint layers (its film-look filter layer keeps the screen on
   `drawLayersInto`, so every emulated layer goes through the shader each frame: the per-frame cost to measure). If
   release 4 comes before R1-S7b, `run_gates.sh`'s `perf:*` (:103) gets the comma split of `exportperf:*` here, so the
   gate reads `perf:6000x4000,--blend=linear-light` (§2).
4. **Docs:** `docs/TESTING.md` (the gate's paragraph), CLAUDE.md's gate list, `run_gates.sh`'s header comment
   (`blendmodes`), `docs/PLAN_NIK9.md` (the baseline table).

**Measure (the session's product).** For the nine existing modes: GL against the kernel, opaque and translucent; Skia
against the kernel (expected: opaque ≤ 1; translucent ≤ 2-3 for overlay, soft light and hard light).
`exportperf:15000x10000,--blend=multiply` and `--blend=linear-light` (both SIMD). `perf:6000x4000,--blend=linear-light`
in a `--tiles off` run (today's emulated per-frame cost). Optional, informs R4-D4: Skia's native colour dodge, colour burn,
exclusion, hue, saturation, color and luminosity against §5.4.1's formulas (an in-page JS reference) on the pairs
document, on a GPU and a `willReadFrequently` canvas.

**Tests (normal).** The gate on both backends, `--offline`, passes on the ten modes. A three-mutant self-check that
each step bites: the reference uses op + 1 ((b) fails); the compositor uses `|| 0` without the lookup ((d) fails); the
PSD writer maps everything to `norm` ((h) fails).

**Effort.** 0.5-1 d.

#### R4-S4: tier A (exclusion, linear dodge, linear burn, subtract, pin light, hard mix: ops 14-19, ABI 15)

**Goal.** Six new entries at the end of the layer row's Blend list (ungrouped until R4-S8). They look the same on
screen, in every export and in a run; PSD keeps them both ways, ORA only for Scumble; `set_layer` and MCP take the
names; a document using one needs the new reader.

**Preconditions.** R4-S1 to S3. R4-D2 (hard-mix tie; default `≥`, white), R4-D9 (ORA naming), G5 (R fixed). Read the
OpenRaster layer-stack spec page once to settle `svg:exclusion`.

**Changes.**

1. `composite.rs`: constants `EXCLUSION` 14, `LINEAR_DODGE` 15, `LINEAR_BURN` 16, `SUBTRACT` 17, `PIN_LIGHT` 18,
   `HARD_MIX` 19; `LAST_BLEND = HARD_MIX`; `blend_of` / `blend_from` arms per §5.4.1; SIMD `blend_pixel` arms in u32
   lanes with no underflow (exclusion `d·(255−s) + s·(255−d)`; linear dodge `min(d+s, 255)·255`; linear burn `(max(d+s,
   255) − 255)·255`; subtract `(max(d,s) − s)·255`; pin light `bitselect(max(d, max(2s,255)−255), min(d, 2s), s >
   127)·255`; hard mix `(d + s ≥ 255) & 65025`); `SIMD_BLENDS` += the six; the header comment's formula list.
2. `lib.rs`: `px_abi_version` 15 ("15: blend ops 14 to 19") and the op list in `composite_tile`'s doc comment.
   `px.js`: `PX_ABI = 15`. Rebuild: `build_px.py`, then `--check`.
3. `kernels_js.js`: cases 14-19 in `blendOf` (used by `blend3`), and the doc comment.
4. `BLEND_FN_GLSL`, in `blend1`:

   ```glsl
   if (mode == 14) return b + s - 2.0 * b * s;
   if (mode == 15) return min(1.0, b + s);
   if (mode == 16) return max(0.0, b + s - 1.0);
   if (mode == 17) return max(0.0, b - s);
   if (mode == 18) return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);
   if (mode == 19) return floor(b * 255.0 + 0.5) + floor(s * 255.0 + 0.5) >= 255.0 ? 1.0 : 0.0;
   ```

5. `blend_modes.js`: six rows from §5.4.1, `reader: R`, appended. `docfile.js`: `READER_OF_BLEND` += the six at R (with
   F1 the rows follow; without F1 `READER_VERSION` derives to R and the "newer" fixtures move: `document_test.js:313`,
   `:320`, `document_test.py:1208` and its docstring :36, from the literal 3 to `R + 1`).
6. `tools/px_test.js`: exhaustive opaque pairs at full opacity in closed form (linear dodge `min(255, b+s)`, linear burn
   `max(0, b+s−255)`, subtract `max(0, b−s)`, pin light per §5.4.1, hard mix 0 / 255), each exact (0 differ) on the twin
   and both wasm builds; exclusion against the reference; `blendRef` and `blendFloat` entries; the loops `op <=
   LAST_BLEND` and `ops.push((trial + l) % (LAST_BLEND + 1))`; `LAST_BLEND + 1` composites as source-over; the timing row
   adds ops 14 and 18; the float checks keep their bounds (≤ 0.51 at full opacity, ≤ 1 otherwise; translucent ratio ≤
   1).
7. `tools/blendmodes_test.py`: `BOUNDS` for the six, from the first run.
8. Docs: `docs/COMMANDS.md` regenerated (`python tools/commands_doc.py` against an offline dev instance; F2's freshness
   check fails otherwise); `DOCUMENTS.md` §4 blend row (:180) and the reader; the CHANGELOG line.

**Tests (full).** `node tools/px_test.js` (all three builds), `build_px --check`, `pxjobs`; gates `--offline` on both
backends: `blendmodes`, `composite --strict` (references unchanged), `export` (its loop takes the six), `layered`,
`document`, `clip`, `fill`, `groups`, `pixels`, `editor`, `commands`, `mcp`, `nodecopy`, `node`, `lint`, `types`.
Mutation round: Rust exclusion `2·b·s` → `b·s` (pairs fail); pin-light threshold 127 → 128 (pairs fail); hard mix `≥` →
`>` (pairs fail); SIMD linear burn without the max (u32 wrap; `px.wasm` only, "each alone over an opaque tile"); JS
subtract unclamped (twin against reference); GLSL linear dodge without `min` (`blendmodes` (d)); the docfile row deleted
(document).

**Measure first.** The SIMD path takes the six: the timing row shows the SIMD build at least 2× faster than scalar, like
multiply. `exportperf:15000x10000,--blend=exclusion` against `--blend=multiply`: at most 10 % slower.

**Risks.** Hard mix at a zoom below 100 % thresholds mip averages, so the fit view differs from the export (reported,
not gated, as composite's fit row is). The Krita spellings are unverified (the linear-light precedent).

**Docs line (Unreleased; extended in R4-S5 and S7, finalised in S8).** "**Six more blend modes**: exclusion, linear
dodge (add), linear burn, subtract, pin light and hard mix, computed the same way on screen, in an export and in a run;
PSD files keep them both ways. A document with one of them needs this version or newer."

**Effort.** 1 d.

#### R4-S5: tier B (colour dodge, colour burn, vivid light, divide: ops 20-23, ABI 16)

**Goal.** Four more modes, the division ones. ORA keeps colour dodge and colour burn in OpenRaster's own names.

**Preconditions.** R4-S4.

**Changes.**

1. `composite.rs`: constants 20-23, `LAST_BLEND = DIVIDE`; helpers `dodge16(b, s)` and `burn16(b, s)` in u32 per
   §5.4.1 (numerators < 2^25) and arms for 20-23; not in `SIMD_BLENDS`.
2. ABI 16 in `lib.rs` and `px.js`; rebuild and `--check`.
3. `kernels_js.js`: the same cases (`Math.floor` on exact quotients; numerators < 2^26).
4. `BLEND_FN_GLSL`: `bm_dodge(b, s) = b <= 0 ? 0 : s >= 1 ? 1 : min(1, b / (1 − s))`, `bm_burn`, branches 20-23 per
   §5.4.1. **Measure, then decide:** quantise `b` and `s` with `bm_q8` in these four branches only, kept if it lowers the
   translucent maximum against the kernel; existing branches never change (the composite references would move).
5. `blend_modes.js`: four rows (ORA `svg:color-dodge`, `svg:color-burn`). `docfile.js`: four entries at R.
6. `px_test.js`: exhaustive opaque pairs against the reference (0 differ, all three builds); against floats at full
   opacity ≤ 0.51 levels; edge sets b ∈ {0, 255} × s ∈ {0, 127, 128, 254, 255}; **for ops ≥ 20 the translucent float
   check uses the kernel's own `cb`** (`dp = mul255(d, da)`, `cb = min(255, ⌊(dp·255 + ⌊da/2⌋)/da⌋)`) under the same
   bound, and the raw deviation is printed, not gated (a slope of up to 255 near s = 255 magnifies the backdrop's 8-bit
   storage, as in any premultiplied compositor).
7. `layered_test.js`: confirm the unknown-key case no longer uses `vLit` (moved in R4-S1).
8. `BOUNDS`, `COMMANDS.md`, `DOCUMENTS.md`, the CHANGELOG line extended.

**Tests (full).** Everything R4-S4 runs. Mutation round: dodge's `+ d` → `+ 0` (pairs fail); burn's edge order swapped
(`s=0` before `b=255`; pairs at (255, 0) fail); the vivid-light threshold (pairs fail); divide without its `s=0` branch
(a twin exception or a wrong value); GLSL burn `1 − min` → `min` (`blendmodes` (d)).

**Measure first.** `exportperf:15000x10000,--blend=color-dodge` against multiply, scalar only (record; more than 1.5× is
a flag for the user, not a stop); `perf:6000x4000,--blend=color-dodge` in a `--tiles off` run (the emulated per-frame
cost); the GL
translucent maximum with and without `bm_q8`.

**Risks.** GL on translucent pixels near s ≈ 1: the source comes from a premultiplied 8-bit texture, so the view can be
several levels off the export on half-transparent edges of these four modes; measure, put it in `BOUNDS`, one sentence
in the manual (R4-S8). Opaque pixels stay ≤ 1.

**Effort.** 1 d.

#### R4-S6: tier C, the kernel (hue, saturation, colour, luminosity, darker colour, lighter colour: ops 24-29, ABI 17)

**Goal.** The kernel and the twin learn the whole-pixel modes in exact integers (§5.4.2). The registry does not list
them yet, so no path calls them; nothing changes for the user.

**Preconditions.** R4-S5 (ops 20-23 and ABI 16 come first, so these are 24-29 and ABI 17), R4-S2 (`blend3`). R4-D3
(default: channel sum; a tie keeps the backdrop).

**Changes.**

1. `composite.rs`: constants 24-29, `LAST_BLEND = LIGHTER_COLOR`; `fn nonsep(op: u8, b: [u32; 3], s: [u32; 3]) -> [u32;
   3]` in i64 per §5.4.2; `blend3` arms for 24-27 call it, 28 and 29 compare sums; `blend_from` arms; not in SIMD.
2. ABI 17; rebuild and `--check`.
3. `kernels_js.js`: the same algorithm in `Number` arithmetic with `Math.floor`, no `| 0` on the large terms.
4. `px_test.js`: `blendRef3(op, b3, s3)` written **independently** from W3C's pseudo-code (a small BigInt fraction
   type; `Lum = 3/10·r + 59/100·g + 11/100·b`; `ClipColor` with its two `if`s; `SetSat` by the Cmid algorithm; B16 =
   R(…) half up); the reference `compositeTile`'s `blended(c)` takes the pixel's three B16 values. Cases: 2^18 random
   triplet pairs; edge sets (greys, all 65,536 grey pairs; primaries and secondaries; two equal maxima or minima; equal
   channel sums for the darker / lighter ties; black and white backdrops); each at opacities 255 and 140, with and
   without a mask, over opaque and translucent backdrops. Twin = `px.wasm` = `px_scalar.wasm` byte for byte and **equal
   to the BigInt reference (0 differ)**. The timing row adds ops 24 and 28.

**Tests (full).** `px_test` (all three builds), `build_px --check`, `pxjobs`; the wasm changed, so `composite --strict`
and `export` on both backends (references unchanged). Mutation round, each must fail px_test: the Lum weight 59 → 60;
the clip-x branch with `(Ux − Un)` for `(Ux − Lu)`; `SetSat` not zeroed at D = 0; the darker tie `<` → `≤`; hue's
`SetSat` inputs swapped with saturation's; R truncating instead of half up.

**Measure first.** The timing row for 24 and 28 (i64 divisions, scalar): about 4× multiply's scalar time is acceptable;
above that, report to the user before R4-S7.

**Risks.** If a measured case breaks §5.4.2's bounds (it should not; the bounds are analytic), fall back to f64 in the
same order of operations in both twins (`cmatch.rs` is the precedent for float twins), and px_test against the BigInt
reference then allows ≤ 1 level on a rare tie.

**Effort.** 1 d.

#### R4-S7: tier C, the paths

**Goal.** Six more modes in the list; all 16 deterministic modes work everywhere.

**Preconditions.** R4-S6.

**Changes.** `BLEND_FN_GLSL`: `bm_lum` = `dot(c, vec3(0.3, 0.59, 0.11))`, `bm_clip` (W3C's two `if`s), `bm_setLum`,
`bm_sat`, `bm_setSat` (closed form); `blendRGB`: `if (mode >= 24 && mode <= 27)` the W3C compositions, 28 and 29 compare
sums of rounded bytes, otherwise per channel through `blend1`. `blend_modes.js`: six rows (§5.4.1). `docfile.js`: six
entries at R. `BOUNDS`, `COMMANDS.md`, `DOCUMENTS.md`, CHANGELOG.

**Tests (full).** `blendmodes` on both backends ((d) and (e) opaque ≤ 1; flips on darker / lighter ties counted);
`composite --strict`, `export`, `layered`, `document`, `clip`, `fill`, `groups`, `pixels`, `commands`, `mcp`,
`nodecopy`, `node`, `lint`, `types`. Mutation round: the GLSL `bm_setSat` denominator; the GLSL Lum weights; the PSD
keys of hue and saturation swapped (`layered` / (h) fails); darker colour compared in float instead of on bytes (the
flips gate in (f)).

**Measure first.** GL against the kernel on opaque pixels for 24-27: expected ≤ 1 (float32 against exact); if
`ClipColor`'s near-singular denominators push past that, document it and set `BOUNDS`.

**Effort.** 0.5-1 d.

#### R4-S8: the grouped list, references, docs, and the live PSD check

**Goal.** The Blend list in the layer row is grouped (Normal, Darken, Lighten, Contrast, Inversion, Component, or
R4-D5's names) with readable labels; the manual describes the modes; the other editor's PSD has been compared.

**Preconditions.** R4-S7. R4-D5, R4-D6's file if provided, R4-D7, R4-D8.

**Changes.**

1. `blend_modes.js`: rows reordered into §5.4.1's group order; final labels; `BLEND_GROUPS = [{ id, label }]`.
2. `inpaint_canvas.js`: `selectGrouped(rows, value, title)` beside `selectInput` (~767): one `<optgroup label>` per
   group, `value` = id, text = label, the same click / keydown `stopPropagation`; the layer row (~15032) uses it; its
   change handler is unchanged. Arrow keys on the focused, closed select already apply each mode as a preview (`change`
   fires); hover previews in a native select are impossible in Chromium.
3. References: a `references` step in `blendmodes_test.py` on a showcase document of 1024 x 640 (composite_test's base,
   gradient and bars, plus 25 columns, one per non-normal mode with a formula (the 9 of today and the 16 new; dissolve
   stays out, R4-S9 tests it on its own, so the references never move for it), 32 px wide and 36 apart, each holding
   composite_test's gradient layer at opacity 0.75 with its white and black rectangles); `tools/refs/blendmodes_full.png`
   and `blendmodes_view.png` taken **once**, with `--update` on tiles, after the last formula change; full identical on
   both backends, view within the measured tolerance (composite's view rule: 3).
4. PSD reader, fill opacity (R4-D8): read `L.info.iOpa[0]`. Default: a note "fill opacity below 100 % read as 100 % (n
   layers)". Option: fold it into opacity where fill and opacity act alike, and keep the note for colour burn, linear
   burn, colour dodge, linear dodge, vivid light, linear light, hard mix and difference (that list is unverified).
5. Live check (R4-D6, R4-D7), before the release: open the user's PSD, flatten it, compare each mode's region against
   the PSD's own merged picture (`readPsd`'s `composite`); a max / mean table into PLAN_NIK9; a deviation over 2 levels
   goes to the user (a formula change after the release changes saved documents' pictures); an optional Krita ORA
   confirms or removes the unverified `krita:` aliases; the file becomes a fixture only on the user's word.
6. Docs: `MANUAL.md:222` replaced (below); `DOCUMENTS.md` §4 blend row with the final list and reader; the final
   CHANGELOG bullet; README :85 optional ("26 blend modes", 27 once R4-S9 ships dissolve); `COMMANDS.md` regenerated
   (the enum order changes);
   `TESTING.md` (references); PLAN_NIK9 status "release 4 built".

Proposed manual paragraph: "Blend modes, grouped by what they do: darken (darken, multiply, colour burn, linear burn,
darker colour), lighten (lighten, screen, colour dodge, linear dodge, lighter colour), contrast (overlay, soft light,
hard light, vivid light, linear light, pin light, hard mix), inversion (difference, exclusion, subtract, divide) and
component (hue, saturation, colour, luminosity). Each is computed with a single rounding per channel, so a stack looks
the same on screen as in the exported file; on the half-transparent edges of a layer in colour dodge, colour burn,
vivid light or divide the screen can be a few levels off the export. PSD files keep every mode both ways; an ORA keeps
colour dodge and burn, hue, saturation, colour and luminosity for other programs and the rest for Scumble. A document
with one of the newer modes needs Scumble 0.1.N or newer."

Proposed final CHANGELOG bullet: "**Sixteen more blend modes** (seventeen with dissolve): colour burn, linear burn and
darker colour; colour dodge, linear dodge (add) and lighter colour; vivid light, pin light and hard mix; exclusion,
subtract and divide; hue, saturation, colour and luminosity. The layer row's list is grouped by what the modes do. Every
mode is computed the same way on screen, in an export and in a run, PSD files keep them both ways, and a PSD layer in
one of them no longer opens as normal. A document with one of the new modes needs 0.1.N or newer; `set_layer` takes the
new names."

**Tests (normal / light).** `blendmodes` (both backends, references), `composite` (unchanged), `layered`, `help`,
`skins` (no CSS expected), `commands`, `lint`, `types`; one look in the app (the user judges the list). If R4-D8 folds
fill opacity into opacity, item 4 changes how PSDs from other programs read (a reader path): then `layered` on both
backends and a hand mutation (the fold skipped) as well.

**Effort.** 0.5-1 d.

#### R4-S9: dissolve (optional, on the user's word, R4-D1; two sittings, R4-S9a and R4-S9b)

**Goal.** Dissolve keeps a random share of the layer's pixels, as many as its alpha and opacity say. The pattern is
fixed in the picture, so the export equals the screen at 100 %.

**Design.** Row `{ id: "dissolve", op: 0, dither: true, canvas: null, psd: "diss", ora: "scumble:dissolve", group:
"normal", reader: R }`; op 0 keeps it out of `BLEND_OPS`, so `glCompositeUsable` sends the view to Canvas 2D and the GL
compositor needs no branch. Rule at image pixel (x, y): with `c = mul255(mul255(srcA, alpha255), mask)` (the clip
coverage folded into the mask), keep the pixel iff `c == 255 || (hash32(x, y, seed) >>> 24) < c`; a kept pixel
composites opaque, a dropped one is nothing. `hash32` is lowbias32 over `(x·0x9E3779B1) ^ (y·0x85EBCA77) ^ seed`, with
`Math.imul` and `>>> 0` in JS and `uint` in GLSL ES 3.00 (both wrap mod 2^32). `seed` = FNV-1a of `layer.id` (which
persists).

**Changes.** `stackPlan` entries get `dissolve: seed` instead of returning null. `inpaint_worker.js` `rowsOfStack`,
`stackPoints` and `inpaint_boxstack.js` dither the entry's source rows into a scratch copy at their image origins (`X0`,
`Y0` or `xs`, `ys`), then use op 0 at alpha 255. `blendEmulated`: on the CPU dither the scratch at image coordinates from
`ctx.getTransform()`'s inverse; on screen a `DISSOLVE_SHADER` through `runShader` hashes at
`floor(inverse(transform)·fragPx)` (below 100 % a subsample of the true pattern; at 100 % identical). The merges go
through `blendEmulated`. PSD / ORA rows.

**Tests (full: it changes the worker stack, the merges and the PSD / ORA writers, and adds a FEATURES entry).** Export
against flatten: 0 bytes; the canvas view at 1:1 against the kernel's dither: 0 bytes; the kept share at alpha 128 is
50 % ± 1 % over 256²; the PSD key round trip; `READER_OF_BLEND` has dissolve at R (the `blend_table_test.js`
cross-check); `blendmodes`, `composite --strict` (references unchanged), `export`, `layered`, `document`, `clip`,
`fill`, `groups` on both backends; `exportperf:15000x10000,--blend=dissolve`. Mutation round: the hash's `>>> 24`
taken as `>>> 23` (the share fails); the dither skipped in `inpaint_boxstack.js` (export against flatten fails); the
PSD key dropped (`layered` fails).

**Sittings.** R4-S9a (1 d): the row, `stackPlan`, the worker and box-stack dither, the merges, the tests above but the
view; R4-S9b (0.5 d): `DISSOLVE_SHADER`, the canvas view at 1:1, the measurement.

**Risks.** A document turn re-seeds the picture (image coordinates change). Other editors draw their own pattern over
our PSD's layer; the merged image is ours. The view below 100 % differs from the export by its nature.

**Effort.** about 1.5 d.

#### R4-S10: the release

The release session of §1.3. Release-specific parts: exe gates add `blendmodes clip fill groups` on tiles and
`blendmodes clip fill groups export layered` on the canvas run; `node tools/px_test.js` against the built binaries; the
blog's content: the groups and what they are for (a dodge for highlights, colour or luminosity to change a colour
without its tone), and that PSDs from other programs keep their modes; if a node version ships with it, the node's
`mcp/inpaint_canvas_mcp.py:496-497` docstring and `js/inpaint_bridge.js:257` (`set_layer` takes any string today) need
the new list and a check. 0.5-1 d.

## 6. Open questions for the user

Each question names the session that needs the answer. A proposed default is given where the planners had one; a
session never starts on a default the user has not seen.

### 6.1 General

| Id | Question | Needed by |
|---|---|---|
| G1 | **Release order.** Default 1, 2, 3, 4 (the research's order). Releases 3 and 4 need nothing from 1 and 2 and may go first (their foundations move with them); release 2 needs release 1. | before F1 |
| G2 | **When item 22 starts** relative to item 36 (the portable zip, next on the list), the Comfy Dev Platform Challenge (2026-10-05 to 10-19) and B3 (CLAUDE.md: "suggested after B3"). This plan assumes no date. | the first session |
| G3 | **R1-S1 and R1-S2 before the foundations** (recommended: the checkpoint on the user's pictures comes about two sessions in and decides release 2's size), or after F8. | R1-S1 |
| G4 | **The two folded packages** (masks and selections 6.5-12.5 d; grading and panels 11-19.5 d; `docs/HISTORY.md:1495-1504`): after release 3 (proposed), folded into releases 1-3, or an update of their own. This plan already covers soft add / intersect, the black-and-white mask view and (with R2-D6) refine edge; the soft selection from a layer's alpha could join R1-S9 for about 0.5 d (§2). | R1-S9 for the soft selection from alpha, R2-S9 for refine edge, R3-S1 for the rest |
| G5 | **Reader bumps.** One per release (§1.2): documents using the release's features need 0.1.N or newer, and 0.1.41 and older refuse them (low impact with one user). | the first FEATURES row of each release: R1-S7a, R2-S4, R3-S2, R4-S4 |
| G6 | **Each release itself**: whether it ships alone, its version number and wording, the blog post, the Store submit, and whether a node version ships with it. | R1-S12, R2-S16, R3-S13, R4-S10 |
| G7 | **F10's interface grows** by `wholeStatsSize` and a `ctx` argument (the document's maps for plugin filters, API 4), or built-ins only. | whichever builds F10 (R2-S1 or R3-S1) |
| G8 | **A licence and patent look before any sale** (like the film names): the depth model's training-data question (DA2 issue #320, open), and the dehaze method (the dark channel prior's US patent US8340461 is listed as lapsed for fees; the guided filter, no patent found in one search). Nothing blocks the GPL builds; §2 "Licences" has the table. | before a paid release, not before building |

### 6.2 Release 1

| Id | Question | Needed by |
|---|---|---|
| R1-D1 | **The model and its download**: Depth Anything V2 Small, fp32, 99 MB, Apache-2.0 (issue #320 about the training data still open), from the deprecated single-file repo pinned to commit `4472b736…`. The user clicks *Download* in *Settings › Helpers* or gives Claude a yes for the file. | R1-S1 |
| R1-D2 | **DA3Mono-Large in the checkpoint**: it needs third-party export code and about 1.4 GB. | R1-S2 |
| R1-D3 | **The user's 15k picture**: its path, and whether crops of it may go into `docs/PLAN_NIK9.md`. | R1-S2 (reused by R1-S11 and R2-S3) |
| R1-D4 | **Main thread or a process of its own** for the model: decided by R1-S1's measurement; asked only if DirectML fails inside a utility process and the CPU is slow. | R1-S1 |
| R1-D5 | **Working map and guide**: `WORK_MAX` 4096 or 2048, the guide's `r` and `eps`, the long-side cap for panoramas (after R1-S2's look). | R1-S2, used by R1-S3a |
| R1-D6 | **A depth limit without a map**: no effect (proposed; like a missing plugin filter) with a note in the row, or unlimited. | R1-S7a |
| R1-D7 | **Fill layers take a depth limit only** in this release (a brightness or colour range of what lies below cannot be stored in a PSD layer). | R1-S7b |
| R1-D8 | **One command `select_range`** for depth, brightness and colour, instead of the research's `select_depth`. | R1-S5a |
| R1-D9 | **Object box drag**: a plain drag adds like the click (proposed) or replaces like the rectangle; the edge hard at the model's boundary (proposed) or soft. | R1-S9 |
| R1-D10 | **Mask overlay**: red where the mask hides (proposed) or where it shows; a key for it or none (proposed: none; `\` is taken by the base-picture peek). | R1-S10 |
| R1-D11 | **Staleness threshold**: confirm `STALE_DIFF` after R1-S11's table; recompute stays manual. | R1-S11 |

### 6.3 Release 2

| Id | Question | Needed by |
|---|---|---|
| R2-D1 | **The detail route** (after R2-S3's bench): none, a large input (one run at a long side up to 1568), tiles 2 x 2 / 3 x 3, or both as *Fine* / *Finest*; and whether `depth.js` moves into a utility process first (R1-S1b, if the main thread blocks over 1 s). | R2-S7 |
| R2-D2 | **The edge snap's default** for new maps: 50 (proposed) or 0 (release 1's look until turned up). | R2-S4 |
| R2-D3 | **Which edge steps to build** (after R2-S3): the refine brush (R2-S10), the matte in the band (R2-S9), or neither if *Flatten* and the snap are enough; and, if the bench shows the research's full-resolution guided filter clearly better, accept the snap or plan a stored edge-tile correction (more storage, an atlas in the shader). | R2-S9, R2-S10 |
| R2-D4 | **Haze as its own filter** (recommended: exponential, a start depth, an automatic colour) or only "a colour fill plus a depth limit" (no new type, cruder). | R2-S12 |
| R2-D5 | **Dehaze in the node**: a built-in ships to the ComfyUI node with its next version (auto works there, the depth mode is hidden); ship it, or hide dehaze in the node too. | R2-S14 |
| R2-D6 | **The matte step's scope**: only inside *Flatten*, or a generic *Refine edge* for any selection (overlaps G4, about 0.5 d more). | R2-S9 |
| R2-D7 | **Lens blur**, yes or no; if yes the aperture cap (1.5 % of the long side proposed) and the export time accepted at 15k. | R2-S15 |
| R2-D8 | **Depth from a layer** (cheap; lets the user's own ComfyUI depth maps and glb's depth stand in for the model). | R2-S11 |
| R2-D9 | **Release grouping**: all of release 2 as one release, or haze and dehaze first (they need R2-S1, S4, S5, S12-S14) and the edge work later. | before R2-S7 |
| R2-D10 | **The guide's memory**: about 45 MB plus a 45 MB texture per 15k document; accept, or a smaller guide (luma only, or packed) with less snap on edges between colours of equal brightness. | R2-S4 |

### 6.4 Release 3

| Id | Question | Needed by |
|---|---|---|
| R3-D1 | **The effects plugin's id** (permanent, stored in documents): `effects`, named "Effects pack" (proposed), or the two filters added to the film pack. | R3-S9 |
| R3-D2 | **Reader bump for the effects plugin's filters** (proposed: yes, with the rest of the release), or none (a 0.1.41 row already shows "missing: <id>" and passes the picture through). | R3-S9 |
| R3-D3 | **HSL implementation**: a direct shader through `registerGLFilter`, an exact twin with no LUT (proposed; the LUT path is untested and frees no texture per frame), or a baked 33³ LUT. | R3-S4 |
| R3-D4 | **HSL and grading looks**: hue as an exact HSV shift of ±30° at ±100, saturation around luma, luminance as a luma shift; grading tint strength 0.35 and brightness ±64 levels. The user judges after the look. | R3-S3, R3-S4, R3-S12 |
| R3-D5 | **Grading layout**: four wheels (shadows, midtones, highlights, global) plus Balance and Blending, brightness as an offset (not a lift / gamma / gain split). | R3-S2 |
| R3-D6 | **Circles under a non-uniform resize**: keep them circles (today's rule, pinned by `film_test.py:282`), or turn them into ellipses (exact, but it changes how a resize treats old points). | R3-S5 |
| R3-D7 | **Hover scope**: the Film looks panel only, or also the list button on every select in a filter row (proposed: both). | R3-S7 |
| R3-D8 | **BUGS:152**: fix "None (adjustments only)" adding grain? It changes the picture of documents saved with "None". | R3-S7 |
| R3-D9 | **Glass styles and defaults**: ribbed, reeded, wavy, blocks, frosted, pebbled (proposed). | R3-S10 |
| R3-D10 | **Copy and paste of control points across tabs** (+0.25 d): build or skip. Paste-mask rules as proposed: the same document only, outside the source layer hidden, the source read at paste time. | R3-S8 |

### 6.5 Release 4

| Id | Question | Needed by |
|---|---|---|
| R4-D1 | **Dissolve** in this release (R4-S9) or not; it sets "sixteen" against "seventeen" in the texts. | R4-S4 (wording), R4-S9 |
| R4-D2 | **Hard mix at b + s = 255**: white (default) or black. | R4-S4 |
| R4-D3 | **Darker / lighter colour**: by channel sum (default; what the other editor's documentation says) or by luminance; a tie keeps the backdrop. | R4-S6 |
| R4-D4 | **Emulate all new modes** (default: the screen equals the export; a shader pass per such layer per frame on the Canvas 2D view path), or Canvas 2D's native op for the seven it has, after R4-S3's measurement. | R4-S1, R4-S4 |
| R4-D5 | **Labels**: British spelling ("Colour dodge") and group names (default), or unlabelled separators. | R4-S8 |
| R4-D6 | **A PSD with every mode from another editor** (made by the user, or the user allows a free web editor), an optional Krita ORA, and whether either may be committed as a fixture. | asked at R4-S3, needed by R4-S8 |
| R4-D7 | **Whether a deviation from that editor's merged picture is followed**; decided before the release. | R4-S8 |
| R4-D8 | **PSD fill opacity**: a note only (default), or folded into opacity where fill and opacity act alike. | R4-S8 |
| R4-D9 | **ORA**: modes OpenRaster does not name are written as `scumble:<id>` (default yes). | R4-S4 |

## 7. Traps to remember

From CLAUDE.md and the readers, the ones this work walks into.

**Process and safety**

- Every app gate `--offline`: uploads (layers, depth and guide PNGs) are forwarded to a connected ComfyUI, and 8188 is
  the user's production machine. `/queue` before a model benchmark; nothing queued, nothing restarted there.
- DirectML competes with a ComfyUI job for the GPU (HELPERS.md measured 125 s instead of 1.6 s with 29 of 32 GB in
  use). Set `editor.helperUsed = true` for every GPU session so a local run frees it; `slowHelperHint` covers the rest.
- Every test run its own `--user-data-dir`; never the user's profile (it shares the autosave).
- A download needs the user's yes. A release needs the user's word.

**Writing code here**

- Write scripts and JS with the Write tool: a Bash heredoc breaks on an apostrophe, runs backtick spans when unquoted,
  and turns `\u0080` and `\\n` into characters. The Write tool itself turns `\u0080` into the literal character: check
  with `grep -nP "[^\x00-\x7F]"`.
- A backtick inside a comment in a GLSL template literal ends the JS string; `node --check` on an ES module reports
  nothing (the app reports `Unexpected identifier` at import). GLSL reserved names: `filter`, `half`, `sample`; the film
  PRELUDE already defines `sstep`, `luma`, `sat3` (use the `w_`, `bm_` prefixes).
- Python patch scripts write with `newline=chr(10)` and encode before truncating; PowerShell `Set-Content` writes a BOM
  (electron-builder then refuses `package.json`).
- A comment edit in `crates/px/src/*.rs` changes the wasm bytes: `python tools/build_px.py`, then `--check` (CI repeats
  it on the tag). Rust twins: no `mul_add`, round by `floor(x + 0.5)`, the same operation order as the JS twin.
- A new editor module goes into `build_node.py` FILES; a new host member into the typedef and the node's `js/host.js`.

**Chromium, canvas and WebGL**

- Set both UNPACK switches before every typed-array upload, or premultiplied bytes are premultiplied twice.
- `copy`, `destination-in` and the other `WHOLE_CANVAS_OPS` act on the whole canvas: a regional use needs `clip()` or a
  scratch the size of the region.
- The acceleration latch: once at least 100 `getImageData` calls have disabled acceleration and they reach 95 % of all
  canvases, Chromium makes every new canvas software. Use one reused `willReadFrequently` scratch for readbacks.
- `drawImage` with `copy` and smoothing on changes bytes by up to 2 levels; `source-over` or smoothing off gives them.
- A canvas 65,536 px on a side draws nothing; the WebGL drawing buffer caps at about 33 MP (filters render in tiles
  above it, where `renderToTexture` binds its target: F7 moves it off the sampler units).
- Source textures and surfaces are NEAREST and RGBA32F samplers cannot be LINEAR: subpixel reads need a manual bilinear
  with an identical JS twin.
- `requestAnimationFrame` does not fire in a hidden window and `img.decode()` never resolves there: scripted waits use
  `setTimeout`, image loads wait for `onload`.
- An occluded window drops CDP key events unless `Emulation.setFocusEmulationEnabled` is on. Escape never reached a
  plugin tool before R3-S5.

**The tile engine and big pictures**

- No W x H array or canvas on any new path at 15k (600 MB of RGBA8 per full-size layer); `makeCanvas` and
  `flattenToCanvas` throw above Chromium's canvas limits. Use `bandPlan` / `readBand` / `readBox`, row sources, region
  passes at a scale, per-tile combines. Check with `memoryReport()` (no mirror over 64 MB).
- A tile's bytes are a view into a SharedArrayBuffer: no `ImageData`, `Blob` or `crypto.subtle` over them; a worker
  never writes a tile it was given (it returns new tiles); whoever hands tiles to a job holds them until the answer is
  in; a job's answer counts only if the tile's version is still the one it was made from.
- Two walks of the stack (`drawLayersInto`, `passStores`) must branch alike (F5's `skipFilters`); `stackPlan` is a third
  walk and its `filters` option means something else.
- A big picture-relative reach repeats the halation export slowness (BUGS.md:336, 67 s at 20000 x 14000): prefer reach 0
  (the snap, dehaze's small field) and measure `exportperf` before a release.

**Data, undo and documents**

- The filter undo snapshot copies params shallowly: nested values (`params.limit`, points arrays, polygon `pts`) are
  always replaced, never mutated.
- Document maps are immutable: never write `data` or `guide` after `makeMap`; a recompute or an edit makes a new map.
- Every top-level `getValue` field must be in `STATE_KEYS` (`groups` was missing; `maps` is added), or an opened
  document carries a stale copy in `header.extra`.
- A picture-changing document feature is a FEATURES row with the release's reader number and one explicit case in
  `document_test.js` (a loop over the rows cannot notice a deleted row); fixtures use derived "newer" numbers.
- Every input that changes a filter's picture goes into its cache key (`filterKey`: the limit, `mapsVersion`, the view
  flag); `bandFilter` has no key of its own.
- Relative depth is per picture: ranges do not transfer between pictures or presets (no limits in presets).
- Soft selections still meet hard thresholds in a run (`stitch.js:237, :255, :532`, `providers/inapp.js:32`,
  `providers/util.js:178`): a depth selection used for inpainting comes back hard-edged (the manual says so).
- Plugin ids are permanent; documents store them.

**Tests and measurements**

- New steps in new gates; `editor_test.py` is near its 420 s timeout. Re-run a failing step listed in TESTING.md
  "Known flakes" before believing it; add a new flake there with the date and what was ruled out.
- A mutation round needs a fresh instance per mutation (the renderer caches its ES modules), on a copied tree with
  `node_modules` as a junction and PASS on the untouched copy first; `git diff --stat` afterwards.
- References taken with `--update` go stale with every later fix to the same path: take them once, after the last
  formula change (R4-S8), and run both backends before the commit.
- Restart the app before every benchmark or memory run; compare A and B in one session and one state.
- The renderer keeps its own settings copy; a gate that switches anything in the window puts it back through the
  window's own functions. `ed.syncLayers()` before a reload; layer changes in tests go through `set_layer` (it touches
  the composite version).
- `COMMANDS.md` regenerates only against a running dev instance (`python tools/commands_doc.py`); F2's commands gate
  fails when it is stale.
- The perf gates split their options at commas (`exportperf:*`, `mem:*`; `perf:*` and `docperf:*` once a session adds
  the split) and pass them unquoted: no JSON in a gate option, use the comma-free forms (§2), and parse
  `split("=", 1)`.
- Keys: `\` is the base-picture peek; check `onKey` (`inpaint_canvas.js` ~:3035-3135) and the MANUAL's key table before
  giving anything a key.
