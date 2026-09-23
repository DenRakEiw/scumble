# Help: the manual in the app, with a chat on top

Asked for by the user on 2026-09-23: a **Help button** that opens a chat which answers questions
about using the app, with a Markdown file holding everything about Scumble as its context, on a
model picked from the ones the user has keys for. Not built. This file is the design and what it
would cost.

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
