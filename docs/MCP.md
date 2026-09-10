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

Dev: `node_modules/.bin/electron . --mcp` (or `.cmd`, `--headless`, `--cmd status` likewise).

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

Claude Code, dev checkout (`.mcp.json` in the repo does this for the project scope):

```bash
claude mcp add scumble -e ELECTRON_RUN_AS_NODE=1 -- F:\canvas\node_modules\electron\dist\electron.exe F:\canvas\electron\main\mcp\launch.js --mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "scumble": {
  "command": "C:\Users\<you>\AppData\Local\Programs\Scumble\Scumble.exe",
  "args": ["C:\Users\<you>\AppData\Local\Programs\Scumble\resources\app.asar\electron\main\mcp\launch.js", "--mcp"],
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
agent can act on "no layer X (layers: ...)". Read-only commands (`ping`, `list_*`, `status`,
`get_state`, `filter_types`, `screenshot`) carry `readOnlyHint`. When plugins are reloaded
the server sends `tools/list_changed`. `ping` adds `mcp: {mode, pid}` with mode `proxy`
(driving another process), `headless` or `window`.

The server's instructions text (what the model reads at connect) describes the round trip:
load_image → select_rect / select_by_text → set_prompt → generate → screenshot →
set_layer(match) → export.

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
  `generate` always ends in the editor first.
- **`electron/main/local.js`**: the command socket every running instance opens:
  `\\.\pipe\scumble-<hash of userData>` on Windows, `<userData>/scumble.sock` elsewhere.
  Newline-delimited JSON, `{id, cmd: run|describe|ping, name, args}` → `{id, ok,
  result|error}`, plus `{event: "commands"}` when the table changes. Local machine only, no
  authentication: the same trust as the DevTools port and the node's loopback route.
- **`electron/main/mcp/server.js`**: `@modelcontextprotocol/sdk` (MIT) low-level `Server`
  with `tools/list` and `tools/call` handlers built from `list_commands` on every list, so
  plugin commands appear without a restart. Stdin is read through
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
the Python `mcp` client: instructions, 62 tools with valid names and schemas, `ping`
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
