"""The prompt field of item 26 (docs/PLAN_REFS.md 26c1): steps of the editor gate (tools/editor_test.py), against the
running app with real input through CDP (Input.insertText, Input.dispatchKeyEvent, Input.imeSetComposition,
Input.dispatchMouseEvent). Each step makes its own document (the test base and two references, "jacket" = @img1 and
"coat" = @img2), shows the Generate pane with the field focused, and closes the document at its end.

- prompt_field_is_the_textarea_for_every_reader: value / selection / placeholder / disabled / focus as a textarea's,
  normalised tokens drawn as chips (the hidden "@" of zero width, innerText reads the token), the states live,
  inactive (a hidden reference, its layer name) and broken, the empty field's placeholder.
- prompt_field_types_deletes_and_moves_over_chips: typing, Backspace and Delete take a chip whole, the arrows step over
  it, Enter, a caret on both sides of a chip that stands between two others, a typed token becomes a chip at the space
  (and not before), a word typed against a chip gets its space, and the editor's own undo never moves.
- prompt_field_undo_redo_paste_and_copy: the field's undo in word steps with the caret, a paste with CR LF and U+200B,
  a copy over a chip, an undo after a remap (a reference hidden) gives the remapped older text, "reset" empties it.
- prompt_field_leaves_a_composition_alone: no redraw while an IME composes (the chip nodes stay), no line from its
  Enter, the commit, and a remap that arrives mid-composition applied to the composed text.
- prompt_field_keeps_the_editor_keys: Ctrl+Enter and Ctrl+U reach their methods, Escape hands the focus to the editor,
  Backspace / Delete / Ctrl+Z in the field touch no layer and no editor undo, the AltGr probe (Ctrl+Alt "@") runs no
  shortcut, and a click on a chip's chevron keeps the focus in the field (and opens its swap menu, which the first
  Escape closes).
"""
import asyncio
import json

# the document every step works on; `pfSetup` makes it, `pfClose` closes it and goes back to the gate's test tab
SETUP = r"""
const file = { filename: "test_base.png", subfolder: "inpaint_canvas", type: "input" };
const pfSetup = async () => {
    const d = await run("new_document");
    await run("load_image", { ...file, doc: d.id });
    const ed = ednow(d.id);
    host.shell.activate(ed);
    await run("add_image_layer", { ...file, role: "reference", name: "jacket", doc: d.id });
    await run("add_image_layer", { ...file, role: "reference", name: "coat", doc: d.id });
    if (!ed.promptField) throw new Error("no prompt field: host.refTokens is off in the app");
    // showPane remembers the pane for every document opened later ("ipc.pane"): pfClose puts back the one found here,
    // or a later gate's new document opens on Generate (film's panel_thumbnails rendered nothing, 2026-09-29)
    if (window.__pfPane === undefined) { try { window.__pfPane = localStorage.getItem("ipc.pane"); } catch (_) { window.__pfPane = null; } }
    ed.showPane("gen");
    const det = ed.promptInput.closest("details");
    if (det) det.open = true;
    ed.promptInput.focus();
    window.__pf = d.id;
    return ed;
};
const pfClose = async () => {
    if (window.__pf != null) await run("close_document", { doc: window.__pf, force: true });
    window.__pf = null;
    const t = ednow(window.__t);
    host.shell.activate(t);
    if (window.__pfPane !== undefined) { t.showPane(window.__pfPane || "image"); window.__pfPane = undefined; }
};
const pf = () => ednow(window.__pf);
const chips = (ed) => [...ed.promptInput.querySelectorAll(".ipc-chip")].map((c) => c.dataset.token + ":" + c.dataset.state);
const same = (what, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(what + ": " + JSON.stringify(got) + ", not " + JSON.stringify(want)); };
"""

KEYS = {
    "Backspace": 8, "Delete": 46, "ArrowLeft": 37, "ArrowRight": 39, "ArrowUp": 38, "ArrowDown": 40, "Home": 36,
    "End": 35, "Enter": 13, "Escape": 27,
}
ALT, CTRL, SHIFT = 1, 2, 8


async def key(c, name, mods=0, text=None, code=None):
    """One key down and up. `text` makes it a key that types (keyDown with text), else a rawKeyDown."""
    vk = KEYS.get(name) or ord(name.upper()[0])
    common = dict(key=name, code=code or (name if name in KEYS else "Key" + name.upper()), windowsVirtualKeyCode=vk,
                  nativeVirtualKeyCode=vk, modifiers=mods)
    down = dict(common, type="keyDown" if text is not None else "rawKeyDown")
    if text is not None:
        down["text"] = down["unmodifiedText"] = text
    await c.call("Input.dispatchKeyEvent", **down)
    await c.call("Input.dispatchKeyEvent", **dict(common, type="keyUp"))
    await asyncio.sleep(0.03)


async def typ(c, text):
    """Typed one character at a time, as the keyboard delivers it (each its own beforeinput)."""
    for ch in text:
        await c.call("Input.insertText", text=ch)
        await asyncio.sleep(0.02)


async def js(c, pre, body, timeout=120):
    return await c.eval(pre % (SETUP + body), timeout=timeout)


# ---- the steps ----------------------------------------------------------------------------------------------------

async def is_the_textarea_for_every_reader(c, pre):
    return await js(c, pre, r"""
const ed = await pfSetup();
try {
    const el = ed.promptInput, out = {};
    if (!el.isContentEditable || el !== ed.promptField.el) throw new Error("promptInput is not the field's contenteditable");
    if (document.activeElement !== el) throw new Error("the field did not take the focus: " + (document.activeElement && document.activeElement.className));
    // set from code: normalised (the token's prefix, CR LF), drawn as chips, promptText and value the same
    ed.setPromptText("a @img1 and @IMG2\r\nb");
    same("value", el.value, "a @img1 and @img2\nb");
    same("promptText", ed.promptText, el.value);
    same("chips", chips(ed), ["@img1:live", "@img2:live"]);
    const at = el.querySelector(".ipc-chip-at");
    out.atWidth = at.getBoundingClientRect().width;
    if (out.atWidth !== 0) throw new Error("the hidden @ is " + out.atWidth + " px wide");
    out.innerText = el.innerText;
    if (!el.innerText.includes("@img1") || !el.innerText.includes("@img2")) throw new Error("innerText does not read the tokens: " + JSON.stringify(el.innerText));
    if (!el.querySelector(".ipc-chip img.ipc-chip-av").getAttribute("src")) throw new Error("a live chip has no thumbnail");
    // the selection as a textarea's: kept while the field has no focus, back at focus()
    el.setSelectionRange(3, 3);
    same("selection", [el.selectionStart, el.selectionEnd], [2, 2]);   // inside @img1 [2, 7): its nearer edge
    el.setSelectionRange(8, 11);
    el.blur();
    same("selection while blurred", [el.selectionStart, el.selectionEnd], [8, 11]);
    el.focus();
    if (document.activeElement !== el) throw new Error("focus() did not focus the field");
    same("selection after focus()", [el.selectionStart, el.selectionEnd], [8, 11]);
    const s = document.getSelection();
    if (!el.contains(s.anchorNode) || s.toString() !== "and") throw new Error("the document selection after focus() is " + JSON.stringify(s.toString()));
    // a hidden reference: its token parks, the chip is inactive and shows the layer's name; a number no layer holds is broken
    const coat = ed.layers.find((l) => l.name === "coat");
    ed.setPromptText("the @img2 on @img9", { history: "reset" });
    await run("set_layer", { layer: coat.id, visible: false });
    same("parked", ed.promptText, "the @img?" + coat.id + " on @img9");
    same("states", chips(ed), ["@img?" + coat.id + ":inactive", "@img9:broken"]);
    const labels = [...el.querySelectorAll(".ipc-chip-label")].map((x) => x.textContent);
    same("labels", labels, ["coat", "img9"]);
    // the reason a chip does not go (26c2: the hover card shows it; the chip has no title)
    out.reasons = [...el.querySelectorAll(".ipc-chip")].map((x) => x.dataset.reason || "");
    if (!/hidden/.test(out.reasons[0]) || !/no reference img9/.test(out.reasons[1])) throw new Error("the reasons: " + JSON.stringify(out.reasons));
    await run("set_layer", { layer: coat.id, visible: true });
    same("shown again", [ed.promptText, chips(ed)], ["the @img2 on @img9", ["@img2:live", "@img9:broken"]]);
    // a deleted reference: broken, img?
    const jacket = ed.layers.find((l) => l.name === "jacket");
    ed.setPromptText("of @img1", { history: "reset" });
    await run("remove_layer", { layer: jacket.id });
    same("deleted", chips(ed), ["@img?" + jacket.id + ":broken"]);
    same("deleted label", el.querySelector(".ipc-chip-label").textContent, "img?");
    // the empty field shows its placeholder; placeholder and disabled as a textarea's
    ed.setPromptText("");
    if (!el.classList.contains("ipc-pf-empty") || !el.placeholder) throw new Error("the empty field shows no placeholder: " + el.className);
    el.disabled = true;
    if (el.isContentEditable || !el.disabled) throw new Error("disabled did not stop editing");
    el.disabled = false;
    if (!el.isContentEditable) throw new Error("disabled = false did not give editing back");
    out.drift = ed._refDrift || 0;
    if (out.drift) throw new Error("the reference labels drifted " + out.drift + " times");
    return out;
} finally { await pfClose(); }
""")


async def types_deletes_and_moves_over_chips(c, pre):
    await js(c, pre, r"""
const ed = await pfSetup();
ed.setPromptText("a @img1 @img2", { history: "reset" });
ed.promptInput.setSelectionRange(13, 13);
window.__pfUndo = ed.undo.length;
return 1;
""")
    out = {}

    async def state():
        return await js(c, pre, r"""
const ed = pf(), el = ed.promptInput;
return { v: el.value, p: ed.promptText, sel: [el.selectionStart, el.selectionEnd], chips: chips(ed), undo: ed.undo.length, layers: ed.layers.length };
""")

    async def expect(what, v, sel=None, chip_count=None):
        s = await state()
        if s["v"] != v or s["p"] != v:
            raise Exception("%s: the field holds %s (promptText %s), not %s" % (what, json.dumps(s["v"]), json.dumps(s["p"]), json.dumps(v)))
        want = sel if isinstance(sel, list) else [sel, sel]
        if sel is not None and s["sel"] != want:
            raise Exception("%s: the selection is %s, not %s" % (what, s["sel"], want))
        if chip_count is not None and len(s["chips"]) != chip_count:
            raise Exception("%s: %d chips, not %d (%s)" % (what, len(s["chips"]), chip_count, s["chips"]))
        out[what] = s
        return s

    try:
        # a letter typed right after a chip gets a space before it (a word against the chip would make it text)
        await typ(c, "x")
        await expect("x after a chip", "a @img1 @img2 x", 15, 2)
        await key(c, "Backspace")
        await key(c, "Backspace")
        await expect("x and its space deleted", "a @img1 @img2", 13, 2)
        # Backspace right after a chip takes it whole
        await key(c, "Backspace")
        await expect("Backspace takes the chip", "a @img1 ", 8, 1)
        # the arrows step over a whole chip; Delete in front of one takes it whole
        await key(c, "ArrowLeft")
        await expect("ArrowLeft to the space", "a @img1 ", 7)
        await key(c, "ArrowLeft")
        await expect("ArrowLeft over the chip", "a @img1 ", 2)
        await key(c, "ArrowRight")
        await expect("ArrowRight over the chip", "a @img1 ", 7)
        await key(c, "ArrowLeft")
        await key(c, "Delete")
        await expect("Delete takes the chip", "a  ", 2, 0)
        # Enter is a line break of the field (Shift+Enter too); a typed token is text until the space ends it
        await key(c, "Enter")
        await expect("Enter", "a \n ", 3)
        await typ(c, "@img2")
        await expect("typing @img2", "a \n@img2 ", 8, 0)
        await typ(c, " ")
        await expect("the space makes it a chip", "a \n@img2  ", 9, 1)
        # a letter typed right before a chip gets a space after it, and a space typed there steps over that one
        await js(c, pre, "pf().promptInput.setSelectionRange(3, 3); return 1;")
        await typ(c, "on")
        await expect("a word against the chip's front", "a \non @img2  ", 5, 1)
        await typ(c, " ")
        await expect("the typed space steps over the field's", "a \non @img2  ", 6, 1)
        # a chip between two others: the caret can stand on either side of the comma between them
        await js(c, pre, r"""
const el = pf().promptInput;
pf().setPromptText("@img1,@img2,@img1", { history: "reset" });
el.setSelectionRange(5, 5);
return 1;
""")
        await typ(c, ";")
        await expect("between chip and comma", "@img1;,@img2,@img1", 6, 3)
        await js(c, pre, "pf().promptInput.setSelectionRange(13, 13); return 1;")
        await typ(c, "(")
        await expect("between comma and chip", "@img1;,@img2,(@img1", 14, 3)
        # an @ typed in front of "img1" makes a chip around the caret: the caret goes after it, the next letter too
        await js(c, pre, 'pf().setPromptText("a img1 b", { history: "reset" }); pf().promptInput.setSelectionRange(2, 2); return 1;')
        await typ(c, "@")
        await expect("@ typed in front of img1", "a @img1 b", 7, 1)
        await typ(c, "z")
        await expect("the next letter goes after that chip", "a @img1 z b", 9, 1)
        # Shift+ArrowLeft right after a typed token: it becomes a chip and the selection takes the whole of it
        await js(c, pre, 'pf().setPromptText("foo ", { history: "reset" }); pf().promptInput.setSelectionRange(4, 4); return 1;')
        await typ(c, "@img1")
        await key(c, "ArrowLeft", SHIFT)
        await expect("Shift+ArrowLeft over the token just typed", "foo @img1", [4, 9], 1)
        # a press on a chip puts the caret beside it, on the side pressed, and typing goes on from there
        for side, want, caret in (("right", "x @img1 q y", 9), ("left", "x q @img1 y", 3)):
            xy = await js(c, pre, r"""
const ed = pf();
ed.setPromptText("x @img1 y", { history: "reset" });
ed.promptInput.setSelectionRange(0, 0);
const r = ed.promptInput.querySelector(".ipc-chip-label").getBoundingClientRect();
return [%s, r.top + r.height / 2];
""" % ("r.right - 2" if side == "right" else "ed.promptInput.querySelector('.ipc-chip').getBoundingClientRect().left + 3"))
            for kind in ("mousePressed", "mouseReleased"):
                await c.call("Input.dispatchMouseEvent", type=kind, x=xy[0], y=xy[1], button="left", buttons=1 if kind == "mousePressed" else 0, clickCount=1)
            await asyncio.sleep(0.05)
            await typ(c, "q")
            await expect("a press on the chip's %s, then a letter" % side, want, caret, 1)
        # Backspace on the space between a chip and a word steps over it (the chip would turn into text), then takes the chip
        await js(c, pre, 'pf().setPromptText("@img1 jacket", { history: "reset" }); pf().promptInput.setSelectionRange(6, 6); return 1;')
        await key(c, "Backspace")
        await expect("Backspace on the chip's space", "@img1 jacket", 5, 1)
        await key(c, "Backspace")
        await expect("the next Backspace takes the chip", " jacket", 0, 0)
        s = await state()
        undo_before = await js(c, pre, "return window.__pfUndo;")
        if s["undo"] != undo_before:
            raise Exception("the editor's undo moved from %d to %d" % (undo_before, s["undo"]))
        return {k: v["v"] for k, v in out.items()}
    finally:
        await js(c, pre, "await pfClose(); return 1;")


async def undo_redo_paste_and_copy(c, pre):
    await js(c, pre, r"""
const ed = await pfSetup();
ed.setPromptText("", { history: "reset" });
return 1;
""")
    try:
        await typ(c, "one two")
        r = await js(c, pre, "const el = pf().promptInput; return { v: el.value, n: pf().promptField.history.undoCount };")
        if r["v"] != "one two" or r["n"] != 2:
            raise Exception("typing one two: %s" % json.dumps(r))
        await key(c, "z", CTRL)
        await js(c, pre, 'const el = pf().promptInput; same("undo", [el.value, el.selectionStart], ["one", 3]); return 1;')
        await key(c, "z", CTRL)
        await js(c, pre, 'const el = pf().promptInput; same("undo 2", [el.value, el.selectionStart, pf().promptText], ["", 0, ""]); return 1;')
        await key(c, "y", CTRL)
        await js(c, pre, 'const el = pf().promptInput; same("redo", [el.value, el.selectionStart], ["one", 3]); return 1;')
        await key(c, "z", CTRL | SHIFT)
        await js(c, pre, 'const el = pf().promptInput; same("Ctrl+Shift+Z", [el.value, el.selectionStart, pf().promptText], ["one two", 7, "one two"]); return 1;')
        r = await js(c, pre, r"""
const ed = pf(), el = ed.promptInput;
// a paste: CR LF becomes LF, U+200B goes, the token becomes a chip, one undo step
const dt = new DataTransfer();
dt.setData("text/plain", " see @img1\r\nthere" + String.fromCharCode(0x200b));
const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
el.dispatchEvent(ev);
if (!ev.defaultPrevented) throw new Error("the field let the browser paste");
same("paste", [el.value, ed.promptText, chips(ed)], ["one two see @img1\nthere", "one two see @img1\nthere", ["@img1:live"]]);
// a copy over a chip gives its token
el.setSelectionRange(8, 17);
const dc = new DataTransfer();
const cp = new ClipboardEvent("copy", { clipboardData: dc, bubbles: true, cancelable: true });
el.dispatchEvent(cp);
same("copy", dc.getData("text/plain"), "see @img1");
el.setSelectionRange(el.value.length, el.value.length);
return 1;
""")
        # an undo after a remap gives the older text remapped: @img1 parks while jacket is hidden
        await typ(c, " x")
        r = await js(c, pre, r"""
const ed = pf(), el = ed.promptInput;
const jacket = ed.layers.find((l) => l.name === "jacket");
await run("set_layer", { layer: jacket.id, visible: false });
el.focus();
same("parked", ed.promptText, "one two see @img?" + jacket.id + "\nthere x");
window.__pfJacket = jacket.id;
return 1;
""")
        await key(c, "z", CTRL)
        r = await js(c, pre, r"""
const ed = pf(), el = ed.promptInput, id = window.__pfJacket;
same("undo after the remap", el.value, "one two see @img?" + id + "\nthere");
await run("set_layer", { layer: id, visible: true });
same("shown again", ed.promptText, "one two see @img1\nthere");
// "reset" empties the undo, also when the text stays the same
ed.setPromptText("fresh", { history: "reset" });
same("reset", [ed.promptField.history.undoCount, ed.promptField.history.redoCount], [0, 0]);
ed.setPromptText("fresh");
ed.setPromptText("fresh", { history: "reset" });
same("reset with the same text", ed.promptField.history.undoCount, 0);
// a remap that leaves the text shown alone still reaches the undo: an older state names jacket, which moves to img2
ed.setPromptText("@img1 jacket", { history: "reset" });
el.focus();
el.setSelectionRange(0, el.value.length);
const dt2 = new DataTransfer();
dt2.setData("text/plain", "a red coat");
el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt2, bubbles: true, cancelable: true }));
const coat = ed.layers.find((l) => l.name === "coat");
ed.moveReference(coat, +1);
same("coat is img1 now", ed.refLabels().get(coat.id), 1);
same("the text shown", ed.promptText, "a red coat");
return { value: el.value };
""")
        await key(c, "z", CTRL)
        await js(c, pre, 'same("the undo names jacket as img2", [pf().promptInput.value, pf().promptText], ["@img2 jacket", "@img2 jacket"]); return 1;')
        return r
    finally:
        await js(c, pre, "await pfClose(); return 1;")


async def leaves_a_composition_alone(c, pre):
    await js(c, pre, r"""
const ed = await pfSetup();
ed.setPromptText("x @img1 @img2", { history: "reset" });
ed.promptInput.setSelectionRange(1, 1);
window.__pfChips = [...ed.promptInput.querySelectorAll(".ipc-chip")];
return 1;
""")
    kept = 'const now = [...pf().promptInput.querySelectorAll(".ipc-chip")]; return now.length === window.__pfChips.length && now.every((x, i) => x === window.__pfChips[i]);'
    try:
        await c.call("Input.imeSetComposition", text="a", selectionStart=1, selectionEnd=1)
        if not await js(c, pre, kept):
            raise Exception("the chips were drawn anew when the composition started")
        await c.call("Input.imeSetComposition", text="ä", selectionStart=1, selectionEnd=1)
        # an Enter while composing belongs to the IME: no line break
        await key(c, "Enter")
        r = await js(c, pre, 'return { v: pf().promptInput.value, composing: pf().promptField.composing };')
        if "\n" in r["v"] or not r["composing"]:
            raise Exception("while composing: %s" % json.dumps(r))
        if not await js(c, pre, kept):
            raise Exception("the chips were drawn anew during the composition")
        await c.call("Input.insertText", text="ä")
        r = await js(c, pre, r"""
const ed = pf(), el = ed.promptInput;
same("committed", [el.value, ed.promptText, el.selectionStart, ed.promptField.composing], ["xä @img1 @img2", "xä @img1 @img2", 2, false]);
return 1;
""")
        if not await js(c, pre, kept):
            raise Exception("the chips were drawn anew at the commit")
        # a remap that comes while composing waits, and then applies to the composed text
        await js(c, pre, "pf().promptInput.setSelectionRange(0, 0); return 1;")
        await c.call("Input.imeSetComposition", text="o", selectionStart=1, selectionEnd=1)
        await js(c, pre, r"""
const ed = pf();
window.__pfCoat = ed.layers.find((l) => l.name === "coat").id;
await run("set_layer", { layer: window.__pfCoat, visible: false });
return 1;
""")
        await c.call("Input.insertText", text="o")
        r = await js(c, pre, r"""
const ed = pf(), el = ed.promptInput, id = window.__pfCoat;
same("remap after the composition", [el.value, ed.promptText], ["oxä @img1 @img?" + id, "oxä @img1 @img?" + id]);
same("chips after it", chips(ed), ["@img1:live", "@img?" + id + ":inactive"]);
await run("set_layer", { layer: id, visible: true });
el.setSelectionRange(0, 0);
return { value: el.value };
""")
        # an agent's prompt during a composition, then a remap: promptText says the outcome at once, and the commit
        # leaves the written text with the remap on it (the composed letter gives way to the explicit write)
        await c.call("Input.imeSetComposition", text="k", selectionStart=1, selectionEnd=1)
        await js(c, pre, r"""
const ed = pf(), id = window.__pfCoat;
ed.setPromptText("set during @img2");
same("promptText right after the write", ed.promptText, "set during @img2");
await run("set_layer", { layer: id, visible: false });
same("promptText after the remap", ed.promptText, "set during @img?" + id);
return 1;
""")
        await c.call("Input.insertText", text="k")
        r = await js(c, pre, r"""
const ed = pf(), el = ed.promptInput, id = window.__pfCoat;
same("both writes after the commit", [el.value, ed.promptText], ["set during @img?" + id, "set during @img?" + id]);
await run("set_layer", { layer: id, visible: true });
same("shown again", ed.promptText, "set during @img2");
return { value: el.value, first: 1 };
""")
        return r
    finally:
        await js(c, pre, "await pfClose(); return 1;")


async def keeps_the_editor_keys(c, pre):
    await js(c, pre, r"""
const ed = await pfSetup();
ed.setPromptText("a @img1 b", { history: "reset" });
ed.promptInput.setSelectionRange(9, 9);
// stubs on the instance, deleted at the end: the prototype's methods come back
window.__pfCalls = [];
ed.generate = function () { window.__pfCalls.push("generate"); };
ed.upsamplePrompt = function () { window.__pfCalls.push("upsample"); };
ed.onKey = function (e) { window.__pfCalls.push("onKey " + e.key); };
ed.activeLayerId = ed.layers[ed.layers.length - 1].id;
window.__pfBefore = { layers: ed.layers.length, undo: ed.undo.length };
return 1;
""")
    try:
        await key(c, "Enter", CTRL)
        await key(c, "u", CTRL)
        await key(c, "Backspace")
        await key(c, "Delete")
        await key(c, "z", CTRL)
        # AltGr+Q types @ on a German keyboard: Chromium reports it with Ctrl and Alt down; it is typing, not a shortcut
        await key(c, "@", CTRL | ALT, text="@", code="KeyQ")
        r = await js(c, pre, r"""
const ed = pf(), el = ed.promptInput;
same("the calls", window.__pfCalls, ["generate", "upsample"]);
same("the layers and the editor's undo", { layers: ed.layers.length, undo: ed.undo.length }, window.__pfBefore);
// Backspace took the b, Delete at the end nothing, Ctrl+Z gave the b back, AltGr+Q typed its @
same("the text after the keys", [el.value, el.selectionStart], ["a @img1 b@", 10]);
if (document.activeElement !== el) throw new Error("the field lost the focus to a key");
// a click on a chip's chevron keeps the focus in the field
const r = el.querySelector(".ipc-chip-chev").getBoundingClientRect();
window.__pfChev = [r.left + r.width / 2, r.top + r.height / 2];
return { value: el.value };
""")
        x, y = await js(c, pre, "return window.__pfChev;")
        for kind in ("mousePressed", "mouseReleased"):
            await c.call("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left", buttons=1 if kind == "mousePressed" else 0, clickCount=1)
        await asyncio.sleep(0.1)
        focused = await js(c, pre, "return [document.activeElement === pf().promptInput, document.querySelectorAll('.ipc-refpop[data-mode=swap]').length];")
        if focused != [True, 1]:
            raise Exception("a click on the chevron: focus in the field, one swap menu: %s" % json.dumps(focused))
        # the first Escape closes the swap menu (26c2) and leaves the focus in the field, the second hands it on
        await key(c, "Escape")
        first = await js(c, pre, "return [document.activeElement === pf().promptInput, document.querySelectorAll('.ipc-refpop').length];")
        if first != [True, 0]:
            raise Exception("the first Escape: focus in the field, no menu: %s" % json.dumps(first))
        await key(c, "Escape")
        r2 = await js(c, pre, r"""
const ed = pf();
if (document.activeElement !== ed.root) throw new Error("Escape did not hand the focus to the editor: " + (document.activeElement && document.activeElement.className));
same("no editor shortcut ran", window.__pfCalls, ["generate", "upsample"]);
return 1;
""")
        return {"value": r["value"], "escape": r2}
    finally:
        await js(c, pre, r"""
const ed = pf();
if (ed) { delete ed.generate; delete ed.upsamplePrompt; delete ed.onKey; }
await pfClose();
return 1;
""")


STEPS = [
    ("prompt_field_is_the_textarea_for_every_reader", is_the_textarea_for_every_reader),
    ("prompt_field_types_deletes_and_moves_over_chips", types_deletes_and_moves_over_chips),
    ("prompt_field_undo_redo_paste_and_copy", undo_redo_paste_and_copy),
    ("prompt_field_leaves_a_composition_alone", leaves_a_composition_alone),
    ("prompt_field_keeps_the_editor_keys", keeps_the_editor_keys),
]
