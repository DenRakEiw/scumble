# An external review, verified (2026-11-07)

The user pasted a security and performance review written by another AI agent (2026-11-07, in German: nine security
points S1-S9, twenty performance points P1-P20). A workflow of eight read-only verifiers (one per area, each told to
refute what the code does not show) checked every point against `wasm-kernels` at `4f1826d`. Their full answers, one
object per point (verdict, severity, evidence with file:line, impact, an existing plan entry, the minimal fix, its
risk), are in `verified.json`. A dated snapshot, not kept up to date.

## The verdicts

Nothing is high. The review's severities were too high throughout: for a local single-user app most points need code
already running in the window (a plugin the user installed) or in the user's ComfyUI page, which already has more power.

| Id | Verdict | Severity | In one line |
| --- | --- | --- | --- |
| S1 | confirmed | low | `main.js` `setWindowOpenHandler` passes any URL to `shell.openExternal`; the IPC route checks http(s). Only window code reaches it (which can already read and write any path through IPC); a middle-click on an `href="#"` link may show Windows' "find an app" prompt |
| S2 | partly | low | `comfy:probe` loads the stored ComfyUI secret for any URL; only a plugin can call it. Custom auth headers do follow a cross-origin redirect |
| S3 | confirmed | low | The ComfyUI window's sign-in popups have no navigation guard; `.firebaseapp.com` lets any Firebase project open as a popup. **New, not in the review:** the `persist:comfyui` session has no permission handler, so a page there gets camera / microphone / location without asking |
| S4 | partly | low | `bypassCSP` changes nothing today (the CSP allows `scumble://app` anyway); `/comfy/*` responses carry the server's content type on the window's origin |
| S5 | partly | low | **The one a file can trigger:** a crafted PSD / ORA can ask the renderer for gigabytes (an uncapped inflate, unbounded layer and mask rectangles): a crash of every tab, no code execution. K2's `inflate_z` with a cap covers part of it only if Stop 2 picks Rust |
| S6 | partly | low | The local command pipe's line buffer has no cap and rescans the whole string per chunk (quadratic on one huge line); the Linux socket has no 0o600 (umask covers it in practice) |
| S7 | refuted | none | A plugin's icon in `innerHTML`: the plugin already runs with the window's rights |
| S8 | partly | low | CI `contents: write` for every run (fork PRs get read-only tokens anyway); `provision.sh` unpinned clones (never run) |
| S9a | partly | low | `recipes.save` writes `recipe.id` unsanitised; only a hand-copied recipe file with `../` in its id reaches it |
| S9b | partly | none | Unchecked `w * h * 4` in old exports: inside the wasm sandbox, unreachable at sizes Scumble opens |
| P1 | partly | low | `shadow_march`'s per-tap constants: K13's job; the hoists keep the bytes only where the twin changes the same way |
| P2 | partly | none | `deflate_part`'s compressor per call: under 0.1 % of deflate |
| P3 | partly | low | `height_normals`: a few tens of ms of a 320 ms pool job |
| P4 | partly | low | `dilate`'s divisions and whole-image scratch: perhaps 10-20 ms in a worker, not felt |
| P5 | refuted | none | `grow_mask`'s clear |
| P6 | confirmed | low | The GL compositor's redundant clear and location lookups: about 0.03 ms a frame |
| P7 | partly | low | Grain on pan: this design was measured at 2 ms per step already |
| P8 | confirmed | low | The curves histogram read back on every run (0.5-2 ms, inferred) |
| P9 | partly | low | Gradient / fill layers have no GL path (10-20 ms per pan frame, inferred) |
| P10 | confirmed | **medium** | `inpaint_tiles.js` `tileWithGutter` copies byte by byte: u32 words (as `coarseSlot` does) could take a 1:1 far-pan frame from about 12 to 5-7 ms (inferred), the same bytes |
| P11 | partly | low | Lens blur's CPU fallback recomputes snapField per tap (the GPU path is the default since 0.1.46) |
| P12 | partly | low | relight's `detailRatio` allocations (memory more than time); K24 covers the guided part |
| P13 | confirmed | low | The CorridorKey refine (`keymatte.js`) on a key larger than the cap: about 1 s of an estimated 8-11 s saved by reused scratch and one hoisted mean, the same bytes |
| P14 | partly | **medium** | SAM2, matting and depth run on Electron's main process (`docs/HELPERS.md` already says so): seconds of a frozen IPC per CPU cutout; the fix is LaMa's utility process |
| P15 | confirmed | low | `ComfyClient.probe`'s eleven serial requests: 1-2 s per Test on a remote server |
| P16-P19 | partly | none / low | Small main-thread and UI costs (sync fs on plugin assets, `openSettings`' serial awaits with an `nvidia-smi` spawn, a forced layout per streamed token, a double PNG decode on oversize runs) |
| P20 | refuted | none | The JSON round trip of a command reply: it drops what structured clone would refuse |
