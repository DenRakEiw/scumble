# ComfyUI in Scumble: the graph behind a recipe, in the app (item 35; the user, 2026-10-03)

**Status (2026-10-03):** planned from one reading of the code and the docs; nothing built. Five steps (V1-V5), one
per session (the user's rule), **released together as one update** after V5. The user answered §6 the same day: a
window of its own, Comfy Cloud API access yes, *Save to recipe* overwrites, all in one update; then the *ComfyUI*
button after *Help* and *Assistant*, and **Scumble keeps working without any ComfyUI installed** (§2.5, a rule for
every step).

The user's ask (2026-10-03): "ist es möglich eine art browser in scumble zu öffnen in dem dann comfyui läuft?", then,
to the answer that a plain browser is nice but the point is the connection to the recipes: "ja, genau darum geht es
... das ist erstmal das wichtigste update ... mache einen umsetzungsplan für comfyui in scumble", and "und auch die
option testen comfy.cloud in scumble".

The idea in one line: ComfyUI's own page runs in a window of Scumble's; a recipe opens there as its graph,
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
  needs its own websocket, so the ComfyUI window loads the server's URL itself, not through the proxy. `--no-comfy` starts
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

### 2.1 The ComfyUI window (V1)

The user chose a window of its own (2026-10-03: "Eigenes fenster"). It can sit on a second screen beside the editor,
and it avoids two traps a tab in the main window would have had: a child view drawn over the window's page covers
Scumble's own dialogs and popups, and its rectangle has to follow every layout change.

- `electron/main/comfyview.js`: one `BaseWindow` (title "ComfyUI · <server>" or "Comfy Cloud"), made when it is first
  opened and destroyed when it closes (the ComfyUI page holds hundreds of MB with a large graph); its size and place are
  kept in `settings.comfyView.bounds` like the main window's. Two views in it:
  - **the bar** (a strip about 36 px high, `scumble://app/comfybar.html`, the app's skin, a preload of its own with
    a few `comfyview:*` calls; main answers those only from this webContents): the target (*My ComfyUI* / *Comfy
    Cloud*, a plain `<select>`, whose popup is the OS's and is not clipped), the recipe the window holds ("Editing:
    FLUX.2 Klein (ComfyUI)" or "No recipe"), *Save to recipe*, *Save as new recipe*, *Reload*;
  - **the page** (a `WebContentsView` under the bar): `partition: "persist:comfyui"` (its own cookies and cache; a
    Comfy Cloud login stays), `sandbox`, `contextIsolation`, `nodeIntegration: false`, **no preload**. The page runs
    the JavaScript of every custom node pack on that server: it must never reach `window.scumble`, IPC, `scumble://`
    or a key.
- **Shortcuts:** the window has no menu on Windows and Linux (`setMenu(null)`), so Scumble's accelerators do not fire
  there and ComfyUI keeps its own Ctrl+S, Ctrl+Z, Ctrl+Enter; on macOS (B3) the menu is global, and
  `setIgnoreMenuShortcuts(true)` on the page does the same.
- **Where it opens** (the user's question, 2026-10-03: "wo passt der button zum öffnen?"; the title-row button decided
  the same day, the rest proposed):
  - **a *ComfyUI* button in the title row**, after *Help* and *Assistant* (`renderer/index.html` `#shell-bar`): the
    three buttons that open something beside the picture. It opens the window on the target used last, or brings it to
    the front; with no target at all it opens the window's own start page (§2.5). Its title names the target and the
    shortcut;
  - **a small *Edit in ComfyUI* button right of the title row's *Recipe* select** (`#shell-recipe`), shown only while
    the selected recipe is a ComfyUI recipe: it opens the window with that recipe's graph (V2);
  - the same two in the *View* menu, with a shortcut picked in V1 (Ctrl+U is Upsample), and *Edit in ComfyUI* per
    recipe in *Settings > Recipes*.
- **The target:** the connected server (`settings.comfy.url`), or Comfy Cloud (V4). Auth for a remote server: the
  same headers `comfy.js` sends, set by `session.webRequest.onBeforeSendHeaders` for that origin only (whether it
  covers the websocket handshake is checked in V1; a basic-auth 401 can fall back to the `login` event).
- **Navigation:** links to other origins open in the system browser (`setWindowOpenHandler`); `will-navigate` stays
  on the target origin (and, for Cloud, its login pages, V4). A crashed page (`render-process-gone`) is loaded again
  by *Reload*; it never touches the main window's crash guard. Closing the main window closes this one; this one's
  close never asks anything (an unsaved graph is ComfyUI's to keep: the page autosaves its workflow itself).
- Not opened headless, in agent mode or in a test instance unless the test opens it; `--no-comfy` keeps it closed
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
- **The layout:** recipes gain an optional `workflow` (the UI graph). A recipe taken from the window keeps it, so it
  opens next time as it was laid out; a shipped recipe opens laid out by ComfyUI the first time.
- **From the graph** (the bar's *Save to recipe* and *Save as new recipe*): `read()`, then `fromPrompt(output,
  objectInfo)` plus `workflow`. *Save to recipe* **overwrites** the recipe the window was opened with (the user,
  2026-10-03: "überschreiben ist ok"), without a dialog: a user recipe in place; a shipped recipe as a user recipe of
  the same id, which then stands in for the shipped one (that is how `list()` already treats ids), and the status line
  says so and that deleting it under *Settings > Recipes* brings the shipped one back (an app update of that recipe
  stays hidden behind the copy). *Save as new recipe* asks for a name (the app's own dialog) and makes a new user
  recipe. Either way the recipe is selected in the active tab afterwards, and its `needs` are checked against
  `/object_info` as at any import.

### 2.4 Comfy Cloud (V4, V5)

- **V4, the window on Comfy Cloud:** the bar's target switch: *My ComfyUI* / *Comfy Cloud*. The login happens in the
  page and stays in its partition (the user has a Comfy Cloud plan with API access, 2026-10-03, so V5 can run there). Google may refuse a sign-in from an embedded browser; measured in V4,
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
  (cached per key) and a missing one stops the run by name. A graph taken from the window on Comfy Cloud as a recipe is already
  in this form when it uses `LoadImage` nodes marked as crop / mask / reference (the marking, by node title, is part of
  V5).

### 2.5 Without any ComfyUI (a rule for every step)

The user, 2026-10-03: "wichtig scumble muss auch funktionieren weiterhin wenn kein lokales comfyui installiert ist".
Scumble works today without a ComfyUI (the API providers, the in-app helpers, the editor, documents and export), and
none of V1-V5 may change that:

- **Nothing at start:** the window, its partition and its page are made only when the user opens it; no request to a
  ComfyUI, to Comfy Cloud or to `/object_info` happens because the feature exists. A start without a ComfyUI shows no
  new note, error or dialog.
- **The window's start page:** when there is no target to show (no ComfyUI URL set, the server does not answer, or
  Comfy Cloud chosen without a login yet), the bar's own page fills the window instead of the remote page: "No ComfyUI
  to show." with *Connect a ComfyUI* (opens *Settings > ComfyUI*) and *Use Comfy Cloud* (switches the target, V4). An
  unreachable server says so with its URL; nothing retries in a loop.
- **The buttons stay usable:** the *ComfyUI* button always opens the window (the start page is the way to Comfy
  Cloud); *Edit in ComfyUI* shows only for ComfyUI recipes, which need a ComfyUI anyway, and without one it opens the
  start page with that recipe named.
- **No new dependency of other paths:** provider recipes, Generate new, upscales and the helpers never wait on the
  window or on a ComfyUI; V3's `needs` check reads the `/object_info` of the target the graph came from (the user's
  server, or Comfy Cloud with its key in V5), never a server that is not there; V5's cloud recipes run through Comfy
  Cloud alone, with no local ComfyUI.
- **No install path:** the user's ComfyUI may sit anywhere, or on another machine (RunPod), so nothing in V1-V5 reads
  a ComfyUI folder: the window and every check go through the URL (`settings.comfy.url`). Whether a node exists comes
  from `/object_info` (as the recipe check does today), the frontend's version from the page itself, never from a file.
  The facts of §1 about this machine (frontend 1.53.10, the RTX node, the portable install under `F:\Comfyui`) are this
  machine's only. The only folder Scumble ever reads is the `models/` folder a user links under *Settings > Helpers*,
  which stays as it is. A local ComfyUI is not always on 8188 (the desktop build of ComfyUI has its own default port,
  to be checked in V1): the start page names the URL it tried and leads to the setting.
- **Tested in every step:** the gates run `--offline` (`--no-comfy`) already; each step's gate step includes the
  window opened with no target (the start page, no request made), and the existing offline gates stay green.

## 3. Steps (one session each)

- **V1, the window:** `comfyview.js`, the bar (`comfybar.html` and its preload, the target and *Reload*; the save
  buttons disabled until V3), the page's partition, the auth headers, the navigation rules, no menu, its bounds kept,
  create and destroy, the *ComfyUI* button and the *View* menu entry, the start page without a target (§2.5). Tests
  (Normal): a gate step against a stub HTTP page started by the test (not the user's ComfyUI), and one with no target
  at all (the start page, no request made): the window opens and comes to the front on a second click, the
  page gets no `window.scumble`, Ctrl+S reaches the page and saves no document, the bar's calls are refused from the
  page, the window closes with the main window; one look in the app against the user's ComfyUI on the user's word
  (opening the page queues nothing).
- **V2, a recipe as a graph:** `toPrompt`, `load()`, `ready()`, *Edit in ComfyUI* (the button beside the title row's
  recipe select, the *View* menu, *Settings > Recipes*), the bar's "Editing: <recipe>". Tests: plain-Node `fromPrompt(toPrompt(r))` over every shipped ComfyUI
  recipe; a gate step with a stub page whose fake `window.app` records what it was given.
- **V3, a graph as a recipe:** `read()`, *Save to recipe* (overwrite; a shipped recipe as a user recipe of its id) and
  *Save as new recipe* (the name dialog), the `workflow` field kept, the selection afterwards. Tests: plain-Node (a recorded `graphToPrompt` answer of the user's frontend as a fixture ->
  recipe), the stub-page gate step; one round trip on the user's ComfyUI (open a recipe, move a node, save back, run it
  once) on the user's word.
- **V4, Comfy Cloud in the window:** the target switch, the login check, the refusal note. One look with the user's
  login.
- **V5, cloud recipes:** `detach`, the run path on `comfycloud.js`'s calls, the `/object_info` check, the marking of
  `LoadImage` nodes. Tests: plain-Node `detach` on every shipped ComfyUI recipe (which detach, which refuse and why); a
  loopback run; one live run on Comfy Cloud with the user's key (credits). Possibly two sessions.

## 4. Traps known before the first line

- The menu's accelerators beat a page (§1): in a window with Scumble's menu, Ctrl+S in ComfyUI would save the Scumble
  document and Ctrl+R reload the window. The ComfyUI window has no menu (and `setIgnoreMenuShortcuts` on macOS).
- A view laid over the main window would have covered Scumble's own dialogs: one reason for the window of its own.
- The bar's preload is the only way into main from the ComfyUI window: its `comfyview:*` handlers check the sender is
  the bar's webContents, and the page's webContents has no preload at all.
- The user's ComfyUI is a production machine: the window is one more client of it; nothing in a test queues there, and
  a run the user starts in the window is theirs.
- The Inpaint Canvas node's own editor loads inside the page as well (it is a ComfyUI extension); harmless, but heavy.
- `window.app` is the frontend's older surface; newer frontends move names under `window.comfyAPI`. `ready()` names
  the frontend version when a call is missing, rather than failing silently.
- `fromPrompt` empties the canvas node's inputs (padding, target size, feather, multiple): `toPrompt` restores what the
  recipe file holds, and V3 keeps what the user set on the node.

## 5. Size (a guess from the reading)

V1 one session, V2 one, V3 one, V4 half, V5 one or two.

## 6. The user's answers (2026-10-03) and what is still open

- The place: **a window of its own** ("Eigenes fenster"), opened by **a *ComfyUI* button after *Help* and
  *Assistant*** (decided the same day); the *Edit in ComfyUI* button and the menu entries of §2.1 are proposed.
- **Scumble works without any ComfyUI installed** (the user, the same day): §2.5, a rule for every step.
- Comfy Cloud: **the user's plan has API access** ("ja, habe api zugang"), so V5 can run live.
- *Save to recipe*: **overwrites** ("überschreiben ist ok"), §2.3.
- The order: **one update with all five steps** ("ist egal, soll alles in einem update sein"); V1-V5 in order, the
  release after V5. Still to paste: Comfy's exact answer about the Comfy Dev Platform Challenge (Oct 5-19, memory
  `comfy-dev-challenge`), in case its rules ask for work inside those dates.
