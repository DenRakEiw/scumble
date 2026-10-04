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

The app alone can do a great deal — open, paint, select, layer, filter, save, export — but it generates nothing until it has somewhere to render. That is the next chapter.

### Steps

1. **Download.** Scumble Setup \<version\>.exe from the latest release. On Linux: the .AppImage (chmod +x, start it) or the .deb.
2. **Run it.** More info, then Run anyway, when SmartScreen asks. The app installs per user, no admin rights needed.
3. **Start it.** First start opens an empty tab. Nothing is configured yet and nothing has to be.

### Notes

- Windows 10 and 11, 64-bit. A GPU is not required for the editor itself: filters run on the GPU when there is one and fall back to the processor when there is not.
- The installer is about 128 MB, the installed app about 410 MB, most of which is Chromium and the helper models' runtime.
- Updates: when a new version is downloaded, Scumble asks once whether to restart into it now, later (it is installed when you close Scumble) or not for this version. Settings › Updates shows everything that changed.

## Where it renders: your ComfyUI, or an API key

<!-- slug: rendering-and-keys -->
_The one decision to make before the first generate — and how to store a key so it is not lying in a config file._

![Settings, the API providers section: one row per provider with its key field, Save and Clear, and a note under each saying whether a key is stored](https://www.denrakeiw.com/projects/scumble/manual/rendering-and-keys.jpg "1600x946")

Scumble does not generate anything itself. It sends your selection somewhere and puts the answer back as a layer. That somewhere is either your own ComfyUI, or a model provider you have an API key for. You can have both and switch per run; the recipe picker in the top bar decides which one a run uses.

Your own ComfyUI is free to run, keeps every pixel on your machine, and gives you the models you already downloaded. It needs the node pack ComfyUI-InpaintCanvas installed there, and the models the recipe asks for. Type the server's address into the top bar — http://127.0.0.1:8188 for a local one, or the address of a rented box, RunPod included — and press Connect. If the node pack is missing, Scumble notices and offers to install it through the ComfyUI Manager.

An API provider needs no server at all. Put a key into Settings › API providers and the models behind it appear in the recipe picker: Google's Nano Banana, OpenAI's GPT Image, Black Forest Labs' FLUX.2 and FLUX 3 Image, ByteDance's Seedream, Qwen Image Edit, and the same models through aggregators like fal.ai, Replicate, WaveSpeedAI, ToAPIs, Comfy Cloud, Comfy Router, OpenRouter and Oxen.ai. You pay that provider directly; Scumble takes no cut and sees no invoice. Comfy Router has no key row of its own: it runs on the Comfy Cloud key, with credits and without a paid Comfy plan. The same key runs HY Image 3.5 through Comfy's Partner API.

Keys are stored in the operating system's own credential store through Electron's safeStorage, never in a settings file you might share by accident. On Linux that is the desktop keyring; if the system has none, the settings say so in plain words rather than pretending the key is encrypted when it is only obfuscated.

The same key rows also feed two other things: the assistant, and prompt upsampling. If you already have an OpenRouter or an Oxen.ai key, one key covers a lot of ground at once.

### Steps

1. **For a local ComfyUI.** Install the ComfyUI-InpaintCanvas node pack there, start ComfyUI, type its address in the top bar, press Connect. The dot goes green.
2. **For an API provider.** Ctrl+, → API providers, paste the key into its row, Save. No restart, no connection needed.
3. **Pick what a run uses.** The recipe dropdown in the top bar lists every recipe you can actually run: local recipes when a server is connected, provider recipes when their key is there.

### Notes

- A provider recipe with no key is shown greyed out with the reason, not hidden — so you can see what would be available.
- A remote ComfyUI behind basic auth or a token: the fields are in Settings › ComfyUI, and the app proxies everything through its own origin, so images from the server never taint the canvas.
- Nothing is uploaded to a provider until you press Generate. Opening, painting, selecting, filtering, saving and exporting all happen on your machine.

## Your first edit

<!-- slug: first-edit -->
_Open a picture, select something, describe what should be there instead, generate. The whole loop in one page._

![The picture open, the handbag selected with marching ants and the crop box around it, the Generate tab on the right with the prompt typed in](https://www.denrakeiw.com/projects/scumble/manual/first-edit.jpg "1600x946")

The loop is always the same, whatever the model behind it: select an area, write what should be in it, press Generate. What comes back is a layer sitting over the selection, not a new picture — which is the point of the whole app. If you do not like it, you delete the layer and the original is untouched underneath.

Open a picture with Ctrl+O, by dropping it on the window, or by pasting from the clipboard. PNG, JPEG, WebP and TIFF, and since 0.1.25 also PSD and ORA files with their layers intact; a .scumble document you saved earlier opens the same way. Then paint over the thing you want changed with the selection brush — the default tool, size with the bracket keys, Alt to erase what you painted too much of.

The prompt goes into the Generate tab on the right. Describe what should be in the selected area, not what is there now: "a red leather handbag" and not "change the bag to red leather". Then Generate, or Ctrl+Enter. A run on a local ComfyUI takes as long as your card needs; an API run is usually ten to thirty seconds. While it runs you can keep working, even in another tab.

The result arrives as a layer over the selection, and the layer row has a Match slider. That slider is the small feature that saves most results: it matches the colours of the generated patch to what surrounds it, so the piece stops looking pasted in. Start at 100 %, pull it back when the model's own tone is worth keeping.

Happy with it? Ctrl+Shift+E exports the visible picture, and Ctrl+S keeps the whole document, every layer still editable, as a .scumble file. Not happy? Press Generate again — a new seed, a new layer, and you can compare the two by toggling their eyes.

### Steps

1. **Open.** Ctrl+O, or drop a file on the window, or Ctrl+V a picture from the clipboard.
2. **Select.** Paint over the area with the selection brush. \[ and \] change the size, Alt subtracts.
3. **Prompt.** Generate tab on the right: describe what should be there. Leave it empty for a pure cleanup with an inpainting model.
4. **Generate.** Ctrl+Enter. The status line says where it runs and how long it has been running.
5. **Blend.** In the new layer's row, pull Match up until the patch sits in the picture.
6. **Save.** Ctrl+S saves the document as a .scumble file you can come back to. Ctrl+Shift+E exports the picture in the format the Export panel is set to: PNG, JPEG, WebP or TIFF, or PSD and ORA with all layers.

### Notes

- Feather the selection by a few pixels (Selection panel) before a generate and the edge gets easier for both the model and the stitch.
- Every document is a tab: Ctrl+T new, Ctrl+W close, Ctrl+Shift+T reopen the last one closed, Ctrl+Tab next. A run keeps going while another tab is in front.
- Ctrl+Z is a real undo stack, not a single step, and it covers the assistant's work too. The **Undo history** section of the Image tab lists every step by name, oldest first; a click on a row jumps there, and the rows below the highlighted one are what redo brings back. **Snapshot** keeps the whole document under a name (up to eight per tab, not saved with the file), and Restore puts it back as one undo step. How many steps are kept is set under Settings › Rendering (30 steps, 384 MB by default).

## Selecting: brush, shapes, wand, objects, words

<!-- slug: selection -->
_Seven ways to say which part of the picture you mean, and what to do with the selection once you have one._

![The handbag outlined exactly by the in-app SAM2 model after one click, with the status line reporting 97 objects found in 3.3 seconds](https://www.denrakeiw.com/projects/scumble/manual/selection.jpg "1600x946")

The selection is the most important thing in an inpainting editor, so Scumble gives it seven routes. The brush is the honest one: paint, Alt to subtract, done. Rectangle, ellipse and lasso are there for the shapes that painting gets wrong. The magic wand takes everything of a similar colour from where you clicked, which is what you want for skies and flat backgrounds.

Object hover is the one people like: move the pointer over the picture and Scumble outlines the object under it, click to select it. That is SAM2 running inside the app through ONNX Runtime, on your GPU on Windows and on the processor on Linux. Nothing leaves your machine, and the model file is downloaded once or read from a ComfyUI models folder you point at.

Selection by text is the other one: type "the handbag" or "her sunglasses" into the Selection panel and press Go. That route runs on your connected ComfyUI (SAM3 there), so it needs a server, unlike object hover.

Once you have a selection, the Selection panel does the rest: grow and shrink it by a pixel count, feather its edge, invert it, take it from a layer's transparency, or save it under a name to come back to later. Selections survive a restart with the document, and the selection and the saved ones travel in its .scumble file.

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

Local recipes are ComfyUI workflows in API format with an Inpaint Canvas node in them. The shipped ones cover FLUX.2 Klein, Qwen Image Edit 2.1 and an upscale-model chain, plus the Realism Pass (Windows only, RTX only), which has a chapter of its own. You can import your own: Settings › Recipes, Import, pick your exported workflow. If it holds an Inpaint Canvas node, Scumble fills that node with your canvas and queues the rest exactly as you built it.

Provider recipes go out over HTTPS with your key. Scumble crops the selection with context, sends it at a size the provider really accepts — the Highres fix setting picks the tier — and stitches the answer back at full resolution with the surrounding pixels preserved. Models that take a mask get one; models that do not get an instruction edit and Scumble's own composite mask does the blending afterwards. Reference layers are sent along for the models that take references; the next chapter shows how to name them in the prompt.

FLUX 3 Image, on your Black Forest Labs key, or through OpenRouter, Comfy Router, fal.ai, Oxen.ai or WaveSpeedAI on their keys, edits the crop by instruction with up to nine more pictures (the Original and your reference layers), and in Generate new it takes up to ten reference images. It takes no pixel size: Scumble widens the crop to one of the model's fifteen shapes and picks a size class from it, 1k or 2k for an edit and up to 4k for a new picture (the larger class costs more); it has no seed, so two runs of the same prompt differ. The recipe's Settings have a Grounding switch, on by default, that lets the model search the web and images for what the prompt names before it renders; turn it off to keep your prompt away from search. On OpenRouter the switch is missing: grounding stays at Black Forest Labs' default, on. On fal.ai it is missing too, each picture may have at most 4 megapixels (Scumble scales a larger reference layer down) and there are fourteen shapes, without the tallest; a *Prompt expansion* switch there, on by default, lets the model rewrite your prompt before it renders, as Black Forest Labs' own API always does. On Oxen.ai the Grounding switch is there and on by default, as on Black Forest Labs' own API (Oxen's own default is off), and Oxen keeps every picture it makes in your Oxen account. WaveSpeedAI takes the same 4 megapixels and fourteen shapes as fal.ai and has the same *Prompt expansion* switch, but neither Grounding nor Safety tolerance. The model also takes boxes in the prompt that say where things go, your selection among them: the *Boxes* switch under the prompt field turns them on, as *Boxes in the prompt* below explains.

Ideogram 4.5, on your Replicate token, your WaveSpeed key or Comfy Router (the Comfy Cloud key), repaints only what you selected: the selection goes as the model's mask, the answer comes back at the crop's own size, and what the edit leaves alone stays as it was. It is strong at lettering. Up to three more pictures go along (the Original and your reference layers); the model takes them without a number, so the prompt cannot name them with @img1, and a run whose prompt names one stops before anything is sent. It takes no picture steeper than 6:1, so a very narrow selection goes with more of its surroundings. *Quality* in the recipe's Settings (very_low, low, medium, high; medium by default) also sets the price per picture. On WaveSpeed, *Edit precision* high, the default, keeps the unchanged pixels, and no seed goes there, so two runs of the same prompt differ; Replicate and Comfy Router take the seed. Generate new makes a picture from the prompt alone, at the closest of the model's shapes and sizes. The recipe was written from the three providers' documentation and has not run against them yet.

The recipe **LaMa remove (in-app)** does what the Remove tool does, for a selection: select what should go, pick the recipe and press Generate. It runs the same model inside the app, offline and without a prompt, and its answer is stitched back like a provider's. It fills from the surroundings and never invents anything new; for that, use a model recipe.

Generate new makes a new base picture from the prompt, locally or through a provider, when you want to start from nothing rather than from a photo; Mystic, Magnific's own model, lives only there. The reference layers stay: the answer replaces the picture and every other layer, and the shown references go along to a model that takes reference images for a new image (FLUX.2, FLUX 3 Image, GPT Image, Nano Banana, Seedream and more). There is no crop before them, so @img1 goes out as image 1; references the prompt does not name go along too, and a hidden one stays in the tab without being sent. A model that makes pictures from the prompt alone sends none, keeps them in the tab, and stops the run when the prompt names one. On a local recipe they follow the white canvas the recipe renders on, so there @img1 is the second picture (the third when the Original goes too), as the dialog's chips show, and a token that cannot go, or a ComfyUI that is not connected, stops the run before the picture is replaced. Through a provider, the status line says which name each token went as and how many other layers were replaced. In an empty tab, a reference added through the prompt field (its +, the @ list, or a picture pasted or dropped on it) first gets a white 1024 × 1024 canvas, which Generate new then replaces. The dialog's prompt field works like the Generate tab's and starts with its prompt, with chips, the @ list and the bar above it: the card over each chip says what its reference goes out as for the model and provider picked in the dialog, and the + adds a reference to the tab.

Prompt upsampling turns a short prompt into a long one through a language model — your own key, an OpenRouter, Oxen.ai or ToAPIs key, or a local Ollama or LM Studio that needs no key at all. Your own prompt-writing rules can be stored as Markdown templates, so upsampling follows your house style and not a generic one. Upsampling keeps the @img tokens: the language model is told which reference each one names and that it has to leave them as they are, and a token that names no shown reference (a hidden or deleted layer, one that is no longer a reference, or a number no reference holds) stops the upsampling until you show or restore the layer or take the token out. When a rewrite drops a token, adds one or names a picture by number ("image 3") instead, the status line says so, and Revert brings your prompt back. Upsample in the Generate new dialog does the same, and there the note under the prompt says so, next to its own Revert. A template of your own gets the names too; {references} puts them where you want them. With an API model or a local endpoint, upsampling also shows the language model the reference images the prompt names (up to six), as small pictures of at most 512 pixels, so the rewrite knows what each token is; they then go to that model's provider as well. Settings › Prompt templates has the switch to keep them back. A model that takes one picture at a time is asked again with the picture being edited alone, and the status line says "crop only".

The *ComfyUI* button in the top bar (Ctrl+Shift+K, also View › ComfyUI) opens your ComfyUI's own page in a window of its own, from the address and auth under Settings › ComfyUI: a local install, a box in your network or a RunPod pod. ComfyUI's own shortcuts work there; Scumble's do not reach it. With no ComfyUI to show, the window says why and leads to the setting. Scumble needs no ComfyUI for anything else. While a ComfyUI recipe is selected, *Edit in ComfyUI* beside the recipe picker (also View › Edit Recipe in ComfyUI, and Settings › Recipes) opens that recipe's graph there, with the result and the Settings rows wired to the Inpaint Canvas node. Change the graph in ComfyUI, then *Save to recipe* in the window's bar writes it back (a shipped recipe becomes your own copy, which Settings › Recipes can remove again), or *Save as new recipe* keeps it under a new name; the editor selects the saved recipe, and it opens next time laid out as you left it. The window's *Show* picker switches to Comfy Cloud, where you sign in on its own page (email or GitHub; Google may refuse an app window); Comfy Cloud runs no custom nodes, so a recipe built on the Inpaint Canvas node opens on your own ComfyUI only. To run one there anyway, *Cloud copy* under Settings › Recipes makes a copy without the node, which runs on your Comfy Cloud key while Scumble crops and stitches; a workflow you built or opened on Comfy Cloud, one of Comfy's templates for one, becomes a recipe by *Save as new recipe* in the window (or by importing its exported file): Scumble reads which picture is the crop and where the prompt and the seed go, and the bar says what it read. If it reads one wrong, title the nodes for it ("Scumble crop", "Scumble prompt", "Scumble seed" and a few more). Comfy Cloud recipes have a mode of their own: pick *comfy cloud* in the mode picker next to Generate (beside *local* and *api*), and the recipe picker lists them alone; they run on Comfy Cloud with your Comfy Cloud key. Six come with Scumble, from Comfy's own image-edit templates: Boogu Image 0.1 Edit, Flux.2 Klein 9B base (one picture, or two: the crop and the Original or your first reference layer), Mage Flow Edit Turbo, Qwen Image 2.1 Edit and Qwen Image Edit 2509. Leave the negative prompt empty and the template's own negative stays. Before anything goes up, Scumble checks that Comfy Cloud has every node of the recipe's graph. When a run fails, the message also names any model file the graph uses that Comfy Cloud's list does not show, with a close name it does show where there is one (your own models on Comfy Cloud are not in that list, so they never stop a run). Generate new has a *Comfy Cloud* choice too, with Comfy's text-to-image templates: Anima base and preview, Flux.2 Klein 9B, Ideogram 4, Krea 2 Turbo, Mage Flow, Qwen Image 2.1 and Z-Image Turbo. Flux.2 dev comes as an edit recipe: it works from the selection.

### Notes

- While an API run waits, *Cancel* beside the timer in the title row stops it. Before anything is sent nothing goes out; after that Scumble stops waiting, and the provider may still finish the job and charge it.
- Recipes are files. Copy a shipped one, change the model id or a default, and it appears in your picker alongside the originals.
- The seed field has a dice next to it, and the status line keeps the seed of every run, so a result you liked can be repeated.
- An API run's real size is shown before it goes out. Providers charge per picture, and a larger tier can cost more.
- Cost and privacy per provider — who hosts the model, in which region, what they keep — are listed in docs/RECIPES.md in the repository.

## Reference images in the prompt

<!-- slug: references -->
_Name a reference layer in the prompt as @img1, and Scumble sends it under the name the model knows that picture by._

![The prompt field with two reference chips in the text, the bar above it saying 2 of 12 for this recipe, and the card over the second chip: the reference picture, its layer name and "img2 · sent as image 4"](https://www.denrakeiw.com/projects/scumble/manual/reference-prompt.jpg "1600x946")

A reference layer is a picture that goes to the model beside the one it edits and is not part of your image: add one with the button of the References list, a Shift+drop on the canvas or the + above the prompt, or set a layer's role to reference. The reference list and the canvas label each shown reference img1, img2 and so on from the top of the list; a new reference goes below the others and takes the next number, hiding one renumbers the rest, and the list's arrows or Ctrl+\[ and Ctrl+\] move a reference past the next one. Write @img1 in the prompt to name that picture: the prompt keeps following it when the list changes, and the request names it the way the chosen model counts its pictures (image 3, say, when the crop and the Original go first); the status line says which name each token went as. A token whose reference is hidden, deleted or no longer a reference waits for it and stops the run until you show the layer again, undo the delete, make the layer a reference again or take the token out. An upscale sends no reference pictures, so there a token goes as the layer's name; what Generate new does with them is in the chapter before. On a local ComfyUI recipe a token is written as the name that recipe's model reads for its picture (\<image3\> on Qwen Image Edit 2.1, image 3 on FLUX.2 Klein); the card over the chip and the References line at the foot of the Crop panel show it. A local recipe reads a limited number of pictures, the crop and the Original included (4 for Klein, 10 for Qwen Image Edit 2.1): a reference past that is left out with a note in the status line, and a token that names one stops the run and says why. A workflow of your own whose graph Scumble cannot follow gets the names by the pictures' place in the batch, and the status line says the wording is guessed.

In the prompt field each token shows as a chip: a small round picture of the reference and its label. A token whose reference is hidden shows struck through with the layer's name, one whose reference was deleted or is no longer a reference, or a number no reference holds, shows struck through in red; the card over the chip says why. A chip counts as one character: the caret steps over it, and Backspace or Delete takes it whole. A token becomes a chip once you type the space after it, so @img12 can be typed without a chip for @img1 on the way. A word typed right against a chip gets a space between the two, since @img1 only counts with one; type the space yourself and it steps over the one already there, and Backspace or Delete on such a space steps over it too. A click on a chip puts the caret beside it. The prompt field keeps its own undo: Ctrl+Z there takes back typing, a paste, Upsample, Revert or a prompt an agent set, and never an edit of the picture.

Type @ at the start of a word and a list of the shown references opens under the caret: a small picture, the label, the layer's name and the name the model gets the picture by. What you type after the @ narrows the list by label or name; the arrow keys move in it, Enter or Tab puts the chosen reference into the prompt, and Escape closes the list (a second Escape leaves the field). "+ Add reference" at the end of the list adds pictures as new reference layers and names them where the @ was. A picture pasted into the prompt, or dropped on it, becomes a reference layer the same way and is named where it came in; text still pastes as text.

Above the field a bar shows every reference as a chip, a hidden one dimmed with a crossed-out eye, then a + that adds pictures, and on the right how many reference images the chosen recipe takes, not counting the crop and the Original ("2 of 3 for this recipe" on FLUX.2 Klein on ComfyUI). A click on a chip in the bar names that reference at the caret; a hidden one cannot be named. A chip past what the recipe takes gets a yellow edge and the count turns yellow: through a provider such a run stops before anything is sent and says how many pictures the model takes, and on a local recipe that reference is left out. When the recipe sends no reference pictures at all (an upscale, say), the chips in the prompt are struck through, the bar's are dimmed, and the bar says "This recipe sends no reference images". Rest the mouse on a chip for a moment, in the text or in the bar, and a card shows a larger picture, the layer's name and what the token goes out as ("img2 · sent as image 3"), or why it does not go. The small arrow on a chip in the text opens a menu that swaps the token for another reference, shows a hidden reference again, or takes the token out of the prompt. A chip can be dragged to another place in the text, and a selection dragged inside the field moves there (hold Ctrl to copy it).

## Boxes in the prompt

<!-- slug: boxes -->
_Draw boxes on the picture and say what goes in each: the model gets them with the prompt and knows where things go._

Some models take, with the instruction, a table of boxes that says where things go: in Scumble FLUX 3 Image (on every provider it runs on) and Ideogram 4 on fal. The *Boxes* section of the Generate pane keeps such boxes with the document. Each row is one box: its name (lowercase words and a number joined by underscores, the way the model refers to it), what it does, a description, and its position in image pixels. *New* adds what the description says inside the box. *Keep* holds an element where it is. *Move* takes an element from its source box (From) to the new one (To). *Remove* takes an element out and fills the background. *From reference* places a reference layer, or a part of it, in the box. *Text* renders the words you give, the description saying how. A description may name a reference layer with @img1, as the prompt does. A new box is called box_1, box_2 and so on until you describe it; then it takes its name from the description: the last two words of its first phrase, so "a red scarf" makes red_scarf_1 and "a small black cat sitting in the grass" makes black_cat_1, and the model reads a name that means something. A name of your own (not box_1, edit_2 and the like), or one already made from a description, stays when the description changes, and so does a box_1 your prompt names as <box_1>.

With the boxes, a run writes a sentence for each box into the prompt, after your own words, that says what happens to it and where: "Place a red scarf <red_scarf_1> at the top left.", "Move the lamp <old_lamp_1> up and to the left, larger.", "Remove the cat <cat_1> at the bottom right.", "Keep the log <log_1> as it is." A description written as an instruction ("make the tiger pink") goes in as it is. A box your prompt already names as <red_scarf_1> gets no sentence, since you said it yourself. Your prompt always goes first, word for word; when it is the description of a box (as with the selection's box), that box's sentence only says where: "The change goes in <red_door_1> at the top left." When the prompt is empty or one box's description, the sentences end with "Leave the rest of the picture as it is."; a prompt of your own keeps the last word on the rest of the picture. *Copy rows* writes the same sentences. This is how FLUX 3 Image gets the boxes.

Ideogram 4 on fal gets them as its own structured caption instead: the whole prompt becomes a description of the picture, with your words as its summary and each box as an element in its place. A New box is an object, a Text box the words it renders (its description says how they look), a Keep box an element that stays where it is (on an edit). Ideogram's caption describes a picture rather than a change, so it has no Move, Remove or From reference: those boxes stay out of an Ideogram run, the Boxes section says so under an Ideogram recipe, and the status line names them after the run. While the boxes go, *Prompt expansion* goes as None whatever its row says, since an expansion would rewrite the caption; the status line says so. On a new image your prompt also describes the background, so write one: without it, the model tends to paint a transparency checkerboard around the boxes. Tried live: a red apple box and a Text box "SAUNA" in a meadow put the apple and the carved sign where the boxes were; a box placed somewhere a thing could not be (an apple floating in the sky of a meadow) was ignored for a more natural picture.

Whether boxes go with a run is one switch: *Boxes*, in a row of its own under the prompt field. It shows while the selected recipe takes boxes, and its label counts the document's boxes ("Boxes · 3"). On, Generate and Generate new send the document's boxes. With no boxes, Generate sends your selection as one box, and the row says "the selection goes as one box": the model is told where in the crop the change goes and what to put there (the prompt), or, when the prompt names a reference with @img1, that this reference goes into the box. Off, no box goes and the boxes stay with the document; the row says "not sent", and a run says in the status line how many boxes did not go. The switch is off in a new document and is saved with it. The first box a document gets, drawn with the tool, made with *Selection → box* or added by an agent, turns it on, and the status line says so; switching it off never deletes a box. Undo takes that first box back but leaves the switch on, so the next run sends the selection as one box; switch it off when you want neither. The status line says how many boxes went ("Sent with 1 box."), the log keeps the prompt as it went out, rows included, and a box under 48 pixels a side at the size the crop is sent at gets a note, the selection's and every other box that places something, since the model often leaves a box under about 40 pixels empty. A New box sent without a description gets a note too.

The *Boxes* tool (X, under Plugins in the tool column) draws them on the picture: drag on an empty place for a New box, click a box to select it (its row in the section lights up; a click on a row selects its box; where boxes lie on top of each other, the click takes the smallest), drag it to move it, drag one of its eight handles to resize it, and double-click it to type its description right on the picture (Enter keeps it, Shift+Enter starts a new line, Escape cancels; on a Text box it is the words; it goes into the prompt as words, never into the picture). Delete removes the selected box, D duplicates it, the arrow keys nudge it by a pixel (with Shift by ten), Escape lets go of it, and Alt+click picks a box that lies under another. A Move box's source and a From box's part get handles of their own once the box is selected; a box you turn into Move keeps its place as the source, and its target steps aside by a fifth of the picture, so you can drag it where the element should go. Each gesture is one undo step. While the tool is active or the section is open, the boxes show on the picture, each in a colour of its own that it keeps (its row in the section has the same colour at its edge), with their name and the first words of the description; the kind shows in the shape and the tag: a Move box has a dashed source and an arrow from it, a Remove box is hatched, a From reference box names its reference, a Text box carries a T, and Keep, Move and Remove say their kind when the name does not. While the Boxes switch is off they are drawn dashed and paler: they stay with the document but go with no run.

*Selection → box* takes the selection's bounds as a New box with the prompt as its description; when the prompt names a reference with @img1, the box places that reference into the selection instead. *Clear* removes every box, *Copy rows* puts the model's rows on the clipboard for use in another tool (measured against the whole picture). Every change is one undo step, the boxes are saved in the .scumble file, and they follow a crop, a turn or a resize of the picture.

A recipe that takes no boxes leaves them where they are, and the section says which is the case; under one that does, it says whether the switch sends them. A run measures the boxes in the crop it sends, so a box outside the crop is left out with a note in the status line (it still counts as the document's, so the selection does not go in its place). A box sets place and size, not a hard edge: the model may reach a little past it. It takes the size seriously: asked for "a small black cat" with the selection as the box, FLUX 3 painted a cat that fills the box, so draw a box as large as the thing should be. While the Boxes tool is active and something is selected, the picture outside the crop Generate would send is dimmed, with the crop's size under its edge, so you see which boxes it cuts. While the switch is on, the section warns of a New box without a description (the model would have to guess what goes there), and, while something is selected, when a box is too small to place anything in at the size the crop is sent at, lies outside that crop (it is left out), reaches past its edge (only the part inside goes), or changes the picture outside the selection: with *Paste* on *selection* (the Crop settings), the stitch keeps the result inside the selection only, so a box moved, removed or drawn outside it would be cut. *Paste the whole crop* in the warning switches Paste to the whole crop for this document. Agents and scripts have the same through `boxes_add`, `boxes_set`, `boxes_remove`, `boxes_list`, `boxes_from_selection` and `boxes_clear`, and the switch through `set_generation` (`boxes`).

## Layers, masks and colour match

<!-- slug: layers -->
_Every result is a layer. Nothing is baked in until you flatten, and the one slider that makes results fit._

![The layer stack with the generated result on top, its row expanded to show opacity, the Match slider, the blend mode and the cut-out row](https://www.denrakeiw.com/projects/scumble/manual/layers.jpg "1600x946")

Scumble is a layered editor that happens to generate, not a generator with an undo button. Every result, every paint stroke, every piece of text and every filter is a layer with an opacity, a blend mode, a mask and a name. You can reorder them, duplicate them, merge them down, hide them, erase into them and copy them between tabs. Flatten is a command you give, not something that happens to you.

Colour match is the feature I would keep if I had to throw the rest away. A generated patch almost always comes back a little off: a shade cooler, a touch brighter, a different contrast to its surroundings. The Match slider in the layer row corrects that by matching the layer's statistics to what lies around it — or to what lies below it, your choice in the same row — and it is non-destructive, so you can move it any time.

Masks do the rest of the fitting. Every layer can have one, painted with the normal brush, and what a mask hides comes back when you paint the mask again. The eraser removes a layer's pixels themselves; an over-eager erase is one Ctrl+Z away. The paint brush and the eraser also have **Flow**: below 100 % each dab lays down only part of the paint, so a stroke builds up where it overlaps itself (Opacity still caps the stroke as a whole). For a pen, **Pressure** picks how pressure sizes the brush (linear, soft or hard), and **Stabiliser** makes the brush follow the cursor on a string of that many screen pixels, which calms a trembling hand; letting go draws the rest of the line to the cursor. For photographic repairs there are clone, heal and smudge tools that work like the ones you know. Their **Sample** option says what they pick up: the active layer alone, or the whole visible picture (the smudge also offers the layers up to the active one, *below*); the smudge on the base paints into a new layer from the picture, since the base itself is never changed. The smudge carries the paint it picks up: **Strength** is how much of it goes down at each step, **Length** how far it goes on (0 leaves it where it lands, towards 100 it is dragged to the end of the stroke), and **Finger** starts each stroke with the paint colour on the brush. It drags transparency as well as colour, so a stroke that starts outside a layer's edge thins what it crosses; alpha lock keeps the layer's alpha. An imported brush tip shapes the smudge too. The smudge tool's **Mode** turns it into a blur or a sharpen brush: each dab moves what it passes over towards a softer or crisper version of the picture as it was when you pressed, by the strength; the dabs overlap, so at the default strength one stroke goes nearly all the way (a single click goes as far as the strength says), and for a gentle touch you set the strength low. Going over a place again in the same stroke does not overdo it; a new stroke adds more. **Dodge / burn** (Shift+O, in the same group) lightens or darkens what you paint over: **Range** picks the shadows, midtones or highlights, **Exposure** how far one stroke goes, and **Protect tones** moves the three colour channels together so colours keep their hue (off, each channel is curved on its own); a strong highlights dodge can still blow out what is already bright, and a shadows burn can crush the darkest parts to black. Hold Alt while you press to burn with the dodge and the other way round. Its **Mode** also has the sponge: *saturate* (with **Vibrance**, dull colours gain more than vivid ones, and nothing clips) and *desaturate*. Like blur and sharpen, a stroke works from the picture as it was when you pressed, so it does not pile up over itself; paint again to go further. **Sample** and the base work as for the smudge. Clone and heal can turn, scale and mirror their source (**Angle**, **Scale**, **Flip H**, **Flip V**), and with **Overlay** on you see what the brush would copy, half transparent under it, before you press; imported tips shape them as well. **Heal** copies the source's texture and blends it into the colour and light around the stroke: while you paint you see a quick version, and when you let go the stroke is blended so that it meets the picture without a rim (a large stroke takes a moment; the brush and the shortcuts wait for it, and Ctrl+Z takes it back once it has landed). With a selection, the blend stops at the selection's edge and meets the picture there too. The quick version stays on a scaled layer, for a stroke larger than about 8 megapixels of box, and where the source's transparency splits the stroke into thin strands. Clone and heal paint pixels, so they refuse while quick mask is on or a mask is being edited.

**Remove** (Shift+J, in the same group) takes things out of the picture: brush over an object, a person in the background, a wire or a blemish, generously, and let go. While you paint the stroke shows as a pink mark; when you let go, LaMa, a model that runs inside Scumble, fills it from what surrounds it, and the fill lands in the active layer as one undo step (on the base, in a new layer, so the original stays underneath). It needs no prompt, no key and no ComfyUI, but the model has to be downloaded once in Settings › Helpers (in-app models) (198 MB). Scumble loads it as soon as you pick the tool, which takes about ten seconds the first time; after that a stroke takes one to two seconds on the processor, and the brush and the shortcuts wait for it. **Sample** says what it fills from: the visible image or the active layer alone. The model looks at a square around the stroke twice as wide as the stroke, at 512 × 512 pixels: a small spot is filled at the picture's full resolution, a large stroke comes back softer than the picture around it, and a stroke wider than 2,048 pixels is refused (select the area and use Generate with a model recipe instead). With a selection only the selected part of the stroke is filled. Like clone and heal, Remove refuses while quick mask is on or a mask is being edited, and on a layer that is scaled.

**Patch** (Shift+J again, in the same group) repairs a whole area at once. Lasso the spot with the tool itself (or select it any other way), then press inside the selection and drag: the selection's outline follows the pointer, and the spot shows what lies under the outline. Let go where the picture is right, and that texture is laid into the spot and takes on the colour and light around it, right up to its edge, the healing brush's blend for a whole area. **Mode** Destination turns it round: what is selected is copied to where you let go and blends in there. **Blend** below 100 % keeps more of the copied texture's own colour, and 0 % copies it as it is. The patch lands in the active layer as one undo step (on the base in a new layer) and the selection stays where it was, so you can drag again: a second drag patches over the first (with a feathered selection the first try still shows faintly in the soft edge), so press Ctrl+Z first to try another source from scratch. Esc during the drag cancels it. A soft (feathered) selection gives a soft edge. Patch works on a layer at its own size, not on text or filter layers, and blends up to 8 megapixels of selection at a time.

**Content-aware move** (Shift+J a third time, in the same group) moves something to another place in the picture. Lasso the object with a little of its surroundings, press inside the selection and drag it; let go where it should be. The object lands there as it was, and a band inside the selection's edge takes on the colour and light of its new place, so the bit of old background you selected with it blends in; LaMa fills where it was, from what surrounds that place, as Remove does. **Mode** Extend leaves the original and places a copy (no model needed). **Blend** All lets the whole piece take on the new place's colour and light, not only its edge: better when the object moves into shade or sun, worse when its own colour matters. It needs the LaMa model for Move (Settings › Helpers (in-app models)), lands in the active layer as one undo step (on the base in a new layer), and the selection stays where the object was. A feathered selection moves as far as its outline (the marching ants) reaches; the blend does the soft edge. A selection much larger than the object keeps more of the old background around it, and where the old and the new surroundings differ a lot a faint halo can remain with Blend Edge: select the object more closely, or use Blend All. The old place is filled at the model's 512 × 512, so a large object leaves a softer fill; with Move the selection can be up to 2,048 pixels across (the old place LaMa has to fill), while Extend has no such limit.

**Liquify** (Shift+W, or Ctrl+Shift+X; in the same group) bends the picture like wet paint. **Mode** *push* drags what is under the brush along with the cursor; *grow* swells it and *shrink* pinches it, *swirl* turns it clockwise or counter-clockwise, and *restore* brings back the layer as it was. Grow, shrink, swirl and restore keep working while you hold the button still; Alt while pressing swaps grow and shrink and the swirl's direction. **Strength** is how far one dab moves the picture (with push at 100 % the picture under the brush's centre follows the cursor all the way), the brush's size and hardness shape it, and a pen's pressure scales the strength. While you drag you see the result; when you let go it lands in the active layer as one undo step. Every stroke is taken from the layer as it was when you started liquifying it, so a hundred strokes blur the picture no more than one does, restore finds the original pixels, and **Restore all** puts back the whole layer (inside the selection, if there is one). The session ends when you pick another tool; after that, restore goes back only to that point. A selection limits Liquify: what lies outside it stays where it is. **Freeze** does the same with the brush: in the modes *freeze* and *thaw* you paint what should stay where it is (shown in red while the tool is Liquify, with **Freeze** ticked) and free it again; Alt swaps the two, a lower strength freezes only partly, and the two buttons beside the tick clear the freeze or invert it. The freeze belongs to the layer while the document is open, across tools and sessions; it is not undone and not saved. On the base Liquify works on a copy of it, the layer *Liquify*, directly above it; one Ctrl+Z takes the copy away again. The layer mask stays where it is and a layer does not grow: what is pushed past a layer's edge is cut, and what is pulled in from outside is transparent (on a layer as large as the picture, its edge repeats). Liquify refuses a text or filter layer, a scaled layer or one placed between pixels, a layer whose transparency is locked, and quick mask or a mask being edited. The grid it moves on is 1 pixel up to 4 megapixels, 2 up to 16, 4 above (8 beyond 256 megapixels), so on a very large picture a very small brush bends softly; the picture while you drag is a little softer than the result.

Around all this sit transform (move, scale, rotate, flip, with a perspective mesh), crop, and extend canvas — which is how outpainting starts: extend the canvas, select the new empty part, prompt, generate. Or pick an Outpaint recipe (Image Expand on Magnific), which extends the picture outward from what is kept: after Extend canvas the new border is already selected, so Generate is the only step left.

### Notes

- Blend modes: the usual eight and linear light, computed in the compositor with a single rounding per channel, so a stack looks the same on screen as it does in the exported file. A document with a linear-light layer needs Scumble 0.1.32 or newer to open.
- **Image › Frequency Separation…** splits the picture (or the selection's box; up to 16 megapixels at a time) into two layers on top: *Low frequency*, a blur of the radius you give, carrying colour and tone, and *High frequency* in linear light, carrying the texture. Together they give back the picture exactly. Paint or blur on the low layer to even out skin tone without losing pores; clone or heal on the high layer to fix texture without shifting colour. One Ctrl+Z takes both layers away.
- **Image › New Dodge & Burn Layer** adds a layer in soft light on top: paint white on it to lighten and black to darken, with a soft brush at 10 to 20 % opacity, and erase to take it back. It starts empty, which gives the same picture as the classic layer filled with 50 % grey and costs no memory until you paint; **New Dodge & Burn Layer (50 % Grey)** makes the grey one, where painting grey takes it back.
- Layer names can be renamed by double-clicking them, and a rename is an undo step like anything else.
- **Several layers at once:** Ctrl+click a row to add it to the selection or take it out, Shift+click to select every row from the last one you clicked. The selected rows are highlighted and act together: with the transform tool (T) a drag moves them all, the handles on the box around them scale them together, and the arrow keys nudge them. Ctrl+E merges them into one layer at the place of the topmost, Delete (or the bin in one of their rows) removes them, and the eye and the lock of a selected row switch all of them. Moving, scaling, nudging, merging and deleting are one undo step each; the eye and the lock take none, as for one layer. Locked and filter layers stay where they are when the others move, Ctrl+E refuses while one of them is selected and Delete keeps the locked ones; rotate, distort and warp still take one layer at a time. A plain click selects one layer again.
- **Align and distribute:** with the transform tool (T) the bar above the canvas has six buttons that line up the selected layers' left edges, horizontal centres, right edges, top edges, vertical centres or bottom edges, and two that space them with equal gaps, side by side or one above the other. *To* chooses what they line up in: *Selection*, the box around the selected layers (distributing keeps the outer two where they are and needs three layers), or *Canvas* (the outer two go to the canvas edges; two layers are enough). One layer on its own always aligns to the canvas. They go by each layer's box, the frame the transform tool draws around it, not by what is painted in it. Each click is one undo step; locked and filter layers stay put.
- **Show only one layer:** Alt+click a layer's eye and every other layer is hidden; Alt+click it again and what was visible before comes back. On a row of several selected layers it shows just those. Switching the solo to another layer keeps what was visible before the first one, so the way back is always to where you started. The same is in the menu a right click on a row opens (*Show only this layer*, *Show all layers*, beside merge and delete). References are not part of the picture and are left as they are.
- **Clip to the layer below:** Alt+click the line between two layer rows (the pointer changes when Alt is held over it), press Ctrl+Alt+G, or pick *Clip to layer below* in a row's right-click menu: the upper layer then shows only where the layer below it has pixels, as if that layer's shape were its mask. How much shows follows the lower layer's own transparency, its mask and its opacity, not its blend mode. Several layers in a row can clip to the same layer, which gets an underline; each clipped row gets a small arrow. A filter layer clipped this way changes only the picture under that layer, for a grade of one object. If the layer below is hidden, the clipped layers are hidden too; a clip over a filter or fill layer, or on the bottom layer, has no effect and its arrow is dimmed. The same click, key or menu entry releases it, one undo step each. Merge down bakes the clip in when a clipped layer goes into the layer it clips to. Where the lower layer is only partly there (a soft edge, a feathered mask) each clipped layer is drawn over the picture with that partial strength, so two clipped layers can look a little different from the same two merged into one there. PSD keeps the clip both ways; ORA has no clipping and gets the layers unclipped.
- **Groups:** select layers and press Ctrl+G (or pick *Group* in a row's right-click menu) to put them into a group, a folder with its own row in the layer list. The group sits where the topmost of them was; a group whose layers are all selected goes in whole, so groups nest. The group's row folds the group open or shut (the arrow), hides every layer in it (the eye; their own eyes stay as they were and come back with the group's), locks every layer in it (the lock), dissolves it (*Ungroup*: the layers stay where they are, and those of a hidden or locked group stay hidden or locked) or deletes it with its layers (the trash); double-click its name to rename it. A click on the group's row selects its layers, so the transform tool moves and scales them together. Drag a layer onto a layer's row to put it above or below that layer in its group; onto the upper half of a group's row to put it above the group, onto the lower half to put it into the group at its top; a group's row drags the same way. Ctrl+] and Ctrl+[ step the active layer past the next layer, into a group next to it (at its near end) or out of its own group at its end. A group has no opacity, blend mode or mask of its own: its layers are drawn exactly as if it were not there, only its eye and lock count. A clip does not reach out of a group: the bottom layer of a group has nothing to clip to. Groups are saved with the document; PSD files keep them both ways (when a PSD opens, a group's opacity goes into its layers and the status line says so, a group's blend mode becomes pass through); ORA gets the layers without the groups, those of a hidden group hidden.
- Copy and paste move whole layers between tabs, pixels, mask and settings included.
- A mask can be switched off without losing it: the eye button in the mask row, or Shift+click on the word "mask". The layer then shows whole, the mask stays with it through moves, crops and saves, and editing the mask switches it back on.
- The "..." button in the mask row, or a right click on the word "mask", holds the whole-mask operations: Reveal all and Hide all put a white or a black mask on the layer (Hide all, then paint the mask where the layer should show, is the quickest way to bring in a small part of a result), Reveal selection and Hide selection make the mask from the selection, and Invert mask swaps what shows and what is hidden. Each is one undo step.
- SVG files can be loaded as layers, and PSD or ORA files arrive with their own layers since 0.1.25.
- The whole picture turns and mirrors from Image › Rotate 90° Clockwise, Rotate 90° Counter-clockwise, Rotate 180°, Flip Horizontal and Flip Vertical, or from the Turn row in the Canvas section. Every layer turns with it, masks, the selection, guides, saved selections and earlier results included; text stays editable and keeps the turn, 3D objects and film control points follow. Nothing is resampled, so four turns give back the same pixels, and the whole turn is one Ctrl+Z. While a render is still running (on an API or on your ComfyUI) the picture does not turn, since the result lands where it was made for; two quick clicks on 90° make 180°. The transform tool's flip and rotate buttons turn one layer only.
- **Straighten and crop** with the Canvas tool (C). Its frame now waits for you: drag its edges to crop or extend, drag inside it to move it, and nothing happens until you press Enter, click Apply or double-click inside it; Esc resets it. Drag outside the frame to turn the picture, type the angle in the bar above the canvas, or hold Ctrl and draw a line along a horizon or a wall (the Straighten button does the same): the picture turns until that line is level or plumb. While the picture is turned the frame stays inside it, the largest one of the aspect you chose (original, 1:1, 4:3, 3:2, 16:9, 5:4 or your own; X turns it on its side). The bar also draws thirds, the golden section, a grid or diagonals over the frame. Every layer, mask and the selection are resampled once, text stays text and turns with the picture, guides stay where they are on the screen, and the whole straighten is one Ctrl+Z.
- Crop, extend and resize take the guides, saved selections and the places of earlier results with them, as the turns do.

## Filter layers and the film pack

<!-- slug: filters -->
_Grain, curves, LUTs and a film look, all as layers you can switch off again._

![The same picture under a Kodak Portra 400 film look and a vignette, both as filter layers, the look's sliders open in the layer row](https://www.denrakeiw.com/projects/scumble/manual/filters.jpg "1600x946")

A filter in Scumble is a layer, not a one-way change to your pixels. Add one and everything below it is filtered; drag it up or down and it filters more or less; set its opacity, give it a mask, or switch it off. Its settings stay editable a week later.

The built-in set covers the photographic basics: grain with film presets, curves, levels, colour balance, HSL, exposure and contrast, sharpen, blur, normalise, vignette, and LUTs from .cube files. They run on the GPU through WebGL2, so they stay interactive on large pictures, with a processor path as a fallback.

A fill layer works the same way but paints instead of filtering: the fill button in the layer list adds a layer of one colour (the paint colour to start with), and its row turns it into a gradient, linear, reflected or radial, between two colours that each have their own opacity (from the fill's colour to transparent to start with), with an angle, a scale and a centre set in per cent. It covers what is below it until its blend mode, its opacity or a mask lets the picture through, and it can be changed as long as the document exists. PSD and ORA exports write it as an ordinary layer of pixels.

The film pack is a plugin that ships with the app and goes further: film looks with real film names, halation, glow, bleach bypass, cross processing, split toning, light leaks, frames, and control points that steer a look locally. The names are there so you know what a look is after; the values are Scumble's own approximations, not licensed manufacturer data, and the tooltip and the About dialog say so.

### Notes

- A filter layer over an inpaint result is often the cheapest way to make the result belong: one grain layer over everything hides a lot of difference in texture.
- A gradient fill from a colour to transparent in multiply or overlay is a quick graduated filter for a sky; a warm colour fill in soft light at a low opacity warms the whole picture.
- LUTs: drop a .cube file into the LUT filter and it is applied at full precision, with a strength slider.
- Filters render in tiles on large documents, so a 15,000 pixel picture does not stall the window.

## Text, shapes, brushes and 3D objects

<!-- slug: text-shapes-objects -->
_The smaller tools: editable text layers, vector shapes, Photoshop brushes, and .glb models placed into the picture._

![A text layer over the picture, its font, size, colour and outline editable in the layer row](https://www.denrakeiw.com/projects/scumble/manual/text-shapes-objects.jpg "1600x946")

Text is a layer that stays text: font, size, colour, spacing, alignment and a few effects, editable after the fact, exported into PSD as its own layer. The bundled fonts are open-licensed; the + beside the font list adds your own font file (.ttf, .otf, .woff or .woff2), which stays in the list from then on. Fonts installed on your system are not listed: add the file with + to use one.

The shape tool draws rectangles, ellipses, polygons, Bezier paths and freehand paths, filled, outlined or both, with a corner radius, clipped to the selection if there is one. Each shape is one undo step.

Brushes can be loaded from Photoshop .abr files, which means the brush set you already own works here for painting and for masking. Click the tip's thumbnail in the brush bar to see every tip with a stroke drawn with it, the ones you used last on top and a search box for a pack of hundreds; a click tries a tip, a double click or Enter takes it and closes the list.

And there are 3D objects: drop a .glb file in, and it is placed into the picture as a layer you can rotate, scale and light. It is a niche feature with a clear use — a product, a prop or a reference shape put into a scene in the right perspective before you let a model paint over it.

### Notes

- Everything here is a normal layer: blend mode, opacity, mask, and a place in the stack.
- A shape or a text layer makes a good mask source: draw it, then Select from layer.
- Text turns by any angle and stays editable: the transform tool (T) or the Angle field in the text layer's row. It is drawn sharp at its angle every time, so turning it again and again costs nothing. Distort and warp cannot be kept as text: they turn the layer into pixels, and Ctrl+Z brings the text back.

## Upscaling

<!-- slug: upscale -->
_Make the selection sharper, or the whole picture bigger, through a provider or your own upscale models._

![The Upscale dialog: the model, the choice between the selection and the whole picture, and the factor](https://www.denrakeiw.com/projects/scumble/manual/upscale.jpg "1600x946")

The Upscale button sits next to Generate new and opens a small dialog: which upscaler, then the selection or the whole picture, then the factor. Which of the two you pick changes what happens more than it sounds.

The selection goes out at its own size and comes back sharper at the document's resolution — a detail pass on a face, a label, a piece of texture, landing as a layer like any other result. The whole picture goes out alone and the answer becomes the new base: the document is resized, layers, masks and the selection scale with it, and that is one undo step.

Through a provider you get Topaz (Precision, Bloom, Wonder), Clarity, SeedVR2, Recraft and Magnific (Precision and Creative), each on its own key or through fal; the three Topaz models also through Oxen.ai. Times differ wildly and the status line warns you about the slow ones — Magnific Precision took five minutes for a small box in my own test, Topaz about twenty-five seconds for the same kind of job.

On your own ComfyUI, the Upscale model recipe runs any model in your server's upscale\_models folder — ESRGAN, UltraSharp, DAT, whatever you have. *RTX Video Super Resolution (ComfyUI)* runs NVIDIA's video upscaler on an RTX card there: it takes compression artefacts out and cleans edges without inventing detail, 1 to 4 times, with a *Quality* setting (LOW to ULTRA). It needs the node pack Nvidia\_RTX\_Nodes\_ComfyUI on that ComfyUI, and its answer may be at most 8192 pixels on the long side, so a large box or picture at 4× is refused before anything is sent. *RTX Video Super Resolution (Comfy Cloud)* is the same upscaler on Comfy Cloud's GPUs, on your Comfy key and billed in Comfy credits, with nothing to install: the same factors, *Quality* and 8192-pixel cap, for the selection or the whole picture, listed with the providers; it ran a 1024 × 1024 picture to 2048 × 2048 in about 21 seconds (2026-10-04), and a cut-out picture comes back opaque, black where it was transparent. Both ComfyUI recipes work on the selection and on the whole picture: for the whole picture the base goes to your ComfyUI alone, and the answer becomes the new picture with every layer scaled along, as with the providers. For the whole picture, the Upscale model recipe takes at most 2048 pixels on the long side, so a 4× model answers at most 8192; a selection has no such cap. On this route a cut-out picture comes back opaque, black where it was transparent (ComfyUI loads it without the alpha), and the dialog says so. While it runs, the title row's timer shows the recipe and its *Cancel* takes the job off your ComfyUI. Three of the upscalers, Clarity, Magnific Creative and Topaz Bloom on Oxen.ai, also take a prompt; since 0.1.27 the dialog shows a prompt field for those, filled from the Generate tab but sent separately. An upscale sends no reference pictures, so an @img token comes into that field as its layer's name.

### Notes

- Upscaling the whole picture has a ceiling: the document can go to 65,535 pixels a side and about a gigapixel, and a factor that would pass it is refused before it costs you anything.
- An upscale of the selection is a layer, so it can be masked back in partly — often nicer than a uniformly sharpened picture.
- The same dialog lists the *Realism Pass (Windows only, RTX only)*, which refines the whole picture at 1×, or at 1.5× to 3× refines it and makes it larger in one go. It has a chapter of its own, the next one.

## Realism Pass (Windows only, RTX only)

<!-- slug: realism-pass -->
_A refiner for generated pictures: DLSS 5 Neural Rendering over the whole picture on your own ComfyUI, as a new layer._

Generated people often come back with skin like wax and hair and fabric that look moulded rather than grown or woven. The Realism Pass sends the picture through DLSS 5 Neural Rendering, NVIDIA's neural renderer, on your own ComfyUI, so that generated skin, hair and fabric look less waxy. It is a refiner first: at 1× the picture keeps its size, and the answer comes back as a new layer above it, so the picture underneath stays as it was. At 1.5× to 3× it also makes the picture larger, with the pass on top at the new size. The label says what it needs and means it: a ComfyUI on Windows with an NVIDIA RTX card, and a community node pack with its runtime that you install there yourself. Scumble ships none of it.

Open *Upscale*, or *Image › Realism Pass (Windows only, RTX only)...*, which opens the same dialog with the pass already chosen, and pick *Realism Pass (Windows only, RTX only)* as the model. The factor offers *1× (refine)*, *1.5×*, *1.7×*, *2×* and *3×* (1× to start with), and the scope is the whole picture; the selection is not used. The row below holds the pass's own settings: *Style* (Default, Natural or Cinematic), *Strength* (0 to 1, how strongly the neural rendering is applied) and *Preset*, the DLSS model preset (Default, J, K, L or M; L to start with). They count for every document, not for one picture. Press *Upscale* and the dialog closes; the status line follows the pass while it reads the picture, sends it, waits in your ComfyUI's queue and runs, and the title row shows its timer with *Cancel* beside it.

What goes out is the picture as you see it: every visible layer with its filters and blend modes, without the reference layers. The exception is a run of filter layers at the top of the stack, such as a film look or grain: they are not sent, because the pass would smooth grain away as noise, and the new layer goes in under them, so they stay live above it. The new layer is called *Realism Pass (Windows only, RTX only)*, covers the whole picture, and adding it is one undo step. It comes without a colour match, since the pass shifts colours a little along with the texture: its opacity sets how much of the pass you keep, its Match slider takes a colour shift back (its source is *underneath*: the picture the layer covers), and a mask keeps the pass off a part of the picture, a background that should stay soft, say. A second run reads everything visible, the first pass layer included, and stacks its own layer above it. The pass also takes noise and grain out of the picture itself, so a grainy photo comes back cleaner; put grain back with a filter layer above it if you want it. A transparent picture goes out over mid-grey and comes back with exactly its own transparency; soft edges can come back a little lighter.

At 1.5×, 1.7×, 2× or 3× the pass makes the picture larger in the same run: DLSS answers at that many times the size (1.7× is its Balanced mode, 1.724 times), the document is made that much larger first, the base and every layer, mask and the selection scaled as the Canvas section's Resize row scales them, and the pass layer covers the larger picture. Making it larger and adding the layer are one undo step: one Ctrl+Z takes both back. Only the pass layer holds new detail; the layers under it are resampled, so the pass layer is what you keep, or hide it to see the picture merely enlarged. DLSS answers at most 7680 × 4320 (long side × short side). A picture whose answer would be larger is not refused: it is scaled down first, with plain resampling and no model, to the largest size of its shape whose answer fits, so the answer comes back as large as DLSS allows, smaller than the factor alone would make it. The dialog's size note says what goes out and what the picture becomes, and the status line says "Realism Pass (Windows only, RTX only) scaled the picture down to W × H first: its output is capped at 7680 × 4320." A 5456 × 3072 picture at 1.5×, for example, goes out at 5114 × 2880 and comes back at 7672 × 4320. A picture that is already as large as DLSS answers (7680 × 4320) cannot get larger, and a long narrow picture whose scaled-down copy would be under 64 pixels a side is refused; both before anything goes out.

On an RTX 5090, a 5456 × 3072 picture took about 8 seconds on the ComfyUI at 1× (10 seconds in all, reading and sending included) and about 4.6 GB more graphics memory while it ran; a box of about 1000 × 1000 pixels through the recipe took about 12 seconds (measured 2026-10-04). The DLSS worker starts anew for every run, so a small picture does not take much less. The larger factors were not measured yet.

The pass goes to the front of your ComfyUI's queue but never interrupts a job that is already running there; while it waits, the status line says how many jobs are ahead. *Cancel* takes only Scumble's own job off the server. While the pass works on a document, that document takes no second run that would land in the same picture: an API Generate, an upscale, Generate new and a turn of the picture are refused with a note until the layer is in, while Generate with a recipe on your own ComfyUI still queues. If the picture changes while the pass runs, the layer shows it as it was when the pass started, and the status line says so. Closing the tab asks first and ends the pass, and nothing is added.

The pass is also a recipe of the same name in the recipe picker, among the local recipes. With it selected, Generate sends the selection's box with its surroundings at its own size, without a fill and without the reference layers, and the answer lands over the box as a result layer, stitched like any local result; *Select All* first runs it over the whole picture that way. Its Settings section has the DLSS model preset row with two presets that come with the recipe, L (the default) and M; Style and Strength are the ones in the Upscale dialog's row. Use the box with care: the pass changes colour and texture and takes out the grain, so a passed box can stand out against the unpassed picture around it, its edge showing where the grain stops. For an even look, pass the whole picture and mask the layer where it should not show. Generate new does not offer the recipe, since the pass makes nothing from a prompt.

There is no Comfy Cloud version of the pass. Comfy Cloud runs no custom nodes, and the runtime needs Windows on the machine with the graphics card; the recipe has no Cloud copy, and nothing of the pass goes to Comfy Cloud.

Everything the pass needs lives on the machine your ComfyUI runs on, which need not be the one Scumble runs on: Scumble asks the connected ComfyUI what it runs on, not your own computer. That machine needs Windows; an NVIDIA RTX 50, 40 or 30 card with a current driver (NVIDIA ships DLSS 5 for the RTX 50 series, the community runtime also runs it on the 40 and, as an experiment, the 30 series, and RTX 20 and older are refused); a ComfyUI recent enough for the V3 node API; the Inpaint Canvas node pack, as every local recipe does; the community node pack ComfyUI-DLSS5-Enhancer (github.com/Blueforcer/ComfyUI-DLSS5-Enhancer); and that pack's runtime, a download of about 467 MB (about 700 MB on disk) from the community project Merserk/dlss5-visual-enhancer on GitHub. The runtime holds NVIDIA's proprietary DLSS libraries and other files under their own terms. The pack's installer tells you to install only components you are authorised to use; install it only if you trust the source.

The steps below follow the pack's README as it was on 2026-10-04 (pack version 1.1.0); where the README says something different by the time you read this, the README is right. The commands are for the Windows portable ComfyUI and run in its folder, the one that holds python\_embeded and ComfyUI; with another install, use the Python your ComfyUI runs with.

### Steps

1. **Install the node pack.** In the ComfyUI Manager, search for "DLSS5" and install ComfyUI-DLSS5-Enhancer. By hand: `git clone https://github.com/Blueforcer/ComfyUI-DLSS5-Enhancer.git ComfyUI\custom_nodes\ComfyUI-DLSS5-Enhancer`, then `python_embeded\python.exe -m pip install -r ComfyUI\custom_nodes\ComfyUI-DLSS5-Enhancer\requirements.txt`.
2. **Install the runtime.** `python_embeded\python.exe ComfyUI\custom_nodes\ComfyUI-DLSS5-Enhancer\install_runtime.py` shows the licensing notice, asks before it downloads, and puts the runtime into the pack's runtime folder. On 2026-10-04 the download address built into the script was wrong (it asks for a release named 3.0; the release is called v3.0), and the runtime came only with the address given by hand. If the download fails for you, add `--url https://github.com/Merserk/dlss5-visual-enhancer/releases/download/v3.0/DLSS.5.Visual.Enhancer.v3.0.zip` to the same line, but only if you trust that source. To install the runtime again, close ComfyUI first: the script does not overwrite files that are in use.
3. **Let Windows run the worker.** The runtime's worker is a program that has to be named nvngx.dll, and a .dll started as a program is a pattern Windows Defender and SmartScreen flag, so they may block or quarantine it. The pack's README says: if the node reports that the worker could not be started, add the runtime folder to your exclusion list. That is the folder `ComfyUI\custom_nodes\ComfyUI-DLSS5-Enhancer\runtime`. Do it only if you trust the source: Defender no longer checks what lies in an excluded folder.
4. **Restart ComfyUI.** The pack's nodes appear under image/upscaling. In Scumble, open *Upscale* and pick the pass: the dialog says it is ready, or what is still missing. If it still says the nodes are missing, connect to the server again from the top bar.

### Notes

- **Before anything is sent** Scumble checks your ComfyUI, greys *Upscale* with the reason, and refuses Generate on the recipe with it: no ComfyUI connected (connect it under Settings › ComfyUI), a ComfyUI that runs on another system than Windows, no RTX 30, 40 or 50 card among the devices your ComfyUI reports, the pack's nodes missing (steps 1 and 4), the Inpaint Canvas node pack missing, or a node list Scumble could not read (connect again). A card your ComfyUI does not report is left to the pack, which then says what it found.
- **An RTX 30 card** passes with a note: the pack runs that series only with the exact pair of runtime files it was tested with, checks them by their hash, and calls the path experimental, so it may still crash where a newer card does not. The v3.0 runtime installed on 2026-10-04 held that pair; if the pack says the installed runtime is not that pair, install it again from the address in step 2.
- **Size.** The pass takes at least 64 pixels a side and at most 7680 × 4320 (long side × short side), the most the pack makes. At 1× a larger picture is refused before anything goes out: crop it with the Canvas tool, scale it down in the Canvas section's Resize row, or select a part and run the recipe on it. For the recipe, the limits apply to the box with its surroundings. At 1.5× to 3× a picture whose answer would pass the cap is scaled down first instead (above); refused are only a picture that cannot get larger ("cannot make the W × H picture larger": use 1×) and one whose scaled-down copy would be under 64 pixels a side ("would go at W × H": pick a smaller factor). Above 1× the pass also waits for any other job on the document that would land where the picture was (a cutout, a selection by text), as *Upscale* on the whole picture does.
- **A busy document.** "A run is still going on this document" means another run has not landed yet: wait for it, or *Cancel* it. "The document is still loading" passes in a moment; "load an image first" means the tab is empty.
- **Waiting and time.** "Waits for your ComfyUI (2 jobs ahead)" is the queue in front of it. Once the pass runs, your ComfyUI has 300 seconds to answer (the time spent waiting in the queue does not count toward them), and a pass started from the Upscale dialog also ends 30 minutes after you pressed *Upscale*, the wait in the queue included. Either way the status line says there was no answer within that time and that its job was taken off the queue: try again when the server is free. "Your ComfyUI did not take the picture" means the upload did not get through in time: check the connection and run it again. "The connection to your ComfyUI was lost" means what it says: connect again and run the pass again. *Cancel* ends it at once and leaves your other jobs alone.
- **The runtime.** "The DLSS 5 runtime is not installed" means step 2 has not happened on that machine. "The DLSS 5 runtime is incomplete", with the missing files named, and "the installed runtime is not the version the pack expects (v3.0)" both mean: install it again (step 2, with the address there). "Windows Defender (or another antivirus) blocked the DLSS worker" is step 3.
- **The machine.** "Shows no NVIDIA driver" means the pack found no NVIDIA driver there: it needs a current one. "Is not supported; it needs an RTX 30, 40 or 50 card" names the card the pack found. "The DLSS worker crashed" asks for a driver update and the runtime installed again, and on an RTX 30 card it may be the experimental path itself. "DLSS 5 did not run its neural rendering" usually means another program held the graphics card, a game, a video encoder or another ComfyUI job: close it and try again. "Your ComfyUI's Python has no OpenCV" means what it says: the pack needs OpenCV and leaves it out of its requirements on purpose, so step 1 does not install it. Install it with `python_embeded\python.exe -m pip install opencv-python`, or opencv-contrib-python if you already use that one (the pack's README).
- **The picture.** "DLSS refused this size" comes from NVIDIA's own check of the size: try a smaller area or a newer driver. When the runtime refuses the DLSS model preset you picked, the whole-picture pass switches its Preset to Default, runs again at once and says so; set it back in the dialog when the runtime takes it again. On the recipe, pick Default in its DLSS model preset row and Generate again.
- **Anything else** comes as "failed on your ComfyUI:" with the first line of the pack's message. The pack has a self-test that runs without ComfyUI and tells a runtime or driver problem apart from anything Scumble does: `python_embeded\python.exe ComfyUI\custom_nodes\ComfyUI-DLSS5-Enhancer\selftest.py --frames 5 --mode "2x (Performance)"`.
- Agents and scripts run the pass with `realism_pass` (`factor` 1, 1.5, 1.7, 2 or 3); `status` says whether it would start on the document at 1× and why not, and `list_recipes` whether the connected ComfyUI can run it. The assistant asks before it runs the pass, showing the Style, Strength and preset it sends, and above 1× the factor.
- NVIDIA, RTX and DLSS are trademarks of NVIDIA Corporation. Scumble is not affiliated with or endorsed by NVIDIA, nor by the authors of the node pack or its runtime; the pass runs what you installed on your ComfyUI.

## Documents: your work as a .scumble file

<!-- slug: documents -->
_Ctrl+S keeps the whole document in one file — layers, filters, text, 3D objects, prompts and results — and it opens again as editable as you left it._

An exported picture is the end of the road. PSD and ORA keep the layers for other programs, but a filter layer survives there only in the merged picture, and the prompts and the results stay behind. A .scumble file is Scumble's own document: Ctrl+S writes the tab into one, and opening it next week, or on another machine, brings the document back with every part of it still editable.

What goes in is everything the document is. Every layer with its pixels, its mask, blend mode, opacity, role, lock and alpha lock. Filter layers with their settings, LUTs and grain plates included. Text layers as text: a font you added yourself travels in the file, a system font is only named and falls back to another one on a machine that lacks it. 3D objects with their model file, so Edit 3D object still works after reopening, on another machine too. The selection and the saved selections, the guides and the crop, the prompt, the negative prompt and the generation settings. And the result history: the results and the prompts of earlier runs.

What stays out is what belongs to you or to this machine rather than to the picture: API keys, the ComfyUI connection, the app's settings, the undo history, and the view — zoom and pan. The recipe choice stays yours as well; the file only notes which recipe it was saved with.

The first Ctrl+S asks where; after that it writes to the same file, and Ctrl+Shift+S (Save As) writes a new one, which the tab follows from then on. The tab carries the file's name and shows its path in the tooltip. A * after the name, in the window title too, means the tab has changes that are not in its file, or has no file yet. The picture export that used to be on Ctrl+S is on Ctrl+Shift+E now (the next chapter).

The result history is work you paid for, in money or in GPU time, so it goes into the file. A Save As of a document that holds results asks once — Save with History, Save without History, or Cancel — and leaving it out is for sharing a picture without how it was made. The tab's file remembers the answer, so the next Ctrl+S does the same.

Closing a tab with changes, or with a picture that was never saved, asks: Save, Don't Save or Cancel. A tab whose file holds everything closes without a question. Either way Ctrl+Shift+T brings back the last ten tabs closed in this session, also after Don't Save. Quitting Scumble asks nothing: the session keeps every open document, the unsaved ones still marked with *, and they come back at the next start.

A save cannot leave half a file behind. It is written beside the target under a temporary name and only then renamed over it, so a crash, a full disk or a killed process leaves the old file as it was. A long save or open shows a chip on the tab, "Saving 43 %", with a cross that cancels it; a cancelled or failed save leaves the old file alone too. Closing the app or installing an update waits for a save in progress.

### Steps

1. **Save.** Ctrl+S. The first time it asks for a name and a folder.
2. **Save under a new name.** Ctrl+Shift+S, File › Save As. The tab follows the new file; the old one stays as it was.
3. **Open.** Ctrl+O, File › Open Recent for the last ten documents, or drop the .scumble on the window. Opening a file that is already open brings its tab to the front.
4. **Undo a close.** Ctrl+Shift+T, File › Reopen Closed Tab: one tab per press, up to the last ten of the session.

### Notes

- Saving over a file that changed on disk since you opened or saved it asks first: Overwrite, Save As or Cancel.
- A file made by a newer Scumble opens with a note: what this version does not know is kept, not dropped. Saving over it asks first and proposes Save As.
- Without the history, the results and the prompts of earlier runs stay out; the prompt and the settings in the Generate tab are part of the document and still go in.
- A font you added travels in the file, so check its licence before you pass a document on.
- File › Open Recent › Clear Recently Opened empties the list; a document that was moved or deleted leaves it when it fails to open.
- The format is a plain zip with stored entries: rename a copy to .zip and any zip tool shows ordinary PNGs inside. Opening a document someone else made is safe — entry names are checked, and nothing is written outside the app's local file store (the next chapter).
- Documents are the app's. The ComfyUI node Inpaint Canvas keeps Ctrl+S for its picture export; its document is the workflow.

## Exporting and where your files live

<!-- slug: export -->
_PNG, JPEG, WebP, PSD and ORA with layers, the AI label, tabs that come back, and the folder that holds it all._

![The Export panel with PSD chosen, next to the size and canvas fields and the buttons for a single layer or the mask](https://www.denrakeiw.com/projects/scumble/manual/export.jpg "1600x946")

Ctrl+Shift+E, File › Export Image, writes the visible picture in the format the Export panel is set to: PNG, JPEG, WebP or TIFF for a flat result, PSD or OpenRaster when you want the layers, masks and selections to survive into Photoshop, Krita or GIMP. Ctrl+S used to do this; it saves the .scumble document now (the chapter before). You can export at a percentage, at a pixel size, or into a frame of a given size with a background of your choosing, and a single layer or the mask on its own.

A PNG export can carry the prompt, the negative prompt, the seed and the recipe as text inside the file: **Prompt and recipe in the PNG** in the Export panel is on unless you untick it, and it stays as you set it for every document. Anyone who gets the file can read what it carries, and a recipe you imported from your own ComfyUI workflow carries every setting of that workflow, except the ones named like a key, a token, a secret or a password (an API key typed into a node, for one), which are left out. JPEG, WebP, PSD and ORA never carry them. Every PNG export is marked as sRGB, which it is; JPEG and WebP exports carry an sRGB profile.

The AI label panel stamps the EU's icon for AI-generated or AI-modified content onto the picture as a layer of its own, for the day you need to show that a model was involved: move and scale it like any layer, and every export shows it while it is visible.

Every document is a tab, and tabs come back, saved as a .scumble file or not. The session is autosaved and restored at the next start, with no server needed for it, because every image the editor sends or receives is kept locally under %APPDATA%/Scumble/files/ in folders that mirror ComfyUI's own input and output. That is also why a restarted or freshly rented ComfyUI just works: before a run the app uploads what the server does not have.

Closing Scumble asks nothing about unsaved documents. It waits until your last changes are in the session, and for a document save that is still running; on a very large picture that can take a few seconds, and closing again meanwhile asks whether to wait. If the window crashes, it comes back with your documents. Settings › Local files › Earlier states opens the documents of the last two sessions as new tabs, for the day a start did not bring back what you expected.

### Notes

- Large PNGs beyond the browser's canvas limit — up to 65,535 px a side — are opened and written in strips, so they do not need to fit into one canvas.
- PSD export keeps layer names with umlauts and other non-ASCII letters since 0.1.25; before that they became underscores.
- PSD keeps masks as masks: a layer's pixels go out whole and its mask as Photoshop's layer mask, switched off if it is off here, and a PSD's layer masks open as masks you can go on painting (a switched-off one stays off). ORA has no layer masks, so an ORA export bakes each mask that is on into its layer.
- TIFF files open in 8 and 16 bits per channel (16 is rounded to 8), in RGB, grayscale or with a palette, uncompressed or with LZW, ZIP or PackBits compression, stored in strips or tiles; a transparent one keeps its transparency. The first picture of a file with several pages opens. Colour profiles and the orientation tag are not applied, and a layered TIFF from Photoshop opens as its merged picture; the status line says so when it happens. CMYK, floating-point, 32-bit and JPEG-compressed TIFFs are refused with a message saying how to save them instead. A TIFF export is 8 bits per channel, RGB with its transparency as an alpha channel, ZIP compressed; a picture that could pass 4 GB (more than about a gigapixel) has to go out as PNG instead.
- The export runs in worker threads, so the window stays usable while a 15,000 pixel PSD is being written.

## The assistant

<!-- slug: assistant -->
_A chat column that drives the editor for you — on your key, with a card per step, and a question before anything costs money._

![The assistant panel open beside the canvas, with the model picker, the chat list and the input field](https://www.denrakeiw.com/projects/scumble/manual/assistant.jpg "1600x946")

Ctrl+Shift+A opens a chat column next to the canvas. Tell it what you want — "remove the bollard on the left and match it to its surroundings" — and it does it by calling the same commands an external agent would: select, prompt, generate, match, layer by layer. Every call is a card you can open to see exactly what it did.

It runs on your own API key. Anthropic, OpenAI and Google directly, or anything OpenAI-compatible: OpenRouter, DeepSeek, Moonshot, Z.ai, ToAPIs, WaveSpeed, Oxen.ai, or a local server that needs no key at all. The picker groups models by provider and greys out the ones you have no key for. Your own model ids can be added in Settings › Language models, so a model released after this version of Scumble still works.

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
- Agents name reference layers the way you do: list_layers and status give each shown reference its label (img1), set_prompt takes @img tokens and a refs map ({"img1": "\<layer id\>"}) that ties a token to a layer whatever the order, generate returns prompt_sent, the prompt as the model got it, and generate_new says which references went along and as what (on a local recipe its prompt_sent shows the names).
- Only one instance of Scumble runs at a time, headless ones included — a stuck headless instance will keep the window from opening.
- The copied registration starts Scumble without a window when none is open. Add --attach-only after --mcp and the client only drives a Scumble you started: with none open it offers ping alone and says Scumble is not running, and the other tools come with the first call once Scumble runs.

## Large pictures

<!-- slug: large-pictures -->
_Why a 15,000 pixel document still paints at full speed, and the one setting behind it._

![Settings, the Rendering section: the tile engine switch and the memory limits, with the live reading of what the GPU process holds](https://www.denrakeiw.com/projects/scumble/manual/large-pictures.jpg "1600x946")

Scumble keeps the picture, every layer and every mask in tiles rather than in one big canvas, and the pixel work — flood fill, grow and shrink, blur, blending, the match — runs as compiled Rust in worker threads. That is the reason a 15,000 by 10,000 document paints, selects, filters and exports without the window locking up, and why export and selection work happens off the main thread.

The tile engine is on by default. Settings › Rendering has the switch back to the old canvas path, which exists as an escape hatch if something ever looks wrong on your hardware; the app is slower and hungrier that way, but it is there.

Above the browser's canvas limit — beyond about 268 megapixels — pictures are opened and written in strips instead, which is how PNGs up to 65,535 pixels a side and about a gigapixel work at all.

### Notes

- Big documents want memory more than speed. Several open 15k tabs will show in the task manager.
- On a large picture one undo step can hold hundreds of megabytes. The MB limit of the undo history (Settings › Rendering) counts brush strokes and selections only; a whole-layer step (a flip, a rotation, a filter change, a mask, a crop, a restored snapshot) can hold a full copy of its layer and is limited by the number of steps alone, so keep that number low on big documents. Snapshots cost nothing when taken and grow as the picture changes after them.
- If something draws wrong, the first useful test is the Rendering switch: the two paths are the same picture by design, and a difference between them is a bug worth reporting.

## Under the hood: the crop, the Highres fix and the stitch

<!-- slug: under-the-hood -->
_What actually happens between pressing Generate and the layer arriving — and which knob to turn when it comes back soft, or too expensive._

Every inpainting model has a size it works at, and it is small: around one megapixel, four at the very top end. Your picture is not. A 6000 by 4000 photo is 24 megapixels, and the thing you selected in it might be 300 pixels across. That gap is the whole problem of inpainting at photo resolution, and everything in this chapter exists to close it.

The naive answer — scale the picture down, let the model paint, scale it back up — ruins everything outside the selection and gives you a soft patch inside it. Scumble does the other thing: it cuts a box around your selection, sends only that, and puts the answer back at the document's own resolution. Nothing outside the box is ever touched, because nothing outside the box ever leaves your machine.

The box is not the selection. Around it goes context — the surroundings the model needs to match light, texture and perspective — and Scumble works out how much from the selection's own size: roughly a tenth of its diagonal as the feather, a little more as padding, and never a box smaller than 512 pixels. A tiny selection therefore still goes out as a workable picture instead of a postage stamp. You can override all of it in the Crop panel, and Context is the one worth touching: too little and the model has nothing to match, too much and your selection becomes a detail the model stops caring about.

Then comes the part with the odd name. The box gets sent at the size the chosen model actually takes, and that is usually larger than the box's own pixels. Select a 300-pixel bag in a photo and the crop goes out at 1440 or 2048 or 3840, depending on the model: the model paints far more detail than that area of your picture holds, and the answer is scaled back down into the box. The detail survives the scaling down; it would not have survived being invented at 300 pixels. That is the Highres fix, and it is why an inpaint in a big photo does not come back looking like a blurred sticker.

The Highres fix select in the Generate tab decides how far to push it. Maximum, the default, uses everything the model allows. 2x crop and 4x crop send the box at twice or four times its own resolution, still under the model's ceiling — cheaper, faster, and enough when the selection is already large. Target size keeps the number in the node parameters, and Off sends the crop exactly as it is. The ceiling itself is not a guess: every provider variant carries the size rules of its endpoint, the longest side, the rounding step, the smallest side, a pixel budget and a floor, and a crop steeper than the model's allowed aspect gets more context on its short side rather than being refused.

Coming back, the answer is scaled to the box and blended in, not pasted. Scumble builds a composite mask from your selection — grown by a few pixels, then blurred by the feather — so the patch writes at full strength in the middle, fades out at the edge and does not touch a pixel you did not select. This matters most for the models that take no mask at all: GPT Image, Nano Banana, FLUX.2, FLUX 3 Image, Seedream and the rest get the crop and an instruction, they hand back a whole repainted box, and it is this mask that keeps the repaint inside your selection. Then colour match runs if it is on, matching the patch's per-channel mean and spread to the ring of picture around it, and the result lands as a layer at the box's position at full resolution.

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
| Shift+J | Remove (LaMa in the app fills what you brush over) |
| Shift+J (again) | Patch (drag the selection to where the picture is right) |
| Shift+J (a third time) | Content-aware move (drag the selection; LaMa fills where it was) |
| Shift+O | Dodge / burn (and the sponge) |
| Shift+W, Ctrl+Shift+X | Liquify (push, grow, shrink, swirl, restore) |
| G  ·  Shift+G | Bucket fill · gradient |
| Y | Shape tool |
| T  ·  Shift+T | Transform · text |
| C | Canvas frame — drag its edges to crop or extend, outside it to turn the picture; Enter applies, Esc resets |
| Ctrl+drag | Canvas tool: draw along a horizon or a wall to straighten the picture |
| X | Canvas tool: turn the frame's aspect on its side; any other tool: the Boxes tool (boxes in the prompt) |
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
| Tab | Canvas only: every bar and panel goes, the picture fills the screen; Tab or Escape brings them back |

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
| Ctrl+\[  ·  Ctrl+\] | Move the layer down · up the stack, into a group next to it or out of its own; a reference layer steps past the next reference |
| Ctrl+Shift+N | New paint layer |
| Ctrl+J  ·  Ctrl+E | Duplicate the layer · merge it down (several selected layers: merge them) |
| Ctrl+click  ·  Shift+click a row | Add a layer to the selection · select the rows in between |
| Ctrl+G | Put the selected layers into a group |
| Ctrl+Alt+G | Clip the layer to the layer below, or release it |
| Alt+click an eye | Show only that layer (the selected ones), again to show the others |
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

#### In the prompt field

| Key | What it does |
| --- | --- |
| @ | At the start of a word: the list of reference images |
| Up  ·  Down | Move in that list |
| Enter  ·  Tab | With the list open: put the chosen reference in |
| Enter  ·  Shift+Enter | A new line |
| Backspace  ·  Delete | Delete a character, or a reference chip whole |
| Left  ·  Right | Step over a character, or over a chip |
| Ctrl+Z  ·  Ctrl+Y | Undo and redo in the prompt, not in the picture |
| Ctrl+Enter  ·  Ctrl+U | Generate · upsample the prompt, from the field too |
| Escape | Close the @ list or a chip's menu, else leave the field; the editor's keys work again |

#### The app

| Key | What it does |
| --- | --- |
| Ctrl+O | Open a picture or a .scumble document |
| Ctrl+S  ·  Ctrl+Shift+S | Save the document · save it as a new file |
| Ctrl+Shift+E | Export the visible picture (PNG, JPEG, WebP, TIFF, PSD or ORA) |
| Ctrl+T  ·  Ctrl+W | New tab · close tab |
| Ctrl+Shift+T | Reopen the last closed tab |
| Ctrl+Tab  ·  Ctrl+Shift+Tab | Next tab · previous tab |
| Ctrl+, | Settings |
| F1 | This manual, and the chat on it |
| Ctrl+Shift+A | The assistant |
| Ctrl+Shift+K | Your ComfyUI's own page, in a window of its own |
| Ctrl+Shift+L | The console and the log |
| F11 | Full screen |
| Ctrl+R | Reload the window: your last changes go into the session first, and the documents come back |

### Notes

- On macOS every Ctrl here is Cmd.
- **Canvas only** (Tab, or View › Canvas Only) hides the tab bar, the editor's bars, the tools, the side panel and the rulers, and the window goes full screen with the picture fitted into it. Every tool and key still works there. Tab again or Escape brings everything back, with your zoom and the window as they were; while something is pending (a transform, a polygon, a text edit) the first Escape cancels only that. Switching tabs, F11, or opening Help or the assistant ends it too. A question of the assistant still shows over the picture.
- **The side panel's width:** drag its left edge to make it wider or narrower (from 310 px to 60 % of the window); a double click on the edge brings back the default. Every tab shows the same width, and it is kept for the next start.
- A shortcut does nothing while you are typing in a field — the editor only listens when the canvas has the focus. The File menu's keys, Ctrl+S among them, work from a text field too.
- **The app's questions** (Save / Don't Save when a tab closes, Overwrite or Save As, removing a recipe or a helper model) open inside the window, and the editor's keys wait until they are answered: Enter answers the highlighted button, Escape cancels, the arrow keys move between the buttons, and a question that deletes something starts on Cancel.
- Plugins can add shortcuts of their own; the Plugins menu shows what each one bound.
- The same editor in the ComfyUI node Inpaint Canvas keeps its old keys: Ctrl+S exports the picture there, and Ctrl+Shift+E merges down like Ctrl+E.

## Settings, updates and when something goes wrong

<!-- slug: settings-and-trouble -->
_What is in the settings dialog, how updates work, and the three things to check before reporting a bug._

![The console window over the editor, with the filter by level and text and the path of the log file](https://www.denrakeiw.com/projects/scumble/manual/settings-and-trouble.jpg "1600x946")

Ctrl+, opens the settings: the ComfyUI server and its authentication, API providers, language models, recipes, helper models, the assistant, the appearance, plugins, local files, rendering and updates. Most of it you set once.

Settings › Appearance switches the app's look: the default, 90s, Duck or a skin you add (docs/SKINS.md); View › Skin does the same from the menu, and View › Skin › Default brings the default back if a skin makes the app hard to read. A skin recolours the app's questions too, but cannot hide them or change the order of their buttons.

Updates come from GitHub releases. A few seconds after the start the app looks for a new version and downloads it in the background (Settings › Updates switches the check off). Once it is downloaded, a question names the version and what changed since yours, one line per change. Restart and update saves your documents, installs it and starts the new version with them. Later installs it when you close Scumble. Skip this version leaves it out until a newer one comes; closing Scumble then installs nothing. The question comes once per start and waits while you draw, type or answer another question; a key you were still typing answers Later. When a restart would end a run, the assistant's turn or an agent's session, it asks first. The Update button in the title row and Settings › Updates, which has the whole release notes of every version since yours, install a downloaded version at any time, a skipped one too. Nothing is installed while you are working. The copy from the Microsoft Store is updated by the Store.

When something misbehaves: Ctrl+Shift+L opens the log, which is also written to a file. The status line under the canvas carries the last thing that happened, including the reason a run was refused — a missing key, a server that did not answer, a size a provider would not take. And the changelog says what changed in the version you are on, which is often the answer by itself.

Scumble is at 0.1.x and it says so. Not every path has been tested end to end; the API providers in particular are written from their documentation and only some have run against the live service. Keep backups of pictures you care about, and report what breaks in the issues — a bug with a picture and a version number attached is a bug that gets fixed.

### Notes

- Keys are never written into a settings file, so a settings file you share holds no secrets — but check anything you paste from the log before you post it.
- Issues: github.com/DenRakEiw/scumble/issues. The version is in the About dialog and in the log's first line.
