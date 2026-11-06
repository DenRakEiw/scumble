# CorridorKey 2.0: the UI half (I4, I5, I7) on the branch `ck-ui`, notes for the integration

Built 2026-11-06 on a stubbed engine (`host.keyEngine`), from `docs/PLAN_CORRIDORKEY.md` §4.4-4.8, then reviewed (11
confirmed findings and 3 nice-to-haves, all fixed the same day; "After the review" below). Nothing here ran a real
model. The text under "Texts for the shared files" is for the files this branch did not touch (MANUAL, CHANGELOG,
TESTING, README, MCP.md, CLAUDE.md).

## What is built

| Session | Files | What |
|---|---|---|
| I4 | `renderer/editor/host.js` (the key section after the Realism Pass: `keyEngine` ... `keyOverlayCanvas`), `renderer/editor/keying.js` (pure), `renderer/editor/keyworker.js` | `host.keyScreen`: the box plan, the read at the bucket, the hint, the run, the landing (`landKey`: the Key layer trimmed to the matte, its mask the matte in white, the grey Fill, the hidden source, one undo step), Re-key (`layerfull`), `preview` into the selection |
| I5 | `renderer/keydialog.js` | the Key dialog: a non-modal panel, the live loop (`KeySession`: a dab, a stroke's end, the queue, the overlay), the first-run block |
| I7 | `renderer/commands.js` (`key_screen`, `status.key`), `electron/main/assistant/policy.js` (RUNS + the ask card), `docs/COMMANDS.md` (generated) | the command and the assistant's ask |
| | `electron/main/settings.js` DEFAULTS.key, `electron/main/main.js` (Image › Key Green / Blue Screen...), `renderer/shell.js` (the menu's one dispatch line), `tools/commands_doc.py` (GROUPS) | the entry and the settings |
| tests | `tools/key_test.py` (gate `key`), `tools/keying_test.js` (plain Node) | below |

## The interface I3 fills in

`host.keyEngine` (renderer/editor/host.js) is one object; the gate replaces it whole. Until I3 its calls answer
`keying.TEXTS.notInstalled` ("Key screen: the CorridorKey 2.0 engine is not part of this build yet.").

| member | request | answer |
|---|---|---|
| `status()` (sync, cached) | | `{ installed, offered, present, provider, gpu, cpuSeconds, error, workingSizes, buckets, gb, host }` |
| `prepare(req)` | `{ key, image, bucket: { w, h }, content: [0, 0, cw, ch] }` | `{ provider, ms, cached }` |
| `run(req)` | `{ key, hint, quality, despill, screen, ticket }` | `{ alpha, fg, ms, provider, ticket }`; **rejects with a message holding `KEY_FEATURES_GONE`** (`keying.FEATURES_GONE`) when it no longer holds `key`'s features |
| `holds(key)` | | whether the features of `key` are held (Re-key from its record reads nothing then) |
| `cancel()` | | stop the run going (the title row's Cancel, key_screen's timeout, a closed tab) |
| `free()` | | the process gone |
| `closed()` | | the dialog closed: start the 60 s idle timer |
| `download()` (optional, I2) | | the first-run block's Download: the pre-download terms dialog, then the set |

- `key` is `<doc id>:<SHA-1 of the image bytes, 20 hex>:<w>x<h>` (the features' cache key; a mask stroke on the key
  layer keeps it).
- `image` is RGBA **exactly bucket-sized and already padded**: the picture sits at the top left (`content`), the rest is
  reflect-101 of it (`keying.padRect`). **A change against the plan's §4.4**, where `keycolor.js` pads: here the renderer
  pads, so keycolor.js must not pad again when the image is bucket-sized (and the answer is cropped by `content` in the
  renderer). The pad goes only where the picture's edge leaves the box short of the bucket's aspect.
- `hint`: `Uint8Array` at the bucket (255 = subject), padded the same way, or `null` with `quality: -1`. `quality` is
  0.5 / 0.75 / 0.95 (the mask of a Re-key is 0.95).
- `screen` is always `"green"` or `"blue"` (Auto is resolved in the renderer from the border ring,
  `keying.screenFromRing`; a ring that is neither asks the user).
- `alpha`: `Float32Array` (0..1) or `Uint16Array` (0..65535) at the bucket; `fg`: `Uint8Array` RGB, sRGB, despilled.
- **`buckets` holds the set's buckets at every size it has**; the renderer narrows them to those whose long side is the
  working size (`keying.bucketsAt`) and picks the nearest aspect among them, else `keying.bucketsFor(workingSize)`.
- `workingSizes` narrows the working sizes the setting may pick (`host.keyWorkingSize`). `gb` and `host` fill the
  first-run block's paragraph (`keying.termsParagraph`; without them "about 2.4 GB" and no host).
- The wrappers: `keyHelper(name, req)` in host.js calls `host.helperCall("keyPrepare" | "keyRun" | "keyHolds" |
  "keyCancel", req)` once `window.scumble.helpers.<name>` exists; `status()` reads
  `window.scumble.helpers.keyStatusCached()` if the preload offers it. I3 either adds those to the preload or replaces
  the bodies of `host.keyEngine`.
- The coalescing lives in the renderer, not in I3: `keying.KeyQueue` (one in flight, one pending, the newest replacing
  the pending one, tickets; Key's final run is **pinned**: a preview asked while it waits is dropped, never the final).
  The key process may answer in arrival order as the plan says.
- **`closed()` comes only from the dialog's own close** (Close, Escape, Key landing, another tab in front), never from
  a restart (Refit, another source, Re-key on or off, a turn of the picture): an idle timer that starts at a restart
  would kill the engine under the open panel.
- **The features can go while the panel is open** (the idle timer, `freeHelpers` before a local ComfyUI run kills the
  process, a crash and restart): the run must then reject with `KEY_FEATURES_GONE`, and the renderer prepares again
  from the picture it kept (`host.keyReprepare`, `KeySession.reprepare`; a Re-key that read nothing reads now) and
  sends the run once more. Any other error is shown as it is.
- **A Cancel lets the document go at once** (`providerPending`, `_keyBusy`, the title row): host.keyScreen races every
  engine await against it, calls `cancel()` and ignores the late answer. I3's `cancel()` should stop the run (or kill
  the process) so the next key does not wait behind it.
- `editor.helperUsed = true` is set on every prepare, so `freeHelpers` (main's `helpers:free`) must kill the key
  process too (I3's `index.js free()`).

## What I6 joins

`renderer/editor/keyworker.js` answers `{ op: "matte" | "rows" | "drop" }`; `keying.RowsClient` is the window's side
(in the thread where no worker starts). `host.landKey` calls `rows(mid, map, lw, y0, 256)` per band, `map` from
`keying.sampleMap(mbox, box, content)` (u = X·sx + u0 over the layer's pixels). The refine is a new op there (the band's
full-resolution picture rows with a halo, read by the caller through `readBox`) whose `a` replaces the bilinear one;
the foreground stays bilinear. The status line says "refined" through `keying.statusLine({ refined: true })`. For a
Re-key the refine's guide rows are the picture keyRead read: the source layer (`keyRekeyRead`) or the picture under the
key (`upTo`), never the visible composite.

## What I2 joins

- **The first-run block's Download** calls `host.keyEngine.download()` when it is a function (I2: the pre-download
  terms dialog of §3.3 with `keying.termsParagraph`, then the set's download); without it the button opens Settings at
  *Helpers (in-app models)* (`openHelpersSettings` in keydialog.js, the way the menu's Settings entries scroll to their
  section). The block itself (the paragraph, the links to the licence and corridorkey.com) is in the dialog already.
- **The Settings › Helpers row "Key screen: working size"** (§4.7 point 2) does not exist yet: it belongs to the
  Helpers section I2 builds (shell.js). It writes `settings.key.workingSize` through `host.setKeyValues({ workingSize })`
  (the renderer keeps a copy, `host.keyStored`) and offers `status().workingSizes`. `key_screen`'s description names
  `settings.key.workingSize` and `status.key.working_size`, not the row.

## Where this differs from the plan's words (decided while building)

- **The Key of the visible picture lands at the top of the stack**, under its top run of filter layers (as the Realism
  Pass lands), with the grey layer directly under it, not directly above the base: the visible picture holds every
  layer, so a key placed above the base alone would sit under the layers it was made from. With the base alone both
  read the same.
- **The foreground is sampled in the worker** with the alpha (bilinear in floats, `keying.bilinearRows`), not drawn
  through band canvases: the bytes are exact at a scale of 1 and the window does no scaling.
- **A layer as the source** is read on the screen colour where it is transparent (#00b140, #0047bb for Blue). **On
  Auto its screen is told from its own opaque pixels** (the border ring weighted by the layer's alpha) before the fill
  is chosen; a Screen change in the dialog prepares a layer source again (another fill is another picture).
- **Re-key reads what the key was made from** (`host.keyRekeyRead`): the source layer the record names (the key hid it,
  so the visible picture has no subject), the picture under the key (`upTo`) for a key of the picture; with the record
  it first asks `holds(<record hash key>)` and reads nothing when the engine still has the features (§4.5). After a
  restart (no record): the hidden pixel layer directly below the key when there is one, else the picture under it; the
  box line says which ("read from Subject (hidden)"). The record keeps the original source across Re-keys.
- **A turn, crop, extend, resize or straighten** (the host's "geometry" event) drops the records' box and hash
  (`keyWatchGeometry`): a later Re-key starts from the layer's bounds and reads again. The open dialog restarts on it.
- **The Key dialog is a panel, not a modal `<dialog>`** (`renderer/keydialog.js`, its own shadow root with the skin's
  tokens), so the canvas takes the brush while it is open; Escape inside it closes it, **another tab in front closes
  it** (its strokes would go to the other document).
- **Key reuses the matte the overlay shows** only when it is the newest asked for, nothing is read or waits, and the
  hint (its selection sig **and its trust**), the screen, the despill and the prepared picture are unchanged; a value
  changed with Preview off drops the matte shown. **Key reads the picture once more** (a few ms) and prepares it again
  when its hash differs from the session's (an edit or undo under the open panel).
- **On the CPU** (`status().provider === "cpu"` or `gpu: false`) the dialog has no Preview row and runs nothing before
  Key (§4.4, §4.8); Key runs once.
- **`key_screen` `hint: "mask"`**: a first key with the source layer's own mask as a soft hint (0.95 unless `trust`
  says otherwise); refused for the picture or a layer without a mask. `rekey` stays the key layer's own mask.
- **`key_screen` is grouped under "Prompt and generation"** in docs/COMMANDS.md (`tools/commands_doc.py` GROUPS), after
  `realism_pass`.

## The tests

- `node tools/keying_test.js` (Light, plain Node): the box plan at 1k / 4k / 15k (aspect growth, context, inside the
  picture, edge-only padding), a set's buckets narrowed to the working size, reflect-101, the screen from the ring (and
  weighted by a layer's alpha), `overColour`, the matte's box, the bilinear rows (exact at 1, within a level scaled, no
  band seam), the queue (coalescing, the pinned final), `isFeaturesGone`, the settings fill, the texts (box line with a
  layer's box and a Re-key's read, the terms paragraph).
- Gate `key` (`tools/key_test.py`, both backends, `--offline`), on a stub engine (`holds`, `cancel`, `FEATURES_GONE`,
  the prepared picture's first and centre pixels and its magenta count): refusals; the landing's bytes and mask
  (MASK_RGB), the trim, the grey layer, one undo; a layer source; a scaled selection; the restore; **rekey read** (held
  features read nothing; dropped features read the picture under the key and not the key's own magenta pixels); **rekey
  layer** (Auto on a blue-plate layer with transparent margins keys blue on a blue fill; Re-key held, then reading the
  hidden source, then after a restart the hidden layer below with the box line saying so; Screen Green refills); Re-key;
  **cancel** (the document free at once, the engine told, the late answer adds nothing); PSD / ORA; the dialog (values,
  a selection change, the dab coalescing, a stale ticket, Key lands the matte shown); dialog Re-key; **dialog follow**
  (real selection-brush strokes through the editor's own pointer handlers on an empty selection: every run during the
  stroke carries the painted hint and it grows; Refit does not call `closed()`; features gone are prepared again);
  **dialog values** (Trust with Preview off runs again at the new trust; the final run survives dabs and a selection
  change asked while it waits); **dialog geometry** (a turn re-plans the box, an edit under the panel is prepared again
  at Key, another tab closes the panel); dialog states (dormant, missing with the first-run block and Download, the CPU
  without preview); `key_screen` (preview, rekey, hint mask, status.key).

## Merge order and wiring

1. `ck-i2` (`electron/main/onnx/models.js`, the downloader) and `ck-ui` touch different files, except that both may
   touch `renderer/shell.js` (this branch: one line in `menuCommand`, `key-screen`; I2: the Helpers rows). Merge either
   first; the shell.js conflict, if any, is a one-line keep-both.
2. `ck-ui` before `ck-refine`: I6 adds its op to `renderer/editor/keyworker.js` (this branch's file) and its call in
   `host.landKey`; `renderer/editor/keymatte.js` is its own.
3. I3 (the key process) last: it fills `host.keyEngine` (or adds `helpers.keyPrepare`, `keyRun`, `keyHolds`,
   `keyCancel`, `keyFree`, `keyStatusCached` to the preload and main) with the contract above, and `download()` comes
   from I2's terms dialog.
4. After the merges: `npx eslint .`, `npx tsc --noEmit -p tsconfig.check.json`, `node tools/keying_test.js`,
   `python tools/commands_doc.py` (the count), gate `key` on both backends.

## Texts for the shared files

**CHANGELOG `## Unreleased`** (with the in-app route offered; §4.12 says which texts ship in which hosting case):

- Image › Key Green / Blue Screen...: CorridorKey 2.0 keys a green or blue screen inside Scumble. The matte follows
  the selection brush while the Key dialog is open; *Key* adds one layer "Key" with the subject's own colour and the
  matte as its layer mask, a grey layer under a key of the picture, the source layer hidden, one undo step. *Re-key*
  redoes a key from its painted mask. Agents: `key_screen`.

**README / docs/MCP.md**: the tool count +1 on what they say at the merge (118 / 98 core after LoRAs' LR4;
`grep -c '^### \`' docs/COMMANDS.md` is 118 on this branch).

**docs/TESTING.md** (the gate list): `key` (`tools/key_test.py`): the Key screen on a stubbed engine: the landing's
bytes and mask (MASK_RGB), the trim, the grey layer, the hidden source, one undo, the restore, Re-key (held features
read nothing; otherwise the source layer or the picture under the key, never the key's own pixels), Auto on a layer's
own pixels, a Cancel that frees the document at once, PSD / ORA; the Key dialog's loop (a selection change, real
selection-brush strokes on an empty selection, the dab coalescing, a stale ticket, Key lands the matte shown or runs
again after a value changed with Preview off, the final run never replaced, features gone prepared again, a turn of
the picture, an edit under the panel, another tab, the dormant, missing and CPU states); `key_screen`, its preview,
rekey and hint mask, `status.key`. Both backends. Plain Node: `node tools/keying_test.js`.

**docs/MANUAL.md, the chapter's UI paragraphs** (slug `key-screen`; the engine, download and licence paragraphs come
from I2 / I8):

> *Image › Key Green / Blue Screen...* opens a panel beside the canvas. It stays open while you work: paint the subject
> roughly with the selection brush or the quick mask (Q), and the matte follows on the canvas as you paint (a tint
> over what is kept, the rest dimmed; it is never part of the picture or an export). **Screen**: Auto reads the border
> of the box (of a layer, only its own pixels); when it is neither clearly green nor clearly blue it asks you to pick.
> **Hint**: the selection, or none (the model picks the subject itself). **Trust**: how much the hint is believed:
> Rough for a brush scribble, Automatic for a selection from *Select by text*, Clean for a precise one. **Despill**
> takes the screen's colour out of the edges. **Source**: the visible picture, or the active layer (a subject generated
> on flat green; where it is transparent it is read on the screen's colour). **Leave the base as it is** keeps the
> plate under the key instead of the grey layer. The box line says what goes: the selection's box grown by context and
> keyed at the working size, the layer's box, or the whole picture when nothing is selected; strokes outside the box do
> not grow it (*Refit the box* reads it again; turning or cropping the picture does it too). Switching to another tab
> closes the panel. On a machine where only the CPU runs the set there is no live preview: *Key* keys once.
>
> *Key* adds a layer **Key** directly above what you keyed, trimmed to the matte, its pixels the subject's own colour
> and its layer mask the matte (edit it with P / E, look at it with *Show alone*). A keyed layer is hidden in the same
> step; a key of the picture gets a mid-grey layer **Grey** under it, so the key shows at once: replace it with your
> background. One Ctrl+Z takes it all back. With a key layer active the panel offers **Re-key**: the layer's painted
> mask becomes the hint and the key is redone from what it was made from (the hidden source layer, or the picture under
> the key). The key's settings are kept until Scumble quits; after a restart, or after the picture was turned or
> cropped, Re-key starts from the layer's bounds and reads the hidden layer directly below the key when there is one,
> else the picture under it; the box line says which.
>
> Agents: `key_screen` (with `preview: true` the matte becomes the selection instead; `rekey: true` re-keys the active
> key layer; `hint: "mask"` uses the source layer's own mask as a soft hint). A selection an agent sets with
> `select_mask` is binary; a soft hint needs a layer mask (`set_mask`) and `hint: "mask"` or `rekey`.

**CLAUDE.md, item 49's block** (one line): "I4, I5, I7 built on the branch `ck-ui` on a stubbed engine (the landing,
the Key dialog's live loop, `key_screen`; reviewed, 11 findings fixed; `docs/ck2/ui_notes.md`); the key gate green on
both backends; the engine behind `host.keyEngine` is I3's (its contract in the notes: FEATURES_GONE, holds, cancel,
closed only from the dialog's close)."

## After the review (2026-11-06)

Fixed: Re-key read the visible composite and so keyed the background of a layer-sourced key (now `keyRekeyRead`, the
held features first); a Trust change reused the matte shown; the CPU ran a live preview; Key's final run could be
replaced by a preview; the first stroke on an empty selection sent no hint (the bounds are stale mid-stroke); Auto
filled a layer source green before telling its screen; a restart called `closed()` and the features could go under
the open panel; a stale plan after a turn, an edit or a tab switch; a Cancel held the document until the engine
answered; the set's buckets were not narrowed to the working size; the first-run block and Settings at Helpers were
missing. Taken: `hint: "mask"` for agents, the two vacuous gate steps made real (magenta key pixels, real dabs), "the
layer's box" in the box line.
