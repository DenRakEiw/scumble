// Boxes plugin (item 28 S3, docs/PLAN_BOXES.md §10): boxes in the prompt for a model that takes them (FLUX 3 Image, Ideogram 4).
// A box says where an element goes in the picture (New), which element stays (Keep), moves (Move) or goes (Remove),
// and which reference layer, or a part of it, is placed in it (From reference); a Text box renders words. The boxes
// live in the document's plugin data (scumble.documents.data: saved with the session and the .scumble file) in image
// pixels, follow the picture through a crop, a turn or a resize (the "geometry" event), and go out with a run of a
// recipe that takes boxes through the generate hook (plugin API 3) while the document's Boxes switch under the prompt is
// on (the core's genSettings.boxes, S3d; the first box turns it on): the app measures them in the crop it sends and
// writes the model's rows. S3a: the data, the panel in the Generate pane, the commands. S3b: the canvas tool and the
// overlay (tool.js). S3c: the crop Generate sends, as a frame while the tool is active and as warnings in the panel
// (a box the crop leaves out or cuts; a box outside the selection while Paste keeps the selection only). S3e: a box is
// named after its description while it has a default id (red_scarf_1), the panel warns of a New box without one and of
// a box too small to place anything in, a box turned into Move steps aside from its source; the caption of a run says
// where each box goes (main's providers/boxes.js, format.js for the clipboard).
//
//   tool     Boxes (X): draw, select, move, resize, delete, duplicate, nudge; the overlay while the tool or the panel
//            shows, the crop's frame while the tool is active
//   panel    "Boxes" in the Generate pane: one row per box, Selection → box, Clear, Copy rows; the crop warnings
//   action   Selection → box (Plugins menu)
//   commands boxes.list, boxes.add, boxes.set, boxes.remove, boxes.from_selection, boxes.clear
//   generate the document's boxes for a run that takes them

import { BOX_ID, KINDS, DESC_MAX, toFrame, idWords, smallBox, smallNote } from "/editor/boxes.js";
import { clipboardText, fold } from "./format.js";
import { makeTool, colourOf, colourSlot, nextColour } from "./tool.js";

const HELP = "Boxes tell a model that takes them (FLUX 3 Image, Ideogram 4) where things go. New: what the description says, in the box. Keep: an element stays where it is. Move: from its source box to this one. Remove: taken out, the background filled. From reference: a reference layer (or a part of it) placed in the box. Text: the words rendered in the box. Positions are image pixels; a run measures the boxes in the crop it sends and leaves out one outside it. A box sets place and size, not a hard edge. Ideogram 4 takes New, Text and Keep boxes; Move, Remove and From reference stay out of its runs.";
const KIND_LABELS = { new: "New", keep: "Keep", move: "Move", remove: "Remove", from: "From reference", text: "Text" };
const TOKEN = /@img([1-9][0-9]*)\b/g;

export function activate(scumble) {
    const { ui } = scumble;

    // ---- the data ----------------------------------------------------------------------------------------------------
    // per document: { version: 1, boxes: [{ id, kind, rect: [l, t, r, b] (image px), src, layer, desc, text, colour }] }
    // (colour: the box's slot in tool.js PALETTE, given when it is made)
    const boxesOf = (doc) => { const d = scumble.documents.data(doc).get(); return Array.isArray(d.boxes) ? d.boxes : []; };
    const write = (doc, boxes, label) => scumble.documents.data(doc).set({ version: 1, boxes }, { undo: label });

    const num = (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v);
    /** A rectangle argument ([l, t, r, b] or { x, y, w, h }) as whole image pixels, or an error naming `what`. */
    function rectOf(v, what) {
        let r = v;
        if (v && typeof v === "object" && !Array.isArray(v)) r = [num(v.x), num(v.y), num(v.x) + num(v.w), num(v.y) + num(v.h)];
        if (!Array.isArray(r) || r.length !== 4) throw new Error(`${what} must be [left, top, right, bottom] in image pixels (or { x, y, w, h })`);
        const out = r.map((x) => Math.round(Number(num(x))));
        if (!out.every(Number.isFinite)) throw new Error(`${what} holds a value that is not a number`);
        if (out[2] <= out[0] || out[3] <= out[1]) throw new Error(`${what} is empty: right must be past left and bottom past top`);
        return out;
    }
    const shownReferences = (doc) => doc.layers().filter((l) => l.role === "reference" && l.visible);
    /** A reference layer by id, name, a part of the name or "active"; refuses a layer that is not a reference. */
    function referenceOf(doc, key) {
        const l = doc.layer(key);
        if (l.role !== "reference") throw new Error(`${l.name} is not a reference layer: set its role to reference first`);
        return l;
    }
    /** The next free id with that base: box_1, box_2 .. */
    function nextId(boxes, base = "box") {
        const used = new Set(boxes.map((b) => b.id));
        let n = 1;
        while (used.has(`${base}_${n}`)) n++;
        return `${base}_${n}`;
    }
    /** The id a box gets by default, by its kind (S3a), and Selection → box's edit_n. */
    const DEFAULT_ID = /^(?:box|keep|move|remove|ref|edit)_[1-9][0-9]*$/;
    /** The words an id is made from (S3e): a Text box's words (their first two: a sign's text), else its description. */
    const wordsOf = (b) => idWords(b.text, { first: true }) || idWords(b.desc);
    /** The prompt names the box as <id>: renaming it would leave the prompt naming nothing. */
    const promptNames = (doc, id) => String((doc.editor && doc.editor.promptText) || "").includes(`<${id}>`);
    /** `r` moved aside by a fifth of the picture (right, else left, else down, else up), so a box turned into Move does not lie on its source. */
    function aside(doc, r) {
        const dx = Math.round(doc.width / 5), dy = Math.round(doc.height / 5);
        if (r[2] + dx <= doc.width) return [r[0] + dx, r[1], r[2] + dx, r[3]];
        if (r[0] - dx >= 0) return [r[0] - dx, r[1], r[2] - dx, r[3]];
        if (r[3] + dy <= doc.height) return [r[0], r[1] + dy, r[2], r[3] + dy];
        if (r[1] - dy >= 0) return [r[0], r[1] - dy, r[2], r[3] - dy];
        return r.slice();
    }
    /**
     * A box held to its shape: `input` the fields given, `base` the box it changes (null for a new one). The id matches
     * BOX_ID and is unique in the document; a keep / move / remove box needs a source; a from box a reference layer; a
     * new box has neither. `text` makes a Text box (a new box whose words are rendered). Without an id given, the id
     * comes from the words of the description (S3e: "a red scarf" -> red_scarf_1): a new box's, and a box's whose id
     * is still a default one (box_1, edit_2) when its description or text changes, unless the prompt names it as <id>;
     * an id once made from words stays. `idBase` is the default when there are no words.
     */
    function normalise(doc, input, { base = null, boxes = boxesOf(doc), idBase = null } = {}) {
        const a = input || {};
        const kind = a.kind != null ? String(a.kind) : base ? base.kind : "new";
        if (!KINDS.has(kind)) throw new Error(`kind "${kind}" is not new, keep, move, remove or from`);
        let rect = a.rect != null ? rectOf(a.rect, "rect") : base ? base.rect : null;
        if (!rect) throw new Error("rect is required: [left, top, right, bottom] in image pixels");
        let src = a.src !== undefined ? (a.src == null ? null : rectOf(a.src, "src")) : base ? base.src : null;
        let layer = a.layer !== undefined ? (a.layer == null ? null : referenceOf(doc, a.layer).id) : base ? base.layer : null;
        if (kind === "new") { src = null; layer = null; }
        else if (kind === "from") {
            src = src || null;
            if (!layer) throw new Error("a From reference box needs layer, the reference layer");
        } else {
            layer = null;
            // a New or From box turned into Keep / Move / Remove: the element is where the box is (a From box's src is
            // a part of its reference layer, not a place in the picture)
            if (base && (base.kind === "new" || base.kind === "from") && a.src === undefined) src = (kind !== "move" && a.rect != null ? rect : base.rect).slice();
            if (!src) throw new Error(`a ${kind} box needs src, where the element is now: [left, top, right, bottom]`);
            // turned into Move with the target on its source: the target steps aside, so the two can be told apart
            if (kind === "move" && base && base.kind !== "move" && a.rect == null && rect.every((v, i) => v === src[i])) rect = aside(doc, src);
        }
        const desc = a.desc !== undefined ? fold(a.desc) : base ? base.desc || "" : "";
        if (desc.length > DESC_MAX) throw new Error(`desc is longer than ${DESC_MAX} characters`);
        const text = a.text !== undefined ? (a.text == null ? null : String(a.text).replace(/\s+/g, " ").trim()) : base ? base.text || null : null;
        if (text != null && kind !== "new") throw new Error("only a New box renders text");
        let id;
        const others = base ? boxes.filter((b) => b.id !== base.id) : boxes;
        if (a.id != null && String(a.id).trim() !== "") id = String(a.id).trim();
        else if (!base) id = nextId(boxes, wordsOf({ desc, text }) || idBase || (kind === "from" ? "ref" : kind === "new" ? "box" : kind));
        else {
            id = base.id;
            const words = wordsOf({ desc, text });
            const changed = desc !== (base.desc || "") || text !== (base.text == null ? null : base.text);
            if (changed && words && DEFAULT_ID.test(base.id) && !promptNames(doc, base.id)) id = nextId(others, words);
        }
        if (!BOX_ID.test(id)) throw new Error(`the id "${id}" is not lowercase words and a number joined by underscores (knight_1, red_scarf_2), or is a picture's name (ref_image_1)`);
        if (others.some((b) => b.id === id)) throw new Error(`the id ${id} is already used by another box`);
        // every box its own colour, given when it is made and kept through every change (a box from before colours
        // keeps the one its place in the list gave it); a duplicate is a new box and gets a new one
        const colour = base ? colourSlot(base, boxes) : nextColour(boxes);
        return { id, kind, rect, src, layer, desc, text, colour };
    }

    // ---- what a box says -----------------------------------------------------------------------------------------------
    /**
     * The desc a run gets: an @img token becomes a {@layer:id} marker the app resolves. A Text box's words go beside it
     * as `text` (the app writes them as the model takes words), so its desc says only how they look.
     */
    function descOf(doc, b) {
        const labels = new Map(doc.layers().filter((l) => l.label).map((l) => [l.label, l.id]));
        return (b.desc || "").replace(TOKEN, (m, n) => (labels.has("img" + n) ? `{@layer:${labels.get("img" + n)}}` : m));
    }
    /** The desc for the clipboard: an @img token as the model's picture name (<ref_image_k>, k the reference's number). */
    function clipDesc(doc, b) {
        const words = b.text != null ? `text reading "${b.text}"${b.desc ? ", " + b.desc : ""}` : b.desc || "";
        return words.replace(TOKEN, (m, n) => `<ref_image_${n}>`);
    }
    /**
     * The recipe's stand on boxes: { takes, name, schema } (takes: the core's own test, the one the Boxes switch shows by;
     * schema: the format they go in, "flux3" or "ideogram4").
     */
    function recipeState() {
        const r = scumble.host.recipe;
        const s = scumble.host.boxSwitch(null);
        return { takes: !!(s && s.takes), name: r ? r.name || r.id : null, schema: (s && s.schema) || null };
    }
    /** The boxes a run of the recipe leaves out by their kind: Ideogram 4's caption has no Move, Remove or From (main's boxes.js). */
    const unplacedOf = (boxes, schema) => (schema === "ideogram4" ? boxes.filter((b) => b.kind === "move" || b.kind === "remove" || b.kind === "from").map((b) => b.id) : []);

    // ---- the Boxes switch under the prompt (S3d): the core's genSettings.boxes, per document ---------------------------
    const SWITCH_NOTE = "The Boxes switch under the prompt is on now: the boxes go with the next run.";
    const SWITCH_LATER = "The Boxes switch is on for this document: the boxes go with a run of a recipe that takes them (FLUX 3 Image, Ideogram 4).";
    const switched = new Map();   // document id -> the note of the switch the last add turned on, until its caller has said it
    const switchOf = (doc) => !!(doc.editor && doc.editor.genSettings && doc.editor.genSettings.boxes);
    /** The first box of a document turns its switch on, so a drawn box is not left out without a word. */
    function switchOn(doc) {
        const ed = doc.editor;
        if (!ed || !ed.genSettings || ed.genSettings.boxes) return;
        ed.genSettings.boxes = true;
        ed.notifyChanged();   // the row follows (host.changed), the file keeps it
        // under a recipe that takes no boxes the row is hidden: the switch waits for one that does
        const note = recipeState().takes ? SWITCH_NOTE : SWITCH_LATER;
        switched.set(doc.id, note);
        doc.status(note);
    }
    /** " " + the note when the last add turned the switch on, else "": for the caller's own status line. */
    const switchNote = (doc) => { const n = switched.get(doc.id); switched.delete(doc.id); return n ? " " + n : ""; };

    // ---- the crop Generate sends (S3c) ---------------------------------------------------------------------------------
    /** The crop Generate would send now ({ x, y, w, h, emitted, paste } in image pixels), or null without a selection. */
    function cropOf(doc) {
        try { return typeof scumble.host.cropFrame === "function" ? scumble.host.cropFrame(doc.editor) : null; }
        catch (_) { return null; }
    }
    /** The rectangles a run measures in the crop: the target, and the source of a Keep, Move or Remove box (a From box's part lies in its layer). */
    const placed = (b) => (b.kind === "new" || b.kind === "from" ? [b.rect] : [b.rect, b.src]).filter(Array.isArray);
    /** Where a box changes pixels: the target of a New, Text, From or Move box, Move's source, Remove's place; a Keep box nowhere. */
    const changes = (b) => (b.kind === "keep" ? [] : b.kind === "remove" ? [b.src || b.rect] : b.kind === "move" ? [b.rect, b.src] : [b.rect]).filter(Array.isArray);
    const within = (r, f, tol = 0) => r[0] >= f[0] - tol && r[1] >= f[1] - tol && r[2] <= f[2] + tol && r[3] <= f[3] + tol;
    /**
     * What Generate would do with the boxes now: `out` the ones it leaves out (outside its crop, or a sliver of it, by
     * the run's own toFrame), `cut` the ones its edge cuts, `spill` (with Paste on "selection") the ones that change
     * pixels outside the selection, where the paste cuts the result away, `small` (S3e) the ones that place something
     * in a box under 48 px a side at the size the crop is sent at. Null without a selection or boxes. The selection is
     * its bounding box, 2 px of slack for the soft edge.
     */
    function cropCheck(doc, boxes = boxesOf(doc)) {
        const crop = cropOf(doc);
        const sel = typeof doc.editor.getBounds === "function" ? doc.editor.getBounds() : null;
        if (!crop || !sel || !boxes.length) return null;
        const f = [crop.x, crop.y, crop.x + crop.w, crop.y + crop.h];
        const sentAt = Array.isArray(crop.emitted) ? crop.emitted : [crop.w, crop.h];
        const out = [], cut = [], spill = [], small = [];
        for (const b of boxes) {
            const rs = placed(b);
            if (rs.some((r) => !toFrame(r, crop))) { out.push(b.id); continue; }
            if (rs.some((r) => !within(r, f))) cut.push(b.id);
            if (crop.paste !== "crop" && changes(b).some((r) => !within(r, sel, 2))) spill.push(b.id);
            if (b.kind !== "keep" && b.kind !== "remove" && smallBox(toFrame(b.rect, crop), sentAt)) small.push(b.id);
        }
        return { crop, out, cut, spill, small };
    }
    /** The New boxes (not Text) without a description: the model would have to guess what goes there (S3e). */
    const bareOf = (boxes) => boxes.filter((b) => b.kind === "new" && b.text == null && !b.desc).map((b) => b.id);
    /** Crop > Paste on "whole crop" for this document (the set_crop command: the Crop section follows). */
    async function pasteWholeCrop(doc) {
        await scumble.commands.run("set_crop", { doc: doc.id, paste: "crop" });
        doc.status("Paste is now the whole crop for this document (Generate pane, Crop > Paste): the boxes outside the selection keep their result.");
    }

    // ---- changes (one undo step each) ----------------------------------------------------------------------------------
    function add(doc, input, { idBase = null } = {}) {
        switched.delete(doc.id);
        const boxes = boxesOf(doc);
        const b = normalise(doc, input, { boxes, idBase });
        write(doc, [...boxes, b], `Add box ${b.id}`);
        // the first box turns the switch on; an undo, a redo or an opened document never does (they do not add)
        if (!boxes.length) switchOn(doc);
        return b;
    }
    function set(doc, id, patch) {
        const boxes = boxesOf(doc);
        const i = boxes.findIndex((b) => b.id === id);
        if (i < 0) throw new Error(`no box ${id}`);
        const b = normalise(doc, patch, { base: boxes[i], boxes });
        const next = boxes.slice(); next[i] = b;
        write(doc, next, `Change box ${id}`);
        if (b.id !== id) {
            // named after its new description (S3e): the tool keeps it selected under its new id
            if (boxTool.selected(doc) === id) boxTool.select(doc, b.id);
            if (patch && patch.id == null) doc.status(`Box ${id} is called ${b.id} now, after its description.`);
        }
        return b;
    }
    function remove(doc, id) {
        const boxes = boxesOf(doc);
        if (!boxes.some((b) => b.id === id)) throw new Error(`no box ${id}`);
        write(doc, boxes.filter((b) => b.id !== id), `Remove box ${id}`);
    }
    function clear(doc) {
        const n = boxesOf(doc).length;
        if (n) write(doc, [], "Clear boxes");
        return n;
    }
    /**
     * The selection's bounds as a box: a New box with the prompt as its description; when the prompt names a reference
     * with @img, a From box of that layer (the whole layer into the selection), the prompt still its description.
     */
    function fromSelection(doc, { id, desc } = {}) {
        const sel = doc.selection({ box: true });   // the bounds' mask alone, not a mask of the whole picture
        if (!sel) throw new Error("Nothing is selected.");
        const { x, y, w, h } = sel.bounds;
        const prompt = desc != null ? String(desc) : String(doc.editor.promptText || "");
        const m = TOKEN.exec(prompt); TOKEN.lastIndex = 0;
        const ref = m ? doc.layers().find((l) => l.label === "img" + m[1]) : null;
        // the id from the prompt's words (red_door_1), edit_n when it has none
        return add(doc, { id: id || undefined, kind: ref ? "from" : "new", rect: [x, y, x + w, y + h], layer: ref ? ref.id : undefined, desc: prompt }, { idBase: "edit" });
    }
    function copyRows(doc) {
        const boxes = boxesOf(doc);
        if (!boxes.length) { doc.status("No boxes to copy."); return null; }
        const refs = shownReferences(doc);
        const layerById = new Map(doc.layers().map((l) => [l.id, l]));
        // the prompt's @img tokens as the descriptions' (clipDesc), so a box described by the prompt reads as said by it
        const prompt = String(doc.editor.promptText || "").replace(TOKEN, (m, n) => `<ref_image_${n}>`);
        const got = clipboardText(prompt, boxes.map((b) => ({ ...b, layerFrame: b.layer && layerById.has(b.layer) ? { x: layerById.get(b.layer).x, y: layerById.get(b.layer).y, w: layerById.get(b.layer).w, h: layerById.get(b.layer).h } : null })),
            { x: 0, y: 0, w: doc.width, h: doc.height }, { mode: "edit", nameOf: (id) => { const k = refs.findIndex((l) => l.id === id); return k < 0 ? null : `ref_image_${k + 1}`; }, descOf: (b) => fold(clipDesc(doc, b)) });
        if (navigator.clipboard) navigator.clipboard.writeText(got.text).catch(() => {});
        doc.status(`${got.rows.length} row${got.rows.length === 1 ? "" : "s"} copied, measured against the whole picture (a run measures them in the crop it sends).${got.notes.length ? " " + got.notes.join(" ") : ""}`);
        return got;
    }

    // ---- the tool and the overlay ----------------------------------------------------------------------------------------
    const panels = new Map();   // doc id -> { box, highlight() } of the open panel
    const boxTool = makeTool(scumble, {
        boxesOf, add, set, remove, nextId, switchNote,
        frame: cropOf,
        sent: switchOf,
        panelShown(doc) {
            const p = panels.get(doc.id);
            if (!p || !p.box.isConnected) return false;
            const details = p.box.closest("details");
            return (!details || details.open) && p.box.getClientRects().length > 0;
        },
        selChanged(doc) { const p = panels.get(doc.id); if (p) p.highlight(); },
        referenceName(doc, id) {
            const l = doc.layers().find((x) => x.id === id);
            return l ? (l.label ? "@" + l.label : l.name) : "(no layer)";
        },
    });
    scumble.tools.register(boxTool.tool);
    scumble.events.on("removed", (ev) => { if (ev.doc) { boxTool.forget(ev.doc.id); panels.delete(ev.doc.id); } });

    // ---- the picture changed its geometry: the boxes move with it ----------------------------------------------------
    scumble.events.on("geometry", (ev) => {
        if (!ev.doc || !Array.isArray(ev.m)) return;
        const boxes = boxesOf(ev.doc);
        if (!boxes.length) return;
        const [a, b, c, d, e, f] = ev.m;
        const map = (r) => {
            if (!Array.isArray(r)) return r;
            const xs = [], ys = [];
            for (const [x, y] of [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]]) { xs.push(a * x + c * y + e); ys.push(b * x + d * y + f); }
            const out = [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs)), Math.round(Math.max(...ys))];
            if (out[2] <= out[0]) out[2] = out[0] + 1;
            if (out[3] <= out[1]) out[3] = out[1] + 1;
            return out;
        };
        // new objects, never the old ones: the step's own undo puts the data back (docs/PLUGINS.md, events)
        scumble.documents.data(ev.doc).set({ version: 1, boxes: boxes.map((x) => ({ ...x, rect: map(x.rect), src: map(x.src) })) });
    });

    // ---- the generate hook: the document's boxes for a run that takes them ------------------------------------------
    scumble.generate.register({
        id: "document",
        count(doc) { return boxesOf(doc).length; },
        boxes(doc) {
            return boxesOf(doc).map((b) => ({ id: b.id, kind: b.kind, rect: b.rect, src: b.kind === "new" ? undefined : b.src, layer: b.kind === "from" ? b.layer : undefined, desc: descOf(doc, b), text: b.text != null ? b.text : undefined }));
        },
    });

    // ---- panel -----------------------------------------------------------------------------------------------------------
    scumble.panels.register({
        id: "panel",
        title: "Boxes",
        pane: "gen",
        open: false,
        build(box, doc) {
            box.appendChild(ui.el("div", "shell-help", HELP));
            const note = ui.el("div", "shell-help boxes-note", "");
            box.appendChild(note);
            const warn = ui.el("div", "boxes-warn");
            box.appendChild(warn);
            const list = ui.el("div", "boxes-list");
            box.appendChild(list);
            const run = (fn) => { try { fn(); } catch (err) { doc.status(String((err && err.message) || err)); render(true); } };
            const buttons = ui.el("div", "boxes-buttons");
            buttons.appendChild(ui.button("Selection → box", "The selection's bounds as a New box with the prompt as its description (a From box when the prompt names a reference with @img1)", () => run(() => { const b = fromSelection(doc); doc.status(`Box ${b.id} added.${switchNote(doc)}`); })));
            buttons.appendChild(ui.button("Clear", "Remove every box of this document (Ctrl+Z brings them back)", () => run(() => { const n = clear(doc); doc.status(n ? `${n} box${n === 1 ? "" : "es"} removed (Ctrl+Z brings them back).` : "No boxes."); })));
            buttons.appendChild(ui.button("Copy rows", "The boxes as the model's rows, measured against the whole picture, to the clipboard (a run measures them in the crop it sends)", () => run(() => copyRows(doc))));
            box.appendChild(buttons);
            const field =(cls, value, title, onChange) => {
                const inp = document.createElement("input");
                inp.type = "text"; inp.className = `boxes-field ${cls}`; inp.value = value == null ? "" : value; inp.title = title; inp.spellcheck = false;
                inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); });
                inp.addEventListener("change", () => onChange(inp.value));
                return inp;
            };
            const select = (options, value, title, onChange) => {
                const sel = document.createElement("select");
                sel.className = "ipc-sel boxes-select"; sel.title = title;
                for (const [id, label] of options) { const o = document.createElement("option"); o.value = id; o.textContent = label; sel.appendChild(o); }
                sel.value = value;
                sel.addEventListener("keydown", (e) => e.stopPropagation());
                sel.addEventListener("change", () => onChange(sel.value));
                return sel;
            };
            const change = (id, patch) => run(() => set(doc, id, patch));
            const rectText = (r) => (Array.isArray(r) ? r.join(", ") : "");
            const parseRect = (s) => s.split(/[\s,;]+/).filter(Boolean).map(Number);
            // what Generate would do with the boxes now (S3c): rebuilt only when it says something else, so the button
            // under the pointer is not replaced by a change elsewhere
            let warnKey = null;
            const names = (ids) => `${ids.length === 1 ? "Box" : "Boxes"} ${ids.join(", ")}`;
            const renderWarnings = (chk, bare, unplaced = [], name = "") => {
                const lines = [];
                if (unplaced.length) lines.push([`${names(unplaced)} ${unplaced.length === 1 ? "does" : "do"} not go with ${name}: Ideogram 4 places New, Text and Keep boxes only (Keep on an edit).`, false]);
                if (bare.length) lines.push([`${names(bare)} ${bare.length === 1 ? "has" : "have"} no description: the model does not know what goes there. Describe ${bare.length === 1 ? "it in its row" : "them in their rows"}.`, false]);
                if (chk && chk.small.length) lines.push([smallNote(chk.small), false]);
                if (chk && chk.out.length) lines.push([`${names(chk.out)} ${chk.out.length === 1 ? "lies" : "lie"} outside the crop Generate sends and ${chk.out.length === 1 ? "is" : "are"} left out.`, false]);
                if (chk && chk.cut.length) lines.push([`${names(chk.cut)} ${chk.cut.length === 1 ? "reaches" : "reach"} past the crop's edge: Generate sends the part inside it.`, false]);
                if (chk && chk.spill.length) lines.push([`${names(chk.spill)} ${chk.spill.length === 1 ? "reaches" : "reach"} outside the selection: Generate pastes the result inside the selection only and would cut ${chk.spill.length === 1 ? "it" : "them"} there.`, true]);
                const k = JSON.stringify(lines);
                if (k === warnKey) return;
                warnKey = k;
                warn.innerHTML = "";
                for (const [text, paste] of lines) {
                    const row = ui.el("div", "boxes-warn-row", text);
                    if (paste) row.appendChild(ui.button("Paste the whole crop", "Crop > Paste on whole crop for this document: the result of the whole crop is pasted back, so a box outside the selection keeps its change", () => pasteWholeCrop(doc).catch((err) => doc.status(String((err && err.message) || err)))));
                    warn.appendChild(row);
                }
            };
            let key = null, pending = false;
            const render = (force = false) => {
                const boxes = boxesOf(doc);
                const refs = shownReferences(doc);
                const rs = recipeState();
                const on = switchOf(doc);
                const chk = rs.takes && on && doc.loaded ? cropCheck(doc, boxes) : null;
                const at = chk ? ` Generate measures them in the crop it sends, ${chk.crop.w} × ${chk.crop.h} px at ${chk.crop.x}, ${chk.crop.y} (the frame the Boxes tool shows).` : "";
                note.textContent = !rs.name ? ""
                    : !rs.takes ? `${rs.name} takes no boxes: they stay with the document until a recipe that does (FLUX 3 Image, Ideogram 4) is selected.`
                    : !on ? `Not sent: the Boxes switch under the prompt is off. The boxes stay with the document; switch it on to send them with ${rs.name}.`
                    : boxes.length ? `${rs.name} sends these boxes with every Generate and Generate new run.${at}`
                    : `${rs.name} sends the selection as one box while the document has none (the Boxes switch is on).`;
                renderWarnings(chk, rs.takes && on ? bareOf(boxes) : [], rs.takes && on ? unplacedOf(boxes, rs.schema) : [], rs.name || "");
                const k = JSON.stringify([boxes, refs.map((l) => [l.id, l.name])]);
                if (!force && k === key) return;
                // a field being edited is not rebuilt under the user's cursor: the next change after it blurs does it
                if (!force && list.contains(document.activeElement)) { pending = true; return; }
                key = k; pending = false;
                list.innerHTML = "";
                if (!boxes.length) { list.appendChild(ui.el("div", "boxes-empty", doc.loaded ? "No boxes yet. Draw one with the Boxes tool (X), or Selection → box takes the selection; boxes.add places one by numbers." : "Load an image first.")); return; }
                for (const b of boxes) {
                    const row = ui.el("div", "boxes-row");
                    row.dataset.box = b.id;
                    row.style.borderLeftColor = colourOf(b, boxes);
                    // a click on the row (not in a field) selects the box on the canvas
                    row.addEventListener("pointerdown", (e) => { if (!e.target.closest("input, select, button")) boxTool.select(doc, b.id); });
                    const head = ui.el("div", "boxes-head");
                    head.appendChild(field("boxes-id", b.id, "The element's name in the prompt: lowercase words and a number joined by underscores (knight_1, red_scarf_2)", (v) => change(b.id, { id: v })));
                    const kindNow = b.text != null ? "text" : b.kind;
                    head.appendChild(select(Object.entries(KIND_LABELS), kindNow, "What the box does", (v) => {
                        if (v === "text") change(b.id, { kind: "new", text: b.text || "" });
                        else if (v === "from") { if (!refs.length) { doc.status("Add a reference layer first (a layer with the role reference, shown)."); render(true); return; } change(b.id, { kind: "from", layer: b.layer && refs.some((l) => l.id === b.layer) ? b.layer : refs[0].id, text: null }); }
                        else change(b.id, { kind: v, text: null, ...(v !== "new" && b.kind === "new" ? { src: b.rect } : {}) });
                    }));
                    head.appendChild(ui.button("×", "Remove this box", () => run(() => remove(doc, b.id))));
                    row.appendChild(head);
                    if (b.text != null) row.appendChild(field("boxes-text", b.text, "The words rendered in the box", (v) => change(b.id, { text: v })));
                    const desc = field("boxes-desc", b.desc, b.text != null ? "Style and colour of the text (optional)" : "What it is (a reference as @img1); a box still called box_1 takes its name from it", (v) => change(b.id, { desc: v }));
                    desc.placeholder = b.text != null ? "style of the text (optional)" : b.kind === "new" ? "what goes in the box" : b.kind === "from" ? "what to take from the reference (optional)" : "what it is";
                    row.appendChild(desc);
                    const geo = ui.el("div", "boxes-geo");
                    geo.appendChild(ui.el("span", "boxes-geo-label", b.kind === "remove" ? "Was" : b.kind === "keep" ? "At" : "To"));
                    geo.appendChild(field("boxes-rect", rectText(b.kind === "keep" || b.kind === "remove" ? b.src : b.rect), "left, top, right, bottom in image pixels", (v) => change(b.id, b.kind === "keep" || b.kind === "remove" ? { src: parseRect(v), rect: parseRect(v) } : { rect: parseRect(v) })));
                    row.appendChild(geo);
                    if (b.kind === "move") {
                        const g2 = ui.el("div", "boxes-geo");
                        g2.appendChild(ui.el("span", "boxes-geo-label", "From"));
                        g2.appendChild(field("boxes-rect", rectText(b.src), "where the element is now: left, top, right, bottom", (v) => change(b.id, { src: parseRect(v) })));
                        row.appendChild(g2);
                    }
                    if (b.kind === "from") {
                        const g3 = ui.el("div", "boxes-geo");
                        g3.appendChild(ui.el("span", "boxes-geo-label", "Layer"));
                        const opts = refs.map((l) => [l.id, `${l.label ? "@" + l.label + " " : ""}${l.name}`]);
                        if (!refs.some((l) => l.id === b.layer)) opts.unshift([b.layer, "(not a shown reference)"]);
                        g3.appendChild(select(opts, b.layer, "The reference layer placed in the box (shown reference layers)", (v) => change(b.id, { layer: v })));
                        row.appendChild(g3);
                        const g4 = ui.el("div", "boxes-geo");
                        g4.appendChild(ui.el("span", "boxes-geo-label", "Part"));
                        g4.appendChild(field("boxes-rect", rectText(b.src), "the part of the reference layer, in image pixels where the layer sits; empty = the whole layer", (v) => change(b.id, { src: v.trim() ? parseRect(v) : null })));
                        row.appendChild(g4);
                    }
                    list.appendChild(row);
                }
                highlight();
            };
            const highlight = () => {
                const id = boxTool.selected(doc);
                for (const row of list.querySelectorAll(".boxes-row")) row.classList.toggle("boxes-row-sel", row.dataset.box === id);
            };
            panels.set(doc.id, { box, highlight });
            // the overlay shows while the panel is open: opening or closing it repaints the canvas
            const details = box.closest("details");
            if (details) details.addEventListener("toggle", () => doc.draw());
            list.addEventListener("focusout", () => { if (pending) setTimeout(() => { if (!list.contains(document.activeElement)) render(); }, 0); });
            render(true);
            doc.draw();
            scumble.events.on("changed", (ev) => { if (ev.doc && ev.doc.id === doc.id) render(); });
            scumble.events.on("recipe", () => render());
            // a node parameter or the API size changed the crop Generate sends
            scumble.events.on("crop", (ev) => { if (ev.doc && ev.doc.id === doc.id) render(); });
        },
        destroy(box, doc) { panels.delete(doc.id); },
    });

    // ---- Plugins menu ------------------------------------------------------------------------------------------------
    scumble.actions.register({ id: "from_selection", label: "Selection → box", run: (doc) => { try { const b = fromSelection(doc); doc.status(`Box ${b.id} added.${switchNote(doc)}`); return b; } catch (err) { doc.status(String(err.message || err)); return null; } } });

    // ---- commands ------------------------------------------------------------------------------------------------------
    const FIELDS = {
        kind: { type: "string", description: "new (an element added in the box), keep, move, remove (an element of the picture), from (a reference layer placed in the box)", enum: ["new", "keep", "move", "remove", "from"] },
        rect: { type: "array", description: "[left, top, right, bottom] in image pixels (or { x, y, w, h }): where the element goes; for remove, where it was" },
        src: { type: "array", description: "keep / move / remove: where the element is now; from: the part of the reference layer, in image pixels where the layer sits (omit for the whole layer)" },
        layer: { type: "string", description: "from only: the reference layer (id, name or a unique part of it)" },
        desc: { type: "string", description: `what the element is, at most ${DESC_MAX} characters; a reference as @img1` },
        text: { type: "string", description: "new only: words to render in the box (the box becomes a Text box)" },
    };
    const summary = (b) => ({ ...b });
    scumble.commands.register("list", {
        description: "The boxes of this document (image pixels), whether the selected recipe takes boxes and whether the document's Boxes switch is on (set_generation boxes): a run sends them only when both are.",
        params: {}, needsImage: true, scope: "doc",
        run(doc) { const rs = recipeState(); return { boxes: boxesOf(doc).map(summary), count: boxesOf(doc).length, recipe: { name: rs.name, takes: rs.takes, schema: rs.schema }, switch: switchOf(doc) }; },
    });
    scumble.commands.register("add", {
        description: "Add a box for the prompt: where an element goes (new), stays (keep), moves to (move) or is taken out (remove), or where a reference layer is placed (from). One undo step. Sent with a run of a recipe that takes boxes (FLUX 3 Image; Ideogram 4 takes new, text and keep) while the Boxes switch is on; the document's first box turns it on (switched_on in the answer).",
        params: { id: { type: "string", description: "lowercase words and a number joined by underscores (knight_1, red_scarf_2); default made from the last two words of the description's first phrase (\"a red scarf\" -> red_scarf_1, \"a small black cat sitting in the grass\" -> black_cat_1), else the next free box_n" }, ...FIELDS },
        needsImage: true, scope: "doc",
        run(doc, a) { const b = add(doc, a); return { ...summary(b), ...(switchNote(doc) ? { switched_on: true } : {}) }; },
    });
    scumble.commands.register("set", {
        description: "Change a box: only the given fields change (new_id renames it). A box whose id is still a default one (box_1, edit_2) is named after a new description (red_scarf_1) unless the prompt names it as <id>; the answer carries the id. One undo step.",
        params: { id: { type: "string", description: "the box to change", required: true }, new_id: { type: "string", description: "a new id" }, ...FIELDS },
        needsImage: true, scope: "doc",
        run(doc, a) { const { id, new_id: newId, ...rest } = a || {}; return summary(set(doc, String(id), newId != null ? { ...rest, id: newId } : rest)); },
    });
    scumble.commands.register("remove", {
        description: "Remove a box. One undo step.",
        params: { id: { type: "string", description: "the box to remove", required: true } },
        needsImage: true, scope: "doc",
        run(doc, a) { remove(doc, String(a.id)); return { removed: String(a.id), count: boxesOf(doc).length }; },
    });
    scumble.commands.register("from_selection", {
        description: "The selection's bounds as a box: a new box described by the prompt (or desc); when the prompt names a reference with @img1, that layer placed into the selection (a from box). One undo step.",
        params: { id: { type: "string", description: "default made from the description's words (red_door_1), else the next free edit_n" }, desc: { type: "string", description: "the description (default the prompt)" } },
        needsImage: true, scope: "doc",
        run(doc, a) { const b = fromSelection(doc, a || {}); return { ...summary(b), ...(switchNote(doc) ? { switched_on: true } : {}) }; },
    });
    scumble.commands.register("clear", {
        description: "Remove every box of this document. One undo step.",
        params: {}, needsImage: true, scope: "doc",
        run(doc) { return { removed: clear(doc) }; },
    });

    scumble.log("loaded");
}

export function deactivate() {}
