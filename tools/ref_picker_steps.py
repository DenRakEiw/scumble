"""The @ picker, the reference bar, the hover card, the swap menu and the chip drag of item 26 (docs/PLAN_REFS.md
26c2): steps of the editor gate (tools/editor_test.py), with real input through CDP as tools/prompt_field_steps.py
(whose document, helpers and keys they share: "jacket" = @img1, "coat" = @img2).

- ref_picker_opens_on_at_and_inserts: an @ at a word start opens one picker (after "mail" none), what is typed after it
  filters the rows, the first Escape closes it and keeps the focus and the text, the second leaves the field; the
  arrows move with wrap and Enter or Tab insert "@imgN " as one step of the field's undo; the AltGr probe (Ctrl+Alt
  "@") opens it once; a hidden reference is not listed but counted in a note; the editor's undo never moves.
- ref_picker_adds_a_reference_in_place: `addReferences([file])` during a session adds one reference whose token takes
  the place of the @; without a session it lands at the kept caret; an image pasted or dropped into the field becomes
  a reference named where it came in; text still pastes as text.
- ref_bar_hover_and_swap: the bar above the field (a chip per reference, "+", the count), with the host's refLayout
  stubbed (and put back): cap 1 marks the second chip over and says "2 of 1 for this recipe", "none" strikes the
  chips through and says so; a bar click inserts at the kept caret; the hover card is not there at 250 ms and is there
  (with "sent as image 2") within 1.5 s; the chevron's swap menu swaps a token as one undo step, shows a hidden
  reference (its token comes back) and removes a token with one of its spaces.
- ref_picker_keeps_what_stood_there: an @ typed in front of a word or a chip is replaced alone by a pick; with no
  reference listed Enter is a new line (no file dialog); a chip or a word moved in front of a chip keeps a space, so
  both stay chips; a swap menu open under a remap removes its own chip only; a bar click on a field without the focus
  reports one change.
- prompt_field_drags_a_chip: a chip pressed and moved to the end of the text goes there as one undo step (the gap it
  leaves closes), a press without a move only puts the caret beside it.
"""
import asyncio
import json

from prompt_field_steps import SETUP, key, typ, js, CTRL, ALT  # noqa: F401  (SETUP: the shared JS prelude)

# a File of the gate's test picture, for addReferences / paste / drop
FILE_JS = r"""
const pfFile = async (name = "shoe.png") => {
    const { viewUrl } = await import("./editor/inpaint_canvas.js");
    const b = await (await fetch(viewUrl(file))).blob();
    return new File([b], name, { type: "image/png" });
};
const pops = () => [...document.querySelectorAll(".ipc-refpop")];
const rows = () => { const p = pops()[0]; return p ? [...p.querySelectorAll(".ipc-rp-row")].map((r) => r.dataset.kind + ":" + (r.querySelector(".ipc-rp-label") ? r.querySelector(".ipc-rp-label").textContent : "") + (r.classList.contains("ipc-rp-cur") ? "*" : "")) : null; };
"""


async def jsx(c, pre, body, timeout=120):
    return await js(c, pre, FILE_JS + body, timeout)


async def click(c, x, y):
    for kind in ("mousePressed", "mouseReleased"):
        await c.call("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left", buttons=1 if kind == "mousePressed" else 0, clickCount=1)
    await asyncio.sleep(0.1)


async def move(c, x, y, buttons=0):
    await c.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y, button="left" if buttons else "none", buttons=buttons, pointerType="mouse")


async def center(c, pre, selector_js):
    """the centre of the element the JS expression names, in CSS pixels"""
    return await jsx(c, pre, "const n = " + selector_js + "; if (!n) throw new Error('no element for the click'); n.scrollIntoView({ block: 'nearest' }); const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];")


async def opens_on_at_and_inserts(c, pre):
    await jsx(c, pre, r"""
const ed = await pfSetup();
ed.setPromptText("", { history: "reset" });
window.__rpUndo = ed.undo.length;
return 1;
""")
    try:
        # after a word the @ is plain text
        await typ(c, "mail@")
        r = await jsx(c, pre, "return { pops: pops().length, v: pf().promptInput.value };")
        if r != {"pops": 0, "v": "mail@"}:
            raise Exception("mail@: %s" % json.dumps(r))
        await jsx(c, pre, 'pf().setPromptText("a ", { history: "reset" }); pf().promptInput.setSelectionRange(2, 2); return 1;')
        await typ(c, "@")
        r = await jsx(c, pre, r"""
same("one picker", pops().length, 1);
same("its rows", rows(), ["ref:img1*", "ref:img2", "add:"]);
same("its head", pops()[0].querySelector(".ipc-rp-head").textContent, "Reference images");
return rows();
""")
        await typ(c, "jac")
        r = await jsx(c, pre, r"""
same("filtered", rows(), ["ref:img1*", "add:"]);
same("the head says the query", pops()[0].querySelector(".ipc-rp-head").textContent, "@jac");
same("the @word stays text", [pf().promptInput.value, chips(pf())], ["a @jac", []]);
return rows();
""")
        # the first Escape closes the picker only
        await key(c, "Escape")
        r = await jsx(c, pre, "return [pops().length, document.activeElement === pf().promptInput, pf().promptInput.value];")
        if r != [0, True, "a @jac"]:
            raise Exception("the first Escape: %s" % json.dumps(r))
        await key(c, "Escape")
        r = await jsx(c, pre, "return document.activeElement === pf().root;")
        if not r:
            raise Exception("the second Escape did not leave the field")
        # again, with "co": the arrows wrap, Enter inserts @img2 and a space as one step
        await jsx(c, pre, 'const el = pf().promptInput; el.focus(); el.setSelectionRange(el.value.length, el.value.length); return 1;')
        await typ(c, " @co")
        await key(c, "ArrowDown")
        r1 = await jsx(c, pre, "return rows();")
        await key(c, "ArrowDown")
        r2 = await jsx(c, pre, "return rows();")
        if r1 != ["ref:img2", "add:*"] or r2 != ["ref:img2*", "add:"]:
            raise Exception("the arrows: %s then %s" % (json.dumps(r1), json.dumps(r2)))
        await key(c, "Enter")
        r = await jsx(c, pre, r"""
const ed = pf(), el = ed.promptInput;
same("inserted", [el.value, el.selectionStart, pops().length], ["a @jac @img2 ", 13, 0]);
same("its chip", chips(ed), ["@img2:live"]);
same("promptText", ed.promptText, el.value);
return el.value;
""")
        await key(c, "z", CTRL)
        r = await jsx(c, pre, "return pf().promptInput.value;")
        if r != "a @jac @co":
            raise Exception("one Ctrl+Z after the insert gives %s" % json.dumps(r))
        await key(c, "y", CTRL)
        # Tab inserts too; the AltGr probe (Ctrl+Alt with text "@") opens the picker once
        await key(c, "@", CTRL | ALT, text="@", code="KeyQ")
        r = await jsx(c, pre, "return [pops().length, rows()];")
        if r[0] != 1:
            raise Exception("the AltGr @ opened %s pickers" % r[0])
        await key(c, "Tab")
        r = await jsx(c, pre, r"""
const ed = pf(), el = ed.promptInput;
same("Tab inserted", [el.value, pops().length, document.activeElement === el], ["a @jac @img2 @img1 ", 0, true]);
return el.value;
""")
        # the editor's undo never moved; a hidden reference is not listed, a note counts it
        await jsx(c, pre, 'const ed = pf(); same("the editor undo", ed.undo.length, window.__rpUndo); await run("set_layer", { layer: ed.layers.find((l) => l.name === "coat").id, visible: false }); ed.promptInput.focus(); const el = ed.promptInput; el.setSelectionRange(el.value.length, el.value.length); return 1;')
        await typ(c, "@")
        r = await jsx(c, pre, r"""
const ed = pf();
same("with coat hidden", rows(), ["ref:img1*", "add:"]);
same("the note", pops()[0].querySelector(".ipc-rp-note").textContent, "1 hidden reference is not listed");
const got = rows();
await run("set_layer", { layer: ed.layers.find((l) => l.name === "coat").id, visible: true });
return got;
""")
        return r
    finally:
        await jsx(c, pre, "await pfClose(); return 1;")


async def adds_a_reference_in_place(c, pre):
    await jsx(c, pre, r"""
const ed = await pfSetup();
ed.setPromptText("see ", { history: "reset" });
ed.promptInput.setSelectionRange(4, 4);
return 1;
""")
    try:
        await typ(c, "@sh")
        r = await jsx(c, pre, r"""
const ed = pf(), el = ed.promptInput;
same("a session", pops().length, 1);
const n0 = ed.layers.length;
const ids = await ed.promptField.addReferences([await pfFile()]);
same("one new reference", [ids.length, ed.layers.length - n0], [1, 1]);
same("its token took the @'s place", [el.value, pops().length], ["see @img3 ", 0]);
same("chips", chips(ed), ["@img3:live"]);
same("drift", ed._refDrift || 0, 0);
// without a session: at the kept caret
ed.setPromptText("x y", { history: "reset" });
el.setSelectionRange(1, 1);
await ed.promptField.addReferences([await pfFile("hat.png")]);
same("at the caret", el.value, "x @img4 y");
// a picture pasted: a reference named at the caret; text pastes as text
el.focus();
el.setSelectionRange(el.value.length, el.value.length);
const dt = new DataTransfer();
dt.items.add(await pfFile("glove.png"));
el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
for (let i = 0; i < 100 && !/@img5/.test(el.value); i++) await wait(50);
same("pasted picture", el.value, "x @img4 y @img5 ");
const n1 = ed.layers.length;
const t = new DataTransfer();
t.setData("text/plain", "plain");
el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: t, bubbles: true, cancelable: true }));
same("pasted text", [el.value, ed.layers.length], ["x @img4 y @img5 plain", n1]);
// a picture dropped at the start of the text
const box = el.getBoundingClientRect();
const d2 = new DataTransfer();
d2.items.add(await pfFile("scarf.png"));
el.dispatchEvent(new DragEvent("drop", { dataTransfer: d2, clientX: box.left + 4, clientY: box.top + 12, bubbles: true, cancelable: true }));
for (let i = 0; i < 100 && !/@img6/.test(el.value); i++) await wait(50);
same("dropped picture at the start", el.value, "@img6 x @img4 y @img5 plain");
same("drift at the end", ed._refDrift || 0, 0);
return el.value;
""")
        return r
    finally:
        await jsx(c, pre, "await pfClose(); return 1;")


async def bar_hover_and_swap(c, pre):
    await jsx(c, pre, r"""
const ed = await pfSetup();
ed.setPromptText("a @img1 @img2", { history: "reset" });
window.__rpLayout = host.refLayout;
return 1;
""")
    try:
        r = await jsx(c, pre, r"""
const ed = pf();
const bar = ed.promptInput.parentElement.firstElementChild;
same("the bar is the first child", bar.className, "ipc-refbar");
same("its chips", [...bar.querySelectorAll(".ipc-refbar-chip")].map((b) => b.dataset.state + ":" + b.textContent), ["live:img1", "live:img2"]);
same("its +", bar.querySelector(".ipc-refbar-add").disabled, false);
const ids = Object.fromEntries(ed.layers.filter((l) => l.role === "reference").map((l) => [l.name, l.id]));
window.__rpIds = ids;
// cap 1: the second reference is over
host.refLayout = async (e) => {
    const info = { names: new Map([[ids.jacket, "image 2"], [ids.coat, "image 3"]]), over: new Set([ids.coat]), none: null, local: false, cap: 1 };
    e.refLayoutInfo = info;
    return info;
};
ed.refreshRefLayout();
await wait(400);
same("over", chips(ed), ["@img1:live", "@img2:over"]);
same("the count", [bar.querySelector(".ipc-refbar-count").textContent, bar.querySelector(".ipc-refbar-count").classList.contains("ipc-refbar-over")], ["2 of 1 for this recipe", true]);
same("the bar's over chip", bar.querySelectorAll(".ipc-refbar-chip")[1].dataset.state, "over");
// none: every chip struck through, the count says so
host.refLayout = async (e) => {
    const info = { names: new Map([[ids.jacket, null], [ids.coat, null]]), over: new Set(), none: "An upscale sends the picture alone.", local: false, cap: null };
    e.refLayoutInfo = info;
    return info;
};
ed.refreshRefLayout();
await wait(400);
same("none", chips(ed), ["@img1:none", "@img2:none"]);
same("the none count", bar.querySelector(".ipc-refbar-count").textContent, "This recipe sends no reference images");
// back to names, no cap
host.refLayout = async (e) => {
    const info = { names: new Map([[ids.jacket, "image 2"], [ids.coat, "image 3"]]), over: new Set(), none: null, local: false, cap: 4 };
    e.refLayoutInfo = info;
    return info;
};
ed.refreshRefLayout();
await wait(400);
same("live again", chips(ed), ["@img1:live", "@img2:live"]);
same("the count", bar.querySelector(".ipc-refbar-count").textContent, "2 of 4 for this recipe");
// a bar click names the reference at the kept caret
ed.setPromptText("x y", { history: "reset" });
ed.promptInput.setSelectionRange(1, 1);
ed.root.focus();
return 1;
""")
        x, y = await center(c, pre, 'pf().promptInput.parentElement.querySelectorAll(".ipc-refbar-chip")[0]')
        await click(c, x, y)
        r = await jsx(c, pre, r"""
const el = pf().promptInput;
same("a bar click", [el.value, document.activeElement === el, el.selectionStart], ["x @img1 y", true, 7]);
pf().setPromptText("a @img1 b", { history: "reset" });
return 1;
""")
        # the hover card: not at 250 ms, there within 1.5 s, with the name it is sent as
        await c.call("Page.bringToFront")
        x, y = await center(c, pre, 'pf().promptInput.querySelector(".ipc-chip .ipc-chip-label")')
        await move(c, x - 40, y + 60)
        await asyncio.sleep(0.05)
        await move(c, x, y)
        await asyncio.sleep(0.25)
        early = await jsx(c, pre, 'return document.querySelectorAll(".ipc-refcard").length;')
        card = await jsx(c, pre, r"""
for (let i = 0; i < 30; i++) {
    const k = document.querySelector(".ipc-refcard");
    if (k) return [k.querySelector(".ipc-refcard-name").textContent, k.querySelector(".ipc-refcard-line").textContent, !!k.querySelector("canvas")];
    await wait(50);
}
return null;
""")
        if early != 0 or card != ["jacket", "img1 · sent as image 2", True]:
            raise Exception("the hover card: %s at 250 ms, then %s" % (early, json.dumps(card)))
        await move(c, x - 40, y + 80)
        await asyncio.sleep(0.4)
        gone = await jsx(c, pre, 'return document.querySelectorAll(".ipc-refcard").length;')
        if gone != 0:
            raise Exception("the hover card stayed after the pointer left")
        # the swap menu: img1 -> img2, one undo step
        x, y = await center(c, pre, 'pf().promptInput.querySelector(".ipc-chip .ipc-chip-chev")')
        await click(c, x, y)
        r = await jsx(c, pre, r"""
same("the swap menu", [pops().length, pops()[0].dataset.mode, rows()], [1, "swap", ["ref:img2*", "remove:"]]);
return 1;
""")
        x, y = await center(c, pre, 'document.querySelector(".ipc-refpop .ipc-rp-row[data-kind=ref]")')
        await click(c, x, y)
        r = await jsx(c, pre, r"""
const ed = pf();
same("swapped", [ed.promptInput.value, pops().length], ["a @img2 b", 0]);
ed.promptField.undo();
same("one undo", ed.promptInput.value, "a @img1 b");
// a hidden reference's chip: "Show jacket" brings the layer and the token back
await run("set_layer", { layer: window.__rpIds.jacket, visible: false });
same("parked", chips(ed), ["@img?" + window.__rpIds.jacket + ":inactive"]);
return 1;
""")
        x, y = await center(c, pre, 'pf().promptInput.querySelector(".ipc-chip .ipc-chip-chev")')
        await click(c, x, y)
        r = await jsx(c, pre, "return rows();")
        if r != ["ref:img1*", "show:", "remove:"]:
            raise Exception("the hidden chip's menu: %s" % json.dumps(r))
        x, y = await center(c, pre, 'document.querySelector(".ipc-refpop .ipc-rp-row[data-kind=show]")')
        await click(c, x, y)
        r = await jsx(c, pre, r"""
const ed = pf();
same("shown", [ed.layers.find((l) => l.id === window.__rpIds.jacket).visible, ed.promptInput.value, chips(ed)], [true, "a @img1 b", ["@img1:live"]]);
return 1;
""")
        # remove from the prompt, with one of its spaces
        x, y = await center(c, pre, 'pf().promptInput.querySelector(".ipc-chip .ipc-chip-chev")')
        await click(c, x, y)
        x, y = await center(c, pre, 'document.querySelector(".ipc-refpop .ipc-rp-row[data-kind=remove]")')
        await click(c, x, y)
        r = await jsx(c, pre, r"""
const ed = pf();
same("removed", [ed.promptInput.value, pops().length, ed._refDrift || 0], ["a b", 0, 0]);
return ed.promptInput.value;
""")
        return r
    finally:
        await jsx(c, pre, "if (window.__rpLayout) host.refLayout = window.__rpLayout; window.__rpLayout = null; await pfClose(); return 1;")


async def keeps_what_stood_there(c, pre):
    await jsx(c, pre, r"""
const ed = await pfSetup();
ed.setPromptText("the jacket", { history: "reset" });
ed.promptInput.setSelectionRange(4, 4);
window.__rpChanges = 0;
window.__rpOnChange = () => { window.__rpChanges++; };
ed.promptInput.addEventListener("change", window.__rpOnChange);
return 1;
""")
    try:
        # an @ typed in front of a word: a pick replaces the @ only, the word stays
        await typ(c, "@")
        await key(c, "Enter")
        r1 = await jsx(c, pre, 'return [pf().promptInput.value, pops().length];')
        # in front of a chip: the chip stays
        await jsx(c, pre, 'pf().setPromptText("put @img2 on", { history: "reset" }); pf().promptInput.setSelectionRange(4, 4); return 1;')
        await typ(c, "@")
        await key(c, "Enter")
        r2 = await jsx(c, pre, 'return [pf().promptInput.value, chips(pf())];')
        # nothing listed: Enter is a new line, no file dialog
        await jsx(c, pre, 'const el = pf().promptInput; pf().setPromptText("x", { history: "reset" }); el.setSelectionRange(1, 1); return 1;')
        await typ(c, " @zzz")
        await key(c, "Enter")
        r3 = await jsx(c, pre, 'return [pf().promptInput.value, pops().length];')
        if r1 != ["the @img1 jacket", 0] or r2 != ["put @img1 @img2 on", ["@img1:live", "@img2:live"]] or r3 != ["x @zzz\n", 0]:
            raise Exception("what stood there: %s" % json.dumps([r1, r2, r3]))
        r = await jsx(c, pre, r"""
const ed = pf(), f = ed.promptField, el = ed.promptInput;
// a chip moved in front of another keeps its space: both stay chips
ed.setPromptText("@img2 cat @img1", { history: "reset" });
f.moveRange(10, 15, 0);
same("moved in front of a chip", [el.value, chips(ed)], ["@img1 @img2 cat ", ["@img1:live", "@img2:live"]]);
ed.setPromptText("@img1 red", { history: "reset" });
f.moveRange(6, 9, 0);
same("a word moved in front of a chip", [el.value, chips(ed)], ["red @img1 ", ["@img1:live"]]);
// a swap menu open while a remap rewrites the text after its chip: its remove takes that chip only
ed.setPromptText("@img1 cat @img2", { history: "reset" });
f.openSwap(el.querySelector(".ipc-chip"));
const jacket = ed.layers.find((l) => l.name === "jacket");
await run("set_layer", { layer: jacket.id, visible: false });
same("remapped under the menu", [el.value.replace(jacket.id, "ID"), pops().length], ["@img?ID cat @img1", 1]);
f.pickItem(f.picker.items.find((it) => it.kind === "remove"));
same("removed that chip only", el.value, "cat @img1");
await run("set_layer", { layer: jacket.id, visible: true });
// a bar click while the field has no focus reports one change (the document is marked changed)
ed.root.focus();
window.__rpChanges = 0;
return 1;
""")
        x, y = await center(c, pre, 'pf().promptInput.parentElement.querySelectorAll(".ipc-refbar-chip")[0]')
        await click(c, x, y)
        await key(c, "Escape")
        n = await jsx(c, pre, 'return [window.__rpChanges, document.activeElement === pf().root];')
        if n != [1, True]:
            raise Exception("a bar click on a field without focus, then Escape: %s change events (want 1), root focused %s" % (n[0], n[1]))
        return [r1, r2, r3]
    finally:
        await jsx(c, pre, "const ed = pf(); if (ed && window.__rpOnChange) ed.promptInput.removeEventListener('change', window.__rpOnChange); await pfClose(); return 1;")


async def drags_a_chip(c, pre):
    await jsx(c, pre, r"""
const ed = await pfSetup();
ed.setPromptText("a @img1 b c", { history: "reset" });
return 1;
""")
    try:
        await c.call("Page.bringToFront")
        x, y = await jsx(c, pre, 'const r = pf().promptInput.querySelector(".ipc-chip").getBoundingClientRect(); return [r.left + r.width / 2 + 3, r.top + r.height / 2];')
        # the end of the text: right of its last character
        ex, ey = await jsx(c, pre, r"""
const el = pf().promptInput, t = [...el.childNodes].filter((n) => n.nodeType === 3 && n.data.includes("c")).pop();
const rg = document.createRange(); rg.setStart(t, t.data.length - 1); rg.setEnd(t, t.data.length);
const r = rg.getBoundingClientRect();
return [r.right + 1, r.top + r.height / 2];
""")
        # a press without a move: the caret beside the chip, nothing moved
        await click(c, x, y)
        r = await jsx(c, pre, "const el = pf().promptInput; return [el.value, el.selectionStart];")
        if r != ["a @img1 b c", 7]:
            raise Exception("a press on the chip: %s" % json.dumps(r))
        await c.call("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", buttons=1, clickCount=1)
        for k in range(1, 7):
            await move(c, x + (ex - x) * k / 6, y + (ey - y) * k / 6, buttons=1)
            await asyncio.sleep(0.03)
        caret = await jsx(c, pre, 'return document.querySelectorAll(".ipc-pf-dropcaret").length;')
        await c.call("Input.dispatchMouseEvent", type="mouseReleased", x=ex, y=ey, button="left", buttons=0, clickCount=1)
        await asyncio.sleep(0.1)
        r = await jsx(c, pre, r"""
const ed = pf(), el = ed.promptInput;
const got = [el.value, chips(ed), document.querySelectorAll(".ipc-pf-dropcaret").length];
same("moved", got, ["a b c @img1", ["@img1:live"], 0]);
same("promptText", ed.promptText, el.value);
ed.promptField.undo();
same("one undo", el.value, "a @img1 b c");
return got;
""")
        if caret != 1:
            raise Exception("no drop caret while dragging")
        return r
    finally:
        await jsx(c, pre, "await pfClose(); return 1;")


STEPS = [
    ("ref_picker_opens_on_at_and_inserts", opens_on_at_and_inserts),
    ("ref_picker_adds_a_reference_in_place", adds_a_reference_in_place),
    ("ref_bar_hover_and_swap", bar_hover_and_swap),
    ("ref_picker_keeps_what_stood_there", keeps_what_stood_there),
    ("prompt_field_drags_a_chip", drags_a_chip),
]
