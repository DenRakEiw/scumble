# Item 39: a tidier Settings dialog (the user, 2026-10-05)

The user, with a screenshot of *Settings › Recipes*: "das einstellungs menü aufräumen. die model liste ist zu lang /
auch die anbieterliste; kann man das aufklappbar machen?" Put on the list for a later update; nothing built. Mapped
2026-10-05 (read only, two agents); every anchor below was read at commit 40f01f0.

## What is there today

- **One long column.** `<dialog id="shell-settings">` (`renderer/index.html:38-190`) holds 14 flat `<section><h3>`
  blocks in this order: ComfyUI, API providers, Local / OpenAI-compatible endpoint, Language models, Prompt templates,
  Recipes, Helpers, Assistant, Appearance, Plugins, Local files, Rendering, Updates, About. No tabs, no side nav; 560 px
  wide, at most 92vh, scrolling (`renderer/shell.css:56-96`). `openSettings` (`renderer/shell.js:2137-2195`) rebuilds
  every list each time it opens.
- **Recipes: 60 rows on a fresh profile**, one per recipe, no headings (`renderRecipeList`, `shell.js:558-619`), sorted
  by family (`loadRecipes` :424-431, `FAMILY_ORDER` :402, `familyOf` :405). By mode (`modeOf` :410): ComfyUI 5,
  Comfy Cloud 13, API 42 (LaMa in-app counts as API). By family: 18 families (Comfy Cloud 13, Upscale 10, Black Forest
  Labs 6, ComfyUI 5, then 3 or fewer each). 55 rows carry a provider `<select>`; **27 of those have one option only**.
  129 buttons in the list; **all 60 Remove buttons are disabled** on a fresh profile (shipped recipes cannot be
  removed, :609-610). The active recipe is only a bold name (`.active`, `shell.css:85`, `syncRecipeRows` :529-543).
  Imports, Cloud copies and graphs saved from the ComfyUI window land in the same list.
- **API providers: 16 key rows** (`renderProviders`, `shell.js:663-725`; the order of `describeAll`,
  `electron/main/providers/index.js:45-82`, minus the two that share the Comfy Cloud key): ToAPIs, fal.ai, Black Forest
  Labs, OpenAI, Google Gemini, Replicate, WaveSpeedAI, Comfy Cloud, OpenRouter, BytePlus ModelArk, Oxen.ai, Magnific,
  Anthropic, DeepSeek, Moonshot / Kimi, Z.ai / GLM (the last four for language models only). Each row takes two lines
  (label, key field, Save, Clear; then the key state with "get a key", on four rows "check balance").
- **No filter field and no group headings** in either list. The title row's recipe picker already groups by family
  with `<optgroup>` (`shell.js:434-453`).
- **Collapsible patterns that exist:** the side panel's `<details>` sections (`section()` in
  `renderer/editor/inpaint_modal.js:334-344`, the caret CSS in `inpaint_canvas.js:1372-1378`), the plugin panels
  (`renderer/plugins.js:355`), layer groups (a caret button, state in the document), the assistant's result cards.
  Per-window UI state lives in `localStorage` (help.js:402/413, assistant.js:267/271).

## The shape (a sketch, to be decided with the user)

Renderer only (`shell.js`, `shell.css`, `index.html`); no change to main, recipes or settings data. Light to normal
test tier (UI, no pixels): the gates below, `lint`, `types`, `skins`, one look in the app in each skin.

1. **Recipes in three collapsible groups** by mode, the same words as the editor's picker: *ComfyUI (5)*,
   *Comfy Cloud (13)*, *API models (42)*, the last with plain family sub-headings like the picker's optgroups. Each
   group's line shows its count, how many are ready (`providerKeyState`, :474-484) and "in use: <name>" when the active
   recipe is inside. The active recipe's group opens by itself. No filter field (decided, see below).
2. **Providers in two groups**: *Keys stored (n)* open, *Add a key (m)* closed; the order inside each stays the
   `describeAll` order.
3. **Small clean-ups in the rows**: Remove only on the user's own recipes (today 60 disabled buttons); a one-option
   provider select may become plain text (see the traps: a gate reads one).
4. ~~Every section collapsible~~: no, only the two long lists (decided, see below). The sections keep their plain h3,
   so the menu jumps by h3 text keep working as they are.
5. **Open state kept in `localStorage`** (`shell.settings.open`, try / catch as in help.js), read on every render.

## Traps (what a build must keep)

- **Rebuilds reset the DOM.** Both lists are rebuilt after a key Save / Clear, Remove, Cloud copy, import, a graph saved
  in the ComfyUI window and on every `openSettings` (`shell.js:613, 627, 641, 665, 680, 685, 2181-2188, 2959`): the
  open state must come from storage, not the DOM. Not in `settings.json`: the renderer keeps its own copy of the
  settings (the CLAUDE.md testing trap).
- **The gates rely on the rows** (13 scripts open Settings, all from JS, so rows in a closed group stay reachable):
  - `.shell-recipe[data-id=X] select`, its option order and labels (toapis, ark, openrouter, comfyrouter, oxen,
    magnific gates; `magnific_test.py:130-135` reads the one-option select of `mystic`). Keep one row per recipe with
    its own select and `data-id`; do not reorder `providerIds`.
  - Key rows found by their leading label text (`/^OpenRouter/` and others: `openrouter_test.py:81`, `ark_test.py:66`,
    `comfyrouter_test.py:65, 117-122`, `oxen_test.py:62`, `magnific_test.py:127`): nothing in front of the label inside
    a row. `toapis_test.py:87-90, 119` takes the **first** `.shell-provider` in the document as ToAPIs, and
    `#set-compat-key-row` / `#set-hf-row` share the class (`index.html:70, 125`): sorting by key state breaks it.
  - `comfyview_test.py:518-531, 557-561` reads the button texts "Edit in ComfyUI" / "Cloud copy" and clicks the latter
    by its text.
  - Other ids in the dialog the gates read: `set-keys-note`, `set-update-*`, `set-tiles*`, `set-lm-*`,
    `set-prompt-refpics`, `set-gens*`, `set-as-steps`, `#set-skins/#set-plugins .shell-plugin`, `set-auth-secret`,
    `set-recipe-note` (platform, editor, llm, quit, portable, skins, recipes gates).
- **Jumps into a section.** Four menu commands find an h3 by its exact text and scroll to it (`shell.js:2852-2856`:
  Updates, Plugins, ComfyUI with a focus on `#set-url`, Appearance; the ComfyUI window's bar uses the ComfyUI one). An
  h3 with a count or caret in its text stops matching, and a scroll or focus into a closed `<details>` does nothing:
  `openSettings(section)` has to open the target first. The Help button (`help.js:315-318`) and the assistant's "Open
  Settings" (`assistant.js:744-747`) say API providers but open the top; with groups they should open that group.
- **Form validity.** An invalid number field keeps Close from submitting (`shell.js:2151-2153`); inside a closed
  `<details>` Chromium cannot focus it, so Close would silently do nothing. A section that holds number fields
  (Rendering, Assistant) opens on `invalid`, or the fields are checked before the submit. (Moot while only the two
  lists collapse: they hold no number fields.)
- **The shared family code.** `familyOf` / `FAMILY_ORDER` also build the title-row picker's optgroups
  (`upscale_test.py:205` checks `optgroup[label=Upscale]`); a recipe's group can change with its provider select
  (`cloudModeOf`, :404).
- **Skins.** Both shipped skins style the dialog (`plugins/skin_90s/skin.css:48-200`: a bevel on every
  `#shell-settings button`, `#shell-settings h3`; `plugins/skin_duck/skin.css:76-119`); both already style
  `summary:focus-visible`. New CSS goes inside `shell.css`'s one `@layer app {}` with `--sc-*` tokens that have
  fallbacks, or `tools/skins_test.js` fails.
- **Keys and focus.** A filter field stops key propagation like the key inputs (`shell.js:395, 675`), or the editor's
  shortcuts take the typed keys. A real Escape must still close the dialog (`editor_test.py:55-83`).
- **Text that names a place.** About 20 messages say "Settings › API providers" or "Settings › Recipes" (e.g.
  `shell.js:482-483, 523, 1536`, `assistant.js:866`, `electron/main/providers/util.js:203-204`, `main.js:959`);
  "above" in `index.html:97, 142` and `shell.js:949` reads wrong if sections move.
- **Docs and pictures go stale.** `docs/MANUAL.md:51` (rendering-and-keys.jpg), `:141` (recipes.jpg), `:65, 146, 160,
  666`; `README.md:130` (`docs/images/settings-language-models.jpg`); `docs/RECIPES.md:278` ("a select per row"). New
  screenshots mask the key hints (`key set (…xxxx)`, `shell.js:693`). The uncommitted tutorial recorder
  (`docs/images/video/rec/scenes.py:133-143`, `scenes2.py:203-217`) picks visible rows only and `#set-providers > *`.

## Decided (the user, 2026-10-05)

- **Recipes as in shape 1:** three collapsible groups *ComfyUI (5)*, *Comfy Cloud (13)*, *API models (42)*, family
  sub-headings inside, each group's line with its count, how many are ready and the recipe in use; the active recipe's
  group open.
- **No filter field:** "suchfeld braucht es nicht, aufklappbar reicht".
- **Only the long lists collapsible** ("nur die langen listen aufklappbar"): the recipes and the API providers; the
  other sections stay as they are.

## Still open

1. Providers: *Keys stored* open and *Add a key* closed (shape 2), or every provider one closed line?
2. Hide Remove on shipped recipes; show a one-option provider as text instead of a select?

Size: about one session with the gate updates, plus the manual's two screenshots (recipes.jpg, rendering-and-keys.jpg).
