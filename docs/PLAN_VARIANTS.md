# Variants on a result layer, and Compare without / with a layer: the design plan (item 60)

**Status: designed 2026-11-07 against `8689d49` (branch `wasm-kernels`), read-only: nothing built, nothing measured.**
Line numbers are from that commit; `renderer/editor/inpaint_canvas.js` and `renderer/editor/host.js` will be split by
item 56 before this is built (see §8), so grep the name before editing. Facts are **read** in the code unless marked
**inferred**; every effort figure is inferred. The user's words (CLAUDE.md item 60, 2026-11-07): "another run on the
same selection lands as a variant of the result layer (`◀ 2/4 ▶` on the layer, each variant with its own edge fit and
colour match) instead of one more layer; and Compare (today `toggleCompare`, two result layers A / B with a divider; `\`
held shows the base) also against the picture under the active layer, for a Realism Pass, relight or a filter layer. A
design plan first (masks, undo, the `.scumble` format, the history, MCP)." The open questions are §10; every one has a
recommendation, and the sessions below are written for the recommendations.

## 0. In one paragraph

A **variant set** is a few ordinary result layers that sit together in the stack and show as **one row** in the Layers
panel: the one shown sits on top of the block, the others lie directly below it, hidden. Each member stays a whole
layer of its own (pixels, file, mask, placement, colour match, history entry), so saving, autosave, undo, the
whole-picture operations (crop, extend, resize, turn, straighten), flat export and memory work exactly as they do for
hidden layers today, and an older Scumble opens such a document as separate result layers with the same picture. A
second Generate on the same area (the same crop box as an existing result layer) lands as a new member of that layer's
set instead of a new row, generated from the picture **under** the layer (the shown variant left out of the crop, of
the colour match and of the edge fit at landing). The row gets `◀ 2/4 ▶`. Compare learns two things: A / B between two
variants of one layer (the rest of the picture as it is), and **without / with** for any layer (the picture without the
active layer on the left, with it on the right), which is what a Realism Pass, a relight or a filter layer needs. Both
ride on one change of the compositor's stack walks (§5.1), made first and on its own.

## 1. What exists today (read at `8689d49`)

**How a result lands.** `InpaintEditor.addResults` (`inpaint_canvas.js:18905`) loads each answer file and calls
`addLayer` with `kind: "result"`, the name `"Result " + (history.length + 1)` and `x, y, w, h` from the answer, then pushes
a history entry `{ key, name, ref, x, y, w, h, layerId, time, prompt, negative, refs, seed, mode, denoise, via }`
(18923). `addLayer` (18785) makes **no undo step** ("no undo step, but a waiting restore of the layer list must not drop
it", 18801) and activates the layer. The answers come from three places: `host.runProvider` (`host.js:2377`, API runs:
the crop in the stitch worker, `finishResultAsync` stitches, `addResults` at 2489), `host.runUpscale` (2593, a selection's
upscale, `addResults` at 2676), and the ComfyUI websocket's `executed` handler (`host.js:6901`, local runs, which spreads
the click's texts kept per prompt id in `ed._sentTexts` into each result, 6903-6909). Each area (`renderer/editor/eacharea.js`,
item 54) runs `editor.generate({ refs, area })` once per area, each result its own layer.

**What a result layer holds.** Its pixels are the stitched patch (`stitch.js` `finishPixels`, 661): the model's answer
resized to the crop box, warped by the edge fit when the crop setting `align` is on (`fitLayerRGBA`, 703, against the
composite of the box), colour matched when `colorMatch` is on (729, against the same region), and the selection's soft
mask baked into its alpha (740). So the edge fit and the stitch-time colour match of today are **in the pixels**. Beside
them a layer has a live colour match `match: { strength, source }` (`addLayer` 18800, drawn by the compositor, saved at
24655), an optional layer mask (`maskPx` / `maskRef` / `maskOff`), and after the fact `matchEdges` (5094) moves the layer
(a whole-pixel fit) or resamples it, baking a live mask in, as one `layerfull` undo step.

**The history panel.** `renderHistory` (20907): one item per entry, newest first; a thumbnail click is `soloResult` (21053:
every result layer hidden but this one), Ctrl / Shift+click sets Compare's A / B (`setCompare`, 4843); the seed and (0.1.48
S4) the prompt are clickable (`reusePrompt`, 20964); an entry whose layer is gone shows *Restore* (`restoreResult`, 21341,
which loads the file again and applies the entry's `orient` / `xf`).

**Compare and the peek.** `toggleCompare` (4856) takes the two newest result layers as A (left) and B (right);
`drawSceneImage` (23815) draws the scene twice, clipped at the divider, with `this.compareShow` set to the side's layer
id. Every walk of the stack reads `compareShow`: `boxReach` (8420), `stackPlan` (8480), `passStores` (9145),
`belowSignature` (15654), `nextIsFilterLayer` (16295), `drawLayersInto` (21863), `sceneSignature` (23763), and in
`host.js` the two `readSig` keys of the Realism Pass and relight (3843, 5045). While `compareShow` is set, **every other
result layer is hidden** and the side's result is drawn even when it is hidden. The peek (`\` held, 3730 / 3162; the view
bar's button, `inpaint_modal.js:198`) draws the base alone and wins over Compare (`drawSceneImage` checks it first).
Esc ends Compare (3131). The Compare button sits in the History section's header (`inpaint_modal.js:1098`).

**Undo.** Steps are snapshots by kind (`snapshotOf`, 14268): `layers` keeps shallow copies of every layer record
(`snapshotLayer`, 14104: the pixels by reference, `match` / `params` / `text` copied), the pixel steps (`layerrect`,
`layerfull`, `mask`, `match`, `transform`) address one layer **by id**. A visibility switch (`setSelectedFlag`, 18868) is no
undo step, nor is a landing. `historyGen` counts changes.

**The document.** `getValue` (24632) writes each layer from a fixed field list, so unknown layer fields are dropped by
the next save; `setValue` (24710) reads pixel layers of any kind with a `ref` (24827-24849). `.scumble` versioning is the
`FEATURES` table in `electron/main/docfile.js` (55): a row with `version` (an older reader opens with a note and asks
before saving over the file, `docfile.js:274`) or `reader` (an older reader refuses). `FORMAT_VERSION` is the largest
`version` (2 today, from `maps`), `READER_VERSION` the largest `reader` (6, from `relight`; `docs/DOCUMENTS.md` §6.2 still
says 5). Every object with a string `filename` anywhere in the state is a ref the file carries (`collectRefs`, 230), and
the Local files clean-up walks the same way (`host.referencedFileKeys`, 5875).

**Whole-picture operations** walk `this.layers` and change each record in place or replace its pixels, with a `canvas`
or `turn` step holding the copies (crop `cropCanvasNow` 5954, resize `resizeImageNow` 6005, extend 13843, turn 5301,
straighten 5599); the history entries' boxes follow through `mapExtras` (5423), and an undo maps them back by the
difference (`restoreGeometry`, 5512).

**The run's crop box before the run.** `stitch.js` `planFrame` (528) / `planBox` (549) give the box an API run will
send (the same geometry as `planCrop`, including the widening to an aspect preset); `editor.cropRect()` (18250) mirrors the
node's crop for a local run. Each area plans each area's box with `planBox` on the area's bounds.

**MCP.** `generate` (`renderer/commands.js:1882`) waits for a new history entry and answers `layer` (its
`layerSummary`, 74); `list_layers` (1979) lists every layer; `findLayer` (157) resolves an id, an exact name, then a unique
part of a name; `compare` (2508) toggles the A / B split only.

**Layered export.** `exportLayerStack` (17765) and `exportLayerSources` (17809) write every pixel layer into a PSD / ORA,
hidden ones as hidden layers. Flat exports draw what is visible.

## 2. What the user gets

1. **Generate on a selection** gives *Result 1*, as today.
2. **Generate again on the same area** (the selection untouched, or the same area selected again: the same crop box)
   lands on *Result 1*'s row as **variant 2 of 2**, shown at once; the row reads `Result 1  ◀ 2/2 ▶`. The run was made
   from the picture under Result 1 (Result 1 left out of the crop), and its edge fit and colour match at landing were
   done against that picture too, so each variant is a fresh try at the same spot, not an edit of the one before. The
   status line: "Result 5 is variant 2 of 2 of Result 1 (◀ ▶ on its row, or , and . with the layer selected)."
3. **◀ / ▶** on the row (and `,` / `.` with the layer active) step through the variants. Each step is one undo step;
   steps in a row on the same layer count as one, so Ctrl+Z after looking through them goes back to the variant shown
   before.
4. **A new layer instead, once:** Shift+click on Generate (Ctrl+Shift+Enter). **For the document:** the Generate
   setting *Same area again*: "a variant of its layer" (default) or "a new layer".
5. **Four quick Generates on a ComfyUI recipe** (they queue) land as one layer with four variants.
6. **Each area again** on the same selection gives each area's layer a variant.
7. **The row's controls are the layer's:** the eye, opacity, blend mode, lock, clipping, group and place in the stack
   hold for all its variants. **The pixels are the variant's:** painting, the layer mask, moving and scaling, *Match
   edges*, the colour match and the history entry belong to the variant shown. A new variant starts with the colour match
   of the one shown before it.
8. **The row's menu:** *Keep this variant* (the others go), *Discard this variant*, *Split into layers* (the picture does
   not change), *Compare variants*. With two or more result rows selected: *Join as variants* (for older documents, or
   results made on different areas).
9. **The history** marks each entry of a variant ("variant 2 of 4", "shown"); a click on its thumbnail shows that
   variant; the prompt and the seed are clickable as before; *Solo* still shows that result alone.
10. **Saving** keeps every variant in the `.scumble` file; a **flat export** is what is shown; **PSD / ORA** get the
    variant shown (§6.4, Q10).
11. **Compare A / B** of a layer with variants compares two of its variants (the variant before and the one shown, or
    the history thumbnails' Ctrl / Shift+click), the rest of the picture as it is; ◀ ▶ while comparing step side B.
12. **Compare without / with** (new): for the active layer of any kind (a filter, relight, the Realism Pass layer, a key,
    a paint or result layer): the picture without that layer on the left, with it on the right, the divider dragged as
    today. Started from the view bar (a button beside the peek) or the layer's menu; Esc ends it; holding `\` still shows
    the base alone.
13. **Agents** see one entry per row in `list_layers`, with the variants listed in it; `set_variant` and `edit_variants`
    are new; `generate` takes `as`; `compare` takes `a`, `b`, `layer` and `split` (§7).

## 3. Three models, and why the members model

**A. Hidden records outside the stack, one layer id.** The layer keeps its id; the hidden variants are records on it
(`layer.variants = [...]`) and a switch puts another record into `this.layers`. The id stays stable (references, plugin
data, MCP), but every place that has to see **all** the pixels a document holds has to learn the hidden records:
`getValue` / `setValue` (a nested field an older reader drops on save: the hidden variants are gone), `syncLayers` (an
edited hidden variant must be uploaded), `heldPixels`, the five whole-picture operations and their `canvas` / `turn`
steps (`turnSnapshot` keys its clones by layer id, 14549, so records sharing an id collide), and every pixel undo step
addressed by id would land on whichever variant is shown when it is undone (a `layerrect` of variant 2 written into
variant 3). A–Z of the Full test tier, for a feature whose risk should be in the UI.

**B. Hidden variants parked as files.** The hidden ones are plain JSON (a ref, a mask ref, a box, `orient` / `xf` like a
history entry), so saving and undo are easy, but a switch becomes an asynchronous decode (and an upload of an edited
variant), the parked boxes need the history entries' geometry mapping (and must not be mapped again on an undo, since the
layer records come back from the step), and Compare between two variants needs one of them decoded into a scratch layer.

**C. Members: each variant is an ordinary hidden layer (chosen).** The pixels, files, undo, geometry, autosave and the
older reader all stay as they are; Compare between two variants is today's `compareShow` with a narrower hiding rule. The
cost moves into the Layers panel and the row operations (§6.3: one row per set, the block moves as one, merge / delete /
duplicate know about it) and into the id of the row, which changes with the variant shown (the row's `activeLayerId`
follows the switch; agents read `list_layers` again, §7). That cost is visible and undoable when wrong, which is what the
Normal tier is for (CLAUDE.md "Working rules"). The Full tier is left for the stack walks (§5.1) and the format row
(§6.5).

## 4. The data model (members)

### 4.1 Fields

On a result layer that is a member of a set (only `kind: "result"`, role `none`):

| Field | Type | What |
|---|---|---|
| `vset` | string | the set's id, `"V" + Date.now().toString(36) + counter` (as layer ids are made) |
| `vno` | integer >= 1 | the variant's number: the order `◀ ▶` steps in, the landing order; renumbered 1..n after one leaves |
| `vshown` | `true` | on the one member the set shows (left out on the others); also while the row's eye is off |

A layer without `vset` is a plain layer. A member's `visible` is its own as today; a hidden member's is always false.

### 4.2 The invariants (`normalizeVariants`, pure)

A new module `renderer/editor/variants.js` (shared with the node build: plain named imports, into `tools/build_node.py`'s
FILES) holds the rules as pure functions over an array of layer-like objects, so plain Node can test them
(`tools/variants_test.js`). The editor runs `normalizeVariants(this.layers)` at the start of `normalizeGroups`
(21980; it already runs in `renderLayers` and `layersRestacked`, and skips while `holdGroups` counts a load), before the
group rules, and it must be idempotent:

1. A set has two or more members; a set of one loses its fields (a plain layer).
2. Exactly one member has `vshown`: none, the one with the highest `vno`; more than one, the topmost keeps it.
3. Every other member has `visible: false`.
4. The members sit together: the shown one where it is, the others directly below it in `vno` order (the lowest at the
   bottom). Each takes the shown one's `group` and `clip`: a clipped shown member must find, through `clipTargetOf`
   (21896, which steps past clipped layers), the layer below the block, not a hidden member; and a layer clipped to the
   block from above finds the shown member, since it is on top.
5. A member that is not `kind: "result"` with role `none` (a reference, a control layer: changed by a command) leaves the
   set (rule 1 then applies to the rest).
6. `vno` runs 1..n without gaps.

Rule 4 is the one that keeps the row operations simple (§6.3): an operation that moves the shown member anywhere, by any
path (a drag, Ctrl+] / Ctrl+[, `moveLayer` to the top, Ctrl+G), leaves the hidden members behind, and the normalization in
the same `renderLayers` call gathers them under it again. Since every such operation pushes its `layers` step before it
moves anything, the repair is inside that step. Normalization never runs in the middle of an operation.

### 4.3 Shared and own

| The set's (the shown member's, handed on at a switch) | Each variant's own |
|---|---|
| `name`, `visible` (the eye), `opacity`, `blend`, `locked`, `alphaLock`, `clip`, `group`, the place in the stack | `px`, `ref`, `dirty`, `exportRef`, `x`, `y`, `w`, `h`, `maskPx` / `maskRef` / `maskOff` / `maskDirty`, `match`, its caches (`_mcache`, `_fcache`, `_masked`, `_mstats...`), its history entry (prompt, negative, refs, seed, mode, denoise, via, time) |

The edge fit of the landing is in each variant's pixels (§1), *Match edges* afterwards changes the variant shown, and the
live colour match is each variant's own (the user's words), copied from the shown variant when a new one lands (Q4). The
layer mask is each variant's (Q5): *Match edges* bakes a live mask into the pixels it resamples (5165), so a mask is tied
to its variant's pixels anyway. Moving or scaling by hand is the variant's (Q6). The history entry's name stays "Result
5"; the member takes the set's name.

### 4.4 Memory

A set of n variants holds what n result layers hold today: each member's tiles (and its display mirror once it was
shown). Nothing new is kept. At 15k a variant of a 3,000 x 3,000 crop is 36 MB of tiles (inferred from 4 bytes per
pixel), so eight are about 290 MB, as eight result layers are today. V6 measures it (§8); if the hidden members' display
mirrors weigh, a switch can let the hidden one's mirror go (`releaseDisplay`, as `releaseDetachedDisplays` does for
pixels the document no longer holds, 14452).

## 5. Landing as a variant

### 5.1 The stack walks: one predicate first (V0)

Today eight places repeat the two lines that decide whether a pass draws a layer (`compareShow`'s hiding, then
`shown(l)`). Both new things in this plan add a condition: the run of a variant leaves the layer it varies out of its
composite (`omit`), and Compare's without / with leaves the active layer out of one side (`compareHide`). CLAUDE.md's trap
("a second walk of the layer stack ... is where this design breaks; keep it next to `drawLayer`'s branches") says to make
it one function before adding to it:

```js
// whether a pass draws this layer; `opts.omit`: a Set of layer ids the pass leaves out (a variant's run)
passShows(l, opts) {
    if (opts && opts.omit && opts.omit.has(l.id)) return false;
    if (this.compareHide && l.id === this.compareHide) return false;
    const cs = this.compareShow;
    if (cs) {
        if (this.compareLocal) { if (l.vset && l.vset === this.compareLocal) return l.id === cs && !!l.px; }   // §6.6
        else if (l.kind === "result" && l.id !== cs) return false;                                        // today's rule
        if (l.id === cs) return !!l.px;                                                                   // shown even when hidden
    }
    return this.shown(l);
}
```

used in `boxReach`, `stackPlan`, `passStores`, `nextIsFilterLayer`, `drawLayersInto` (and whatever else
`grep compareShow` finds then), with `omit` threaded as an option through `drawComposite`, `sampleRegion`,
`holdRunStack` / `holdStack`, `readBox` / `readBoxBytes`, `flattenToCanvas`, `encodeComposite` / `uploadComposite`; and
`compareHide`, `compareLocal` added to the keys that hold `compareShow` today (`sceneSignature`, `belowSignature`, the two
`readSig` in `host.js`). V0 changes no picture: `omit` is never passed and `compareHide` is never set. Full tier (the
compositor): both backends, a mutation round, and a new editor step that composites a box through every path (region
pass, stack plan, bands, the GL view composite) with `omit` of one layer and compares its bytes with the same composite
with that layer hidden.

### 5.2 When a run is a variant: the rule at the click (the app's host)

The decision is made where the run is made, in the app's host (`host.js` `runProvider` and `queueGenerate`'s edit path;
an area's run goes through the same two), not in the shared editor: the node's host would otherwise need a new member
(`tools/build_node.py --check` fails when the editor calls a host member the node's `js/host.js` lacks), and the node's
result path carries no prompt id to tie a landing to its click. The editor gives the host pure helpers
(`variants.js`: `variantTarget`, below) and acts on what the landing carries (§5.4). In the node nothing changes (Q14).

1. **The choice** `as`: from the click (Shift+click / Ctrl+Shift+Enter: "layer"), the MCP `generate as`, else the
   document's setting `genSettings.variants` ("auto" by default, "off"). "layer" (or "off" without an explicit
   "variant"): no target.
2. **The box** the run will land at: an API run `planFrame(editor, nodeParams, cropLimits())` (the same geometry as
   `planCrop`, aspect presets included), an area's `planBox(editor, ..., area.bounds())`; a local run `editor.cropRect()`
   (the node's crop; a local area's `cropRect` of the area's bounds, `cropRect` taking bounds as an argument).
3. **The candidates:** the panel's rows of kind `result`, role `none`, not locked (`isLocked`, a group's lock included),
   with a history entry of a member (or of the plain layer) whose `[x, y, w, h]` equals the box and that has no `xf`. The
   history entries' boxes are the landing crop boxes (`addResults` writes the layer's place at landing, which is the crop
   box), and `mapExtras` keeps them right through every whole-picture operation and its undo. (A box field on the layer
   would be mapped twice on an undo: the step brings the layer record back as it was and `restoreGeometry` maps the
   extras again, §9 trap 8.)
4. **The target:** the active row if it is a candidate, else the topmost candidate; none: a new layer. With `as`
   "variant" and no candidate: the active row if it is a result layer, whatever its box (the agent or the user asked);
   else the run is refused before anything is sent ("Select a result layer to add a variant to").
5. **The queue (local runs):** with no candidate, the click reserves a set id for its box (`ed._variantReserved`, keyed by
   the box, with the count of its runs still out); a later click with the same box while one is out takes the same id.
   The first landing of the id makes a plain layer and records it; the next landings of the id join it (§5.4). The map
   lives only in memory and empties as the runs land, fail or are cancelled (the runs do not survive a restart either).
   API runs need none: one API run per document (`providerPending`).
6. **The omit:** the target's members (the shown one is the only one drawn) go as `omit` into the run's crop: the
   stitch worker path's `holdRunStack({ forRun: true, omit })` and `regionBytes` (`stitch.js:899, 907`), the window
   fallback `prepareCrop`, and a local run's composite upload (`serializeForPrompt` 24986: `uploadComposite({ forRun: true,
   omit })`, which must not reuse or set `uploaded.baseHash`, the cache of the composite with every layer; a slot of its
   own keyed by the omitted ids, dropped whenever `baseHash` is). Q3 asks whether this is what the user wants.
7. **The finish:** `finishResultAsync` reads the box's composite again for the colour match and the edge fit
   (`stitch.js:949`); a variant's read omits the set's members **as they are at the read** (the user may have switched
   or discarded one during the run), so the new variant is matched and fitted against the picture under the layer,
   not against the variant it replaces. A local run's node stitches against the composite it was sent (step 6).
8. **What travels:** `{ set, of, box, reserve }` on the run (the API token; a local run's entry in `ed._sentTexts` for its
   prompt id, which `executed` already spreads into each result, `host.js:6909`), and `addResults` reads it as
   `r.variant`.

### 5.3 What is never a variant

An upscale of the selection (`runUpscale`), the Realism Pass, relight's generative routes, a key, Generate new and a
result restored from the history pass no `variant` and land as they do today (Q20 asks about the Realism Pass and relight
later).

### 5.4 The landing (`addResults` with `r.variant`)

1. **The target again:** the shown member of `set`, else the layer `of` (a plain result layer), else the layer recorded
   for `reserve`. It must still be there, a result layer, role `none`, not locked, and the landed box (`r.x, r.y,
   r.width, r.height`) must equal the click's `box` (unless the target was explicit, §5.2 step 4); else the answer lands as
   a new layer and the status line says why ("Result 6 is a new layer: Result 1 was locked during the run").
2. **The new member:** made by `addLayer` as today (its history entry too), then joined: a plain target gets a set id
   (the reserved one when there is one), `vno` 1 and `vshown`; the new one gets `vset`, `vno` = the largest + 1,
   `vshown`, the set's shared fields (§4.3) and the shown member's `match`, `visible: true`; the member shown before gets
   `visible: false` and loses `vshown`; the new one goes into the stack directly above it (the top of the block).
3. **No undo step**, as a result's landing today (the record a later `layers` step takes includes it; an undo of a step
   from before the landing takes it away, as it takes a result away today: §9 trap 18).
4. **The status line** as in §2.2; `generate` answers `variant: { set, index, count }` (§7).

## 6. The row, the switch, the history, Compare

### 6.1 The row

`renderLayers` (18941) lists rows: a set's hidden members are skipped (a helper `rowLayers()` and `isHiddenVariant(l)`,
which the commands and the plugin API's `layers()` use too). A set's row shows the shown member's thumbnail and name, and
after the name `◀ k/n ▶` (two mini buttons and the count; the count's tooltip lists the variants with their seeds). The
row's context menu (`openLayerMenu`) gets *Keep this variant*, *Discard this variant*, *Split into layers*, *Compare
variants*; with two or more result rows selected, *Join as variants*. The kind select (result / reference) is hidden on a
set's row: a set never becomes a reference (*Split into layers* first, §6.3).

### 6.2 The switch (`showVariant(layer, k | { step })`)

Refused while the layer is locked (it changes the picture, as a delete would), while a stroke is held
(`removePending` / `healPending` / `liquifyPending`) or a pointer gesture is on the layer; a pending transform is
cancelled first (`cancelPending`, as other layer operations do); a mask view of the old member ends. Then, in one
synchronous step:

1. the undo step: `pushUndo({ kind: "layers", label: "Show variant k" })`, unless the top step is a switch of this set and
   nothing happened since (`snap.variantSet === set && this.historyGen === snap.gen`): then nothing is pushed, so a run of
   switches is one step and Ctrl+Z returns to the variant shown before them (Q7). A switch after an undo pushes a new step
   (and clears the redo steps, as every edit does);
2. the shared fields from the old member to the new; the old one `visible: false`, without `vshown`; the new one with it;
   the new one spliced to the old one's index (the top of the block);
3. `activeLayerId` and `layerSel` follow the new id; Compare's B follows when it was the old member (§6.6);
4. `uploaded.baseHash` / `controlHash` dropped, `refsMutated`, `renderLayers`, `renderHistory`, `draw`, `drawThumb`,
   `notifyChanged`; the status line names the variant, its seed and its route (the history entry's `via`).

Keys: `,` and `.` with a set's row active (free in the editor's key handler today, 3700-3810; the plugins' `pluginKey`
and the Boxes tool's keys run first and must be checked in V3; Q8).

### 6.3 The row operations (the block)

What every operation that the Layers panel or a command offers does with a set (each is one `layers` undo step, as it is
today):

| Operation | With a set |
|---|---|
| Delete the row (trash, Delete, `remove_layer`, `removeLayers`) | the whole set; the status says "with its n variants" |
| *Discard this variant* / *Keep this variant* | the shown member, the next lower `vno` shown (the next higher for the first) / every other member |
| *Split into layers* | the fields removed; each member a plain layer where it is (the hidden ones stay hidden: the picture does not change), named by its history entry ("Result 5") where it has one |
| *Join as variants* (2+ result rows) | one set: the topmost shown, the others below it in stack order (`vno` from the bottom), its shared fields for all; sets among them join with all their members |
| Merge down (`mergeDownNow`, 17172) of the set | the shown member into the layer below **the block** (today `this.layers[i - 1]`, 17178, which would be a hidden member), the hidden members dropped; the status says so (Q12) |
| Merge down of the layer above a set | into the shown member (it is on top): the set keeps its other variants |
| Merge selected (`mergeSelected`, 17230) | as merge down: the shown members go in, their hidden members are dropped |
| Flatten (22838) | as today (it keeps control and reference layers only; the hidden members go with the rest) |
| Duplicate (Ctrl+J, `duplicateLayer`, 17130) | the shown member as a plain layer: the spread `{ ...layer }` (17135) must drop `vset`, `vno`, `vshown`, or the copy is a second shown member (Q11) |
| Move: drag (`dropInLayers`), Ctrl+] / Ctrl+[ (`stepLayer`), to top / bottom, Ctrl+G (`groupLayersNow`) | the shown member moves as today and the normalization gathers the block under it (§4.2 rule 4); `stepLayer` downwards must step past the block's own hidden members (22234: the next layer down is a hidden member of its own set, and a swap with it moves nothing) |
| The eye (`setSelectedFlag`), Alt+click solo (`soloLayers`, 17092), *Show all layers* (`showAllLayers`, 16769) | the shown member; `showAllLayers` sets every layer visible (16771) and must skip hidden members; a solo's restore keeps one member visible (17099 sets hidden members false, its restore lists the members that were visible) |
| Lock, alpha lock, opacity, blend, clip (`setLayerClip`) | the shown member; handed on at a switch; the normalization gives `clip` and `group` to all members |
| The role (`setLayerRole`, 4429: reference or a control type) | refused on a set ("Split into layers first") |
| *Match edges*, a mask, a move, the colour match, painting | the shown member (its own) |
| Copy (Ctrl+C) / paste to another tab | the shown member's pixels, as for any layer |
| Ungroup, delete group | as today (`ungroup` changes every member's `group`; `removeGroup`'s `groupLayers` includes the hidden members) |

### 6.4 Export

Flat exports draw what is visible: the shown variant. `exportLayerStack` and `exportLayerSources` (the PSD / ORA writers'
two layer lists) skip hidden members (`isHiddenVariant`), so a PSD gets the row as the user sees it (Q10 asks whether the
others should go along as hidden layers instead). `export_layer` and *Export layer* of a row export the shown member.

### 6.5 The `.scumble` format and the session autosave

`getValue` writes `vset`, `vno` and `vshown` on members (`...(l.vset ? { vset: l.vset, vno: l.vno, ...(l.vshown ? { vshown:
true } : {}) } : {})`), `setValue` reads them on pixel layers (24841) and leaves the repair to `normalizeVariants` once the
load ends (`holdGroups`). Every member is a layer with its own `ref`, so its file is packed as required, kept by the
clean-up, restored by the autosave, all as today; "Save without history" keeps the variants (they are layers).

**Versioning:** a `FEATURES` row `{ id: "variants", since: "<the release>", version: 3, sample: { layers: [{ kind:
"result", vset: "V1", vno: 1, vshown: true }, { kind: "result", vset: "V1", vno: 2, visible: false }] }, test: (d) =>
layersOf(d).some((l) => l && typeof l.vset === "string") }`. `FORMAT_VERSION` becomes 3; `minReader` is not raised: an
older Scumble shows the same picture (the hidden members are hidden layers), opens the file with its note and asks before
saving over it (`docfile.js:274`), and if the user saves anyway the set becomes separate result layers, all pixels kept.
`docs/DOCUMENTS.md` §4.1 (the three fields), §6.2 (the reader is 6, not 5; the note's "what this version does not know is
kept" is not true of layer fields: they become separate layers) and §8 (the row) are updated with it.
`gen.variants` (the setting) needs no row: unknown `gen` keys ride along (`setValue` spreads `gen`, as `gen.boxes`).

### 6.6 Compare

**A / B, variant-aware.** `this.compare` gets a mode: `{ mode: "results", a, b, split }` (today's) or `{ mode: "layer", id,
split }` (below). When both sides are members of one set, `this.compareLocal` is that set's id while a side is drawn, and
`passShows` (§5.1) hides only the set's other members and shows the side's member: the other areas' results stay in the
picture (today's rule hides every other result layer, which is right for two plain results and stays for them and for a
mixed pair). `toggleCompare` with a set's row active compares the variant before the shown one (`vno` - 1, wrapping) with
the shown one; elsewhere as today, over rows (the two newest result rows), not over hidden members. Ctrl / Shift+click
on history thumbnails set A / B by the entries' layer ids as today. While two variants of one set are compared, ◀ ▶ (and
`,` / `.`) switch the shown variant and side B follows it, so A can be held while B steps through the others. The labels
read "A · Result 1, variant 2" / "B · ... variant 4".

**Without / with (new).** `{ mode: "layer", id }`: side A is drawn with `this.compareHide = id` (the layer left out of
every walk, §5.1), side B as it is; the labels read "Without · Relight 1" / "With · Relight 1". For a set's row the shown
member is the layer. The whole picture without that one layer is what each side shows (the layers above it stay), which
is what a filter layer, relight, the Realism Pass layer (it lands under the top run of filters,
`host.js` `realism.topFilterRun`) or a key layer needs (Q15). A reference or control layer is refused ("not part of the
picture"); a hidden layer gets a word ("Relight 1 is hidden: both sides are the same").

**How it fits.** One Compare at a time: starting one mode ends the other, the divider's place is kept, Esc ends either
(3131), the peek (`\` held, the peek button) wins over both while it lasts, as it does over today's Compare. Entry points:
the History header's button stays A / B (variant-aware); a new view-bar button beside the peek, "Compare without / with
the active layer"; the layer menu's *Compare without this layer*; MCP `compare` (§7). A held key for a quick look without
the active layer (the peek's sibling) is Q16.

### 6.7 The history panel

`renderHistory` marks each entry whose layer is a member: "variant k of n", and "shown" on the shown one. A thumbnail
click on a member's entry shows that variant (`showVariant`) instead of `soloResult` (which would set a hidden member
visible beside the shown one); the *Solo* mini button keeps its meaning (that result alone among the result rows: a
switch, then every other result row hidden). *Discard* on a member's entry discards that variant (§6.3). An entry whose
member is gone shows *Restore* as today, which restores it as a plain layer.

## 7. MCP

| Command | Change |
|---|---|
| `list_layers`, `status` | rows only (no hidden members); a set's entry gets `variants: { set, shown: k, count: n, items: [{ id, index, shown, seed, mode, prompt }] }` (the prompt of its history entry, cut to 120 characters); `status.results` counts result rows |
| `findLayer` (every layer argument) | names and parts of names over rows only (members share a name); a hidden member's id is refused with "layer L... is variant 2 of 4 of Result 1 and not shown: set_variant shows it", except in `set_variant`, `edit_variants` and `compare` |
| `generate` | `as`: `"auto"` (the document's setting), `"layer"`, `"variant"` (of the active result layer; refused without one); the answer adds `variant: { set, index, count } \| null` and `landed_as` (`"variant"` or `"layer"`, with the reason in `notes` when an auto variant fell back to a new layer); `each_area` the same per area in `layers` |
| `set_variant` (new) | `{ layer, index?, step? }`: show variant `index` (1-based) or step `+1` / `-1`; answers the shown member's summary and `variant`; one undo step (merged as in §6.2) |
| `edit_variants` (new) | `{ layer, action: "remove" \| "keep" \| "split" \| "join", index?, layers? }`: remove the shown variant or `index`, keep only the shown one, split into layers, join `layers` (two or more result layers) into one set; one undo step each |
| `remove_layer` | a set's row goes with all its variants (the description says so; `edit_variants remove` takes one) |
| `compare` | `{ enabled?, a?, b?, layer?, split? }`: `a` / `b` two result layers or two variants' ids (from `list_layers`' `variants`), `layer` the without / with split for that layer, `split` 0.05-0.95; answers `{ compare, mode, a, b, layer, split, status }` (an agent then takes a `screenshot`) |

The tool count grows by two (118 to 120 at 0.1.52's count; README, `docs/MCP.md`, the `.mcpb` tool count in the gates).
The assistant uses the same server and gets the same words. The plugin API's `layers()` (`renderer/plugins.js:65`) lists
rows too (`docs/PLUGINS.md`).

## 8. Sessions

**When:** item 60 touches `inpaint_canvas.js` widely (the walks, the row, the operations) and `host.js` (the run path).
Item 56 (the user, 2026-11-07) splits "the rest of `inpaint_canvas.js` and `host.js` after the kernel release (K41), as a
block of its own before new features", and items 57-59 are being built in the same file now. So this is built after the
kernel release and the split, on a branch of its own, one session at a time with a commit each, and its anchors are found
again by name then. Q21 (§10) asks whether the user wants it earlier.

| # | Session | Tier | Effort |
|---|---|---|---|
| V0 | **The stack walks' predicate** (§5.1): `passShows` in every walk, `omit` threaded through the composite paths, `compareHide` / `compareLocal` in the keys; no picture changes. A new editor step: a box composited through each path with `omit` equals the composite with the layer hidden, on both backends | Full: `bash tools/run_gates_both.sh v0 --offline lint types pixels composite editor groups clip blendmodes maps relight export layered pxjobs edges`, a mutation round (`tools/mutation_round.py`: the predicate reduced to `shown(l)`, `omit` dropped in one walk, the `compareShow` branch inverted; each kill set must go red) | 0.5-1 day |
| V1 | **The model and the format** (§4, §6.5): `renderer/editor/variants.js` (pure: `normalizeVariants`, `variantTarget`, the switch's reorder, join / split / keep / remove on an array), the editor's methods without UI (`showVariant`, `rowLayers`, `isHiddenVariant`, the operations of §6.3 that are data: join, split, keep, discard), `getValue` / `setValue`, the `FEATURES` row, `docs/DOCUMENTS.md`, `tools/build_node.py` FILES; `tools/variants_test.js` (plain Node: the six invariants, the target rule over layers and history boxes, the switch, the queue's reservation) | Full for the format: `document` and `docux` on both backends with a set saved and opened (members, order, visibility, files, the picture's bytes); an older reader's view (the state with the three fields stripped opens as plain layers with the same picture bytes); a mutation round on `normalizeVariants` and the `getValue` fields; `nodecopy`, `python tools/build_node.py --check` | 1-1.5 days |
| V2 | **Landing as a variant** (§5): the host's rule at the click (API, local, Each area), the queue's reservation, `omit` in the crop and at the finish, `addResults`' join, the setting and its control, Shift+Generate / Ctrl+Shift+Enter, the status line, `generate`'s `as` and answer. A new gate `variants` (`tools/variants_test.py`, the loopback provider, which answers an edit with the crop it was sent, and the stubbed local queue of `tools/areas_test.py`): a second run on the same selection joins as variant 2 and its pixels hold none of variant 1's (variant 1 painted pure red: no red in variant 2's crop, nor pulled in by the colour match); another box or Shift: a new layer; a target locked during the run: a new layer and the word; four queued local runs: one set of four; Each area twice: each area's layer two variants; `as: "variant"` without a result layer refused | Normal, the crop on both backends (`run_gates_both.sh v2 --offline variants`) and on tiles the gates that land results: `areas edges generate editor mcp loras boxes` (adapt any that counted layers after a second run on the same area: with the default "auto" those now join) | 1.5-2 days |
| V3 | **The row and the operations** (§6.1-6.4, §6.7): `◀ k/n ▶`, `,` / `.`, the switch with its merged undo step, the shared fields, the row menu, every operation of the §6.3 table, the history marks and the thumbnail click, the PSD / ORA skip. `variants` gate steps for each row of the table, the keys, the undo merge and its end at an undo; the layered export with a set (the PSD's and the ORA's layer lists) | Normal on tiles (`variants editor groups clip`), `layered export` on both backends with one mutant (the skip removed: the step goes red) | 2 days |
| V4 | **Compare** (§6.6): the two modes, `compareLocal`, the default for a set, B following the switch, the labels, the view-bar button, the layer menu entry, Esc and the peek's precedence, the hold key if Q16 is answered. `variants` gate steps: each side's pixels equal a render with the right layers hidden (A / B of two variants with another area's result in the picture; without / with of a filter layer and of the Realism Pass layer's kind, an `image` layer with `match` underneath) | Normal, both backends for the passes (`run_gates_both.sh v4 --offline variants editor relight`) | 1-1.5 days |
| V5 | **MCP** (§7): rows in `list_layers` / `status` / the plugin API, `findLayer`, `set_variant`, `edit_variants`, `remove_layer`'s words, `generate`'s answer, `compare`'s parameters; `docs/MCP.md`, `docs/PLUGINS.md`, the tool counts | Normal: `mcp commands assistant mcpb` on tiles, `lint types` | 1 day |
| V6 | **Docs, the 15k look, the review:** the manual's sections (*Variants of a result*, and *Compare* rewritten for both modes; no other product named), README's line, `docs/TESTING.md` (the `variants` gate), the CHANGELOG line and CLAUDE.md's gate list by the main loop; at 15k: the memory of a set of eight 3,000 x 3,000 variants and the time of a switch (a frame expected, inferred); a review workflow over V0-V5's diff | Light, and the measurement once | 1 day |

About 7.5-10 days in all (inferred). V3 does not need V2 (*Join as variants* makes sets to build the row on), so V2 and
V3 may swap.

## 9. Traps

1. **The stack walks.** `compareShow` is read in eight places today (§1); a new condition added to some of them shows
   one picture on the screen and sends another to a run. V0 makes it one predicate before anything is added, and its
   gate step checks every path.
2. **The run's composite caches.** A local run's composite is cached by `uploaded.baseHash` (24980): a variant's run
   must neither reuse it nor set it. The two `readSig` keys in `host.js` and `belowSignature` hold `compareShow` and
   must hold `compareHide` / `compareLocal` too.
3. **`{ ...layer }` copies** carry `vset` / `vno` / `vshown`: `duplicateLayer` (17135) would make a second shown member;
   any other spread that makes a new layer from an old one must drop them (grep `...layer,` and `...l,` in V3).
4. **Names are shared** by a set's members: `findLayer` (`commands.js:165`) would find a hidden member by name first;
   names resolve over rows only.
5. **Neighbours.** `this.layers[i - 1]` (merge down's target), `stepLayer`'s swap and `clipTargetOf`'s walk see hidden
   members. Keeping the shown member on top of its block makes everything above the block right by itself; the block's
   own operations step past its hidden members (§6.3).
6. **The normalization** runs inside `normalizeGroups`, after `holdGroups` (a load adds layers one by one, 24772), is
   idempotent, and only repairs what an operation left behind inside that operation's own undo step; it never runs in
   the middle of one.
7. **An edit of a hidden variant** (a stroke undone after a switch) changes nothing visible: the switch is an undo step
   (§6.2), so Ctrl+Z first shows the variant the edit was made on. Merged switches must stop merging at any other step,
   an undo or a redo (`historyGen`).
8. **The box to match on** is the history entry's (mapped forward by `mapExtras`, and back on an undo by
   `restoreGeometry`'s difference), never a box stored on the layer, which an undo would bring back and `mapExtras` would
   then map a second time.
9. **The predicted box must be the landed box.** `planFrame` mirrors the API run's `planCrop`, `cropRect` the node's crop;
   a landing whose box differs from the click's lands as a new layer (never a variant at another place). V2's gate runs
   both routes and an aspect-preset widening (a FLUX 3 style recipe on the loopback) to see they agree.
10. **The node** gets the shared editor code (the row, the walks, `variants.js`) in its next build but never makes a set:
    no host member is added, the decision is the app's host's (§5.2). `build_node.py --check` stays green only so.
11. **Each area's gate** (`tools/areas_test.py`) and any gate that generates twice on the same area and counts layers
    changes its count with the default "auto"; V2 adapts the counts or sets the document's setting to "off" in the steps
    that test something else.
12. **Compare's hiding rule.** Today's "every other result hidden" would hide the other areas' results while two variants
    are compared; the set-local rule is for two members of one set only, today's for everything else.
13. **The thumbnail click** (`soloResult`) sets a result visible: on a hidden member it would show two members; for
    members it is the switch.
14. **`showAllLayers`** sets every layer visible (16771); it skips hidden members. Any other bulk visibility write
    (grep `.visible =` in V3: `inpaint_canvas.js` 16771, 17099, 21056; `host.js` 4711, 5067-5092, 5349; `commands.js`
    2004) is checked against invariant 3.
15. **`toggleCompare`** picks the two newest result layers from `this.layers` (4864), which would be two hidden members
    with one name; it picks over rows, or over the set's members with their variant numbers in the labels.
16. **The format note.** An older Scumble's note says unknown things are kept; layer fields are not (they become separate
    layers). The ask before saving over the file is what protects the file; `docs/DOCUMENTS.md` says it plainly.
17. **Memory at 15k** is that of n result layers (§4.4), not more; but a set makes many variants easy to collect, so V6
    measures eight, and a cap is Q18.
18. **A landing is no undo step today**, for results and variants alike: an undo of a `layers` step from before the
    landing takes the result (or the variant) away again, with its file kept in the history. This plan does not change
    that; Q19 asks whether a landing should become an undo step of its own.
19. **Keys.** `,` and `.` are free in the editor's handler today; `host.pluginKey` (3735) and the Boxes tool's keys run
    first: V3 checks the built-in plugins.
20. **A switch while a run of the same set is out** is fine: the run's omit is resolved again at the finish (§5.2 step 7),
    and its landing joins the set whichever member is shown then.

## 10. Open questions for the user, each with a recommendation

1. **When does a run become a variant?** Recommended: when its crop box is the box of an existing result layer
   (the active one first, else the topmost), whatever made the selection; not only while that layer is active, and not
   only on an explicit choice.
2. **On by default?** Recommended: yes ("a variant of its layer"), as the item is worded; a per-document setting and
   Shift+Generate (Ctrl+Shift+Enter) for a new layer once.
3. **Does a variant's run see the variant shown before it?** Recommended: no: it is made from the picture under the
   layer, so every variant is a fresh try at the same spot, and the colour match and the edge fit at landing compare with
   that picture. A refinement on top of a result is then Shift+Generate (a new layer).
4. **The colour match of a new variant:** copied from the variant shown (recommended; each its own afterwards), or off?
5. **The layer mask:** each variant its own (recommended: *Match edges* bakes it into the pixels anyway), or one mask for
   the whole layer?
6. **Moving or scaling the layer by hand:** the variant shown only (recommended, as the edge fit is each variant's), or
   all variants together?
7. **Is a switch an undo step?** Recommended: yes, switches in a row on one layer as one step, so Ctrl+Z shows the variant
   an edit was made on before it undoes the edit. (The eye is no undo step today.)
8. **Keys:** `,` and `.` for the previous and next variant?
9. **The history thumbnail of a variant:** a click shows that variant (recommended), the *Solo* button keeps solo?
10. **PSD / ORA:** the variant shown only (recommended, as the item says), or the others as hidden layers too?
11. **Duplicate (Ctrl+J) of a layer with variants:** the shown variant as a plain layer (recommended), or the whole set?
12. **Merge down / merge selected / flatten:** the shown variant goes in and the others are dropped (recommended,
    undoable, said in the status line), or refused while a layer has variants?
13. **Queued runs on your ComfyUI** (several Generates before the first lands): one layer with all of them as variants
    (recommended)?
14. **The ComfyUI node:** variants there too later (its result path needs the click carried through to the landing, and
    a new host member), or the app only (recommended for now)?
15. **Without / with:** the whole picture without the layer (recommended), or only the layers below it?
16. **A held key for a quick look without the active layer** (the peek's sibling; Shift with the peek key where the
    keyboard layout allows), or the button and the menu only?
17. **A `◀ ▶` on the canvas** beside the layer (a small floating control while it is active), or the row only for now
    (recommended: the row, the keys and the history)?
18. **A cap on variants per layer** (memory at 15k: each is a layer)? Recommended: none, a word in the status line past
    eight.
19. **Should a landing become an undo step** (results and variants: Ctrl+Z takes the last result back)? Today it is none;
    recommended as a separate small item, not inside this one.
20. **Reruns of the Realism Pass, relight's generative routes and a key as variants** of their layer, later?
21. **Timing:** after the kernel release and item 56's split (recommended, CLAUDE.md's rule for `inpaint_canvas.js`), or
    earlier on a branch of its own?

## 11. A research note (plan only; not for the manual, the README, posts or the CHANGELOG)

From memory, not checked for this plan: Photoshop's Generative Fill keeps the variations of each generation on its
generative layer and shows them as thumbnails in the Properties panel, where one is picked (arrows step through them),
and a new generation on the layer adds more; the layer's mask is the selection's and is shared by its variations. Krita's
AI plugin keeps a strip of results per generation and applies one into a layer. Scumble's design differs where its own
pieces decide: each variant keeps its own edge fit, colour match and mask, the history panel already lists every run, and
Compare puts two variants (or a layer and the picture without it) side by side.
