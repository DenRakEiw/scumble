# CorridorKey 2.0: the UI half (I4, I5, I7) on the branch `ck-ui`, notes for the integration

Built 2026-11-06 on a stubbed engine (`host.keyEngine`), from `docs/PLAN_CORRIDORKEY.md` §4.4-4.8. Nothing here ran a
real model. The text below is for the shared files (MANUAL, CHANGELOG, TESTING, README, MCP.md, CLAUDE.md), which this
branch did not touch.

## The interface I3 fills in

`host.keyEngine` (renderer/editor/host.js) is one object; the gate replaces it whole. Until I3 its calls answer
`keying.TEXTS.notInstalled` ("Key screen: the CorridorKey 2.0 engine is not part of this build yet.").

| member | request | answer |
|---|---|---|
| `status()` (sync, cached) | | `{ installed, offered, present, provider, gpu, cpuSeconds, error, workingSizes, buckets? }` |
| `prepare(req)` | `{ key, image, bucket: { w, h }, content: [0, 0, cw, ch] }` | `{ provider, ms, cached }` |
| `run(req)` | `{ key, hint, quality, despill, screen, ticket }` | `{ alpha, fg, ms, provider, ticket }` |
| `free()` | | the process gone |
| `closed()` | | the dialog closed: start the 60 s idle timer |

- `key` is `<doc id>:<SHA-1 of the image bytes, 20 hex>:<w>x<h>` (the features' cache key; a mask stroke on the key
  layer keeps it).
- `image` is RGBA **exactly bucket-sized and already padded**: the picture sits at the top left (`content`), the rest is
  reflect-101 of it (`keying.padRect`). **A change against the plan's §4.4**, where `keycolor.js` pads: here the renderer
  pads, so keycolor.js must not pad again when the image is bucket-sized (and the answer is cropped by `content` in
  the renderer). The pad goes only where the picture's edge leaves the box short of the bucket's aspect.
- `hint`: `Uint8Array` at the bucket (255 = subject), padded the same way, or `null` with `quality: -1`. `quality` is
  0.5 / 0.75 / 0.95 (the mask of a Re-key is 0.95).
- `screen` is always `"green"` or `"blue"` (Auto is resolved in the renderer from the border ring,
  `keying.screenFromRing`; a ring that is neither asks the user).
- `alpha`: `Float32Array` (0..1) or `Uint16Array` (0..65535) at the bucket; `fg`: `Uint8Array` RGB, sRGB, despilled.
- The wrappers: `keyHelper(name, req)` in host.js calls `host.helperCall("keyPrepare" | "keyRun", req)` once
  `window.scumble.helpers.keyPrepare` exists; `status()` reads `window.scumble.helpers.keyStatusCached()` if the
  preload offers it. I3 either adds those to the preload or replaces the bodies of `host.keyEngine`.
- The coalescing lives in the renderer, not in I3: `keying.KeyQueue` (one in flight, one pending, the newest replacing
  the pending one, tickets). The key process may answer in arrival order as the plan says.
- `editor.helperUsed = true` is set on every prepare, so `freeHelpers` (main's `helpers:free`) must kill the key
  process too (I3's `index.js free()`).
- `keyStatusCached().workingSizes` narrows the working sizes the setting may pick (`host.keyWorkingSize`); `buckets`
  ([{ w, h }]) replaces `keying.bucketsFor(long)` (the long side, the other side every multiple of 128 from half of it).

## What I6 joins

`renderer/editor/keyworker.js` answers `{ op: "matte" | "rows" | "drop" }`; `keying.RowsClient` is the window's side
(in the thread where no worker starts). `host.landKey` calls `rows(mid, map, lw, y0, 256)` per band, `map` from
`keying.sampleMap(mbox, box, content)` (u = X·sx + u0 over the layer's pixels). The refine is a new op there (the band's
full-resolution picture rows with a halo, read by the caller through `readBox`) whose `a` replaces the bilinear one;
the foreground stays bilinear. The status line says "refined" through `keying.statusLine({ refined: true })`.

## Where this differs from the plan's words (decided while building)

- **The Key of the visible picture lands at the top of the stack**, under its top run of filter layers (as the Realism
  Pass lands), with the grey layer directly under it, not directly above the base: the visible picture holds every
  layer, so a key placed above the base alone would sit under the layers it was made from. With the base alone both
  read the same.
- **The foreground is sampled in the worker** with the alpha (bilinear in floats, `keying.bilinearRows`), not drawn
  through band canvases: the bytes are exact at a scale of 1 and the window does no scaling.
- **A layer as the source** is read on the screen colour where it is transparent (#00b140, #0047bb for Blue).
- **The Key dialog is a panel, not a modal `<dialog>`** (`renderer/keydialog.js`, its own shadow root with the skin's
  tokens), so the canvas takes the brush while it is open; Escape inside it closes it.
- **Key reuses the matte the overlay shows** when it is the newest asked for and the hint, screen and despill are
  unchanged (no second run); otherwise it runs once more through the same queue.
- **`key_screen` is grouped under "Prompt and generation"** in docs/COMMANDS.md (`tools/commands_doc.py` GROUPS), after
  `realism_pass`.

## Texts for the shared files

**CHANGELOG `## Unreleased`** (with the in-app route offered; §4.12 says which texts ship in which hosting case):

- Image › Key Green / Blue Screen...: CorridorKey 2.0 keys a green or blue screen inside Scumble. The matte follows
  the selection brush while the Key dialog is open; *Key* adds one layer "Key" with the subject's own colour and the
  matte as its layer mask, a grey layer under a key of the picture, the source layer hidden, one undo step. *Re-key*
  redoes a key from its painted mask. Agents: `key_screen`.

**README / docs/MCP.md**: the tool count +1 on what they say at the merge (118 / 98 core after LoRAs' LR4;
`grep -c '^### \`' docs/COMMANDS.md` is 118 on this branch).

**docs/TESTING.md** (the gate list): `key` (`tools/key_test.py`): the Key screen on a stubbed engine: the landing's
bytes and mask (MASK_RGB), the trim, the grey layer, the hidden source, one undo, the restore, Re-key through `upTo`,
a cancel, PSD / ORA; the Key dialog's loop (a selection change, a dab burst: one run in flight and one pending, a stale
ticket, Key lands the matte shown, Re-key at the stroke's end, the dormant and missing states); `key_screen`, its
preview and rekey, `status.key`. Both backends. Plain Node: `node tools/keying_test.js`.

**docs/MANUAL.md, the chapter's UI paragraphs** (slug `key-screen`; the engine, download and licence paragraphs come
from I2 / I8):

> *Image › Key Green / Blue Screen...* opens a panel beside the canvas. It stays open while you work: paint the subject
> roughly with the selection brush or the quick mask (Q), and the matte follows on the canvas as you paint (a tint
> over what is kept, the rest dimmed; it is never part of the picture or an export). **Screen**: Auto reads the border
> of the box; when it is neither clearly green nor clearly blue it asks you to pick. **Hint**: the selection, or none
> (the model picks the subject itself). **Trust**: how much the hint is believed: Rough for a brush scribble, Automatic
> for a selection from *Select by text*, Clean for a precise one. **Despill** takes the screen's colour out of the
> edges. **Source**: the visible picture, or the active layer (a subject generated on flat green). **Leave the base as
> it is** keeps the plate under the key instead of the grey layer. The box line says what goes: the selection's box
> grown by context and keyed at the working size, or the whole picture when nothing is selected; strokes outside the
> box do not grow it (*Refit the box* reads it again).
>
> *Key* adds a layer **Key** directly above what you keyed, trimmed to the matte, its pixels the subject's own colour
> and its layer mask the matte (edit it with P / E, look at it with *Show alone*). A keyed layer is hidden in the same
> step; a key of the picture gets a mid-grey layer **Grey** under it, so the key shows at once: replace it with your
> background. One Ctrl+Z takes it all back. With a key layer active the panel offers **Re-key**: the layer's painted
> mask becomes the hint and the key is redone from the picture under it. The key's settings are kept until Scumble
> quits; after a restart Re-key starts from the layer's bounds and the box line says so.
>
> Agents: `key_screen` (with `preview: true` the matte becomes the selection instead; `rekey: true` re-keys the active
> key layer). A selection an agent sets with `select_mask` is binary; a soft hint needs a layer mask and `rekey`.

**CLAUDE.md, item 49's block** (one line): "I4, I5, I7 built on the branch `ck-ui` on a stubbed engine (the landing,
the Key dialog's live loop, `key_screen`; `docs/ck2/ui_notes.md`); the key gate green on both backends; the engine
behind `host.keyEngine` is I3's."
