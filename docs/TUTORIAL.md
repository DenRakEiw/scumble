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

**END CARD: scumble.app · Download for Windows and Linux · Manual, videos and the dev blog on
denrakeiw.com/scumble**

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
- **The honest line stays in:** the version number, "keep backups", "tell me what breaks". It is the
  README's voice, and it is why people trust the rest of it.

### Later videos, one feature each (60–90 s, no dialogue, just doing it)

1. Object hover and selection by text
2. Colour match, the before and after
3. Outpainting: extend the canvas and fill it
4. The film pack over a result
5. The assistant doing a real job end to end
6. PSD out, into Photoshop, layers intact
