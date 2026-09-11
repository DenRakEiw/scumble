# Changelog

What changed in each release, for the people who use Scumble. The release on GitHub carries
the section for its version; `docs/` and the commit history hold the technical detail.

## 0.1.6 — unreleased

- **API runs go out at the size the provider really takes.** Until now every API run sent a
  1024 px crop, whatever the model could have handled, because one number in the Generate
  section governed both the local and the API path. Each model now carries its own ceiling
  and the crop is emitted against that: FLUX.2 and FLUX.1 Fill at most 1440 px (2048
  answered with an error), GPT Image at most 2048 px inside its pixel budget, Seedream 5
  under an area budget instead of a side limit (4 megapixels for pro, 16 for lite), so a
  wide selection goes out well past 2048 px, the rest at a conservative 2048 until the
  provider's own number is confirmed. The new **API size** row
  under the Generate section chooses how the ceiling is used: *Provider max* for the best
  the model offers, *2x crop* and *4x crop* for a high-res fix that sends a small selection
  at twice or four times its own resolution, or the two older behaviours. Local ComfyUI runs
  are untouched and keep using Target.
- **Export can save smaller.** A Size row under the Export section takes a percentage of the
  document, or a free width and height that keep the aspect ratio, and JPEG and WebP got a
  quality field next to it. A large reduction is walked down in halving steps instead of one
  jump, which keeps fine detail from breaking up. The status line names the size that was
  actually written. PSD and ORA always keep the full size, because their layers would each
  have to be scaled. The `export` command and the MCP tool take `scale`, `width`, `height`
  and `quality` for the same thing.
- **Seven more models.** Z-Image Turbo (fal, with a real mask inpainting endpoint),
  Ideogram 4, Grok Imagine 2.0 and Reve 2.1 for editing; Krea 2, Recraft V4 and Z-Image base
  make images from the prompt alone, so they appear in "Generate new" and the Generate
  button says where they belong. None of them has run against the live API yet, as with
  every other provider in Scumble.

## 0.1.5 — 2026-09-10

- **MCP clients that refused to talk to Scumble now connect.** Before the app itself starts,
  Electron writes one empty line to the channel the client is listening on, and a client that
  follows the specification to the letter counts that as a broken message and drops the whole
  session. Scumble is now started through a small launcher that keeps the channel clean.
  Help › Copy MCP registration puts the right line for Claude Code or the JSON block for
  Claude Desktop on the clipboard, with the paths of your installation filled in - nobody
  should have to type those by hand. An already working registration keeps working.
- **Prompt upsampling on your own machine, without a key.** Settings › Local /
  OpenAI-compatible endpoint takes the address of a server that speaks the OpenAI chat API -
  Ollama, LM Studio, vLLM, a proxy - and a model name, and that model joins the Upsample list
  in the Prompt section next to the ComfyUI nodes and the API models. Test asks the server
  which models it has and offers them in the field. A model that can see gets the same crop
  the other backends get; one that cannot is asked again without it, and the status line then
  says "text only" so you know the rewrite is based on your words alone.
- **Generate a new image from the prompt alone.** *Generate new* in the top bar opens a
  dialog: where it runs (your ComfyUI or an API provider), which model, the prompt with the
  upsample button beside it, aspect ratio and size, and the seed. The answer becomes the
  tab's image, so you can start from nothing and then edit as usual. On an API provider
  nothing but the prompt is sent, no blank canvas travels with it. Providers that can do
  this: OpenAI, Google, Black Forest Labs, fal.ai, Replicate and WaveSpeedAI; Comfy Cloud
  cannot and says so.
- **The size list follows the model.** Nano Banana and the other Gemini image models are
  offered up to 4096 px, because that is what they take; OpenAI's stay at their two standard
  sizes. Before, every model got the same list that stopped at 2048. The list has nothing to
  do with whether a key is stored.
- **Prompt templates as Markdown files.** How the language model rewrites your prompt is no
  longer one fixed rule. Four come with the app - a rich scene, a photographic one, a tag
  list for SDXL-style models, and a short edit instruction - and you can write your own,
  import them under Settings › Prompt templates and pick one in the Generate new dialog or
  for the editor's Upsample button. A template is a plain .md file with a short header, so a
  prompt style can be kept and passed on like any other document. See docs/PROMPTS.md.
- **New asks for width and height in two boxes.** One field that wanted "1440x1440" was
  awkward to type and easy to get wrong. There are two number boxes now, with a *Keep the
  ratio* tick if you want the second to follow the first.
- **Fixed: the size in that dialog could not always be typed.** The dialog put the cursor in
  the field, and the click that had opened it took the cursor straight back to the canvas.
- **A click deselects again, as in Photoshop and Krita.** Clicking inside an existing
  selection with the rectangle or ellipse tool started moving its outline and kept the
  selection even when nothing moved. A lasso click did nothing at all. Both clear the
  selection now, so you can start a new one straight away. The selection brush is unchanged:
  a click sets a dab there, which is what a brush does in both programs too.
- **The selection outline stays visible on a white image.** While you drag a rectangle,
  ellipse, lasso or polygon, the outline was a white dashed line and vanished on anything
  light. It is now drawn black first with the white dashes over it, the same two-colour trick
  the finished selection already used.
- **Copy and paste whole layers, also from one tab into another.** Ctrl+C with nothing
  selected used to refuse; it now copies the whole active layer, Ctrl+X cuts it out, and
  Ctrl+V pastes it as a new layer in any tab. The layer row also has a duplicate button now,
  for what Ctrl+J could always do.

## 0.1.4 — 2026-09-10

- **Fixed: the app got slower the longer you worked in it.** Opening and closing several
  large images in one session left every one of them in memory, with all of its layers. After
  four 12k documents a slider drag cost 50 ms per step instead of 9, panning stuttered, and
  the graphics card was holding 19 GB it could not use for anything. The documents are let go
  properly now: the same four rounds end within a few percent of the first one, and with
  35 MB left over instead of 19 GB. The cause was in the plugin system, so it also applies to
  any plugin you write yourself.
- **Filter layers stay on the graphics card.** A stack of filter layers used to hand the
  picture back and forth between the processor and the card once per layer. It now stays
  there for the whole chain: five filter layers on a 24 megapixel document cost 1.5 ms a
  frame instead of 2.9, and a film look with halation and grain 2.7 ms instead of 3.4. The
  picture is unchanged, checked layer by layer including opacity, blend modes and masks.
- **Free VRAM gives the caches back too.** The button in the toolbar already unloaded the
  helper models; it now also releases the filtered copies, the display pyramids and the
  textures the current documents are holding, and says how many megabytes that was.
- **Background tabs release their caches when memory runs short.** Above a limit you can set
  in Settings › Rendering (3 GB by default, 0 switches it off) the tabs that are not in front
  give up what they can rebuild. The document in front is never touched, and neither is a tab
  that is working on something.
- **Fixed: painting or erasing on a layer snapped back.** The stroke was in the image the
  whole time - it was saved, exported and rendered with - but the screen kept showing the
  layer as it was before. A regression of the graphics-card compositor in 0.1.3.
- **Fixed: the colour match slider did nothing.** On the same path the match had nothing to
  measure itself against and quietly stayed at zero, whatever the slider said. Also from
  0.1.3, and also only on screen: a flatten or a run applied the match correctly.
- **A reference image keeps the layer's mask tools.** Turning a layer into a reference used
  to take away background removal (RMBG) and the mask buttons, which is where a reference
  needs them most. The selected reference now has the same row as an image layer, and the
  cut-out travels into the image that is sent with the crop.

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
