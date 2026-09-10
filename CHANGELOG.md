# Changelog

What changed in each release, for the people who use Scumble. The release on GitHub carries
the section for its version; `docs/` and the commit history hold the technical detail.

## 0.1.3 — 2026-09-10

- **The view is composited on the graphics card.** Every layer is now stacked in one shader
  pass instead of being drawn one at a time on the processor. On a large window with a
  dozen layers the slowest frames went from about 10 ms to 0.2 ms, so panning and zooming
  stay smooth where they used to stutter. The picture is unchanged: the new path was checked
  against the old one pixel by pixel over every blend mode, a masked layer, colour match and
  text, and agrees to within one level of 255.
- Filter layers, a running brush stroke, a transform, the compare split and every export
  keep the previous path, and so does any machine without WebGL2. Nothing depends on the
  new compositor being available.

## 0.1.2 — 2026-09-10

- **High-resolution editing is a different program.** Working on 6k to 12k images used to
  mean waiting after every action; the whole drawing pipeline was rebuilt around what is
  actually visible. On a 96 megapixel document:

  | | before | now |
  |---|---|---|
  | opacity or colour-match slider | 250–900 ms per step | under 10 ms |
  | pan and zoom | stuttering | steady |
  | grow the selection by 16 px | 3.9 s frozen | 0.3 s |
  | magic wand, paint bucket | 1.5–2 s frozen | 0.3 s |
  | saving a layered PSD | 4.1 s frozen | 0.1 s |

  Long jobs now run beside the window instead of stopping it, so the interface keeps
  answering while they finish.

- **Fixed: images larger than 64 MB could not be loaded.** Nothing happened and the reason
  only appeared in the status line. Large files took a route that needed a reachable
  ComfyUI; they are stored locally now like every other image, so loading works with no
  server at all. This also fixes rendering with very large layers.
- **Prompt upsampling with your own API keys.** GPT-5.6 Luna and Terra, Gemini 3.8 Flash and
  3.5 Flash Lite, Claude Opus 5 and Haiku 4.5 appear in the upsample list once a key for
  that provider is stored, next to the ComfyUI nodes. "Select by text" can use them too.
- **Setting presets for local recipes.** Save a model, text encoder and VAE combination
  under a name and pick it again from the Settings section.
- The local / api switch now also switches the recipe list, instead of leaving the previous
  recipe selected in the wrong mode.
- Removed the models the providers retired (gemini-2.5-flash-image, gpt-image-1.5).

## 0.1.1 — 2026-09-09

- **Fixed: filters on very large images showed a stretched corner.** Chromium caps a
  graphics buffer at about 33 megapixels, so a film look on a 10864 × 6062 image rendered
  one corner blown up to full size. Filters render in tiles above that cap now; only the
  16384 pixel limit on a single side remains.
- **Two more API providers**: WaveSpeedAI and Comfy Cloud, each as a variant of the existing
  model recipes.
- Fixed: the provider list in Settings kept showing "(no key)" after a key was saved or
  cleared, until the dialog was reopened.

## 0.1.0 — 2026-09-09

The first public release, under the GPL-3.0.

- A standalone editor for AI inpainting: Krita-style layers, selection by text, retouch
  tools, filter layers, colour match per layer, text layers, PSD and ORA export.
- Renders through your own ComfyUI, locally or remote, or through an API provider.
- Background removal and object selection run in the app through ONNX (SAM2, BiRefNet,
  RMBG), on the graphics card where possible.
- JavaScript plugins on the command core, with a film pack of eleven looks built in.
- Speaks MCP, so an agent can drive the editor.
- Updates itself from GitHub Releases.

Windows only for now, and the installer is not signed yet, so SmartScreen will warn on the
first start (More info, then Run anyway).
