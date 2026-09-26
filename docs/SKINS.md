# Skins

A skin changes how Scumble looks: its colours, fonts and shapes. It never changes the picture, and it
carries no code. Scumble ships two, **90s** and **Duck**; anyone can make another one.

- The mechanism: `electron/main/skins.js` (the manifest, which skin is in use, the virtual stylesheet),
  `renderer/skins.js` (switching in the window, the assistant's question drawn out of a skin's reach, the
  checks, *Settings › Appearance*), `renderer/protect.css` (what no skin can change) and
  `renderer/editor/inpaint_theme.js` (the token list and the canvas colours that follow it).
- The gate: `node tools/skins_test.js`, then `python tools/skins_test.py` (the `skins` gate).

## 1. What a skin is

A skin is a plugin folder without JavaScript. It lives where plugins live:

- `<userData>/plugins/<id>/`: your own. *Settings › Appearance › Open folder* opens it (on the Store copy,
  the folder Windows really keeps it in).
- `<app>/plugins/<id>/`: the built-in ones, `skin_90s` and `skin_duck`.

A user folder with the same name as a built-in one replaces it. The folder name is the skin's id: letters,
digits, `-` and `_`.

`plugin.json`:

```json
{
  "name": "Night shift",
  "version": "1.0.0",
  "description": "one line for the Appearance list",
  "author": "you",
  "homepage": "https://...",
  "registers": ["skin"],
  "skin": {
    "css": "skin.css",
    "background": "#101418",
    "swatch": ["#101418", "#1b2229", "#e8e2d4", "#6fb3a8"],
    "tokens": 1
  }
}
```

- `"registers": ["skin"]` makes the folder a skin, and nothing else may stand in that list.
- There is **no `entry`**: a manifest that has one is an error ("a skin carries no JavaScript").
- `skin.css`: the stylesheet, a relative path inside the folder, ending in `.css`. The default is `skin.css`.
- `skin.background`: the window's colour while it loads, as `#rrggbb`. The default is `#181818`.
- `skin.swatch`: up to six `#rrggbb` colours for the Appearance list. Anything else in it is dropped.
- `skin.tokens`: the token contract the skin was written for (section 3). The default is 1. A number above
  the app's shows "made for a newer Scumble"; the skin still works, but tokens the app does not know do
  nothing.

The folder serves only its stylesheet, pictures and fonts: `.css`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`,
`.svg`, `.woff`, `.woff2`, `.ttf` and `.otf`. Not its `plugin.json`, and nothing else.

A skin appears under *Settings › Appearance*, not under *Settings › Plugins*. The `list_plugins` command lists
it with `kind: "skin"`, and it is never loaded as a module.

## 2. How it applies

The window's stylesheets come in three parts:

1. `protect.css`, first, in an anonymous cascade layer. It pins what no skin may change (section 5), and every
   rule in it is `!important`.
2. The app's own CSS (`shell.css`, `assistant.css`, `help.css` and the editor's style) in the layer `app`.
3. The skin's stylesheet, **unlayered**. The window links `scumble://app/skin.css`, which the app answers with
   an `@import` of the chosen skin's stylesheet, or with nothing in the default look.

What that means for a skin:

- **A normal rule of a skin beats every rule of the app, whatever their specificity.** `button { ... }` in a
  skin wins over `#shell-settings button { ... }` in the app.
- **A skin's `!important` does not beat the app's `!important`** (the `[hidden]` rule, the update button) and
  never beats `protect.css`.
- Relative `url()`s in the stylesheet resolve inside the skin's folder: `url("lcd.png")`,
  `url("fonts/Mono.woff2")`.

## 3. The tokens (contract version 1)

Every colour, font family and radius of the app's CSS reads a token: `var(--sc-fg, #ddd)`. The app never sets
a token; each place keeps today's value as its fallback. A skin that sets a token changes every place that
reads it. A skin that leaves a token out leaves each of those places exactly as the default look has it.

| Token | Kind | Default | What it colours or shapes |
|---|---|---|---|
| `--sc-bg` | color | `#181818` | the window's background (body, the editor) |
| `--sc-chrome` | color | `#1f1f1f` | bars: the top bar, the active tab, the editor's top and bottom bars, the side columns' head and foot, the rulers |
| `--sc-chrome-edge` | color | `#000` | the hard dividers between those regions |
| `--sc-surface` | color | `#202020` | dialogs, the side panel, the tool column, the assistant and Help columns, the editor's question box, the floating options bar |
| `--sc-raised` | color | `#262626` | bubbles, cards, flyouts, section heads, row and tab hover, the curves histogram |
| `--sc-selected` | color | `#2b3a4f` | the selected or on state: the selected layer, toggled buttons, your chat bubble, a search hit |
| `--sc-well` | color | `#161616` | sunken areas: tab strips, logs, code, reports, thumbnail backdrops, the curves canvas |
| `--sc-field` | color | `#111` | inputs, selects, text areas, the progress track |
| `--sc-btn` | color | `#2d2d2d` | the face of buttons and colour inputs |
| `--sc-btn-hover` | color | `#3a3a3a` | a button under the pointer or pressed |
| `--sc-border` | color | `#444` | dialog and panel frames, button outlines |
| `--sc-line` | color | `#333` | dividers, the borders of fields, wells and cards, row separators, the ruler's edge |
| `--sc-fg-strong` | color | `#eee` | emphasised text |
| `--sc-fg` | color | `#ddd` | body and input text, the brush-tip glyph, the curves' RGB line |
| `--sc-fg-2` | color | `#aaa` | secondary text |
| `--sc-muted` | color | `#888` | hints, meta lines, section heads, inactive tabs, the ruler's numbers |
| `--sc-faint` | color | `#777` | faint and disabled marks, the idle dot, the ruler's ticks |
| `--sc-accent` | color | `#f0c674` | the logo, dialog titles, links in Settings, the active tab's line, busy states, toggled-on text, the filter-layer kind |
| `--sc-active` | color | `#4a90d9` | focus borders, the active tab's underline, the selected layer's stripe, drop lines, the progress bar |
| `--sc-active-bg` | color | `#2f5f9f` | the face of the active tool and of the update button |
| `--sc-on-active` | color | `#fff` | text on `active-bg` and on `go` |
| `--sc-go` | color | `#2f6b3f` | Generate, Upscale and the other primary buttons |
| `--sc-warn` | color | `#f0c674` | warnings, the control-layer kind, a recipe's missing-key note |
| `--sc-ok` | color | `#7cc47f` | success, the connected dot |
| `--sc-error` | color | `#e0533d` | errors, the error dot, delete on hover |
| `--sc-error-bg` | color | `#3a1f1c` | behind errors, a danger button on hover |
| `--sc-link` | color | `#7cc7ff` | informational text: the log's source, a tool card's name, Help's links, the reference-layer kind |
| `--sc-backdrop` | color | `rgba(0, 0, 0, 0.55)` | behind modal dialogs and the editor's question |
| `--sc-shadow` | shadow | `0 8px 24px rgba(0,0,0,.55)` | the whole `box-shadow` of popups |
| `--sc-scheme` | scheme | `normal` | `color-scheme`: native controls and scroll bars (`dark` or `light`) |
| `--sc-control` | control | `auto` | `accent-color`: checkboxes, radios, range sliders |
| `--sc-scrollbar` | scrollbar | `auto` | `scrollbar-color` (thumb and track) |
| `--sc-font` | font | `system-ui, sans-serif` | the interface's font family |
| `--sc-font-mono` | font | `ui-monospace, Consolas, monospace` | the monospaced font family |
| `--sc-radius-sm` | radius | `3px` | wells, cards, code, thumbnails |
| `--sc-radius` | radius | `3px` | buttons and fields |
| `--sc-radius-lg` | radius | `6px` | dialogs, bubbles, popups |

"Default" is the value the token stands for. Near duplicates in the app share one token but keep their own
exact old value as their fallback (a card at `#232323` and one at `#262626` both read `--sc-raised`), so in
the default look nothing moved.

**Versions.** The contract has a number, today 1 (`skin.tokens` in `plugin.json`). Adding a token keeps the
number: an older skin just does not set it. Removing a token, renaming one or changing what it means raises
the number.

## 4. Rules for a skin's stylesheet

- **Declare the tokens on `:root`.** A token may be set on a smaller part (`#assistant { --sc-surface: ... }`),
  but the colours drawn on canvases (section 6) read only `:root`.
- **Leave out what you do not want to change.** An unset token keeps each place's own default.
- **A value of the wrong kind is reset.** After a skin is loaded, each token is checked against the property
  of its kind: `color` for colours, `font-family`, `border-radius`, `box-shadow`, `color-scheme`,
  `accent-color` and `scrollbar-color`. A value that fails (`--sc-bg: 12px`) is taken back, that token falls
  back to its default everywhere, and *Settings › Appearance* says so under the skin.
- **Nothing from the internet.** Fonts are system fonts or files in the folder; pictures are files in the
  folder or `data:` URLs. The window's content security policy and its cross-origin isolation block anything
  else, and the Appearance list names every `url()` or `@import` that tries. A `url()` into the app itself
  (`../../comfy/...`, another plugin's folder) does load, since it is the app, but it is no part of the skin,
  and the list names it too.
- Free CSS is allowed: gradients, bevels, `::-webkit-scrollbar`, `::selection`, a font size for the whole
  editor. It is how a skin gets a look the tokens alone cannot give (section 8 says what that costs).

A minimal skin:

```css
:root {
    --sc-bg: #101418;
    --sc-surface: #1b2229;
    --sc-fg: #e8e2d4;
    --sc-accent: #6fb3a8;
    --sc-radius: 6px;
}
```

## 5. What a skin cannot change

- **The assistant's questions.** The card that asks before a paid run or a change it cannot take back, its
  text and its *Allow* and *Don't* buttons, look the same in every skin, because no skin reaches it: its parts
  sit in a shadow root with their own copy of the default look, which no selector of a skin matches, and its
  own box starts from `all: initial` in a rule that beats every rule outside it. While the question is open
  the card lies in the window's top layer, where nothing a stylesheet does can be painted over it; it sits over
  a spacer in the chat and scrolls and clips with it, so it looks like any other card. A light skin shows it
  dark on purpose. `protect.css` keeps the elements around it up to the window from being hidden, faded, moved
  or zoomed. What a skin still decides is where the chat is and how big it is. So whenever a question appears,
  whenever the skin is switched while one is open, and four times a second while it is open, the app checks
  that the chat can show it, that it is large enough, and that both buttons can be reached and read *Allow*
  before *Don't*. **A skin that fails the check is switched off**: the default look comes back, the reason goes
  into the app log, the status line and the Appearance list, and the skin stays off until it is chosen again.
  That includes a skin that shrinks the chat later, on a delay or when the pointer comes near.
- **Masked keys.** A key field shows dots in every skin (the browser pins that).
- **The picture and what is drawn on it.** The selection outline, the brush ring, the crop and reference
  frames, handles and guides are drawn on the canvas and never read a token, so they keep their contrast on
  any picture.
- **The neutral grey around the picture**, so a skin does not change how the picture's colours look.
- **The order of the editor's own question buttons.**

## 6. Canvas colours

Most of the editor draws on canvases. Only its chrome follows the tokens, read from `:root` once per switch:

- the rulers: `--sc-chrome` (background), `--sc-line` (edge), `--sc-muted` (numbers), `--sc-faint` (ticks);
- the brush-tip thumbnail's glyph: `--sc-fg`;
- the curves control: `--sc-well` (background), `--sc-raised` (histogram), `--sc-line` (grid and diagonal),
  `--sc-fg-strong` (the active point), `--sc-muted` (the hint), `--sc-fg` (the RGB curve).

Everything drawn on the picture stays as it is (section 5), and so do the red, green and blue of the curves'
channels. A plugin that draws colours of its own can listen for the `theme` event (docs/PLUGINS.md) and read
the tokens with `getComputedStyle(document.documentElement)`.

## 7. Switching

- **Settings › Appearance**: the default look and every skin folder, each with its swatch and its state (in
  use, available, error, switched off, made for a newer Scumble). A choice applies at once: the new stylesheet
  is loaded before the old one goes, so the window never shows a frame in between. *Reload skins* reads the
  folders and the stylesheet again (for a skin's author: edit, reload). *Reload plugins* does the same.
- **View › Skin**: the same choice from the menu. The menu is drawn by the system, out of any skin's reach, so
  **View › Skin › Default** always brings the default look back.
- **`--no-skin`** on the command line starts without a skin and keeps the choice for the next start.
- The choice is stored in `settings.json` as `appearance: { "skin": "<id>", "refused": null }` (`""` is the
  default look). `refused` holds the skin that was switched off, with the reason and the time.

When the chosen skin's folder is gone, or its manifest has an error, the default look is used and the choice is
kept; Appearance says what is wrong. A stylesheet that does not load or is empty switches the skin off like a
failed check.

## 8. Stable and unstable

- **The tokens are the stable part.** A skin that only sets tokens keeps working across versions; the contract
  number (section 3) says when that changes.
- **Free CSS that names the app's ids and classes is unstable.** The markup changes between versions without
  notice, as the app's modules do for plugins. Write it, but expect to follow the app.
- A rule aimed at something the app protects (the question card, which no rule reaches at all, `.as-reason`,
  a key's state, a password field, `.ipc-view`) changes nothing that matters; the Appearance list names such
  rules, a rule in a layer named `app` or `protect`, and a `url()` that reaches out of the skin's folder into
  the app.

## 9. The built-in skins

Both set every token, use only system fonts and draw their decoration with CSS gradients: no pictures, no
downloaded fonts. Read them as examples.

- **90s** (`plugins/skin_90s`): a late-90s media player. Bevelled slate panels, black LCD readouts with green
  segment text and scan lines, a small spectrum next to the logo, a segmented progress meter, title-bar strips
  on the dialogs, square corners and small type.
- **Duck** (`plugins/skin_duck`): warm cream panels, lavender bars and an orange accent in soft, rounded
  shapes, a dark face-plate top bar, a round lens mark on the primary buttons, soft shadows. The assistant's
  questions stay dark inside it (section 5).

## 10. Names and artwork

Do not ship other people's names, logos, wordmarks or artwork in a skin: not in its folder name, its
`plugin.json`, its stylesheet or its pictures. A look may recall an era or a device; a skin under someone
else's name reads as their endorsement. Make the drawings yourself (CSS, or pictures you made), and check the
licence of any font file you put in the folder.
