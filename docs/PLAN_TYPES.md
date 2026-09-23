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

## Stage 2 - `@ts-check` where the contracts are (BUILT, 2026-09-23)

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

## Stage 2 - as built (2026-09-23)

`tsconfig.check.json` at the root (it carries the why in its own header), `typescript` and
`@types/node` as devDependencies, `npm run types`, the gate **`types`** in
`tools/run_gates.sh` (no app and no Python, like `lint` and `node`) and a **Types** step in
`.github/workflows/build.yml` right after Lint. Four files hold the contracts:
`renderer/editor/host.js`, `renderer/commands.js`, `electron/main/recipes.js` - each with
`// @ts-check` and the typedefs of its own shape - and the new `types/`, which is not shipped
(`build.files` in `package.json` does not list it) and never loaded.

**`checkJs` is off, and that is the whole design.** With it on, `tsc` checks every file the
three import as well: the first run said **534 errors**, almost all of them in
`inpaint_canvas.js`, `inpaint_tiles.js` and `px/`, which is exactly the wall of findings
stage 3 says not to walk into. Off, a file is checked because it says `// @ts-check` at the
top, so the `include` list is the whole truth about what is judged.

**The three contracts**

1. **The host.** `EditorApi` (4 members) and `EditorHost` (the **40** members the editor
   modules actually call, which is what `tools/build_node.py --check` greps for) are typedefs
   in `host.js`, beside the header comment that has described them in prose since C0.
2. **The command core.** `CommandParam`, `Command`, `CommandDescriptor` and `CommandCore` in
   `commands.js`. `COMMANDS` carries `@satisfies {Record<string, Command>}`, `describe()` a
   `@returns {CommandDescriptor[]}`, the exported `commands` object a `@type {CommandCore}`,
   and the `P.*` helpers now say they build a `CommandParam` - which is what makes a
   misspelled `type` an error instead of a tool schema nobody reads.
3. **The recipe.** `Recipe`, `ProviderVariant`, `EditLimits`, `UpscaleFactor`, `TextShape`
   and `SettingRow` in `recipes.js`, on `normalize()`, `editLimits()`, `upscaleFactor()` and
   `textVariant()`: the shape `normalize()` promises every reader downstream.

**Not the plan's word, in three places.**

- **`@satisfies` on the `host` object does not work, and the reason is worth keeping.** It
  does excess-property checking on a fresh object literal, so all ~110 members the *shell*
  uses would have to stand in the contract too, and it re-types `this` inside every method,
  which turned `this.mountEl` and `this.nodeParams` into errors. The check is an **assignment**
  in `types/contracts.js` instead: `/** @type {EditorHost} */ const _host = host;` in a file
  nothing imports and nothing runs. An assignment checks that the implementation *answers* the
  contract, without caring what else it carries - which is what a contract means here.
- **The node's own `js/host.js` cannot be typed from here.** It is another repository with no
  tsconfig, so `build_node.py --check`'s grep stays the only check that reaches it. The
  typedef says what that file has to answer; the grep says whether it does.
- **The 33 shipped recipes are not imported and checked one by one.** It was considered
  (`resolveJsonModule` would type-check every file against `Recipe`), and rejected: a static
  list of 33 imports rots the moment a recipe is added, while `tools/recipes_test.js` reads
  the directory and covers whatever is in it.

**What changed in files that ship.** Comments, except seven lines. Six in `host.js` are DOM
string properties that were being handed numbers - `i.min = 1`, `input.step = step`,
`input.value = v` - now `"1"`, `String(step)`, `String(v)`; the DOM coerced them on the way in,
so the behaviour is the same byte for byte. One in `commands.js` is a cast:
`document.activeElement` is an `Element`, and `blur()` belongs to `HTMLElement`. Nothing else
in the three files is code.

**No defect was found.** As in stage 1, that is a result and not a disappointment. What the
typedefs did find is three shapes the prose did not state: a variant may carry `text: false`
(a file switching "Generate new" off) where the normalised shape has `TextShape | null`, the
old one-provider recipe shape has a top-level `note`, and `refreshHelpers()`'s catch answers
`{ models: [] }` alone, so the helper status' three other fields are optional. All three are
written into the typedefs now.

**Does it have teeth? 15 mutations, 12 red.** Each was applied to the real file, `tsc` run,
the file put back (the scratchpad's `mutate_types.py`). Red: a host member renamed, a host
member turned from a function into a flag, a host member answering a word where the editor
expects a yes or no, a command losing its `description`, a parameter type misspelled
(`"strng"`), the core losing `describe()`, a descriptor field the MCP server reads
disappearing, `providerIds` ceasing to be a list, `editLimits` answering the ratio as text, an
upscale variant getting the file's own `factor` instead of the filled-in one, a variant's text
shape becoming a string, a text shape losing a field. **The three that stayed green, and why
- this is the limit of the tool, not of the typedefs:**

- Two mutations *grew* a parameter on an implementation (`selectPoint(editor, ix, iy, p,
  extra)`, `exportQuality(editor, fmt)`). In a `.js` file TypeScript treats every parameter as
  implicitly optional, so an implementation that grew one is still assignable. The opposite
  direction is caught: a *call* with more arguments than the implementation takes is an error.
- `names: () => COMMANDS` instead of `() => Object.keys(COMMANDS)` stays green because the
  command table's type is circular - the `run` bodies reach back into the core - so TypeScript
  infers `any` for it and cannot judge what `names()` answers.

The blind spot showed itself while this was written: the typedef was taken from the app's
implementations, and a scan of the editor's call sites (the scratchpad's `callsites.py`) found
two members where the editor passes more than the app declares - `exportCanvas(editor, fmt)`
and `saveExport(blob, name, { editor, download })`, which the app ignores and the node reads.
Both typedef lines were wrong and are right now; no checker would have said so.

**What it does not check**, so that nobody reads more into a green gate than is there: the
node's copy of the host, any file not on the list, an implementation that grew a parameter,
and every value that only exists at run time - a recipe file's JSON, an editor's state, a
provider's answer. Those are the gates' business, and they stay.

**Gates.** `npm run lint` 0 errors and the same 18 warnings as before stage 2, `npm run types`
clean, `tools/build_node.py --check` unchanged (its only complaints are the known
"the node repo is behind" file diffs), `node tools/recipes_test.js` 22 of 22 and
`node tools/upscale_test.js` 95 of 95.

## Stage 3 - widen, file by file (NOT BUILT)

A file joins the `include` list when it is clean, never before, and the list only grows. Good next
candidates, in order: **`electron/preload.js`**, `electron/main/keys.js`,
`electron/main/llm_custom.js` and `electron/main/assistant/policy.js` - small, self-contained,
and the kind of code where a wrong shape is a silent misbehaviour rather than a crash.

The preload is first because stage 2 ran into it: it is the fourth contract - the only door
between the window and the main process - and `window.scumble` is declared `any` in
`types/globals.d.ts` because typing it means writing down what some sixty IPC handlers answer.
Every `window.scumble.*` in a checked file is unjudged until that is done.

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
