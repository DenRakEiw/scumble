# CorridorKey 2.0, I2 (the registry and the downloader): notes for the integration

Built 2026-11-06 on the branch `ck-i2` (from `corridorkey` at `6e9c0cf`), session I2 of `docs/PLAN_CORRIDORKEY.md`.
This file holds what I2 could not write into files other groups also touch (the shell, the facade, the settings,
the CHANGELOG, the manual, TESTING.md, CLAUDE.md); the integration copies each piece where it says, then this file
can go.

## What I2 built (its own files)

- `electron/main/onnx/models.js`: the downloader hardened (the sha256 per file, the token rule, the resume cases, the
  free-disk check, the terms, the overall progress), sets of many files in their own folder under `onnx/`, the
  CorridorKey 2.0 entry, `offered`, `describe`, `verify`, `termsText`, `setFolder`, `targetDir`, `hfTokenAllowed`,
  `fromSetCatalogue`, `hashFile`. The hashes of every helper but RMBG-2.0, their URLs pinned to the commit the hash
  was read at, and SAM2 large's decoder size fixed. `docs/HELPERS.md` "Downloads" is the full description.
- `electron/main/onnx/corridorkey2.json`: the set's catalogue, a placeholder (28 planned files, no URL, no sha256).
- `tools/ck2_catalogue.js`: writes that catalogue from a built set folder (`--set`, `--version`, `--base`, `--check`).
- `tools/download_test.js` (64 checks), `tools/scan_test.js` (22 checks, six new for the set).
- `docs/BUGS.md`: the downloader entry marked fixed in place; `docs/HELPERS.md`.

## The interface (exact)

```js
const models = require("./models");          // electron/main/onnx/models.js
models.offered(model) -> boolean             // every file has a URL; a set also a size and a sha256 per file; never a placeholder
models.describe("corridorkey2", dir, links?, elsewhere?) -> row | null
//   row: { id, kind: "key", label, note, source, sourceUrl, license, gated, offered, files: [{ name, role, size, path,
//          rel, bytes, present, linked, partial }], present, linked, bytes, size, elsewhere,
//          set: true, subdir: "onnx/corridorkey2", folder, version, approxBytes, terms: { version, text, links },
//          termsText, placeholder, invalid }
models.describeAll(dir, links?, elsewhere?, { all = false }?)   // leaves out what is not offered unless all
models.setFolder(model, dir) -> string | null                   // the folder of a present set (the key process loads from it)
models.termsText(model) -> string                               // the terms paragraph with {size} and {host} filled in
models.verify(id, dir, lookup?) -> Promise<{ id, ok, files: [{ name, path, ok: true | false | null }] }>
models.hfTokenAllowed(url) -> boolean
new models.Downloader(dirProvider, tokenProvider, onProgress, {
    termsAccepted?: (model) => boolean,      // default: never, so a model with terms is refused until this is wired
    tokenAllowed?, freeSpace?, lookup?, fetch?,   // for tests
})
downloader.download(id) -> Promise<locate() | null>             // null when cancelled
downloader.running() -> { [id]: { file, received, total, index, count, setReceived, setTotal } }
// onProgress events:
//   { id, file, received, total, index, count, setReceived, setTotal }   while a file streams (every 200 ms) and at its end
//   { id, done: true, count, setReceived, setTotal }
//   { id, file, index, count, error, cancelled }                         error null when cancelled
```

Refusals thrown before any request: `unknown model <id>`, `<label> is not available for download yet.`,
`<label>: its licence terms have to be accepted before the download.`, `<label> is already downloading`. Thrown as the
download's error (with an `error` event): `Not enough free disk space for <label>: the download needs <n> in <dir>,
<m> are free.`, the checksum, size, HTTP and redirect sentences (`docs/HELPERS.md` "Downloads").

## What the integration has to do

1. **`electron/main/onnx/index.js`** (plan I2's `:20, :158`):
   - `DEFAULTS.key = "corridorkey2"`; `MISSING.key` = the readiness sentence of the plan's §4.8 table ("Key screen
     needs the CorridorKey 2.0 set (about 2.4 GB): download it in Settings › Helpers (Help › Scumble help › Key
     screen).").
   - The Downloader's fourth argument: `{ termsAccepted: (m) => !!m.terms && ((conf().terms || {})[m.id] === m.terms.version) }`,
     and an `acceptTerms(id)` that stores `helpers.terms[id] = model.terms.version` through `settings.set` (once per
     machine: settings.json is per profile; a new terms `version` asks again). IPC `helpers:acceptTerms`, preload
     `helpers.acceptTerms(id)`, `main.js` beside `helpers:download` (`main.js:1235`).
   - `status()` gains `key: models.describe(conf().key, dir, links(), sc ? sc.elsewhere : null)` and
     `termsAccepted: conf().terms || {}`; `keying.inAppOffered` (§4.3) is `status.key.offered`, never a setting.
   - For I3: `keySetFolder()` = `models.setFolder(models.byId(conf().key), modelsDir())`, null meaning "not
     downloaded" (`MISSING.key`).
   - Optional: `helpers:verify` -> `models.verify(id, modelsDir())` for a Verify button or the parity test.
2. **`electron/main/settings.js:23`**: `helpers.key: "corridorkey2"` and `helpers.terms: {}` in the defaults; the
   settings migration test with them.
3. **`renderer/shell.js` `renderHelpers`** (`:2077-2143`): the kind label `key: "green / blue screen keying (CorridorKey
   2.0)"` in the name's title (`:2077`); a set's row text from `m.license` and `m.approxBytes` ("about 2.4 GB
   download"); while downloading a model with `dl.count > 1`, the info line "file <index> of <count> · <setReceived>
   of <setTotal>" (fmtBytes) and the bar's width from `dl.setReceived / dl.setTotal` (`:2088-2090`, `:2136-2143`;
   a one-file model keeps today's line). The Download button of a row with `m.terms` and no acceptance first opens
   the terms dialog (`renderer/dialogs.js`, item 25): `m.termsText` and `m.terms.links` (a `file` link opens the set's
   notices file once it is present), *Accept and download* / *Cancel*; on accept `helpers.acceptTerms(m.id)` then
   `helpers.download(m.id)`. A model that is not offered never reaches `renderHelpers` (describeAll leaves it out),
   so nothing there needs a dormant branch.
4. **`docs/BUGS.md`**: move the entry "(Fixed for 0.1.52 ...) The helper downloader sent the Hugging Face token ..."
   from "Open" under "Fixed, waiting for its release" (it was fixed in place to keep the merge to one hunk).
5. **`CHANGELOG.md` `## Unreleased`**, two lines for the user:
   - "Helper models (Settings › Helpers) are now checked against their published checksum after the download, where
     Hugging Face lists one (all but RMBG-2.0, which is gated); a download that does not match is deleted and can be
     started again, and a broken download picks up where it stopped. Your Hugging Face token is sent to Hugging
     Face only."
   - "SAM2 large downloads again: its decoder is 24 bytes longer on Hugging Face than Scumble expected, so the
     download always stopped at the size check. A download that stopped there finishes at the next click without
     fetching the file again."
6. **`docs/MANUAL.md`** (Settings › Helpers, `:816`): one sentence: "Every download is checked against its published
   checksum where there is one, and a stopped download resumes; the Hugging Face token you save there is sent to
   Hugging Face only." The CorridorKey chapter (§4.12) takes the terms paragraph from `m.termsText`'s source,
   `corridorkey2.json` `terms.text`, so the dialog and the manual say the same.
7. **`docs/TESTING.md`** (beside `node tools/helpers_test.js`, `:80`): "`node tools/download_test.js` checks the
   helper downloader without network or models (two local HTTP servers as two hosts, a fetch stub for huggingface.co
   and its CDN): the token rule, the sha256, the resume cases, sets in their own folder, the overall progress, the
   free-disk and terms refusals, the CorridorKey placeholder, `tools/ck2_catalogue.js`." Optionally a gate rule
   `download) node tools/download_test.js` in `tools/run_gates.sh`, as `scan` has none either.
8. **`CLAUDE.md`** item 49's block: "I2 done (`ck-i2`): ..." with the commits.
9. **The set at I1 / the release** (no code change): `node tools/ck2_catalogue.js --set dist/ck_onnx/<version>
   --version <version>` after I1 (the entry stays not offered without `--base`), `--base <hosting folder URL>` at the
   release once the files are uploaded, `--check` against the uploaded copy; then `docs/HELPERS.md`'s rows per part
   (pinned revisions, sha256, licences). The catalogue's planned list (28 files: buckets 768², 1024 × 768, 768 × 1024,
   1024²) is a guess at I1's layout; the tool replaces it whole.
10. **`THIRD_PARTY_NOTICES.md`** (plan §3.3; committed with the set's hosting, so not drafted as a file here): in the
    repo root and inside the hosted set: Corridor's LICENSE (`CorridorKey2.0@cf44a8d`), NVIDIA's Open Model License
    and its `Notice` line ("Licensed by NVIDIA Corporation under the NVIDIA Open Model License"), Microsoft's MIT
    notice for MoGe-2 (and the Apache-2.0 notice for its DINOv2 code), the CC BY 4.0 line for RVM (Google DeepMind),
    each part marked "converted to ONNX / fp16 by Scumble from <source @ revision>". The catalogue's terms link
    `{ "file": "THIRD_PARTY_NOTICES.md" }` points at the copy inside the set.

## Decisions I2 took (the plan left them open or was looser)

- **The token never goes to Hugging Face's CDN hops** (the plan allowed "its CDN redirects that Hugging Face
  documents"): the redirect URLs are signed, gated downloads already worked that way (undici dropped the header on
  a cross-origin redirect), and a narrower list cannot leak. Only `huggingface.co` and `hf.co`, https, default port.
- **`onnx/corridorkey2/` is under the model folder**, not under `downloadDir`: in a ComfyUI models folder that is
  `models/onnx/corridorkey2/` (the plan's wording), in the app folder `<app models>/onnx/corridorkey2/`, one rule
  for both, and never a bare `corridorkey2/`.
- **A set is offered only with a size and a sha256 per file**, a placeholder never; the terms are enforced in main
  (default refuse), not only by the dialog.
- **The placeholder lists 28 files** (the plan's "file 7 of 25" counted the graphs and weights; the manifest, the
  notices and the licence are files of the set too).
- **The whole-file `.part` is kept when it checks** (no request): this is what finishes the user's SAM2 large
  download.

## Measured / read for I2

- The Hugging Face tree API at each pinned commit, 2026-11-06: every registry size matched but SAM2 large's decoder
  (20,640,910 on HF, 20,640,886 in the registry); HEAD of each pinned resolve URL: 302 to `us.aws.cdn.hf.co` with
  `X-Linked-Size` and `X-Linked-ETag` equal to the recorded size and sha256. RMBG-2.0's oids are masked without a token.
- The user's models folder (`%APPDATA%\Scumble\models`, listed, not read): `sam2_hiera_large.decoder.onnx.part` of
  20,640,910 bytes from 2026-10-05 beside the large encoder.
