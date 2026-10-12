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
- The relight gate has 270 in-app checks on tiles and 269 on canvas since F4 (251 / 250 after F3, 150 / 149 after F1,
  198 after F2, 141 / 140 at 77da63f; case h is tile-only).

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

**F3 as built (2026-10-12, the commit after 4192a6a).** Mapped by a workflow (one reader per item, a cross-checker), the
tests written by three agents beside the main loop (each file its own, each port its own), reviewed by a workflow (four
areas, every must and should checked by a skeptic): 1 must and 1 should found and fixed here, with four of the nits.
Every new check was run on 4192a6a (red) and against a mutation of its fix (red).
- **Undo (items 1, 2):** the relight nudge and wheel burst own `_nudgePending` / `_wheelPending` (+ `_wheelLabel`); each
  flushes the other when it begins, so nudge, wheel, nudge are three steps in their order. A slider's `_undoPending` is
  its own again: a slider moved within a burst's 300 ms is a second step (at 4192a6a the same snapshot was pushed twice;
  the generic and limit sliders shared it too). `LAYER_PENDING_KEYS` (every edit in progress: `_undoPending`, `_textUndo`,
  `_matchUndo`, `_hoverSnap`, the burst fields, flushes and timers) is dropped from `snapshotLayer`'s records (layers,
  canvas and turn steps, named snapshots, the assistant's turn) and from `duplicateLayer`'s copy. The flush closures
  clear their field first and return before any push or render when the layer left `this.layers`;
  `flushPendingDebounces` nulls the holder before it calls. `releaseDroppedEdits`: layers an undo replaced let go of a
  text edit's or a match drag's "before" (on canvases a blob URL no record holds any more).
- **close() (item 3):** `closeTipPicker()` again; a nudge or wheel burst still in its 300 ms is dropped whole (timer,
  flush, snapshot, its `filterPreview`), not committed (the plan's choice: no march or render on an editor being torn
  down). In the node a reopened editor keeps the light where the dropped nudge put it, without a step of its own.
- **The relight command (item 4):** an omitted route keeps the layer's route and renders nothing (the answer names the
  layer's route, with a note when it is not "app"); a given route goes into the undo step with the values, only when it
  changes ("Relight route" alone), then touch. `RELIGHT_ROUTES` (inpaint_relight.js) is the one list: `checkParams`
  refuses another route in relight, set_filter and add_filter. The schema default is gone; COMMANDS.md regenerated.
- **Light type (item 5):** no default; the Bria row has "From the lights" (value "") first, which forgets the pick on the
  layer and in the settings; a pick is kept for new layers.
- **Settings (item 6):** `DEFAULTS.relight = {}`. host keeps `RELIGHT_DEFAULTS` (frozen) and `relightPicked`, what the
  user set, which is all `setRelightSettings` stores (undefined forgets a key); `configure` rebuilds
  `relightSettings` from the defaults and the picks and drops object values. main's `get()` drops a stored nested
  `magnific` / `detailFromOriginal` and, when those mark a store from before F3 (it wrote host's whole object), every key
  at its old default (`PRE_F3_RELIGHT`, light_type's included).
- **Recipes (item 7):** `selectRecipe` with a relight id keeps the recipe in use (selected again, so the select is right
  after `loadRecipes`; no provider change, nothing stored); relight rows have no provider select, their meta says the
  layer's Relight panel picks the route, they are not counted as keyed, and `chosenProvider` ignores a stored relight
  provider; `onModeChanged` skips relight recipes.
- **Previews (item 8):** `cancelPreviews()` (a choice hover, and every `_undoPending` whose preview is shown:
  `previewShown`, `filterPreview` names the layer and no nudge or wheel burst owns it) runs in `historyStepNow` after
  every wait and before the redo copy, and in `restoreTurn`.
- **The review's must:** a list slider grabbed within a burst's 300 ms and still held when its flush ran was cut off by
  the flush's `renderLayers` (no change event: its `_undoPending` stayed), and `cancelPreviews` then put that "before"
  back at the next undo, over every edit since (the redo lost five nudges and the slider's value). The flushes call
  `renderLayersUnlessEditing` (no rebuild while a layer holds `_undoPending` or `_matchUndo`), and an `_undoPending` no
  preview shows any more is never cancelled. **The should:** a record taken while a preview is shown (Ctrl+J over a
  hovered stock, an agent's step, a named snapshot) held the hovered values without the guard that would put the
  clicked ones back: `committedFilter` gives the record and the copy the committed values.
Tests: relight gate cases route (14 checks, in case t), z (+8), undo (24: a1-a5, b, c the list slider across the timer,
d a slider cut off by a rebuild, e a flush of a replaced layer and a record during a nudge) and cl (7); relight_test.js
suites 22 (the flat picks, route app, light_type) and 23 (the command's route), 19 restores `relightPicked`;
settings_migration_test.js `relight()` (the real shape of a store from before F3); recipes_test.py
`a_relight_id_keeps_the_recipe_in_use_and_stores_nothing`, `relight_rows_have_no_provider_select`; film_test.py
`panel_hover_undo_redo`, `panel_hover_layers_step`. Relight gate: 251 in-app checks on tiles, 250 on
canvas. Mutations, each red: the shared field, no cross-flush, records keeping the pending keys, an omitted route as
app, a route step though unchanged, the light_type default, "" written for From the lights, close() without the tip
picker, close() keeping the snapshot, the flush rebuilding the list, cancelling a preview no one shows, a nudge's
preview counting as a slider's, records and copies keeping the preview (and in the agents' runs: the readers of
81178aa, the whole object stored, undefined kept, the command's route branch and step, the selectRecipe guard and the
row condition, `cancelPreviews` removed).
Left, noted: an `_undoPending` some other rebuild cut off (an agent's command mid-drag) is no longer cancelled, but the
next slider on that layer still takes it as its "before" (as before F3); an undo does not cancel a match drag or a
text edit in progress (only an MCP undo reaches them); the magnific gate is red since L4 (6b61514: list_recipes lists the
Relight recipe, which names magnific first; F4); a relight recipe imported or saved under a new id is accepted and never
run (`docs/BUGS.md`); list_layers' params of a relight layer do not go back through set_filter (the panel keys are not in
the spec; before F3 too).
Gates on the fix: relight editor document on both backends (relight 251 / 250), assistant (38/38) commands film grading
recipes brush comfyview help on tiles (comfyview's "Ctrl+S reaches the page" control failed once while the mutation
round's instance ran beside it, the known flake of docs/TESTING.md; 25/25 alone); 73 of 74 `node tools/*_test.js` (the
74th, ideogram45_test.js "Nano Banana 2 text run", fails on 4192a6a too; F4); eslint 0 errors, types; `build_node.py
--check`: inpaint_canvas, inpaint_filters and inpaint_relight differ (the node build waits for the release).

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
- Found in F3, not relight's own code: the magnific gate is red since L4 (6b61514): `magnific_test.py` LISTS takes the
  Relight recipe (it lists magnific, first) into the edit list; leave task relight out there and check relight's
  providers on their own. `tools/ideogram45_test.js` fails "Nano Banana 2 text run (640 x 1536)" (241/242, on 4192a6a too).
- At the end: the full gate list on both backends (relight editor assistant selection limit maps edges depthfx
  document commands skins help recipes mcp film grading brush comfyview magnific, export on tiles), every
  `node tools/*_test.js`, lint, types,
  `build_node.py --check` (then the node build when the release comes), the CHANGELOG, then the user's test.

**F4 as built (2026-10-12, the commit after 2f9aa60).** Mapped by a workflow (one reader per item, each with a scratch
prototype and its red-before-fix run), reviewed by a workflow (four areas; two shoulds, each judged a nit by its skeptic;
no must), and a mutation round on copies of the tree (each mutation on a fresh instance, the untouched and the restored
copy PASS).
- **Case u:** the base has a darker top half (30 / 100 over 60 / 200); a spy on `host.relightSend` keeps what goes to the
  mock and what it answers. Checks: one picture sent, at 2048 x 512; the answer 1024 x 256; the landed layer's own size;
  the sent picture keeps the base's top/bottom ratio and its levels under the light (65 / 130 within 1.5); the landed
  layer keeps the base's top/bottom ratio within 5 %; after getValue / setValue (now settled) the relit layer shows; a
  second render through host and the mock sends the picture under the first one's relit layer (four corner bands within
  1.5 levels); the Python side checks the mock's own record (two requests, each picture 2048 x 512). The copied skip
  logic is gone. Mutations, each red: e1ebe65's low-res read (ratio 0.365 against 0.5; the old case u stayed green, as
  did the old contrast and left/right checks on the uniform base), host's hide of the previous relit layer off (the
  second send's bands 79 / 57 / 158 / 114 against 65 / 65 / 130 / 130; the old copied check stayed green), the mock
  echoing (the answer size), the read taking the relight layer in (upTo past the run and the layer left visible: only the
  levels under the light catch it, 73.9 / 146.1, since the light sits on the line the ratio splits at).
- **Case r:** `ed.hover = null` before every screen read; the run's flatten equal with the handles shown and hidden and
  under the lights and select tools (bitwise); the H key hides the handles and keeps the tool, H again shows them; the
  screen with handles shown and hidden differs by more than 200 px, each light and the own light have more than 20 of
  them within 48 px, none elsewhere; hidden equals the select tool's screen. Measured: 1978 px, 1131 / 847 near, 0 far.
  Mutations, each red: the handles never drawn (the old case r stayed green), H ignored, the handles under every tool,
  the handles drawn into a run's flatten (also red in cases a, e, h, i, m).
- **Case w2 (new):** a sun on the map centre with dist 0, GL against CPU, on a gradient base (see the nits).
- **Array schemas:** `assistant_test.js` loads every plugin with a plugin.json through `renderer/plugins.js`
  `loadPlugins()` (`tools/loader.mjs` maps `/plugins/<id>/...?v=` onto plugins/), so commands are registered under
  `<id>.<name>` by plugins.js itself: six plugins, 114 tools. New checks: every plugin with code loads, every plugin
  command carries its plugin's id, every array serves the items its command declares, and boxes rect / src (depth 1)
  and film vertices (depth 2) are numbers. Mutations on a copy (the converter serving `{type:"object"}`, nested arrays
  rewritten, ec60f14's fallback with rect undeclared, src typed string, a plugin array without items, fullId bare): the
  old block passed all six, the new one fails each.
- **shadow_march:** px_test's one-cold-call benchmark is gone. `relightBench` loads `kernels.js` as a pool worker does
  (a fetch shim for `file:`), checks the routing by a call counter on the routed Px (kind 0 runs the twin, kind 1 Rust,
  byte for byte; red with the routing inverted) and switches kernels.js back to JS for the later cases (the review: else
  jobCases compared Rust against Rust). The times only with `PX_BENCH=1` / `large`. `docs/PERFORMANCE.md` 15.2
  rewritten from the routed numbers on a smooth map (Electron's V8, warmed, interleaved, medians): point and spot
  0.72-0.78 twin / SIMD, the sun 1.33-1.77; one job per light over the whole map, no bands, only `px.wasm` in the app.
- **Nits:** a filter record keeps `_deselected` and `applySnapshot` restores it with the id (not the plan's
  `!_selectedLightId`, which turns a step taken before any pick into "none"); relight_test.js suite 24 (red on 2f9aa60:
  an undo over Escape showed light_2 while list_layers said none; an undo over a pick lost "none"). `lightToMap` and
  `shadePixel` turn a sun vector shorter than 1e-5 into (0, 0, 1), the shader's rule; suite 25 (red on 2f9aa60:
  direction (0, 0, 0), 8-10 levels under the shader, 1828 of 2048 texels shadowed) and gate case w2 (red without the
  shadePixel half: max 16 levels). The GL registration's skip is `relightSkip` itself. PLAN_RELIGHT_BUILD.md 4.1 / 4.3:
  near-high heights `z = scaleZ * (1 - far01)`, `lz` with `scaleZ`, the sun's zero rule, shadow_march as built (ABI 20,
  one job per light, kind 0 in the twin). TESTING.md: the no-app exit 1 of selection / limit / maps / edges_test.py
  (measured with `SCUMBLE_CDP_PORT=9599`) and of relight_test.py; `PX_BENCH`.
- **Foreign reds:** `magnific_test.py` LISTS leaves task relight out of the edit list and checks the Relight recipe on
  its own (providers magnific, fal, comfycloud; provider magnific; model image-relight; no Generate; with the key
  keys.magnific true): the gate runs all 11 steps again, the later ones for the first time since L4, all green; mutations
  (default fal, the filter dropped, magnific removed from relight.json) each red. `ideogram45_test.js` expects
  `google/nano-banana-2/text-to-image` (ad19457 moved the WaveSpeed text route there, the bare id answers 404) and prints
  the URL on a failure: 242/242; red with ad19457's line removed.
- The manual's Kelvin presets (it named 1850 K candlelight; the code has Tungsten 2700 to Blue sky 10000); the CHANGELOG's
  Unreleased section rewritten for the people who use Scumble (the relight entries, the Layer menu, reader version 6).
Gates on the fix: relight (270 / 269), editor, assistant (38/38), selection, limit, maps, edges, depthfx, document,
commands, skins, help, recipes, mcp, film, grading, brush, magnific on both backends, export on tiles: all PASS.
comfyview 24 of 25 three times, its control step (the known flake of docs/TESTING.md: the user's Scumble open with this
session's MCP server attached; 2f9aa60 in a worktree failed the same way). All 74 `node tools/*_test.js`, eslint 0
errors, types. `build_node.py --check`: inpaint_canvas, inpaint_filters and inpaint_relight differ (the node build waits
for the release).
Left, noted: case u's spy on `host.relightSend` is restored only around the second render (an exception before it ends
the whole eval, and the spy passes every call on); w2 runs with shadows 0, so the march's use of the frontal sun is
covered by suite 25 alone; the routing check proves kernels.js dispatches on the kind, not that ensureRelightMaps sends
a spot as kind 0; `applySnapshot`'s fallback for a filter record without `_selectedLightId` cannot run any more (every
record carries the key; kept); assistant_test now prints the plugins' load lines; case y's flag read-backs stay.

## Open questions for the user

- The Brainfuck easter egg (4cc2f76): keep it?
- Highlights clip hard at 255 since the identity fix: a soft shoulder instead?
