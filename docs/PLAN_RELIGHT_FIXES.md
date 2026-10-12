# Relight: the fix plan after review round 3 (2026-10-12)

Relight (item 43, `docs/PLAN_RELIGHT_BUILD.md`) was built by another agent (L0a-L6, N2, N3) and reviewed by this
account three times on 2026-10-12: round 1 on f0a25eb, round 2 on 81178aa (fixes ec60f14 + 81178aa), round 3 on
77da63f. Each round's fixes brought new defects, so from here this account fixes the rest itself (the user,
2026-10-12: "vielleicht macht es mehr sinn wenn du die fehler fixed"). The other agent does not edit relight while
this plan runs.

Line numbers below are at 77da63f. Every finding was confirmed by a second agent and the musts were re-read by hand.

## Rules for every session

- One session per section F1-F4, a local commit each, then `/clear` (the user's rule).
- A test added or changed for a finding must fail on 77da63f before the fix: run it once against the unfixed code
  (a scratch copy of the module or a targeted mutation) and name the failure in the commit message. No copied
  production code in a test, no uniform input.
- Tiers (CLAUDE.md Working rules): the relight filter and its routes are normal tier (one gate step per fix on tiles,
  the gates the change touches, the canvas backend when a pixel path changed). Document save/restore and undo are
  full tier: `document` and `editor` on both backends.
- Gates run `--offline`, never on port 9555 while the other agent might use it; plain `node tools/*_test.js` runs (no
  `--loader`); the export gate skips on `--tiles off` and does not count there.
- The relight gate has 150 in-app checks on tiles and 149 on canvas since F1 (141 / 140 at 77da63f; case h is
  tile-only).

## Verified fixed in 77da63f (no action)

relightOf saved and restored; FluxKontextImageScale replaced by ImageScaleToTotalPixels in both graphs; the assistant
adds relight layers (resolveLayer exemption); the array schemas themselves; the host-side 27.9 MP cap before any send;
debounce undo order with per-layer timers; flushPendingDebounces limited to nudge and wheel; stepHistory; the depth
await on add_filter / set_filter; the Lightning LoRA link and `checkComfyRelightModels`; the manual and the per-menu
manual_test; the relight command's lights refusal and COMMANDS.md; the shadow_march routing (point and spot to the JS
twin); relight_test.js 7, gate cases (s) and snap, request suite 5; the loud magnific mock; rgbLin; the overlay label;
one depth hint; selected_light after Escape; the assistant TIMEOUT; releaseCaches' freed bytes. The drag preview now
shows the quick shadows (live: 0 levels off a settled render, 39 before).

## F1: the contained musts

1. **The assistant refuses every relight above 27.9 MP** (`electron/main/assistant/policy.js:167`), the free app route
   and plain light edits included. It reads `call.args.detail`, which the relight command does not have.
   Fix: AUTO for route "app" before the cap; for paid routes read detail from the target layer's params (or the
   remembered setting for a new layer); `realism.MAX_AREA` instead of the literal. assistant_test cases at 28.1 MP:
   app auto, magnific with detail on refused, a layer with detail off asked.
2. **`tools/assistant_test.js:634` registers `tools/editor_loader.mjs`**, which was never committed, inside an empty
   catch. A plain run exits 1 after 14 checks; the assistant gate is 37/38 (node_layer) on both backends (81178aa:
   38/38). Fix: register the committed `tools/loader.mjs` (checked: 258/258 plainly) and rethrow from the catch.
3. **`historyStepNow` resets gen after the waits** (`inpaint_canvas.js:14487-14488`: flush, then
   `gen = this.historyGen`). The editor gate step `undo_does_not_run_over_edits_made_while_it_loads` fails at 77da63f
   and passes at 81178aa: a stroke made during a wait is undone, a layer added during a redo is lost.
   Fix: `const g0 = this.historyGen; this.flushPendingDebounces(); gen += this.historyGen - g0;`. Gates `editor` and
   `relight` on both backends.
4. **Default `lora_strength: 1.0`** (`host.js:420`) on a 0..100 scale; both routes divide by 100 (`host.js:3190`
   local, `:3238` Comfy Cloud), so every new layer sends strength_model 0.01 (81178aa: 1.0). Fix: default 100 (or no
   key, so the `?? 100` fallbacks apply), migrate stored values <= 1 as fractions, fix request suite 18 (its 0.8 is on
   the wrong scale), assert strength_model 1.0 for a fresh layer on comfyui and comfycloud.

**F1 as built (2026-10-12, the commit after d6119ce).** Each fix reviewed by a workflow (16 agents, every finding
refuted or confirmed by a second one); every new test run against the unfixed code.
1. `policy.js` `relightRow`: route app is AUTO before any cap; a paid route is refused above `REALISM_MAX_AREA` (a copy of
   realism.js MAX_AREA, CommonJS cannot import it; the test pins it to the source like REALISM_LABEL) when the layer it
   runs on restores detail: the named layer's `params.detail` from list_layers, for a new layer `facts.relightDetail`,
   which `factsFor` reads from the stored `settings.relight.detail` (absent = on, as host's default). `relightCard`
   names no layer for a new one (it named the active layer). assistant_test `relight_cap_spares_the_app_route_and_reads_
   detail_from_the_layer` (on 77da63f: 258/259, every case refused, the app route too) and `relight_facts_read_detail_
   from_the_stored_relight_settings`.
2. assistant_test registers `tools/loader.mjs` without a catch; the loader now resolves `/editor/` from its own folder,
   so the test runs from any cwd (260/260; on 77da63f exit 1 after 14 checks, `C:\editor\inpaint_filters.js`).
3. **Not the formula above:** the review found that `gen += this.historyGen - g0` forgives a nudge begun *during* the
   wait (the waiting undo takes it back silently, the next undo goes one step further). As built: `undoStep` /
   `redoStep` flush before reading gen (as at 81178aa), `historyStepNow` flushes again after the wait and keeps gen, so a
   nudge begun during the wait stops that undo like any edit. New relight gate step "l2: a nudge made while an undo
   waits is not undone by it" (+2 checks): red with the plan's formula (measured on a copy: x 151 -> 150, the next undo
   to 100). The editor gate step passes on both backends.
4. `host.relightSettings.lora_strength` 100; `loraPercent` (inpaint_relight.js: unset 100, (0, 1] x 100, clamped)
   in `host.configure` (stored settings), both routes (comfyui always writes `lora_relight.strength_model`) and the
   slider; `host.relightSend` is the provider routes' send, a member the gate stubs. relight_test.js suite 18 (80, the
   default 100) and 19 (loraPercent, the configure migration); gate case z (6 checks: a fresh layer holds 100, comfyui
   and comfycloud send 1.0, 55 % goes as 0.55): red with 77da63f's default and readers (0.01 on both routes, measured).
Gates `relight editor assistant document` green on both backends (relight 150 / 149, assistant 38/38), every relight
node test, eslint 0 errors, types. `build_node.py --check`: js/inpaint_canvas.js and js/inpaint_relight.js differ (the
node build waits for the release, F4).

## F2: the quick map and the fit (pixel paths)

5. **pickVis key mismatch:** `pickVis` gets `map.version` (`inpaint_relight.js:1264`, `:1690`), `ensureRelightMaps`
   keys vis on `depthMap.dataVersion` (`inpaint_canvas.js:22709`). After an Edges change (`setMapMeta` bumps only
   version) vis never matches, and the view, the export and the Magnific light map read the quarter-res, 1-tap
   visQuick, maybe from an old drag position (export off by up to 64 levels; 0 at 81178aa). Also `pickVis` returns
   visQuick whenever `info.quick` is set without checking its keys, so a slider preview shows an old drag's shadows
   for the first frames. Fix: one key helper on dataVersion for both sides; return vis when its keys match the current
   lights, visQuick only when its own keys are current, never a stale visQuick on forRun. Node tests: a meta-only
   deriveMap, then pickVis returns cache.vis; a visQuick with old keys is not returned.
6. **The fit cache ignores the picture below** (`inpaint_relight.js:1110-1116`, keyed on depth version, depth_scale,
   sigma, W, H): a picture swapped from lit-left to lit-right keeps l0[0] at -0.9 (fresh: +0.9), the export is off by
   up to 61 levels on 18-20 % of pixels, and a reopened document renders differently. Fix: a cheap hash of the 256 px
   sample in the key (not compositeVersion). Node test: same layer, swapped picture, the sign of l0[0] flips. With it:
   `belowStats` keys on the global compositeVersion, which every drag frame bumps (a 10-move drag runs wholeStats and
   the 256 px readback 22 times): key it on a version of the layers below plus the maps version, check the cache
   before the readback.
7. **The rest of the quick-map item:** gate case (q) is unchanged and vacuous (141/141 with visQuick hidden): render
   the view pass (not forRun) during the drag and assert the shadow band matches a settled render at the new position
   (box scene: 0 vs 39 with the old reader). Generate's crop read (`stitch.js:780` readBoxBytes), `plugins.js`
   flatten({settled:true}) and the `commands.js` screenshot read the quarter map mid-march (mean 10.5 off): wait on
   `_relightPending` there, not `relightSettled` (it flushes a pending nudge).

**F2 as built (2026-10-12, the commit after 2920bb1).** Reviewed by a workflow (5 reviewers, each area's findings checked
by a skeptic): 1 must (found by three reviewers: statistics above a relight layer kept the picture from before its maps
landed) and 6 should, all fixed here, with most of the nits; every new check run against a mutation of its fix.
5. `inpaint_relight.js`: one key for both sides, `relightMapKey(map)` (dataVersion and `xf`: a meta-only change keeps
   it, new data or another placement does not), `relightVisKey`, `relightVisCurrent`, `relightDepthScale`; `pickVis(cache,
   info, params, map)`: the full map when current; a run (`info.forRun`, set by `filterInfo` and by the light map of
   `relightWhole`) reads the full map, never the quick one; the view reads a current quick map, else the one written last
   (`seq`); shadows at 0 read an all-lit 1x1 map. The GL key carries `seq`. `ensureRelightMaps`: a quick map is seeded from
   the full one with its keys (`_f` to `_q`), so a drag marches only the light it moves; a march lands into the map there
   is when it ends: one for the key the channel wants then always (and outranks older ones still running), one for a key
   the light has left only into the quick map and only over an older march (the quick map trails the pointer; at
   2920bb1 every result for a moved light was thrown away, so a continuous drag showed the shadows from before it); a
   dropped result with nothing running for the wanted key asks for a march. A new full map drops the quick one;
   `dropQuickVis` drops it once the full map is current. Shadows at 0 keep the maps (they were filled white).
6. The fit's cache key holds an FNV hash of the 256 px sample. `belowStats` keys on `belowSignature(layer)` (the base and
   every layer below: identity and version of each pixel source, geometry, visibility with groups, opacity, blend,
   clip, mask, match, role, a filter's parameters, LUT, plate, a relight layer's shadow and normal maps, the maps for a
   layer that reads them; the compare side; another layer's filter preview) plus the parameters the statistics read
   (`wholeStatsParams`: relight depth_scale and sigma, haze and dehaze none; a plugin's function all of them) plus the
   maps when the layer reads them. Not `pixelVersion`: it moves with every brush dab anywhere (the review measured a
   re-read per frame while painting above a dehaze chain); each source's own version moves with `touch()`.
7. `relightIdle(also)`: ensure the full maps of the shown relight layers (and `also`), wait for the jobs there are, three
   rounds at most, no flush; `relightSettled(also)` = flush + `relightIdle`. Waiting now: `readBoxBytes`,
   `sampleRegionSettled` (the picture, not skipFilters / baseOnly), `shotCanvas`, `Document.flatten({ settled })` (every
   branch; the layer index read after the wait), `mergedClip`, the window crop fallback in `prepareCropAsync`, the canvas
   backend's `promptContextCanvas` and `objectInput`, and `relightSettled` at the start of `exportImage` (PSD, ORA and TIFF
   read bands that did not wait) and `extendCanvasNow` (its flatten becomes the base). Still not waiting, synchronous:
   copy merged (`copySelection` / `copyLayer`), `matchEdges`, a plugin's unsettled flatten and getPixels; within a march's
   time after a light change they read the full map of where the light was.
Tests: relight_test.js 20 (pickVis: keys, Edges change, quick only when current or newer, never for a run, shadows 0)
and 21 (the fit follows the picture); plugin_api4_test.js calls the real `belowStats` / `belowSignature` (it tested a
copy of the old one). Gate case q rewritten over a box (the view shows the current quick map, 0 levels off the settled
picture in both bands; five readers of a run's picture mid-drag each equal the same read after a settle; the drag reads
the picture below back 0 times, 6 at 2920bb1; a run's pass is marked forRun; a light turned off and on while its march
runs, and a march for a position the light has left), case fit (a new base lit from the other side flips the fit; a
depth_scale change refits, a light move does not; a Normalise over the relight layer re-reads when the shadow map
lands, 110.2 before, 113.4 after) and l2 (a read leaves a pending nudge pending). `RELIGHT_GATE_SKIP_NODE=1` runs the
in-app checks alone (for mutations of `inpaint_relight.js`, which the node suites catch first). Relight gate: 198 in-app
checks on tiles. Mutations, each red: the view never reading the quick map, a run reading it, the map key on `version`,
the fit key without the hash, `belowStats` on compositeVersion, the signature without the base, without a relight
layer's maps, no `wholeStatsParams`, `filterInfo` without `forRun`, the landing rule on tickets alone, each reader
without its wait, a read flushing the nudge. Green on purpose: the landing's "ask for a march" alone removed (the
landing rule already lands the running march in the cases a test can build; it stays as a safety net).
Left (nits): `relightWhole` reads the lights after its settle and the encode (a light moved during that wait goes with
the full map of before); `prepareCropAsync` holds the click's stack while `readBoxBytes` waits (relight is applied with
the lights at the end of the wait); `RELIGHT_GATE_SKIP_NODE=1` left set in a shell skips the node suites and still
prints PASS (it says so in a [skip] line).

## F3: undo, snapshots, routes and settings (should)

- **The same snapshot pushed twice:** nudge / wheel and the relight sliders share `layer._undoPending`; a slider change
  within 300 ms of a nudge runs `_flushNudge` (pushes the object), then the caller pushes it again (the second undo
  and the first redo do nothing). Generic and limit commits (`:19001`, `:19229`) too. Separate fields
  (`_nudgePending` / `_wheelPending`) or skip a push when `this.undo` already ends with the snapshot.
- **Debounce fields in snapshots:** `snapshotLayer` (`:13756`) and `applySnapshot` (`:14148`) spread `{...l}`, so
  `_flushNudge`, `_flushWheel`, the timers and `_undoPending` travel into snapshots; after nudge + Ctrl+J + undo every
  later pushUndo runs renderLayers and ensureRelightMaps on a detached layer. Drop those fields in snapshotLayer and
  duplicateLayer; in the closures return unless `this.layers` includes the layer.
- **`close()` lost `this.closeTipPicker()`** (regresses 8c14eee): restore it; also null a dropped nudge's
  `_undoPending` / `_undoLabel` and clear `filterPreview` when it is theirs.
- **The relight command's edit path writes `params.route = "app"`** when route is omitted (`commands.js:1433`): a
  Magnific layer switches to app; with no param keys there is no undo step and no touch, the panel still shows
  Magnific, and Render sends provider "app" ("Unknown provider: app"). Write route only when given, inside the undo
  step, then touch.
- **light_type default** "soft overcast daylight lighting" (`host.js:419`) is copied onto every layer, so Bria never
  gets the type derived from the lights. Make "From the lights" (unset) the default; remember explicit picks only.
- **Settings shape:** `electron/main/settings.js:25-29` DEFAULTS.relight is still nested (fresh profiles store both
  shapes): make it flat. Request suite 18 round-trips only host's store and passes with the readers reverted: test
  `InpaintEditor.prototype.addFilterLayer` / `setFilterType` on a stub after
  `setRelightSettings({route:"magnific", strength:40})`, expecting route app and strength 40.
- **`selectRecipe` (`shell.js:507`)** still maps a relight id silently to the first non-relight recipe and saves it
  (reachable through Edit in ComfyUI > Save to recipe and importRecipe): return unchanged for task relight; hide the
  provider select on relight rows.
- **Undo during a plugin hover preview** records the hover value, which redo then applies (since R3-S7, not in
  0.1.46): cancel a pending non-debounce preview in historyStepNow before the redo snapshot.

## F4: vacuous tests, measurements, nits

- Gate case (u): vacuous for the shear (passes with e1ebe65's sheared read); give the base low-frequency variation (a
  darker top half), assert the top/bottom ratio within 5 % and the mock's answer size (not flattenToCanvas). Its
  re-read (`relight_test.py:1257-1272`) copies host's skip logic: run the relight command again through the mock and
  check the picture the mock receives.
- Gate case (r): vacuous (its 1450 px diff is the select tool's brush ring at a stale `ed.hover`): `ed.hover = null`,
  compare the lights tool with hideLightHandles false vs true.
- The array-schema test activates only film, boxes and effects: activate every plugin with a plugin.json under
  `<id>.<name>` as plugins.js does, and assert the leaf item types (rect, src, vertices: number).
- shadow_march: px_test's benchmark uses uniform noise, one cold run and px directly (prints Rust faster for a point
  light, against the routing); PERFORMANCE.md 15.2 still shows 591.6 / 464.5 ms, 0.8x, 14.1 s and a wrong :1576.
  Benchmark the routed kernels.js on a smooth depth map, warmed and interleaved, for point, spot and sun; regenerate
  the table.
- Nits: applySnapshot sets `_deselected = !_selectedLightId`; the GL registration (`inpaint_relight.js:1802`) uses
  `relightSkip`; a sun at the centre with dist 0 (CPU (0,0,0) vs shader (0,0,1)); PLAN_RELIGHT_BUILD.md 4.1 / 4.3 z
  convention; a TESTING.md line that limit, maps, edges and selection_test.py exit 1 with no app.
- At the end: the full gate list on both backends (relight editor assistant selection limit maps edges depthfx
  document commands skins help recipes mcp, export on tiles), every `node tools/*_test.js`, lint, types,
  `build_node.py --check` (then the node build when the release comes), the CHANGELOG, then the user's test.

## Open questions for the user

- The Brainfuck easter egg (4cc2f76): keep it?
- Highlights clip hard at 255 since the identity fix: a soft shoulder instead?
