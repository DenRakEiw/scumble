# The Microsoft Store listing

What Partner Center asks for when a package is submitted (docs/STORE.md is the package itself, its
identity and what ran on it). Written for the first submission, 0.1.27, on 2026-09-23. Everything
here is pasted into Partner Center by hand; nothing reads this file.

The package declares **English only** (`build.appx.languages`), because the app's interface is
English: every language the package declares needs a complete listing of its own.

## Submission options

| Field | Value |
| --- | --- |
| Pricing | Free, all markets |
| Category | Photo & video |
| Subcategory | (none) or Image editing, where offered |
| Privacy policy URL | https://github.com/DenRakEiw/scumble/blob/main/docs/CODE_SIGNING_POLICY.md#privacy-policy |
| Website | https://www.denrakeiw.com/scumble |
| Support contact | https://github.com/DenRakEiw/scumble/issues |
| Copyright | © 2026 DenRakEiw. Free software under the GNU General Public License v3.0. |
| Additional license terms | https://github.com/DenRakEiw/scumble/blob/main/LICENSE |
| Restricted capability `runFullTrust`, the why | Scumble is a desktop image editor (an Electron app packaged with the Desktop Bridge). It connects to the user's own ComfyUI server, usually on 127.0.0.1, reads and writes image files the user opens and saves anywhere on disk, runs local helper models with ONNX Runtime and DirectML, and offers a local MCP server for AI agents. None of this is possible from an AppContainer. |
| Age rating (IARC) | Answer that the app lets users generate and edit images with AI models of third-party providers the user chooses and pays, from their own prompts; no user-to-user communication, no content shared by the app, no purchases in the app. The rating body decides; expect a general rating with a note on generated content. |

## Description (up to 10,000 characters)

Scumble is a desktop editor for AI inpainting. Select a part of a picture, describe what should be there
instead, and the answer comes back as a layer you can blend, colour-match, mask and export, next to
everything else a layer editor does.

It renders through your own ComfyUI, on your machine or a rented server, or through the image models of an
API provider whose key you give it: Google's Nano Banana, OpenAI's GPT Image, Black Forest Labs' FLUX.2,
ByteDance's Seedream, Qwen Image Edit and others, directly or through fal.ai, Replicate, WaveSpeedAI, Comfy
Cloud or OpenRouter. You pay the provider directly; Scumble has no account, no subscription and no server of
its own in between.

What it does:

- Select by brush, shapes, lasso, magic wand, a hovered object (SAM2, running in the app) or a few words.
- Recipes instead of node graphs: pick "Flux.2 Klein local" or "GPT Image 2.5 via OpenRouter", press Generate.
  Your own ComfyUI workflow becomes a recipe when it holds an Inpaint Canvas node.
- Layers with masks, blend modes, opacity and a colour match per layer, so a generated patch sits in its
  surroundings.
- Filter layers on the GPU: curves, levels, colour balance, grain, LUTs and a film pack.
- Text, shapes, brushes, retouching (clone, heal, smudge) and 3D objects placed into the picture.
- Upscaling of the whole picture or a selection, through the providers or your ComfyUI.
- Large pictures: documents up to 65,535 pixels a side, kept in tiles.
- Export to PNG, JPEG, WebP, and PSD or OpenRaster with every layer; PSD and ORA files open with theirs.
- An assistant that drives the editor for you on your own key, asking before anything costs money, with
  every step undoable.
- The manual in the app (F1), searchable and offline, with a chat that answers from it.
- A built-in MCP server, so Claude and other AI agents can drive Scumble directly.

Scumble is free and open source (GPL-3.0). Your pictures, keys and settings stay on your computer; keys are
kept in Windows' own credential store. The app sends nothing anywhere unless you run a recipe, a prompt
upsampling or the assistant, and then only to the service you picked.

## Short description (the first lines people see)

A desktop editor for AI inpainting: select, describe, generate, and blend the result as a layer. Renders
through your own ComfyUI or the image models of the API provider you choose.

## Product features (up to 20, 200 characters each)

1. Inpaint a selection with FLUX.2, GPT Image, Nano Banana, Seedream, Qwen and more
2. Render on your own ComfyUI, locally or on a rented GPU, or through your API key
3. Select by brush, wand, lasso, a hovered object (SAM2 in the app) or a few words
4. Layers with masks, blend modes and a colour match per layer
5. GPU filter layers: curves, colour balance, grain, LUTs and a film pack
6. Upscale the whole picture or a selection
7. Open and save PSD and OpenRaster files with their layers
8. An assistant that drives the editor on your own key and asks before it spends money
9. The manual in the app (F1), with a chat that answers from it
10. A built-in MCP server for Claude and other AI agents
11. No account, no subscription: pay the provider you choose directly
12. Free and open source under GPL-3.0

## Keywords (up to 7)

inpainting, AI image editor, ComfyUI, FLUX, image generation, layers, PSD

## What's new in this version

The first version in the Microsoft Store. New in 0.1.27: the manual in the app (F1) with a chat that answers
from it, a logo, a prompt field for the upscalers that take one, and a smaller install.

## Screenshots (1366 x 768 or larger, up to 10)

The manual's pictures, 1600 x 946, from the website's `public/projects/scumble/manual/`; copied into
`dist/store-listing/` by the release session and **converted to PNG** (Partner Center takes PNG only), in this
order, with these captions:

1. `first-edit.jpg` - Select a part of the picture, describe what should be there, generate.
2. `selection.jpg` - Selection by brush, wand, object or words.
3. `layers.jpg` - Every result is a layer, colour-matched to its surroundings.
4. `filters.jpg` - Filter layers on the GPU, and a film pack.
5. `upscale.jpg` - Upscaling through the providers or your ComfyUI.
6. `help.jpg` - The manual in the app, with a chat that answers from it.
7. `text-shapes-objects.jpg` - Text, shapes, brushes and 3D objects.

Leave out every screenshot of *Settings › API providers*: it shows the last characters of a stored key
(the manual's own shot was masked before it was taken).

## After the first submission

- Certification takes hours to a few days; the result arrives by mail.
- Every later submission needs a higher version than the last (`package.json`; the fourth part stays 0).
- Coupling it to the GitHub release (the `msstore` CLI in `build.yml`) needs an Entra ID app linked to the
  Partner Center account; only submissions after the first can go through the API.
