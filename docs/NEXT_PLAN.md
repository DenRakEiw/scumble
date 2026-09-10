# Plan after 0.1.4: MCP handshake, local upsampler, signing policy, two decisions

Written 2026-09-10 for the implementation session. Read `CLAUDE.md` first; the numbers and
findings below were measured on this machine today, the design follows from them. Work the
items in order 1, 2, then the hand-over; items 3 and 4 are as far as they go without the user.

Release target: **0.1.5** (items 1 and 2 are user-visible, both get a `CHANGELOG.md` entry).
0.1.4 is prepared and untagged; tag it first or fold it into 0.1.5, the user decides at the
start of the session (`git tag v0.1.4 && git push --tags`, then
`gh release edit v0.1.4 --draft=false`).

---

## 1. MCP handshake: no byte before the first JSON message

### What is wrong

Electron's Windows entry point writes `\r\n` to stdout before any JavaScript runs. The MCP
stdio transport says a server "MUST NOT write anything to its stdout that is not a valid MCP
message", so `Scumble --mcp` violates the protocol by one line. Clients react differently:

- TypeScript SDK (Claude Code, Claude Desktop): one `Unexpected end of JSON input` through
  `onerror`, then carries on. That is why the dev registration in `.mcp.json` works today.
- Python `mcp` 1.29.1 (the one installed here, `tools/mcp_test.py`): `stdout_reader` in
  `mcp/client/stdio/__init__.py` line 155 fails on the line `'\r'` with a pydantic
  `json_invalid` error, pushes the exception into the session and the whole `TaskGroup`
  dies: `FAIL: unhandled errors in a TaskGroup (1 sub-exception)`. Reproduced today with the
  dev electron; the installed 0.1.3 fails the same way. Any strict client will do the same.

### What was measured (do not repeat, build on it)

| Experiment | Result |
| --- | --- |
| `electron.exe . --cmd ping`, stdout a pipe | stdout starts with `\r\n{` |
| same with `ELECTRON_NO_ATTACH_CONSOLE=1` | unchanged, `\r\n{` |
| same with stdout redirected to a file | unchanged, the bytes are written whatever stdout is |
| `ELECTRON_RUN_AS_NODE=1 electron.exe -e "process.stdout.write('x')"` | exactly `x`, **nothing before it** |
| Node mode reading the packaged asar (`fs.readdirSync('dist/win-unpacked/resources/app.asar')`) | works: the launcher can live inside the asar |
| A scratch Node-mode launcher spawning `electron.exe . --cmd ping` with the env var removed for the child, dropping leading CR / LF / space bytes from the child's stdout | stdout starts with `{`, exit code passed through |

So the CRLF cannot be suppressed from inside the app or by an environment variable; it can
only be avoided by not being the Electron process that talks to the client. The Node mode of
the same executable prints nothing, and it is available in the packaged app (the `runAsNode`
fuse is on; electron-builder does not flip fuses unless told to).

### Design

**`electron/main/mcp/launch.js`**, a plain Node script (no Electron API, no `require` of
anything from the app), started in Node mode by the same executable:

```
ELECTRON_RUN_AS_NODE=1 Scumble.exe resources\app.asar\electron\main\mcp\launch.js [--mcp | --cmd name [json]]
ELECTRON_RUN_AS_NODE=1 electron.exe F:\canvas\electron\main\mcp\launch.js [...]     (dev)
node electron\main\mcp\launch.js [...]                                              (dev, plain node)
```

Behaviour:

1. Pick the child. Packaged (`process.execPath` is not `electron.exe`): `[execPath,
   ...args]`. Dev: `[execPath, <app root>, ...args]` where the app root is
   `path.resolve(__dirname, "../../..")`; when run under plain `node`, the executable is
   `require("electron")` (in plain Node that export is the path to the binary). Default
   args when none are given: `["--mcp"]`.
2. `spawn(exe, args, { env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true })` with
   `env` a copy of `process.env` **without** `ELECTRON_RUN_AS_NODE`; otherwise the child is
   a Node process too and the app never starts.
3. Relay stdin to `child.stdin` (read fd 0 with `fs.createReadStream(null, {fd: 0})` like
   `server.js` does; that works in plain Node as well). On `end`/`close` call
   `child.stdin.end()` and start a 5 s timer that kills the child if it has not exited (the
   client went away; the server's own stdin-end handling normally quits the app when
   nothing else holds it).
4. Relay `child.stdout` to `process.stdout`, dropping only the **leading** run of bytes 13,
   10 and 32 until the first other byte arrives (state flag, then pass everything through
   untouched; never touch bytes after the first message, they carry base64 image content).
5. `child.on("exit", code => process.exit(code ?? 1))`; `process.on("SIGTERM" | "SIGINT" |
   "exit", () => child.kill())`. On Windows the client killing the launcher does not kill
   the child by itself; the stdin end from step 3 is what ends it, the kill is the backstop.
6. Errors spawning the child go to stderr with a `scumble-mcp:` prefix, exit 1.

Keep `Scumble --mcp` and `--cmd` working directly as before (tolerant clients, scripts);
the launcher is the documented, spec-clean way. `--cmd` through the launcher yields clean
JSON on stdout too, which scripts can `json.loads` without stripping.

### Files

- `electron/main/mcp/launch.js`: new, as above. Comment header: why it exists (the
  experiments in one paragraph), that it must stay free of Electron and app requires.
- `electron/main/main.js`: the header comment (lines 25 to 29) gets the launcher line; the
  `--mcp` comment "cannot be suppressed" points to the launcher.
- `.mcp.json`: `"command": "node_modules/electron/dist/electron.exe", "args":
  ["electron/main/mcp/launch.js", "--mcp"], "env": {"ELECTRON_RUN_AS_NODE": "1"}`.
- `tools/mcp_test.py`: `SERVER` uses the launcher: dev `electron.exe` +
  `electron/main/mcp/launch.js`; `--exe <Scumble.exe>` uses `<exe dir>/resources/app.asar/
  electron/main/mcp/launch.js`; both with `env={..., "ELECTRON_RUN_AS_NODE": "1"}` on the
  `StdioServerParameters`. Add `--direct` for the old registration (`--mcp` straight on the
  exe) for manual use; with the installed Python client that is the documented FAIL, so it
  is not part of the gate.
- `docs/MCP.md`: "Registering with a client" gets the launcher forms: Claude Code
  `claude mcp add scumble -e ELECTRON_RUN_AS_NODE=1 -- "<install>\Scumble.exe"
  "<install>\resources\app.asar\electron\main\mcp\launch.js" --mcp`, Claude Desktop JSON
  with `"env"`, and the dev form; the paragraph at lines 48 to 51 becomes "why the launcher
  exists". `README.md` line 46 (MCP bullet) and the `--mcp` mention in "Run from source"
  follow.
- **Help > Copy MCP registration** (main.js menu, small): puts the `claude mcp add ...`
  line with the real install path on the clipboard, a second entry for the Claude Desktop
  JSON. Users will not type an asar path by hand. `app.getPath("exe")` gives the exe,
  `process.resourcesPath` the resources folder (packaged), in dev the repo paths.
- `CLAUDE.md`: in "Electron on Windows, three traps" the CRLF trap is now "handled by the
  launcher"; the "tools/mcp_test.py fails" paragraph in the phase 6 section goes.
- `CHANGELOG.md` 0.1.5: "MCP clients that reject a blank line before the first message
  (the Python SDK among them) could not connect; register the server through the launcher
  (Help > Copy MCP registration)".

### Gates

- `python tools/mcp_test.py` PASS in proxy mode (dev instance running on 9555) **and**
  headless (nothing running); then `npm run dist` and `python tools/mcp_test.py --exe
  dist/win-unpacked/Scumble.exe` (stop the dev instance first, single-instance lock).
- Raw check that costs nothing: a `python -c` that spawns the launcher with `--cmd ping`
  and asserts `stdout[0] == ord("{")`.
- Claude Code itself: `claude mcp add` with the launcher line from Help, then `claude mcp
  list` shows scumble connected and one `ping` tool call works. That is the user-visible
  proof; note it in the hand-over.
- `commands_test.py` unchanged (the launcher touches no command).

Estimate: 2 to 3 hours including the packaged run.

---

## 2. Generic OpenAI-compatible endpoint for prompt upsampling

### Why

`electron/main/llm.js` knows three hosted APIs, all keyed. A local Ollama / LM Studio (or
OpenRouter, any `/v1/chat/completions` server) gives a free upsampler without ComfyUI and
without a key. Marked "not yet" in `CLAUDE.md` since 2026-09-10.

### Design

**Settings.** `settings.llm.compat = { url, model }` in `electron/main/settings.js`
`DEFAULTS` (`url: ""`, `model: ""`; placeholders show `http://localhost:11434` for Ollama,
`http://localhost:1234` for LM Studio). Optional key under the secret name `compat`
(`keys.js`; OpenRouter and some proxies need one, Ollama and LM Studio do not).

**Adapter** `askCompatible({ url, model, key, instruction, image, maxTokens })` in `llm.js`:

- `POST <url>/v1/chat/completions` (accept a URL that already ends in `/v1`; strip a
  trailing slash), body `{ model, messages: [{ role: "user", content }], max_tokens,
  stream: false }`, `content` = `[{type: "text", text}]` plus `{type: "image_url",
  image_url: {url: dataUri(png)}}` when an image is given. `Authorization: Bearer` only
  when a key is set.
- Text-only models answer 400 (or an error mentioning images / vision) when the image is
  in the request: **retry once without the image** and append "(text only)" to the label
  the status line shows, so the user learns the model did not see the crop.
- Read `choices[0].message.content` (a string, or an array of `{type: "text"}` parts on
  some servers); ignore `reasoning_content`; strip a `<think>...</think>` block (Ollama's
  Qwen3 / DeepSeek put the thinking into the content). The quote / fence stripping in
  `ask()` applies after.
- Errors: `readError(r)` from `providers/util.js` like the others; a connection refused
  becomes "No server at <url> (is Ollama / LM Studio running?)".
- Timeout 120 s (local models on CPU are slow; `AbortSignal.timeout`).

**Listing.** `list()` appends `{ id: "compat:<model>", provider: "compat", model, label:
"<model> (<host>)", key: true }` when both `url` and `model` are set (the `key` flag is
what `host.upsampleBackends()` filters on; keep the field name). `PROVIDER_LABEL.compat =
"OpenAI-compatible endpoint"`. `ask()` resolves `compat:` ids against the settings instead
of `MODELS`.

**Models from the server.** IPC `llm:models` -> `GET <url>/v1/models` -> `[id]` (Ollama and
LM Studio both serve it). Used by the Test button; on success the model field gets a
`<datalist>` with the ids and the state line says "n models, <first three>".

**Settings UI** (`renderer/shell.js` `renderProviders()` or a block right below the key
rows, heading "Local / OpenAI-compatible endpoint"): URL field, model field with datalist,
key field with Save / Clear like the provider rows (reuse the row builder with `p.id ===
"compat"` special-cased for the two extra inputs), a *Test* button. Saving URL or model
writes `settings.llm.compat` through the existing settings IPC and calls
`host.refreshLLMs()` so the editor's upsample select updates without reopening the dialog
(same pattern as the key rows, `shell.js` lines 443 and 448). `providers/compat.js` as a
key-row-only entry like `anthropic.js` (`needsKey: false`, label, `keyHint`, `edit()`
throws) keeps `describeAll()` and the key store uniform.

**Editor side needs nothing new**: `host.upsampleBackends()` already turns every listed
model with `key: true` into a select entry, `host.upsampleInApp()` runs it, the
`upsample_prompt` command and "select by text from the prompt" use the selected backend.
Adjust the `upsample_prompt` description in `renderer/commands.js` line 441 ("... or a local
OpenAI-compatible server") and regenerate `docs/COMMANDS.md` with `tools/commands_doc.py`.

### Test without a real model

`tools/llm_mock.py`: a `http.server` on a free port that answers `GET /v1/models`
(`{"data": [{"id": "mock-vision"}, {"id": "mock-text"}]}`) and `POST /v1/chat/completions`:
model `mock-vision` returns "<first five words of the instruction> UPSAMPLED, image: yes|no";
model `mock-text` returns HTTP 400 `{"error": {"message": "image input is not supported"}}`
when the content holds an `image_url` part, otherwise the same text with `image: no`; it
records every request body to a file for the assertions. Started by the test itself in a
thread, the way `smoke_test.py` sets the loopback provider from inside (line 230).

`tools/llm_test.py` (needs the app on 9555 and the test image, no ComfyUI): start the mock,
set `settings.llm.compat` through CDP (`window.scumble.settings.set(...)`, then
`host.refreshLLMs()`), check `host.upsampleBackends()` lists `app:compat:mock-vision`, set
the editor's upsample select to it, `commands.run("upsample_prompt")` -> the prompt contains
`UPSAMPLED` and `image: yes`; switch the model to `mock-text` -> the retry happens (the mock
saw two requests, the second without an image), the prompt contains `image: no`, the status
contains "text only"; stop the mock -> the error text names the URL. Restore the settings at
the end. Add the step to `CLAUDE.md` "Working rules" and README "Tests".

Docs: `docs/HELPERS.md` section "Prompt upsampling" gets the endpoint (fields, which
servers were tried, the text-only retry); `CLAUDE.md` "Decisions" bullet for API rendering
gets one line; CHANGELOG 0.1.5.

Estimate: 4 to 6 hours. Ollama / LM Studio are not installed here; the mock is the gate, and
the hand-over must say plainly that no real local server has been tried.

---

## 3. Code signing policy page: done in this session

`docs/CODE_SIGNING_POLICY.md` exists and is linked from the README (Install section and the
layout table). It follows the SignPath Foundation terms read today (`signpath.org/terms`):
the heading "Code signing policy", the roles *Committers and reviewers* / *Approvers*
(GitHub write permission of `DenRakEiw/scumble`), the verbatim privacy sentence plus the
honest list of what the app contacts (the update check at start is the one automatic
connection; it can be switched off), how the release is built by CI, and the attribution
sentence "Free code signing provided by SignPath.io, certificate by SignPath Foundation"
marked as applying from the first signed release on. Nothing to build now.

What remains for the application itself, later and by the user:

1. MFA on the GitHub account (SignPath requires it for the approvers).
2. "Visible use" (some stars / downloads / issues); the terms also want the functionality
   described on the download page, which the README and the release notes do.
3. Apply at `signpath.org` (project, repo, policy page URL).
4. Then in `.github/workflows/build.yml`: the SignPath GitHub Action
   (`signpath/github-action-submit-signing-request`) after the build, `SIGNPATH_API_TOKEN`
   as a repository secret, the organization / project / signing-policy slugs from the
   SignPath portal, and the signed installer replacing the unsigned one in the draft
   release before it is published. The About dialog and the README get the attribution
   sentence at that point, and the SmartScreen paragraph goes.

---

## 4. Waiting for the user's decision

Neither is to be built without a "yes". Both are written up so the decision can be taken
from this page.

### 4a. Blur as a shader pass in the film pack

**Situation.** `plugins/film/common.js` `blur()` is a Canvas 2D `ctx.filter = blur(sigma)`
on a mirrored-padded canvas; six call sites (`filters.js` lines 186, 415, 436, 464, 657 and
`points.js` line 105: halation, glow, light leak, structure, the `useBlur` paths). It is the
one place where the GPU filter chain has to touch down to a canvas and wait: the full film
stack stays at 5.5 ms per frame at a 24 MP document, the chain saved everything else
(`docs/PERFORMANCE.md`, phase 5 step 2).

**Recommendation: not now.** 5.5 ms is a third of a 60 Hz frame; the gain is 2 to 3 ms that
nobody feels while dragging a slider, and the price is a look change in every blur-based
filter and in the halation default of all 46 stocks, because Skia's blur (a triple box
approximation) and a true Gaussian differ visibly at the radii halation uses. Revisit when a
measured workflow (not a benchmark) is blur-bound, for example the export of a 12k image
with the film stack, and then decide with a contact sheet before / after.

**If yes, the plan** (about a day):

1. Separable Gaussian in `inpaint_filters_gl.js`: two passes (horizontal, vertical) on
   `GLSurface`s, kernel radius `ceil(3 sigma)`, weights as a uniform array up to 32 taps,
   and above sigma of about 10 a downsample / blur / upsample pyramid (blur at 1/2 or 1/4
   resolution, sigma scaled) so a sigma of 40 times the export scale does not mean a
   240-tap kernel. Mirror edges in the shader instead of the padded canvas.
2. `scumble.gl.blur(surfaceOrCanvas, sigma, info)` in the plugin API (`renderer/plugins.js`,
   `docs/PLUGINS.md`); `common.js` `blur()` calls it when the GL chain is present and stays
   on the chain (no `toCanvas`), and gets a **CPU Gaussian twin** (separable, same kernel and
   pyramid rule) so `film_test.py` keeps comparing GPU against CPU. Both twins change
   together, which is why the test cannot catch the look change: add a scripted before /
   after contact sheet (`dist/smoke/film/sheet.jpg` was made by hand once).
3. Re-tune the halation defaults per stock in `looks.js` by eye against the old sheet, and
   say so in CHANGELOG ("halation and glow look slightly different, softer edges").
4. Measure: `perf_test.py --chain 6000x4000` film stack and `glChainStats()` round trips
   (expected 5 -> 1 per frame), the full export time.

### 4b. The editor source moves into this repo, the node consumes a build

**Situation.** `renderer/editor/` is a copy of the node's `js/` made by
`tools/sync_editor.py` (453 lines, 49 patch rows in `docs/SYNC.md`, growing with every
phase; phases 1 to 6 and the film-pack hooks are all patches). `docs/BRIEF.md` section 6
already recommends "editor source lives here, the node repo gets a build step", and the
phase 5 notes say the GL filter module and the compositor are app-only until they go back.

**Recommendation: yes, as its own step after 0.1.5**, on a branch in both repos, because
the sync round trip works today and the patch table is the risk (every editor change has to
land in the node first, then survive the patch anchors; the memory leak and the three 0.1.3
regressions were all found in the app and written back through the sync).

**Plan** (1 to 2 days, both repos):

1. **Freeze the diff**: run `sync_editor.py` once more, commit both sides, and record the
   node's `js/` hash in the app repo. From here the app copy is the source of truth.
2. **Make the patches permanent**: the 49 rows become plain code in `renderer/editor/`.
   Each hook the patches added (`host.pluginOverlay`, `host.pluginPointer`, `host.pluginKey`,
   `host.toolChanged`, `host.editorBuilt`, `addSection`, `_addTool`, the DOM helper exports,
   `objectBackendAvailable()` / `host.findObjects`, `host.cutoutBackends()`,
   `host.upsampleBackends()`, the ask modal, the mask row builder, ...) already goes through
   `host.*` with a fallback, so the node needs the same surface with no-ops: write the node's
   `js/host.js` (the ComfyUI `api` from `../../scripts/api.js`, `queuePrompt`, events, no
   plugins, no in-app helpers) mirroring the shape of `renderer/editor/host.js`.
3. **Build step**: `tools/build_node.py` copies `renderer/editor/*.js` (plus `fonts/`,
   `inpaint_worker.js`, `inpaint_filters_gl.js`, `inpaint_compositor.js`) into the node's
   `js/`, keeps the node's own `host.js`, `inpaint_bridge.js` and the ComfyUI extension
   entry, rewrites nothing else. The node's `DEVELOPMENT.md` gets the rule "`js/` is
   generated from `DenRakEiw/scumble` `renderer/editor/`, edit there"; a check compares the
   hash.
4. **Delete** `tools/sync_editor.py` and `docs/SYNC.md`; `CLAUDE.md` "Do not edit the synced
   files by hand" flips to "edit them here, then `build_node.py`".
5. **Gates**: app: `composite_test.py`, `commands_test.py`, `film_test.py`, `perf_test.py`
   (within noise), `smoke_test.py --no-helpers`; node: its own test list in `DEVELOPMENT.md`
   plus one real run in the ComfyUI browser tab. The GL filter module and the compositor
   arrive in the node with this step, which is the "same code goes back into the node"
   decision from `CLAUDE.md`; check them in the browser.

Open question for the user in this item: whether the node repo should become a git
submodule / subtree of the app instead of a generated copy. The generated copy is simpler
for node users (`git pull` in `custom_nodes` keeps working, no submodule init) and is what
BRIEF recommends.

---

## Hand-over checklist for the implementation session

- Items 1 and 2 landed, gates green on a **fresh** instance: `mcp_test.py` (proxy, headless,
  `--exe`), `llm_test.py`, `commands_test.py`, `composite_test.py`, `film_test.py`,
  `smoke_test.py --no-helpers`.
- `CHANGELOG.md` 0.1.5 section (and 0.1.4 tagged or merged into it), `package.json` 0.1.5.
- `docs/MCP.md`, `docs/HELPERS.md`, `docs/COMMANDS.md` (regenerated), `README.md`,
  `CLAUDE.md` "Where things stand" rewritten to the new state; this file stays as the record
  of the decisions in item 4.
- Commit as DenRakEiw (see `CLAUDE.md` "Working rules"), push, tag after the user's go.
