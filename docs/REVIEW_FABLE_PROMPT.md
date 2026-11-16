# Whole-code review with Fable 5.2 (prompt for 0.1.57)

Written 2026-11-16 for the review of the finished 0.1.57 state, before its release. Run it as a workflow; every agent
(reviewers and verifiers) on `model: "fable"` (Fable 5.2, `claude-fable-5-2`). Replace `<SHA>` with the tip of
`quick-wins` once lanes A-E of `docs/PLAN_0_1_57.md` "Second round" are merged.

---

You review Scumble, an Electron desktop editor for AI inpainting (GPL-3.0), at commit `<SHA>` of `F:\canvas`
(branch `quick-wins`). Work in a detached worktree of that commit (`git worktree add --detach
.claude/worktrees/review-fable <SHA>`, a junction to `F:\canvas\node_modules` made with `cmd //c mklink /J`, removed only
with `cmd //c rmdir`). **Read-only:** change, build, commit or push nothing; no app starts on ports 9555 or 9576; never
touch the user's ComfyUI on 8188; no request to any provider with a key; no downloads.

Read first: `CLAUDE.md` (what the app is, "How the app is put together", "Traps worth keeping"), `docs/BRIEF.md`,
`docs/DOCUMENTS.md`, `docs/RECIPES.md`, `docs/TESTING.md`.

## What counts as a finding

A defect you can show from the code: a concrete input or state, the steps, and the wrong outcome (lost or corrupted
pixels or data, wrong pixels on screen or in an export or a paid run, a paid job lost or charged twice, a key sent where
it must not go, a crash or hang from a crafted file, a refusal of a valid case, a measurable slowdown on a 15k
picture). Not a finding: style, naming, a missing comment, a refactor wish, a guess without a path through the code.

Severity: **must** (data or money lost, wrong pixels in an export or run, a security hole), **should** (a real bug a
user can hit, with a workaround), **nice** (an edge case, a misleading message, a small waste).

Leave out what is already known: the open entries of `docs/BUGS.md`, every finding in
`docs/research/review_full_2026-11-12/verified.json`, `review_full_2026-11-07/verified.json` and
`review_external_2026-11-07/verified.json`, and the steps still planned in `docs/PLAN_WASM_BUILD.md`. A finding that
repeats one of those is marked `known`, not counted.

## Part 1: everything since the last review, in depth

`git diff ce4415ec..<SHA>` (the last whole-code review read `ce4415ec`). It holds: that review's own fixes (lanes
shell-assistant, editor-a, host-main, editor-b; `f7f6e0e0`, `6601a96f`, `24d2640f`), Deep paint (item 72,
`docs/PLAN_SURFACE_PAINT.md`: `inpaint_surface.js`, `inpaint_surfacefx.js`, `inpaint_wrap.js`, relight on the surface
maps, the intrinsic / MoGe-2 helpers), Gemini 4 Hydrogen, Seedream 5.5 on OpenRouter, the night build's items 63, 65,
68, 61, 66, 67 and the second round's lanes A-E (`docs/PLAN_0_1_57.md`), and the two live fixes `9e6a125c` / `e723cf9f`.
One reviewer per slice:

1. Deep paint: the layer, its storage and FEATURES row, the brush on it, Fill / bucket / eyedropper, every geometry op.
2. Deep paint: the surface maps, relight with `surface`, Wrap and its live follow, the points map.
3. The review fixes of 2026-11-12 themselves (a fix is new code: did each close its hole without opening another?).
4. Items 63 and 61 (outpaint after extend, contact shadow) and lane A's undo step for a landed result.
5. Items 65 and 68 (scope and clipping view pass, a frame from a video: `videofiles.js`'s token server) and lane D's
   open by path.
6. Items 66 and 67 (Parameters in the ComfyUI window: the page script, the IPC; the mannequin and the per-plugin undo
   data).
7. Lanes B, C, E (a split kept across a page reload, Split on OpenRouter, the small fixes, Florence-2 in the helpers
   process and its downloader entry).

## Part 2: the rest of the code, a second pair of eyes

The same fifteen slices as `docs/research/review_full_2026-11-12/README.md` (canvas-core, canvas-tools, canvas-select,
prompt-refs, tiles, filters, relight-depth-key, files-io, rust, host-gen, main-docs, main-net, providers, shell,
assistant-glb), on `<SHA>`, looking for what the Opus review of 2026-11-12 did not find.

## One cross-cutting lens: what a provider will refuse

The two bugs of 2026-11-16 were invisible to a code review that trusted the code's own idea of the API: a seed above
Seedream's 2147483647, and Comfy Cloud's job links on another origin, which the SDK then read without the key. One
reviewer goes through every adapter in `electron/main/providers/` and every recipe variant in `recipes/` and checks each
value Scumble sends against the provider's saved schema in `tools/refs/` and its docs cited in the code: number ranges
(seeds, steps, strengths, sizes), enums, field names per model, required fields, picture counts and byte limits, and
every place where Scumble follows a URL the server returned (status, events, cancel, downloads, redirects) with or
without its key. Report a value only with the schema line that refuses it.

## How to run it

Each finding from a reviewer goes to a second agent that tries to refute it against the code at `<SHA>` (read the
lines, follow the call path, check the guards); only confirmed findings are kept. Record per finding: `id`
(`slice/short-slug`), `severity`, `category` (bug, data-loss, money, security, perf), `file:line`, `function`, the claim,
the failure scenario, the evidence (quoted lines), a suggested fix and its effort (small / medium / large), and the
verifier's verdict and reason. Reviewers also note what they read and what they suspected without proof.

Write the result to `docs/research/review_fable_<date>/` in the main checkout: `README.md` (what was read, counts per
slice and severity as in the 2026-11-12 README, the musts in full, the shoulds worth doing first, then every confirmed
finding) and `verified.json`. Nothing is fixed by the review; the main loop and the user pick what gets fixed before
the release.
