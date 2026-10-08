# The tutorial material: the picture, the screenshots, the video

The manual is written (the website repo `F:\portfolio_web`, `lib/scumble-manual.ts`, 14 chapters).
What is still open is everything visual: which picture the tutorial is built on, which screenshots
each chapter gets, and the video. This file holds the decisions and the script so the next session
does not start from scratch.

## 1. The picture

Everything — the manual's screenshots, the video, the front page — should use **one** picture.
A reader who sees the same scene in chapter 3 and in the video at minute two knows immediately
what changed; a new picture per chapter costs that for nothing.

### Decided (2026-09-22, the user): the pictures are the user's own

All three pictures the tutorial uses were **made by the user** — so there is no licence, no
model release and no third-party photographer in the way. They live in `docs/images/tutorial/`:

| File | What it is | Where it is used |
| --- | --- | --- |
| `scene.jpg` | The woman in front of the blue Porsche, 2000 x 1125 | The tutorial scene: every screenshot and the whole video |
| `skin.jpg` | The close-up with the plastic film and the beads, 1500 x 2000 | The filter / film pack / retouch chapter |
| `titlecard.jpg` | The painted smile in the dark, 1333 x 2000 | The video's title card and the hub page |

**Why the Porsche picture carries the tutorial and the two portraits do not.** It is the only one
of the three that can teach every chapter in one frame:

- The handbag stands free in the foreground — object hover, and a thing that can be named
  ("the handbag") for selection by text.
- The sky is one large flat area — the magic wand, and room for a generate with space around it.
- Hard sun on the wall and deep shade under the car — a patch that visibly does not fit until
  colour match is pulled up.
- Empty paving at the bottom and sky at the top — somewhere for extend canvas and outpainting.
- The wheel, the headlight and the bag's chain — detail for the upscale chapter.
- And it is **16:9**, so it fills the editor's canvas area. The two portraits are upright: in a
  16:9 window they sit as a narrow strip with grey either side, in every screenshot and for the
  whole video. Both are also close-ups against near-black, which leaves nothing to select, nothing
  flat to fill and almost no surrounding colour for the match to work against.

`skin.jpg` earns its place where it is strongest: grain, halation, split toning and the retouch
tools read on skin texture far better than on car paint and concrete.

### Done (2026-09-22): the marks are removed, `scene-clean.jpg` is the base

Four runs of **GPT Image 2.5 Flare through OpenRouter**, in the app, on the dev instance:

| # | What | Selection | Seconds | Cost |
| --- | --- | --- | --- | --- |
| 1 | The Balmain band, PARIS and the monogram on the shirt | 900, 276, 238 x 160 | 31.6 | $0.0865 |
| 2 | The Chanel double-C on the necklace, now a plain gold oval | 1012, 244, 54 x 50 | 23.4 | $0.0522 |
| 3 | The lettering on the left sock | 638, 778, 114 x 88 | 25.1 | $0.0402 |
| 4 | The lettering on the right sock | 1216, 860, 112 x 82 | 51.0 | $0.0402 |

**$0.22 and about two minutes for all four**, default crop settings, no colour match needed: no patch
edge is findable at 1:1, the folds and the light carry through, the hair and arm edges survived.
The result is `docs/images/tutorial/scene-clean.jpg`; `scene.jpg` keeps the original so the removal
can still be shown as the opening demo.

**Worth knowing for the opening:** it is four marks, not one — shirt, necklace, two socks. That is
better for the video than a single edit: four short runs in a row, each one a sentence long, and at
the end the picture is clean.

### Why the removal stays in the tutorial

The Balmain wordmark is readable on the shirt and on both socks, and it is a brand in what will be
a promotional video, whoever made the picture. So **the tutorial's first exercise is removing it** —
select the lettering, generate, done. That is the core feature in its simplest form, it makes a
good opening shot ("watch this"), and from minute one everything after it runs on a mark-free
picture. Every screenshot uses the cleaned version; `scene.jpg` keeps the original so the removal
can be shown.

## 2. The screenshots

Once the picture is decided, the screenshots can be produced from a running instance in one pass
(the app under CDP, `tools/cdp.py shot`, or the `screenshot` command). One per chapter, at the same
window size, same zoom, same theme:

| Chapter | The shot |
| --- | --- |
| Install and first start | The empty first window with one tab |
| Where it renders | Settings › API providers with a key row, and the top bar connected |
| Your first edit | The lettering on the shirt painted over, the prompt typed in |
| Selecting | Object hover with the outline on the handbag |
| Recipes | The recipe picker open, the Settings panel below it |
| Layers and colour match | The result layer at Match 0 % and at 100 %, side by side, as one image |
| Filter layers | The stack with a grain and a film look layer |
| Text, shapes, objects | A text layer and a shape over the picture |
| Upscaling | The Upscale dialog over a selection on the headlight |
| Saving and exporting | The Export panel with PSD chosen |
| The assistant | The panel mid-turn with a question card open |
| Agents and plugins | Help › Copy MCP registration, or a client driving the app |
| Large pictures | Settings › Rendering, or the status line on a 15k document |
| Settings and trouble | The log window (Ctrl+Shift+L) |

The manual's `Chapter` type already has an optional `shot` field (`src`, `alt`, `width`, `height`),
so a screenshot is one line per chapter, added whenever it exists. The page renders without them.

## 3. The video: "Scumble, explained by someone who did not ask"

A Q&A explainer, two voices, about three minutes. **She** uses the app and answers; **he** is the
sceptic with a subscription and opinions about AI. He asks what everybody asks; she answers in one
sentence and shows it. The jokes come from him being wrong in a friendly way, never from her
being clever at his expense.

Screen: the app, the whole time, on the tutorial picture. Faces are not needed — two voices over
the screen recording is enough, and much cheaper to make.

Timing is a guide, not a rule. Directions in italics.

---

**COLD OPEN (0:00–0:12)**

*The picture open in Scumble. Nothing has happened yet.*

**HIM:** So this is your Photoshop.

**HER:** It's my inpainting editor.

**HIM:** That's a Photoshop with extra words.

**HER:** It's a Photoshop that can paint the bits you don't want. Watch. *(paints over the lettering
on the shirt, types "plain black t-shirt", Ctrl+Enter)*

**HIM:** ...and what do I do while it—

*The lettering is gone. Plain black shirt, same folds, same light.*

**HIM:** Okay.

**TITLE CARD: Scumble. Free, open source, and that took four seconds.**

---

**Q1 — "Where does my picture go?" (0:12–0:40)**

**HIM:** Right. So which company owns that picture now.

**HER:** Nobody. It went to my own ComfyUI. That box under the desk.

**HIM:** And if I don't have a box under the desk?

**HER:** Then you put an API key in the settings and it goes to whichever model you picked. Your key,
your bill, no account here. *(Settings › API providers, the key rows)*

**HIM:** Where does the key live?

**HER:** In Windows' own credential store. Not in a text file you email to yourself.

**HIM:** I would never.

**HER:** You did. In March.

---

**Q2 — "How does it know what I mean?" (0:40–1:10)**

**HIM:** How does it know I meant the shirt and not the whole person?

**HER:** Because I told it. Seven ways to tell it. Brush, rectangle, ellipse, lasso, magic wand—
*(hovers the handbag; the outline snaps around it)*

**HIM:** Oh. It just knows what the bag is.

**HER:** That one runs inside the app. Nothing leaves the machine for it. Or — *(types "her
sunglasses" into the text field, presses Go; the sunglasses are selected)*

**HIM:** You just typed a word at it.

**HER:** I just typed a word at it.

**HIM:** I have been drawing around things with a mouse since 2004.

**HER:** I know. I watched.

---

**Q3 — "Why does mine always look pasted in?" (1:10–1:45)**

*A fresh result over the handbag: the new bag is red now, and a shade colder than the sunlit
paving around it. The edge of the patch is findable.*

**HIM:** There. That. That's why I don't use these things. It looks stuck on. Like a plaster.

**HER:** Right, and this is the part I'd keep if you took the rest of the app away. *(drags Match
from 0 to 100; the patch settles into the picture)*

**HIM:** ...What did that do?

**HER:** Matched its colours to what's around it. One slider, in the layer's own row, and it's not
baked in — I can move it back tomorrow.

**HIM:** Tomorrow.

**HER:** It's a layer. Everything here is a layer.

---

**Q4 — "What if it's terrible?" (1:45–2:05)**

**HIM:** What if it gives me a handbag with five handles.

**HER:** Then I delete the layer and my picture is exactly as it was. *(deletes it; the blue bag is
underneath, untouched)* Or I press Generate again, get another one, and compare the two.

**HIM:** And if you've done forty things by then?

**HER:** Ctrl+Z. It's a real undo stack, not one step and a shrug.

---

**Q5 — "Can it make it bigger?" (2:05–2:25)**

**HIM:** Can it make this bigger? Properly bigger. For print.

**HER:** Pick an upscaler, pick the selection or the whole picture, pick a factor. *(selects the
headlight, opens the Upscale dialog)* The selection comes back as a sharper layer; the whole
picture becomes the new picture.

**HIM:** How long?

**HER:** Twenty-five seconds on one of them. Five minutes on another.

**HIM:** Which one's five minutes?

**HER:** It tells you while it runs. I got tired of wondering too.

---

**Q6 — "Can I just tell it what to do?" (2:25–2:55)**

**HIM:** Right, but can I just... say it. Out loud. Like a person.

**HER:** *(Ctrl+Shift+A, types: "take the handbag out of the picture and match it to the ground")*
Like that. It drives the same editor I do — same commands, one card per step, you can open any of
them and see what it actually did.

*A question card appears: Allow / Don't.*

**HIM:** Why is it asking permission?

**HER:** Because that step costs money. Anything that costs money, queues on my server, or touches a
layer that isn't its own, it asks first.

**HIM:** And if it does something stupid?

**HER:** Undo this turn. Puts everything back, even if the turn was longer than the undo stack.

**HIM:** ...That's better than most people.

---

**CLOSE (2:55–3:15)**

**HIM:** Fine. What does it cost.

**HER:** Nothing. It's free software, GPL, the source is on GitHub.

**HIM:** What's the catch.

**HER:** Version 0.1.

**HIM:** Meaning?

**HER:** Meaning it works, I use it every day, and some of it has never been tested by anybody but
me. Keep backups. Tell me what breaks.

**HIM:** ...And *that's* how you get me to use it.

**HER:** That's how I get you to report the bugs.

**END CARD: github.com/DenRakEiw/scumble · Download for Windows and Linux · Manual, videos and the
dev blog on denrakeiw.com/scumble**

---

### Production notes

- **Language:** English, like the site and the README. A German version is a straight translation —
  the jokes survive it, "Version 0.1" is funny in both.
- **Voices:** two people reading is best. If not, two text-to-speech voices work for this format;
  the ElevenLabs-style tools in the toolbox can do it, but a real reading is worth the hour.
- **The picture:** `docs/images/tutorial/scene.jpg` throughout; `titlecard.jpg` under the title and
  the end card; `skin.jpg` only if a filter shot is cut in.
- **Recording:** the app at 1600 x 950 or so, the same window size as the screenshots, mouse
  movements slow and deliberate. Cut the waiting: a generate that takes 20 seconds is 2 seconds of
  video with a cut.
- **Length:** if it runs past 3:30, Q5 (upscaling) is the one to drop — it has its own video later.
- **Where it goes:** `public/scumble/videos/` in the website repo, self-hosted like the rest of the
  site's media; one entry in `videos` in `lib/scumble.ts` with a poster frame, and the videos card
  on the hub stops saying "In preparation" by itself.
- **Addresses:** on the end card without `https://` (nobody clicks a picture, the line reads larger);
  in the video's description in full, `https://github.com/DenRakEiw/scumble`, so it is a link everywhere.
- **The honest line stays in:** the version number, "keep backups", "tell me what breaks". It is the
  README's voice, and it is why people trust the rest of it.

### Later videos, one feature each (60–90 s, no dialogue, just doing it)

1. Object hover and selection by text
2. Colour match, the before and after
3. Outpainting: extend the canvas and fill it
4. The film pack over a result
5. The assistant doing a real job end to end
6. PSD out, into Photoshop, layers intact

### Intro and outro with the mascot (2026-09-23)

Every tutorial video opens and closes with the same two clips, made by the user with FLUX 3
(image to video, in Discord, so a prompt stays under 2,000 characters). They are in
`docs/images/video/`:

| File | What it is |
|---|---|
| `intro.mp4` | 8 s: the drop lands, the mascot looks to the right and waves; the right half stays empty for the title, set in the edit |
| `outro.mp4` | 10 s: the mascot comes closer, a second stroke crosses the first, it waves and fades out like a glaze; from about 6 s only the cream X and a falling drop are left, for the end card |
| `klecks_left_1280x720.png`, `klecks_center_1280x720.png` | The start frames: the mascot from the website's share image on the plain background (#1F120D), the title text taken out |
| `keyframe_tutorial_a.png`, `_b.png` | Start frames for a 20 s concept clip (the mascot glazes a coffee stain off a still life), Nano Banana Pro with the mascot as reference; not made into a video yet |

What was learned: text to video made the mascot caramel brown, which reads as something else
entirely; image to video from the website's mascot keeps the colour, the outline and the
translucency. No text in the clips (titles and URLs go in in the edit), and FLUX 3 answers
1920 x 1088, so crop to 1080 before the cut.

### Video 1 as made (2026-09-24)

Recorded from the app over CDP (`docs/images/video/rec/`: `recorder.py` screencasts the page with a drawn
cursor, `scenes.py` runs each scene at the pace of its dialogue and marks where each line starts,
`plan.py` builds the Resolve timeline from the marks), voiced with Gemini 3.8 Flash TTS
(`docs/images/video/voice/`: HER a designed voice, HIM the prebuilt Achird; `split_lines.py` cuts a
scene's dialogue into lines, `check_lines.py` transcribes each line back and compares it with the
script), cut in DaVinci Resolve (project "Scumble Tutorials", timeline "01 Scumble explained").
Changes from the script above: Q3 and Q4 use a patch on the paving instead of a red handbag (Match 100
on the red bag pulls it towards the blue car; with "underneath" the paving patch settles), and the
close carries lower thirds instead of an About dialog (it is a native menu item the screencast cannot
see). 4:40, live on https://www.denrakeiw.com/scumble/videos since 2026-09-24 and linked from the README.

## 4. Video 2: "Scumble, part two: he has more questions" (draft, not recorded)

Same two voices, same intro and outro. He has used it for a week now and comes back with the things
a working artist asks. About four and a half minutes. Every claim below is checked against the code
(the fact sheet of 2026-09-24); the lines marked **check** are not yet.

---

**COLD OPEN (0:00–0:20)**

*A terminal on the left, Scumble on the right, the clean scene open. The title bar says nothing yet.*

**HIM:** Right. I've been thinking.

**HER:** Oh no.

**HIM:** Your editor. Does it talk to Claude?

**HER:** Other way round. Claude talks to it. *(types into the terminal: "In Scumble: add a CineStill
800T film look, put the word SCUMBLE top left in white, and export it as a PSD to my desktop")*

*The Scumble title bar reads "Scumble · 1 agent connected". A film look layer appears, then the text,
then the status line reports the export. The terminal lists the calls it made.*

**HIM:** ...It's clicking around in there.

**HER:** It isn't clicking anything. Same commands I use, about seventy of them.

---

*INTRO (the mascot clip with the title)*

---

**Q1 — "So Claude runs my editor now?" (0:30–1:05)**

**HIM:** How did it even find your app?

**HER:** One line. Help, copy MCP registration, paste it into Claude Code. *(Help menu, the item,
the terminal with `claude mcp add scumble ...`)*

**HIM:** And it sees what I see?

**HER:** Same window, same tabs, same undo. If Scumble isn't open, it starts one without a window
and works in there.

**HIM:** And if it deletes everything?

**HER:** Ctrl Z. It's still my undo stack.

---

**Q2 — "Why does AI stuff always look so clean?" (1:05–1:40)**

**HIM:** Why does everything AI look so... clean? Like it's been microwaved.

**HER:** Because nobody puts grain on it. *(opens Film looks at the end of the Image tab, clicks
CineStill 800T; the halation blooms around the highlights)*

**HIM:** Oh, that's nice. Is that baked in now?

**HER:** It's a layer. *(toggles the layer's eye, drags its opacity)* Forty-six film stocks, grain,
halation, curves, a LUT if you have one. Give it a mask and it only touches her.

**HIM:** Forty-six.

**HER:** Forty-six. I have a problem.

---

**Q3 — "It's too tight. I need a banner." (1:40–2:20)**

**HIM:** It's too tight. The client wants a banner. Wide.

**HER:** *(canvas tool, drags the frame's left and right edges outward; the new border is selected
by itself; Generate)* Then it's wide.

*The border fills: more of the white building, more paving, the same sun.*

**HIM:** It just... made up the rest of the building.

**HER:** It made up the rest of the building. One thing: extending flattens what's visible into the
new picture. So I do this before the layers, not after.

**HIM:** Noted. Never.

---

**Q4 — "And if I don't have a picture?" (2:20–2:45)**

**HIM:** And if I don't have a picture at all?

**HER:** Generate new. *(the button, the dialog, types "a red vintage motorcycle in a white gallery,
hard sunlight", Generate)* A picture from the prompt, and then you're back to editing it.

---

**Q5 — "My client needs a PSD." (2:45–3:25)**

**HIM:** My client only takes PSDs. Of course.

**HER:** *(Export, format psd, Save as; Photoshop opens the file, the Layers panel shows every
layer)* There.

**HIM:** With the layers?

**HER:** Names, opacity, blend modes, the lot. Filter layers get baked into the picture, Photoshop
doesn't have them. And a PSD opens back in here with its layers too.

**HIM:** So I can lie to my client about which program I used.

**HER:** I didn't hear that.

---

**Q6 — "I have my own ComfyUI workflow." (3:25–3:55)**

**HIM:** I spent three weekends on my ComfyUI workflow. I'm not giving that up.

**HER:** Don't. Put an Inpaint Canvas node in it and import it. *(Settings › Recipes › Import workflow;
the new recipe in the list, its settings in the Generate tab)* Now it's a recipe, with its own
settings, right here.

**HIM:** Three weekends.

**HER:** One click. Sorry.

---

**Q7 — "My files are huge." (3:55–4:15)**

**HIM:** My files are fifteen thousand pixels wide. Everything chokes on them.

**HER:** *(a 15,000-pixel document, zoomed in, panned, a brush stroke, no stutter)* This doesn't. Up
to sixty-five thousand pixels a side.

---

**CLOSE (4:15–4:35)**

**HIM:** Right. And when I'm stuck and you're not there.

**HER:** F1. *(the Help column opens beside the canvas; she types "how do I extend the canvas?", the
answer comes with its chapter)* The whole manual, and a chat that only answers from it.

**HIM:** ...It's nicer than you.

**HER:** It's cheaper than me.

*OUTRO with the end card.*

---

### Production notes for video 2

- **Recording:** scenes inside the app as in video 1 (screencast, drawn cursor). **Three scenes need
  a desktop capture** (ffmpeg `ddagrab` of a screen region, the user away from mouse and keyboard):
  the cold open and Q1 (a terminal beside Scumble, a native Help menu), Q5 (Photoshop). A native
  `<select>` popup and file dialogs do not show in the screencast either, so Q6 imports by the
  Settings dialog's own list, not the recipe picker's popup.
- **The Claude Code run** in the cold open is real: the scumble MCP server registered for that
  session, pointing at the recording instance. **Check** how the launcher reaches an instance started
  with its own `--user-data-dir` (the proxy finds the running app by its local socket).
- **Costs:** the outpaint and Generate new runs (a few cents each on OpenRouter), the Claude Code
  turn, the help chat question (about a cent), the voices.
- **Q7 needs a real 15k picture.** The tutorial scene is 2000 px wide; blown up it would look soft at
  1:1. Either one of the user's own large files or a real upscale of the scene (Topaz or Magnific,
  a few cents) — the user's call.
- **Check before recording:** `docs/MANUAL.md` says masks and selections survive into PSD/ORA; the
  writer bakes a mask into the layer's transparency and writes no selection. The Q5 line says only
  what the code does; the manual line needs a fix of its own.

### Video 2 as made (2026-09-25, overnight)

4:31, `dist/video/edit2/02_scumble_part_two_v1.mp4` (web encoding `web_crf25.mp4`, 19.9 MB, poster
`poster.jpg`); Resolve timeline "02 Scumble part two" in the project "Scumble Tutorials". **Not online**:
waits for the user's look. Recorded like video 1 (`scenes2.py`, `plan2.py`), except three takes that
are desktop captures (ffmpeg `ddagrab`, no system cursor): the cold open and Q1 (Claude Code in a
Windows Terminal window of its own beside Scumble, `term.ps1`, `take_mcp.py`, `desk.py`) and Q5's
middle part. Changes from the script above:
- **Cold open:** the prompt is "... save it as a PSD in this folder"; Claude looked at the picture and
  added an outline to the white text on its own. Its summary claims an ORA would keep the film look
  editable; the ORA writer bakes filter layers too (not cut out; small in the terminal).
- **Q3:** FLUX.1 Fill [pro] (BFL). GPT Image 2.5 Flare was refused by OpenAI's safety system on the
  crop (the legs again), Nano Banana 2 and a 384 px context invented unrelated scenes; the prompt is
  set after the extension. The wait (23 s) is cut.
- **Q5:** not Photoshop — the user's Photoshop had their own document open, so nothing was opened
  there. The PSD is shown in **Krita** (a fresh instance, closed afterwards), then reopened in Scumble.
- **Q7:** the scene upscaled 4x by Magnific Precision (sublime) to 8000 x 4496 (1260 credits; 8x was
  refused), then Lanczos to 16000 x 8992. The zoom is a scripted view tween: the wheel zoom plus F left
  the view off the canvas (a real editor quirk worth a look: after wheel zooms, `fitView` via F put the
  view at x -1884, y -1579).
- **Title card:** "Scumble · Part two: he has more questions."
- **Found on the way:** a tab renames itself to the base's file name after Extend canvas
  ("n4_base_..."); offered as a separate task.

## 5. Video 3: plan (draft, 2026-10-05, nothing recorded)

The user, 2026-10-05: "lass uns jetzt tutorial 3 planen", with better motion design (references: the launch clip
Lighthouse Academy made for the user, `C:/Users/schoeneberg/Downloads/Scumble_Launch_4x5_v4.mp4`, and a page of
motion-graphics examples), "behalte aber unseren lustigen dialog style". Planned by one workflow (five studies, three
concepts, one judge; read only). Part two is live (4:03); the "not online" note above is out of date.

### What the launch clip does that ours do not

45 s, 4:5, 60 fps, music only (120 BPM, -11.8 LUFS), motion graphics around real canvas footage. Brand system:
background #1E130D (corners #140D07) with a vignette and fine grain, orange #C7613A, cream #FFF8EF, a semibold sans
headline with the key word in orange, a letter-spaced mono eyebrow ("YOU GET · 01 / 06"), a thin orange progress line at
the bottom. Five things ours lack: one idea per beat in 2-5 words on screen; the picture big enough for a phone (the
canvas cropped out of the UI into a rounded card; the full app only when the UI is the point); every change animated
with easing, nothing static for more than about 2 s; one signature transition (a slanted orange panel, about 0.35 s)
that always means "new chapter"; music cut to the edit, dropping out under the key line. Results are revealed by a
glowing orange scan line, numbers count up (20 -> 46 film stocks), punchlines get a full orange card.
Our videos 1 and 2: the whole 1600 x 900 window for 4-5 minutes, hard cuts only, no zoom, no music, no sound effects,
UI text about 13 px in the 1080p master.
Not taken over: 4:5, 60 fps, -11.8 LUFS, the clip's music (licence unknown). Whether its design system (colours, wipe,
layout) may become the series look is the user's question (made for the user, rights never confirmed).

### The style stays (from sections 3 and 4)

HER and HIM, no names, English, no faces. She uses the app and answers in one sentence while she shows it; he is the
sceptic, wrong in a friendly way, never the butt of her cleverness. Each beat: his concrete complaint, her one-liner
over a live demo, his stunned "...Oh." or an echo, her dry tag; she has the last line. HIM's lines a median 6-7 words,
HER's 8-13. Running gags: the client, his past exposed, her confessions ("Forty-six. I have a problem."), "It's a
layer", "I didn't hear that." Motion lands on HER's demo beats and leaves HIM's jokes room: never zoom or whoosh over a
punchline; a beat of silence and a still frame make it land.

### Recommended concept: "Scumble, part three: the client has notes"

He has a client: one café poster, six notes, one picture from an empty canvas to a print-ready file; every note is one
feature and lands as a layer on the same picture. The canvas stays in a big card; a strip of "coats" (one thumbnail
per note) grows along the bottom, so the viewer watches one transformation, and the name pays off at the end ("A thin
coat over a dry one." / "I thought it was a sneeze." / "Bless you."). Scripted about 4:20, expect 4:45-5:00; 16:9,
30 fps, about -14 LUFS.

| Time | Beat | Screen | Motion |
|---|---|---|---|
Revised the same day with the user's answers (see "Decided" below): every model run is FLUX 3 Image, spoken of
warmly; no in-app LaMa (Remove, Content-aware move); the Realism Pass is shown, and nothing names its vendor or
technique.

| Time | Beat | Screen | Motion |
|---|---|---|---|
| 0:00-0:24 | Cold open "Brief" | blank 16:9 canvas, three New boxes (a sleeping ginger cat on the window sill; a green bin by the door; the café's sign reading "Café Klecks" over the door), each described by double click; Generate new on FLUX 3 Image (BFL) | card scales in, client chat bubble, follow-cam on the drags only, numbered circles in each box's colour, ramp with "x16" badge, per-box scan line in its own colour, music drop on "The cat's in the box." |
| 0:24-0:28 | Title | last 4 s of intro.mp4, letters rise | "notes" in orange |
| 0:28-1:02 | Note 01 "Our cup" | a cup photo as reference img1 (a prop made with FLUX 3), a From reference box, "their cup from @img1", FLUX 3 Image | photo chip flies onto the layer, spotlight, push-in on the prompt, scan line, cost pill counts the real charge |
| 1:02-1:38 | Note 02 "Who put a bin there?" | a Remove box on the bin and a Move box from the cat to the left end of the sill, one FLUX 3 edit; fallback: the Remove box alone | quote card "A BIN OR SOMETHING. · YOU, 09:14", the two boxes in their colours, scan line per box, stamp "It didn't mind." |
| 1:38-2:12 | Note 03 "A barista. Human." | a selection behind the counter, "a barista with freckles, laughing, wiping the counter", FLUX 3 Image (the selection goes as one box) | ramp, slow push-in on the face, a small callout on the freckles |
| 2:12-2:52 | Note 04 "Printer says twice the size" | Upscale, the Realism Pass at 2x on the user's ComfyUI (about 10 s on the RTX 5090) | size counter rolls to the new size, before/after divider at full resolution, reactions on a still frame; no lower third with the label, the camera stays on the picture |
| 2:52-3:14 | Note 05 "More analog vibe" | a film look, the filter layer's eye | counter "46 FILM STOCKS" lands on "Forty-six.", stamp "Different grain. Mine." |
| 3:14-3:40 | Note 06 "Can we see the first one again?" | each note's layer hidden, then shown again (recordable per note; snapshot restores only if a test across the 2x resize works) | timestamp rolls to 23:48, flip-book rewind along the coat strip |
| 3:40-3:56 | The stack | the real layers (export_layer) | CSS 3D exploded stack, names on leader lines (cut first if long) |
| 3:56-4:13 | Close | Export PNG | cost tally (the real charges), stamp |
| 4:13-4:20 | Outro | outro.mp4 from 3.0 s, end card | progress strip completes |

Sample lines (draft; the script is written from these):
- **Cold open.** HIM "I have a client." / HER "Congratulations." / HIM "A café poster. Cat in the window, their name
  over the door. ...Make it look lived-in. A bin or something." / HER "And the picture?" / HIM "...There isn't one." /
  HER "Then I'll draw where things go." / HIM "You can't just draw rectangles at a model and expect—" / HER "This one
  reads rectangles." / HIM "...The cat's in the box." / HER "The cat's in the box." / HIM "They'll have notes." / HER
  "They always have notes."
- **Note 01.** HIM "They love it. They want their own cup in it." / HER "Send me the cup." / HIM "It's a photo. From
  their phone. On a radiator." / HER "Then it's a reference. I only take the cup. The radiator stays in their kitchen."
  / HIM "What's the little picture in the sentence?" / HER "That's the cup. It tells FLUX which picture I mean." / HIM
  "...That's their cup." / HER "Their cup. Their handle. Their very specific beige."
- **Note 02.** HIM "They want to know who put a bin there." / HER "You did. 'A bin or something.'" / HIM "...Lose the
  bin. And the cat is 'crowding the name'." / HER "One box takes the bin out. One box moves the cat." / HIM "You moved
  a cat with a rectangle." / HER "It didn't mind."
- **Note 03.** HIM "Now it feels empty. They want a barista. 'Friendly. Human.' In capitals." / HER "Behind the
  counter, then." / HIM "Is she done?" / HER "She's doing her hair." / HIM "...Freckles. Did I say freckles?" / HER
  "The client said freckles. FLUX listened." / HIM "She looks like she likes her job." / HER "She just started."
- **Note 04.** HIM "The printer wants it twice the size." / HER "Then the last coat goes on at twice the size." / HIM
  "Does that run on my laptop?" / HER "Only with the right graphics card, Windows and your own ComfyUI. It tells you
  before it sends anything." / HIM "...I can count her freckles." / HER "Twenty-three. I counted."
- **Note 05.** HIM "Now they want 'analog vibes'. ...Don't say forty-six." / HER "Forty-six." / HIM "You just made it
  twice as sharp, and now you're adding grain." / HER "Different grain. Mine."
- **Note 06.** HIM "Ten to midnight. 'Can we see the first one again?'" / HER "The first one." / HIM "...With their
  cup. Without the bin. With the barista. And the grain." / HER "So, this one." / HIM "So this one."
- **The stack.** HER "Every note went on as a layer, over the one before. That's what a scumble is. A thin coat over a
  dry one." / HIM "I thought it was a sneeze." / HER "Bless you."
- **Close.** HIM "Export it before they wake up." / HER "Done." / HIM "What did all that cost me?" / HER "A few runs on
  my key. Less than the coffee." (checked against the real charges) / HIM "I'll tell them it took all week." / HER "I
  still didn't hear that."

Rules: one transition style (the wipe, only between notes); the scan line only for model results; at most three
stamps; follow-cam only on drags; no full captions (subtitle track); HER / HIM pills bottom left at each line start.
FLUX is named warmly or not at all, never as the cause of a problem; the Realism Pass never with its vendor or technique
(not in the lines, the overlays, the description or the chapters; the app's own label on screen stays as it is).
Record each note on its own from a saved .scumble, so a failed paid run costs one note, not the chain.
Cut order past 5:00: the stack's orbit, Note 05 to its counter beat, the Move box in Note 02.

The other two concepts (scored lower): "he missed fourteen updates" (a quiz countdown of the best new features: most
features, most modular, but a list shape that drifts from the question-led style; its per-box reveal, key overlays,
shorter bookends and modular takes are grafted above); "he has people now" (agents do the work, he only clicks Allow:
in character, but video 2 already opened with an agent, the agents' output cannot be scripted before the voices, and
it reverses the voice-first pipeline).

### Building blocks (in build order; nothing built, the scratch prototypes are not in the repo)

1. A recorder copy (rec3) that logs cursor x / y / t and clicks (recorder.py:106-133 computes them, writes nothing) and
   the DOM rects of the targets per mark; an orange click ring with a pulse (recorder.py:25). One check first: does the
   screencast grow with `--force-device-scale-factor=2` and a larger maxWidth (recorder.py:38)? Push-ins above 1.25x
   depend on it.
2. An HTML / CSS overlay renderer over CDP (every animation paused and seeked per frame, transparent PNG to ProRes 4444;
   a 30-frame prototype worked): brand frame, eyebrow, speaker pills, the wipe, the chat bubble, cost pill, coat strip,
   key overlay, callouts, stamps, counters, lower third. Fonts Inter and JetBrains Mono (OFL, the website's).
3. A camera pass on ffmpeg `libplacebo` (per-frame sub-pixel crops, eased; `zoompan` stair-steps and is ruled out) with
   the rounded media card on the brand colour, targets from the click and rect logs.
4. Speed ramps by rescaling frames.txt durations, with the "xN" badge (Resolve's SetSpeed is constant only).
5. Reveals: the scan line, per box in its palette colour, the before / after divider.
6. The audio pre-mix in ffmpeg: a music bed the user may publish, ducked about 20 dB under a dialogue stem, drop-outs
   before punchlines baked in (Resolve 21.1 has no volume keyframes), sound effects from the click log; voices raw;
   master about -14 LUFS, -1 dBTP.
7. plan3.py: one JSON edit list and a Resolve interpreter on AppendToTimeline (as plan.py:110 / :120); tracks V1 picture,
   V2 frame and overlays, V3 wipes and stamps; A1 HER, A2 bookends, A3 HIM, A4 bed, A5 effects; AddMarker per note for
   YouTube chapters.
8. The exploded stack (CSS 3D), last, the first thing to cut.
Estimate: about 3.5 days for the ffmpeg and HTML path, plus the recording and the voices.

### Decided (the user, 2026-10-05)

- **The concept "the client has notes"** ("ok").
- **FLUX 3 for every model run**, the cold open included ("nee, mit flux 3"). The user is on friendly terms with Black
  Forest Labs: speak of FLUX warmly or use another model, never blame it ("sehr wohlwollend ausdrücken"; the barista
  stays on FLUX 3, "aber halt nicht schlecht reden"). The skin joke ("candle", "ironed her") is out.
- **No in-app LaMa on camera** ("nicht so gut, eher nicht zeigen"): Remove and Content-aware move both fill with it
  (inpaint_canvas.js:5404, :8157); Note 02 uses FLUX 3's Remove and Move boxes instead.
- **The Realism Pass is shown, without naming NVIDIA or DLSS** ("ja zeigen nur nicht nvidia und dlss nennen"). In a run
  that works the app shows only its label "Realism Pass (Windows only, RTX only)" and the mode "2x"; the texts that
  name the technique are error hints (renderer/editor/realism.js:205-231), so a failed take is cut, never shown.
  **Corrected by the fact check (2026-10-05):** the Upscale dialog names the technique even when the pass is ready (its
  help paragraph, renderer/index.html:245, and the entry's note, shell.js:1586; the Style / Strength / Preset tooltips),
  and so do Settings › About and the ComfyUI status tooltip: the dialog is never on camera (section 6, Note 04).
- **Not the Comfy Dev Platform Challenge entry**: the challenge gets a video of its own ("dafür machen wir ein extra
  video").
- **Budget for paid runs: at most $14.** Planned about $2-4: FLUX 3 on BFL costs about $0.05 (1k) to $0.10 (2k) a run
  (docs/PLAN_FLUX3.md:249, :268; half price until October 8), about 25 runs with the tests and the prop; the TTS.
- **Music: the user makes it with ElevenLabs** from the brief below.
- **Sizes: 2k or 4k** ("mach die läufe in 2k oder 4k bessere qualität zeigen"). Generate new (the cold open, the
  picture everything builds on) at **4k**: 4096 x 2304 (`recipes/flux3.json` text sizes 1024 / 2048 / 4096). The edits at
  **2k**, the most the FLUX 3 recipe sends (`limits.max` 2048, recipes/flux3.json:273-274; a selection's crop smaller
  than that renders at full detail anyway). The Realism Pass at 2x on 4096 x 2304 would be 37.7 MP, above its 27.9 MP
  cap, so it lands at about 7040 x 3960 (fitted, not refused). Cost at BFL: 4k $0.607, 2k $0.10 (list), half until
  October 8 (docs/PLAN_FLUX3.md:249): tests and takes about $3-6 in all, under the $14; run them before October 8.
- **The smaller points are left to Claude** ("up2u"): the café is "Café Klecks" (the mascot's name, fictional); the cup
  photo is a prop made with FLUX 3 ("a phone photo of a beige ceramic cup on a white radiator, daylight"); Note 06 is
  the layer-eye version; bookends shortened (intro 4 s, outro 7 s); fonts Inter and JetBrains Mono. The look takes the
  colours Scumble already has (#1F120D is the mascot's, the orange and cream its brand), and the wipe, cards and
  counters are built here, nothing copied from the launch clip's files.
- The ComfyUI on 8188 is connected for Note 04 only (queue checked empty; `--no-comfy` for every other take).

### Music brief (for ElevenLabs)

One bed, one title sting, one end sting, a handful of effects. Instrumental only, no vocals; Scumble ducks and masters
it itself (about 20 dB under the voices), so the bed must stay even: no build-ups, drops or solos.
The user's direction (2026-10-05): trip hop with 8-bit retro ("mehr richtung trip hop? 8bit_retro?"). Square waves sit
in the voices' range, so the chiptune parts stay sparse, low-passed and quiet.
- **Bed, 4:40, A (trip hop with 8-bit accents, recommended):** "Playful trip hop instrumental for a funny software
  tutorial with two talking voices. Slow laid-back breakbeat with dusty vinyl crackle, deep warm sub bass, mellow Rhodes
  chords, and small 8-bit chiptune accents: soft low-passed square-wave arpeggios and occasional retro game blips, quiet
  and sparse. 88 BPM, D minor with a cheeky, wry mood, not dark. Even energy for the whole track, no build-ups, no
  drops, no solos, no lead melody that competes with speech; keep the midrange open for voices. Clean ending with a
  filtered pad ring-out." If the tool caps the length, make two minutes that loop cleanly at a bar line.
- **Bed, B (more 8-bit):** "Lo-fi chiptune trip hop instrumental for a funny software tutorial with two talking
  voices. Relaxed head-nod breakbeat at 88 BPM, warm sub bass, gentle bitcrushed chords, and soft 8-bit square and
  triangle wave patterns kept low and filtered, like a cozy retro game menu. D minor, wry and playful. Even energy
  throughout, no build-ups, no drops, no solos, no lead melody over the voices; leave the midrange clear. Ends with a
  soft fading chiptune chord." Both are tried under a test scene with the voices; the one that ducks better wins.
- **Title sting, 4 s:** "Short trip hop sting with a rising 8-bit arpeggio over a dusty breakbeat, lands on a soft hit
  at 3.4 seconds, D minor, 88 BPM."
- **End sting, 7 s:** "Trip hop outro sting, mellow Rhodes and a soft chiptune chord resolving, filtered pad ring-out,
  D minor, 88 BPM."
- **Effects (sound effects generator):** "a soft bitcrushed whoosh, 0.4 s, left to right" (the wipe); "a tiny 8-bit UI
  click, soft" (clicks); "a soft low 8-bit thud, 0.3 s" (the stamps); "a short retro game blip tick" (counters); "a
  quick chiptune shimmer sweep, 0.4 s" (the scan line); "a reversed bitcrushed whoosh, 0.6 s" (the rewind in Note 06).
Deliver as WAV 48 kHz if offered.

**Delivered by the user (2026-10-05, ElevenLabs, all WAV 48 kHz stereo, in `C:/Users/schoeneberg/Downloads/`)**,
measured (ebur128, spectrograms, a ducked test mix under video 2's cold open and Q1; nobody listened here):
- Beds, each 4:40, all around D minor, each with an 11 s intro and a 15-25 s outro:
  - `Unzip_and_Run_...121027.wav`: 88.5 BPM, -14.3 LUFS, the clearest under the voices (1-4 kHz voice-to-music
    28.0 dB), 65 % of its energy below 150 Hz (thin on phone speakers), a steady 1 kHz arpeggio, the outro breaks down
    from about 4:10.
  - `Uncaught_Exceptions_and_Cozy_Menus_...121208.wav`: about 118 BPM (not the 88 asked), -11.5 LUFS, a breakdown with
    the drums out at 2:02-2:20, the most energy at 150-300 Hz where HIM's voice sits. Least suited.
  - `The_Glitchy_Guidebook_...121149.wav`: 88.5 BPM, -13.5 LUFS, the evenest (10 s spread 3.3 dB), the most 8-bit
    sparkle (1-8 kHz), still clear under the voices (23.4 dB), a short filter break at 3:38-3:48, a clean end.
- Stings: `Dust_and_Pixels_...121410.wav` (4.0 s): a sub hit at 0.0-0.8 s and a chord ringing to 3.6 s, so the hit
  sits at the start: it lands on the cut into the title and the letters rise on it. `Static_Resolve_...121437.wav`
  (8.0 s): a soft chord with vinyl ticks decaying over 8 s, -24.2 LUFS (raise about 10 dB): the end card.
- **Chosen: The Glitchy Guidebook** (the user, 2026-10-05, after the test mixes). Its intro (0-11 s) and the filter
  break at 3:38-3:48 are placed or cut in the edit; the bed starts after the title sting.
- Effects (11 files, each 0.48 s, sound from sample 0, so a start mark is exact), the pick per role:
  - wipe: `a_soft_bitcrushed_wh_#2-1791202573348.wav`, a low swell that moves left to right (its peak at 0.442 s goes
    on the frame where the panel is full orange); `..._wh_#3-1791202600217.wav` decays from 0.05 s and stays in the
    middle. Both are 96-97 % below 200 Hz: little air, quiet on phone speakers.
  - click: `a_tiny_8-bit_UI_clic_#2-1791202638568.wav`, one 36 ms click.
  - counter: `a_short_retro_game_b_#1-1791202664020.wav` is four blips in a row (a rolling counter);
    `..._b_#2-1791202664021.wav` is three: its first 70 ms alone are the landing tick.
  - stamp: `a_soft_low_8-bit_thu_#4-1791202699042.wav` is sub only (centroid 35 Hz) and quiet (peak -18.6 dBFS): raised
    12 dB with the click on top, or a new one with some low-mid punch.
  - scan line: `a_quick_chiptune_shi_#2-1791202724172.wav`, an arc around 3.4 kHz (the two `#1` takes sit at 6-7 kHz,
    sharper).
  - rewind: `a_reversed_bitcrushe_#1-1791202794405.wav`, full range, swelling to its end (peak at 0.459 s on the
    restore); `..._#1-1791202815401.wav` is the brighter one.
  A 13 s reel of these over the Glitchy Guidebook bed was sent to the user.
- Second batch (2026-10-05, on the two weak points):
  - stamp: `a_soft_punchy_8-bit__#2-1791203545952.wav`, a short punch (body 0-0.16 s, peak -3.3 dBFS), still 98 % below
    200 Hz: used with the click on top (-10 dB) so it reads on small speakers. Replaces the quiet `thu_#4`.
  - wipe: `a_soft_airy_bitcrush_#4-1791203592036.wav` with its channels swapped (it moves right to left as delivered;
    mirrored it moves left to right like the panel), an arc peaking at 0.149 s, 92 % of it above 2 kHz; layered with the
    first batch's low `wh_#2` (-12 dB, peaks aligned) it is a full-range whoosh. Others: `airy_#3-1791203572085` (an arc,
    peak 0.164 s, no clear direction), `airy_#2-1791203586203` (a hiss swelling to its end, left to right, very high),
    `airy_#2-1791203566334` (broadband, sits right, no movement).
  A 10 s reel of the candidates was sent to the user.

### Test runs (2026-10-05, FLUX 3 Image on BFL, nothing recorded)

The user: "mach die läufe in 2k oder 4k bessere qualität zeigen". A dev instance on a scratch copy of the recording
profile's keys (`Local State`, `secrets.json`, `settings.json`), `--no-comfy`, driven over CDP (`commands.call`);
grounding off for the fictional café. Eight runs, **65.35 credits ($0.65 at the launch half price)**, 34-148 s each.
Pictures, the cup prop and two `.scumble` states in `dist/video/v3test/` (not in git): `A_coldopen.scumble` (the cold
open's answer) and `E_after_notes.scumble` (Notes 01-03 on it, the cup reference hidden).

| Run | What | Result | Credits, time |
|---|---|---|---|
| A, cold open | 4096 x 2304 white canvas, New boxes `ginger_cat_1` [1980,1330,2680,1700], `green_bin_1` [3620,1520,3960,2180], Text box `cafe_sign_1` [2660,300,3760,620] reading "Café Klecks"; the caption a café front across a cobblestone street, a big window with a wide wooden sill, the counter and an espresso machine behind the glass, a dark green door with a sign | **Everything in its box, the lettering exact** ("Café Klecks" with its accent, cream letters on dark wood), the counter readable through the glass; 100 % crops sharp (fur, whiskers). The answer came at **5456 x 3072**, not the size asked (BFL's 4k tier at 16:9): the boxes stayed at their 4096 rects (docs/BUGS.md) | 30.35, 148 s |
| B, the prop | new tab, text run 1536 x 2048: "A casual phone photo of a handmade beige ceramic coffee cup with a chunky, slightly crooked ear-shaped handle and a thin dark brown rim, standing on top of a white radiator ..." | A believable phone photo, 1776 x 2368 (2k 3:4): `cup_prop.png` | 5, 34 s |
| C, Note 01 | the prop as reference layer "their cup" (`@img1`), a From box `their_cup_1` [2250,1930,2490,2180] on the sill left of the cat, `src` the cup in the layer; selection 670 x 650; "Put their cup from @img1 on the window sill." | **The same cup** (glaze, specks, rim, handle) on the sill, in the street's sunlight, no seam | 5, 80 s |
| D1, Note 02 | a Remove box on the bin, selection 756 x 1122 at the right edge, "Take out the green bin.", **the cup reference still shown** | **Failed**: the result was the kitchen photo, not the street (FLUX 3's own plan in the log was right). Removed; docs/BUGS.md | 5, 129 s |
| D1b | the same with the cup layer hidden | The bin gone; door frame, wall, drainpipe, step and paving rebuilt; the neighbour's grey bin kept | 5, 117 s |
| D2, Note 02 | a Move box `ginger_cat_1` from [2630,1780,3550,2270] to [1240,1780,2160,2270] (left of the cup), the selection its old and new place (the cup left out), "Move the cat to the left." | **The same cat, same pose**, on the left; its old place filled with the counter and the sill, rosemary and cup untouched. The crop was 3393 x 1454, so the cat came back about 1.7x softer than the original at 100 % (still fine on screen) | 5, 106 s |
| E, Note 03 | a selection 800 x 740 behind the counter, no boxes (the selection goes as one box), "A barista with freckles, laughing, wiping the counter." | A laughing, freckled barista with red hair and a green apron wiping the counter with a cloth, sharp at 100 %; the cups on the tray there went | 5, 142 s |
| G, Note 03 again | the user's idea: her copy as a reference. `copy_to_layer` merged of [2500,860,760,780] as "barista (casting)", role reference, moved to x 5600 (outside the 5456 canvas), Result 5 hidden; the same selection, "A barista with freckles from @img1, laughing, wiping the counter." (no boxes: the selection went as a From row with the whole reference) | **The same person**, almost the same pose; the reference outside the canvas was sent (`@img1 -> image 2`) and is not in the picture. `barista_casting.png` and `G_barista_casting.scumble` | 5, 63 s |

What it means for the plan:
- **The cold open starts on a 5456 x 3072 canvas**, so the answer has the canvas's size and the boxes stay on what they
  placed (the BUGS.md workaround). Same rects scaled by 1.332.
- **Note 02 is two runs**, not one: the bin and the cat are 4000 px apart, one crop over both would be 21:9 at about 2x
  downsampling. She draws the Remove box, Generate, then the Move box, Generate (or both boxes first, a selection per
  run). The line "One box takes the bin out. One box moves the cat." still holds.
- **Hide the cup's reference layer after Note 01** (its eye; a line can carry it: "The radiator stays in their
  kitchen."). A shown reference goes along with every run.
- **Note 04 does not double the size.** 2x on 5456 x 3072 is 67 MP; the Realism Pass caps at 27.9 MP, so it lands at
  about 7040 x 3960 (1.29x, 16.8 -> 27.9 MP). **Decided (the user, 2026-10-05: "mach es so wie du meinst"): the 4k
  picture stays, the lines say "bigger", not "twice the size"**, and the size counter rolls 5456 -> 7040 (16.8 -> 27.9
  MP). Rejected: a 2k cold open so 2x lands at exactly 5456 x 3072.
- **The barista: her copy goes along as a reference** (the user: "du kannst eine kopie von ihr in neuem layer machen und
  den layer als reference image mitsenden"; run G). Before the take, `add_image_layer` `barista_casting.png` role
  reference, then `set_layer` x 5600 (outside the canvas; the camera's card never shows it), the cup's reference
  hidden, so she is `@img1`; the take's prompt "A barista with freckles from @img1, laughing, wiping the counter." The
  prompt shows an @img1 chip and the layers list a "barista (casting)" row, so the script says so in a line (a
  suggestion: HIM "Where did she come from?" / HER "I cast her this morning."), and the lines may say "she".
- Still true: 46 film stocks (`film.looks`, so "Forty-six." stands); the log records BFL's charge per run (`read_log`
  detail `info.cost` in credits, 1 credit = $0.01): the cost tally reads it.
- The takes re-run A, C, D1b, D2 and G on camera (the prop and the casting copy exist): about 50 credits with no
  failure ($0.50 at half price until October 8, $1.00 after).

### Not checked yet

The screencast at device scale 2 on the real window; the Realism Pass at 2x on the 5456 x 3072 poster (needs the
user's ComfyUI free; the 27.9 MP cap fits it to about 7040 x 3960); the two-run Note 02 on camera; every overlay at 360
px phone width; CSS 3D and backdrop blur in the overlay renderer; the intro's loudness under the bed; YouTube chapter
rules (0:00 marker, at least 10 s each).
Checked 2026-10-05 (above): FLUX 3 Generate new with three New boxes and a Text box; a Move box on FLUX 3; a From box
with @img1; the lettering; the log's charge per run.

## 6. Video 3: "Scumble, part three: the client has notes" (script, 2026-10-05, not recorded)

The same two voices and the same bookends, shortened (intro 4 s, outro 7 s). He has a client now, off screen: one café poster, six notes, and one picture that goes from an empty canvas at 09:14 to a print-ready file after midnight. Each note shows one feature and adds one coat to the same picture. Every model run is FLUX 3 Image on Black Forest Labs. The Realism Pass runs on the user's own ComfyUI. Every action and label below was checked against the fact sheets of 2026-10-05 and the code. Lines marked **check** depend on what the paid take returns, because FLUX 3 takes no seed and no take will repeat a test run. Scripted at 4:20; expect 4:45-5:00 as made. The cold open and Note 01 are the densest scenes: their spoken lines alone fill about nine tenths of their windows. HER / HIM pills sit bottom left at the start of each line. Subtitles go on a track and are never burned in.

---

**COLD OPEN: "The brief" (0:00–0:32)**

*Scumble with a tab that has no picture yet, the editor in a rounded card on the brand background. She clicks New in the editor's top bar. In "New empty canvas" she enters Width 5456 and Height 3072 and clicks Create. A white 16:9 canvas appears.*

**HIM:** I have a client.

**HER:** Congratulations.

**HIM:** A café poster. Cat in the window, their name over the door.

**HIM:** They said "lived-in." I said, "A bin or something."

**HER:** And the picture?

**HIM:** ...There isn't one.

**HER:** Then I'll draw where things go, and write what's in each box. *(X picks Boxes. She drags a box on the sill, low in the middle, double-clicks it, types "a sleeping ginger cat on the window sill" and presses Enter. The green tag reads ginger_cat_1. She draws an orange box low on the right, "a green bin by the door": green_bin_1. Then a cyan box across the top right. In the Generate tab's Boxes section she sets its kind to Text, double-clicks the box, types "Café Klecks" and presses Enter: cafe_klecks_1 T. Its description, "a hand-painted wooden sign over the door", goes into its row in the section. Under the prompt the row reads Boxes · 3. The typing is ramped.)*

**HIM:** You can't just draw rectangles at a model and expect—

**HER:** This one reads rectangles. *(Generate new in the top bar. The dialog "Generate a new image" shows Where: API provider, Model: FLUX 3 Image, Provider: Black Forest Labs, Aspect ratio 16:9, Long side 4096 px, with the café prompt already in it. She clicks Generate, and the dialog shows "running ..." over the canvas.)*

*The wait is ramped. The dialog closes on the picture: a café front across a cobbled street, a ginger cat asleep on the wide wooden sill, a green bin by the dark green door, and "Café Klecks" on the sign above it (**check** the take). The Boxes tool is still active, so the three coloured boxes sit on what they asked for.*

**HIM:** ...The cat's in the box.

**HER:** Of course it's in the box. It's a cat.

**HIM:** They'll have notes.

**HER:** They always have notes.

*Motion: the card scales in. Eyebrow "THE BRIEF · 09:14". The client's bubble ("CLIENT · 09:12: Poster for the café? Cat in the window, our name over the door. Make it look lived-in!") and his reply ("YOU · 09:14: a bin or something?") come up over HIM's first lines. Follow-cam runs on the three drags only, and a numbered circle drops into each box in that box's colour (1 green, 2 orange, 3 cyan). The ramp badge shows the real factor. On the reveal a scan line crosses each box in its own colour, and the first thumbnail drops into the coat strip. The music drops out on "...The cat's in the box." and the line plays over a still frame.*

---

**TITLE (0:32–0:36)**

*The last 4 s of intro.mp4, with the title sting (Dust and Pixels) hitting on the cut. The letters of "Scumble · Part three: the client has notes." rise, with "notes" in orange.*

---

**NOTE 01: "Our cup" (0:36–1:12)**

*The poster is in the card and the Generate tab is open. The document holds no boxes (Boxes › Clear before the take), and the prompt field is empty.*

**HIM:** They love it. Now they want their cup in it.

**HER:** Send me the cup.

**HIM:** It's a photo. From their phone. On a radiator.

**HER:** Then it's a reference. It goes straight into the sentence. *(In the prompt field she types "Put their cup from " and presses Ctrl+V. An img1 chip with the cup's thumbnail lands at the caret, and the photo appears top left on the poster in a cyan dashed frame with an "img1" badge. She types " on the window sill.")*

*Cut: the new row in the References list is renamed "their cup" (double-click the name, Enter).*

**HER:** I only take the cup, and it goes here. *(X: a box on the sill, left of the cat. She double-clicks it, types "their cup from @img1" and presses Enter. In the Boxes section she sets the kind to From reference; its Layer select already reads "@img1 their cup", the only shown reference. She types the cup's rectangle into Part (ramped). A dashed frame in the box's colour closes around the cup on the photo and leaves the radiator outside. The tag reads their_cup_1 ← @img1. With R she drags a rectangle selection around that stretch of sill, then clicks Generate. The title row shows the timer and Cancel.)*

**HIM:** What's the little picture in the sentence?

**HER:** That's the cup. It tells FLUX which picture I mean.

*Result 1 lands on the sill: the same cup with its glaze, its dark rim and its crooked handle, in the street's light (**check** the take).*

**HIM:** ...That's their cup.

**HER:** Their cup. Their handle. Their very specific beige.

**HIM:** And the radiator?

**HER:** Stays in their kitchen. I only borrowed the cup. *(Boxes › Clear first, then the eye on "their cup" in the References list. Its badge reads hidden, and the photo leaves the poster's corner.)*

*Motion: the wipe. Eyebrow "NOTE 01 · OUR CUP · 11:20". A spotlight falls on the dashed Part frame around the cup. The camera pushes in on the prompt chip during the ramp. The scan line runs in the box's colour on the reveal, and a thumbnail joins the coat strip.*

---

**NOTE 02: "Who put a bin there?" (1:12–1:50)**

**HIM:** They want to know who put a bin there.

**HER:** You did. Nine-fourteen this morning. "A bin or something."

**HIM:** ...Lose the bin. And the cat's "crowding the name."

**HER:** One box takes the bin out. No brush, no eraser. *(X: a box over the bin. She double-clicks it, types "the green bin" and presses Enter. In the Boxes section she sets its kind to Remove, and the box turns hatched. With R she drags a rectangle selection down the right edge around the bin, types the prompt "Take out the green bin." and clicks Generate.)*

*The run is ramped. Result 2: the bin is gone, with wall, door frame and step where it stood (**check** the take).*

**HIM:** ...There was a wall behind it?

**HER:** There is now.

**HER:** And one box moves the cat, from here to there. *(Boxes › Clear. X: a box around the cat, double-click, "a sleeping ginger cat on the window sill", ginger_cat_1. She sets its kind to Move. The box stays as the dashed source, an arrow appears, and the solid target jumps to the right. She drags the target left along the sill, past the cup, to the sill's left end. With R she drags a rectangle over the cat, then holds Shift and adds a second one over its new place, leaving the cup out. She replaces the prompt with "Move the cat to the left." and clicks Generate.)*

*The run is ramped. Result 3: the same cat in the same pose at the left end of the sill. Its old place is sill and counter again, and the cup is untouched.*

**HIM:** You moved a cat with a rectangle.

**HER:** It didn't mind.

*Motion: the wipe. Eyebrow "NOTE 02 · WHO PUT A BIN THERE? · 14:05". The quote card "A BIN OR SOMETHING. · YOU, 09:14" lands as she quotes him. Each run gets a scan line in its box's colour (both green, because after Clear the next box starts green again). Follow-cam runs on the target's drag only. The stamp "IT DIDN'T MIND." comes after her line, over a still frame. No zoom past fit on the moved cat.*

---

**NOTE 03: "A barista. Human." (1:50–2:24)**

**HIM:** Now it feels empty. A barista. "Friendly. Human." In capitals.

**HER:** Behind the counter, then. No boxes: the selection is the box. *(Boxes › Clear. With R she drags a rectangle selection behind the counter, through the glass. Under the prompt: "Boxes" with the hint "the selection goes as one box". In the emptied prompt field she types "A barista with freckles from @". The list opens under the caret: a small face, img1, "barista (casting)", then "+ Add reference" and the note "1 hidden reference is not listed". Enter puts the chip in. She types ", laughing, wiping the counter.")*

**HIM:** ...Who's that in the sentence?

**HER:** I cast her this morning. She's waiting outside the canvas. *(She zooms out one step. To the right of the poster, in the margin, the reference waits in its cyan frame with the img1 badge. In the References list, "barista (casting)" carries img1 and "their cup" reads hidden. She zooms back in.)*

**HIM:** ...You cast her.

**HER:** I had a feeling this client would want a human. *(Generate. The title row counts.)*

**HIM:** Is she done?

**HER:** She's doing her hair.

*Result 4: the barista from the casting, behind the counter with a cloth in her hand, laughing, freckled (**check** the take).*

**HIM:** ...Freckles. Did I say freckles?

**HER:** I did. FLUX listened.

**HIM:** She looks like she likes her job.

**HER:** She just started.

*Motion: the wipe. Eyebrow "NOTE 03 · A BARISTA. HUMAN. · 17:40". A push-in on the @ list and the face chip. The wait is ramped with its badge. The scan line runs on the reveal, then a slow push-in on her face and a small callout on the freckles.*

---

**NOTE 04: "Printer says bigger" (2:24–2:54)**

*ComfyUI is connected for this take only. Nothing is selected.*

**HIM:** The printer wants it bigger.

**HER:** Then the next coat goes on bigger: the Realism Pass, over the whole picture. *(Upscale in the editor's top bar, clicked without resting the pointer on it, then Upscale in the dialog. The cut goes from her first click straight to the running pass, so the dialog never shows. The title row reads "Realism Pass (Windows only, RTX only) · N s" with Cancel.)*

**HIM:** Does that run on my laptop?

**HER:** On Windows, with the right graphics card and your own ComfyUI.

**HIM:** ...So, no.

**HER:** That's why you called me.

*The wait is ramped. The pass lands. The document is 7036 × 3962, every layer has been scaled along, and a new layer "Realism Pass (Windows only, RTX only)" sits on top of the stack.*

**HIM:** ...I can count her freckles.

**HER:** A hundred and twelve. I counted. (Re-voiced 2026-10-06: the pass layer at 100 % shows about 100-150 freckles, so "Twenty-three" did not hold.)

*Motion: the wipe. Eyebrow "NOTE 04 · BIGGER · 21:15". The camera stays on the picture card, with no lower third. A size counter rolls "5,456 × 3,072 → 7,036 × 3,962 · 16.8 → 27.9 MP". A before/after divider at 100 % sweeps across her face (the pass layer hidden, then shown). The last two lines play over a still frame.*

---

**NOTE 05: "More analog vibe" (2:54–3:10)**

**HIM:** Now they want "analog vibes." ...Don't say forty-six.

**HER:** Forty-six. *(She opens Film looks at the end of the Image tab, group All: forty-six thumbnails. With the Realism Pass layer active she clicks a colour-negative stock. A filter layer named after it lands at the top of the Layers list with its eye and the "filter" badge, and the grain settles over the poster. She turns its eye off and on once.)*

**HIM:** You just cleaned it up, and now you're adding grain.

**HER:** Different grain. Mine.

*Motion: the wipe. Eyebrow "NOTE 05 · MORE ANALOG · 22:30". The counter "46 FILM STOCKS" lands on "Forty-six." with the music out under it. The stamp "DIFFERENT GRAIN. MINE." follows her last line. No overlay names the stock.*

---

**NOTE 06: "Can we see the first one again?" (3:10–3:36)**

*The full window: the layer list beside the poster, because the eyes are the point. The Result layers were renamed before the take: "the cup", "bin out", "cat moved", "barista".*

**HIM:** Ten to midnight. "Can we see the first one again?"

**HIM:** ...Please tell me it's a layer.

**HER:** They're all layers. I just close their eyes. *(Eyes off from the top: the film look, the Realism Pass layer, then "barista", "cat moved", "bin out", "the cup". The grain goes, the barista goes, the cat jumps back to the middle of the sill, the bin comes back and the cup goes. The poster is the cold open's picture again.)*

**HIM:** ...Oh. That's this morning.

**HIM:** ...With their cup. Without the bin. With the barista. And the grain.

**HER:** So, this one. *(Eyes back on from the bottom up, with the Realism Pass layer and the film look last.)*

**HIM:** ...So this one.

**HER:** Nobody wants the first one. They want to have seen it.

*Motion: the wipe. Eyebrow "NOTE 06 · THE FIRST ONE", its clock rolling up to 23:50. A flip-book rewind runs along the coat strip with the reversed whoosh as the eyes go off, then forward again as they come back on. Nothing moves under her last line.*

---

**THE STACK (3:36–3:50)**

*The finished poster tilts back and comes apart into its coats, with the morning's picture at the bottom and the grain on top.*

**HER:** Every change went on as a layer, over the one before.

**HIM:** ...Like coats of paint.

**HER:** A thin coat over a dry one. That's a scumble.

**HIM:** I always thought that was a sneeze.

**HER:** Bless you.

*Motion: no wipe. A CSS 3D exploded stack built from the real layers, with a leader line per coat: "THE BRIEF", "01 THEIR CUP", "02 BIN OUT", "02 CAT MOVED", "03 BARISTA", "04 BIGGER", "05 GRAIN". It folds back flat before "Bless you.", and the music dips out, so the punchline plays over a still frame. If time is short, the 3D motion is the first motion to cut. The five lines stay over a still of the finished poster, because they pay off the name.*

---

**CLOSE (3:50–4:13)**

**HIM:** Export it before they wake up.

**HER:** Done. *(Image tab › Export: the name already set, png, then Save as. "Saving ... N %" runs, the save dialog is cut, and the status reads "Saved ... (7036 × 3962, ... MB, recipe embedded, ...)".)*

**HIM:** What did all that cost me?

**HER:** A few runs on my key. Less than the coffee.

**HIM:** I'll tell them it took all week.

**HER:** I still didn't hear that.

*Optional tag (the first thing to cut): a bubble, 07:02, "CLIENT: LOVE it!! One tiny thing —".*

**HIM:** ...They love it. "One tiny thing."

**HER:** They always have notes.

*Motion: eyebrow "00:20". The stamp "PRINT-READY" lands on "Done.". The cost tally counts up each FLUX 3 run's charge as the provider logged it. Its label is "FLUX 3 runs · the provider's charge · N credits · $N/100", with the sum read_log returns for the takes used (about 50 credits, $0.50, before October 8 if nothing fails). Notes 04 and 05 cost nothing. "They always have notes." plays over a still frame.*

---

**OUTRO (4:13–4:20)**

*outro.mp4 from 3.0 s. The coat strip completes, and the end sting (Static Resolve, raised about 10 dB) plays. End card: github.com/DenRakEiw/scumble · Download for Windows and Linux · Manual, videos and the dev blog on denrakeiw.com/scumble*

---

### Production notes for video 3

- **Takes:**
  - One saved .scumble per note (the brief, 01, 02, 03, 04, 05, 06), so a failed paid run costs one note.
  - Before every FLUX 3 take, select FLUX 3 Image on Black Forest Labs in the tab, and untick Grounding in the Generate tab's Settings rows. It is on by default and set per document, and "Café Klecks" is fictional.
  - Empty the prompt field before the takes of Notes 01, 02 and 03. The café caption stays in the tab's prompt after Generate new, and each saved .scumble keeps the last prompt, including Note 01's @img1 chip.
  - Look at each result before cutting its line to it: the cup, the wall behind the bin, the moved cat, the freckles.
  - Run the takes before October 8 for the half price.
- **Native popups do not show in the screencast.** That covers the Boxes kind select, the selects in Generate new, Upscale's Model and Factor, the Film looks group and every save dialog. Set each value before the take in the same app session, pick it with the keyboard on the focused select, or cut past it. The From box's Layer select fills itself with the only shown reference, so it is never opened.
- **Tooltips:** never rest the pointer on the top-bar Upscale button (its tooltip names other upscalers), the ComfyUI status, or a film thumbnail (stock name and trademark note). Click and move on.
- **Tools:**
  - X is Boxes, R is the rectangle selection. Switch to R before every selection, or the drag draws a new box.
  - X picks Boxes from every tool except the Canvas tool.
  - The box overlay shows only while the Boxes tool is active or the Boxes section is open.
- **Boxes outlive runs.** Press Boxes › Clear:
  - before Note 01, off camera;
  - after Result 1, on camera, before the eye;
  - between Note 02's two runs;
  - at the start of Note 03, so the hint "the selection goes as one box" is in shot.

  Hide the cup only after Result 1 has landed, and always Clear first:
  - A From box whose reference is hidden makes every later run refuse ("... is not a reference picture of this run: nothing was sent.").
  - A cup that is still shown turned the bin run into the kitchen photo once (BUGS.md).
- **Cold open:**
  - Start from a tab with no picture, or New warns "This discards ...".
  - Open Generate new once, set Aspect ratio 16:9 and Long side 4096 px, and Cancel. In each new session it opens on 1:1 and 1024 px, and a square answer stretches the boxes.
  - Put test A's café caption in the tab's prompt; the dialog takes it from there.
  - Box rects (test A × 1.332): cat 2637,1772,3570,2264; bin 4822,2025,5275,2904; sign 3543,400,5008,826.
  - Draw cat, bin, sign in that order, so the colours run green, orange, cyan.
  - The sign: set the kind to Text, type its words, and only then its description, so the id comes from the words (cafe_klecks_1). Once an id is made from words, it stays.
  - Check the description-to-id rule in a dry run. By the code, "a sleeping ginger cat on the window sill" gives ginger_cat_1 and "a green bin by the door" gives green_bin_1; the test's wordings gave curled_up_1 and wheelie_bin_1.
  - Check that the answer is 5456 × 3072 before cutting "The cat's in the box." to it.
  - Keep the status's "4096 × 2304" out of focus.
- **Note 01:**
  - Copy the cup prop to the clipboard as a bitmap. It arrives named "image", so cut to the rename.
  - The Part cannot be drawn. Measure its four numbers in a dry run: image pixels where the layer lands, a third of the canvas at 16,16. Test C used 430,690,1100,1285.
  - The From box sits at 2250,1930,2490,2180; the selection is 670 × 650 at 1950,1700.
  - Keep "Named in the prompt: @img1 → image 2" out of focus.
  - The prompt chip is 20 px tall in the 1080p master and needs the push-in.
- **Note 02:**
  - Use the Remove kind in the Boxes section, never the tool column's Remove brush.
  - The bin's selection is 756 × 1122 at the right edge.
  - Move box 2630,1780,3550,2270 → 1240,1780,2160,2270. The target first jumps about 1091 px to the right.
  - The selection is two rectangles (Shift adds), or the paste cuts the moved cat.
  - The moved cat is about 1.7× softer at 100 %, so do not zoom past fit.
  - If the bin take shows no wall or door frame, cut "There was a wall behind it?" / "There is now." rather than rewrite it.
- **Note 03:**
  - Before the take, add barista_casting.png with add_image_layer, named "barista (casting)", role reference.
  - Then set_layer x 5600: adding clamps it inside the canvas.
  - The cup stays hidden, so she is @img1.
  - The selection is 800 × 740 behind the counter, as in run E.
- **Note 04:**
  - Connect the ComfyUI on 8188 for this take only, with /queue empty. The pass queues at the front, and every layer uploads to its input folder.
  - Select none first.
  - The dialog never appears on camera, because its help paragraph and the note under Model name the technique. Cut from the top-bar click to the running title row.
  - Check before the take that the top-bar Upscale opens on the pass with Factor set (it starts at 1× in each session). If it does not, run realism_pass {factor} by command and show only the title row.
  - Never open the Model list, never hover Style / Strength / Preset, the Upscale button or the ComfyUI status, never open Settings › About. Never show a not-ready state; cut any failed take.
  - Pick 1.5× or 2× by eye on E_after_notes. Both land at 7036 × 3962.
  - The wall time at this size is unmeasured: ramp it and say no number.
  - Count the freckles on the pass layer at 100 % and put the real number into the line and the TTS. If they do not survive, use HIM "...I can see her eyelashes." / HER "All of them. I checked."
- **Note 05:**
  - Make the Realism Pass layer active before the click, so the look becomes a new layer on top.
  - Set the group to All off camera; the panel itself opens on camera.
  - The layer row shows the stock's real name, which is fine. No line or overlay names it, and no hover over a thumbnail.
- **Note 06:**
  - Rename the four Results off camera: "the cup" (not "their cup", which is the reference's name), "bin out", "cat moved", "barista".
  - The pass layer is opaque and full size, so its eye goes off before the Results; otherwise nothing changes on screen.
- **The stack:**
  - export_layer gives the Results and the pass layer.
  - The base comes from an export with every layer hidden.
  - The film look is a filter layer that export_layer refuses. Its plane is the difference between the export with it and the export without it, or a drawn grain sheet.
  - Leader lines name the notes, never "Result N", the stock or the pass.
- **Close:**
  - Export into a neutral folder, because the status prints the full path.
  - The tally is an overlay from read_log detail.info.cost (credits, 1 credit = $0.01), labelled as the provider's charge, with the real sum of the takes used. The app shows no tally.
  - About 50 credits at half price, about 100 after October 8, still less than a coffee.
- **Overlay rules:**
  - The wipe only between notes. The scan line only on model results.
  - Three stamps: IT DIDN'T MIND., DIFFERENT GRAIN. MINE., PRINT-READY.
  - No zoom or whoosh over a punchline.
- **Cut order past 5:00:**
  1. The close's optional tag.
  2. The stack's 3D motion (its lines stay).
  3. Note 05 down to its counter beat.
  4. The wall pair in Note 02.
  5. Note 02's Move run. It takes with it: "And the cat's 'crowding the name.'", "And one box moves the cat, from here to there.", the "It didn't mind." beat and its stamp, the cat jumping back in Note 06, and the coat "02 CAT MOVED".

### Voices as made (2026-10-05 evening)

Written by one workflow (two fact checks against the code, three drafts, two judges, a synthesis, an adversarial
check; HIM's median 6 words a line, HER's 8). Voiced with the same two voices as videos 1 and 2
(`docs/images/video/voice/v3_*.json`, `tts.py`): nine scenes, 78 lines, **3:21 of speech** (4:14 with the voices'
own pauses), so the plan's 4:45-5:00 as made holds.
- **A new splitter, `split_align.py`:** it transcribes every speech segment between pauses and groups the segments
  onto the script's lines by text. `split_lines.py` (pause length and word count) slipped by a line in four scenes
  of nine; the new one placed all 78 lines right on its first run. Transcripts are cached in `<scene>_lines/segments.json`.
- **`takes.py`:** three more takes of a scene, each split and transcribed back; the clearest becomes `<scene>.wav`
  and `<scene>_lines/`, all takes stay in `<scene>_takes/` (t0 the first). Run on the cold open, Notes 03, 05 and 06
  after the first check heard "grain" as "green", "They're all layers" as "liars", "Is she done?" as "Must be done?".
  Kept: cold t2, n3 t2, n5 t2, n6 t1, every line clear in the transcription check.
- To listen: `dist/video/v3/voices_preview.mp3` (all nine scenes in order, 1.5 s between scenes).
- Still depends on the takes: "Twenty-three. I counted." (the real freckle count on the pass layer at 100 %; the
  fallback pair is in the Note 04 production note).

### Voices switched to ElevenLabs (2026-10-05 night)

The user: the Gemini voices sounded too different from scene to scene (nine calls; one call for the whole script
was steadier, measured, but garbled lines near its end). Tested and chosen: **ElevenLabs, two fixed voices, every line
on its own**, "die elevenlabs stimmen sind super": HER = "Annika - Warm, Witty & Conversational"
(`j08RBkJwvXYv5AZ961JE`), HIM = "Mark - Natural Conversations" (`UgBBYS2sOqTuMpoF3BR0`), model `eleven_v4` with audio
tags ([deadpan], [jumping in], [short pause]). The characters sound different from videos 1 and 2.
- The lines, prompts and voices: `docs/images/video/voice/v3_eleven/lines.json`; the takes `v3_eleven/<scene>/NN_WHO.mp3`
  (+ trimmed `.wav`); `eleven.py fetch | check | join` (join writes `dist/video/v3/voices_elevenlabs.mp3`, 3:58 with
  the pauses set there). ElevenLabs flows "Scumble video 3 - voices" and "... cold open voice test" hold every take.
- "layer" / "layers" (Note 06) came out as one syllable ("lair"); IPA did not help, the respelling "LAY-er" did in a
  forced-choice check (an open transcription still hears "liars": the user's ear decides). "grain" retaken with IPA.
- Cost: about 70 credits a line by the estimate; the runs reported 0 credits each.

### Motion graphics: the renderer and a cold-open test (2026-10-05 night)

`docs/images/video/motion/`: `render.js` (an Electron window shown at opacity 0, frames taken with DevTools
`Page.captureScreenshot`, a marker pixel carries the frame number so a stale frame is never used; the offscreen
window's paint images stayed on the first frame after a seek), `coldopen_test.html` (the composition: WAAPI animations
paused and seeked per frame), `build_test.py` (timings from the voiced lines, the render, the audio mix: voices, the
Glitchy Guidebook bed from 11 s ducked by sidechain with a drop-out on the punchline, the effects, the title sting;
-14 LUFS). Fonts Inter and JetBrains Mono (the website's, OFL) in `motion/fonts/`, colours from `build/icon.svg`
(#1B1714, #C4643A, #D08967, #EFE7DA), box palette green / orange / cyan. Output `dist/video/v3/coldopen_motion_test.mp4`
(46 s, about 0.3 s a frame). A stand-in white canvas sits where the real recording goes.

### Cold open v2: the app take under the motion graphics (2026-10-05 night)

The user on the first test: "es sieht zu leer aus ... nutze screenrecordings aus scumble und mache darüber motion
graphics", the bubbles may sit over the app, the HER / HIM pills are "weird" (dropped), the cat must read as in its
box (the cat's box now lights up on the punchline), sound "passt".
- The take: `docs/images/video/rec/rec3.py` (the recorder plus a log: cursor, clicks, marks, element rects in frame
  pixels) and `scene3_cold.py` (`setup`, `take`, `check`), paced to `motion/timing.js`; `winfit.ps1` sets the window to
  1600 x 900 (it opens at 1602 x 901). No model run: the dialog's Generate is guarded; the result is the
  A_coldopen.scumble tab (its boxes moved to the 1.332 rects in memory, not saved). Frames and `events.json` in
  `dist/video/v3/rec/cold/` (764 frames, 2400 x 1350).
- The composition `motion/coldopen_v2.html` + `build_v2.py`: the whole app in a 1728 x 972 card, the camera on the
  New dialog, each box while drawn (1.3x) and the Generate new dialog; during the ramp the dialog frame is held, then
  the canvas with its three boxes, each box fills with a scan line in its colour, a light scan reveals the result.
  `dist/video/v3/coldopen_v2.mp4`.
- Found: after New, a tab without a file is named after its upload (`n2_base_... *`); the take keeps "Untitled"
  through the page's `docFile` name. Same family as the Extend-canvas tab name noted under video 2.

### Decided for the edit (the user, 2026-10-05 night: "ok")

Master in **1440p** (the scenes render at 1920 x 1080 CSS pixels with a device scale of 4/3, so 2560 x 1440; the takes
are 2400 x 1350, and YouTube gives 1440p uploads a better encode). **Resolve** (project "Scumble Tutorials", over the
DaVinci MCP) for the assembly, the stems on their own tracks (voices, effects, the bed already ducked), chapter markers
and the export (YouTube master, web encode); subtitles as SRT from the script's own timing, not burned in. **No colour
grading**: the app's UI must look like the app; at most the mascot clips matched if they stand out. A vertical cut, if
any, is rendered by the scene engine, not by Smart Reframe.

### Video 3 as made (overnight 2026-10-06)

Built in one night while the user slept ("mach das video fertig"): the last four takes, five more scenes, the mix,
the Resolve timeline and the master, then an independent check of the master. Nothing committed (the tutorial
material stays uncommitted until the user says so); no paid FLUX run; the ComfyUI on 8188 was connected only for the
Note 04 take, its `/queue` empty before and after.

**Where everything is**
- Master: `dist/video/v3/final/03_scumble_part_three.mp4` (5:34.8, 10,045 frames, 2560 x 1440, 30 fps, H.264 High
  about 36 Mbps, AAC 320k; -14.0 LUFS, LRA 11.4 LU, -1.6 dBTP). Web: `03_web.mp4` (1920 x 1080, CRF 25, faststart,
  the master's audio unchanged, 58.9 MB). `poster.jpg` (the title card, 1280 x 720).
- Subtitles `03_scumble_part_three.en.srt` (78 cues, one per voiced line, never burned in), `chapters.txt` (nine
  chapters, each at least 10 s), `timeline.json` (clip starts, joins, bed drops, levels). Stems `stem_voice_fx.wav`,
  `stem_music.wav` (32-bit float, master gain, no limiter, peaks above 0 dBFS) and `stem_mix.wav` (the limited mix,
  the master audio). `outro_1440.mov`, `endcard_1440.png` / `.mov` (video 2's end card redrawn at 1440p).
- Resolve: project "Scumble Tutorials", timeline "03 Scumble part three" (1440p on the timeline only; V1 the clips,
  V2 the end card from 330.5 s, A1 / A2 the stems switched off, A3 `stem_mix.wav`; nine chapter markers; the
  subtitle track "English"). To rebalance: A1 / A2 on, A3 off, a limiter on the main bus.
- Scenes: `dist/video/v3/scenes/v3_n1.mp4` ... `v3_close.mp4` with `_stem.wav`; specs in
  `docs/images/video/motion/scenes/`, render plans in `motion/plans/`; `motion/build_final.py` builds the mix, SRT,
  chapters and preview again; `motion/build_stack_assets.py` the stack's planes (`dist/video/v3/stack/planes/`).
- Takes: `dist/video/v3/rec/cold, n1 .. n6, close` (+ `rec/stack`, one frame), states `dist/video/v3/takes/N0_start
  .. N6.scumble`; the scripts `docs/images/video/rec/scene3_cold.py`, `scene3_notes.py`, `scene3_rest.py`. The
  exported layers in `dist/video/v3/stack/`, the poster `dist/video/v3/final/cafe_klecks_poster.png`.
- YouTube text: the section "Video 3: 'Scumble, part three: the client has notes'" at the end of
  `dist/video/youtube_descriptions.md`.

**What differs from the script**
- Length 5:34.8 against 4:20 scripted (4:45-5:00 expected): Note 04 runs 41 s (window 30 s) and Note 06 37 s (26 s);
  Note 04's silent demo stretch (about 14 s) is the easiest trim. Nothing of the cut order was cut, the close's
  optional tag included.
- Voices: ElevenLabs, no HER / HIM pills (the user's taste since cold open v2). The freckle line is re-voiced as "A
  hundred and twelve. I counted." (about 100-150 freckles on the pass layer at 100 %); the voice says it as digits.
- Note 04: the dialog never opens (a capture listener on the top-bar Upscale click starts the dialog's own
  `realism_pass` at 1.5x); the camera is on the status line, not the title row, whose label is squeezed to "(Win" by
  the recipe note. The landed status prints "in 11 s"; no line says a number. No speed badge on the pass (16 s wait
  at about 1.5x). The size counter rolls 5,456 x 3,072 -> 7,036 x 3,962 · 16.8 -> 27.9 MP; the divider sweeps at
  100 %.
- Note 05: the stock's name shows in the grid and the layer row only (allowed); no overlay names it.
- The stack: a wipe between Note 06 and the stack (the script said none); setting n6's `wipeOut` and the stack's
  `wipeIn` to false makes it a seamless hand-off.
- Close: the export went to `dist/video/v3/final/`, so the status on camera reads "Saved F:/canvas/dist/video/v3/
  final/cafe_klecks_poster.png ..." for several seconds under the camera push (no user name in it; the production
  note asked for a neutral folder). The tally reads "FLUX 3 RUNS · THE PROVIDER'S CHARGE · 50.35 credits · $0.50".
- Mix: end sting at the voices' loudness, outro audio +10 dB (not +15), title sting -6 dB, effects -3 dB, a 2.5:1
  compressor on the voices, a whoosh at the eight joins; the bed sits 19 LU under speaking voices, 12 LU between
  lines, silent in all six drops.
- Engine fixes found on the way: the coat strip's earlier coats were invisible in every scene (a one-key animation),
  and the before / after divider line was clipped away; n1-n3 re-rendered with the fix.

**The independent check of the master (2026-10-06 morning)**
- Duration, size, frame count, streams (video, AAC, a Resolve timecode track) as above; master and web the same
  length. ebur128 on the master: -14.0 LUFS, -1.6 dBTP, LRA 11.4 LU.
- Contact sheets every 2 s and full frames at every chapter start, counter, stamp and reveal: no empty, black or
  stale frame (freezedetect finds only the held Generate new dialog at 22.7-25.4 s and the title card at 43-46 s).
  Windows OCR over one frame per second: no text naming NVIDIA, DLSS, neural rendering or the node pack; the Realism
  Pass only as its app label; no dialog of the pass on screen; no key, no user-folder path.
- The SRT matches `lines.json` line for line (78 / 78, no doubled or missing line). Two cues were shorter than 0.7 s
  and were lengthened in the SRT only ("Bless you." to 1.5 s, "Done." to 1.07 s); Resolve's subtitle track still has
  the old ends (it is not burned in, so the master is unchanged).
- Spot checks of subtitle against picture and voice: "...The cat's in the box." over the lit cat box, "Forty-six."
  with the 46 FILM STOCKS counter, "Done." with the PRINT-READY stamp, "Bless you." over the flat poster; each voice
  starts within 0.2 s of its cue.

**Left for the user**
- Watch it once by ear and eye; decide on the Note 04 / Note 06 trims.
- The path in the close's status (above): keep it, or cover it (a re-render of `v3_close` with the status masked or
  a re-take into a neutral folder, then the Resolve render again).
- The end card fades in over the outro while the mascot's drop is still falling: from 330.5 to about 331.5 s the drop
  crosses "Download for Windows and Linux". Cosmetic; start the end card a second later or drop it after the fall.
- The YouTube text: replace `[link to part one]` / `[link to part two]`, settle the heading clash with the older "Video
  3" (the 45 s launch preview), and the cost line after October 8 (the half price ends; about 100 credits then).
- Upload, the website post and the commit of the tutorial material only on the user's word.

### Video 3 redo (2026-10-06)

The user watched the master: "die katze ist halt sehr groß, die ganzen proportionen stimmen nicht ... die barista
hinter der scheibe sieht aus als wäre sie vor der scheibe ... sehr glitchy ai". Decided: the whole video again from
the cold open (Variante 1). The big-cat version stays as a "cursed" cut for a forum and LinkedIn post:
`dist/video/v3/cursed/scumble_part3_cursed_1080p.mp4` (52 MB), `_720p` (24 MB), `_under10mb` (540p, 9.7 MB).
- Archive of the big-cat version: `dist/video/v3_bigcat/` (rec, takes, scenes, final, stack, coats, coldopen_v2).
- The cold open's picture again: `rec/scene3_cold_gen.py` (a real Generate new, 4k, 30.35 credits): the cat box
  460 x 240 at 2470,2000 (was 933 x 492), bin and sign boxes as before; scale from the bin (879 px, about 1.07 m) and
  the door (about 2.1 m = 1660 px). Result `dist/video/v3test/A2_coldopen.scumble` / `.jpg`; copied as
  `v3test/redo/A_coldopen.scumble` (the tab name on camera stays) and `v3/takes/N0_start.scumble`.
- `scene3_cold.py`: the new A_DOC and cat box; the result tab's boxes lose their description label (it covered half the
  cat at its true size), the tags stay. `coldopen_v2.html`: the camera leans in on the cat's box (1.7x) while the scan
  passes it and stands still before "...The cat's in the box.". Rendered: `dist/video/v3/coldopen_v2.mp4`.
- `scene3_notes.py`: new rects (the cup box 125 x 120 on the sill's cup ring, the Move from the cold open's box to the
  sill's left end, the barista's selection 640 x 620 inside the glass left of the machine) and the barista prompt
  "... wiping the counter behind the window glass."; a `move_path` rect for Note 02's follow-cam (`v3_n2.json`).
- Traps found: the cold open's setup leaves a click guard on Generate in the page: reload the page before a paid take.
  Black Forest Labs answered "over capacity ... temporarily shedding requests" several times that morning (no charge):
  `rec/retry_take.sh <note>` runs a take again every 2 minutes while that is the error.
- The takes again (the same scripts, the new rects): Note 01 the cup 125 x 120 on the sill's cup ring (right size next
  to the cat, its handle and rim kept); Note 02 the bin out (wall and drainpipe rebuilt), the cat moved to the sill's
  left end (first take hung it over the front edge: the sill lies about 75 px higher at the left, CAT_DST raised);
  Note 03 the barista 640 x 620 inside the glass left of the machine, "... behind the window glass": she stands in the
  shop, sharp at 100 %, freckled; Note 04 the Realism Pass in 10 s at 1.5x (ComfyUI connected for the take only, queue
  empty before and after), FACE_5456 / FACE_C_5456 moved to her face; 05, 06, the stack and the close as before. The
  close exports into `F:/Cafe Klecks/` (the status on camera reads "Saved F:/Cafe Klecks/cafe_klecks_poster.png ...")
  and the file is moved into `final/` after the take.
- Cost of the redo at BFL: 65.35 credits (the cold open 30.35, Note 01 5, Note 02 three times 5 + 10 + 10 for an
  over-capacity abort and the hanging cat, Note 03 5); the runs used in the video still add up to 50.35 credits.
- Motion: a new fx `loupe` in `scene_engine.html` (a round 100 % crop of the real result on a leader line, zooming with
  the camera; `img` relative to `dist/video/v3`, crops in `dist/video/v3/loupes/`): the cup in Note 01 ("Their cup.
  Their handle."), the barista's face in Note 03 ("FRECKLES ✓ · 100 %", replacing the old callout at fixed pixels).
- The cut: `build_final.py` with the end card a second later (CARD_AT 3.7; the bed one bar longer for it), two short
  cues lengthened in the SRT again ("Bless you." 1.5 s, "Done." 1.24 s); Resolve: the bin's clips deleted and imported
  fresh (the media pool kept the old frame counts), the timeline built again (10,031 frames, end card from 9,931),
  the master rendered with the H.264 Master preset.
- Also rebuilt from the new cold open and pushed (the user, 2026-10-06): the README's `hero.gif` and
  `before-after-cafe.jpg` (e7866f8; the GIF crop for the 1440p cold open is 2304:1296:128:96); the Product Hunt
  gallery and its `src_*.jpg` locally (the old ones in `dist/producthunt/_bigcat/`).
