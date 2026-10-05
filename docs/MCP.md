# MCP server and headless mode

Scumble is MCP-capable: `Scumble --mcp` is a stdio MCP server whose tools are the commands of
the command core (`docs/COMMANDS.md`), including the commands plugins register. An agent
(Claude Code, Claude Desktop, Cursor, any MCP client) loads images, selects, prompts,
generates, adds layers and filters, looks at screenshots and exports, in the same documents
the user sees. No ComfyUI is needed for the server itself; `generate` needs the selected
recipe's backend like it does in the window.

## Starting it

| Command | What happens |
| --- | --- |
| `Scumble` | the editor window (as before) |
| `Scumble --mcp` | the stdio MCP server. If Scumble is already running, the server drives that instance over the local command socket. If not, this process starts the app **headless** (no window) and quits it when the client disconnects. |
| `Scumble --headless` | the app without a window, for scripts (`--cmd`) or a later `--mcp` |
| `Scumble --cmd <name> [json]` | run one command against the running instance (or a short-lived headless one), print the result as JSON, exit 1 on error |
| `--attach-only` (with `--mcp` or `--cmd`) | drive a running instance and never start one. With no Scumble running, `--mcp` lists `ping` alone and every call answers "Scumble is not running"; the first call that reaches a started Scumble sends `tools/list_changed`, and the client lists every command. |

Dev: `node_modules/.bin/electron . --mcp` (or `.cmd`, `--headless`, `--cmd status` likewise).

**The repo's `.mcp.json` registers the dev tree with `--attach-only`.** The dev app's `productName` gives it the
installed app's profile (`%APPDATA%\Scumble`), so a headless dev instance held the user's single-instance lock: a
Start-menu Scumble handed over to the dev tree, which then wrote the user's autosave, showed the dev version and had
no updater (`docs/BUGS.md`). With the switch a Claude Code session in the checkout drives the user's open Scumble and
starts nothing when none runs. `tools/mcp_attach_test.py` (part of the `mcp` gate) checks it on a profile of its own.

A second start of Scumble while a headless instance runs brings its window up (the
single-instance lock hands the start over; a window that was never shown needs `restore()`
on Windows, `show()` alone leaves it hidden). While an MCP client is connected, closing the
window only hides it; the app ends when the MCP session ends and no other process talks to
the socket. The window title shows `Scumble · n agents connected` while agents are attached
and the status bar says "MCP client connected." once.

## Registering with a client

Register the **launcher**, not the executable directly: `electron/main/mcp/launch.js` is a
plain Node script that the same executable runs in Node mode (`ELECTRON_RUN_AS_NODE=1`),
spawns the real app as its child and hands the client a stdout that starts with the first
JSON message. Help > Copy MCP registration puts the two lines below on the clipboard with
the paths of the installation you are running.

Claude Code, packaged app:

```bash
claude mcp add scumble -e ELECTRON_RUN_AS_NODE=1 -- "C:\Users\<you>\AppData\Local\Programs\Scumble\Scumble.exe" "C:\Users\<you>\AppData\Local\Programs\Scumble\resources\app.asar\electron\main\mcp\launch.js" --mcp
```

Linux, AppImage (untested; `electron/main/mcp/registration.js`): the file itself with `--mcp`, no launcher, because
every path inside an AppImage lives on a mount that changes with each start. A .deb install registers the launcher
under `/opt/Scumble/` like Windows.

```bash
claude mcp add scumble -- "/home/<you>/Applications/scumble-<version>.AppImage" --mcp
```

Claude Code, dev checkout (`.mcp.json` in the repo does this for the project scope):

```bash
claude mcp add scumble -e ELECTRON_RUN_AS_NODE=1 -- F:\canvas\node_modules\electron\dist\electron.exe F:\canvas\electron\main\mcp\launch.js --mcp --attach-only
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "scumble": {
  "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\Scumble\\Scumble.exe",
  "args": ["C:\\Users\\<you>\\AppData\\Local\\Programs\\Scumble\\resources\\app.asar\\electron\\main\\mcp\\launch.js", "--mcp"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
} } }
```

The launcher takes `--cmd <name> [json]` too, which is the way to get JSON a script can
parse without stripping anything. Plain `node electron/main/mcp/launch.js --mcp` works in a
dev checkout as well (in plain Node the `electron` package exports the binary's path).

### Why the launcher exists

Electron writes one empty line (`\r\n`) to stdout before any JavaScript runs on Windows, and
the MCP stdio transport forbids anything on stdout that is not a protocol message. Measured
on 2026-09-10: the bytes appear whatever stdout is (a pipe or a file) and whatever
`ELECTRON_NO_ATTACH_CONSOLE` says, so the app cannot suppress them; the same executable in
Node mode prints nothing at all and can read the packaged asar. Clients differ in how much
they mind: the TypeScript SDK (Claude Code, Claude Desktop) reports one "Unexpected end of
JSON input" through `onerror` and carries on, the Python `mcp` client fails the whole
session with a `json_invalid` error. `Scumble --mcp` therefore still works directly for
tolerant clients and for scripts, and the launcher is the one that keeps to the
specification.

## Tools

One tool per command, same name, with `.` replaced by `_` because tool names allow
`[A-Za-z0-9_-]` only: `film.apply_look` is the tool `film_apply_look`, `sample.mean_color`
is `sample_mean_color`. Parameters become the JSON schema (`type`, `enum`, `required`,
defaults in the description; `object` params such as `select_mask`'s `mask` accept anything).
Document commands take `doc`; without it the active tab is used. `screenshot` returns image
content (JPEG) plus a text block with the metadata, so the model sees the picture. Errors
come back as the command core's message with `isError`, never as protocol errors, so an
agent can act on "no layer X (layers: ...)". When plugins are reloaded
the server sends `tools/list_changed`. `ping` adds `mcp: {mode, pid}` with mode `proxy`
(driving another process), `headless` or `window`.

**Hints.** Every tool carries `readOnlyHint`, `destructiveHint` and `openWorldHint: false`, from
flags on the command's own definition (`readOnly` / `destructive` in `renderer/commands.js`, and
in a plugin's `scumble.commands.register`; `list_commands` and `docs/COMMANDS.md` show them).
Read-only: `ping`, the `list_*` commands, `status`, `get_state`, `filter_types`, `screenshot`,
`read_log`, `film_looks`, `glb_info`, `ailabel_info`, `boxes_list`, `sample_mean_color`.
Destructive (the call can lose something: a document, a layer, layers merged or flattened, a crop,
a file written over without asking, the recipe or its settings, an undo or redo step):
`close_document`, `new_canvas`, `load_image`, `generate_new`, `remove_layer`, `merge_down`,
`flatten`, `extend_canvas`, `straighten_canvas`, `resize_image`, `save_document`, `export`, `export_layer`,
`export_mask`, `delete_snapshot`, `undo`, `redo`, `select_recipe`, `set_node_params`,
`ailabel_add` (it replaces the label layer) and `ailabel_remove`. Everything else changes the
document additively or in one undo step (a `copy_to_layer` cut in two) and carries neither. A plugin command that sets no flag
is judged by its own name, the part after the plugin id: a `list...`, `get_...`, `info` or
`status` command is read-only, and none is destructive. Until 0.1.42 the hints came from the names
alone: the plugins' reads and `read_log` were not marked read-only, `new_document` was marked
destructive, and of the destructive commands above only the first three and `remove_layer` were.

The server's instructions text (what the model reads at connect) describes the round trip:
load_image → select_rect / select_by_text → set_prompt → generate → screenshot →
set_layer(match) → export.

**Reference layers in the prompt** (docs/PLAN_REFS.md). `@img1`, `@img2` ... name the shown
reference layers, top of the reference list first. `list_layers` gives each reference its
`label` (`"img1"`, or `null` while it is hidden: its tokens then wait as `@img?<layer id>`);
`status` adds `references: [{id, name, label, visible, sent_as}]`, where `sent_as` is the name
the selected recipe's route sends that picture as ("image 3" when the crop, the Original and
another reference go before it). `set_prompt` and `generate_new` take `refs: {"img1": "<layer
id>"}`: the agent's tokens are read with its own map and rewritten to the labels now (an id no
layer has is refused), and `set_prompt`'s answer carries `labels` and `parked`. `generate`
returns `prompt_sent` (the prompt as the model got it, each token written as that model's name,
on a local ComfyUI recipe as its graph numbers the picture), `notes` (what the route declared
it left out) and `seed` (the seed the model got; null when the route sends none, as FLUX 3 Image); a run that cannot send a token (a hidden or deleted reference, one past a local
recipe's slots) throws at once with the reason. An upscale sends no reference picture: a token
goes as its layer's name.

**`generate_new` and reference layers** (step 26f). It replaces the image, the history and every
layer but the reference layers, which stay with their ids, order, visibility and pixels. The
shown ones go along where the chosen variant's text shape takes reference images for a new image
(`list_recipes` gives each recipe `textRefs`: true when `generate_new` sends them with its chosen
provider, and on a ComfyUI recipe when its graph reads pictures after the white canvas, which is
image 1 there; false on a model that makes pictures from the prompt alone; absent on an upscaler). They are numbered from 1, with no crop before them, so `@img1` goes out
as `image 1`; references the prompt does not name go too, hidden ones stay without being sent. A
token on a model that makes pictures from the prompt alone is refused, and so is a run with more
references than the model takes, before anything is sent. The API path returns `prompt_sent`,
`references: [{label, id, sentAs}]` (every reference sent; `sentAs` the name the model got for a
token the prompt holds, null for a reference the prompt does not name), `kept` (reference
layers) and `dropped` (other layers replaced), `notes` and `info`. The local path keeps the
references on its fresh white canvas, which is picture 1 of the recipe's batch, so `@img1` is
named as picture 2 there (3 when the Original goes too); it returns `prompt_sent` and `notes`.
`add_image_layer` with `role: "reference"` works in an empty tab: a white 1024 × 1024 canvas
comes first, which `generate_new` replaces while the reference stays (`role: "none"` there is
still refused with "no image loaded").

**`realism_pass`** (docs/PLAN_0_1_42.md, R3b / R4 / R-U). The Realism Pass (Windows only, RTX only) runs on
the user's own ComfyUI only: Windows, an RTX 30, 40 or 50 card, the community node pack
ComfyUI-DLSS5-Enhancer and its runtime, which the user installs there (the manual's chapter of the
same name). It sends the whole visible picture and adds the answer as a new layer under the top run
of filter layers, one undo step; it takes no prompt and no selection. `factor` 1 (the default)
refines at the picture's own size; `factor` 1.5, 1.7 (DLSS's 1.724x Balanced), 2 or 3 also makes the
document that many times larger first (the base and every layer, mask and the selection scaled
along) and the layer comes at the new size, in the same undo step; a picture whose output would
pass 7680 × 4320 or 27.9 megapixels (measured: answers near 30 megapixels sometimes came back
with broken colours) is scaled down before it goes (a note says to what), so the document grows
as far as the pass allows. Any other factor is refused. Before calling it, read
`status`'s `realism: { ready, reason, note, style, strength, preset }`, which answers for factor 1:
`ready` false gives the sentence the command would refuse with (the server, a run going on the
document, still loading, no picture, past 7680 × 4320 or 27.9 megapixels; above factor 1 that last reason does not
hold, and a picture that cannot get larger or would be scaled under 64 px a side is refused
instead), and `note` the RTX 30 one. `list_recipes` gives the pass recipe (task
`pass`) `ready` / `reason` / `note` for the connected server alone (every recipe has `ready` / `reason`
since F2a, below). Style, Strength and the model
preset are the user's (the Upscale dialog's row); there is no command argument for them. The
command waits for the answer (`timeout`, 570 s by default, ends the job on the server too) and
returns `layer`, `seconds`, `notes`, `changed` (the picture changed while the pass ran), `factor`, and
`from` / `width` / `height` (the document's size before and after). The pass
recipe itself runs through `generate` on a selection's box; `generate_new` refuses it.

**Before a run, during it, and the picture** (docs/PLAN_0_1_42.md F2a). `list_recipes` says per recipe
whether it can run now: `ready`, and `reason` when not (an API recipe: a key stored for its chosen
provider, or the in-app model downloaded; a recipe on the user's ComfyUI: connected, and every node
type it needs on the server), `keys` (per provider of the recipe, `true` / `false`), `new_image` /
`edit` (whether `generate_new` / `generate` take it), `sizes` (the long sides its text route offers;
null: any), `background` (whether `generate_new`'s `background: "transparent"` reaches it), and an
upscaler's `document_max`; `provider_keys` lists every API provider with whether a key is stored, as a
boolean (never the key or its last characters). `cancel_run` cancels the runs in flight as the
title row's Cancel does (one tab's with `doc`, else every tab's); a `generate`, `upscale` or
`realism_pass` waiting on one ends at once, and a provider may still charge a job it already had; a run
whose answer is already landing can no longer be cancelled and is listed under `landing`. A
Generate with a recipe on the user's own ComfyUI is not interrupted. `screenshot` takes `box` [x, y,
w, h] (a region at up to 1:1, to judge an inpainted area of a large picture), `what: "base"` (the
picture without its layers) and `what: "mask"` (the selection, or with `layer` that layer's mask, in
black and white). `transform_layer` rotates, distorts, warps or quarter-turns one layer;
`copy_to_layer` lifts a layer's or the picture's selected pixels onto a new layer (in this tab or
another, the user's clipboard untouched); `resize_image` resizes the whole document as Image › Canvas
› Resize. Each is one undo step; a `copy_to_layer` cut is two in its own tab (the cut, then the
paste: `undo {steps: 2}` takes both back).

**Selections, the Settings rows, crop and filter values** (docs/PLAN_0_1_42.md F2b). `select_color` is
the Magic wand at a point (`tolerance` 0..255, `contiguous`, `sample` image or layer), in the app with
no model or server; `select_shape` selects an ellipse (`x`, `y`, `w`, `h`) or a polygon / lasso
(`points`), with `mode` and an optional `feather` of the new shape's edge, without a whole mask going
through `select_mask`. Each is one selection undo step. `list_settings` gives the selected recipe's
Settings rows (index, label, input, `kind` number / combo / boolean / string, a combo's `options` up to
`max_options` with `options_total`, a number's `integer` / `min` / `max` / `step`, the `value` and
`valid`) and the Preset row's `presets` (the recipe's shipped ones first, then the user's, each with
its values by row and the files the server lacks); `apply_preset` applies one by name, and is refused
with nothing changed when the server lacks a file it names; saving and deleting presets stay in the
app. `set_crop` takes its switches as booleans and its choices from their lists (`context` / `feather`
auto or manual: the pixels manual uses are `set_node_params` padding / feather, so a number is
refused), checks every key before it stores any, and answers with the crop as the editor reads it,
as `status` does. `add_filter` / `set_filter` apply `params.preset` as the layer list does (its
values, the layer named after it; a slider that is no offset on the preset, `filter_types`' `offset`,
turns it to custom when it changes the value), refuse a bad value before anything changes, and
`set_filter` is one undo step of its own; `filter_types` gives each option `{id, label, group}`.

## How it works

```
MCP client ──stdio──> Scumble --mcp (electron/main/mcp/server.js)
                           │  AgentBackend (main.js): proxy or own app
                           ├─ running instance?  ──named pipe / unix socket──> LocalServer (local.js)
                           └─ none: start the app headless in this process       │
                                                                                  ▼
                                                        Bridge (bridge.js) ──IPC commands:request──> renderer
                                                                            <──commands:reply──  commands.call(name, args)
```

- **`electron/main/bridge.js`**: main → renderer request / reply over IPC, one id per call.
  The renderer sends `commands:ready` at the end of its start (plugins loaded, session
  restored); earlier calls wait for it (up to 120 s). A reload of the window rejects pending
  calls. Bridge timeout: 10 minutes plus the command's own `timeout` argument, so a long
  `generate` always ends in the editor first. A request of the in-app assistant carries a third
  argument, `meta` (its origin, the user-activity wait, the busy check), which the shell reads
  before `commands.call`; when the assistant's turn is stopped while such a request still waits,
  the Bridge sends `commands:cancel {id}` and the request never runs. Requests without `meta`
  (external agents, `--cmd`, scripts) take exactly the path they always took.
- **The in-app assistant** (`docs/ASSISTANT.md`) drives the editor through **the same server**:
  `createServer(backend)` on an `InMemoryTransport` pair inside the main process, with the Bridge
  as its backend. It sees the same tools minus six it must not have (`list_commands`, `run_action`,
  `set_status`, the three `ailabel_*`), and its requests carry the `meta` above. **Nothing an
  external agent sees changed for it**: the tool list, the instructions, the annotations and the
  error texts are what they were, and that was proven byte for byte when `createServer` was split
  out of `serve()`.
- **`electron/main/local.js`**: the command socket every running instance opens:
  `\\.\pipe\scumble-<hash of userData>` on Windows, `<userData>/scumble.sock` elsewhere.
  Newline-delimited JSON, `{id, cmd: run|describe|ping, name, args}` → `{id, ok,
  result|error}`, plus `{event: "commands"}` when the table changes. Local machine only, no
  authentication: the same trust as the DevTools port and the node's loopback route.
- **`electron/main/mcp/server.js`**: `@modelcontextprotocol/sdk` (MIT) low-level `Server`
  with `tools/list` and `tools/call` handlers built from `list_commands` on every list, so
  plugin commands appear without a restart. `createServer(backend, opts)` makes that server
  and `serve(backend, opts)` puts it on stdio; an in-process client (the in-app assistant)
  connects the same server to a transport pair instead, so both see one tool surface. The
  `changed` listener goes off the backend again when the server closes: the Bridge outlives
  an in-memory session, and Node warns after ten listeners. Stdin is read through
  `fs.createReadStream(null, {fd: 0})`: in Electron's main process `process.stdin` never
  emits `data` when stdin is a pipe on Windows (the stream ends, the bytes are lost). The
  transport does not watch the end of stdin either, so the server closes on `end` / `close`
  itself.
- **`main.js`**: `parseArgs`, console → stderr in `--mcp` mode, `headless` flag
  (`ready-to-show` does not show, `second-instance` / `activate` call `showWindow`),
  `needWindow()` in front of every dialog (Open / Save / Import recipe / Choose folder throw
  "pass a path instead" when no window is shown), `AgentBackend` (connect to the socket,
  else take the single-instance lock and start headless; a proxy whose instance went away
  reconnects or takes over at the next call), `maybeQuit()`.
- **Renderer**: `preload.js` `scumble.commands` (`onRequest`, `reply`, `ready`, `changed`);
  `shell.js` runs `commands.call` for every request and answers with JSON-safe payloads,
  sends `ready` after its start and `changed` on plugin changes.

Headless rendering: the hidden window has `backgroundThrottling: false`, WebGL2 filters,
canvas exports and the ONNX helpers run as in the window (`document.visibilityState` says
"visible" because of that flag). The autosaved session is restored headless too, so the
agent sees the user's last documents.

## Testing

`python tools/mcp_test.py [--exe dist/win-unpacked/Scumble.exe]` talks to the server with
the Python `mcp` client: instructions, the tools with valid names and schemas (105 on a fresh
profile on 2026-10-05: 88 core commands and 17 from the built-in plugins), `ping`
(reports the mode), `new_document`, `load_image` by path, `select_rect`, `add_filter`
(`sample.posterize`, WebGL2 in the hidden window), `sample_mean_color`, `screenshot` as
image content (`dist/smoke/mcp_screenshot.jpg`), `export` to a path, an error case, an
unknown tool, `close_document`. Run it with the app open (proxy mode, about 1.5 s) and
without (headless, about 5 s including the app start; the process ends with the session).
Both PASS on 2026-09-09 with the dev electron and the packaged exe.

`node_modules/.bin/electron . --cmd status` is the quickest check of the socket; a stray
`\r\n` precedes the JSON on stdout (see above).

## Known small things

- A `--mcp` proxy spawns a full Electron process (Chromium, GPU process) just to relay over
  the socket; a plain Node relay would be lighter but cannot avoid Electron's stray newline
  either, and `ELECTRON_RUN_AS_NODE` would have to be set by the client. Left as is.
- Two MCP clients: the second proxies to the first's headless app; when the first client
  disconnects its app quits and the second's next call starts its own.
- Windows GUI executables print nothing to a console: `Scumble.exe --cmd ...` shows output
  only through a pipe (`| more`, `subprocess`), the dev `electron.exe` prints normally.
