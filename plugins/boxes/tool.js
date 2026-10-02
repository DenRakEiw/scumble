// The Boxes tool and overlay (item 28 S3b, docs/PLAN_BOXES.md §10). Drag on empty canvas draws a New box, a click selects
// a box (its row in the panel lights up), a drag moves it, the eight handles resize it; Delete removes the selected box,
// Escape lets go of it, D duplicates it, the arrows nudge it by 1 px (Shift 10), Alt+click goes through boxes that lie
// on top of each other. A Move box's source and a From box's part are boxes of their own once the box is selected. A
// drag changes nothing until the button comes up: then it is one undo step through the plugin's data. The overlay draws
// every box in its kind's colour with its id, and the first words of its description when the box is wide enough; while
// the tool is active it also shows the crop Generate sends (S3c): the picture outside it dimmed, its size on its edge.

export const COLOURS = { new: "#3ddc84", text: "#3ddc84", keep: "#b4b4b4", move: "#4aa3ff", remove: "#ff5a5a", from: "#b57cff" };
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The rectangle the tool shows and edits for a box: a Keep or Remove box is where the element is (src). */
export const mainRect = (b) => ((b.kind === "keep" || b.kind === "remove") && Array.isArray(b.src) ? b.src : b.rect);
/** The colour of a box (a Text box is a New box with words). */
export const colourOf = (b) => COLOURS[b.text != null ? "text" : b.kind] || COLOURS.new;

/** A rectangle with whole, ordered corners, at least 1 px each way. */
function tidy(r) {
    let [l, t, rr, bb] = r.map(Math.round);
    if (rr < l) [l, rr] = [rr, l];
    if (bb < t) [t, bb] = [bb, t];
    if (rr === l) rr = l + 1;
    if (bb === t) bb = t + 1;
    return [l, t, rr, bb];
}
const inside = (r, x, y) => Array.isArray(r) && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
function handlePoints(r) {
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    return { nw: [r[0], r[1]], n: [cx, r[1]], ne: [r[2], r[1]], e: [r[2], cy], se: [r[2], r[3]], s: [cx, r[3]], sw: [r[0], r[3]], w: [r[0], cy] };
}
/** `r` with the handle `h` dragged by (dx, dy). */
function resized(r, h, dx, dy) {
    const out = r.slice();
    if (h.includes("w")) out[0] += dx;
    if (h.includes("e")) out[2] += dx;
    if (h.includes("n")) out[1] += dy;
    if (h.includes("s")) out[3] += dy;
    return out;
}

/**
 * The tool's definition for scumble.tools.register. `api` is the plugin's data side: boxesOf(doc), add(doc, input),
 * set(doc, id, patch), remove(doc, id), nextId(boxes, base), frame(doc) (the crop Generate sends, { x, y, w, h,
 * emitted } in image pixels, or null), panelShown(doc) (the Boxes panel is open and on screen), selChanged(doc) (the
 * panel shows the selection), referenceName(doc, id), sent(doc) (the document's Boxes switch is on: off, the boxes are
 * drawn dashed and paler), switchNote(doc) (" " + a note when the last add turned that switch on, else "").
 */
export function makeTool(scumble, api) {
    const selected = new Map();   // doc id -> box id
    let drag = null;              // { docId, mode: "new" | "move" | "resize", part: "main" | "src", id, handle, start, orig, rect, moved, square }
    const viewOf = (doc) => ({ scale: doc.editor.view.scale, dpr: window.devicePixelRatio || 1 });

    const selOf = (doc) => {
        const id = selected.get(doc.id);
        return id ? api.boxesOf(doc).find((b) => b.id === id) || null : null;
    };
    function select(doc, id) {
        if (id) selected.set(doc.id, id); else selected.delete(doc.id);
        api.selChanged(doc);
        doc.draw();
    }
    /** The parts of a box the tool edits: its main rectangle, and its source when it has one of its own. */
    const partsOf = (b) => {
        const out = [["main", mainRect(b)]];
        if ((b.kind === "move" || b.kind === "from") && Array.isArray(b.src)) out.push(["src", b.src]);
        return out;
    };
    /** A handle of the selected box under (x, y): { b, part, handle }. */
    function handleAt(doc, x, y, view) {
        const b = selOf(doc);
        if (!b) return null;
        const tol = 6 * view.dpr / view.scale;
        for (const [part, r] of partsOf(b).reverse()) {
            if (!Array.isArray(r)) continue;
            const pts = handlePoints(r);
            for (const h of HANDLES) if (Math.abs(x - pts[h][0]) <= tol && Math.abs(y - pts[h][1]) <= tol) return { b, part, handle: h };
        }
        return null;
    }
    /** Every box part under (x, y), the topmost (drawn last) first. */
    function hitsAt(doc, x, y) {
        const out = [];
        const boxes = api.boxesOf(doc);
        for (let i = boxes.length - 1; i >= 0; i--) {
            const b = boxes[i];
            for (const [part, r] of partsOf(b)) if ((part === "main" || b.id === selected.get(doc.id)) && inside(r, x, y)) out.push({ b, part });
        }
        return out;
    }
    /** The patch that puts part `part` of box `b` at rectangle `r`. */
    function patchFor(b, part, r) {
        if (part === "src") return { src: r };
        if (b.kind === "keep" || b.kind === "remove") return { rect: r, src: r };
        return { rect: r };
    }
    const shifted = (r, dx, dy) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
    function change(doc, b, patch, what) {
        try { api.set(doc, b.id, patch); return true; }
        catch (err) { doc.status(String((err && err.message) || err)); return false; }
        finally { if (what) doc.draw(); }
    }

    const tool = {
        id: "box",
        label: "Boxes",
        title: "Boxes for the prompt (FLUX 3 Image): drag to draw a box, click to select, drag to move, the handles to resize; Delete removes, D duplicates, arrows nudge, Alt+click picks a box under another",
        icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="11" height="9" rx="1"/><rect x="10" y="10" width="11" height="9" rx="1" stroke-dasharray="3 2"/></svg>',
        key: "X",
        hint: "Boxes: drag to draw a box, click to select, drag to move, handles resize; Delete removes, D duplicates, arrows nudge (Shift 10 px), Alt+click picks a box under another. Describe the boxes in the Generate pane's Boxes panel.",
        drawAlways: true,
        onDeselect(doc) { drag = null; doc.draw(); },
        onDown(doc, ev) {
            if (!doc.loaded) return;
            drag = null;
            const view = viewOf(doc);
            const h = handleAt(doc, ev.x, ev.y, view);
            if (h && !ev.alt) {
                const r = h.part === "src" ? h.b.src : mainRect(h.b);
                drag = { docId: doc.id, mode: "resize", part: h.part, id: h.b.id, handle: h.handle, start: [ev.x, ev.y], orig: r.slice(), rect: r.slice(), moved: false };
                return;
            }
            const hits = hitsAt(doc, ev.x, ev.y);
            if (hits.length) {
                const cur = selected.get(doc.id);
                let pick = hits[0];
                if (ev.alt) {
                    // the next box under the pointer after the selected one, round and round
                    const ids = [...new Set(hits.map((x) => x.b.id))];
                    const next = ids[(ids.indexOf(cur) + 1) % ids.length];
                    select(doc, next);
                    doc.status(`Box ${next} (${ids.indexOf(next) + 1} of ${ids.length} here).`);
                    return;
                }
                const mine = hits.find((x) => x.b.id === cur);
                if (mine) pick = mine;   // the selected box stays the one dragged even under another
                if (pick.b.id !== cur) select(doc, pick.b.id);
                const r = pick.part === "src" ? pick.b.src : mainRect(pick.b);
                drag = { docId: doc.id, mode: "move", part: pick.part, id: pick.b.id, start: [ev.x, ev.y], orig: r.slice(), rect: r.slice(), moved: false };
                return;
            }
            if (selected.has(doc.id)) select(doc, null);
            drag = { docId: doc.id, mode: "new", part: "main", id: null, start: [ev.x, ev.y], orig: null, rect: null, moved: false };
        },
        onMove(doc, ev) {
            if (!drag || drag.docId !== doc.id) return;
            const view = viewOf(doc);
            const dx = ev.x - drag.start[0], dy = ev.y - drag.start[1];
            if (!drag.moved && Math.hypot(dx, dy) * view.scale / view.dpr < 3) return;   // a click, not a drag
            drag.moved = true;
            if (drag.mode === "new") {
                let w = dx, h = dy;
                if (ev.shift) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
                drag.rect = tidy([drag.start[0], drag.start[1], drag.start[0] + w, drag.start[1] + h]);
            } else if (drag.mode === "move") drag.rect = tidy(shifted(drag.orig, dx, dy));
            else drag.rect = tidy(resized(drag.orig, drag.handle, dx, dy));
            const r = drag.rect;
            doc.status(`${drag.id || "New box"}: ${r[0]}, ${r[1]} - ${r[2]}, ${r[3]} (${r[2] - r[0]} x ${r[3] - r[1]} px)`);
            doc.draw();
        },
        onUp(doc) {
            const d = drag;
            drag = null;
            if (!d || d.docId !== doc.id) return;
            if (!d.moved || !d.rect) { doc.draw(); return; }
            if (d.mode === "new") {
                try {
                    const b = api.add(doc, { kind: "new", rect: d.rect, id: api.nextId(api.boxesOf(doc), "box") });
                    select(doc, b.id);
                    doc.status(`Box ${b.id} added: describe it in the Boxes panel of the Generate pane.${api.switchNote(doc)}`);
                } catch (err) { doc.status(String((err && err.message) || err)); doc.draw(); }
                return;
            }
            const b = api.boxesOf(doc).find((x) => x.id === d.id);
            if (b) change(doc, b, patchFor(b, d.part, d.rect), true);
        },
        onKey(doc, ev) {
            const b = selOf(doc);
            if (!b) return false;
            if (ev.key === "Delete" || ev.key === "Backspace") {
                try { api.remove(doc, b.id); doc.status(`Box ${b.id} removed (Ctrl+Z brings it back).`); }
                catch (err) { doc.status(String((err && err.message) || err)); }
                select(doc, null);
                return true;
            }
            if (ev.key === "Escape") { select(doc, null); return true; }
            if (ev.key.startsWith("Arrow")) {
                const step = ev.shift ? 10 : 1;
                const dx = ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0;
                const dy = ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0;
                change(doc, b, patchFor(b, "main", shifted(mainRect(b), dx, dy)), true);
                return true;
            }
            if (ev.lower === "d" && !ev.shift) {
                const off = 10;
                const base = b.id.replace(/_\d+$/, "");
                const copy = { kind: b.kind, rect: shifted(b.rect, off, off), desc: b.desc, text: b.text };
                if (b.kind === "keep" || b.kind === "remove") copy.src = shifted(b.src, off, off);
                else if (b.kind === "move" || b.kind === "from") copy.src = b.src;
                if (b.kind === "from") copy.layer = b.layer;
                try {
                    const n = api.add(doc, { ...copy, id: api.nextId(api.boxesOf(doc), base) });
                    select(doc, n.id);
                    doc.status(`Box ${n.id} added as a copy of ${b.id}.`);
                } catch (err) { doc.status(String((err && err.message) || err)); }
                return true;
            }
            return false;
        },
        draw(doc, ctx, view) {
            if (!doc.loaded) return;
            if (!view.active && !api.panelShown(doc)) return;
            const boxes = api.boxesOf(doc);
            const live = drag && drag.docId === doc.id && drag.moved ? drag : null;
            const crop = view.active ? api.frame(doc) : null;
            if (!boxes.length && !live && !crop) return;
            const px = view.dpr / view.scale;   // one screen pixel in image pixels
            const sel = selected.get(doc.id);
            // the Boxes switch is off: the boxes stay with the document but go with no run, drawn dashed and paler
            const base = api.sent(doc) ? 1 : 0.5;
            ctx.font = `${11 * px}px system-ui, sans-serif`;
            ctx.textBaseline = "top";
            const outline = (r, colour, width, dash) => {
                ctx.setLineDash(dash ? dash.map((v) => v * px) : []);
                ctx.lineWidth = width + 2 * px; ctx.strokeStyle = "rgba(0,0,0,0.55)";
                ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
                ctx.lineWidth = width; ctx.strokeStyle = colour;
                ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
                ctx.setLineDash([]);
            };
            const handles = (r, colour) => {
                const s = 7 * px;
                for (const [x, y] of Object.values(handlePoints(r))) {
                    ctx.fillStyle = "#fff"; ctx.fillRect(x - s / 2, y - s / 2, s, s);
                    ctx.lineWidth = 1.5 * px; ctx.strokeStyle = colour; ctx.strokeRect(x - s / 2, y - s / 2, s, s);
                }
            };
            const tag = (r, colour, text) => {
                const pad = 3 * px, h = 15 * px;
                const w = Math.min(ctx.measureText(text).width + 2 * pad, Math.max(r[2] - r[0], 40 * px));
                const y = r[1] - h >= 0 ? r[1] - h : r[1];
                ctx.fillStyle = colour; ctx.fillRect(r[0], y, w, h);
                ctx.fillStyle = "#111";
                ctx.save(); ctx.beginPath(); ctx.rect(r[0], y, w, h); ctx.clip();
                ctx.fillText(text, r[0] + pad, y + 2 * px);
                ctx.restore();
            };
            const words = (r, text) => {
                const pad = 5 * px, w = r[2] - r[0] - 2 * pad;
                if (!text || w < 50 * px || r[3] - r[1] < 34 * px) return;
                let t = text;
                if (ctx.measureText(t).width > w) {
                    while (t.length > 1 && ctx.measureText(t + "…").width > w) t = t.slice(0, -1);
                    t = t.trimEnd() + "…";
                }
                // white on a dark strip reads on any picture
                ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(r[0] + pad - 3 * px, r[1] + 17 * px, ctx.measureText(t).width + 6 * px, 15 * px);
                ctx.fillStyle = "#fff"; ctx.fillText(t, r[0] + pad, r[1] + 19 * px);
            };
            const hatch = (r, colour) => {
                ctx.save(); ctx.beginPath(); ctx.rect(r[0], r[1], r[2] - r[0], r[3] - r[1]); ctx.clip();
                ctx.strokeStyle = colour; ctx.globalAlpha = 0.45 * base; ctx.lineWidth = 1 * px;
                const step = 9 * px, w = r[2] - r[0], h = r[3] - r[1];
                ctx.beginPath();
                for (let o = -h; o < w; o += step) { ctx.moveTo(r[0] + o, r[3]); ctx.lineTo(r[0] + o + h, r[1]); }
                ctx.stroke(); ctx.restore();
            };
            const arrow = (a, b, colour) => {
                const ax = (a[0] + a[2]) / 2, ay = (a[1] + a[3]) / 2, bx = (b[0] + b[2]) / 2, by = (b[1] + b[3]) / 2;
                const len = Math.hypot(bx - ax, by - ay);
                if (len < 12 * px) return;
                const ang = Math.atan2(by - ay, bx - ax), head = 9 * px;
                ctx.strokeStyle = colour; ctx.fillStyle = colour; ctx.lineWidth = 1.5 * px;
                ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx - Math.cos(ang) * head, by - Math.sin(ang) * head); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(bx, by);
                ctx.lineTo(bx - Math.cos(ang - 0.4) * head, by - Math.sin(ang - 0.4) * head);
                ctx.lineTo(bx - Math.cos(ang + 0.4) * head, by - Math.sin(ang + 0.4) * head);
                ctx.closePath(); ctx.fill();
            };
            const visibleLayer = (id) => { const l = doc.layers().find((x) => x.id === id); return !!(l && l.visible); };
            const cropFrame = crop ? [crop.x, crop.y, crop.x + crop.w, crop.y + crop.h] : null;
            if (crop) {
                // the crop Generate sends: the picture outside it dimmed and a thin frame under the boxes, its size on top
                ctx.fillStyle = "rgba(0,0,0,0.3)";
                ctx.beginPath(); ctx.rect(0, 0, doc.width, doc.height); ctx.rect(crop.x, crop.y, crop.w, crop.h); ctx.fill("evenodd");
                outline(cropFrame, "#ffffff", 1 * px, [6, 4]);
            }
            // the selected box last, so its handles lie on top
            const order = boxes.filter((b) => b.id !== sel).concat(boxes.filter((b) => b.id === sel));
            for (const b0 of order) {
                let b = b0;
                if (live && live.id === b.id) b = { ...b, ...patchFor(b, live.part, live.rect) };
                const colour = colourOf(b), r = mainRect(b), isSel = b.id === sel;
                if (!Array.isArray(r)) continue;
                const lw = (isSel ? 2.5 : 1.5) * px;
                ctx.globalAlpha = base;
                if (b.kind === "move" && Array.isArray(b.src)) { outline(b.src, colour, 1.5 * px, [5, 4]); arrow(b.src, r, colour); }
                if (b.kind === "from" && Array.isArray(b.src) && visibleLayer(b.layer)) outline(b.src, colour, 1.5 * px, [5, 4]);
                ctx.globalAlpha = 0.1 * base; ctx.fillStyle = colour; ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]); ctx.globalAlpha = base;
                if (b.kind === "remove") hatch(r, colour);
                outline(r, colour, lw, base < 1 ? [6, 4] : null);
                const name = b.kind === "from" ? api.referenceName(doc, b.layer) : null;
                tag(r, colour, name ? `${b.id} ← ${name}` : b.text != null ? `${b.id} T` : b.id);
                words(r, b.text != null ? `"${b.text}"` : b.desc);
                if (isSel) { ctx.globalAlpha = 1; handles(r, colour); if ((b.kind === "move" || b.kind === "from") && Array.isArray(b.src) && (b.kind === "move" || visibleLayer(b.layer))) handles(b.src, colour); }
            }
            ctx.globalAlpha = 1;
            if (live && live.mode === "new" && live.rect) outline(live.rect, COLOURS.new, 2 * px, [6, 4]);
            if (crop) {
                const f = cropFrame;
                const sent = crop.emitted && (crop.emitted[0] !== crop.w || crop.emitted[1] !== crop.h) ? `, sent as ${crop.emitted[0]} × ${crop.emitted[1]}` : "";
                const text = `Crop Generate sends: ${crop.w} × ${crop.h}${sent}`;
                const h = 15 * px, w = ctx.measureText(text).width + 6 * px;
                const y = f[3] + h <= doc.height ? f[3] : f[3] - h;
                ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(f[0], y, w, h);
                ctx.fillStyle = "#fff"; ctx.fillText(text, f[0] + 3 * px, y + 2 * px);
            }
        },
    };
    return { tool, selected: (doc) => selected.get(doc.id) || null, select, forget: (docId) => selected.delete(docId) };
}
