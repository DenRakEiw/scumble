# Help: the manual in the app, with a chat on top

Asked for by the user on 2026-09-23: a **Help button** that opens a chat which answers questions
about using the app, with a Markdown file holding everything about Scumble as its context, on a
model picked from the ones the user has keys for. **Built the same day** (the last section, "As
built"); the sections before it are the design as it was written.

What exists today under Help is **`Editor guide`, which opens the ComfyUI node's README on GitHub**
(`renderer/shell.js`, the `guide` command). For a desktop app that is the wrong file in the wrong
repository, and it is what this replaces.

## 1. The decision that shapes the rest: Help is the manual, the chat sits on top

A help button that says "add an API key first" is not help. Most people who press it will have no
model configured, and the ones who do may be offline or between keys.

So **the panel renders the manual itself** - searchable, with the chapter list, always available,
no key and no network. **The chat is offered above it when a model is available**, and answers from
the same text. Two ways into one body of knowledge, and the useful one works for everybody.

This also keeps the failure honest: when no model is there, the panel is not broken, it is a manual.

## 2. The source of truth, which is a problem we made today

The manual exists **only in the website repository** (`F:\portfolio_web`, `lib/scumble-manual.ts`,
16 chapters as TypeScript data, written 2026-09-22 and 2026-09-23). That is the wrong place for it
to live alone: it describes this code, it will drift from this code, and nobody editing a feature
here will remember to open another repository.

**The manual moves to `docs/MANUAL.md` in this repository** and becomes the one source:

- **The app** ships it, renders it in the Help panel and feeds it to the chat as context.
- **The website** generates its chapters from it at build time instead of holding its own copy - the
  file is Markdown with one `##` per chapter, and the page's existing `Chapter` shape (summary,
  body, steps, notes, keys, shot) maps onto conventional sub-sections. The screenshots stay where
  they are (`public/projects/scumble/manual/`); the Markdown names them.
- **A change to a feature and the change to its chapter are then one commit**, reviewed together,
  and `tools/` can check the obvious drift (a chapter naming a shortcut the key handler does not
  have, a settings section that no longer exists).

That is half the work of this feature and the half that keeps paying.

## 3. The chat is the assistant's loop with no tools

`electron/main/assistant/` already holds everything: four families (Anthropic Messages, OpenAI
Responses, Gemini, Chat Completions for the seven OpenAI-compatible providers), streaming, retries,
the final-answer rules, cost, and one registry (`providers.js` + `llm_custom.js`) that also feeds
prompt upsampling and knows which providers have a key and which models the user added themselves.

Help reuses it **with an empty tool set**, which removes most of what makes the assistant complex:

| The assistant | Help |
| --- | --- |
| an in-process MCP client, 66 tools | no client, no tools |
| the policy, the asks, ownership | none needed - it can change nothing |
| per-step undo, turn snapshots | none |
| screenshots of the document | none |
| `meta` through the Bridge, the user-activity wait | none |
| vision models only | **any model**, including cheap text-only ones |

That last row is a real gain: a help answer needs no eyes, so the picker can offer the small fast
models the assistant cannot use, and they answer a "how do I feather a selection" perfectly.

What Help adds: a system prompt of its own (the rules below plus the whole `MANUAL.md`), its own
chat storage (or none - a help chat is throwaway; the assistant's "keep the last N" pattern fits
either way), and a panel.

## 4. Cost, and why the whole manual goes in the system prompt

The manual is roughly 8,000 to 14,000 tokens. `prompt.js` already keeps the system text **byte
stable for the whole chat so the prompt cache holds**; the same trick applies here. The first
question of a chat pays for the manual once, every question after it is a cache read. On a small
model that is fractions of a cent per question.

Retrieval or chunking would be the wrong answer for one document that fits in a prompt: it adds an
index to maintain and a failure mode (the right chapter not retrieved) in exchange for nothing.

## 5. The rule that decides whether this is good or embarrassing

A documentation chatbot's classic failure is inventing a menu item that does not exist. So the
system prompt says, and a gate step checks:

- Answer **only** from the manual below.
- When the manual does not cover it, say so in one sentence and point at `docs/` and the issues.
  Do not guess a menu path, a shortcut or a setting name.
- Quote the chapter you are answering from, so the user can read it themselves in the panel.

**The gate step**: ask something the manual deliberately does not contain and check the answer says
so rather than inventing it. That is the one test worth more than all the others here.

## 6. What it must not do

Help has no tools, so it cannot change anything - no document, no setting, no key. The panel says
that in one line, and that is also why it needs no policy, no asks and no undo. **Help explains,
the assistant acts.** Keeping that line clean is what keeps Help free of everything in the table
above.

## 7. Pieces, in build order

1. `docs/MANUAL.md` as the source, and the website generating its chapters from it (§2).
2. The Help panel: the manual rendered and searchable, no model needed. **Built with
   `createElement` and `textContent` like `renderer/assistant.js`** - the no-markup-writes rule
   holds here too, so the Markdown renderer is a small one for the subset the manual uses
   (headings, paragraphs, lists, tables, code, bold), not a library that writes HTML.
3. The chat above it on the existing loop, with the picker filtered to providers that have a key,
   text-only models included.
4. `Help › Editor guide` replaced by it, **F1** as the shortcut, a button in the top bar next to
   *Assistant*.
5. The gate: the panel opens without a key, the search finds a chapter, a mocked model answers from
   the manual, and the invention check of §5. `tools/assistant_mock.py` already plays all four
   families.

**Estimate: about two days**, of which §1 is half - and §1 is worth doing even if the chat never
follows.

## 8. Open for the user

- **Its own dialog, or a second mode of the assistant column?** The recommendation is its own
  dialog: Help is read while working, the assistant column is for acting, and mixing them makes the
  policy question ("can Help do things?") reappear. F1 opens it.
- **Chats kept or thrown away?** Recommendation: kept like the assistant's, but fewer (five), and
  cleared by the same *Delete all assistant data* button.

## As built (2026-09-23)

**§1 and §2, the source.** `docs/MANUAL.md` is the manual: one `##` per chapter, the slug in an HTML
comment, the one-line summary in underscores, paragraphs, then `### Steps`, `### Keys` (`####` groups over
two-column tables) and `### Notes`; screenshots are images with the website's URL and their size as the
title (they render on GitHub, and the app shows none: they live on the website). It was converted from
the website's `lib/scumble-manual.ts` by a one-off script, and the page built from the Markdown was
**character for character the live page** (34,857 characters) before anything was added.
`renderer/help/manual.js` is its **one reader** (no DOM, no imports): `parseManual`, `inline` (spans, never
HTML: backslash escapes, `code`, **bold**), `plain`, `chapterText`; it throws with a line number on
anything outside the shape. **The website holds copies of both files**, made by `node tools/manual_sync.js`
(`--check` compares, line endings aside): `content/scumble/MANUAL.md` and `lib/scumble-manual-reader.js`,
read at build time by `lib/scumble-manual.ts`, and the page renders the inline Markdown through
`components/scumble-inline.tsx`. Portfolio commit `f5329db`, deployed by CLI (the git deploy blocked as
always). `docs/MANUAL.md` is in the package (`build.files`), read by main (`help:manual`).
**The drift checks** (`node tools/manual_test.js`): every menu accelerator in `main.js` is a row of the
shortcuts chapter (it caught F1 on its first run), every `Settings › X` starts with a section heading of
the settings dialog, every `<Menu> › X` with a menu label (it caught a note of this work naming the
removed *Editor guide*).

**§3, the chat.** `electron/main/assistant/help.js`, class `Help`: the assistant's four adapters with
`tools: []` (the four `bodyFor`s now leave an empty `tools` out, so the assistant's bodies are byte for
byte what they were: 224 checks unchanged), the registry through an `Assistant` instance used only for
`target()` / `models()` / `addUsage()` / `costOf()`, with **every** row of *Settings › Language models*
(also the ones marked for upsampling only: Help needs no eyes and no tools). The system text is the rules
of §5 plus the manual without its comments, 40,390 characters (about 10,000 tokens), byte-stable for the
chat. The model is `settings.help.model`, else the assistant's when it is ready, else the first ready
one. A second question while one runs is refused (a `starting` guard over the model lookup too); a
stopped question's unanswered user message is replaced by the next; a tool call nobody offered stays out
of the history. The test-key rule is the assistant's. IPC `help:manual|models|send|stop|reset|state|
setModel`, events on `help:event`, `window.scumble.help`, log lines tagged `help`.

**§7, the panel.** `renderer/help.js` + `help.css`: a `<dialog id="help">` column left of the assistant's,
**F1** (menu *Help › Scumble help*, which replaces *Editor guide*) and a *Help* button in the bar. The
search narrows to chapters holding every word (two letters and more) and marks them; Enter jumps to the
first, Escape clears it, Escape again closes. The chat sits above the manual when a model is ready, else
one line and a *Settings* button; an answer's last `Chapter:` line becomes a *Read:* link. One window
capture `keydown` listener as in the assistant; no markup written (`no_markup_writes` covers `help.js` and
`help/manual.js`).

**§8, decided without asking, both the plan's recommendation or simpler:** its own dialog; **chats are not
kept** (the plan said five; a help chat is throwaway, and no store means nothing to delete).

**Tests.** `tools/assistant_test.js` section `help` (12 checks: all four families send no `tools` and the
manual, the chat and its system text across two questions, reset, no key, the model choice, a text-only
row, an unoffered tool call, the second-question guard, Stop); `tools/manual_test.js` (7 checks); the new
gate **`help`** (`tools/help_test.py`, the manual test and six app steps against `tools/assistant_mock.py`:
the panel without a key, the search, keys never reaching the editor, a question answered with its
*Read:* link, a second question and *New chat*, a 401 as words without the key). **Mutations: 15 of 16
red**; the green one takes the panel's own `stopImmediatePropagation` out, and the editor's key handler
still ignores every key inside an open `<dialog>`, so that guarantee exists twice and no step can tell
them apart. Gates `--offline`: tiles `help assistant llm mcp commands platform editor types` ALL PASS
(`help-tiles`), canvas `help assistant editor` ALL PASS on the rerun (`help-canvas2`; the first run's
`editor` failed `selection_keeps_its_bounds_through_a_restore_above_1mp` with no message, a timing flake).

**Not done.** §5's invention check against a **live** model: the mock can only prove the rule is in the
system text, not that a model keeps it; that needs one real question the manual does not answer, on the
user's key. No screenshot of the panel in the manual yet (the chapter has none).

