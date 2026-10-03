# ComfyUI in Scumble: the graph behind a recipe, in the app (item 35; the user, 2026-10-03)

**Status (2026-10-03):** planned from one reading of the code and the docs; nothing built. Five steps (V1-V5), one
per session (the user's rule). The user decides the open questions (§6) before V1.

The user's ask (2026-10-03): "ist es möglich eine art browser in scumble zu öffnen in dem dann comfyui läuft?", then,
to the answer that a plain browser is nice but the point is the connection to the recipes: "ja, genau darum geht es
... das ist erstmal das wichtigste update ... mache einen umsetzungsplan für comfyui in scumble", and "und auch die
option testen comfy.cloud in scumble".

The idea in one line: ComfyUI's own page runs in a view inside Scumble's window; a recipe opens there as its graph,
and the graph there comes back as a recipe. The same view can show Comfy Cloud, where a recipe can run once it no
longer needs the Inpaint Canvas node (V5).

## 1. What exists (read 2026-10-03)

- **The window** (`electron/main/main.js` `createWindow`): one `BrowserWindow`, preload `electron/preload.js`,
  `contextIsolation`, `sandbox`. Every `scumble://app` response makes it cross-origin isolated (`isolated()`: COOP
  same-origin, COEP require-corp), so an `<iframe>` of a ComfyUI server cannot load in the renderer. Electron is 44:
  `WebContentsView` (a second webContents laid over the window, `win.contentView.addChildView`) is the way; Electron
  advises against `<webview>`. `setWindowOpenHandler` sends links to the system browser; `will-navigate` keeps the
  window on its own origin.
- **The menu's accelerators** (`buildMenu`): Ctrl+S (save the document), Ctrl+W, Ctrl+T, Ctrl+O, Ctrl+R (reload the
  window), Ctrl+Tab, Ctrl+Shift+S / E / T / A / L, F1. They fire at window level, also while another webContents has
  the focus, so ComfyUI's own Ctrl+S, Ctrl+Z and Ctrl+Enter would reach Scumble instead.
- **The ComfyUI client** (`electron/main/comfy.js`): the server URL and the auth from `settings.comfy` (`url`, `auth`:
  none / basic / bearer / header, the secret in the key store as `COMFY_SECRET`), `authHeaders()`; its own websocket
  in main, whose events go to the renderer over IPC; `scumble://app/comfy/*` proxies HTTP only. ComfyUI's own page
  needs its own websocket, so the view loads the server's URL itself, not through the proxy. `--no-comfy` starts
  without a connection (the gates' `--offline`).
- **Recipes** (`electron/main/recipes.js`): a ComfyUI recipe stores the API-format `prompt`, the `canvas` node id,
  `result` ("node:slot"), `needs`, `settings` (`{ index, node, input, label, spec }`: that input takes the canvas
  node's `setting_<index>`, output `FIXED_OUTPUTS + index - 1` = 12 + index); **no layout** (no UI graph is kept).
  `importFile` reads a Scumble recipe, a UI workflow (`fromWorkflow`, needs `/object_info` for the widget order;
  subgraphs, primitives, reroutes and bypass resolved) or an API prompt (`fromPrompt`: exactly one `InpaintCanvas`,
  `result_local` / `result` read as the result, the canvas node's inputs emptied, every input wired from a
  `setting_n` replaced by its default and listed in `settings`). User recipes live in `<userData>/recipes/` and shadow
  a shipped one of the same id; an import never takes `flux2_klein_local` (renamed `_imported`).
- **The Inpaint Canvas node** (node repo `nodes.py`): 13 fixed outputs `crop_image` (a batch: the filled crop, the
  untouched crop with Original, then each shown reference fitted to the crop), `crop_mask`, `image`, `mask`,
  `stitch_info`, `crop_width`, `crop_height`, `prompt`, `control_image`, `denoise`, `seed`, `mode`, `negative`, then
  `setting_1..n`; the node crops, and its result input stitches the answer back.
- **The user's ComfyUI frontend** is `comfyui_frontend_package` 1.53.10; its scripts hold `window.app` with
  `loadApiJson`, `loadGraphData` and `graphToPrompt`, and `window.comfyAPI`.
- **Comfy Cloud** (`electron/main/providers/comfycloud.js`, docs.comfy.org "Cloud API"): `https://cloud.comfy.org`,
  the ComfyUI API with an `X-API-Key` header (`POST /api/upload/image`, `POST /api/prompt`, `GET
  /api/job/<id>/status`, `GET /api/history/<id>`, `GET /api/view` answering 302 to a signed URL, `GET
  /api/object_info`, 401 without a key); API access needs a paid plan (the docs: Creator or Pro). **Users cannot
  install custom nodes there** (Comfy's support pages: preinstalled nodes only, requests possible), and Inpaint
  Canvas is not among them, so today's ComfyUI recipes cannot run on the cloud; `comfycloud.js` builds small graphs
  of core nodes and one Partner Node instead (LoadImage crop / references / mask -> node -> SaveImage), and Scumble
  crops and stitches itself, as for every provider.

## 2. The design

### 2.1 The view (V1)

- `electron/main/comfyview.js`: one `WebContentsView`, made when it is first opened and destroyed when it closes (the
  ComfyUI page holds hundreds of MB with a large graph). `webPreferences`: `partition: "persist:comfyui"` (its own
  cookies and cache; a Comfy Cloud login stays), `sandbox`, `contextIsolation`, `nodeIntegration: false`, **no
  preload**. The page runs the JavaScript of every custom node pack on that server: it must never reach
  `window.scumble`, IPC, `scumble://` or a key.
- **Where it shows:** a *ComfyUI* entry in the tab bar (`renderer/shell.js` `renderTabs`), not a document; while it is
  active the editor area holds an empty placeholder whose rectangle the renderer sends to main (`comfyview:bounds` on
  activation, resize, the side panel's drag, the canvas-only view), and main calls `setBounds`. Another tab hides the
  view (`setVisible(false)`), its page keeps running.
- **Z-order trap:** a child view is drawn above the window's page, so a Scumble dialog, menu or popup opened while the
  view is up would sit under it. The renderer hides the view while any `<dialog>` is open, a menu or picker is up, or
  the shell's own overlays show (one observer on `dialog[open]` plus the few popups), and shows it again after.
- **Shortcuts:** `view.webContents.setIgnoreMenuShortcuts(true)` gives ComfyUI its own Ctrl+S, Ctrl+Z, Ctrl+Enter;
  `before-input-event` on the view keeps the few that must stay Scumble's (Ctrl+Tab and Ctrl+Shift+Tab to switch tabs,
  Ctrl+W to close the ComfyUI tab, F1).
- **The target:** the connected server (`settings.comfy.url`), or Comfy Cloud (V4). Auth for a remote server: the
  same headers `comfy.js` sends, set by `session.webRequest.onBeforeSendHeaders` for that origin only (whether it
  covers the websocket handshake is checked in V1; a basic-auth 401 can fall back to the `login` event).
- **Navigation:** links to other origins open in the system browser (`setWindowOpenHandler`); `will-navigate` stays
  on the target origin (and, for Cloud, its login pages, V4). A crashed view (`render-process-gone`) is recreated on
  the next open; it never touches the window's crash guard.
- Not shown headless, in agent mode or in a test instance unless the test opens it; `--no-comfy` keeps it closed
  unless a test gives it a stub URL.

### 2.2 The bridge to the page (V2, V3)

Main talks to the page with `view.webContents.executeJavaScript(...)` in the page's own world (no preload needed).
Everything that comes back is **untrusted data**: a size cap (20 MB), a shape check (`looksLikePrompt`, a workflow
with `nodes` and `links`), never evaluated. Three calls:

- `ready()`: `window.app && app.graph` (polled after load; a clear error when the frontend has none of the names:
  "This ComfyUI page offers no way to load a graph (frontend <version>)").
- `load(recipe)`: `app.loadGraphData(recipe.workflow)` when the recipe holds a layout, else `app.loadApiJson(prompt,
  name)` (ComfyUI lays the nodes out itself).
- `read()`: `await app.graphToPrompt()` -> `{ workflow, output }` (the UI graph and the API prompt).

### 2.3 Recipe <-> graph

- **To the graph** (`recipes.toPrompt(recipe)`, the inverse of `fromPrompt`): the canvas node's `result_local` (mode
  local) or `result` input wired back to `recipe.result`, each setting's input wired to `[canvas, 12 + index]`, the
  rest as stored. Test: `fromPrompt(toPrompt(r))` gives `r.prompt` and `r.settings` back for every shipped ComfyUI
  recipe.
- **The layout:** recipes gain an optional `workflow` (the UI graph). A recipe taken from the view keeps it, so it
  opens next time as it was laid out; a shipped recipe opens laid out by ComfyUI the first time.
- **From the graph** ("Use as recipe" / "Save to recipe"): `read()`, then `fromPrompt(output, objectInfo)` plus
  `workflow`, then a small dialog: the name, a new recipe or the recipe it was opened from. A user recipe is updated in
  place; a shipped one is never overwritten (a user copy `<id>_edited` that shadows nothing). The recipe is selected
  in the tab afterwards. Its `needs` are checked against `/object_info` as at any import.

### 2.4 Comfy Cloud (V4, V5)

- **V4, the view on Comfy Cloud:** the target switch in the ComfyUI tab: *My ComfyUI* / *Comfy Cloud*. The login
  happens in the view and stays in its partition. Google may refuse a sign-in from an embedded browser; measured in V4,
  and the note names the logins that work (email, GitHub). *Edit recipe* on the cloud refuses a recipe that holds the
  Inpaint Canvas node with a note ("Comfy Cloud has no Inpaint Canvas node; this recipe runs on your ComfyUI, or as a
  cloud recipe after V5"). *Use as recipe* works for a cloud graph once V5 exists.
- **V5, recipes without the node (the "cloud form"):** a recipe whose graph takes its pictures through core nodes and
  answers through `SaveImage`, so Scumble crops and stitches itself (`renderer/editor/stitch.js`, as for every
  provider), and the run goes through `comfycloud.js`'s calls (upload, prompt, job status, history, view). A
  ComfyUI recipe is turned into that form by `detach(recipe)`:
  - `crop_image` -> `LoadImage` per picture (the filled crop, the Original where the recipe sends it, each reference),
    joined by `ImageBatch` in the node's order, so `ImageFromBatch` consumers keep their indices;
  - `crop_mask` -> `LoadImageMask` (or `LoadImage` + `ImageToMask`);
  - `crop_width`, `crop_height`, `prompt`, `negative`, `seed`, `denoise`, `mode` and every `setting_n` -> the values,
    written into the consuming inputs at queue time (the Settings rows already write their values into the nodes);
  - `image`, `mask` (full size), `stitch_info`, `control_image` -> refused in the first cut, with the output named;
  - the result source -> a `SaveImage` the run reads back.
  The crop's padding, target size, feather and multiple come from the canvas node's inputs in the recipe, mapped to
  the stitch's options. Before a run, every node of the detached graph is checked against the cloud's `/object_info`
  (cached per key) and a missing one stops the run by name. A graph taken from the cloud view as a recipe is already
  in this form when it uses `LoadImage` nodes marked as crop / mask / reference (the marking, by node title, is part of
  V5).

## 3. Steps (one session each)

- **V1, the view:** `comfyview.js`, the tab, the bounds, the partition, the auth headers, the navigation rules, the
  shortcuts, the z-order rule, create and destroy. Tests (Normal): a gate step against a stub HTTP page started by the
  test (not the user's ComfyUI): the view opens, sits in the placeholder, hides under a dialog, gets no `window.scumble`,
  Ctrl+S goes to the page; one look in the app against the user's ComfyUI on the user's word (opening the page queues
  nothing).
- **V2, a recipe as a graph:** `toPrompt`, `load()`, `ready()`, *Edit in ComfyUI* on the recipe (the Generate tab's
  recipe picker and *Settings > Recipes*). Tests: plain-Node `fromPrompt(toPrompt(r))` over every shipped ComfyUI
  recipe; a gate step with a stub page whose fake `window.app` records what it was given.
- **V3, a graph as a recipe:** `read()`, the dialog, the update in place / the copy, the `workflow` field kept,
  selection afterwards. Tests: plain-Node (a recorded `graphToPrompt` answer of the user's frontend as a fixture ->
  recipe), the stub-page gate step; one round trip on the user's ComfyUI (open a recipe, move a node, save back, run it
  once) on the user's word.
- **V4, Comfy Cloud in the view:** the target switch, the login check, the refusal note. One look with the user's login.
- **V5, cloud recipes:** `detach`, the run path on `comfycloud.js`'s calls, the `/object_info` check, the marking of
  `LoadImage` nodes. Tests: plain-Node `detach` on every shipped ComfyUI recipe (which detach, which refuse and why); a
  loopback run; one live run on Comfy Cloud with the user's key (credits). Possibly two sessions.

## 4. Traps known before the first line

- The menu's accelerators beat the page (§1): without `setIgnoreMenuShortcuts`, Ctrl+S in ComfyUI saves the Scumble
  document and Ctrl+R reloads Scumble's window.
- The view covers Scumble's own dialogs (§2.1).
- The user's ComfyUI is a production machine: the view is one more client of it; nothing in a test queues there, and a
  run the user starts in the view is theirs.
- The Inpaint Canvas node's own editor loads inside the view as well (it is a ComfyUI extension); harmless, but heavy.
- `window.app` is the frontend's older surface; newer frontends move names under `window.comfyAPI`. `ready()` names
  the frontend version when a call is missing, rather than failing silently.
- `fromPrompt` empties the canvas node's inputs (padding, target size, feather, multiple): `toPrompt` restores what the
  recipe file holds, and V3 keeps what the user set on the node.

## 5. Size (a guess from the reading)

V1 one session, V2 one, V3 one, V4 half, V5 one or two.

## 6. Open questions for the user

- The place: a *ComfyUI* tab next to the documents (proposed), a side panel, or a window of its own?
- Comfy Cloud: does the user's plan have API access (V5 needs it; the view of V4 needs only a login)?
- *Save to recipe* on a user recipe: update in place (proposed), or always a new copy?
- The order: V1-V3 first (the user's own ComfyUI), or Comfy Cloud earlier because of the Comfy Dev Platform Challenge
  (Oct 5-19; Comfy's exact answer and its conditions are still to be pasted, memory `comfy-dev-challenge`)?
