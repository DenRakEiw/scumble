# CLAUDE.md — Scumble (desktop app)

Read this first, then `docs/BRIEF.md` (vision, decisions, architecture, phases).
`docs/BUGS.md` is the bug list: what is reported and not fixed, and what has to be
measured before anyone writes code. Put a new report there, not in this file.
`docs/NAMES.md` holds the name research, `docs/RUNPOD.md` the Docker template notes.

**Name: Scumble** (decided 2026-09-07). A scumble is a thin, semi-opaque layer of paint
brushed over a dry layer so the one below shows through; that is what an inpaint result
over the image is. Pronounced "skum-bl". Domains `scumble.app` and `scumble.de` were free
on 2026-09-07 (`scumble.com` is taken); the user registers them and checks trademarks
(DPMA, EUIPO, USPTO, classes 9 and 42) before the first public mention. Use the name in
the app, the installer (`Scumble Setup.exe`), the MCP server name (`scumble`) and the
repo; the ComfyUI node keeps its name Inpaint Canvas.

## Who and what

Built for and with DenRakEiw (GitHub DenRakEiw, German-speaking, answers in German).
A standalone desktop editor for AI inpainting: layers, selection by text,
retouch, filter layers, colour match per layer, text, PSD/ORA export. Local rendering
through the user's own ComfyUI, API rendering through fal.ai and direct providers,
SAM/RMBG in-app via ONNX. MCP-capable from the start. Windows first, Linux second.

The editor code came from the ComfyUI custom node **Inpaint Canvas**
(`F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-InpaintCanvas`,
GitHub `DenRakEiw/ComfyUI-InpaintCanvas`, GPL-3.0). **Since C0 (2026-09-13) `renderer/editor/`
in this repo is the source of the editor** and the node's `js/` is a build of it
(`python tools/build_node.py`, `docs/BUILD_NODE.md`); the node keeps its own `js/host.js`,
`js/inpaint_node.js` and `js/inpaint_bridge.js`. That repo stays the backend node and keeps
living. Read its `CLAUDE.md`, `DEVELOPMENT.md` (§1–23) and `GUIDE.md` before touching editor
code.

## Decisions already made (do not reopen without the user)

- Shell: **Electron** (identical Chromium on Windows and Linux; `ctx.filter` and canvas
  performance; Node process for `sharp` exports and the in-app MCP server).
- Local rendering: **the user's ComfyUI**, local or remote (RunPod). The app never
  bundles Python/Torch. The node pack must be installed there; the app checks
  `/object_info` and offers to install it via the Manager.
- API rendering: **fal.ai** as the aggregator, plus direct adapters (Black Forest Labs
  Flux.2, OpenAI gpt-image, Google Gemini image) and the ComfyUI API nodes as fallback.
  Keys in the OS credential store via Electron `safeStorage`, never in config files.
  Prompt upsampling runs on the same keys, or on a local OpenAI-compatible server
  (Ollama / LM Studio / vLLM, `settings.llm.compat`, no key needed).
- Helper models: **SAM2 and RMBG-2.0 in-app via ONNX Runtime** (DirectML on Windows,
  CUDA/CPU on Linux); model files downloaded into the app data folder **or** read from a
  linked ComfyUI `models/` folder. SAM3 stays a ComfyUI helper (no ONNX export).
- Recipes instead of graphs: the user picks "Flux.2 Klein local", "SDXL inpaint",
  "Flux.2 via fal" etc.; a recipe is a workflow template with a fixed Inpaint Canvas
  node id that the app fills and queues. Users can import their own workflow as a
  recipe if it holds an Inpaint Canvas node.
- MCP: the bridge commands from the node (`js/inpaint_bridge.js`, 46 tools) become the
  app's command core; `app.exe --mcp` runs the stdio MCP server in-process (TypeScript
  SDK); headless = the app without a window.
- Filters move to **WebGL2** (grain, curves, colour balance, LUT as shaders), CPU path as
  fallback; the same code goes back into the node.
- Film names: **keep the real names in the grain presets and the film pack**, own
  parametric values only (no manufacturer LUTs), disclaimer in the preset tooltip and
  the About dialog, never in product name or marketing; lawyer check before a sale.
- Plugins: **JavaScript plugins on the command core** (plugin folders with
  `plugin.json`, filter / panel / action / tool extension points), the film pack is the
  first built-in plugin; Python plugins later, not now. Plan in `docs/BRIEF.md` §5.
- Licence: **GPL-3.0** (decided 2026-09-09; `LICENSE`, `package.json`, About, README).
  The same licence as the node, no CLA, no dual licensing (that is also what the free
  SignPath Foundation signing requires). Only MIT/Apache/BSD/OFL dependencies in the app.
- Release channel: **GitHub Releases** of `DenRakEiw/scumble` (public since 2026-09-09).
  `electron-updater` reads `latest.yml` there; `.github/workflows/build.yml` builds the
  installer on `windows-latest` and publishes a **draft** release on a `v<version>` tag
  (the tag must match `package.json`); publishing the draft makes it visible to the app.
  **Every release needs its section in `CHANGELOG.md` first**: the workflow builds the
  release body from it through `tools/release_notes.py` and fails the tag build when the
  section is missing, and the app shows the same text in Settings › Updates before you
  restart into the new version.
  First releases are **unsigned**; code signing goes through the SignPath Foundation
  (free for OSS) once the project has a public release and some use, fallback Certum
  Open Source. Azure Trusted Signing is paid and not for individuals in the EU.

The session hand-over blocks that used to live here ("Where things stand / stood", 2026-09-09 to
2026-09-16) are in `docs/HISTORY.md`, newest first, verbatim. They are a record, not instructions.

## Where things stand (2026-09-20)

**2026-09-20: the two defects the OpenRouter session found are fixed, for 0.1.21** (`docs/BUGS.md` "Fixed, waiting
for its release"; CHANGELOG 0.1.21; `docs/RECIPES.md` "Import"). (1) **FLUX.2 [flex] on fal** carried
`num_inference_steps` and `safety_tolerance` both at `"index": 1`; measured in the app on the old file before the fix,
the panel showed two rows instead of three (no *Steps* at all) and the request went out as
`num_inference_steps: "2", guidance_scale: 2.5, safety_tolerance: "2"` - 2 steps instead of 50, and as a string. The
row is slot 3 now. (2) **A recipe with a `providers` map could not be imported** (`importFile` took only the old
one-provider shape): `hasVariants` takes either shape, an empty map and an array count as no provider and get a
message of their own, and `importFile` answers the **normalized** recipe as `list()` serves it - two defects of the
same path that came with it, because the Settings note read "Imported ... (undefined, 0 nodes, 0 settings)" for a
provider recipe (it names the providers now) and the refusal carried the IPC prefix (stripped, as the file's three
other handlers do). **New gate `recipes`** (`tools/recipes_test.js` in plain Node, then `tools/recipes_test.py` in
the app): every settings row of every shipped recipe owns its slot (1 to 8) and its key - 138 rows in 91 provider
variants plus the comfy recipes, the only shared slot in the tree was the FLUX one - and the importer in both shapes,
what stays refused, and the import through the Settings dialog end to end. A mutation round of **19 turned a check
red, all 19** (17 in Node, 2 in the renderer against a restarted app). Gates `--offline` on both backends
(`recipes pixels editor composite commands size transparent generate log mcp toapis openrouter ark llm`):
**ALL PASS on tiles and on the canvas backend**, each at the first try. **Found on the way and fixed:** the `toapis`
gate left the *window's* view of `gpt_image_2` on toapis while restoring the stored settings, which made the
`openrouter` gate red when it ran after it (`openrouter` alone on a fresh profile passed); its cleanup now puts every
recipe it switched back through `selectRecipe`, and the trap is in "Testing and benchmarking" below. **0.1.21 is
still unreleased** (0.1.20 is Latest); ComfyUI (8188) did not answer in this session, so the two points that need it
are still open.

**2026-09-20: the `buildModal` split (item 11) is built** (`docs/BUILD_NODE.md`, its file table and the module-cycle
note). `renderer/editor/inpaint_modal.js` (758 lines) holds `buildEditorModal(ed)` and one function per part -
`buildTopBar`, `buildTools`, `buildView`, `buildSidePanel`, `buildLayers`, `buildReferences`, `buildSelection`,
`buildCanvasPanel`, `buildExport`, `buildPrompt`, `buildGenerate`, `buildSettings`, `buildHistory`, `buildCrop` -
and the class keeps a four-line `buildModal()` that calls it; `inpaint_canvas.js` is 12,808 lines down to 12,126.
**The move is proven**, by a verifier written against the untouched copy (the session's scratchpad,
`verify_modal.js`): the module taken apart, `ed` read back as `this`, the indentation level put back, the pieces
returned to the method's order - **654 of 654 non-empty lines identical, 0 different**. What changed: `this` -> `ed`
at **524 places, in code only** (a scanner that knows strings, template holes, comments and regex literals, 14 tests
of its own; the 6 `this` in tooltip text - "Everything in this editor" - are untouched), one indentation level, 72
frame lines (heads, doc comments, calls, braces), and **one line that is not a pure move**: `pane = this.panes.gen;`
became `toGenPane()`, because `pane` is a closure of the side panel and the Generate tab is filled after it.
`inpaint_modal.js` imports the DOM helpers and `hostText`, `REF_FITS`, `REF_DEFAULTS`, `UPSAMPLE_CASES`,
`randomSeed` back from `inpaint_canvas.js` (now exported) and reads all of them inside functions only: the same
cycle rule as stage 1. **That one translated line had no gate**, so `editor_test.py` got
`every_panel_sits_in_the_tab_it_belongs_to` (Selection / Canvas / Export in the Image tab, Prompt / Generate /
Settings / History / Crop in the Generate tab, neither in the other, and the lists and bars present); four
mutations against a restarted app (no `toGenPane`, no Crop panel, no tool column, no reference list) all turn it
red. Gates `--offline` on both backends (`pixels editor composite commands shape brush film glb ailabel size
transparent generate log mcp recipes`, tiles also `nodecopy`): **ALL PASS**, at the first try. The dialog was also
looked at in a running app (no console error, every panel in its tab, the plugins' sections still arriving through
`ed.addSection`).

**2026-09-20: the assistant (item 13) is started - A0, the server split, is built** (`docs/PLAN_ASSISTANT.md`
"A0 as built", `docs/MCP.md`). `electron/main/mcp/server.js` now has `createServer(backend, opts)` beside
`serve(backend, opts)` (= `createServer` plus the stdio transport), exports `{ serve, createServer, toTool,
toolName, textOf, INSTRUCTIONS }`, and takes its `changed` listener off the backend again when the server closes
(the Bridge outlives an in-memory session; Node warns after ten). **Nothing an external agent sees changed, and it
is proven:** the server's info, capabilities, instructions and all 72 tools (62 core, 10 plugin) read through
`mcp_test.py`'s own client, in proxy and in headless mode, before and after the split - four reads, one md5
(`05837058b7b253f9156769bd89b9f14f`). **Not the plan in one point:** its `onclose` chain is gone, because nothing
sets `server.onclose` before `createServer` does (an unreachable branch; its mutation was the only one to survive).
`tools/assistant_test.js` is the new plain-Node test (section 1, 11 checks, including the listener over 20 sessions
and a child process that runs the real `serve()` on stdio and lists the same tools); 8 of 8 mutations red. Gates:
`node tools/assistant_test.js` PASS, `mcp` headless PASS, `mcp commands` on both backends ALL PASS. `--exe` was not
run: the package in `dist/win-unpacked` is 0.1.20, so that run belongs to the assistant's own release (A9).

**2026-09-20: A1 is built too - the loop, the policy, the registry and the Anthropic adapter, in plain Node**
(`docs/PLAN_ASSISTANT.md` "A1 as built"). Eight modules under `electron/main/assistant/`, none of which requires
Electron: `http.js` (the streamed POST, the retries only before the first byte, `scrub`, the test-key rule both
ways, and `loopbackBase` / `compatBase` / `refusesImage` written again from code that does not export them),
`sse.js`, `providers.js` (the ten providers, all marked "not tried with a real key"), `models.js` (the prices of
2026-09-19), `prompt.js`, `policy.js` (the whole §5 table as data, `clamp`, `undoStep`), `anthropic.js` and
`index.js` (the turn: pin, canonical arguments, policy, ask, the call through the in-process MCP client,
ownership by all three rules, the caps, Stop). **Two things the plan did not have, both found by the mutation
round:** a tool that takes a layer but no `doc` had its layer references sent unresolved (now `takesDoc ||
takesLayer`), and the pinned document closed **by the user** mid-turn is answered and ends the turn (the
assistant closing it itself only drops the pin). `node tools/assistant_test.js` is **98 checks** (sections 1 to
10 in their Anthropic shape, the policy table as 54 rows, the leading example, the golden request body); the
mutation round is **36 of 36 red**, after four survivors were each answered with a check or with the removal of
a branch `decide` already covered. Gates: the node test PASS, and `toapis llm mcp commands` re-run, which is what
proves `llm.js` and the command core are untouched. **Nothing is wired into the app yet** (that is A4): no IPC,
no panel, `bridge.run` still takes two arguments, so the assistant cannot be used from the window. **A2 followed the same day** (the next paragraph).

**2026-09-20: A2 is built - Chat Completions and its seven providers, in plain Node** (`docs/PLAN_ASSISTANT.md` "A2 as
built"). `electron/main/assistant/chat.js` is the one adapter; OpenRouter, DeepSeek, Moonshot (Kimi), Z.ai (GLM), ToAPIs,
WaveSpeed and the local endpoint differ only in the dialect data of `providers.js` (the reasoning field, the thinking
switch, the length field, where a screenshot goes, `stream_options` / `tool_stream` / `session_id` / `provider` /
`cache_control`, `strict: false` on Moonshot's tools, the final error codes with their plain words). Tool calls are
rebuilt by `index` and parsed at the end (a whole call in one delta and an `arguments` object too), one `tool` message
per call with an `Error: ` prefix on an error result, a screenshot inline on Moonshot and as one follow-up `user` message
elsewhere, the assistant message replayed as rebuilt with `reasoning_content` on every message (`""` when none came)
and OpenRouter's `reasoning_details` concatenated unmodified; usage read from either last chunk; the seven final
answers (the 402s, Moonshot's quota and daily limit, Z.ai's 1113 / 1261 / 1301) never retried, the overloads and rate
limits retried like any 429. **Not the plan's word:** `openrouterIgnore()` delegates to the image adapter's
`chinaHosts` (one fetch of the host list per session for both, its seven-host dated list); `checkKey` got `localOk`
for the local server's own key, which goes to a loopback URL by nature; `index.js` reads the tool schema from a
family-neutral `chat.schemas` map (A1's lookup used the Anthropic tool shape, so on any other family `doc` would never
have been injected and no layer reference resolved: a latent A1 defect, caught by the first chat-family run); the 18 MB
cap holds for `google/*` and `gemini-*` ids on any provider; an answer that is not an event stream and a stream that
ends empty are errors, not empty turns. **Tests:** `node tools/assistant_test.js` is **179 checks** (sections 11 to 15
new: the golden body of every provider, the loop per dialect, the reasoning replay across turns, images in both
places, the local server's image fallback, keys and hosts, the final answers, cost, and the same answer cut at every
one of its 1,857 byte offsets); a mutation round of **95 against a copy of the tree** (the scratchpad's `mutate_a2.js`),
**all 95 red** (77 of the first 80 at the first run; the three survivors and the review's gaps each got a check).
**A review of four lenses with two refuters per finding (27 findings, 22 held, 5 fell) fixed ten things, four of them
A1's:** a stream that ends before its `finish_reason` pushed its half answer as the answer (on Anthropic too; now an
error that pushes nothing); pruning ran at every new user message once more than `keepImages` were attached instead of
above twice that (the plan's batches); `refusesImage` was wider than `llm.js`'s rule, so a local server's 400 about an
unsupported parameter would have stripped every screenshot and turned `screenshot` off; the "(stopped)" line stood
twice in a pending user message. A2's own: a refusal with calls left them unanswered (every later request a 400), a
server without `index` merged or split its calls, an `arguments` array ran as a tool's arguments, two error paths in
the adapter were unscrubbed, a failed host-list read was asked again before every call. Rejected: `reasoning` for
every curated OpenRouter model (kept; the live list is A4's), the truncated error body (`err.body` is whole), the
`localOk` gap (already red in the mutation round). Gates: the node test PASS, `toapis llm` `--offline` ALL PASS
(`a2-node`, and `a2-node2` after the fixes). **Nothing is wired into the app yet** (A4), and no dialect has run against a
live key. **Next was A3** in the plan; the user asked for A4 first ("jetzt a4 verdrahten"), which is the next paragraph.

**2026-09-20: A4 is built - the door between the window and the loop, with its review worked through**
(`docs/PLAN_ASSISTANT.md` "A4 as built" and "A4, the review and what it changed"). Built **before A3**, on the
user's word ("jetzt a4 verdrahten"), for the two families that exist; OpenAI and Gemini stand in the picker as
"not built yet" until A3 lands. **IPC** in `main.js` (`assistant:send` / `stop` / `answer` / `reset` /
`state` / `models` / `openrouterModels` / `tools` / `noticed`, the instance made at the first call so the SDK is
not loaded at start, every event of the loop on `assistant:event`), `window.scumble.assistant.*` and
`commands.onCancel` in the preload, **`bridge.run(name, args, meta)`** with `commands:cancel` for a request the
turn abandoned while it waited, the shell's handler reading `meta` (a request without `meta` takes the old path
byte for byte), **`renderer/assistant_wait.js`** (the user-activity wait), `DEFAULTS.assistant` in `settings.js`,
the relaunch refusal and `before-quit`, and **three key rows** (DeepSeek, Moonshot / Kimi, Z.ai / GLM; `docs/HELPERS.md`).
**`tools/assistant_mock.py`** plays all four families (Responses and Gemini already, for A3) and
**`tools/assistant_test.py`** is the new gate `assistant`, which refuses a profile that holds a key and an instance
connected to ComfyUI, and goes last in a list. **The review** (six lenses, two refuters per finding) was cut short
by the other session's usage limit - 36 findings, 16 of 72 verdicts - and this session read the workflow's journal
and judged the rest by reading. **Fixed:** the non-atomic "a turn is running" guard (two sends in the
`connect()` / `newChat()` window started two loops on one chat, the first unstoppable); **a file drop left the
Bridge dead for the whole session** (Chromium announces the navigation before `will-navigate` can prevent it, the
Bridge dropped `ready`, and no `commands:ready` ever came again: measured, an external `--cmd ping` then timed out
at 40 s; `attach()` takes the same rule now); the two plugin reads taking the user-activity wait (the Bridge is
called with command names, the policy's sets hold tool names); `state()` blocking up to 120 s on a renderer that
is not ready; **every assistant log line written empty** (`text` where `log.record` reads `message`, and the test's
own stub had the same typo); `lastTurn` set for read-only turns; the stale tool diff after `reset()`; OpenRouter's
live list cached across a change of base; the local server's key ignoring the test-key rule; and in the wait, a
closed tab's editor kept alive, the wrong document judged, and `upsample_prompt` overwriting a prompt the user was
typing. **The gate's own three:** its cleanup deleted **every key row even when the setup had refused to run on a
profile holding the user's real keys**; the reload step wiped the state the cleanup relies on (it is in Python now,
and the cleanup brings the window back to the app when a step took it off); `Mock.reset()` cleared the failures the
runner reads, so after the first failure every later one was invisible. `node tools/assistant_test.js` is **192
checks**, the gate **19 steps**, the mutation rounds **17 (the build) and 16 (the fixes), all red**. Gates
`--offline` on both backends (`llm toapis log generate mcp commands editor assistant`): **ALL PASS**
(`a4b-tiles`, `a4b-canvas`). **Trap worth keeping:** a page on a custom scheme cannot navigate itself to a `file:`
URL, so a `file:` probe proves nothing about a drop; the probe is an `https` URL on a dead local port.
**A3 followed the same day** (the next paragraph).

**2026-09-20: A3 is built too - OpenAI Responses and Gemini, the last two families**
(`docs/PLAN_ASSISTANT.md` "A3 as built"). Built **after A4**, so both adapters went into a loop the app
already drives: the picker's "not built yet" is gone for OpenAI and Google, and the gate runs a turn on
**all four families** (`every_family_runs_a_turn_in_the_app`: anthropic, openai, gemini, openrouter,
deepseek, moonshot, zai, toapis, wavespeed, compat). **`responses.js`**: the history is a list of input
*items*, not messages; items are taken whole from `response.output_item.done` and never rebuilt from the
deltas, `store: false`, a screenshot in the parts form of `output` (`input_text` + `input_image`), an
error result prefixed `Error: `, `response.incomplete` a cut, a `refusal` part a refusal, a stream
without a terminal event pushes nothing. **Not the plan's word:** the request also asks for
`include: ["reasoning.encrypted_content"]` (the plan says `store:false` returns it by itself and §7 lists
that as unverified; asking costs nothing if it does and is what makes the replay work if it does not).
**`gemini.js`**: `generateContent` with `x-goog-api-key`, the model's parts sent back in their order and
**never merged** (a `thoughtSignature` stays on its part), tool results one user content of
`functionResponse` parts, a screenshot an `inlineData` part inside that response with the JSON answer
pointing at it by `displayName`, `MAX_TOKENS` a cut, the block reasons refusals, no `toolConfig`, and the
registry's 18 MB cap. **Three things the plan did not have:** `appendUserText` per adapter (the loop adds
a stopped turn's text to the pending user message, and A1's helper writes Anthropic-shaped parts, which
neither new family takes); a `functionCall` without an `id` must not be answered with the loop's own id
(`rawId`); and a `functionResponse.response` is a struct, so an array or scalar result goes in under a
name. `node tools/assistant_test.js` is **214 checks** (section 17), the mutation round **26 of 26 red**,
gates `--offline` on both backends (`llm toapis log generate mcp commands editor assistant`) **ALL PASS**
(`a3-tiles`, `a3-canvas`). **Nothing has run against a live key.**
**The checkpoint ran the same day** (the next paragraph).

**2026-09-20: the checkpoint ran, in the short form the user asked for** (`docs/PLAN_ASSISTANT.md`
"Checkpoint as run"; the user: "so viele tests brauchen wir nicht nur ganz kurz die funktion ... nur ein
kurzer call je modell maximal um verdrahtung zu testen"). One live turn per model against the real hosts,
on a scratch profile. **The keys the user holds are Anthropic, OpenAI and Google** (plus bfl, fal,
replicate, comfycloud for the image providers); **no key for the Chat Completions family**, which stays
"not tried with a real key". What the hosts answered: Anthropic **401 `authentication_error`** on both
models, OpenAI **401 `invalid_api_key`** (the stored key does not have OpenAI's `sk-` shape), Google
**429 `RESOURCE_EXHAUSTED`, "Your project has exceeded its monthly spending cap"** - which means that
request **authenticated**. So every family builds its request from the settings, reaches its real host
over the real key, reads the answer, keeps the key out of the error and ends the turn cleanly; **no
model could pay for a task, so there is no go or no-go per model yet.** **Found and fixed on the spot:**
a 429 that will never clear was retried (15.3 s of four identical refusals, and raw JSON as the error);
`gemini.js`, `responses.js` and `anthropic.js` now have `finalWords(status, body)` like `chat.js`'s
dialects - a spending cap, an empty account, an invalid key and a model the provider does not serve are
final and **read as a sentence**, a plain rate limit is still retried; measured live again, all four
rows answer in **0.5 to 0.6 s**. `a_final_answer_is_not_retried_and_reads_as_words` is the check (four
mutations red), the node test is **215 checks**, gates `--offline` on both backends (`llm toapis mcp
commands assistant`) **ALL PASS**. **Trap worth keeping:** on Windows `safeStorage` encrypts with a key
that lives in `<userData>/Local State`, so a scratch profile holding a copy of `secrets.json` alone
decrypts nothing and every row reads "no API key" - copy both. **What the user has to decide:** a
working key (Anthropic, OpenAI, Google - or an OpenRouter key, which would also cover the Chat
Completions family), then the five-task form of the checkpoint costs well under a dollar. **The user's
word (2026-09-20): "hab gerade keinen key, lass uns das testing ueberspringen, machen wir nach release
mach dann eh extreme bug suchen"** - so the model-by-model verdicts wait for the release and the user's own
bug hunt, and building went on with A5.

**2026-09-20: A5 is built - the panel** (`docs/PLAN_ASSISTANT.md` "A5 as built"). `renderer/assistant.js`
(about 600 lines) and `assistant.css`, a `<dialog id="assistant">` in a new `#shell-main` row of
`index.html`, a bar button, **View > Assistant (Ctrl+Shift+A)**, and **`tool_end`** as a new event of the
loop. The plan's three rules hold: a non-modal `show()` (the canvas stays usable, the panel stays out of the
top layer), **one window capture `keydown` listener** registered at shell start so it runs before any editor
question's, and **no markup written anywhere** (`renderText` builds with `createElement` and `textContent`;
the Node check `no_markup_writes` holds the file to it). The picker is grouped by provider, a provider
without a key greyed out, models marked ("cannot look at the picture", "not tried with a real key"), a free
OpenRouter id from the live list; the chat shows bubbles, streamed text rendered once when the block ends,
tool cards (`running`, `done in N s`, the result in a `<details>`, a screenshot thumbnail) and ask cards
with the policy's reason, the file, the recipe and old > new values, **neither button a default**; an ask
opens the panel by itself. **Three things the plan did not have and one it had wrong:** `tool_end` (the
panel cannot say what a call did without it; `state()` strips its data URL so a reloaded panel carries no
base64 over IPC); **a call id is unique inside its turn, not the chat** (every family numbers per request,
so `tool_end` found an older turn's card - the cards live in a `Map` the turn empties; the gate found it);
**Escape and the focus guard fought each other**; and the plan's `keepFocus` flag is set by a focus event
**a window in the back never gets** - the guard reads the `focusout` instead. Gate: **five new steps, 24 in
all**; a mutation round of **13, 10 red** (the three green ones are each a rule a second rule already
covers, written down). Gates `--offline` on both backends (`editor composite generate transparent size log
mcp commands assistant`): **ALL PASS** (`a5-tiles`, `a5-canvas`). **Trap worth keeping:** Chromium delivers
**no focus or blur events at all** to a window that is not focused, and a gate runs behind the terminal:
`focus()` moves `activeElement` silently, so a focus test has to dispatch the `focusout` the real app would
fire. **Next: A6** (chats on disk and the reset), then A7 (undo per step and per turn), A8 (the whole gate
and the docs), A9 (the live check and the release).

## Where things stand (2026-09-19)

**2026-09-19, evening: OpenRouter (item 12) is built, for 0.1.21** (`package.json` 0.1.21, `CHANGELOG.md` "0.1.21 —
unreleased"; `docs/RECIPES.md` "OpenRouter", `docs/HELPERS.md` "Through the OpenRouter key"). **Not the item's plan:**
the image adapter (`electron/main/providers/openrouter.js`) uses OpenRouter's unified Image API, `POST /api/v1/images`
(`input_references` as data URLs, `b64_json` back, `usage.cost`), because the current docs describe only that route
for images; the chat `modalities` route has no guide any more. Only the parameters each model's endpoints list in
`GET /api/v1/images/models` go out (`options.accepts`), no pixel size (no model lists `size`), an edit sends no
`aspect_ratio`, *Resolution* auto takes the smallest tier covering the crop; no mask field exists, so GPT Image and Nano
Banana get the mask as a second picture (as the Gemini adapter), FLUX.2 / Seedream / Grok an instruction edit, Krea 2
and Recraft V4 are text only. `openrouter` is a variant in 14 recipes, **last** in each (no default changed), the key
row after Comfy Cloud, `TEXT_PROVIDERS` has it. Four upsampling rows (Gemini 3.8 Flash, GPT-5.6 Luna, Claude Haiku 4.5,
Mistral Small 4) with a per-row `reasoning` switch and `provider: { data_collection: "deny", ignore }`. **Privacy:** no
attribution header on any request (the trademark check); every image and chat request carries `provider.ignore` with the
hosts OpenRouter lists in China (`GET /api/v1/providers`, once per session, a dated fallback list), so **Qwen Image 3 is
not offered** (its only host, Alibaba, has a CN datacentre); Nano Banana Pro's 4K goes only to Google AI Studio
(`options.only_for` -> `provider.only`). Host rule: `settings.openrouter.base` is openrouter.ai or a loopback mock only,
a `test-` key goes only to the mock and a real key never there. *check balance* reads `GET /api/v1/key` (the key's own
limit, the period's use; the account's credits need a management key). Retries: 429, 529, an overloaded 503 and the
in-flight 402 once, never before `Retry-After`, not at all past 60 s ("try again in N s"). **On the way, for every
provider:** `llm.ask()` takes the key out of every upsampling error (it was left in on the direct OpenAI / Gemini /
Anthropic adapters and in ToAPIs' errors), and the OpenAI-compatible client throws on a refusal (`content_filter` /
`message.refusal`) and on `finish_reason: "error"` instead of returning partial text. **Tests:** `node
tools/openrouter_test.js` (12 sections, 168 checks), gate `openrouter` (`tools/openrouter_test.py` against
`tools/openrouter_mock.py`); a final mutation round of 95 mutations (the scratchpad's `or_mutate3.js`) turned a test red
for every one. Gates `--offline` on both backends: `openrouter toapis llm generate size transparent mcp log` ALL PASS
(after the last code change `openrouter toapis llm mcp` again). Two reviews (four lenses, then three, two refuters per
finding) found 13 and 8 defects, all fixed or written down. **Not run against the live API**: the user's key decides
what `docs/RECIPES.md` "Only a real key can verify" lists. Found on the way and filed, not fixed (`docs/BUGS.md` "What
OpenRouter (item 12) found on the way"): FLUX.2 [flex] on fal has two settings rows at index 1; a model recipe with a
`providers` map cannot be imported.

**2026-09-19, later the same evening: BytePlus ModelArk (item 12b) is built, for 0.1.21 too** (`docs/RECIPES.md`
"BytePlus ModelArk", CHANGELOG 0.1.21). `electron/main/providers/ark.js`: `POST <host>/api/v3/images/generations`,
synchronous, `image` as lowercase data URLs, **`size` always `WxH`** (the crop's own shape inside the model's
method-2 pixel range; a text run exactly the dialog's aspect), **`watermark: false`** (the default is true),
`response_format: "b64_json"`, `output_format: "png"`; no mask (instruction edit), no seed, no `n`. An `ark` variant
right after `toapis` in `seedream_5_pro` (`dola-seedream-5-0-pro-260628`, 0.92 to 4.6 MP, 10 pictures, Johor only)
and `seedream_5_lite` (`seedream-5-0-260128`, 3.7 to 16.8 MP, 14 pictures, a *Region* row ap-southeast Johor /
eu-west Dublin, `limits.max` 7680 so a 16:1 crop reaches the floor); **fal stays the default** of both. The host
comes only from the region (two fixed hosts, own-property lookup), `settings.ark.base` is a loopback mock only,
with the same `test-` key rule as OpenRouter. Pictures checked before sending (16:1, > 14 px, 36 MP, 30 MB with a
JPEG fallback for opaque ones); retries only for `ModelAccountIpmRateLimitExceeded` / `ServerOverloaded`, never
before `Retry-After`, not past 60 s. **Not run against the live API**; a model must be activated in the console, a key
works only in its region, some accounts need an endpoint id (not supported). **BytePlus' country list (21 April
2026) has Germany and the EU but not the United States** (the user said "bin eu / usa"). Tests: `node
tools/ark_test.js` (161 checks), gate `ark` (`tools/ark_test.py`, `tools/ark_mock.py`); a mutation round of 117
(the scratchpad's `ark_mutate.js`) all red. One review round (three lenses, two refuters each): 10 findings, the 7
that held fixed (the 401 / `InvalidAccountStatus` / `QuotaExceeded` words, the exact text-run aspect, the pro note's
Dublin sentence and input fee, the privacy wording with Indonesia, lite's 16:1 floor, `select_recipe`'s list).
Gates `--offline` on both backends: `ark openrouter toapis llm generate size transparent mcp log` ALL PASS.

**0.1.20 is published** (Latest since 2026-09-19, on the user's word; `latest.yml` on the feed says 0.1.20, the release
body is the CHANGELOG section): `package.json` 0.1.20, `CHANGELOG.md` "0.1.20 — 2026-09-19", `npm run dist` built
`Scumble Setup 0.1.20.exe`, the tag `v0.1.20`, CI's draft published (check `gh release list` before believing any
release state written down anywhere). Exe gates,
all `--offline` against `dist/win-unpacked/Scumble.exe`, each on its own profile: `rel20-exe` (tiles: log pixels editor
composite commands shape brush film glb ailabel size transparent generate mcp toapis llm export pxjobs), `rel20-exe-canvas`
(tiles off: pixels editor composite commands shape brush film size transparent generate) and `rel20-exe-huge`
(`huge:30000x20000`) ALL PASS at the first try. On a huge document the provider crop still takes the canvas fallback
(`readBoxBytes` skips the stack above the canvas limit): 552 ms blocked at 30k in `huge_test`, not the user's size.

**2026-09-19, the session after 0.1.19 (what 0.1.20 carries).** Three of the four daily-use bugs are fixed, each
with a gate step, mutations and both backends' gates ALL PASS (`docs/BUGS.md` "Fixed, waiting for its release"):
large JPEG / WebP / profiled PNG files open through a pool worker (`image_read`; the block at 15k 0.95 to 4.4 s down to
34 to 98 ms, the same bytes), a provider run's crop and stitch run in a stitch worker of their own with the box from the
tile workers (`prepareCropAsync` / `finishResultAsync`, `readBoxBytes`, `stitch_worker.js`; 0.67 / 1.47 / 6.28 s blocked
on a plain / matched / matched-and-filmed 15k document down to 24 / 22 / 51 ms), and on tiles a stroke is committed a
tile at a time through the compositing kernel (`commitStrokeTiles`, `compositeStroke`; the release 70 to 288 ms down
to 34 to 66 ms, `tools/release_test.py` is the new measurement with real mouse events). The fourth ("erasing switches
the active layer to the base") is closed on the user's word (2026-09-19: "bug ist beim letzten test nicht
aufgetreten"): the report's recordings pointed at the display bug fixed in 0.1.8. **`smoke` ran** (the user freed ComfyUI for an hour): on the dev
tree with the three fixes in, tiles and canvas backend with `--no-helpers`, and once in full with every helper (SAM3,
RMBG, Qwen-VL, SAM2 on the server; the in-app SAM2 / RMBG were skipped: no model in a fresh profile), ALL PASS; and a
local run on a 6000 x 4000 document with a soft, a matched and a levels layer: the base went up in bands through the
filter program and reached the node byte for byte (its hash recomputed), the result landed at the crop box. **Found
there:** the node's own stitch spent 15 of the run's 19 minutes on one CPU core (a square `max_pool2d` over the whole
picture's mask); a byte-equal fix (separable dilation, masks on a window) is prepared and tested in that session's
scratchpad and, on the user's word, **committed and pushed in the node repo (`fba1fd8` on master); it goes live in the
user's ComfyUI with its next restart, which the user does** (`docs/BUGS.md` "A local run on a large document spends minutes in the node's
stitch"). Not done: the node in a real ComfyUI tab and in
Firefox (the node repo is behind; building the editor into it is a node release).

**Releases.** **0.1.19 is published** (Latest since 2026-09-18, `v0.1.19`, the CI draft published from this session on the user's
word; `latest.yml` on the feed says 0.1.19, the release body is the CHANGELOG section; no `smoke`; exe gates, all `--offline` against `dist/win-unpacked/Scumble.exe`: `rel19-exe` (tiles, the full list with pxjobs) ALL
PASS, `rel19-exe-huge` (`huge:30000x20000`) PASS, `rel19-exe-canvas` (tiles off: pixels editor composite film export)
ALL PASS on the rerun `rel19-exe-canvas-b` of editor and film, whose first run failed on the live stroke's pointer
message and the film panel's thumbnails (0 of 5 rendered) while the user was at the machine; no `smoke`, on the user's
word). **0.1.18 is published** (Latest since 2026-09-18, published by the user's word at the end of the part 3
session; `latest.yml` on the feed says 0.1.18, the release body is the CHANGELOG section). **`package.json` is 0.1.19
and `CHANGELOG.md` has the 0.1.19 section**, with B item 7 part 3 (item 10 below; committed, pushed, CI green on
2026-09-18) and the `set_layer match_source` fix. 0.1.18 carries B items 1 to 5 and item 7 parts 1 and 2. Exe gates for 0.1.18, all `--offline`: `rel18-exe` (log pixels editor
composite brush film export toapis mcp pxjobs), `rel18-exe-canvas` (tiles off: pixels editor composite film export) and
`rel18-exe-huge` (`huge:30000x20000`) ALL PASS, three of them on a rerun, each a known flake (the settled-read step and
the 1200 x 794 composite canvas together in the first seconds of one exe instance; the live stroke step on the canvas
backend). **`smoke` was not run** (the user's ComfyUI). **0.1.17** (published 2026-09-17) carries phase E
(E1 to E5). Exe gates for 0.1.17, all `--offline`:
`rel17-exe` (log pixels editor composite brush film export toapis mcp pxjobs), `rel17-exe-huge` (`huge:30000x20000`) and
`rel17-exe-canvas` (tiles off: pixels editor composite film export) ALL PASS; CI's `build_px.py --check` passed with the
crate's new dependency (miniz_oxide). **`smoke` was not run** (the user's ComfyUI was busy); instead Pillow 12.2 from the
ComfyUI's own Python read a PNG joined from parts (pixels exact, tEXt intact, `verify()` ok). Check `gh release list`
before believing any release state written down anywhere.

**Phase E is built** (2026-09-17, `docs/PLAN_BCE.md` §3 "E1 as built" and "E2 to E5 as built", CHANGELOG 0.1.17).
What it is, because it is **not the plan's design**: there is no second compositor in the workers. A band of an export is a
**region pass at full resolution** (`sampleRegion` at scale 1 with `boxReach`'s margin, `readBand`), and the worker pool
(`renderer/editor/inpaint_pool.js`, up to 8 workers started on demand, priorities, `cancel(group)`, `progress` replies) does
everything that is not compositing: PNG parts (a Rust deflate with a sync flush per part, joined into one zlib stream:
`inpaint_png.js`), PackBits for PSD, CRCs for ORA, hashes, PNG decoding as a stream, the mip chains. Tiles live in a
SharedArrayBuffer arena (`inpaint_arena.js`) and workers read them by (chunk, slot). `inpaint_bands.js` holds the row sources
and the PNG / PSD / ORA writers. Filters of the whole picture take `info.full` / `info.origin` / `info.stats`. A document
may be larger than any canvas (268 MP): up to 65,535 px a side and a gigapixel, PNG only, opened through the stream reader;
`tools/huge_test.py` is its gate (30000 × 20000: open 9.6 s, PNG 10.5 s, PSD 13.7 s). **Not met and written down in
`docs/BUGS.md`**: an export in bands is slower in wall time than the whole flatten was (6.2 s against 3.4 s at 15k, the
window stays usable), the halation on huge documents, invert at 30k, the 5 ms of the mip refresh. **`smoke` ran on it on
2026-09-19** (see the top of this section): the base upload in bands and a real run met the user's server, PASS.

**Built.** C6 (c) slices 3 to 7a, each with its gates, mutations and measurements in `docs/PLAN_BCE.md` §C6 ("C6 (c3) and
slice 4 as built", "slice 5 / 6 / 7a as built"). The tile engine is on by default in the installed app since 0.1.13, with a
switch in Settings › Rendering; the canvas backend is the escape hatch.

**Constraints right now.**
- **The user needs their ComfyUI instance** (2026-09-16; freed for one hour on 2026-09-19, when `smoke` ran): no `smoke`,
  and no gate that forwards to it (`commands`' `large_upload_route` uploads through the mirror to a connected ComfyUI),
  until the user says it is free.
- **A headless MCP instance can block the app from starting** (`docs/BUGS.md`): this repo's `.mcp.json` starts the dev app
  with `--mcp`, which holds the default profile's single-instance lock, and Scumble then shows no window. Stopping the
  `electron.exe ... --mcp` processes fixes it; the missing hand-over is not measured.
- **§C7's memory gate is not met** (at most 300 MB of GPU process per document); the default went on anyway, on the user's
  decision.
- **The node repo is behind** (its `js/` is built from 7f01699, before C3; master is fba1fd8 since 2026-09-19, pushed:
  1f37ad0, `exportIsPlain` in the node's own `js/host.js`, which the editor asks for since E2 and `build_node.py --check`
  insists on, and fba1fd8, the stitch's masks on a window and a separable dilation, live in the user's ComfyUI after a
  restart; `pyproject.toml` unchanged, so no registry publish ran). `nodecopy` builds and tests it in a scratch copy; build it into
  the real repo only when a node version is meant to ship.

**What comes next, in order** (`dist/c6map/c/` holds the maps; they are older than the code):
1. **7b is built** (2026-09-16, `docs/PLAN_BCE.md` §C6 "C6 (c) slice 7b as built", CHANGELOG 0.1.16): a matched layer on
   tiles is matched in the part a pass shows from its tiles; 1144 MB of mirrors and 837 ms of first frame at 1:1 gone at 15k.
2. **7c is built** (2026-09-16, `docs/PLAN_BCE.md` §C6 "C6 (c) slice 7c as built"): one statistics entry per layer for every
   pass, provisional while chains are in the worker. **The (b) numbers are measured and not yet shown to the user**
   (same section): box means 0.81 levels mean over 32 cases, 5.45 / p99 12 on one textured photo; point samples 0.56, max 8.
3. **7d is built** (2026-09-16, `docs/PLAN_BCE.md` §C6 "C6 (c) slice 7d as built"): the match in the atlas shader.
4. **C6 (d) is built** (2026-09-16, `docs/PLAN_BCE.md` §C6 "C6 (d) as built"): the base is `{ ref, px }`, no <img>.
5. **The object tool's bigger change A** (`dist/c6map/c/objects.md` §7 to §9: the image-size label map, the per-object
   shape canvases): ask the user where it goes.
6. **C4 is built** (2026-09-16, `docs/PLAN_BCE.md` §C4 "C4 as built"): steps on whole tiles, `release()`, exact redo boxes.
7. **The rest of §C7 went as far as it could** (2026-09-16, `docs/PLAN_BCE.md` §C7 "The rest of §C7, as far as it went"):
   docs, `--disable-gpu`, the memory walk (not met: +0.6 to +1.4 GB of GPU process per open 15k document on tiles), the exe
   gates (PASS). **Open, needing the user's ComfyUI:** the node in a real ComfyUI tab and in Firefox, `smoke`, `commands`.
   **Open, needing E5:** the 30k gate. **Next, when the user says so:** a release (0.1.16 has its CHANGELOG section).
8. **Phase R is built** (2026-09-17, `docs/PLAN_BCE.md` §2b "Phase R as built", `docs/PERFORMANCE.md` §12 and §12.1):
   **the user's rule is Rust wherever it is faster, however little** (the 3× rule is gone). Every pixel kernel runs from
   `renderer/editor/px/px.wasm` through `px/kernels.js` in the window and both workers, grow / shrink and the flood as one
   whole-job call each; the JS twins are the fallback (`InpaintEditor.kernels = "js"`). `python tools/build_px.py` rebuilds
   the binaries (commit them; `build.yml` checks them), `node tools/px_test.js` and `python tools/px_jobs.py --check` are the
   gates.
9. **Phase E is built** (2026-09-17, see above). Its open ends are in `docs/BUGS.md` ("What phase E left open").
10. **Phase N is measured and decided** (2026-09-17, `docs/PLAN_BCE.md` §3b "N1 as measured, N2 costed, N3's
   recommendation", `docs/PERFORMANCE.md` §14; `tools/native_test.py` and `tools/native_limits.py` are the tools, run on a
   fresh `--no-comfy` instance). At 15k the browser's share of the wall is a half to 85 % on five rows (open, grow /
   shrink, the wand, PNG and PSD export) and nothing on pan, zoom and stroke frames; all of it is the editor moving tiles
   through canvases, which workers over the arena can do without (option B, about 3 weeks, six items in order). Typed
   arrays end at **15.5 GB** in the renderer (18 full 15k layers), not 8. **The user's decision (2026-09-17): stay on
   Electron and build B; no native tile store, no native editor. The user works up to about 15k**, so B's item 6
   (one-channel masks) goes last and 30k is not the size to tune for. **B item 4 is built** (2026-09-17, same
   section, "B item 4 as built"): `dilateMask` / `boxBlurs` as kernels (ABI 7, `crates/px/src/maskf.rs`), a provider run's
   crop 2.5 s to 0.57 s with the same floats; `node tools/stitch_test.js` is its gate beside `px_test.js`. **B item 1 is built** (2026-09-17, "B item 1 as
   built"): a plain stack (no filter layer, blend mode or colour match) is composited by the pool's workers from the
   arena while they pack it (`stackPlan` / `stackSource` next to `boxReach`, `stackRows` in `inpaint_bands.js`,
   `rowsOfStack` in the worker); 15k PNG 3.5 s to 1.7 s, PSD 3.9 s to 1.3 s, within two levels of the flatten
   (`export_test.py`). `InpaintEditor.stacks = false` forces the bands. **B item 2 is built** ("B item 2 as built"): the
   wand and the bucket on a plain stack flood a `SharedArrayBuffer` the pool composited from the tiles (`floodStack`,
   `floodOverTiles`, worker `stack_into` and `flood` with `sab`), and the wand's answer comes back as selection tiles
   (`applyTilesToSelection`); 15k wand 4.2 s to 1.4 s, the block 1.6 s to 0.18 s, the same selection bytes
   (`editor_test.py` `the_flood_over_tiles_is_the_flood_over_canvases`). **B item 3 is built** ("B item 3 as built"): grow,
   shrink and feather read the selection's box from its tiles in a pool worker and send back the tiles that changed
   (`selectionOverTiles`); 15k grow 0.72 s to 0.51 s, shrink 0.60 s to 0.32 s, the blocks 0.2 s to 0.09 / 0.02 s; grow
   and shrink the same bytes, feather within 5 levels of alpha (the GPU blur). Invert stays on the main thread (0.2 s).
   **B item 5 is built** ("B item 5 as built"): `png_unfilter_rows` (ABI 8) undoes a band of PNG row filters in one
   call, and every plain 8-bit PNG of 32 MP and more (no `iCCP` / `gAMA` / `cHRM`) opens through the stream reader
   (`InpaintEditor.pngStreamFrom`); 15k open 3.2 s to 2.7 s, the block 2.1 s to 0.12 s. The reader is bound by the
   browser's inflater, not by JS as N1 said. **Item 6 (one-channel masks) is set aside by the user
   (2026-09-17): it is the 30k item, the user works up to 15k. Next instead, agreed the same day: B item 7, the worker
   path for the stacks it turns away today, in this order: blend modes in `composite_tile`, filter layers over
   worker-composited bands, a colour-matched layer** (`docs/PLAN_BCE.md` §3b "B item 7"). **Parts 1 and 2 are built**
   (2026-09-18, the night before the release, on the user's standing instruction to build up to 0.1.18 without asking
   again; same section, "B item 7, part 1 / part 2 as built"). Part 1: the eight blend modes in `composite_tile` (ABI 9),
   **rounded once per channel** (exact 16-bit products; within half a level of the exact value, where three rounded
   products were 1.45 off and moved the wand's edge): 15k with a multiply layer PNG 3.4 s to 1.6 s, PSD 3.8 s to 1.1 s,
   the wand 3.9 s to 1.1 s with the same pixels selected. Part 2: **a stack with filter layers anywhere in it is a
   program** (`stackPlan({ filters: true })`, `holdStack`, `programStart` / `programFinish`, `bandSource`): the pool
   composites a band with the filters' reach into a `SharedArrayBuffer`, the bytes go to the GPU as a texture
   (`surfaceFromBytes`), the filters run as in a pass at full resolution, the rows come back once (`readSurfaceBytes`),
   layers above a filter and a filter at an opacity, in a blend mode or through a mask are composited over the result by
   the pool again (a stack layer may be bytes, `sab`); the next band is composited while this one is filtered. Three
   paint layers and a levels layer at 15k: 6.2 s to 1.4 s; with the film look 9.1 s to 5.0 s (block 1.2 s to 0.13 s); the
   wand on a filtered document 3.3 s to 1.5 s. The region pass is the fallback (`NO_PROGRAM`) and keeps its own gate
   (`InpaintEditor.stackFilters = false`, `stackBlends = false` are the A/B switches). Against the flatten: one level on
   1.1 % of the bytes below a filter, a filter never more than one level above what the pass shows. **Part 3 is built**
   (2026-09-18, after the 0.1.18 tag, for 0.1.19; same section, "B item 7, part 3 as built"): a colour-matched layer
   is an entry of `stackPlan` (`match: layer`); `holdStack` is async and takes its statistics from **point samples of
   the tiles** (`stackMatches` / `stackMatchOf`, worker job `stack_points`, the grid of `matchGeometry`, the unchanged
   `statsOfMatch`; kept in `_mstatsStack[Run]`), and the worker matches the rows before `composite_tile`
   (`match_pixels`, ABI 10, `crates/px/src/cmatch.rs`, bit for bit with its twin). 15k with a 5,000 × 3,500 matched
   layer: PNG 6.4 s to 1.8 s (block 1.45 s to 84 ms), PSD 1.8 to 1.0 s, wand 2.5 to 0.9 s. Against the whole
   flatten's statistics on four of the user's photos: mean 0.1 to 2.0 levels, max 7 (the textured landscape); with
   the same statistics the two paths are within 2 levels. Turned away still (the whole flatten as before): a matched
   layer above a filter layer, `readBox` (a provider run's crop), JPEG and WebP, the flatten into the base of a plain
   matched stack; `InpaintEditor.stackMatch = false` is the A/B switch. A design review (three lenses, 12 confirmed
   objections) made the grid integers, stamped the statistics with the clones' version, took the layer's own samples
   over the picture's edge, and gave the job a byte-exact gate (`stack_points_gathers_the_samples_it_names`); the
   same section, "After the design review". A scaled or a fractional layer still saves the old way. Not done
   in part 2: the longest block (0.15 s against the plan's 0.05), an asynchronous read, a mask folded into the alpha
   (a filter at an opacity through a mask is a level off on 18 % of the bytes). Each item is measured
   against its row in `tools/native_test.py` before and after, bytes equal to the path it replaces. What N found on
   the way (the 2.5 s `dilate` of a provider crop, the wand at 30k, the `RangeError` at the cap) is in `docs/BUGS.md`.

11. **Split of `renderer/editor/inpaint_canvas.js`, agreed with the user on 2026-09-17** (over 12,000 lines, one class;
   only that file; **moves only: no behaviour change, no renaming, no tidying on the way**; stage 1 the loose functions at
   the top of the file into modules of their own, then decide with the user whether stage 2 pays: the class's methods
   by subject into files that are hung into the class). **Stage 1 is built** (2026-09-18, after the 0.1.19 state was
   pushed; the design came from a panel the user's second account had started and its usage limit cut short; that
   account's workflow journal and scratchpad were read, nothing re-run that had finished): the
   three groups the agreement names went into three modules, moved byte for byte by line ranges (an independent proof,
   `verify_moves.js` in that session's scratchpad: 40 top-level statements moved, 84 stayed, every one of the 1,176
   comments once). `inpaint_jobs.js` (the worker and pool plumbing: the shared worker and `workerCall`, the mips worker,
   the pool, the tile store's chain transport with its three import-time statements, `buildLayered`, `JOB_TIMINGS`;
   21 names, old lines 64, 160 to 310, 336 to 359), `inpaint_encode.js` (the PNG encoders and the two hash functions:
   `encodeCanvas`, `canvasToBlob`, `encodeTilePixels`, `encodeBands`, `encodeRows`, `partsUsable` and the parts state;
   14 names, old lines 312 to 334, 361 to 369, 407 to 413, 417 to 480) and `inpaint_upload.js` (`SUBFOLDER`,
   `LARGE_UPLOAD`, `uploadBlob`, `uploadCanvas`, `uploadPixels`; old lines 54, 371 to 405, 555 to 565). **The one
   glue:** `nextPartsSeq()` in `inpaint_encode.js`, because the class incremented `partsSeq` at two sites and an
   imported binding is read-only (those two class lines are the only statement whose text changed). `inpaint_jobs.js`
   and `inpaint_encode.js` import `InpaintEditor` back from `inpaint_canvas.js` for the switches on the class
   (`mipsOnPool`, `mipsOnSharedWorker`, `pngParts`), read inside functions only: no module of the cycle touches another
   one's binding while it is evaluated (a scope walk, `toplevel.js`), all four entry orders give the same answers in
   Node (a Chromium page that imports each new module first was not run; ComfyUI imports every file of the node in its
   own order), and `setChainTransport(mipsTransport)` now runs when `inpaint_jobs.js` evaluates (before the class when the
   app enters through `inpaint_canvas.js`, after it when a new module is the entry; nothing reads the scheduler while
   the class file evaluates, its only static initialiser is a number). `inpaint_canvas.js` exports its 22 names as
   before (`uploadBlob` and `uploadCanvas` re-exported as imported bindings; the node's `host.js` and `inpaint_node.js`
   keep working). `tools/build_node.py` FILES and the file table of `docs/BUILD_NODE.md` carry the three names (the
   table also got the six older modules it lacked); ESLint with no-undef / no-import-assign / no-const-assign /
   no-unused-vars over the four files: 0 errors and the original's 3 warnings (a later `++partsSeq` in the class would
   pass `node --check` and throw at run time; only that lint sees it, the config is in the session's scratchpad, not
   in the repo). The three switches no gate sets were checked by hand on a fresh tiles instance (`switch_check.py` in the
   session's scratchpad): the transport is `mipsTransport` with `flights` = `poolSize()` (8) and `arena` true;
   `mipsOnPool = false` and `mipsOnSharedWorker = true` each settle a whole change with `chainScheduler().failure`
   null and `arena` false / back to true; `pngParts = false` makes `parts.usable()` false and an upload of a layer
   still lands in the mirror (the canvas way), true again afterwards. **Gates:** tiles, `--offline`, `split1-tiles` (pixels editor composite commands shape brush film glb ailabel size transparent generate log
   mcp nodecopy toapis llm export pxjobs): all PASS but `editor`, whose four full runs on the split tree failed at four
   different timing-bound steps (the live stroke with its pointer message while the browser pane was in use;
   `closed_tabs_are_collected` twice with the last two tabs alive, a step that passed 3 of 3 alone on both trees and in
   the unchanged tree's full run; `helper_inputs_read_levels_and_upload_nothing` with one upload counted), every step
   of the gate green on the split tree at least once (steps 60 to 65 in a run of their own); **the fifth run,
   `split1-tiles-editor5`, PASS in full** (65 steps, 120 s). Canvas backend, `--offline --tiles off`, `split1-canvas`
   (the same list without pxjobs, which needs tiles): ALL PASS (19 gates, the editor gate in full at the first try). The checkpoint commit before this one
   (`1d5ce8e`) was made on the user's word while the gates ran; its message says a Chromium page check was run, which
   it was not (only the Node runs; this paragraph is right). **Open for the user, the scope:** the design panel (three
   partitions, three judges, four hazard hunts with two refuters per finding; all three partitions mechanically
   equal: same glue, same cycle, all checks green) read the agreement's parenthesis as the whole list (this build,
   "narrow"). The judges' 2:1 favourite is "whole-head": every loose function of the head, into six more leaf modules
   with no new cycle, each rejectable on its own: `inpaint_dom.js` (makeCanvas, el, numberInput, selectInput, icon,
   iconButton, miniButton, STYLE, injectStyle), `inpaint_images.js` (viewUrl, loadImageEl, snapImage, needImage, the
   SVG helpers), `inpaint_stroke.js` (StrokeBuffer, STROKE_BAND), `inpaint_geometry.js` (clampRect, tileDiffBox,
   homography, drawMesh, autoSelectionParams, ensureMinSpan), `inpaint_backends.js` (the segment / upsample / cutout /
   object backend tables and their functions), `inpaint_hosts.js` (editorTileMode, hostText, isSettingOutput,
   settingIndex, linkOf); with it `inpaint_encode.js` would also take canvasRows, hugePngSize, pngIsPlainSrgb,
   pixelsFromPngStream, CRC_TABLE, crc32, asciiJson and pngWithText, and `inpaint_upload.js` UploadCache. The third
   reading ("stage2-ready": the constants out too, into an `inpaint_common.js`) pre-empts the stage 2 decision and was
   scored lowest. Whether the six leaf modules follow, and whether stage 2 comes at all, is the user's call. Kept as
   it was, no tidying: the section title in `inpaint_jobs.js` still reads "PNG encoding, upload hashes and the layered
   export writers" and names `js/inpaint_worker.js`; the class file's header comment (lines 1 to 13) is untouched.
   **The class, measured (2026-09-18, `classmap.js` in that session's scratchpad, espree over the class body):** 11,385
   lines (1194 to 12578), 413 methods with 9,879 lines in them, 264 methods of 20 lines or fewer, 118 of 21 to 50, 21
   of 51 to 100, 10 above 100; 269 `this.*` fields assigned; 33 section banners. So it is not tangled logic but a
   god class: the coupling is the 269 fields every method reaches through `this`, and files hung into the class would
   share them just the same (navigation, not decoupling). The three real blocks: `buildModal` (686 lines, the whole
   UI), `drawSceneOverlays` (246), `onPointerDown` / `onPointerMove` / `onPointerUp` (206 / 139 / 115, the dispatch by
   tool). **Decided by the user on 2026-09-18: the next split step is `buildModal` alone**, into a module of its own
   with one build function per panel (toolbar, layers, settings, filters), pure construction and no state, the
   editor / composite / commands gates checking the surface; about half a day, 6 % of the class and its least
   readable place. Not the whole class, not the pointer handlers (the heart of the live-stroke gates; by tool only when
   a tool is reworked), not the 269 fields into state objects (weeks, and behaviour can move quietly). It comes in a
   session of its own after `smoke` and the node test, under the same rule as stage 1: moves, the byte-for-byte proof,
   both backends, `nodecopy`. **BUILT on 2026-09-20** (see the top of this section): `renderer/editor/inpaint_modal.js`,
   654 of 654 lines proven identical, one line translated (`pane = this.panes.gen` -> `toGenPane()`), a gate step of
   its own for it, both backends ALL PASS. **Not the plan's word in one respect:** "pure construction and no state"
   cannot hold - the method writes 101 fields onto the editor, so every function takes `ed` and writes onto it, as the
   method wrote onto `this`. That is navigation, not decoupling, which is what the class measurement said it would be.

12. **OpenRouter as a provider: BUILT on 2026-09-19 (see the top of this section; the plan below is what was asked,
   not what was built: the image route is `/api/v1/images`, and no `HTTP-Referer` / `X-Title` goes out).** OpenRouter
   (`https://openrouter.ai/api/v1`) is an OpenAI-compatible aggregator with one key for most hosted models. Two uses in
   Scumble, both to be written from the docs and verified only with a real key, like every other adapter:
   (a) **prompt upsampling**: a backend beside the API ones and `settings.llm.compat`, the chat completions endpoint
   with a Bearer key from the credential store (`keys.js`), the model chosen by its id (`openai/...`, `google/...`,
   `anthropic/...`), the optional `HTTP-Referer` / `X-Title` headers; (b) **image edit and "Generate new"**: an adapter
   in `electron/main/providers/` next to the OpenAI and Gemini ones, through chat completions with
   `modalities: ["image", "text"]`, the input picture as an `image_url` data URL, the answer read from
   `message.images[0].image_url.url` (a data URL); one variant per image-capable model id with its `limits`, no mask
   parameter on that API (Scumble's own composite mask and stitch apply, as for Gemini). Settings › API keys gets an
   OpenRouter row, recipes an `openrouter` provider variant, `docs/RECIPES.md` the format, and a plain-Node test of
   the request shape (as `transparent_test.py` does for OpenAI) plus the loopback stand-in in the gates. **To verify
   against the live API before anything ships:** which image models OpenRouter serves at the time (Gemini image,
   gpt-image, Flux), whether an input picture reaches them as an edit, the size and count limits, and the shape of an
   image answer; the docs may have moved since this was written.
12b. **BytePlus ModelArk as a direct Seedream provider: BUILT on 2026-09-19 (see the top of this section; the plan
   below is what was asked, the research paragraph after it corrects it).** Seedream runs today through fal, ToAPIs, WaveSpeed and the ComfyUI API node
   (`ByteDanceSeedreamNodeV3`); ModelArk is ByteDance's own API for it. What was found on 2026-09-19 (the docs,
   `https://docs.byteplus.com/en/docs/ModelArk/1541523`, are rendered by script and could not be read field by field):
   `POST https://ark.ap-southeast.bytepluses.com/api/v3/images/generations` (Singapore; also `ark.eu-west.bytepluses.com`),
   an API key from the ModelArk console, model ids such as `seedream-5-0-pro`, `seedream-5-0-lite`, `seedream-4-5`,
   `seedream-4-0`, a request of `model`, `prompt` (at most 300 tokens) and optional `image` (a URL or base64, one or
   several: single- and multi-image edit and fusion). An adapter in `electron/main/providers/` next to `toapis.js`,
   a key row in Settings › API keys (credential store), an `ark` provider variant in the recipes with its `limits`
   (Seedream's 3:1 `ratio` as on ToAPIs), no mask (Scumble's own composite mask and stitch, as for Gemini), "Generate new"
   through the same endpoint without an image, `docs/RECIPES.md` and a plain-Node test of the request shape plus the
   loopback stand-in. **To verify with a real key before anything ships:** the exact field names (`size` format and
   limits, `seed`, `response_format` `url` / `b64_json`, `watermark`, multi-image fields), the answer's shape, whether an
   input picture is edited or only referenced, the size and count limits, and which region the user's key serves (the
   privacy note: ByteDance, Singapore or the EU endpoint).
   **Researched on 2026-09-19 (the field-level docs are in the served HTML, `window._ROUTER_DATA...MDContent`; the
   session scratchpad's `rep_modelark.md` and `ark/` hold them), correcting the lines above:** the AP region is
   **Johor, Malaysia** (`ark.ap-southeast.bytepluses.com/api/v3`), the EU one Dublin (`ark.eu-west...`), keys are bound
   to a region and requests "may be routed" across regions; model ids carry a date: `dola-seedream-5-0-pro-260628`,
   `seedream-5-0-260128` (also `seedream-5-0-lite-260128`), `seedream-4-5-251128`, `seedream-4-0-250828`, and a model
   must be activated first (404 `ModelNotOpen`; some accounts need an endpoint id); the prompt's 300 is a recommendation;
   `image` is a URL or a `data:image/<fmt>;base64,` string or an array (pro 10, the others 14; each [1/16, 16], at most
   30 MB and 36 MP), **`watermark` defaults to true (send `false`)**, `response_format` `url` (24 h) or `b64_json`,
   `size` a tier (pro 1K / 1.5K / 2K, lite 2K / 3K / 4K) or `WxH` by area (pro 921,600 to 4,624,220 px, lite 3,686,400 to
   16,777,216), ratio [1/16, 16] (not ToAPIs' 3:1), `output_format` png only on 5.0 pro / lite, no mask, no `n`, `seed`
   not in the reference (the SDK sends it); errors `{ error: { code, message, param, type } }`; prices per image (pro
   $0.045 up to 2.61 MP, $0.09 above; lite $0.035); data centres in Malaysia, Indonesia and the EU, no training without
   authorisation, filtered content kept 180 days.
13. **The assistant, a chat agent that drives Scumble over MCP (asked for by the user on 2026-09-18, planned that day
   and revised on 2026-09-19 after the user's answers; not built: about twenty-three and a half working days for its
   one release, twenty-four and a half with the two optional steps).** The plan is `docs/PLAN_ASSISTANT.md`; every
   point of its §8 is decided (2026-09-19). It comes last in the order below but before SignPath (the user,
   2026-09-19: "assistant kommt vor codesignierung"), and ships as a release of its own. The MCP server stays primarily for external agents: the assistant changes no command, parameter,
   annotation or `INSTRUCTIONS` line (splitting `createServer` out of `serve()` is internal, its tool list proven
   byte-equal), and the four defects its planning found (`remove_layer` on a locked layer, `flip_layer`'s axis, the
   `llm:models` compat key, the annotations) are filed in `docs/BUGS.md`, not fixed by it. A collapsible chat column
   right of `#editor-host` (`<dialog id="assistant">` shown with `show()`, open state remembered; shell only); the
   loop in main (`electron/main/assistant/`) with raw `fetch`, every call streamed, four adapters: Anthropic Messages,
   OpenAI Responses (`store:false`), Gemini `generateContent`, and Chat Completions for OpenRouter (item 12's key
   row), DeepSeek, Moonshot (Kimi) and Z.ai (GLM) (three new key rows), ToAPIs, WaveSpeed and the local compat
   endpoint. A picker grouped by provider, only ready providers selectable (a stored key; for the local server, which
   needs none, a saved URL), curated vision models (Claude Sonnet 5, the default, and Opus 5; GPT-5.6 Terra, Sol and
   Luna; Gemini 3.8 Flash, 3.1 Pro preview and 3.5 Flash-Lite; DeepSeek V4.1 Flash; Kimi K3 and K2.6; GLM-5.3-Flash
   and FlashX) plus a free OpenRouter id checked against its live list; a privacy notice per provider saying where the
   pictures go as far as its own terms say (the US, Singapore or the PRC, "any region" for Anthropic's inference and
   for Google, "not stated" for OpenAI's default region, Z.ai's GLM-5.3-Flash cluster and, until their terms are read,
   ToAPIs and WaveSpeed). Through OpenRouter the pictures go on to a host it picks: Scumble sends
   `data_collection: "deny"` (hosts that train are excluded, hosts that keep the data are not) and `provider.ignore`
   with every host OpenRouter lists in China, because on 2026-09-19 StreamLake, Baidu and Alibaba served the curated
   GLM, Kimi and DeepSeek models. It reaches the editor only through an in-process MCP `Client` over
   `InMemoryTransport` and sees the 72 tools minus an exclusion set of six (`list_commands`, `run_action`,
   `set_status` and the three `ailabel_*`), so 66, and 65 for a model without vision; its requests carry `meta` and
   wait up to 20 s for the user's stroke, transform, text edit or question. The policy, decided by the planner for the
   user: everything that can cost money or queue on ComfyUI asks (`generate`, `generate_new`, `select_by_text`,
   `cutout_layer`, `upsample_prompt`), and so do the calls that clear undo, `flatten`, `extend_canvas`, unlocking a
   layer or moving or retexting a locked one, `undo` / `redo`, file reads, exports with a path and global settings;
   removing, merging and the edits the commands record no undo step for run without asking only on the chat's own
   layers; exports without a path or with a wrong extension are refused. Its leading use is the user's own: inpaint
   regions, each on its own result layer, and colour-match them (`generate` asks, `set_layer` `match` on the chat's
   own result runs). Chats are saved under `<userData>/assistant/` (20 kept), and Settings › Assistant has a reset
   that deletes all assistant data, its lines in the app log included, but the keys. Undo: every step on the normal
   stack, on both backends; where a command records none (an added layer, `generate`'s result included, `set_layer`'s
   colour match and other non-geometry fields, `set_filter`'s params, `set_text`) the shell pushes the editor's own
   step kind before the assistant's call (`meta.undo`; no command and no editor change); plus "Undo this turn" on
   tiles (a turn snapshot in `inpaint_canvas.js`, hence `build_node.py --check` and `nodecopy`; refused on the canvas
   backend). Steps (PLAN_ASSISTANT's A0 to A9): A0 the server split; A1 the loop, the policy, the registry and
   Anthropic in plain Node; A2 Chat Completions with its seven providers; A3 OpenAI Responses and Gemini; A4 in the
   app with the key rows and the first gate; a checkpoint with the user's keys on several models across providers,
   before any UI (a ceiling of about $10, set by the user); A5 the panel; A6 chats on disk and the reset; A7 per-step
   undo and turn undo; A8 the whole `assistant` gate (76 steps, twenty-one mutations, `tools/assistant_mock.py` for
   all four families) and the docs; A9 a live check on the packaged app and the release. Optional, only on the user's
   word: A10 a budget, "allow for this chat" and a basic tool set; A11 the assistant's own undo steps. **To verify
   against the live APIs before it ships** (§7): per family the reasoning replay (signatures, encrypted items, thought
   signatures, `reasoning_content` on every assistant message), a JPEG in a tool result where the family takes one
   (Moonshot's `tool` message included: its schema allows one, its only example is a video) and in a follow-up user
   message elsewhere, pruning, the streamed rebuild, cache reads, the tool list's real token count and the error
   shapes; Gemini's request limit (its docs say 20 MB and 100 MB; the cap is 18 MB until then); that OpenRouter still
   routes each model with `data_collection: "deny"` and the hosts in China ignored, and whether it does with
   `zdr: true` (then the user decides); that ToAPIs and WaveSpeed pass tools at all, and where they are and what they
   keep. No OpenRouter attribution headers go out before the trademark check (they make a public app page).

**Decision (b) of 7c is made (the user, 2026-09-18): exports and runs of a colour-matched layer may move.** They may
take their statistics from tiles instead of from the whole flatten, with **point samples** (measured mean 0.56, max 8
to 9 levels against the full-resolution statistics; not box means, which were 5.45 / p99 12 on a textured photo;
`docs/PLAN_BCE.md` §C6 "C6 (c) slice 7c as built"). **B item 7 part 3 is built on it** (2026-09-18, item 10 above;
CHANGELOG 0.1.19 says a matched layer's export can move by a few levels). **Stage 1 of the split of
`inpaint_canvas.js` is built** (item 11, 2026-09-18) and **0.1.19 is published**. **Decided by the user on 2026-09-18,
on that session's recommendation:** (1) **no stage 2 for now, and no six leaf modules**: hanging methods into the class
is an eager access to it (it would have to stand in `inpaint_canvas.js` below the `class` statement for ComfyUI's
import order), and twelve sites in four subjects read switches on the class name, so a subject is split out only when
that subject is reworked anyway, as the prelude of that work; (2) **the object tool's change A is parked**: if the coarse
outlines at 15k turn out to matter, compute the image-size label map only in the hovered object's box, on demand,
never for the whole picture; (3) **B item 6 stays on ice** (it saves memory, not time; 97 GB of RAM and the 15.5 GB cap
are not the limit at 15k). **Next, in this order** (the user, 2026-09-20, on this session's plan: the two defects,
then `buildModal`, "und den assistent"): ~~the two defects of the OpenRouter session~~ and ~~the `buildModal` split~~
(both 2026-09-20, see the top of this section); **next is the assistant** (item 13, `docs/PLAN_ASSISTANT.md`), as
a release of its own (the user, 2026-09-19: "agent als letztes, wird ein seperates release", and the same day:
"assistant kommt vor codesignierung"); then SignPath, last. Waiting on the user's ComfyUI, whenever it is free: one
local run on a large document with the node's stitch fix (`fba1fd8`), and the node in a real ComfyUI tab and in
Firefox when a node version is meant to ship. Nothing else stands before them, unless the user names something else
first.

**Housekeeping done on 2026-09-16.** The merged branches `c0-editor-source`, `c2-tiles`, `fix-mask-undo` and `px-spike`
are deleted locally and on origin; the v0.1.11 draft release and its tag are deleted; `dist/` is cleaned (old installers,
gate profiles, `dist/ab`, `composite`, `smoke`). `tools/run_gates.sh` recreates the profiles it needs.

**Still unverified or open:** the ToAPIs, OpenRouter and ModelArk adapters have never run against the live API (`docs/RECIPES.md` "Only a real key can verify", in each section); a real SAM2 / RMBG
model has not run in the app on the slice 6 code (the full `smoke` of 2026-09-19 ran the server's helpers only; a profile
with the models downloaded or the ComfyUI `models/` folder linked would run them); the user has not reported back on
their own 15k file.

## Gate runner and flakes

`bash tools/run_gates.sh <label> [--strict] [--copy] [--tiles on|off] [--offline] [--exe PATH] <gates...>` starts a fresh instance on
port 9555 with its own profile (with `test_base.png`), runs each gate with a timeout, and writes logs and `summary.txt` under
`dist/gates/gates/<label>/` (or `$SCUMBLE_GATES`). `tools/close_app.py` closes an instance by its DevTools port
(`SCUMBLE_CDP_PORT`). Gates: `pixels editor composite commands shape brush film glb ailabel size transparent generate log
mcp nodecopy toapis openrouter ark recipes assistant llm export pxjobs`, plus `smoke` (a real Flux run; check `/queue` first, and not while the user needs
ComfyUI), `perf:<W>x<H>`, `exportperf:<W>x<H>[,--filter=film.look]` and `huge:<W>x<H>` (the 30k gate; it refuses to run
against a connected instance). **`--offline` starts the instance with `--no-comfy`**: it does not connect, so no upload is
forwarded to the user's server. A fresh gate profile otherwise connects to `127.0.0.1:8188`, the user's ComfyUI, and
forwards every upload of every gate to its input folder; use `--offline` for everything but `smoke`. Run a change on both backends (`--tiles on` and `--tiles off`); a release also runs against
`dist/win-unpacked/Scumble.exe` with `--exe`, each run on its own profile.

Known flakes; **re-run before believing any of these**:
- `commands_test.py` hangs after every step has printed `[ok]` (the runner's 420 s timeout, sometimes in
  `Page.captureScreenshot`).
- `editor_test.py` `closed_tabs_are_collected` fails with the last tabs still alive, or against an instance with 50+ tabs
  from repeated runs.
- The live stroke steps (`live_stroke_reaches_the_screen_before_the_release`, `live_stroke_preview_shows_what_the_commit_writes`)
  fail when a real mouse is over the test window (they drive synthetic pointer events), or right after a diagnostic
  instance was closed.
- The marching ants (120 ms) break a screen comparison now and then; steps that compare the screen draw the selection as a
  tint.
- `composite_test.py` once got a 1200 × 794 canvas against its 1200 × 800 reference and then crashed with `KeyError 'bytes'`
  in its own failure message (a test bug, not fixed).
- `node tools/brush_test.js` hung once at exit under load after printing every PASS.
- `editor_test.py` `closed_tabs_are_collected` failed twice in five runs of the editor gate alone on the canvas backend
  (`--tiles off`, 2026-09-17, B item 2) and passed on the rerun each time; the code under it had not changed.
- `editor_test.py` `a_settled_read_builds_its_levels_in_the_worker_not_here` failed once with `requested: 0` in some twenty
  runs since the mip chains go through the pool; not reproduced.
- The first exe instance of the 0.1.18 gates failed `a_settled_read_builds_its_levels_in_the_worker_not_here`
  (`requested: 0`, 11 s into the editor gate) and `composite_test.py`'s view (a 1200 × 794 canvas) in the same run; both
  passed on a fresh instance. Two known flakes at once, in the first seconds of an instance: not looked into.
- `perf_test.py`'s magic wand row (whole-image band) read 2.1, 4.0 and 7.0 s in three runs of the same code while ComfyUI
  ran a job; an A/B against the commit before in the same minute read 3.5 s. It is the card, not the code.
- The `commands` primed-cells checks wait up to 3 s for the film panel's own settled flatten; a failure "primed cells were
  left behind" seen once without a mutation was that race.
- The editor gate run alone on tiles takes about 370 s (120 s inside a full run). On 2026-09-18 (the split, stage 1)
  four runs alone failed at four different timing-bound steps (the live stroke with the pointer message,
  `closed_tabs_are_collected` twice with the last two tabs alive, `helper_inputs_read_levels_and_upload_nothing` with
  one upload counted), while the unchanged tree passed once and `closed_tabs_are_collected` alone passed 3 of 3 on
  both trees; not looked into further.

## Traps worth keeping

**Chromium, canvas, WebGL**
- Chromium applies `UNPACK_PREMULTIPLY_ALPHA_WEBGL` to `ArrayBufferView` uploads too; set both unpack switches explicitly
  before every typed-array upload, or premultiplied tile bytes get premultiplied twice.
- Once at least 100 `getImageData` calls have disabled acceleration and they reach 95 % of all canvases created, Chromium
  makes every new canvas software; a test with a readback after every step can trip it.
- `globalCompositeOperation` `copy` and `destination-in` apply to the whole canvas; a regional use needs `clip()` first (the
  vanishing-layer bug of 0.1.8).
- An OffscreenCanvas clips without anti-aliasing; `drawInto` callbacks allow clips on whole pixels only.
- A canvas 65,536 px on a side draws and reads nothing; 65,535 works. The WebGL drawing buffer caps at about 33 MP whatever
  the canvas size says (filters render in tiles for that).
- A sub-rectangle draw from a very large canvas is not cheap (150 band draws from a 15k canvas cost 30× one whole draw);
  bands only pay when each band's source is small too.
- A `CanvasGradient` belongs to the context that made it; a cached one has to be keyed by the context.
- Skia's CPU raster is not exactly translation-invariant; a GPU readback costs whatever is queued before it; Chromium keeps
  small canvases in software, so a buffer that grew onto the GPU differs from an all-GPU canvas by a few levels.
- `requestAnimationFrame` does not fire in a hidden window (`drawSoon()` is rAF-based), and `img.decode()` never resolves
  there; scripted waits use `setTimeout`, image loads wait for `onload`.
- On a `<dialog>` closed by a real Escape Chromium fires `cancel`, not always `close`.
- `texSubImage2D` and `readPixels` take a view on a `SharedArrayBuffer` here (Electron's Chromium): no copy between the
  workers' buffer and the GPU (B item 7 part 2). 572 MB go up in 0.1 s and come back in 0.2 s, on the main thread.

**Electron and Windows**
- In the main process `process.stdin` never emits `data` from a pipe (read fd 0 with `fs.createReadStream`); Electron prints
  a CR LF to stdout before any JS runs (hence the MCP launcher); a window created hidden stays hidden after `show()`,
  `restore()` brings it up.
- Electron has no `window.prompt`; the editor has its own `ask()` modal.
- Only one instance runs at a time (single-instance lock and named pipe), including headless `--mcp` instances.
- `mcp_test.py --user-data-dir` must come before `--cmd`, which otherwise takes it for its JSON.

**Tooling, shell, git**
- The Bash tool's heredoc breaks on an apostrophe in its text even with a quoted delimiter (`unexpected EOF while looking
  for matching`), and turns `\u0080` in Python source into the character. Write scripts and JS with the Write tool; a
  patch script imports a small `patch(path, [(old, new)])` helper and asserts each `old` occurs once.
- The Write tool itself turns `\u0080` in a JS regex into the literal character. Check a written file for non-ASCII
  (`grep -nP "[^\x00-\x7F]"`) when it holds escapes.
- A backtick in a comment inside a GLSL template literal ends the JS string; `node --check` on an ES module file here
  reports nothing, the app reports `Unexpected identifier` at import.
- A Bash-tool heredoc with an unquoted delimiter (`<<EOF`) runs every backtick span in its text as a command; quote it
  (`<<'EOF'`) or use the Write tool. Heredocs also turn `\\n` in Python source into real newlines, and long Python heredocs
  fail to parse: write scripts with the Write tool.
- PowerShell `Set-Content` writes a BOM (electron-builder then refuses `package.json`); edit such files from Python.
- Python patch scripts write with `newline=chr(10)`.
- Reusing one commit message file gives the next commit the old message.
- The node's publish action runs on a push only when `pyproject.toml` changes; otherwise
  `gh workflow run publish_action.yml --repo DenRakEiw/ComfyUI-InpaintCanvas --ref master`.
- `tools/run_gates.sh` and the mutation helpers restore only the files they saved; check `git diff --stat` after a mutation
  round.
- A background `grep` loop meant to stop a workflow after a phase does not fire in time; read its journal by hand or give it
  a phase switch in `args`.

**Testing and benchmarking**
- A mutation that is not run against a fresh instance proves nothing: the renderer caches the ES modules it imported at
  start. Close the app, patch, start again.
- Restart the app before every benchmark or memory run; after several large documents the GL path degrades.
- A "before" row that runs after `mipsSettled()` measures a warm document.
- An A/B that flips between rows compares two pictures; compare bytes in one state, with
  `releaseCaches({ mirrors: true, deep: true })` between the reads.
- A benchmark row only measures what its document exercises (the perf stack always carries a filter layer).
- ComfyUI holding the card changes op rows by 3 to 5×; A/B a suspected regression in the same session, with the card freed
  (`/free` on an empty queue) if possible.
- The layers reach the local store through `ed.syncLayers()`; a test that reloads right after a change calls it first.
- `editor_test.py`'s `window.__t` is 600 × 300 by the time later steps run; call `new_canvas` first.
- A test that sets `layer.blend` or `layer.visible` by hand leaves the composite version where it was, and the wand's
  coarse pass answers from before the change; go through `set_layer` (it calls `touch`).
- Three 8-bit roundings in a blend formula are up to 1.45 levels off and a level from the shader on 29 % of the bytes of
  a half-transparent layer; one rounding of exact products is within 0.5. Measure a kernel against exact floats
  before blaming the other path.
- The renderer keeps its own copy of the settings (`settings` in `shell.js`). A test that calls
  `window.scumble.settings.set()` directly changes the stored file, not the window's view, and a later gate in the
  same instance that reads both (`list_recipes` against `settings.get()`) fails on the difference: the `toapis` gate
  left `gpt_image_2` on toapis and made `openrouter` red on 2026-09-20 when it ran before it. Its cleanup now puts
  every recipe it switched back through `selectRecipe`, so the order no longer matters; a gate that switches
  anything in the window has to do the same.

**Tile engine code**
- A tile's bytes are a view into a SharedArrayBuffer in the app: no `ImageData`, `Blob` or `crypto.subtle` over them
  (`imageDataOf` copies into a scratch), `t.data.buffer` is the 64 MB chunk (use `byteOffset`), and a worker may read a
  tile while this thread writes it: a job's answer counts only if the tile's version is still the one it was made from.
- A worker must never write a tile it was given by slot; it extends or converts a copy.
- Whoever hands tiles to a job holds them until the answer is in (a `clone()` for a file, the scheduler's batch for mips):
  the slot goes back to the arena when the tile object is collected.
- `makeCanvas` and `flattenToCanvas` throw above Chromium's canvas limits since E5. Code that needs the whole picture asks
  `bandPlan` / `readBand` / `readBox`, or a row source (`inpaint_bands.js`).
- A copy-on-write copy that takes the original's chain buffer must take ownership, or the last holder writes into it in place.
- A rebuild that asks for chains and then drops them asks again forever; cells are kept per tile version.
- `frozen` too high only costs a copy; too low writes into a shared tile. A release must never let go of pixels the document
  still holds.
- A second walk of the layer stack (like `passStores` beside `drawLayersInto`) is where this design breaks; keep it next to
  `drawLayer`'s branches.

## How the app is put together

- `electron/main/main.js`: window, `scumble://app/` scheme (renderer files) with
  `scumble://app/comfy/*` proxied to the ComfyUI server by `electron/main/comfy.js`
  (auth headers live there; the websocket too, events are forwarded over IPC).
  Same-origin, so `<img>` from `/comfy/view` never taints a canvas.
- `renderer/editor/`: the editor, edited here since C0 and built into the node by
  `python tools/build_node.py` (then `python tools/node_test.py`, commit both repos;
  `docs/BUILD_NODE.md`). `renderer/editor/host.js` is the app side: `api` (fetchApi, apiURL,
  queuePrompt, events) and `host` (recipe, settings targets, generate, autosave, export); the
  node's `js/host.js` answers the same members, and `build_node.py --check` fails when the
  editor calls one that either host lacks. Never edit the node's generated `js/` files.
- Recipes are API-format prompts; `host.queueGenerate` injects `canvas_state`,
  `result_source[_local]` and the node params into the canvas node and writes the
  Settings-panel values into the recipe nodes directly (`settings: [{index, node,
  input, label}]`), so `setting_n` outputs are not used.
- State: every tab's `getValue()` JSON in one bundle, autosaved to
  `%APPDATA%/Scumble/autosave.json` and restored at the next start from the local file
  mirror (`%APPDATA%/Scumble/files/`), no server needed. Layer pixels are uploaded like
  in the node (`input/inpaint_canvas`), but the upload lands in the mirror and is
  forwarded; `ensureOnServer` re-uploads before a run.
- `renderer/shell.js`: tab bar, settings dialog (ComfyUI + auth + Test, API keys,
  recipes, helpers, local files), menu commands, restore at start; exports `newDocument`,
  `activate`, `closeDocument`, `openSettings`, `selectRecipe`, `loadRecipes`,
  `importRecipe`, `testConnection`, `connect` for tests (`import("./shell.js")` from
  the console). `window.editor` is always the active tab.
- Helpers in-app: editor → `host.findObjects` / `host.cutoutInApp` / `host.selectPoint`
  (source scaled to 1024² in the renderer) → IPC `helpers:objects|cutout|segment` →
  `electron/main/onnx/index.js` → `sam2.js` / `matting.js` on the `Runtime` → label
  map / alpha back, scaled to the image in the renderer. Models and folder in
  `docs/HELPERS.md`.
- Agents: MCP client → `Scumble --mcp` (`electron/main/mcp/server.js`) → `AgentBackend` in
  `main.js` → the running instance over `electron/main/local.js` (named pipe) or the app
  started headless in the same process → `electron/main/bridge.js` (IPC `commands:request` /
  `commands:reply`) → `commands.call` in `renderer/shell.js`. `docs/MCP.md`.
- Provider runs: `host.runProvider` (the recipe resolved to the chosen provider's variant by
  `shell.js`) → `renderer/editor/stitch.js` (crop) → IPC `provider:edit` →
  `electron/main/providers/index.js` picks the adapter and the key (`keys.js`) →
  `stitch.js` (composite mask, colour match) → mirror upload → `addResults`. Recipe
  formats in `docs/RECIPES.md`.

## Working rules

- Development folder is `F:\canvas`. Scratch files go to the session scratchpad, not here.
- Commit as DenRakEiw: `git -c user.name=DenRakEiw -c user.email=89697885+DenRakEiw@users.noreply.github.com`,
  no Claude trailer in commit messages. Push with `-c credential.helper='!gh auth git-credential'`.
- The user's ComfyUI (port 8188) is a production machine: check `/queue` before
  queueing anything, never restart it unasked, delete own test prompts from the queue.
- Python patch scripts must write with `newline=chr(10)`; a mistyped `newline="\\n"`
  once truncated a 7,000-line file.
- Test with real runs: start `./node_modules/.bin/electron . --remote-debugging-port=9555`
  (9333 is usually taken by the node's headless tab), then `python tools/cdp.py eval|shot|log`
  and `python tools/smoke_test.py` (load, select, generate through the recipe, save,
  then the helpers and exports; `--no-helpers` for the short version) and
  `python tools/commands_test.py` (command core + sample plugin, no ComfyUI needed).
  `python tools/mcp_test.py` talks to the MCP server over stdio through
  `electron/main/mcp/launch.js` (proxy mode while the dev instance runs, headless when
  nothing runs; `--exe dist/win-unpacked/Scumble.exe` for the package, `--direct` for the
  old registration, which the Python client rejects by design).
  `python tools/llm_test.py` checks the OpenAI-compatible upsample endpoint against
  `tools/llm_mock.py` (a mock server it starts itself; no ComfyUI, no key, no local model).
  `python tools/generate_test.py` covers "Generate new" (a base image from the prompt
  alone) against the loopback provider, no ComfyUI and no key needed.
  `python tools/shape_test.py` covers the shape tool: every kind, fill and outline, the
  corner radius, the clip to the selection and one undo step per shape.
  `python tools/size_test.py` covers the size a crop is emitted at for an API run: the
  provider variant's `limits`, the five API size modes, the pixel budget, and that a local
  recipe keeps its `target_size`. Loopback only, no ComfyUI and no key needed.
  `python tools/transparent_test.py` covers the OpenAI `background` parameter: the adapter's
  size rules and parameter set in plain Node, then the loopback provider's transparent
  answer surviving the stitch, "Generate new" with a transparent base, and the pixel floor.
  `python tools/editor_test.py` covers the editor behaviour reported broken in 0.1.5: the
  New dialog's two size boxes and its focus, the click that deselects, the outline that has
  to stay visible on white, and copy / paste of a layer between tabs.
  `node tools/helpers_test.js` runs the ONNX modules without Electron.
  `python tools/composite_test.py` compares the GPU compositor against Canvas 2D and two
  stored references in `tools/refs/` (`--update` rewrites them, `--tolerance n` allows n
  levels); run it after anything that touches drawing.
  `python tools/perf_test.py [2048x1152 6000x4000 12000x8000]` is the drawing benchmark
  (synthetic documents in their own tab, no ComfyUI; `docs/PERFORMANCE.md` §7).
  `python tools/mem_test.py [12000x8000] [--rounds 4] [--keep]` is the memory walk: a
  document per round, benchmarked, closed and collected, with the private bytes of the
  renderer and of the GPU process, a census of every live canvas and the line that made it.
  Restart the app before every benchmark or memory run. Scripted
  waits must use `setTimeout`, never `requestAnimationFrame`: rAF does not fire while the
  window is hidden, and `drawSoon()` is rAF-based, so a hidden window draws nothing.
  Start the dev instance with the Bash tool's `run_in_background`; a plain `&` job dies
  with the shell.
  `window.editor` and `import("./editor/host.js")` are reachable from the console.
  Only one instance runs at a time (single-instance lock); stop the dev instance before
  starting `dist/win-unpacked/Scumble.exe`. `Stop-Process -Name electron` in PowerShell.
- Answer in German; code, comments and docs in English.
