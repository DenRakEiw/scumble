# ComfyUI in Scumble: the graph behind a recipe, in the app (item 35; the user, 2026-10-03)

**Status (2026-10-03, afternoon):** **V1 to V4 built** (the window, the bar, the start page, the auth, the *ComfyUI*
button; a recipe opened as its graph; the graph saved as a recipe; Comfy Cloud in the window: "V1 ... V4 as built"
under §3), V5 in parts: **V5a and V5b built** (`recipes.detach`, the run in `comfycloud.js`), V5c (how a user gets a
cloud recipe) next;
the look with the user's Comfy Cloud login is open. Five steps (V1-V5), one
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
- **The target:** the connected server (`settings.comfy.url`), or Comfy Cloud (V4). *My ComfyUI* is whatever that
  URL names: a local install, a box in the network, or **a RunPod pod** (the user, 2026-10-03: "es kann dort auch ein
  runpod server laufen"; `docs/RUNPOD.md`: `https://<pod-id>-8188.proxy.runpod.net`, the app side built, the template
  never run on a real pod). The bar shows the host ("My ComfyUI · abc123-8188.proxy.runpod.net"). Auth for a remote
  server, by the types *Settings > ComfyUI* already has:
  - *none* (the pod's URL alone): nothing to add;
  - *basic* (the template's proxy): the header for that origin, and the page's `login` event answered with the stored
    user and password, so a 401 never shows a browser prompt; Chromium then reuses the credentials for the origin,
    the websocket included;
  - *bearer* / *custom header* (a token check): only by setting the header, `session.webRequest.onBeforeSendHeaders`
    for that origin only; **whether it reaches the websocket handshake is the first thing V1 measures** (a stub server
    that checks the header on `/ws`). If it does not, the window says that this auth type cannot show the page, and the
    pod's basic auth is the way; the app's own runs (through `comfy.js`) are not affected either way.
  A pod that is stopped or still starting answers the proxy's error page: the start page (§2.5) says the server does
  not answer, with the URL and *Reload*.
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
  page, the window closes with the main window, the stub's auth checks (basic with the `login` answer, a bearer and a
  custom header on the page and on `/ws`); a look on a real RunPod pod when the user starts one (the first real pod of
  `docs/RUNPOD.md`, it costs pod time); one look in the app against the user's ComfyUI on the user's word
  (opening the page queues nothing).
- **V1 as built (2026-10-03):** `electron/main/comfyview.js` (`ComfyView`: one `BaseWindow`, the bar and the page
  as two `WebContentsView`s, made at the first open and destroyed at the close), `electron/comfybar_preload.js`,
  `renderer/comfybar.html` / `.js` / `.css` (the shell's tokens, so skins reach it), the *ComfyUI* button after
  *Assistant* (`#shell-comfy`), *View › ComfyUI* with **Ctrl+Shift+K** (Ctrl+Shift+U would also fire the editor's
  Upsample: its Ctrl+U check ignores Shift), `settings.comfyView` (`bounds`, `maximized`), `menu` command
  `settings-comfy` for the start page's *Connect a ComfyUI*. The page loads `settings.comfy.url` + "/"; in a
  `--no-comfy` start it shows the start page unless the opener passes a stub's URL (`comfyView.open({ url })`, taken
  there only, dropped when the window closes). Load errors, an HTTP status of 400 or more and a crashed page end on
  the start page with the reason; nothing retries. The page gets the keyboard focus when it loads while the window is
  in front. *Save to recipe*, *Save as new recipe* and *Use Comfy Cloud* are there, disabled (V3, V4). Gate
  `comfyview` (`tools/comfyview_test.py`, 8 steps, offline, a stub server of its own).
  Measured on the way (Electron 44.2.0):
  - **Headers on the websocket:** `session.webRequest.onBeforeSendHeaders` reaches the page's `/ws` handshake for
    bearer, a custom header and basic, **but only when the filter names the `ws://` (or `wss://`) origin too**; with
    `http://host/*` alone the handshake went without the header (a stub server checking both). A `login` answer for
    basic auth covers the websocket as well. So every auth type of *Settings › ComfyUI* shows the page; no refusal
    note was needed. The `login` answer is given once per load: a wrong password ends on the 401 (two requests), no
    loop and no browser prompt.
  - **Scumble's menu reaches a BaseWindow:** without `setMenu(null)` and `setIgnoreMenuShortcuts(true)` a key in the
    ComfyUI page fired Scumble's menu accelerator (Ctrl+Shift+L opened the editor's console), also after the menu
    was built again; with them, Ctrl+S reached the page and no menu command (the gate). `buildMenu` drops the menu from the window again after every
    `Menu.setApplicationMenu` (which sets it on every window on Windows and Linux).
  - **Keys over CDP need focus emulation** in an occluded window (the gates run behind other windows: both views
    report `visibilityState` "hidden" and drop `Input.dispatchKeyEvent`); a key into the editor's page reaches no
    menu while the ComfyUI window has the focus, so the gate's control key runs with that window closed.
  Not done in V1: the look on a real RunPod pod, the look against the user's ComfyUI (both on the user's word), the
  desktop build of ComfyUI's default port (the start page names the URL it tried and leads to the setting).
- **V2, a recipe as a graph:** `toPrompt`, `load()`, `ready()`, *Edit in ComfyUI* (the button beside the title row's
  recipe select, the *View* menu, *Settings > Recipes*), the bar's "Editing: <recipe>". Tests: plain-Node `fromPrompt(toPrompt(r))` over every shipped ComfyUI
  recipe; a gate step with a stub page whose fake `window.app` records what it was given.
- **V2 as built (2026-10-03):** `recipes.toPrompt(recipe)` (the canvas node's `result_local` / `result` wired to
  `recipe.result`, each Settings row's input to `[canvas, 12 + index]`); `fromPrompt(src, objectInfo, meta, base)`
  takes the recipe the graph came from and gives back each row's value, label and spec where the same input is still
  wired to the same slot, and **keeps the canvas node's four parameters** (padding, target size, feather, multiple: a
  change for every API-format import too; the run overwrites them from *Settings*, so nothing runs differently). The
  round trip holds for the three shipped ComfyUI recipes (`tools/recipes_test.js` section 5). Main's `comfyRecipe(id)`
  hands the window `{ id, name, prompt: toPrompt(r), workflow }` (a provider recipe is refused by name); the window
  polls the loaded page for `window.app` with `graph` and `loadApiJson` / `loadGraphData` (`READY_JS`, 20 s, read as
  booleans and a 40-character version), then calls `loadGraphData(workflow)` or `loadApiJson(prompt, name)`; the
  answer is read as ok / a short error. The window holds the recipe until it closes, and gives it to the page again
  after every load (Reload included). *Edit in ComfyUI* beside the recipe select (hidden for provider recipes), in
  the provider-select cell of a ComfyUI row under *Settings › Recipes*, and *View › Edit Recipe in ComfyUI* (menu
  command `comfy-edit-recipe`). The user's frontend 1.53.10 (its files on this machine, read only) has
  `async loadApiJson(e, t, n = {})`, `window.app` and `window.__COMFYUI_FRONTEND_VERSION__`. Not run against a real
  ComfyUI yet (the user's word: it loads a graph into their page, it queues nothing).
- **V3, a graph as a recipe:** `read()`, *Save to recipe* (overwrite; a shipped recipe as a user recipe of its id) and
  *Save as new recipe* (the name dialog), the `workflow` field kept, the selection afterwards. Tests: plain-Node (a recorded `graphToPrompt` answer of the user's frontend as a fixture ->
  recipe), the stub-page gate step; one round trip on the user's ComfyUI (open a recipe, move a node, save back, run it
  once) on the user's word.
- **V3 as built (2026-10-03):** `recipes.fromGraph({ output, workflow, objectInfo, base, name, ids, date })` (plain,
  tested in `tools/recipes_test.js` section 6): the API prompt checked with `looksLikePrompt`, `fromPrompt` with the
  held recipe as `base`, the UI graph kept only with `nodes` and `links` arrays; without `name` the held recipe is
  overwritten (its id, name, description, family, task, refs and models stay), with `name` a new id from `slug(name)`
  that no listed recipe has (`_2`, `_3` ...). The window reads the page with `await app.graphToPrompt()` (`READ_JS`:
  both parts as JSON text, at most 20 MB each, parsed in main), fetches `/object_info` from the server the page came
  from (its headers, 15 s, `{}` when it fails), and main's `saveComfyGraph` saves the recipe, tells the editor
  (`comfyview:saved`: the recipes reloaded, the saved one selected, the message in the status line) and hands the
  window the saved recipe (it is held from then on). *Save as new recipe* takes the name in the bar itself (an input
  with Save / Cancel, Enter / Escape): a `<dialog>` would be clipped to the bar's 36 px view. The note beside the
  buttons says what happened. The UI graph stored may hold the Inpaint Canvas node's own widget values (its
  `canvas_state`); harmless, the page shows it as the node had it. Not done: the round trip on the user's ComfyUI
  (open a recipe, move a node, save back, run it once), on the user's word.
- **V4, Comfy Cloud in the window:** the target switch, the login check, the refusal note. One look with the user's
  login.
- **V4 as built (2026-10-03):** `electron/main/comfyhosts.js` (plain; `tools/comfyhosts_test.js`): Comfy Cloud is
  `https://cloud.comfy.org`, its page signs in with Firebase's `signInWithPopup` (read from the cloud's bundle in the
  built-in browser the same day, no sign-in: a `*.firebaseapp.com` auth domain, then Google or GitHub; the login page
  itself is `/cloud/login` on the same origin). A popup to `cloud.comfy.org`, `*.comfy.org`, `*.firebaseapp.com`,
  `accounts.google.com` or `github.com` (https, no credentials in the URL) opens on Comfy Cloud as a child window in
  `persist:comfyui` (sandboxed, no preload, no menu, its own popups to the system browser), closed with the window;
  the page may navigate to those hosts too (the redirect fallback). Nothing hides that this is an app window: Google
  may refuse the sign-in there; email and GitHub are the ways the notes name. The target is `settings.comfyView.target`
  (`comfy` / `cloud`), switched by the bar's *Show* select, the start page's *Use Comfy Cloud* or `open({ target })`;
  no auth headers go to the cloud. A recipe with the Inpaint Canvas node is not loaded there (the bar's note says why)
  and the save buttons are off on the cloud until V5. A `--no-comfy` start shows the start page for the cloud as well,
  unless a test passes a stub's URL. Not done: the look with the user's login (which sign-ins work in the window).
- **V5a as built (2026-10-03):** `recipes.detach(recipe)` -> `{ recipe, notes, needs }`, plain (tested in
  `tools/recipes_test.js` section 7 on the three shipped ComfyUI recipes, a mask and a whole-batch case, three
  refusals). The cloud form is **a provider recipe with one variant, `comfycloud`** (id `<id>_cloud`), so the whole
  provider path (crop, picture layout, key, stitch) carries it: `options.graph` (the graph without the canvas node),
  `options.pictures` (how many pictures it takes), `options.mask`, `options.values` ({ prompt, negative, seed,
  denoise, mode, width, height } -> the [node, input] pairs the run writes), `options.needs`; Settings rows keyed
  `"<node>|<input>"`; `limits` from the canvas node's `target_size` (else 2048) and `multiple_of`; `input` "fill" when
  the graph reads `crop_mask`, else "edit". Each `ImageFromBatch` (one picture at index k) on `crop_image` becomes a
  `LoadImage` titled `scumble:picture:<k>` **under the same node id** (what read the pick reads the picture); a picture
  past the run's last is to be the last one (ImageFromBatch clamps); `crop_image` used whole gets picture 0 and a note;
  `crop_mask` becomes `LoadImage` "scumble:mask" + `ImageToMask` (red). All three shipped recipes detach: Flux.2 Klein
  takes 4 pictures (prompt, seed), Qwen Image Edit 2.1 takes 10 (prompt, negative, seed), the upscale model 1.
  Open for V5b: `comfycloud.js` builds the run from `options.graph` (upload the crop, the references by picture
  index, the mask; fill the titled LoadImage nodes; write the values and the rows), `layout(req)` for it, the
  `/object_info` check per key. For V5c, the user's choice: how a cloud recipe comes about (a button per ComfyUI
  recipe that saves `<id>_cloud`, or a Comfy Cloud provider offered on every ComfyUI recipe that detaches).
- **V5b as built (2026-10-03):** `comfycloud.js` takes `options.graph`: `layout(req)` numbers the crop, the Original
  and the references as pictures 1.. (fields `scumble:picture:<k>`) with `max` = `options.pictures` and the mask in a
  field of its own; `buildDetached` uploads the crop, the references the layout wires and the mask (a fill recipe
  without one is refused), sets each titled `LoadImage` (a picture past the run's last gets the last file, as
  `ImageFromBatch` clamps), writes prompt, negative, seed, width and height into `options.values`' inputs and every
  `"<node>|<input>"` param into its input; `run()` checks `options.needs` against `GET /api/object_info` (kept ten
  minutes per key) **before any upload** and refuses a missing node by name, and reads the job's own `scumble_save`
  output before any other. Denoise and mode keep the graph's values (the provider request carries neither).
  `tools/cloudgraph_test.js` (10 checks, plain Node, a fake cloud). Not run live.
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
