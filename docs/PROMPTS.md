# Prompt instruction templates

A template is the text that tells the language model **how** to rewrite a prompt. It is a
plain Markdown file, so a prompt style can be written, kept and passed on like any other
document. Templates never talk to a model themselves and take no tools; there is one call,
with one instruction. Anything beyond that belongs in a JavaScript plugin
(`docs/PLUGINS.md`).

Built-ins live in `prompts/` in the repo (shipped inside the package), yours in
`<userData>/prompts/`. A file of yours with the same name as a built-in replaces it.
Settings › Prompt templates lists them, imports one and opens the folder.

## The file

```markdown
---
name: Photographic
description: reads like a shot list, camera and light before mood
use: generate
for: flux, gpt-image
---
Write one image-generation prompt in English that a photo-realistic model can follow.

One paragraph of 50 to 90 words in this order: the shot, the subject's appearance and
materials, the lighting setup, the depth of field, and the surface qualities that make it
read as a photograph. Keep every subject, colour, material and number the request names.

Request: {prompt}
```

| Key | What |
|---|---|
| `name` | what the select shows; the file name without `.md` is the id |
| `description` | one line, shown beside the name and under the select |
| `use` | `generate` (the Generate new dialog), `upsample` (the editor's Upsample button) or `both` (the default) |
| `for` | optional, comma separated; a template only appears when one of the words occurs in the recipe's id, name, family or model |

Placeholders in the body, all optional:

| Placeholder | Filled with |
|---|---|
| `{prompt}` | what the user typed |
| `{model}` | the model of the selected recipe |
| `{aspect}` `{width}` `{height}` | the size being asked for (Generate new) |
| `{useCase}` | `fill`, `add`, `remove`, `edit`, `outpaint` or `generate` |
| `{region}` | how the worked-on area is described to the model |
| `{hint}` | what the selection currently shows, when it came from a text selection |

**The app always appends its own output rule** ("Output only the prompt text: no preamble,
no quotes, no headings, no explanation"), so a template that forgets to say it still yields
a usable prompt.

## Where a template is used

- **Generate new**: the select in the dialog. It changes what *Upsample prompt* asks for,
  and the choice is remembered in `settings.promptTemplates.generate`.
- **The editor's Upsample button**: Settings › Prompt templates, the row *Upsample uses*.
  With nothing chosen the editor keeps its built-in rules, which are written per use case
  (fill, add, remove, edit, outpaint) and are usually the better default for editing. A
  template replaces all five at once, so pick one only when you want one voice everywhere.
  Remembered in `settings.promptTemplates.upsample`.

The chosen language model is a separate matter: any API key, or a local server through
Settings › Local / OpenAI-compatible endpoint (Ollama, LM Studio). See `docs/HELPERS.md`.

## How it is put together

`electron/main/prompts.js` reads both folders, parses the front matter and hands the list to
the renderer over IPC (`prompts:list|import|remove|open`). `host.promptTemplates` holds it,
`host.promptTemplatesFor(use)` filters by use and by the `for` words, and
`host.fillPromptTemplate(tpl, ctx)` substitutes and appends the output rule. The editor asks
`host.upsampleInstruction(ctx)` first and falls back to its own
`builtInUpsampleInstruction()` when that returns null, which is the only change the node
repo needed. `tools/generate_test.py` covers the loading, the substitution, the fallback and
the select.
