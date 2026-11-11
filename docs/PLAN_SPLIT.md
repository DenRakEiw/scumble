# Item 56: split the long files (plan, 2026-11-11)

The user, 2026-11-07: "das aufräumen der langen dateien: für bessere ai wartbarkeit, geringerer kontext". CLAUDE.md
item 56 sets the rules: a move, not a rewrite. Behaviour and bytes stay unchanged. Every new editor module goes into
`tools/build_node.py`'s FILES with plain named imports. One file per session. Never while another branch edits the
same file.

The evidence is `docs/research/split_2026-11-11/linemap.md`. A read-only agent made it on `wasm-kernels` `7608dcda`
by parsing the five files with acorn. It holds every top-level declaration, the 80 class regions E01-E80, what each
region reads, the tests that read source text, and the branches. **Line numbers below are from that commit.** Each
session finds its places again by name.

## 1. Where things stand

| file | lines | shape |
|---|---|---|
| `renderer/editor/inpaint_canvas.js` | 25,862 | module scope 1-2257 (helpers, `ICONS` 1485-1592, `STYLE` 1620-2029), then `class InpaintEditor` 2258-25859 (756 members) |
| `renderer/editor/host.js` | 7,100 | helpers 29-446, `export const api` 448, **`export const host = {` 603-6947** (330 properties, one literal), page wiring 6951-7100 |
| `renderer/shell.js` | 3,582 | script-like: 391 top-level statements, 19 sections S00-S18, `settings` reassigned in 19 places |
| `renderer/commands.js` | 3,171 | helpers 35-901, **`const COMMANDS = {` 903-2919** (99 commands), tail and `export const commands` 3142 |
| `electron/main/recipes.js` | 1,955 | CommonJS, plain functions, typedefs 15-231, `module.exports` 1955 |

These facts decide the method:
- `InpaintEditor` has no `super`, no `#private` names, no instance field declarations and no `extends`. It has 10
  accessors and 30 static members (E56, 18112-18236).
- The node's ComfyUI page imports every `.js` in its `js/` in no fixed order (`docs/BUILD_NODE.md:84-99`). Today's
  cycle (`inpaint_canvas.js` <-> `inpaint_jobs.js`, `inpaint_encode.js`, `inpaint_modal.js`) is safe only because
  nothing reads another module's binding while it evaluates.
- `build_node.py` finds host members by 4-space indentation inside `host.js` alone (`:120-124`). It sees a
  `host.X` use only in files on its FILES list (`:166-167`), and only when that file imports `host` (`:145-148`).
- `tsc` checks only `host.js`, `commands.js`, `recipes.js` and `types/` (`tsconfig.check.json` `include`). eslint
  already covers any new file under `renderer/`.
- Tests read source text by path (linemap §6 table): `skins_test.js` reads STYLE, E72's draw methods and
  `shell.js:556`. `quit_test.js` reads `syncLayers*`, host's `saveAll`/`restore`/`bundle` and shell's `onFlush`.
  `comfyrouter_test.js` reads `HINT_NOTE`, `ark_test.js` and `genpresets_test.js` read `GEN_ASPECTS`, and
  `comfyprompt_test.js` reads `CANVAS_OUTPUTS`. Each breaks on a move unless it is pointed at the new file in the
  same commit.

## 2. The method

**Module-scope code moves as plain modules.** These are functions and consts with no `this`. The new file exports
them by name. `inpaint_canvas.js` imports them back and re-exports the names other modules import from it today, so
no importer changes. A leaf module never imports `inpaint_canvas.js`.

**Class methods move as "part classes", text unchanged.** A part module holds an ordinary class whose body is the
moved methods, copied byte for byte with the same 4-space indentation and no commas:

```js
// renderer/editor/inpaint_ed_liquify.js
import { makeCanvas, el } from "./inpaint_dom.js";   // leaf modules only, never inpaint_canvas.js
let InpaintEditor = null;                             // the class, set when it installs this part
export class LiquifyPart {
    liquifyHint() { ... }                             // E36, exactly as it was in the class
    ...
}
export function bindLiquify(C) { InpaintEditor = C; }
```

`inpaint_canvas.js` installs the parts right after the class with one helper, `installParts(InpaintEditor, [...])`
(new leaf `inpaint_parts.js`). For each part it copies every own property descriptor of `Part.prototype` except
`constructor` onto `InpaintEditor.prototype`. Class methods are already non-enumerable and accessors stay
accessors. It **throws on a name that is already there**: no linter sees a duplicate across files. Why this shape:
- The method bodies keep their exact text. `InpaintEditor.X` inside them reads the module's `let`, which the bind
  call sets before any method can run. A part never imports `inpaint_canvas.js`, so it adds no cycle, and it is
  safe in every load order the node's page can take.
- `InpaintEditor.prototype.<name>` exists as before, so `maps_test.js` and `limit_test.js`, which call prototype
  methods with a fake `this`, keep working. `this`, `.name` and `toString()` are unchanged. Nothing uses `super`.
- The statics (E56), the constructor (E02), the accessors E01 and E67's `base`/`basePx`/`_basePx` stay in the class
  (linemap §1.4 "stay in the class", about 1,500 lines).

**The proof that it is a move: `tools/split_check.js`**, written in S0 on acorn (already in `node_modules`, 8.18.0).
It takes a base commit and the files of the split. It parses the old file from `git show` and the new files from
disk. It then checks that:
- every top-level declaration and every class member of the old file is found under the same name in exactly one
  new place, with the same source text (indentation included);
- nothing new was added except the import/export lines, the part class headers and the install calls;
- the member names on `InpaintEditor.prototype` after the install equal the old class's.

It runs in each session's commit check and prints the moved line count. A text change that slips into a move (a
renamed variable, a forgotten line) fails it. This replaces a mutation round. The behaviour is then held by the
gates the moved code already has.

**Tests per session (CLAUDE.md working rules):**
- Every session runs `split_check.js`, `lint`, `types`, `python tools/build_node.py --check` (only "differs"
  lines) and the `nodecopy` gate.
- Every session also runs the gates of the regions it moves (named per session below), on both backends, serially
  for `editor` (`docs/TESTING.md` known flakes).
- The Full-tier regions (history, filters, compositor, persistence, export/load, stroke buffers) take the gates on
  both backends. They take no mutation round: `split_check.js` proves the text is the same.
- No 15k measurement: a move changes no code path.

**Node build:** each new editor module goes into FILES (`build_node.py:39-47`), using `export const/function/class`
or an export list, never `export default` (`:101-103`). A part with `host.` imports `host` from `./host.js`. The
node's `js/` grows by about 20 files. Each has no top-level side effect (the `docs/BUILD_NODE.md` rule), so the
order in which ComfyUI's page loads them does not matter. `node_test.py` checks the built node as today.

## 3. Sessions

The order follows linemap §8. Each session is one commit (or a few) on `wasm-kernels`, and none starts while an
open branch edits the file it moves. **K20c must be merged before S1** (it edits `inpaint_canvas.js` lines 37,
752-757 and 19084-19259). After that, no open branch touches the five files: `ag-chain-b-2` and `ag-fix-prov` are
stale, and their lines are on `wasm-kernels` already.

| # | what | lines out of the file | gates besides the always-set |
|---|---|---|---|
| S0 | tools: `split_check.js`; `inpaint_parts.js` `installParts` with the collision throw and a Node test of it (accessor, non-enumerable, a clash throws); the text-reading tests made to find their code by name in any file of a list (skins, quit, comfyrouter, ark, genpresets, comfyprompt); `build_node.py host_members` able to read the host parts (only needed before S12) | none | the tests it changes, `skins`, `quit` |
| S1 | `inpaint_canvas.js` module scope into leaves: `inpaint_style.js` (STYLE, `injectStyle`), `inpaint_dom.js` (`el`, the inputs, ICONS, `icon*`, `miniButton`), `inpaint_orient.js`, `inpaint_shaders.js`, `inpaint_mesh.js`, `inpaint_backends.js`, `inpaint_consts.js` (head, consts, roles, brush size, `makeCanvas`), `inpaint_strokebuf.js` (`StrokeBuffer`, `UploadCache`, `sourceTag`; `let CLIPBOARD` stays with its accessor) | about 2,050 | `skins`, `editor`, `brush`, `pixels` |
| S2 | the file loading helpers T-load (494-949) into `inpaint_load.js`. They read `InpaintEditor` statics, so they take the bind form | about 460 | `layered`, `tiff`, `document`, `export` |
| S3 | parts, normal tier, panels and UI: E62-E64 (filter / limit / relight blocks), E61 + E54 + E60 (layers panel and layer ops), E65-E66 (history panel, new canvas), E14 + E55 (text tool) | about 3,700 | `editor`, `relight`, `limit`, `groups`, `clip` |
| S4 | parts, normal tier, tools: E29-E30 + E37 (tips, smudge, clone), E31-E35 (heal, patch, move, remove), E36 (liquify), E38-E39 (shape, gradient, bucket) | about 2,500 | `brush`, `editor`, `pixels` |
| S5 | parts: selection E23-E28, E41, E46 (E26-E27's band programs are Full tier) and select by text E42 | about 2,900 | `selection`, `editor`, `shape`, `pixels`, `limit` |
| S6 | parts: transform and canvas geometry E05, E15-E20, the pointer and keys E07 + E21 | about 2,600 | `editor`, `size`, `canvasonly`, `transparent` |
| S7 | parts, Full tier: depth and maps E43, filters E47-E52 | about 2,200 | `maps`, `depth`, `depthfx`, `grading`, `effects`, `limit`, `film`, `composite` |
| S8 | parts, Full tier: history and snapshots E45, persistence E79 | about 1,500 | `document`, `docux`, `quit`, `editor`, `metadata` |
| S9 | parts, Full tier: export, bounds, load E57-E59; stroke buffers E40 | about 1,600 | `export`, `layered`, `tiff`, `pixels`, `brush` |
| S10 | parts, Full tier: display and compositor E67 (minus the accessors) to E70, relight runtime and scene draw E72-E75 | about 2,700 | `composite`, `blendmodes`, `groups`, `clip`, `relight`, `pixels`, `skins` |
| S11 | `recipes.js`: leaves first (typedefs, the shape readers 232-700, `normalize`); R02 and R03 stay together (they call each other) | about 1,000 | `recipes`, `comfyprompt`, `ark`, `loras`, `platform` |
| S12 | `commands.js`: the 99 command groups into files of objects, merged back into `COMMANDS` in the same key order (`describe()`, the MCP list and `docs/COMMANDS.md` follow it). C09 and C14 read `COMMANDS` only when called, through a getter handed in | about 2,000 | `commands`, `mcp`, `mcpb`, `assistant`, `help` |
| S13 | `host.js`: parts as objects installed by descriptors onto `host`, with `build_node.py` reading them (S0). Each part keeps `// @ts-check` and goes into `tsconfig.check.json` | about 5,000 | `document`, `generate`, `quit`, `nodecopy`, `cloudjobs`, `loras`, `key`, `areas`, `types` |
| S14a, S14b | `shell.js`: the state rename with its AST proof, then the moves (§5.1; only on the user's yes) | about 2,900 | §5.1's list |

`inpaint_canvas.js` ends at about 3,500 lines: the class shell with the constructor, the lifecycle (E06), statics,
`syncLayers`, the generate entry points, `releaseCaches` and `destroy`, plus the install list. The biggest new files
are about 1,000-1,300 lines. The longest single methods stay whole: `buildRelightBlock` (843 lines) and
`selectRange` (577). Splitting a method is a rewrite, not item 56.

**Size (inferred):** S0 about one session. S1-S10 one session each, S5 and S7-S10 at the upper end because of their
gates. S11-S13 one each. About 14-15 sessions in all, most of the time going to gate runs.

## 4. Traps to keep

- Never `Object.assign` a part onto the prototype. It reads the accessors as values and makes methods enumerable.
- A part, and anything a part imports, must never import `inpaint_canvas.js`. eslint `no-undef` catches a name the
  part forgot to import. A leftover import in `inpaint_canvas.js` shows as a `no-unused-vars` warning: clear those
  in the same session.
- `host.` in a comment counts for `build_node.py` (`HOST_USE` is a plain regex). A part that only mentions host in
  a comment then needs the import too, or the comment rewritten.
- A moved method that another region calls as `this.x()` keeps working. A module-scope function that called it by
  name does not exist (methods are reached only through `this`), but `split_check.js` lists every free identifier a
  part uses, so a missing import cannot hide.
- `git mv` is no help for a split. The commit message names the base commit and `split_check.js`'s line count, so
  `git log -L` and blame can follow the code (`git blame -C -C` finds moved lines).
- Merge conflicts: any branch that edits `inpaint_canvas.js` after S1 conflicts on whole regions. The block runs as
  one stretch before new features (CLAUDE.md item 56), with no agent branch on these files meanwhile.

## 5. Questions for the user (each with a suggestion)

**The user's answers (2026-11-11):** 1 the part classes; 2 flat; 5 as one block before the next feature. Question 3
asked back ("was wäre wenn wir aufteilen?"), answered in §5.1; question 4 not answered yet.

### 5.1 What a split of `shell.js` would take (the answer to the user's question)

- **Step 1, the rename:** the eight shared module variables go into one object in a new `renderer/shell_state.js`:
  `settings`, `providers`, `recipes`, `lastStatus`, `lastProbe`, `canvasOnlyState`, `windowFullScreen` and
  `takesPending`. Every read and write of them in `shell.js` becomes `state.settings` and so on, about 230 places
  (counted with a grep on 2026-11-11; it includes some property keys of the same name, so the real number is a little
  lower). This is the one step that is a text change, not a move. A script on acorn makes it, renaming only the
  identifiers that resolve to the module-level binding (not a local or parameter of the same name). `split_check.js`
  gets a rename mode that proves the new tree differs from the old only in those `x` -> `state.x` nodes. Nothing else
  changes in that commit.
- **Step 2, the moves**, which are then pure moves:
  - the Settings dialog's panels (about 1,700 lines, eleven sections) into `shell_settings.js`;
  - Generate new and Upscale (about 890 lines) into `shell_generate.js`;
  - updates and star / share (about 320 lines) into `shell_updates.js`;
  - the GPU watch and log console into `shell_watch.js`.

  `shell.js` keeps the imports, the tabs, the 164 top-level wiring statements, the startup and the menu: about 700
  lines. The new modules hold only declarations, so their calls back into `shell.js` happen only after it has
  evaluated. `shell.js` is app-only, so `build_node.py` is not involved.
- **Tests to repoint in the same commits:**
  - `ark_test.js` and `genpresets_test.js` read `GEN_ASPECTS`;
  - `quit_test.js` reads `onFlush`, `startMode` and `saveBeforeRestart` (quit safety: Full tier, both backends);
  - `skins_test.js`'s census expects a `var(--sc-*)` in `shell.js`, and its only one is the `recipeNote` line 556,
    which moves with the recipes section.
- **Gates:** `platform recipes help skins commands assistant toapis openrouter ark comfyview loras cloudjobs document
  quit`, on tiles (the shell has no pixel path) and `quit` and `document` on both backends.
- **Size (inferred):** two sessions, S14a (the rename) and S14b (the moves).
- **Gain:** `shell.js` goes from 3,582 to about 700 lines, and the Settings dialog sits in one file.
- **Risk:** the rename is the only real risk, and the AST check holds it.
- **Suggestion now:** do it, as the last two sessions of the block. Inside the block no feature branch is open, so the
  wide rename conflicts with nothing.

1. **The part classes** (§2) for the 23,600 lines of the class, or only the module scope (S1, S2: about 2,500 lines
   out, the class stays 23,600)? *Suggested: the part classes; without them the file stays at 23,000 lines.*
2. **Where the files go:** flat `renderer/editor/inpaint_ed_<subject>.js` beside today's `inpaint_*.js`, or a
   subfolder? *Suggested: flat. `build_node.py` FILES and the node's `js/` are flat today.*
3. **`shell.js`:** its `settings` is reassigned in 19 places and five other module `let`s are shared across
   sections. A split needs one shared state object (`state.settings`), which changes those lines: a small rewrite,
   not a move. Do it, or leave `shell.js` whole (3,582 lines)? *Suggested: leave it for now; it is the shortest of
   the three big renderer files, and the rewrite needs its own review.*
4. **Gates instead of a mutation round** for the Full-tier moves, with `split_check.js` as the proof that the text
   is the same? *Suggested: yes.*
5. **Order with other work:** the whole block S0-S13 before the next feature (items 57-71 and issue #12's rest), as
   CLAUDE.md says, or S0-S2 now and the class parts between features? *Suggested: as one block. Parts between
   features would put every feature branch on a file that is moving.*
