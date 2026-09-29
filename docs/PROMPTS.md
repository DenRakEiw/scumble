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
| `{useCase}` | `fill`, `add`, `remove`, `edit`, `outpaint`, `upscale` or `generate` |
| `{region}` | how the worked-on area is described to the model |
| `{hint}` | what the selection currently shows, when it came from a text selection |
| `{references}` | the reference images the prompt names by token, each with its layer's name (` The request names this reference image by token: @img2 (the layer "dress").`, with a leading space like `{hint}`); empty when the prompt names none |

**The app always appends its own output rule** ("Output only the prompt text: no preamble,
no quotes, no headings, no explanation"), so a template that forgets to say it still yields
a usable prompt.

**Reference tokens.** When the prompt names reference layers (`@img1`, `@img2`, `docs/PLAN_REFS.md`),
the app also appends a token rule after the output rule: keep every token of the request exactly as
written, add none, never replace one with a description, never name a picture by a number such as
"image 2". A template without `{references}` gets the names there too, so a template of your own
works unchanged. `{references}` and the rule list only the tokens the prompt uses, and only live
ones: a token of a hidden or deleted reference refuses to upsample ("Upsampling needs every @img
token to name a shown reference: ..."). The names are the layers' names, never the name an API
gives the picture: that is written at send time. Without a token in the prompt the instruction is
exactly what it was before. Do not put a literal `@img1` into a template as an example: without
references a small model copies it. The built-in rules (no template chosen) are exactly what they were
before when the prompt has no token; the five shipped templates carry one sentence about reference tokens in
their bodies ("If the request takes something from a reference image, keep its token ..."), which a prompt
without tokens leaves nothing to act on.

When the request named references, the app compares the answer's tokens with the request's: a token
dropped or added, or a picture named by number ("image 3", `<image2>`, "img1" without the @; not
"picture 2x"), puts a note into the status
line ("Check the tokens: the rewrite dropped @img2; added @img1; wrote "image 3".") and into
`upsample_prompt`'s `check` for agents; Revert is lit as always. The answer is then carried to the
labels that hold when it arrives, through the same remaps the prompt and Revert's text went through
meanwhile, so a reference moved, hidden, deleted or merged into another while the model was answering
keeps its tokens pointing at the same picture; the note names the tokens as they are then.

With an API model or the local endpoint the language model also sees the pictures of the references the prompt
names, each after a line with its token (at most six, 512 px; Settings › Prompt templates has the switch, and a
template changes nothing about it). `docs/HELPERS.md` has the details.

The **assistant** (`docs/ASSISTANT.md`) is not a template and uses none: a template is one call
with no tools, the assistant is a loop with the editor's commands in its hand. It is an app
feature beside templates, like prompt upsampling itself.

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
The list holds the models Scumble ships with; any other model of any of those providers -
OpenRouter ids included - goes into it through *Settings › Language models*, which feeds the
assistant's picker from the same rows (`docs/ASSISTANT.md`, "Models of your own").

## How it is put together

`electron/main/prompts.js` reads both folders, parses the front matter and hands the list to
the renderer over IPC (`prompts:list|import|remove|open`). `host.promptTemplates` holds it,
`host.promptTemplatesFor(use)` filters by use and by the `for` words, and
`host.fillPromptTemplate(tpl, ctx)` substitutes and appends the output rule (and, with
`ctx.references`, the token rule). The editor asks `host.upsampleInstruction(ctx)` first and falls
back to its own `builtInUpsampleInstruction()` when that returns null, which is the only change the
node repo needed. The token pieces are pure functions in `renderer/editor/reftokens.js`
(`referencesText`, `referencesRule`, `compare`, `checkNote`), shared with the node, where
`host.refTokens` is false and the instruction never has them. `tools/generate_test.py` covers the
loading, the substitution, the fallback, the select, and in `upsample_references` the token rule,
the refusal, the check and the carry across a swap; `tools/reftokens_test.js` the pure pieces.
