# Scumble manual

<!--
  The one source of the manual: the app's Help panel renders it and its chat answers from it
  (docs/PLAN_HELP.md), and the website's /scumble/manual page is generated from a copy of it
  (node tools/manual_sync.js). renderer/help/manual.js parses it; keep to the shape it reads:
  one ## per chapter, the slug and the one-line summary right under it, paragraphs, then
  ### Steps (a numbered list, each item starting with its **title.**), ### Keys (#### group
  headings over two-column tables) and ### Notes (a bullet list), in that order. Screenshots
  are images with the website's URL and their size as the title.
-->

## Install and first start

<!-- slug: install -->
_Download, the SmartScreen warning, and what Scumble needs on your machine._

![Scumble at first start: one empty tab, the tool column on the left, the side panel on the right, and the hint to load, paste or drop an image](https://www.denrakeiw.com/projects/scumble/manual/install.jpg "1600x946")

Scumble is a normal desktop app. Download the installer from the latest release on GitHub, run it, and it is in your start menu. There is no account, no sign-up and no server of mine in between: the app talks to your own ComfyUI, or to the API provider whose key you gave it, and to GitHub when it looks for an update.

The installer is not code-signed yet, so Windows shows "Windows protected your PC" the first time. That is the warning Windows gives every unsigned program, not a verdict about this one. Click More info, then Run anyway. Updates after that are downloaded by the app itself and do not go through SmartScreen again. Proper signing is planned through the SignPath Foundation, which is free for open-source projects but wants a project with a public release and some use behind it first.

On Linux the same release carries an AppImage and a .deb. Fair warning: they are built by CI and have not been run by me, because I have no Linux machine here. If you try one, tell me what breaks. macOS is prepared but not released.

The app alone can do a great deal — open, paint, select, layer, filter, export — but it generates nothing until it has somewhere to render. That is the next chapter.

### Steps

1. **Download.** Scumble Setup \<version\>.exe from the latest release. On Linux: the .AppImage (chmod +x, start it) or the .deb.
2. **Run it.** More info, then Run anyway, when SmartScreen asks. The app installs per user, no admin rights needed.
3. **Start it.** First start opens an empty tab. Nothing is configured yet and nothing has to be.

### Notes

- Windows 10 and 11, 64-bit. A GPU is not required for the editor itself: filters run on the GPU when there is one and fall back to the processor when there is not.
- The installer is about 128 MB, the installed app about 410 MB, most of which is Chromium and the helper models' runtime.
- Updates: Settings › Updates shows what changed before you restart into the new version. You are never updated behind your back.

## Where it renders: your ComfyUI, or an API key

<!-- slug: rendering-and-keys -->
_The one decision to make before the first generate — and how to store a key so it is not lying in a config file._

![Settings, the API providers section: one row per provider with its key field, Save and Clear, and a note under each saying whether a key is stored](https://www.denrakeiw.com/projects/scumble/manual/rendering-and-keys.jpg "1600x946")

Scumble does not generate anything itself. It sends your selection somewhere and puts the answer back as a layer. That somewhere is either your own ComfyUI, or a model provider you have an API key for. You can have both and switch per run; the recipe picker in the top bar decides which one a run uses.

Your own ComfyUI is free to run, keeps every pixel on your machine, and gives you the models you already downloaded. It needs the node pack ComfyUI-InpaintCanvas installed there, and the models the recipe asks for. Type the server's address into the top bar — http://127.0.0.1:8188 for a local one, or the address of a rented box, RunPod included — and press Connect. If the node pack is missing, Scumble notices and offers to install it through the ComfyUI Manager.

An API provider needs no server at all. Put a key into Settings › API providers and the models behind it appear in the recipe picker: Google's Nano Banana, OpenAI's GPT Image, Black Forest Labs' FLUX.2, ByteDance's Seedream, Qwen Image Edit, and the same models through aggregators like fal.ai, Replicate, WaveSpeedAI, ToAPIs, Comfy Cloud, Comfy Router and OpenRouter. You pay that provider directly; Scumble takes no cut and sees no invoice. Comfy Router has no key row of its own: it runs on the Comfy Cloud key, with credits and without a paid Comfy plan. The same key runs HY Image 3.5 through Comfy's Partner API.

Keys are stored in the operating system's own credential store through Electron's safeStorage, never in a settings file you might share by accident. On Linux that is the desktop keyring; if the system has none, the settings say so in plain words rather than pretending the key is encrypted when it is only obfuscated.

The same key rows also feed two other things: the assistant, and prompt upsampling. If you already have an OpenRouter key, one key covers a lot of ground at once.

### Steps

1. **For a local ComfyUI.** Install the ComfyUI-InpaintCanvas node pack there, start ComfyUI, type its address in the top bar, press Connect. The dot goes green.
2. **For an API provider.** Ctrl+, → API providers, paste the key into its row, Save. No restart, no connection needed.
3. **Pick what a run uses.** The recipe dropdown in the top bar lists every recipe you can actually run: local recipes when a server is connected, provider recipes when their key is there.

### Notes

- A provider recipe with no key is shown greyed out with the reason, not hidden — so you can see what would be available.
- A remote ComfyUI behind basic auth or a token: the fields are in Settings › ComfyUI, and the app proxies everything through its own origin, so images from the server never taint the canvas.
- Nothing is uploaded to a provider until you press Generate. Opening, painting, selecting, filtering and exporting all happen on your machine.

## Your first edit

<!-- slug: first-edit -->
_Open a picture, select something, describe what should be there instead, generate. The whole loop in one page._

![The picture open, the handbag selected with marching ants and the crop box around it, the Generate tab on the right with the prompt typed in](https://www.denrakeiw.com/projects/scumble/manual/first-edit.jpg "1600x946")

The loop is always the same, whatever the model behind it: select an area, write what should be in it, press Generate. What comes back is a layer sitting over the selection, not a new picture — which is the point of the whole app. If you do not like it, you delete the layer and the original is untouched underneath.

Open a picture with Ctrl+O, by dropping it on the window, or by pasting from the clipboard. PNG, JPEG and WebP, and since 0.1.25 also PSD and ORA files with their layers intact. Then paint over the thing you want changed with the selection brush — the default tool, size with the bracket keys, Alt to erase what you painted too much of.

The prompt goes into the Generate tab on the right. Describe what should be in the selected area, not what is there now: "a red leather handbag" and not "change the bag to red leather". Then Generate, or Ctrl+Enter. A run on a local ComfyUI takes as long as your card needs; an API run is usually ten to thirty seconds. While it runs you can keep working, even in another tab.

The result arrives as a layer over the selection, and the layer row has a Match slider. That slider is the small feature that saves most results: it matches the colours of the generated patch to what surrounds it, so the piece stops looking pasted in. Start at 100 %, pull it back when the model's own tone is worth keeping.

Happy with it? Ctrl+S saves the visible picture. Not happy? Press Generate again — a new seed, a new layer, and you can compare the two by toggling their eyes.

### Steps

1. **Open.** Ctrl+O, or drop a file on the window, or Ctrl+V a picture from the clipboard.
2. **Select.** Paint over the area with the selection brush. \[ and \] change the size, Alt subtracts.
3. **Prompt.** Generate tab on the right: describe what should be there. Leave it empty for a pure cleanup with an inpainting model.
4. **Generate.** Ctrl+Enter. The status line says where it runs and how long it has been running.
5. **Blend.** In the new layer's row, pull Match up until the patch sits in the picture.
6. **Save.** Ctrl+S for the visible picture, or the Export panel for PSD and ORA with all layers.

### Notes

- Feather the selection by a few pixels (Selection panel) before a generate and the edge gets easier for both the model and the stitch.
- Every document is a tab: Ctrl+T new, Ctrl+W close, Ctrl+Tab next. A run keeps going while another tab is in front.
- Ctrl+Z is a real undo stack, not a single step, and it covers the assistant's work too.

## Selecting: brush, shapes, wand, objects, words

<!-- slug: selection -->
_Seven ways to say which part of the picture you mean, and what to do with the selection once you have one._

![The handbag outlined exactly by the in-app SAM2 model after one click, with the status line reporting 97 objects found in 3.3 seconds](https://www.denrakeiw.com/projects/scumble/manual/selection.jpg "1600x946")

The selection is the most important thing in an inpainting editor, so Scumble gives it seven routes. The brush is the honest one: paint, Alt to subtract, done. Rectangle, ellipse and lasso are there for the shapes that painting gets wrong. The magic wand takes everything of a similar colour from where you clicked, which is what you want for skies and flat backgrounds.

Object hover is the one people like: move the pointer over the picture and Scumble outlines the object under it, click to select it. That is SAM2 running inside the app through ONNX Runtime, on your GPU on Windows and on the processor on Linux. Nothing leaves your machine, and the model file is downloaded once or read from a ComfyUI models folder you point at.

Selection by text is the other one: type "the handbag" or "her sunglasses" into the Selection panel and press Go. That route runs on your connected ComfyUI (SAM3 there), so it needs a server, unlike object hover.

Once you have a selection, the Selection panel does the rest: grow and shrink it by a pixel count, feather its edge, invert it, take it from a layer's transparency, or save it under a name to come back to later. Selections survive a restart with the document.

### Steps

1. **Something with a clear shape.** Hover it, let the outline appear, click. Grow by 8 px afterwards if the edge is tight.
2. **Something flat.** Magic wand, then raise the tolerance until the whole sky is in.
3. **Something you can name.** Type it into the text field in the Selection panel and press Go (needs a connected ComfyUI).
4. **Something awkward.** Paint it. It is faster than fighting a clever tool.

### Notes

- Ants on or off: the marching-ants outline can be switched to a flat tint, which is easier to judge a result under.
- Grow, shrink and feather are the difference between a visible patch and an invisible one. A feather of 4 to 16 px is a good habit.
- Select from layer turns any layer's transparency into a selection — useful after a cut-out.
- Background removal (RMBG / BiRefNet) also runs in the app and gives you a cut-out layer, not just a selection.

## Recipes: what model runs, and where

<!-- slug: recipes -->
_A recipe is a model and the place it runs. Pick one, adjust its settings in the panel, and forget about node graphs._

![Settings, the Recipes section: the shipped recipes with the provider each runs on, and the button to import a ComfyUI workflow as a recipe](https://www.denrakeiw.com/projects/scumble/manual/recipes.jpg "1600x946")

A recipe is Scumble's answer to the node graph. It names a model — "FLUX.2 \[max\]", "Nano Banana 2", "Upscale model (ComfyUI)" — and, for models that several services host, the provider it should go to. Picking one from the top bar is the whole configuration; the settings the model actually has (steps, guidance, seed, resolution) appear in the Settings panel of the Generate tab, with sensible defaults.

Local recipes are ComfyUI workflows in API format with an Inpaint Canvas node in them. The shipped ones cover FLUX.2 Klein, SDXL inpainting, Qwen Image Edit and an upscale-model chain. You can import your own: Settings › Recipes, Import, pick your exported workflow. If it holds an Inpaint Canvas node, Scumble fills that node with your canvas and queues the rest exactly as you built it.

Provider recipes go out over HTTPS with your key. Scumble crops the selection with context, sends it at a size the provider really accepts — the Highres fix setting picks the tier — and stitches the answer back at full resolution with the surrounding pixels preserved. Models that take a mask get one; models that do not get an instruction edit and Scumble's own composite mask does the blending afterwards. Reference layers are sent along for the models that take references.

Generate new makes the base picture from the prompt alone, locally or through a provider, when you want to start from nothing rather than from a photo. And prompt upsampling turns a short prompt into a long one through a language model — your own key, an OpenRouter or ToAPIs key, or a local Ollama or LM Studio that needs no key at all. Your own prompt-writing rules can be stored as Markdown templates, so upsampling follows your house style and not a generic one.

### Notes

- Recipes are files. Copy a shipped one, change the model id or a default, and it appears in your picker alongside the originals.
- The seed field has a dice next to it, and the status line keeps the seed of every run, so a result you liked can be repeated.
- An API run's real size is shown before it goes out. Providers charge per picture, and a larger tier can cost more.
- Cost and privacy per provider — who hosts the model, in which region, what they keep — are listed in docs/RECIPES.md in the repository.

## Layers, masks and colour match

<!-- slug: layers -->
_Every result is a layer. Nothing is baked in until you flatten, and the one slider that makes results fit._

![The layer stack with the generated result on top, its row expanded to show opacity, the Match slider, the blend mode and the cut-out row](https://www.denrakeiw.com/projects/scumble/manual/layers.jpg "1600x946")

Scumble is a layered editor that happens to generate, not a generator with an undo button. Every result, every paint stroke, every piece of text and every filter is a layer with an opacity, a blend mode, a mask and a name. You can reorder them, duplicate them, merge them down, hide them, erase into them and copy them between tabs. Flatten is a command you give, not something that happens to you.

Colour match is the feature I would keep if I had to throw the rest away. A generated patch almost always comes back a little off: a shade cooler, a touch brighter, a different contrast to its surroundings. The Match slider in the layer row corrects that by matching the layer's statistics to what lies around it — or to what lies below it, your choice in the same row — and it is non-destructive, so you can move it any time.

Masks do the rest of the fitting. Every layer can have one, painted with the normal brush; erasing into a result layer with the eraser writes the mask, not the pixels, so an over-eager erase is one Ctrl+Z away. For photographic repairs there are clone, heal and smudge tools that work like the ones you know.

Around all this sit transform (move, scale, rotate, flip, with a perspective mesh), crop, and extend canvas — which is how outpainting starts: extend the canvas, select the new empty part, prompt, generate.

### Notes

- Blend modes: the usual eight, computed in the compositor with a single rounding per channel, so a stack looks the same on screen as it does in the exported file.
- Layer names can be renamed by double-clicking them, and a rename is an undo step like anything else.
- Copy and paste move whole layers between tabs, pixels, mask and settings included.
- SVG files can be loaded as layers, and PSD or ORA files arrive with their own layers since 0.1.25.

## Filter layers and the film pack

<!-- slug: filters -->
_Grain, curves, LUTs and a film look, all as layers you can switch off again._

![The same picture under a Kodak Portra 400 film look and a vignette, both as filter layers, the look's sliders open in the layer row](https://www.denrakeiw.com/projects/scumble/manual/filters.jpg "1600x946")

A filter in Scumble is a layer, not a one-way change to your pixels. Add one and everything below it is filtered; drag it up or down and it filters more or less; set its opacity, give it a mask, or switch it off. Its settings stay editable a week later.

The built-in set covers the photographic basics: grain with film presets, curves, levels, colour balance, HSL, exposure and contrast, sharpen, blur, normalise, vignette, and LUTs from .cube files. They run on the GPU through WebGL2, so they stay interactive on large pictures, with a processor path as a fallback.

The film pack is a plugin that ships with the app and goes further: film looks with real film names, halation, glow, bleach bypass, cross processing, split toning, light leaks, frames, and control points that steer a look locally. The names are there so you know what a look is after; the values are Scumble's own approximations, not licensed manufacturer data, and the tooltip and the About dialog say so.

### Notes

- A filter layer over an inpaint result is often the cheapest way to make the result belong: one grain layer over everything hides a lot of difference in texture.
- LUTs: drop a .cube file into the LUT filter and it is applied at full precision, with a strength slider.
- Filters render in tiles on large documents, so a 15,000 pixel picture does not stall the window.

## Text, shapes, brushes and 3D objects

<!-- slug: text-shapes-objects -->
_The smaller tools: editable text layers, vector shapes, Photoshop brushes, and .glb models placed into the picture._

![A text layer over the picture, its font, size, colour and outline editable in the layer row](https://www.denrakeiw.com/projects/scumble/manual/text-shapes-objects.jpg "1600x946")

Text is a layer that stays text: font, size, colour, spacing, alignment and a few effects, editable after the fact, exported into PSD as its own layer. The bundled fonts are open-licensed, and the ones installed on your system are offered too.

The shape tool draws rectangles, ellipses, polygons, Bezier paths and freehand paths, filled, outlined or both, with a corner radius, clipped to the selection if there is one. Each shape is one undo step.

Brushes can be loaded from Photoshop .abr files, which means the brush set you already own works here for painting and for masking.

And there are 3D objects: drop a .glb file in, and it is placed into the picture as a layer you can rotate, scale and light. It is a niche feature with a clear use — a product, a prop or a reference shape put into a scene in the right perspective before you let a model paint over it.

### Notes

- Everything here is a normal layer: blend mode, opacity, mask, and a place in the stack.
- A shape or a text layer makes a good mask source: draw it, then Select from layer.

## Upscaling

<!-- slug: upscale -->
_Make the selection sharper, or the whole picture bigger, through a provider or your own upscale models._

![The Upscale dialog: the model, the choice between the selection and the whole picture, and the factor](https://www.denrakeiw.com/projects/scumble/manual/upscale.jpg "1600x946")

The Upscale button sits next to Generate new and opens a small dialog: which upscaler, then the selection or the whole picture, then the factor. Which of the two you pick changes what happens more than it sounds.

The selection goes out at its own size and comes back sharper at the document's resolution — a detail pass on a face, a label, a piece of texture, landing as a layer like any other result. The whole picture goes out alone and the answer becomes the new base: the document is resized, layers, masks and the selection scale with it, and that is one undo step.

Through a provider you get Topaz (Precision, Bloom, Wonder), Clarity, SeedVR2, Recraft and Magnific (Precision and Creative), each on its own key or through fal. Times differ wildly and the status line warns you about the slow ones — Magnific Precision took five minutes for a small box in my own test, Topaz about twenty-five seconds for the same kind of job.

On your own ComfyUI, the Upscale model recipe runs any model in your server's upscale\_models folder — ESRGAN, UltraSharp, DAT, whatever you have. That route works on the selection only. Two of the upscalers, Clarity and Magnific Creative, also take a prompt; since 0.1.27 the dialog shows a prompt field for those, filled from the Generate tab but sent separately.

### Notes

- Upscaling the whole picture has a ceiling: the document can go to 65,535 pixels a side and about a gigapixel, and a factor that would pass it is refused before it costs you anything.
- An upscale of the selection is a layer, so it can be masked back in partly — often nicer than a uniformly sharpened picture.

## Saving, exporting and where your files live

<!-- slug: export -->
_PNG, JPEG, WebP, PSD and ORA with layers, the AI label, tabs that come back, and the folder that holds it all._

![The Export panel with PSD chosen, next to the size and canvas fields and the buttons for a single layer or the mask](https://www.denrakeiw.com/projects/scumble/manual/export.jpg "1600x946")

Ctrl+S saves the visible picture. The Export panel does the rest: PNG, JPEG or WebP for a flat result, PSD or OpenRaster when you want the layers, masks and selections to survive into Photoshop, Krita or GIMP. You can export at a percentage, at a pixel size, or into a frame of a given size with a background of your choosing, and a single layer or the mask on its own.

The AI label panel writes the EU AI Act's disclosure into the file's metadata, for the day you need to say in the file itself that a model was involved.

Every document is a tab, and tabs come back. The session is autosaved and restored at the next start, with no server needed for it, because every image the editor sends or receives is kept locally under %APPDATA%/Scumble/files/ in folders that mirror ComfyUI's own input and output. That is also why a restarted or freshly rented ComfyUI just works: before a run the app uploads what the server does not have.

### Notes

- Large PNGs beyond the browser's canvas limit — up to 65,535 px a side — are opened and written in strips, so they do not need to fit into one canvas.
- PSD export keeps layer names with umlauts and other non-ASCII letters since 0.1.25; before that they became underscores.
- The export runs in worker threads, so the window stays usable while a 15,000 pixel PSD is being written.

## The assistant

<!-- slug: assistant -->
_A chat column that drives the editor for you — on your key, with a card per step, and a question before anything costs money._

![The assistant panel open beside the canvas, with the model picker, the chat list and the input field](https://www.denrakeiw.com/projects/scumble/manual/assistant.jpg "1600x946")

Ctrl+Shift+A opens a chat column next to the canvas. Tell it what you want — "remove the bollard on the left and match it to its surroundings" — and it does it by calling the same commands an external agent would: select, prompt, generate, match, layer by layer. Every call is a card you can open to see exactly what it did.

It runs on your own API key. Anthropic, OpenAI and Google directly, or anything OpenAI-compatible: OpenRouter, DeepSeek, Moonshot, Z.ai, ToAPIs, WaveSpeed, or a local server that needs no key at all. The picker groups models by provider and greys out the ones you have no key for. Your own model ids can be added in Settings › Language models, so a model released after this version of Scumble still works.

It asks before it does anything expensive or irreversible: generating, upscaling, selecting by text, anything that queues on your ComfyUI or costs a provider call, anything that clears the undo stack, anything that touches a layer that is not its own. The question card shows the reason, the file, the recipe and the old and new values, and neither button is the default one.

And it can be taken back. Ctrl+Z undoes its steps one at a time like your own, and Undo this turn puts every document the turn touched back to where it was before — even when the turn was longer than the undo stack. Chats are saved with their screenshots and can be reopened; Settings › Assistant deletes everything it ever stored, your keys excepted.

### Notes

- Screenshots: the assistant looks at your picture to judge its own work, so parts of your image go to the model provider you picked. docs/ASSISTANT.md lists per provider where that is and what they say they keep.
- It costs what the model costs, and the panel shows the running cost of the chat.
- Read-only questions ("what layers are there?") do not ask and do not change anything.

## Help: this manual in the app, and a chat on it

<!-- slug: help -->
_F1 opens this manual beside the picture, searchable and offline, and with any API key a chat that answers from it._

![The Help column beside the picture: the search field, the model picker set to Gemini 3.8 Flash, the question how to take a part out of a selection and its answer with a link to the chapter it came from, and the manual's contents below](https://www.denrakeiw.com/projects/scumble/manual/help.jpg "1600x946")

F1, the Help button in the top bar or Help › Scumble help opens this manual in a column beside the canvas. It is the same text as on the website, shipped with the app, so it works offline and describes the version you are running. Type into the search field and the chapters narrow down to the ones that mention every word you typed, with the words marked; Enter jumps to the first of them.

Above the manual sits a chat. Ask it how to do something, "how do I take a piece out of a selection?", and it answers from this manual and from nothing else, and ends with the chapter it took the answer from; a click on that line opens the chapter. When the manual does not cover a question, it is told to say so and point you to the docs on GitHub instead of inventing a menu item.

The chat runs on any model you have a key for, including small text-only ones: it needs no eyes and no tools. It cannot change anything in the app, which is the assistant's job (Ctrl+Shift+A). Without any key the panel is simply the manual.

### Steps

1. **Open it.** F1, the Help button, or Help › Scumble help. F1 or Escape closes it again.
2. **Search.** Type a word or two. Enter jumps to the first chapter that has them all; Escape clears the search.
3. **Ask.** Pick a model, type the question and press Enter. New chat starts over.

### Notes

- What goes to the provider: your question and this manual, about 10,000 tokens. With a small model through OpenRouter that came to about one cent a question when it was measured; providers that cache prompts charge less for the manual from the second question of a chat on. No picture, no file, no setting.
- New in 0.1.27. Earlier versions had only a link to a README on GitHub in the Help menu.
- The chat is not saved: New chat or closing the app ends it.
- The answer is only as good as the manual. If it says something the app does not do, the manual is wrong; please report it.

## Agents, plugins and the command core

<!-- slug: agents-plugins -->
_Every feature is a command, the commands are an MCP server, and plugins can add more of them._

![Settings, the Plugins section: the built-in plugins with what each one adds to the app](https://www.denrakeiw.com/projects/scumble/manual/agents-plugins.jpg "1600x946")

Underneath the interface, everything the editor can do is a named command with documented parameters. The assistant uses them. So can you: Help › Copy MCP registration puts the line for your MCP client on the clipboard, and after that Claude Code, Claude Desktop or any other MCP client drives Scumble directly — open a picture, select the handbag, generate, export. For scripts there are --headless and --cmd, which run the app without a window.

Plugins are JavaScript. A plugin folder with a plugin.json can add filters (with a GPU and a processor path), panels, menu actions, tools and commands of its own. The film pack, the 3D object tool and the AI label panel are plugins themselves, which is the honest test of whether an extension point is good enough.

The same editor also lives on as the ComfyUI node Inpaint Canvas, built from this repository. If you work inside ComfyUI, you get the same canvas there.

### Notes

- The full command list with parameters is docs/COMMANDS.md; the MCP details are docs/MCP.md; plugins are docs/PLUGINS.md.
- Only one instance of Scumble runs at a time, headless ones included — a stuck headless instance will keep the window from opening.

## Large pictures

<!-- slug: large-pictures -->
_Why a 15,000 pixel document still paints at full speed, and the one setting behind it._

![Settings, the Rendering section: the tile engine switch and the memory limits, with the live reading of what the GPU process holds](https://www.denrakeiw.com/projects/scumble/manual/large-pictures.jpg "1600x946")

Scumble keeps the picture, every layer and every mask in tiles rather than in one big canvas, and the pixel work — flood fill, grow and shrink, blur, blending, the match — runs as compiled Rust in worker threads. That is the reason a 15,000 by 10,000 document paints, selects, filters and exports without the window locking up, and why export and selection work happens off the main thread.

The tile engine is on by default. Settings › Rendering has the switch back to the old canvas path, which exists as an escape hatch if something ever looks wrong on your hardware; the app is slower and hungrier that way, but it is there.

Above the browser's canvas limit — beyond about 268 megapixels — pictures are opened and written in strips instead, which is how PNGs up to 65,535 pixels a side and about a gigapixel work at all.

### Notes

- Big documents want memory more than speed. Several open 15k tabs will show in the task manager.
- If something draws wrong, the first useful test is the Rendering switch: the two paths are the same picture by design, and a difference between them is a bug worth reporting.

## Under the hood: the crop, the Highres fix and the stitch

<!-- slug: under-the-hood -->
_What actually happens between pressing Generate and the layer arriving — and which knob to turn when it comes back soft, or too expensive._

Every inpainting model has a size it works at, and it is small: around one megapixel, four at the very top end. Your picture is not. A 6000 by 4000 photo is 24 megapixels, and the thing you selected in it might be 300 pixels across. That gap is the whole problem of inpainting at photo resolution, and everything in this chapter exists to close it.

The naive answer — scale the picture down, let the model paint, scale it back up — ruins everything outside the selection and gives you a soft patch inside it. Scumble does the other thing: it cuts a box around your selection, sends only that, and puts the answer back at the document's own resolution. Nothing outside the box is ever touched, because nothing outside the box ever leaves your machine.

The box is not the selection. Around it goes context — the surroundings the model needs to match light, texture and perspective — and Scumble works out how much from the selection's own size: roughly a tenth of its diagonal as the feather, a little more as padding, and never a box smaller than 512 pixels. A tiny selection therefore still goes out as a workable picture instead of a postage stamp. You can override all of it in the Crop panel, and Context is the one worth touching: too little and the model has nothing to match, too much and your selection becomes a detail the model stops caring about.

Then comes the part with the odd name. The box gets sent at the size the chosen model actually takes, and that is usually larger than the box's own pixels. Select a 300-pixel bag in a photo and the crop goes out at 1440 or 2048 or 3840, depending on the model: the model paints far more detail than that area of your picture holds, and the answer is scaled back down into the box. The detail survives the scaling down; it would not have survived being invented at 300 pixels. That is the Highres fix, and it is why an inpaint in a big photo does not come back looking like a blurred sticker.

The Highres fix select in the Generate tab decides how far to push it. Maximum, the default, uses everything the model allows. 2x crop and 4x crop send the box at twice or four times its own resolution, still under the model's ceiling — cheaper, faster, and enough when the selection is already large. Target size keeps the number in the node parameters, and Off sends the crop exactly as it is. The ceiling itself is not a guess: every provider variant carries the size rules of its endpoint, the longest side, the rounding step, the smallest side, a pixel budget and a floor, and a crop steeper than the model's allowed aspect gets more context on its short side rather than being refused.

Coming back, the answer is scaled to the box and blended in, not pasted. Scumble builds a composite mask from your selection — grown by a few pixels, then blurred by the feather — so the patch writes at full strength in the middle, fades out at the edge and does not touch a pixel you did not select. This matters most for the models that take no mask at all: GPT Image, Nano Banana, FLUX.2, Seedream and the rest get the crop and an instruction, they hand back a whole repainted box, and it is this mask that keeps the repaint inside your selection. Then colour match runs if it is on, matching the patch's per-channel mean and spread to the ring of picture around it, and the result lands as a layer at the box's position at full resolution.

On your own ComfyUI none of the size machinery applies: there the Inpaint Canvas node does the cropping and stitching on the server, the recipe's Target size rules, and the app sends the canvas and the mask rather than a finished crop.

### Notes

- Result soft or short on detail? Raise the Highres fix, or select a smaller area — a smaller selection means a smaller box, and a smaller box at the same ceiling means more pixels per millimetre of picture.
- Run too expensive or too slow? Lower it. Providers charge by the size that goes out, and 2x crop is often indistinguishable from Maximum on a selection that is already big.
- Edge of the patch visible? More feather in the Crop panel, and check colour match before blaming the model.
- The model repainted things outside what you selected? It cannot have — what you see is inside the composite mask. Select more tightly, or feather less.
- Scumble's crop and stitch are a port of the node's own maths, with three honest differences: the browser resizes bilinearly where the node uses Lanczos, the blur is a triple box blur rather than a true gaussian, and the node's ECC alignment of the answer to its surroundings is not implemented here.
- On a large document the crop and the stitch run in worker threads, so the window does not freeze while a 15,000 pixel picture has a box cut out of it and put back.

## Keyboard shortcuts

<!-- slug: shortcuts -->
_Every key the editor listens to, in one list. Ctrl is Cmd on a Mac._

Scumble is built to be used with one hand on the keyboard. A tool is one letter, the brush size is two brackets, and the things you do a hundred times a day — undo, deselect, fit the view, generate — are one chord each. Nothing here has to be learned first; the status line under the canvas says what the current tool does.

Two of them are worth knowing before the rest. Hold the backslash key to peek at the picture underneath everything you have added, which is how you judge a result in a second. And press F to fit the picture back into the window when you have zoomed yourself into a corner.

### Keys

#### Tools

| Key | What it does |
| --- | --- |
| B | Selection brush — paint the area, Alt subtracts |
| R  ·  Shift+R | Rectangle · ellipse |
| L  ·  Shift+L | Lasso · polygon |
| W | Magic wand |
| O | Object hover (SAM2 in the app) |
| D | Deselect tool — drag over a selection to take it away |
| Q | Quick mask |
| P  ·  E | Paint · erase |
| S  ·  Shift+S  ·  J | Clone · smudge · heal |
| G  ·  Shift+G | Bucket fill · gradient |
| Y | Shape tool |
| T  ·  Shift+T | Transform · text |
| C | Canvas frame — drag out to extend, in to crop |
| H  ·  I | Hand · eyedropper |

#### View

| Key | What it does |
| --- | --- |
| F | Fit the picture into the window |
| 1 | Zoom to 100 % |
| Wheel | Zoom around the pointer |
| Space + drag | Pan (the middle mouse button does it too) |
| 4  ·  6  ·  5 | Rotate the view 15° left · right · back to straight |
| \\ (hold) | Peek at the base picture under every layer |
| Ctrl+Shift+R  ·  Ctrl+Shift+G | Rulers · grid |

#### Selection

| Key | What it does |
| --- | --- |
| Ctrl+D | Deselect everything |
| Ctrl+I | Invert the selection |
| Shift+F | Fill the selection with the foreground colour |
| Delete  ·  Backspace | Clear the selected pixels — with nothing selected, delete the layer |

#### Layers and editing

| Key | What it does |
| --- | --- |
| Ctrl+Z  ·  Ctrl+Shift+Z | Undo · redo (Ctrl+Y works too) |
| \[  ·  \] | Brush smaller · larger |
| Ctrl+\[  ·  Ctrl+\] | Move the layer down · up the stack |
| Ctrl+Shift+N | New paint layer |
| Ctrl+J  ·  Ctrl+E | Duplicate the layer · merge it down |
| Ctrl+C  ·  Ctrl+Shift+C | Copy the selection · copy it merged |
| Ctrl+X  ·  Ctrl+V | Cut · paste (also between tabs) |
| Arrow keys | With the transform tool: nudge the layer by 1 px, with Shift by 10 |

#### Generating

| Key | What it does |
| --- | --- |
| Ctrl+Enter | Generate |
| Ctrl+U | Upsample the prompt with a language model |
| Escape | Cancel what is running, or drop what is pending |
| Enter | Apply what is pending: a transform, a polygon, a shape, the canvas frame |

#### The app

| Key | What it does |
| --- | --- |
| Ctrl+O  ·  Ctrl+S | Open an image · save the visible picture |
| Ctrl+T  ·  Ctrl+W | New tab · close tab |
| Ctrl+Tab  ·  Ctrl+Shift+Tab | Next tab · previous tab |
| Ctrl+, | Settings |
| F1 | This manual, and the chat on it |
| Ctrl+Shift+A | The assistant |
| Ctrl+Shift+L | The console and the log |
| F11 | Full screen |

### Notes

- On macOS every Ctrl here is Cmd.
- A shortcut does nothing while you are typing in a field — the editor only listens when the canvas has the focus.
- Plugins can add shortcuts of their own; the Plugins menu shows what each one bound.

## Settings, updates and when something goes wrong

<!-- slug: settings-and-trouble -->
_What is in the settings dialog, how updates work, and the three things to check before reporting a bug._

![The console window over the editor, with the filter by level and text and the path of the log file](https://www.denrakeiw.com/projects/scumble/manual/settings-and-trouble.jpg "1600x946")

Ctrl+, opens the settings: the ComfyUI server and its authentication, API providers, language models, recipes, helper models, the assistant, plugins, local files, rendering and updates. Most of it you set once.

Updates come from GitHub releases. The app checks, downloads, and shows you the release notes before you restart into the new version. Nothing is installed while you are working.

When something misbehaves: Ctrl+Shift+L opens the log, which is also written to a file. The status line under the canvas carries the last thing that happened, including the reason a run was refused — a missing key, a server that did not answer, a size a provider would not take. And the changelog says what changed in the version you are on, which is often the answer by itself.

Scumble is at 0.1.x and it says so. Not every path has been tested end to end; the API providers in particular are written from their documentation and only some have run against the live service. Keep backups of pictures you care about, and report what breaks in the issues — a bug with a picture and a version number attached is a bug that gets fixed.

### Notes

- Keys are never written into a settings file, so a settings file you share holds no secrets — but check anything you paste from the log before you post it.
- Issues: github.com/DenRakEiw/scumble/issues. The version is in the About dialog and in the log's first line.
