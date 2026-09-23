# Lint and types: the plan

Decided with the user on 2026-09-23, after the question whether the project should gain another
language. The answer was no, and this is what it should gain instead. The project has 41,333 lines
of JavaScript in `renderer/` and `electron/`, and before this plan it had **no linter, no tsconfig,
no file with `@ts-check` and nine typed JSDoc parameters in total**. That is the gap, not a missing
language.

The reason it matters is on the record. When `inpaint_canvas.js` was split (2026-09-18), one ESLint
run found the only mistake the whole exercise could have shipped: a later `++partsSeq` on an
**imported binding**, which `node --check` parses happily and which throws at run time. That config
lived in a session's scratchpad and was lost with it.

**The rule for every stage here: nothing that ships changes.** The editor's `.js` files are both the
source and the delivered artefact - `tools/build_node.py` copies them into the ComfyUI node, where a
browser loads them as they are - so no compiler may stand between the file that is edited and the
file that runs. Everything below checks; nothing transforms.

## Stage 1 - the linter (BUILT, 2026-09-23)

`eslint.config.mjs` at the root, ESLint 10 flat config, `eslint` and `globals` as devDependencies.

**Eleven rules, all about correctness, none about style.** `no-undef`, `no-import-assign`,
`no-const-assign`, `no-dupe-keys`, `no-dupe-args`, `no-dupe-class-members`, `no-unreachable`,
`no-fallthrough`, `no-self-assign`, `no-unsafe-negation`, `no-cond-assign`, plus `no-unused-vars` as
a **warning** (arguments exempt, `_name` exempt). Formatting, quotes, semicolons and line length are
deliberately absent: a rule that fires on working code teaches people to stop reading the output.

**Five environments**, because the repository holds five: ES modules in the window
(`renderer/**`), the two workers, the plugins (with `scumble` as a global), CommonJS in the main
process and the Node tests (`electron/**`, `tools/**`), and the preload, which sees both worlds.
Two files under `tools/` are browser modules wearing a tools path - `pixels_test.js` is evaluated
inside the renderer by its Python driver, `node_test/` stands in for ComfyUI's own page scripts -
and they get browser globals plus `gc` (Chromium's, from `--expose-gc`). Vendored libraries
(`plugins/*/vendor/**`) and the node's built `js/` are ignored.

**What the first run found:** 55 errors and 18 warnings, of which 52 errors were the config not yet
knowing those five environments. What was left over the whole tree:

- One `no-self-assign`: `s.canvas.width = s.canvas.width` in `inpaint_tiles.js`, which is the
  idiom for resetting a canvas and was already commented as such. It carries an
  `eslint-disable-next-line` with the reason now - the one line of source this stage changed.
- 18 unused names: dead `require`s (`net` in `main.js`, `fs` in `log.js`), leftovers from renames,
  an unused helper in the film plugin. Each harmless, none touched. They stay as warnings, which
  is exactly what a warning is for: a list to work through, not a build to break.

**No latent crash was found.** That is a result, not a disappointment: the tree has been through
gates, mutation rounds and reviews for months.

Wired in three places: `npm run lint`, the gate `lint` in `tools/run_gates.sh` (no app, no Python,
like `node`), and a **Lint** step in `.github/workflows/build.yml` before the kernel check, so a
push that breaks it is red before anything is built. The gate fails on errors; warnings are printed
and pass.

## Stage 2 - `@ts-check` where the contracts are (NOT BUILT)

Not the whole tree, and not now for `inpaint_canvas.js`. Types earn their keep where two pieces of
the app have to agree on a shape, and today those agreements are checked by hand or not at all.

1. **The host contract.** `renderer/editor/host.js` (the app) and the node's own `js/host.js` must
   answer the same members, and `tools/build_node.py --check` enforces that by **grepping for the
   calls the editor makes**. A `@typedef` for the host, `@type` on both implementations, and `tsc`
   does statically what a Python script does textually. The grep stays; it also guards the node
   repository, which has no tsconfig.
2. **The command core.** `renderer/commands.js` carries a descriptor per command (name, params,
   types) that `docs/COMMANDS.md`, the MCP server and the assistant's policy all read. One
   `@typedef` for a descriptor and one for a parameter makes the shape checkable everywhere it is
   consumed.
3. **The recipe shape.** `electron/main/recipes.js` normalises recipes with a provider map, settings
   rows, `limits`, `factor` and `task`. `docs/RECIPES.md` describes it in prose and
   `tools/recipes_test.js` checks it at run time; a typedef would catch a malformed shipped recipe
   before the test does.

How: a `tsconfig.check.json` with `allowJs`, `checkJs`, `noEmit`, `strict: false` and an `include`
that lists **only** the files already clean, plus `// @ts-check` at the top of each. A second gate
entry (`types`) runs `npx tsc --noEmit -p tsconfig.check.json`. TypeScript goes in as a
devDependency; nothing in `dependencies`, nothing in the installer.

Estimate: half a day for the three typedefs and the gate, because each is a shape that already
exists in prose and only has to be written down in a form a checker reads.

## Stage 3 - widen, file by file (NOT BUILT)

A file joins the `include` list when it is clean, never before, and the list only grows. Good next
candidates, in order: `electron/main/keys.js`, `electron/main/llm_custom.js` and
`electron/main/assistant/policy.js` - small, self-contained, and the kind of code where a wrong
shape is a silent misbehaviour rather than a crash.

`inpaint_canvas.js` is explicitly **not** a candidate. It is 12,126 lines with 269 fields assigned
through `this`, and `@ts-check` on it would produce a wall of findings about the god class that the
class measurement of 2026-09-18 already described. It gets types when a subject of it is reworked,
as the same decision says for splitting it.

## What this plan is not

- Not TypeScript as a compiler. See the rule at the top: the file that is edited is the file that
  ships, and `build_node.py --check` depends on it.
- Not a style linter. Prettier, quote rules and import order are not on the list and should not
  arrive by the back door.
- Not a reason to touch working code. Warnings are a list; a warning is fixed when its file is open
  for another reason.
