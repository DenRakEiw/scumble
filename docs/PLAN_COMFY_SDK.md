# Comfy Cloud and Comfy Router on the Comfy SDK (0.1.49)

The direction the user accepted on 2026-10-18: (1) Comfy Cloud moves from its legacy API onto the Comfy API v2 through
Comfy's official TypeScript SDK `@comfyorg/sdk`; (2) Comfy Router moves onto the SDK's `comfy.models`; (3) the local
ComfyUI keeps its direct path (`electron/main/comfy.js`); `comfy-api-proxy` is at most a later, optional connection
type. Why: Comfy's Cloud overview calls the v1 Cloud API "deprecated in favor of Comfy API v2", whose "endpoints and
behavior may change without notice" (docs.comfy.org/development/cloud/overview, read 2026-10-18; it already dropped
`/api/history` once, `comfycloud.js:13`); v2 gives an idempotent submit, content-hashed asset dedup, live progress
events for the status row's bar and jobs that can be read again by id. Router: mostly the line "built on the Comfy
SDK" for the challenge (Open Source Higgsfield, deadline 2026-10-30 17:00 German time); the update should be
releasable before that.

Anchors read at `4e6c17e` (2026-10-18). SDK read in the unpacked `@comfyorg/sdk` 0.5.0 (`src/`, `README.md`). Test tier
(CLAUDE.md "Working rules"): providers built against docs are light (plain-Node request-shape tests, `lint`, `types`,
one look in the app); the renderer's bar mapping is normal (one gate step on tiles). One session per section, then
`/clear`. A release only on the user's word.

## 1. What exists

- **Comfy Cloud** `electron/main/providers/comfycloud.js` (602 lines), legacy API on `BASE = https://cloud.comfy.org`
  (:38), header `X-API-Key`. `upload(ctx, bytes, name)` (:196) posts `/api/upload/image` and returns the filename the
  graph's `LoadImage` takes. Two graph builders: partner nodes through `SHAPES` / `LAYOUTS` / `NODE_PICTURES`
  (:53-159, `buildGraph` :397-446: LoadImage per picture, ImageToMask for the mask, the partner node, SaveImage), and
  detached recipe graphs `options.graph` (`buildDetached` :358-395: LoadImage nodes titled `scumble:picture:N` /
  `scumble:mask`, `options.values`, Settings rows `"<node>|<input>"`; 14 of the 32 comfycloud recipes). `run`
  (:536-602): the node-list check for detached graphs (`cloudInfo` :221, `GET /api/object_info`, kept 10 min per key;
  missing node refuses, missing model files only explain a failure, `checkModelFiles` :321), `POST /api/prompt`
  (:566), poll `GET /api/job/<id>/status` every 2 s (:574-581), outputs from `GET /api/jobs/<id>` with the recipe's
  own SaveImage first (:584-595), `GET /api/view` 302 to a signed URL fetched without the key (`download` :459).
  Nothing sends `extra_data`; partner nodes ran live this way. Exports `_buildGraph` (used by
  `tools/nanobanana21_test.js:191` and the 2026-10-18 live-check script) and `objectInfo` (the UI-workflow import,
  `electron/main/main.js:881`).
- **Comfy Router** `electron/main/providers/comfyrouter.js` (868 lines) already speaks the Router's v2 queue contract by
  hand: `send` (:638-716: one `Idempotency-Key` per run, resend up to 3 times under it after a lost answer or
  409/429/503, poll status with Retry-After, `PUT .../cancel` on timeout, 202 = not collectable yet), `sync` (:719, the
  `not_enabled` fallback), `answerOf` (:733, headers request id / credits / dropped params). The dialects (:359-627)
  build each partner's body and read its answer; they are untouched by this plan. Host rule: `testBase` (:86) allows
  only `http://127.0.0.1:<port>` from `settings.comfyrouter.base`, `checkKey` (:102) sends a `test-` key only there and
  a real key never. Key: the Comfy Cloud row (`keyName: "comfycloud"`, :848).
- **Comfy Partner** `comfypartner.js` (HY Image 3.5 over the undocumented `/proxy/...` routes): not covered by the SDK,
  stays as it is; it imports `router._shared` (:28), which must survive.
- **Provider plumbing** `providers/index.js`: `edit` (:184-266) makes one `AbortController` per run id (`running`
  :168, `cancel` :172), `contextFor` (:362-382) gives the adapter `ctx.fetch` / `ctx.sleep` bound to that signal
  (no `ctx.signal`), the cancelled message says the provider "may still finish the job and charge it" (:255). IPC:
  `provider:edit` / `provider:cancel` (`main.js:1086-1087`), preload `providers.*` (`electron/preload.js:132-139`,
  `on()` helper :7-11). There is no provider-to-renderer progress channel.
- **The bar** `renderer/editor/inpaint_progress.js` `RunProgress` (no DOM, also in the node build): ComfyUI-shaped
  events per prompt id (`execution_start`, `executing`, `progress` value/max, `execution_success`, :49-90) and
  `timer({ label, started, promptId })` (:124). An API run shows only "label · N s": `host.syncRunBars`
  (`host.js:2579-2586`) feeds each `_providerRuns` token; a token whose `promptId` is tracked shows that prompt's steps
  under its label (`state` :142, used for picture runs on ComfyUI, `host.js:2733`). `trackRun` (:2591); Cancel
  `cancelRuns` (:2539-2542) calls `providers.cancel(runId)`. Tests: `tools/progress_test.js` (run by the `log` gate),
  `generate` gate step `the_status_rows_bar_follows_the_run`.
- **Tests on the legacy routes**: `tools/cloudgraph_test.js` (fake `ctx.fetch`, :48-67), `tools/upscale_test.js`
  (:305-339), `tools/nanobanana21_test.js` (`_buildGraph` with an upload fake). Router: `tools/comfyrouter_test.js`
  (adapter with `ctx.fetch = server.fetch` :235, `index.edit` with `globalThis.fetch` swapped :653-678),
  `tools/comfyrouter_mock.py` (checks `X-API-Key` :206, :326, `Idempotency-Key` :300), `tools/comfyrouter_test.py`
  (the app over CDP against the mock; also covers comfypartner).
- **Bundle** `package.json` `dependencies` (:34-39: MCP SDK, electron-updater, onnxruntime-node, ws); main is CommonJS;
  electron-builder ships production dependencies inside `app.asar`. The lockfile already holds `zod` 4.5.4 (MCP SDK)
  and `eventsource-parser` 3.1.1.

## 2. What the SDK gives, verified in its source

- **Package.** MIT (`LICENSE` in the npm tarball; the GitHub repo has none), ESM-only (`"type": "module"`, exports `.`,
  `./low`, `./errors`), Node >= 22, deps `zod ^4.4.3` (dedupes onto our 4.5.4), `hash-wasm ^4.11` (new, ~2 MB),
  `eventsource-parser ^4.1` (nested beside our 3.1.1). **`require()` works** through Node's `require(esm)`: checked
  2026-10-18 with Electron 44's own Node 24.20.0 (`ELECTRON_RUN_AS_NODE=1 electron.exe -e "require('@comfyorg/sdk')"`:
  `Comfy`, `comfy.models.{run,schema,list,submit,subscribe,handle}`, `ComfyLow` from `/low`, no warning). No
  top-level await in `dist/`.
- **Class client** `new Comfy({ apiKey, fetch, timeoutMs, clientInfo })` (`src/sdk/client.ts:208-276`). The base URL
  comes **only** from `process.env.COMFY_BASE_URL`, read once in the constructor (:89-117, :267; a positional URL
  throws, :261); unset = `https://cloud.comfy.org`. An explicit `apiKey` wins over `COMFY_API_KEY` (:185-206).
  **`fetch` is injectable** (:219) and replaces every request's transport; then the SDK leaves out undici's inactivity
  limits (`src/low/transport.ts:63-73`, :347). The bearer goes only to the base URL's origin (:257-283); server links
  resolve against that origin (:240-254). `clientInfo` appends `app/<x>` to the User-Agent.
- **Submit** (`client.ts:314-340`): materializes asset handles, sends `Idempotency-Key` (a fresh one per call unless
  given), `apiKey` as `extra_data.api_key_comfy_org`, optional `metadata`; retries a 429 with Retry-After for up to
  60 s (:347-372). **A reused key is rejected (422 `IdempotencyKeyReuse`), never replayed** (`exceptions.ts:115-118`).
- **Job** (`src/sdk/jobs.ts`): statuses `queued running succeeded canceling canceled failed expired`
  (`types.gen.ts:112`); `wait(timeoutMs, signal)` polls with backoff and is authoritative, `result()` throws
  `JobFailed` with `error { code, message, node_id, class_type }` (:249-269); `cancel()` is a request (:278);
  `events(signal)` SSE, auto-reconnect without replay (:326); `client.jobs.get(id)` rehydrates (:448); the `progress`
  snapshot may be null on Cloud (:160-180). Event kinds: `progress { value, message, nodesDone, nodesTotal,
  currentNode, currentNodeClass, step, steps }`, `preview`, `outputReady`, `statusChange { status, queuePosition }`,
  `log` (`events.ts`). Docs: SSE is "a live enhancement, never the source of truth".
- **Assets** (`assets.ts:182-205`): local blake3, `HEAD /api/v2/assets/by-hash/<h>` then `from-hash` or an upload; a
  handle placed **anywhere** in the graph becomes a `core/ASSET` reference at submit (`core.ts` `findAssetHandles` /
  `substituteAssetHandles`), and must sit in a filename widget (`LoadImage.image`), never an IMAGE socket.
  `Output.toBytes()` follows the content redirect (`outputs.ts:105-121`).
- **Router** `comfy.models` (`models.ts`, `modelRequests.ts`): `submit(model, input, { signal, timeoutMs,
  idempotencyKey, retry })` (:234-258; retries inside one call reuse the key and the Router **replays**), handle
  `events()` / `get()` / `cancel()` (PUT), `comfy.models.run` = the synchronous route, typed `routerErrors.*`
  (`NotEnabled` :471, `InsufficientCredits`, `RateLimited` ...), results `{ kind: json | binary, data, requestId,
  servingProvider, droppedParams, creditsUsed }`. **Correction to the research of 2026-10-18: the Router host is not
  pinned.** `comfy.config({ credentials, baseUrl })` (`credentials.ts:97-129`) sets both in module-private bindings;
  base = config > env `COMFY_ROUTER_BASE_URL` > `https://api.comfy.org` (:206-211). Both are read **per request**
  (`modelRequests.ts:562`, :674), and the Router code calls the bare global `fetch` (`models.ts:1364`,
  `modelRequests.ts:589`): no fetch injection, but a test's `globalThis.fetch` swap reaches it.
- **Not in v2 / the SDK**: node definitions (`object_info`), model browsing, credits, queue management (the Cloud
  docs: "the SDKs don't cover it", direct HTTP on v1); job labels and `listJobs` answer 501 on Cloud.

## 3. Design

(Section 10 overrides parts of this section after the critic round.)

### 3.1 Where it runs

Main process only. One CommonJS wrapper `electron/main/providers/comfysdk.js` is the single place that requires the
SDK, lazily on the first Cloud or Router run (start-up time; a broken package fails one run, not the app):
`cloudClient(ctx)`, `routerSetup(ctx)`, `errorText(err, key)` (SDK and router errors in Scumble's words, the key
scrubbed), `version()` (logged once). Neither the renderer nor `recipes.js` (in the `types` check) imports it.

### 3.2 Base URL and key without process.env

- At start (`main.js`, before the providers load) delete `COMFY_BASE_URL`, `COMFY_API_KEY` and `COMFY_ROUTER_BASE_URL`
  from `process.env`, logging the names (never values): Scumble's targets come from its settings, and a shell profile
  must not redirect the user's key. The safeStorage key never goes into `process.env`.
- **Comfy Cloud: the injected fetch is the seam** (chosen). `new Comfy({ apiKey: ctx.key, fetch: guarded(ctx),
  clientInfo: "scumble/<version>" })`; with the env cleared the client always resolves `https://cloud.comfy.org`.
  `guarded` wraps `ctx.fetch` (the run's abort signal reaches every SDK request) and refuses any first URL that is not
  on that origin. A test profile names `settings.comfycloud.base` (the Router's `testBase` rule: loopback only, and
  only a `test-` key goes there, a real key never); then `guarded` rewrites the origin to the mock. Plain-Node tests
  inject a fake fetch exactly as today's tests do.
- Options considered: (b) a per-construction env guard (set `COMFY_BASE_URL`, construct, restore: synchronous, no
  `await` between, so no mutex; only a URL, never the key): kept for a later proxy connection type; (c) raw v2 HTTP
  with the SDK only for Router: loses the asset and SSE code and the challenge line; (d) vendoring: maintenance for no
  gain; (e) asking Comfy for a per-client `baseUrl` option: worth an issue, not blocking (question 7).
- **Comfy Router**: before each run `comfy.config({ credentials: ctx.key, baseUrl: test || "https://api.comfy.org" })`
  after `checkKey`; an explicit base means the env is never read. Process-global is harmless here (one key, one base
  per profile); a key changed mid-run changes the next poll's key.

### 3.3 A Comfy Cloud run on v2

- `ctx.cloudApi` (`"v2"` default, `"legacy"`; from `settings.comfycloud.api`, set in `contextFor`) picks `runV2` or the
  untouched legacy `run`. The graph builders stay: `upload` becomes `ctx.upload || legacyUpload`; on v2 it returns
  `client.assets.fromBytes(bytes, { filename, contentType: "image/png" })`, a handle that `buildGraph` /
  `buildDetached` place where the filename went (always a `LoadImage.image`). No deep copy of the graph after the
  uploads (a JSON round trip drops the handles' symbol).
- Submit: `client.submit(client.workflows.fromJson(graph), { idempotencyKey, apiKey: ctx.key, signal })`, one UUID
  per run; `apiKey` always (the Cloud docs: partner nodes over HTTP take the key again in `extra_data`); no
  `metadata` (501 on Cloud).
- **Lost-answer rule.** No response to the submit (network error, timeout): send once more under the **same** key. A
  422 `IdempotencyKeyReuse` then means the first one was admitted and its id is lost (no `listJobs` on Cloud): stop
  with "Comfy Cloud took the job but its answer was lost; Scumble does not send it again (it may finish and be
  charged)". Never a fresh key after a lost answer. (Router differs: the same key replays, 3.7.)
- Wait: `job.wait(waitMs, signal)` decides (20 min edit, 30 min upscale as today); beside it `job.events()` on its own
  `AbortController` feeds the bar (3.5) and never fails the run. Timeout: `job.cancel()` best effort, then the error.
- Outputs: `job.getOutputs(saveId)` first (the recipe's SaveImage, as :564-565), else the first image output of type
  `output`, else any image; `output.toBytes({ signal })`; mime from `contentType`; `info { node, model, job_id }`.
- Failures: `JobFailed` -> "Comfy Cloud <node>: <class_type>: <message>" plus `missingNote`; `InsufficientCredits`,
  `Unauthorized`, `QueueFull`, `InvalidWorkflow`, `MissingAsset` in words.

### 3.4 Cancel

`contextFor` adds `ctx.signal`; the SDK calls take it. On abort with a known job id the adapter calls `job.cancel()`
under its own 10 s signal and marks the error (`cancelAsked`); `index.js` then says "asked Comfy Cloud to stop the
job" instead of "may still finish" (:255). The Router adapter does the same with `handle.cancel()` (today only on
timeout).

### 3.5 Progress into the status row's bar

- Main: `edit(request, hooks)`; `main.js:1086` passes `{ progress: (p) => sender.send("provider:progress", { runId,
  ...p }) }` (guarded `!sender.isDestroyed()`), `ctx.progress` throttled to 4 per second per run. Payload: `status`,
  `queuePosition`, `value`, `step`, `steps`, `nodesDone`, `nodesTotal`, `node`. Preload: `providers.onProgress(cb)`.
- Host (app side only, no new `host.*` member the node must answer): the token in `_providerRuns` with that `runId`
  gets `promptId = runId`, then `syncRunBars()` and `trackRun(editor, runId, nodesTotal || 1)`; `statusChange running`
  -> `execution_start`, a new `currentNode` -> `executing`, `step/steps` -> `progress { node, value, max }`;
  `runProgress.done(runId)` where the token leaves (`host.js:2548`). `RunProgress` stays unchanged unless the live
  frames carry only `value` (then a small `fraction` event, `progress_test.js`, `build_node.py --check`).
- Router: `QueueUpdate` only (status, queue position): `IN_PROGRESS` -> `execution_start`; no steps.

### 3.6 The node list (object_info)

v2 has no node introspection. Keep the v1 read (`cloudInfo`, `X-API-Key`; the documented Cloud API for node
definitions) for the detached graphs' pre-check and the UI-workflow import (`main.js:881`), but make it **advisory**:
a failed or odd read logs a warning and skips the pre-check; v2's own `InvalidWorkflow` then names the missing node.
Model-file notes stay as they are.

### 3.7 Comfy Router on comfy.models

Replace `send` / `sync` / `answerOf` (:638-743, ~110 lines) with `routerSetup(ctx)`, `comfy.models.submit(modelId,
body, { idempotencyKey: ctx.uuid(), signal, retry })`, `handle.events({ signal })` for the bar, `handle.get({ signal,
timeoutMs })`, `handle.cancel()` on timeout or Cancel; `routerErrors.NotEnabled` -> `comfy.models.run(modelId, body, {
idempotencyKey: ctx.uuid(), signal })`. Map `kind: binary` to `{ bytes, mime }`, `json` to the dialect's `read`;
`meta` from `requestId`, `creditsUsed`, `droppedParams`, `servingProvider`. `WORDS` / `explain` keyed by
`errorType`. Kept: the body and picture size checks, `checkKey`, `scrub`, `download`, `_shared`.

### 3.8 Local ComfyUI, comfy-api-proxy

Unchanged (`comfy.js`, websocket events, `/object_info/InpaintCanvas` :153, :186). A "ComfyUI behind comfy-api-proxy"
connection type is not part of this update (question 6); it would use option (b) of 3.2.

### 3.9 Fallback

`settings.comfycloud.api: "legacy"` brings back today's path for 0.1.49 (no UI, documented in RECIPES.md and the
manual's troubleshooting line); removed one or two releases after v2 has run. Router: no switch (same contract either
way; `git revert` is the fallback) unless the user wants one (question 2).

### 3.10 Bundle

`npm install --save-exact @comfyorg/sdk@0.5.0` (exact pin, lockfile); `npm ls zod eventsource-parser hash-wasm` must
show zod deduped. `build.files` (all three platform lists) adds `!node_modules/@comfyorg/sdk/src/**`. About +3.5 MB
unpacked. `.mcpb` unaffected (it holds no Scumble). Flathub's npm sources list would need regenerating (its
resubmission is the user's).

## 4. Live check (2026-10-18)

Scumble's own detached Cloud graphs through the SDK (scratchpad `sdk-test/cloud_v2_test.mjs`: `_buildGraph` with
captured uploads, assets bound by `setInput`, `client.submit`, SSE followed, outputs downloaded).

| case | graph accepted unchanged | assets / dedup | events seen (kinds, fields, `value` range) | output (node, type, mime) | time | notes |
|---|---|---|---|---|---|---|
| `cloud_z_image_turbo` text, 768² | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ |
| `cloud_flux2_klein_9b` edit, one LoadImage | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ | _tbd_ |

What it changes in this plan: _tbd_ (the `fraction` event of 3.5, the output choice of 3.3, anything refused).
Not covered by it: a partner-node graph (`SHAPES`) on v2, `extra_data`, cancel, the Router (S5's live run).

## 5. Sessions

(Section 10 changes S0-S8 and the timeline after the critic round.)

**S0: the dependency and the seam (light).** Install as 3.10. `comfysdk.js` (3.1, 3.2: `cloudClient` with `guarded`,
`routerSetup`, `errorText`, `clearEnv`, `version`); `main.js` calls `clearEnv()` at start; `contextFor` adds
`ctx.signal` and `ctx.cloudApi`; `settings.comfycloud.base` read through the Router's `testBase` / `checkKey`. Early
exe check: `npm run dist:dir` (it replaces the Store layout in `dist/win-unpacked`, without `app-update.yml`; S5
rebuilds it), then `ELECTRON_RUN_AS_NODE=1 dist/win-unpacked/Scumble.exe -e "require('<abs
path>/dist/win-unpacked/resources/app.asar/node_modules/@comfyorg/sdk')"` (require(esm) from inside asar).
Test: new `tools/comfysdk_test.js` (plain Node): a fake fetch sees `https://cloud.comfy.org/api/v2/...` with `Bearer`
and `app/scumble/`; a test base rewrites only for a `test-` key and refuses a real one; `COMFY_BASE_URL`,
`COMFY_ROUTER_BASE_URL`, `COMFY_API_KEY` set before `clearEnv()` change nothing after it; `routerSetup` sends to
`https://api.comfy.org` even with the env set. Gates: that test, `lint`, `types`. Commit.

**S0 as built (2026-10-18).** `@comfyorg/sdk` 0.5.0 pinned exactly (one zod 4.5.4; `eventsource-parser` 4.1.2 nested
beside the MCP SDK's 3.1.1; `hash-wasm` 4.12.0); no `build.files` change. `electron/main/providers/comfysdk.js`:
`load` / `loaded`, `version` (package.json beside `require.resolve`, the SDK not loaded), `clearEnv`, `testBase`,
`checkKey(who, setting, test, key)`, `guarded(ctx, { bound, timeoutMs })` (cloud.comfy.org only; a test base gets
every request of a test key and nothing else is reached; another origin only without the key), `cloudClient(ctx,
{ bound })` (`timeoutMs` 300000, `clientInfo` `scumble/<version>`), `cancelJob(ctx, jobId)` (unbound, 10 s),
`routerSetup(ctx)`, `errorText`, `scrub`. `main.js` clears the three variables right after the log is installed and
answers `comfySdk` in `app:info`; `contextFor` adds `ctx.signal` and, for comfycloud, `ctx.cloudApi` ("v2" unless
`settings.comfycloud.api` is "legacy"; the adapter ignores it until S1); `comfycloud.baseUrl(settings)` gives
`ctx.base` from `settings.comfycloud.base`. QW1: *Settings › About* says "Comfy Cloud and Comfy Router run through
Comfy's official TypeScript SDK (@comfyorg/sdk 0.5.0, MIT)" (true once S1 and S3 land). Checks: `tools/comfysdk_test.js`
19/19; `comfyrouter_test.js`, `cloudgraph_test.js`, `upscale_test.js`, `refs_layout_test.js`, `nanobanana21_test.js`
pass; gates `lint`, `types`, `platform`, `mcp`, `assistant` (offline); `npm run dist:dir`, then the packaged exe
requires the SDK from inside `app.asar` and `version()` reads 0.5.0 there without loading it (`dist/win-unpacked` is
now the `--dir` layout without `app-update.yml`; S5 rebuilds it).

**S1: Comfy Cloud on v2 (light).** 3.3 and 3.6 in `comfycloud.js` (`runV2` beside `run`, `ctx.upload`, outputs,
failures, lost-answer rule, timeout cancel). Test: new `tools/comfycloud_v2_test.js` on a fake v2 (`fetch` function
in `tools/fake_comfy_v2.js`: by-hash 404 then upload, a second run with the same crop goes `from-hash` with no upload;
`POST /api/v2/jobs` keeps the graph; job queued -> running -> succeeded; outputs with a preview and the SaveImage;
content 302 to a signed URL; an SSE body; failures). Checks: LoadImage inputs hold `core/ASSET` refs for every picture
the layout wires (partner nodes and `scumble:picture:N` / `scumble:mask`), `Idempotency-Key` present, `extra_data`
carries the key, no `metadata`; a thrown submit is sent once more under the same key and a 422 reuse stops with the
lost-answer words (never a third submit); the own SaveImage wins; `JobFailed` words name `class_type`; a failed
`object_info` read does not stop the run; a timeout cancels. Legacy tests (`cloudgraph_test.js`, `upscale_test.js`
:305-339) pass `cloudApi: "legacy"`; `nanobanana21_test.js` unchanged. Gates: those, `refs_layout_test.js`,
`relight_request_test.js`, `recipes_test.js`, `lint`, `types`; one look (`--no-comfy`, no key: the no-key line).

**S2: Cancel and the bar (normal).** 3.4, 3.5: `index.js` hooks and the `cancelAsked` message, `main.js:1086`,
preload `onProgress`, the host mapping, `RunProgress` only if section 4 says so. Test: `comfycloud_v2_test.js` adds
progress calls and Cancel -> `POST .../cancel`; a `generate` gate step `a_cloud_runs_bar_follows_sdk_events` (feeds
synthetic `provider:progress` payloads for a token through the host's handler: label, fill, done; no network). Gates:
`generate` (tiles), `log` (runs `progress_test.js`), `lint`, `types`; `build_node.py --check` if
`inpaint_progress.js` changed (no node publish).

**S3: Comfy Router on the SDK (light).** 3.7. `comfyrouter_mock.py` accepts `Authorization: Bearer` as well as
`X-API-Key` (comfypartner keeps the latter); `comfyrouter_test.js` moves its adapter fakes to `globalThis.fetch` and
asserts Bearer, replay under one key, `not_enabled` -> the sync route, 402 not resent, a binary answer, cancel on
timeout. Gates: `comfyrouter_test.js`, `python tools/comfyrouter_test.py` against a dev instance (`--no-comfy`),
`lint`, `types`.

**S4: docs and review (light).** `docs/RECIPES.md` "Comfy Cloud recipes" (:194) and "Comfy Router" (:2203): v2, the
SDK, the fallback setting, the test base; the manual (Cloud runs show steps, Cancel stops the job on Comfy's side);
README one line ("Comfy Cloud and Comfy Router run through Comfy's official TypeScript SDK"); CHANGELOG Unreleased;
`docs/TESTING.md` (the new tests); CLAUDE.md "How the app is put together" (Provider runs) and the trap lines of
section 6 worth keeping. A review workflow over S0-S3 (findings checked by a second agent), fixes committed.

**S5: release prep, then the release on the user's word.** The paid live run in a test instance with the user's key
typed in: one partner-node edit on Cloud (GPT Image 2 or Nano Banana 2), one detached graph (Z-Image Turbo text), a
Cancel during a Cloud run (the job ends `canceled`), the bar's steps seen, one Router run (FLUX 3 Image). Then
`## 0.1.49` in the CHANGELOG, `package.json` 0.1.49, `npm run dist`, `dist:portable`, `dist:store`, `dist:mcpb`, the
exe gates of 0.1.48's list with `--exe` plus `comfyrouter` against the exe, and `docs/RELEASING.md`'s chain.

**S6: a job back after a crash (in this update, the user 2026-10-18).** At submit `<userData>/cloudjobs.json` gets `{
jobId, runId, recipe, started }`, removed at the end; at the next start `client.jobs.get(id)` and a finished job's
picture opens as a new document.

**Quick wins (section 9; all eight picked by the user on 2026-10-18).** QW1 rides in S0 (it needs
`comfysdk.version`), QW6 in S3 (it needs S3's mapping). The rest:

- **S7 (light): QW2 + QW3 + QW8.** The calm "No ComfyUI at ..." line instead of the red dot; the Manager first in the
  missing-pack hint and the docs (check the Manager's search finds "Inpaint Canvas" before the text says so; the
  registry's 0.3.4 has no boxes, so no text promises them); the mascot in the title row and About (the duck and 90s
  skins hide it). Gates: `skins`, `help`, `lint`, `types`; one look.
- **S8 (normal): QW4 + QW5.** `relight {preset}` (refused beside `lights` and for an unknown name, with the 8 names;
  `relightCard` row; a relight gate step with `RELIGHT_GATE_SKIP_NODE=1`; MCP.md, `commands_doc.py`); every result
  names model, route and seconds in the status line and the history, kept out of `getValue` (the document format stays
  untouched). Gates: `relight`, `commands`, `generate`, `editor` (tiles), `mcp`, `lint`, `types`.
- **S9 (normal): QW7.** Reference rows reordered by drag (`renderReferences`, an own `dragRefId`, through
  `reorderLayer` / `layersRestacked` / `refsMutated`); an `editor_test` step; `build_node.py --check` and `node_test`
  (the node gets it with its next release, the user's call). Gates: `editor`, `selection`, `lint`, `types`.

Order: S0, S1, S2, S3, S6, S7, S8, S9, then S4 (docs and the review over everything), then S5 (the paid live run and
the release prep). Timeline: S0-S3 by 2026-10-22, S6-S9 by 2026-10-25, S4 2026-10-26, S5 2026-10-27/28 (the live run
whenever the user is there); the deadline is 2026-10-30 17:00.

## 6. Traps

- ESM-only: `require()` works only through `require(esm)`; a future SDK release with top-level await breaks it. Pin
  exactly; check the exe (S0) after every upgrade.
- `comfy.config` is process-global and read per request: set it right before every Router run, after `checkKey`.
- A shell's `COMFY_BASE_URL` would send the Cloud key elsewhere: `clearEnv()` at start, never `process.env` for keys.
- The injected fetch drops undici's inactivity limits: an SSE stream idle for 300 s is cut (the SDK reconnects), a
  download stalled 300 s aborts.
- The bearer goes only to the base origin: with the test rewrite, a mock that answers absolute `http://127.0.0.1`
  links gets no auth on them; the fake answers relative or `https://cloud.comfy.org` links.
- Cloud v2 rejects a reused key, the Router replays it: two lost-answer rules in two adapters.
- Asset handles only in `LoadImage.image`; no `JSON.parse(JSON.stringify(graph))` after they are placed; never log
  the graph with handles as if it were the sent JSON.
- Events are not authoritative and `Job.progress` may be null on Cloud: only `wait()` decides success.
- Bearer instead of `X-API-Key` on Router: the mock and any header assertion change; comfypartner keeps `X-API-Key`.
- Output order: a PreviewImage may come first; the recipe's SaveImage decides, as on the legacy path.
- `npm install` may move the MCP SDK's zod; `npm ls zod` and the `mcp` gate after S0.
- A new `host.*` member would need the node's host too (`build_node.py --check`): keep the mapping inside host.js.

## 7. Risks of a 0.x dependency

The SDK is weeks old (0.5.0, ~13 stars); 0.4 -> 0.5 already removed the positional base URL. Comfy's v2 itself is new
(output retention is "a placeholder", the Router "not generally available yet" per the v2 overview). Its ranges
(`zod ^4.4.3`, `hash-wasm ^4.11`, `eventsource-parser ^4.1`) are fixed only by our lockfile. Mitigation: exact pin,
upgrades only on purpose with `comfysdk_test.js`, `comfycloud_v2_test.js` and one live run; one import point
(`comfysdk.js`), so a swap to raw v2 HTTP (~200 lines) or a vendored copy touches one file; the legacy Cloud path
behind `settings.comfycloud.api` for this release; the GitHub repo has no LICENSE file (the npm tarball's MIT
`LICENSE` is what ships).

## 8. Open questions for the user

1. Keep the legacy Comfy Cloud path behind `settings.comfycloud.api` for 0.1.49 (recommended), or cut it now?
2. Router on the SDK in this update (the challenge line, one session of test rework), or Comfy Cloud only? A fallback
   switch for the Router too?
3. Cancel stops the job on Comfy's side (Cloud and Router), with the words "asked Comfy Cloud to stop the job": yes?
4. Cloud runs show "node k/n · step v/m" in the bar like local runs: yes?
5. S6 (a Cloud job back after a crash) in this update, later, or never?
6. A "ComfyUI behind comfy-api-proxy" connection type: not now (recommended)?
7. An issue on Comfy-Org/comfy-typescript-sdk asking for a per-client `baseUrl` option and a LICENSE file: post it
   (outward-facing, your word and your account), or leave it?
8. 0.1.49 as this update alone, released before 2026-10-30, with "built on the Comfy SDK" in the CHANGELOG and the
   post?
9. The node-list pre-check advisory (skip it when the read fails) instead of a hard stop: yes?
10. The paid live run of S5 (a few cents in Comfy credits, your key typed into a test instance): when?

**The user's answer (2026-10-18), in their words: "nee, alles in einem update und haben wir noch ein paar kleine quick
wins für das update ?"** Read as: one update holds all of it (Comfy Cloud and Comfy Router on the SDK, so question 2
is yes; S6 in this update, question 5; not "this update alone", question 8) plus a few quick wins riding along (being
collected by a workflow, `wf_8745b15b-fc2`). **Then (2026-10-18): all eight quick wins of section 9 picked, "mache
plan und fange mit der entwicklung an".** The other questions have no answer yet; the build goes with the
recommendations until the user says otherwise: 1 legacy path kept behind the setting; 3 yes; 4 yes where the events
carry the numbers; 6 not now; 7 not posted (outward-facing, only on the user's word); 9 yes; 10 at S5 with the user
there.

## 9. Quick wins riding along (candidates, 2026-10-18)

Collected and checked at HEAD `4e6c17e` by a workflow (`wf_8745b15b-fc2`: four finders over BUGS.md / the open-items
list, GitHub issues of both repos, the plans' leftovers, the code and the manual; one skeptic per finder read each
candidate in the code; a ranker merged them). Not picked yet: the user picks; picked ones become sessions after S4
(1 after S0, 6 inside S3).

| # | Quick win | Where | h | Tier |
|---|---|---|---|---|
| 1 | *Settings › About* names the Comfy SDK and its version (`comfySdk` in `app:info`) | `electron/main/main.js:1203`, `renderer/shell.js:2449` | 0.5 | light |
| 2 | No red error dot when no ComfyUI runs (ECONNREFUSED: a calm line "No ComfyUI at ...: only ComfyUI recipes need one"; `state` stays `error`) | `electron/main/comfy.js:199`, `renderer/shell.js:326`, `renderer/index.html:57` | 1.25 | light |
| 3 | The node pack via the ComfyUI Manager first in the app's hint and the docs (`git clone` second); check the Manager search finds it; the registry's 0.3.4 has no boxes | `host.js:1116`, `shell.js:386`, `comfy.js:197`, `README.md:153`, `MANUAL.md:56/65`, stale `BUGS.md:12-20/70-79` | 1 | light |
| 4 | `relight {preset: "golden_hour"}` for agents (the panel's 8 presets through `applyLightPreset`) | `renderer/commands.js:1402`, `inpaint_relight.js:154`, the relight gate | 1.5 | normal |
| 5 | Every result names model, route and seconds ("FLUX 3 Image via Comfy Router, 23 s") in the status line and the history; not in `getValue` | `host.js:1876/1878/2061/4937`, `inpaint_canvas.js:18570-18578/20550` | 2.75 | normal |
| 6 | Comfy Router reports left-out parameters and the serving provider (`out.notes`; "served by" in `HINT_NOTE`) | `electron/main/providers/index.js:221-265`, S3's mapping | 1.5 | light |
| 7 | Reference rows reordered by drag, the `@img` chips renumber (node issue #1, ask 3) | `inpaint_canvas.js:18964-18993` `renderReferences` | 2 | normal |
| 8 | The mascot in the title row and in About (the duck and 90s skins hide it) | `build/icon-small.svg`, `index.html:16/184` | 1.5 | light |

Lower: `boxes_check` (2.5 h), a hint on Klein's `mat1 and mat2` (1.5 h), `probe_comfy` (2 h; must refuse under
`--no-comfy`), `reopen_closed_tab`, `crop_plan` in `status`, `text_spacing` (1 h each), `read_pixels` (2 h),
`import_recipe` (after §3.6), the README graph count (5 min). Unchecked: the Comfy credit balance on the key row
(`GET /customers/balance`, measured once, `docs/HISTORY.md:2309`; 2 h). Rejected: the node's progress bar (a live run on
the production ComfyUI and a node push), FLUX 3 on Comfy Cloud (only the paid run checks it; Router covers it), the
Qwen 2.1 example workflow, an early refusal of JPEGs above 268 MP, a FLUX 3 warning for shown but unnamed references.

## 10. After the critic round (2026-10-18): these override sections 3, 5 and 9 where they differ

Three critics read the plan against the SDK source, the repo and the session list (workflow `wf_ad280102-225`; full
findings in the session scratchpad `critics.json`). Three musts, the rest shoulds; all taken in:

**Musts**
1. **Cancel needs a transport not bound to the run (3.4).** `guarded(ctx)` wraps `ctx.fetch`, which refuses every
   request once the run's signal fired (`index.js:365-371`), so `job.cancel()` after a user Cancel never leaves the
   machine and the job runs on, billed. `comfysdk.cancelJob(ctx, jobId)`: a second short-lived client (or `ComfyLow`
   from `@comfyorg/sdk/low`) on `guarded` over plain `globalThis.fetch` with `AbortSignal.timeout(10000)`;
   `cancelAsked` only when that call answered (status canceling / canceled). S2's test aborts the run's controller
   first, then asserts the fake got `POST .../cancel`. The Router's `handle.cancel()` uses the bare global fetch and is
   not affected.
2. **No `!node_modules/@comfyorg/sdk/src/**` in `build.files` (3.10):** it breaks the `platform` gate
   (`platform_test.js` compares the lists). Ship the small TS sources; `platform` joins S0's gates.
3. **Node checks run as the `nodecopy` gate** (S2 if `inpaint_progress.js` changes, S8, S9), never `build_node.py
   --check` / `node_test` against the live node folder: that folder is the user's production ComfyUI (any write
   hot-reloads it).

**SDK facts the design now uses**
- `version()` reads `package.json` beside `require.resolve("@comfyorg/sdk")` (one folder up from `dist`) with `fs`
  (asar-aware), without loading the SDK (no `SDK_VERSION` export; `./package.json` is not in the exports map);
  `comfysdk_test.js` asserts `"0.5.0"` with the SDK not loaded.
- `new Comfy({ apiKey, fetch, clientInfo, timeoutMs: 300_000 })`: an explicit timeout (large uploads).
- `job.wait()` returns on every terminal status and throws only on its own timeout: after it, `status !== "succeeded"`
  builds the error from `job.error` (`{ code, message, node_id?, class_type? }`, may be null), with own words for
  `canceled` and `expired`; a timeout is a non-terminal status after the throw.
- `Output.type` is the kind (`image`, `video`, ...), not the ComfyUI output/temp split: pick `getOutputs(saveId)`, else
  the first `type === "image"` output. Partner graphs pass the id of the SaveImage `buildGraph` writes (today `saveId`
  is null for them, `comfycloud.js:561`).
- Metadata: `metadata_not_supported` on Cloud; `listJobs` 501.
- SSE: reconnects after 45 s idle by design; with `guarded`, server links must be relative or on
  `https://cloud.comfy.org`.
- `errorText` keys on `err.errorType || err.code`, never `instanceof` across the two error hierarchies.
- `ctx.cloudApi`: the v2 default is set in `contextFor` only; the adapter treats a missing value as legacy, so direct
  callers (`refs_layout_test.js` `capture`, `cloudgraph_test.js`, `upscale_test.js`, `nanobanana21_test.js`,
  `_buildGraph` in the live-check script) stay legacy unless they ask for v2. `buildGraph` / `buildDetached` fall back
  to the legacy upload whenever `ctx.upload` is absent.
- Cloud base for tests: `comfycloud.baseUrl(settings)` on `testBase(settings.comfycloud.base)` with a Cloud-worded key
  check (S0).

**Router decisions (3.7)**
- Binary answers exist only on the synchronous `comfy.models.run` (the `not_enabled` fallback); on the queued path a
  non-JSON body is `invalid_response`, mapped to Scumble words.
- The SDK queue retries only transport errors and 5xx. Kept in the adapter as a small loop so the current behaviour
  stays: `RateLimited` / `ConcurrencyLimitExceeded` from submit resent under the **same** idempotency key after
  `err.retryAfter`, up to `RESEND_MAX`; a 429 on a status read or an `invalid_response` 202 after COMPLETED re-attaches
  with `comfy.models.handle(model, requestId)` and polls on (bounded). A submit `request_timeout` or transport error is
  sent once more under the same key (the Router replays).
- One loop: `handle.events({ signal, timeoutMs })` feeds the bar, then `handle.get({ signal, timeoutMs: 0 })`.
  `request_id` from `handle.requestId` (from `result.requestId` only on the sync fallback).
- QW6 reworded: "served by <x>" only when the fallback-provider header names one, dropped parameters only when that
  header is present (mostly the synchronous route); no line on ordinary queued runs. It stays in S3 (small), but it is
  no video moment.

**Host and bar (3.5)**
- Provider run ids stay out of the local ComfyUI lifecycle: `checkTrackedRuns` and `idle()` (`host.js:2627-2647`,
  `:4965-4968`, `:503`) skip them (a set of provider run ids in host.js); a gate step: a local status with
  `queue_remaining 1` while a Cloud token is tracked leaves its steps in place.
- `trackRun` on the first payload that carries `nodesTotal`, or a `nodes(id, n)` setter on `RunProgress`
  (`progress_test.js` case, `nodecopy`).

**Session changes**
- **S0** gates add `npm ls zod eventsource-parser hash-wasm`, `platform`, `mcp` and `assistant` (offline, last).
- **S1** adds `refs_layout_test.js` to its list; the fake v2 contract: 201 job `{ id, status, urls: { self, events,
  cancel }, outputs: [], created_at, expires_at }`, outputs with v2 kinds, the fake follows its own 302 (drops
  Authorization cross-origin) or serves bytes inline, headers read with `new Headers(init.headers)`; SDK-path tests use
  fakes without Retry-After and `retry: { baseDelayMs: 1, maxDelayMs: 5 }`, no `ctx.sleeps` asserts on SDK paths.
- **S2** is Cloud cancel and the bar only; its gate step runs a real loopback run through IPC whose adapter emits a few
  `ctx.progress` frames (label, fill, done), plus the local-status step above. If section 4's live check has not run
  by then, S2 builds the value-only `fraction` path anyway (`progress_test.js`, `nodecopy`).
- **S3** takes the Router cancel and its `cancelAsked` wording (`comfyrouter_test.js:676`), and the test rework the
  critics listed: `comfyrouter_test.py` `check_run` header checks (Bearer on Router calls, `X-API-Key` still on the
  comfypartner calls, :343-355), `comfyrouter_test.js` :295-297 (header set, `ctx.sleeps`), :300-303 (202 re-poll, now
  the adapter loop), :663, :676; and three more tests that drive the Router through `ctx.fetch` fakes:
  `ideogram45_test.js` `runCr` (:364-377), `nanobanana21_test.js` `firstRequest` (:153-183; it uses `k-test` without a
  test base, so it must get a `test-` key and a loopback base or it would reach api.comfy.org), `refs_layout_test.js`
  `capture` (:341-347; a dead loopback base makes the SDK retry for 60 s per case: point it at a fake). Fakes move to a
  `globalThis.fetch` swap restored in `finally`. QW6 with a `comfyrouter_test.js` case (notes reach `out.notes`,
  "served by" matches `HINT_NOTE`). Re-estimated: S3 is a full session.
- **S6** is full tier (start-up restore): plain-Node test on the fake v2 (`jobs.get`: succeeded, failed, expired,
  running, 404; the entry removed after each); a gate step that seeds `cloudjobs.json` in an offline profile without a
  key and asserts no request goes out; the `quit` and `document` gates. Rules: no call without a key, none on a
  headless / `--mcp` / agent start, entries older than 24 h dropped, never a resubmit, after the autosave restore.
- **S7**: the mascot SVG is copied into `renderer/` (`renderer/mascot.svg`, a note tying it to
  `build/icon-small.svg`), hidden by the duck and 90s skins' CSS.
- **S8** adds the `assistant` gate (offline, last) with a policy case (relight with a preset and no route is auto; the
  preset row on the card).
- **S4** adds a manual line each for QW2, QW5, QW7, the CHANGELOG lines of all eight quick wins, the CLAUDE.md
  Decisions line on the Manager (QW3).
- **Section 4's live check** runs with the user before S1 if they are there (the scratchpad script waits for the key).
- **Timeline:** S5 (the release prep) done by 2026-10-28 at the latest; 2026-10-29 for the video and the post. If
  behind, cut S6 first, then S9; S0-S3 and S8 carry the entry.
