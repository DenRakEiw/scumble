# The assistant

A chat column beside the picture. You write what you want; it drives the editor through the same
commands an external agent gets over MCP - select, add layers, set the prompt, render, colour
match, export - and you watch every step as a card. It runs on your own API key, and nothing it
does is out of reach of Ctrl+Z.

Open it with the **Assistant** button in the bar, **View › Assistant** or **Ctrl+Shift+A**. It
remembers whether it was open.

## What it needs

An API key for one provider, under *Settings › API providers*. Without one the panel says which
row to fill. The key never leaves the main process: the window shows only that a row is set and
its last four characters.

| Provider | Key row | Models the picker offers |
|---|---|---|
| OpenRouter | `openrouter` | Claude Sonnet 5 / Opus 5, GPT-5.6 Terra, Gemini 3.8 Flash, DeepSeek V4.1 Flash, Kimi K3 / K2.6, GLM-5.3-Flash, plus any model id from OpenRouter's live list of tool-capable models |
| OpenAI | `openai` | GPT-5.6 Terra, Sol, Luna |
| Anthropic | `anthropic` | Claude Sonnet 5 (the default), Claude Opus 5 |
| Google | `gemini` | Gemini 3.8 Flash, 3.1 Pro (preview), 3.5 Flash-Lite |
| DeepSeek | `deepseek` | DeepSeek V4.1 Flash |
| Moonshot (Kimi) | `moonshot` | Kimi K3, K2.6 |
| Z.ai (GLM) | `zai` | GLM-5.3-Flash, FlashX |
| ToAPIs | `toapis` | Claude Sonnet 5 / Opus 5, Gemini 3.8 Flash |
| WaveSpeed | `wavespeed` | Claude Sonnet 5 / Opus 5, Gemini 3.8 Flash |
| Oxen.ai | `oxen` | Claude Sonnet 5, GPT-5.6 Terra, Gemini 3.8 Flash |
| Local / OpenAI-compatible server | none (a saved URL) | whatever its `/models` lists |

A provider without a key is greyed out in the picker. A model carries a mark only where
something is true of that model: **"cannot look at the picture"** for a model without image
input, and the preview note where the provider calls a model one.

The provider and the model are **fixed per chat**: picking another one starts a new chat and the
panel says so.

## Models of your own

The table above is what Scumble ships with. Any other model of any of those providers - one that
came out after this release, a cheaper one, an OpenRouter id nobody curated - goes into
*Settings › Language models*: pick the provider, type the model id the provider itself uses,
give it a name if you like, and say what it is for:

- **Prompt upsampling** puts it in the editor's *Upsample* list (`docs/PROMPTS.md`).
- **Assistant** puts it in this picker, in its provider's group, after the models Scumble knows.
- **Can see the picture** off means the model has no image input: it then never gets the crop,
  and the assistant leaves `screenshot` out of its tool list, as for any blind model.

It runs on the key that provider already has under *API providers* (the local endpoint on the
URL above it); a provider without a key stays greyed out. *Remove* takes a row out of both lists
again. For OpenRouter the id field suggests from its live list of models that take tools.

Nothing checks that the id exists or that the model can use tools - that is between you and the
provider, and its own error comes back into the chat.

## What it does with a turn

You write a line and press Enter. The assistant then:

1. reads which documents are open and what is in the one in front (the **pinned** document: every
   call of that turn goes to it, even when you switch tabs);
2. asks the model, streaming its answer into the panel;
3. runs the tools the model asks for, one card per call - the arguments, how long it took, the
   first of what came back, and a screenshot as a thumbnail;
4. stops at the step limit (*Settings › Assistant*, 25 by default), at Stop, or when the model
   has nothing left to do.

**Stop** ends the turn: the model request is aborted, a call that has not started is dropped, and
a command that has started runs on in the editor. Your next message continues the same chat.

## What it asks before it does

Everything that can cost money, queue on your ComfyUI, or cannot be taken back asks first, with a
card that says why:

- **`generate`, `generate_new`, `upscale`, `select_by_text`, `cutout_layer`, `upsample_prompt`** - they cost
  money or queue on your server. The card names the recipe and, for a local run, what is in your
  queue. An `upscale` of the selection adds a layer Ctrl+Z takes back like `generate`'s; one of the
  whole picture is one undo step of its own, as *Resize* is.
- **`flatten`, `extend_canvas`, `new_canvas`, `load_image`** - they clear the undo stack or bake
  every layer into the base.
- **Removing, merging or editing a layer that is not the assistant's own**, unlocking a layer you
  locked, moving or retexting a locked one, `undo` / `redo`, reading a file, an export with a
  path, and the global settings.
- Editing a layer the assistant made itself, and the per-document fields (prompt, generation
  settings, crop, the recipe's settings), run **without** asking.

Neither button of an ask card is the default, and Enter in the chat field never answers one. An
export without a path, or with an extension that does not match the format, is refused outright.

## Taking it back

- **Ctrl+Z undoes each step**, including the ones the editor records no step for by itself: a new
  layer, `set_layer`'s name, visibility, opacity, blend, role or colour match, `set_filter`'s
  parameters, `set_text`. For those the assistant pushes the editor's own step before the call.
  A `set_layer` that also moves the layer ends as two steps, so it takes two Ctrl+Z.
- **"Undo this turn"** appears on the turn's card when it changed something. It takes every
  document the turn touched back to what it was **before the turn's first change there** - the
  pixels, the selection, the prompt, the generation and crop settings and the recipe's settings -
  and it works even when the turn was longer than the 30-step undo stack. Ctrl+Z takes that
  restore back again.
  - It needs the **tile engine** (*Settings › Rendering*). On the canvas backend a copy of every
    layer would cost hundreds of megabytes, so the button is not offered there.
  - If **you** edited one of those documents while the turn ran, the button says so and only the
    second press discards your work.
  - A turn of 25 steps can push your own oldest undo steps past the 30-step limit. The turn
    itself still comes back whole, because its snapshot sits outside the stack.
- The per-document fields (prompt, generation, crop, settings) come back **only** with "Undo this
  turn": no undo step of the editor covers them.
- An **external agent's** calls get none of this: its added layers and its colour match stay
  without an undo step, exactly as before.

## Chats

Every chat is saved as it goes, under `assistant/chats/` in the app data folder, with its
screenshots beside it. The **Chats** button lists them; one reopens on the provider and model it
was written with, and only while a key for them is there - otherwise it opens to read, and the
panel says why. *Settings › Assistant* says how many chats to keep (20) and how many tool calls
one turn may take.

**Delete all assistant data** there removes every chat and screenshot, the dates of the privacy
notices, the assistant's settings and its lines in the app log. **Your API keys stay**: they
belong to *API providers*.

## Where your picture goes

What leaves the app: your messages, a short note on the open documents (their names, sizes and
layer names), the results of the tools the model called, and the screenshots it asked for. It
goes to the provider you picked, and to nobody else. Scumble asks none of them to keep the
conversation - OpenAI gets `store: false`, Gemini's `generateContent` holds no state, the rest
are stateless calls - but what a provider does with a request is its own terms, which is why the
panel shows a one-line notice per provider the first time you send to it.

| Provider | Where, as far as its own terms say |
|---|---|
| Anthropic | Anthropic, which runs inference in any region |
| OpenAI | no default region stated |
| Google | Google, which runs inference in any region |
| OpenRouter | a host OpenRouter picks. Scumble sends `data_collection: "deny"` and excludes every host OpenRouter lists in China |
| DeepSeek | the People's Republic of China |
| Moonshot (Kimi) | Singapore (platform.kimi.ai) |
| Z.ai (GLM) | Singapore; the GLM-5.3-Flash cluster's region is not stated |
| ToAPIs, WaveSpeed | not stated |
| Oxen.ai | Oxen.ai, which runs the model or passes it on to its maker or another host; its terms could not be read, so where the pictures go and how long they are kept is not stated |
| Local server | your own machine, or wherever you pointed the URL |

## What it cannot do

- It sees the six tools external agents have but the assistant does not: the command list, plugin
  actions, the status line and the AI-label tools.
- A model **without image input** gets no `screenshot` at all: it judges the picture from the
  layer list and the document's size, and the system prompt tells it to ask you to look when it
  matters.
- It does not open files by itself, and it cannot save one without a path you gave it.
- It is not a prompt template: templates are one call with no tools (`docs/PROMPTS.md`).
- It has **not been tried against a live API** in this release. The wiring was proven against the
  real hosts - every family built its request, reached its host with the real key and read the
  answer - but no model has completed a task here yet; the picker says so per provider. The Oxen.ai
  entry (0.1.29) is written from Oxen's docs and model list and has not been tried with a real key at
  all: its chat route is `/api/ai/chat/completions` (no `/v1`), and it is sent without `stream_options`,
  which Oxen does not document, so a turn may show no cost line.

## Keys, focus and the editor

The chat column keeps its own keys: Enter sends (Shift+Enter is a new line), Escape stops a
running turn or hands the focus back to the picture, and no key typed in the chat reaches the
editor's shortcuts or an open editor question. While you are writing, the chat field takes the
focus back when the editor grabs it for itself - but never from a field you clicked into, and
never after Escape.

These still fire anywhere, as always: **Ctrl+W** closes the tab (after its confirm), **Ctrl+R**
reloads the window, **Ctrl+0 / Ctrl+= / Ctrl+-** zoom the whole window, **F11** is full screen.

Dropping an image on the chat column does nothing: drop it on the canvas. Plugins share the
window with the panel, as they share it with everything else in the editor.

## What it costs

The panel's footer shows the running total of the chat and of the last turn, and how much of the
context was read from the provider's cache. The prices come from each provider's own page as read
on 2026-09-19 and are marked with that date; OpenRouter reports the real cost per request, so
there the number is the provider's own. A local server costs nothing and says "local".

One turn sends the tool list (about 67 tools), the state note and the chat so far; a screenshot
is about 900 to 1,400 image tokens at the default 1024 px. A turn of a few steps on Claude Sonnet
5 is a few cents.
