// the filter, text, history, canvas and export commands: moved out of commands.js (item 56 S12, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./editor/host.js";
import { FILTERS } from "./editor/inpaint_filters.js";
import { refusal } from "./editor/inpaint_status.js";
import { canvasSizeRefusal } from "./editor/inpaint_sizelimit.js";
import { P, SHOT_WHAT, TEXT_LINE_HEIGHT_TEXT, TEXT_SPACING_TEXT, checkParams, docName, filterStepLabel, findLayer, layerSummary, setFont, shotCanvas, textSpacing, touch, withExportPath, writeParams } from "./commands_util.js";

/** @typedef {import("./commands.js").Command} Command */

/** @satisfies {Record<string, Command>} */
export const EditCommandsPart = {
    // -- filters --
    filter_types: {
        readOnly: true,
        scope: "app", description: "The filter layer types (built-in and from plugins) with their parameters; `fill: true` marks a fill layer's type (fill: a colour, gradient: two colours with their opacities), which covers what is below instead of filtering it. A select's options are {id, label, group}; a select with key \"preset\" (a grain's film stock, a black-and-white film's colour filter) fills the other parameters with the option's values when add_filter / set_filter set it, as picking it in the layer list does; `offset: true` marks a slider that is an offset on the preset (the others turn the preset to custom when they change it).",
        params: {},
        async run() {
            const option = (o) => (o && typeof o === "object" ? { id: o.id, label: o.label != null ? String(o.label) : String(o.id), ...(o.group ? { group: o.group } : {}), ...(o.needs ? { needs: o.needs } : {}) } : { id: o, label: String(o) });
            return {
                filters: Object.entries(FILTERS).map(([id, f]) => {
                    const hasPreset = (f.params || []).some((p) => p.key === "preset" && p.type === "select");
                    const needs = f.maps ? (typeof f.maps === "function" ? f.maps({}) : f.maps) : [];
                    return {
                        id, label: f.label, plugin: f.plugin || null, ...(f.over ? { fill: true } : {}),
                        needs,
                        params: (f.params || []).map((p) => ({
                            key: p.key, label: p.label, type: p.type || "number", min: p.min, max: p.max, default: p.type === "custom" ? undefined : p.default,
                            options: p.options ? p.options.map(option) : undefined,
                            offset: hasPreset && p.key !== "preset" && p.keepPreset ? true : undefined,
                            ...(p.hidden ? { hidden: true } : {}),
                            ...(p.when ? { when: p.when } : {}),
                            ...(p.schema ? { schema: p.schema } : {}),
                            ...(p.example !== undefined ? { example: p.example } : {}),
                        })),
                    };
                }),
                common: {
                    limit: {
                        source: ["depth", "luma", "color"],
                        lo: "0..1",
                        hi: "0..1",
                        fLo: "0..1",
                        fHi: "0..1",
                        invert: "bool",
                        color: "#rrggbb",
                        tol: "0..100",
                    },
                },
            };
        },
    },
    add_filter: {
        needsImage: true, description: "Add a non-destructive filter layer on top of the stack (see filter_types for types and params). A fill layer is one too: type \"fill\" (params color \"#rrggbb\") or \"gradient\" (shape linear / reflected / radial, from, to, from_opacity, to_opacity, angle, scale, x, y); it covers what is below, and set_layer's opacity, blend and a mask let the picture through. params.preset (a film stock of the grain, a colour filter of black-and-white film) sets the preset's values and names the layer as the layer list does; the other params are applied after it. Nothing is added when a parameter is refused.",
        params: { type: P.str("filter type id", { default: "grain" }), params: P.obj("parameter values {key: value}"), name: P.str("layer name (default the type, or the preset's name)") },
        async run(ed, a) {
            const type = String(a.type || "grain");
            if (!FILTERS[type]) throw new Error(`unknown filter "${type}" (${Object.keys(FILTERS).join(", ")})`);
            const vals = a.params != null ? checkParams(type, a.params, { width: ed.width, height: ed.height }) : null;
            if (FILTERS[type]?.over && vals?.limit && vals.limit.source !== "depth") throw new Error("a fill layer takes a depth limit only");
            if (type === "relight") {
                const hasDepth = !!(ed.maps && ed.maps.depth && (ed.maps.depth.data || ed.maps.depth.u16));
                if (!hasDepth && ed.ensureDepthMap) {
                    await ed.ensureDepthMap();
                }
            }
            const l = ed.addFilterLayer(type);
            if (!l) throw new Error(ed.status);
            if (vals) writeParams(ed, l, vals);
            if (a.name) l.name = String(a.name);
            touch(ed);
            return layerSummary(ed, l);
        },
    },
    set_filter: {
        description: "Change a filter layer's parameters (or its type), in one undo step as the layer list's controls make one. params.limit restricts where the filter acts (by depth, luma or colour; fill layers take depth only). params.preset (a film stock of the grain, a colour filter of black-and-white film) sets the preset's values and names the layer, then the other params are applied; a slider that is no offset on the preset turns it to custom when it changes the value (filter_types: offset). A new type starts from its defaults, then params. Nothing changes when a parameter is refused.",
        params: { layer: P.layer("", { required: true }), type: P.str("new filter type id"), params: P.obj("parameter values {key: value}") },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (l.kind !== "filter") throw new Error(`${l.name} is not a filter layer`);
            const type = a.type != null && a.type !== "" ? String(a.type) : null;
            if (type && !FILTERS[type]) throw new Error(`unknown filter "${type}" (${Object.keys(FILTERS).join(", ")})`);
            // a fill layer stays a fill and a filter a filter, as the type select offers them
            if (type && FILTERS[l.filter] && !!FILTERS[type].over !== !!FILTERS[l.filter].over) throw new Error(`${l.name} is a ${FILTERS[l.filter].over ? "fill" : "filter"} layer: its type is one of the ${FILTERS[l.filter].over ? "fills" : "filters"} (filter_types: fill)`);
            const vals = a.params != null ? checkParams(type || l.filter, a.params, { width: ed.width, height: ed.height }) : null;
            const targetType = type || l.filter;
            if (FILTERS[targetType]?.over && vals?.limit && vals.limit.source !== "depth") throw new Error("a fill layer takes a depth limit only");
            const keys = vals ? Object.keys(vals) : [];
            const retype = !!type && type !== l.filter;
            if (retype && type === "relight") {
                const hasDepth = !!(ed.maps && ed.maps.depth && (ed.maps.depth.data || ed.maps.depth.u16));
                if (!hasDepth && ed.ensureDepthMap) {
                    await ed.ensureDepthMap();
                }
            }
            // the type select pushes its own step ("Filter type"), which holds the parameters as they were too
            if (retype) ed.setFilterType(l, type);
            else if (keys.length) ed.pushUndo({ kind: "filter", id: l.id, label: filterStepLabel(l.filter, keys) });
            if (keys.length) writeParams(ed, l, vals);
            touch(ed);
            return layerSummary(ed, l);
        },
    },

    // -- text --
    add_text: {
        needsImage: true, description: "Add a text layer at x,y (top left of the text; with an angle the corner the text starts at). Bundled fonts: Roboto, Open Sans, Montserrat, Playfair Display, Lobster, Oswald, Pacifico, Bebas Neue and more (see the editor's font list).",
        params: { text: P.str("the text", { required: true }), x: P.num("left (default 10 % of the width)"), y: P.num("top"), size: P.int("font size in pixels"), font: P.str("font family"), color: P.str("CSS colour"), bold: P.bool(""), italic: P.bool(""), align: P.str("left, center or right"), line_height: P.num(TEXT_LINE_HEIGHT_TEXT), letter_spacing: P.num(TEXT_SPACING_TEXT), outline: P.num("outline width"), outline_color: P.str(""), angle: P.num("degrees clockwise; the text stays editable"), name: P.str("layer name") },
        async run(ed, a) {
            // refused before the layer is added: a call that fails adds nothing
            const spacing = textSpacing(a);
            const l = await ed.addTextLayer(a.x != null ? +a.x : ed.width * 0.1, a.y != null ? +a.y : ed.height * 0.1);
            if (!l) throw new Error(ed.status);
            const t = l.text;
            Object.assign(t, spacing);
            if (a.text != null) t.content = String(a.text);
            if (a.font != null && String(a.font) !== t.font) setFont(t, String(a.font));
            if (a.size != null) t.size = Math.max(4, Math.round(+a.size));
            if (a.color != null) t.color = String(a.color);
            if (a.bold != null) t.bold = !!a.bold;
            if (a.italic != null) t.italic = !!a.italic;
            if (a.align != null) t.align = String(a.align);
            if (a.outline != null) t.outline = Math.max(0, +a.outline);
            if (a.outline_color != null) t.outlineColor = String(a.outline_color);
            if (a.name) l.name = String(a.name);
            await ed.renderTextLayer(l, { keepScale: false });
            // turned about the corner the text starts at, which stays at x, y; the layer's own step covers it
            if (a.angle != null && +a.angle) await ed.setTextAngle(l, +a.angle, { step: false, pivot: "start" });
            if (ed.textEdit) ed.endTextEdit(true);
            try { const focused = /** @type {HTMLElement | null} */ (document.activeElement); if (focused) focused.blur(); } catch (_) { /* ignore */ }
            touch(ed);
            return layerSummary(ed, l);
        },
    },
    set_text: {
        description: "Change a text layer's content, style or angle (degrees clockwise in all, about the layer's middle; the text stays editable).",
        params: { layer: P.layer("", { required: true }), text: P.str(""), font: P.str(""), size: P.int(""), color: P.str(""), bold: P.bool(""), italic: P.bool(""), align: P.str(""), line_height: P.num(TEXT_LINE_HEIGHT_TEXT), letter_spacing: P.num(TEXT_SPACING_TEXT), outline: P.num(""), outline_color: P.str(""), angle: P.num("") },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (l.kind !== "text") throw new Error(`${l.name} is not a text layer`);
            const spacing = textSpacing(a);
            const t = l.text;
            Object.assign(t, spacing);
            for (const [k, tk] of [["text", "content"], ["color", "color"], ["align", "align"], ["outline_color", "outlineColor"]]) if (a[k] != null) t[tk] = String(a[k]);
            if (a.font != null && String(a.font) !== t.font) setFont(t, String(a.font));
            if (a.size != null) t.size = Math.max(4, Math.round(+a.size));
            if (a.bold != null) t.bold = !!a.bold;
            if (a.italic != null) t.italic = !!a.italic;
            if (a.outline != null) t.outline = Math.max(0, +a.outline);
            await ed.renderTextLayer(l, { keepScale: true });
            // a locked layer keeps its angle: said, not silently skipped
            if (a.angle != null && l.locked) throw new Error(`${l.name} is locked: its angle cannot change`);
            if (a.angle != null) await ed.setTextAngle(l, +a.angle || 0, { step: false });
            touch(ed);
            return layerSummary(ed, l);
        },
    },

    // -- history, canvas --
    undo: {
        destructive: true,
        description: "Undo the last step, or `steps` of them (list_history shows what each one is).",
        params: { steps: P.int("how many steps (default 1)", { default: 1 }) },
        async run(ed, a) { const stepped = await ed.stepHistory(-Math.max(1, Math.round(+a.steps || 1))); return { undo: ed.undo.length, redo: ed.redo.length, stepped, status: ed.status }; },
    },
    redo: {
        destructive: true,
        description: "Redo the last undone step, or `steps` of them.",
        params: { steps: P.int("how many steps (default 1)", { default: 1 }) },
        async run(ed, a) { const stepped = await ed.stepHistory(Math.max(1, Math.round(+a.steps || 1))); return { undo: ed.undo.length, redo: ed.redo.length, stepped, status: ed.status }; },
    },
    list_history: {
        readOnly: true,
        description: "The undo history, oldest first: one row per state, named by the edit that led to it; `current` is the picture now, `future` rows are undone steps a redo brings back. `steps` is what undo (negative) or redo (positive) takes to get to a row. Also the named snapshots and the history's depth.",
        params: {},
        async run(ed) {
            return {
                rows: ed.undoList(), undo: ed.undo.length, redo: ed.redo.length,
                snapshots: ed.snapshots.map((s) => ({ name: s.name, at: s.at })),
                depth: { steps: ed.maxUndo, mb: Math.round(ed.maxUndoBytes / 1048576) },
            };
        },
    },
    take_snapshot: {
        needsImage: true, description: "Keep the whole document as it is now under a name (layers, masks, the selection, the prompt and settings), to come back to with restore_snapshot. Up to 8 per document; not saved with the document. Needs the tile backend. A name already taken gets a number.",
        params: { name: P.str("a name for it (default \"Snapshot N\")"), drop_oldest: P.bool("when the document holds 8 already: drop the oldest for good (else this is refused)") },
        async run(ed, a) {
            if (!ed.tileMode) throw new Error("snapshots need the tile backend (Settings › Rendering)");
            if (ed.snapshots.length >= 8 && !a.drop_oldest) throw new Error(`the document holds 8 snapshots (${ed.snapshots.map((x) => x.name).join(", ")}): delete_snapshot one, or pass drop_oldest: true`);
            const s = ed.takeSnapshot(a.name);
            if (!s) throw new Error("the snapshot could not be taken");
            return { name: s.name, snapshots: ed.snapshots.map((x) => x.name) };
        },
    },
    restore_snapshot: {
        needsImage: true, description: "Put the document back as it was in a named snapshot (take_snapshot). One undo step: undo takes it back; the snapshot stays.",
        params: { name: P.str("the snapshot's name", { required: true }) },
        async run(ed, a) {
            if (!ed.findSnapshot(String(a.name))) throw new Error(`no snapshot "${a.name}" (list_history lists them)`);
            if (!ed.restoreSnapshot(String(a.name))) throw new Error("the snapshot could not be restored");
            touch(ed);
            return { restored: String(a.name), undo: ed.undo.length, redo: ed.redo.length };
        },
    },
    delete_snapshot: {
        destructive: true,
        description: "Delete a named snapshot. The picture does not change.",
        params: { name: P.str("the snapshot's name", { required: true }) },
        async run(ed, a) {
            if (!ed.deleteSnapshot(String(a.name))) throw new Error(`no snapshot "${a.name}"`);
            return { deleted: String(a.name), snapshots: ed.snapshots.map((x) => x.name) };
        },
    },
    compare: { description: "Toggle the before / after split view.", params: { enabled: P.bool("on or off; toggles when omitted") }, async run(ed, a) { const want = a.enabled == null ? !ed.compare : !!a.enabled; if (want !== !!ed.compare) ed.toggleCompare(); return { compare: !!ed.compare, status: ed.status }; } },
    extend_canvas: {
        destructive: true,
        needsImage: true, description: "Extend (positive) or crop (negative) the canvas on each side, in pixels. An extension bakes every visible layer into the base and fills the new border as set_crop's extendFill says (average color unless set).",
        params: { left: P.int("", { default: 0 }), top: P.int("", { default: 0 }), right: P.int("", { default: 0 }), bottom: P.int("", { default: 0 }) },
        async run(ed, a) {
            const v = { left: Math.round(+a.left || 0), top: Math.round(+a.top || 0), right: Math.round(+a.right || 0), bottom: Math.round(+a.bottom || 0) };
            // refused before the crop: the extend after it is made as one canvas at the final size (S5)
            const fw = ed.width + v.left + v.right, fh = ed.height + v.top + v.bottom;
            // a crop alone makes no single canvas (a tile document above 268 MP is cropped on its tiles)
            const grows = Object.values(v).some((x) => x > 0);
            const tooBig = grows && fw >= 1 && fh >= 1 ? canvasSizeRefusal(fw, fh, "The extended picture") : "";
            if (tooBig) throw refusal(tooBig, "warn");
            if (Object.values(v).some((x) => x < 0)) {
                const cw = ed.width + Math.min(0, v.left) + Math.min(0, v.right), ch = ed.height + Math.min(0, v.top) + Math.min(0, v.bottom);
                await ed.cropCanvas(v);
                // a refused crop (smaller than 8 px, a job running) only says so in the status: no extend after it
                if (ed.width !== cw || ed.height !== ch) throw refusal(ed.status || "The crop was refused.", ed.statusKind || "warn");
                v.left = Math.max(0, v.left); v.top = Math.max(0, v.top); v.right = Math.max(0, v.right); v.bottom = Math.max(0, v.bottom);
            }
            if (Object.values(v).some((x) => x > 0)) {
                await ed.extendCanvas(v);
                if (ed.width !== fw || ed.height !== fh) throw refusal(`${ed.status || "The extend was refused."}${[a.left, a.top, a.right, a.bottom].some((x) => +x < 0) ? " The crop before it was made (one undo step)." : ""}`, ed.statusKind || "warn");
            }
            return { width: ed.width, height: ed.height, status: ed.status };
        },
    },
    rotate_canvas: {
        needsImage: true, description: "Rotate the whole picture by a quarter or a half turn (degrees clockwise: 90, -90 = 270, 180). Every layer, mask, the selection, the guides, the saved selections and the results history turn with it; nothing is resampled. One undo step. Refused while a render or another job of the document runs.",
        params: { angle: P.int("degrees clockwise", { required: true, enum: [90, -90, 180, 270] }) },
        async run(ed, a) {
            const turns = { 90: 1, 270: -1, "-90": -1, 180: 2, "-180": 2 };
            const op = turns[String(Math.round(+a.angle))];
            if (op === undefined) throw new Error("angle must be 90, -90 (270) or 180");
            const w0 = ed.width, h0 = ed.height;
            if (!(await ed.turnDocument(op))) throw new Error(ed.status || "the picture could not be turned");
            const quarter = op !== 2;
            if (ed.width !== (quarter ? h0 : w0) || ed.height !== (quarter ? w0 : h0)) throw new Error(`the picture is ${ed.width} × ${ed.height} after the turn`);
            return { width: ed.width, height: ed.height, status: ed.status };
        },
    },
    flip_canvas: {
        needsImage: true, description: "Mirror the whole picture: horizontal (left to right) or vertical (top to bottom). Every layer, mask, the selection, the guides, the saved selections and the results history follow. One undo step. (flip_layer mirrors one layer.)",
        params: { axis: P.str("horizontal (left to right) or vertical (top to bottom)", { required: true, enum: ["horizontal", "vertical"] }) },
        async run(ed, a) {
            const axis = String(a.axis || "").toLowerCase();
            const op = axis === "horizontal" || axis === "h" ? "h" : axis === "vertical" || axis === "v" ? "v" : null;
            if (!op) throw new Error("axis must be horizontal or vertical");
            if (!(await ed.turnDocument(op))) throw new Error(ed.status || "the picture could not be mirrored");
            return { width: ed.width, height: ed.height, status: ed.status };
        },
    },
    straighten_canvas: {
        destructive: true,
        needsImage: true, description: "Straighten the whole picture: turn it by any angle (degrees clockwise, -45..45) about its centre and crop it to a frame inside the turned picture, in one undo step. Without x / y / width / height the frame is the largest one of `aspect` (original: the picture's own; free; 1:1, 4:3, 3:2, 16:9, 5:4 or W:H) centred in the turned picture. x / y / width / height set the frame in the turned picture's coordinates (the picture's own at 0 degrees). The base, every layer and mask and the selection are resampled once; text stays editable (its angle grows); guides stay where they are on the screen, shifted by the crop. Refused while a render or another job of the document runs.",
        params: {
            angle: P.num("degrees clockwise, -45..45", { required: true }), aspect: P.str("original, free, 1:1, 4:3, 3:2, 16:9, 5:4 or W:H", { default: "original" }),
            x: P.int("frame left"), y: P.int("frame top"), width: P.int("frame width"), height: P.int("frame height"),
        },
        async run(ed, a) {
            const angle = +a.angle;
            if (!Number.isFinite(angle) || Math.abs(angle) > 45) throw new Error("angle must be between -45 and 45 degrees (rotate_canvas turns by quarters)");
            let frame = {};
            if ([a.x, a.y, a.width, a.height].every((v) => v != null)) frame = { x: +a.x, y: +a.y, w: +a.width, h: +a.height };
            else if ([a.x, a.y, a.width, a.height].some((v) => v != null)) throw new Error("give all of x, y, width and height, or none");
            else {
                const ratio = ed.aspectRatio(String(a.aspect || "original"));
                if (ratio === undefined) throw new Error("aspect must be original, free, 1:1, 4:3, 3:2, 16:9, 5:4 or W:H");
                const [x, y, w, h] = ed.fitFrame(angle, ratio);
                frame = { x, y, w, h };
            }
            if (!(await ed.straightenDocument({ angle, ...frame }))) throw new Error(ed.status || "the picture could not be straightened");
            return { width: ed.width, height: ed.height, status: ed.status };
        },
    },
    resize_image: {
        destructive: true,
        needsImage: true,
        description: "Resize the whole document, as Image › Canvas › Resize: the base picture is resampled to the new size, every layer keeps its own pixels and is scaled in place, masks and the selection follow, and a filter layer's sizes in pixels (a blur radius, a grain size) scale by the same factor; one undo step. Give width and height, or one of them (the other keeps the aspect), or percent, or long_side (the aspect kept). Refused while a run or another job of the document is going (its result would land in the old geometry), below 8 px a side, and past what one canvas holds (65,535 px a side, 268 megapixels). from: the size before.",
        params: {
            width: P.int("the new width in pixels"), height: P.int("the new height in pixels"),
            percent: P.num("instead: percent of the current size (1..1000)"), long_side: P.int("instead: the new long side in pixels"),
        },
        async run(ed, a) {
            const W = ed.width, H = ed.height;
            const given = (v) => v != null && v !== "";
            const ways = [given(a.width) || given(a.height), given(a.percent), given(a.long_side)].filter(Boolean).length;
            if (ways !== 1) throw new Error(ways ? "give width / height, percent or long_side, one of them" : "give width and / or height, percent or long_side");
            const num = (v, what) => { const x = +v; if (!Number.isFinite(x) || x <= 0) throw new Error(`${what} must be a positive number, not ${JSON.stringify(v)}`); return x; };
            let nw, nh;
            if (given(a.percent)) {
                const p = num(a.percent, "percent");
                if (p < 1 || p > 1000) throw new Error("percent must be 1..1000");
                nw = Math.round(W * p / 100); nh = Math.round(H * p / 100);
            } else if (given(a.long_side)) {
                const k = num(a.long_side, "long_side") / Math.max(W, H);
                nw = Math.round(W * k); nh = Math.round(H * k);
            } else {
                nw = given(a.width) ? Math.round(num(a.width, "width")) : null;
                nh = given(a.height) ? Math.round(num(a.height, "height")) : null;
                if (nw == null) nw = Math.round(W * nh / H);
                if (nh == null) nh = Math.round(H * nw / W);
            }
            if (nw < 8 || nh < 8) throw new Error(`${nw} × ${nh} px is too small: at least 8 px a side`);
            if (nw > 65535 || nh > 65535 || nw * nh > 268435456) throw new Error(`${nw} × ${nh} px is more than one canvas holds (65,535 px a side, 268 megapixels): the resize needs one of that size`);
            if (nw === W && nh === H) throw new Error(`the picture is ${W} × ${H} already`);
            // before the editor, which would only say it in the status line: a job would land in the old geometry
            const blocked = ed.turnBlocked();
            if (blocked) throw new Error(blocked);
            if (ed._turning) throw new Error("Wait for the turn to finish.");
            await ed.resizeImage(nw, nh);
            if (ed.width !== nw || ed.height !== nh) throw new Error(ed.status || "the picture could not be resized");
            return { width: ed.width, height: ed.height, from: [W, H], status: ed.status };
        },
    },

    // -- export --
    export: {
        destructive: true,
        needsImage: true, description: "Save the flattened image (png, jpg, webp, tiff, psd or ora with layers). With `path` no dialog is shown. `scale`, `width` and `height` save it smaller or bigger; `canvas_width` / `canvas_height` put it in a frame of that size (bigger: a margin of `fill`, smaller: cropped) at `anchor`; PSD and ORA always keep the full size. A PNG carries the prompt, seed and recipe only when `metadata` is true, or when it is left out and the Export section's switch is on (on by default).",
        params: { format: P.str("png, jpg, webp, tiff, psd or ora", { enum: ["png", "jpg", "webp", "tiff", "psd", "ora"], default: "png" }), name: P.str("file name stem for the dialog"), path: P.str("absolute target path (no dialog)"), scale: P.num("percent of the document size, 1..400"), width: P.int("width in pixels (the height follows the aspect ratio)"), height: P.int("height in pixels (the width follows the aspect ratio)"), quality: P.num("JPEG / WebP quality 0.1..1", { default: 0.92 }),
            canvas_width: P.int("frame width in pixels (default the picture's)"), canvas_height: P.int("frame height in pixels"), anchor: P.str("where the picture sits in the frame: tl, tc, tr, ml, mc, mr, bl, bc, br", { default: "mc" }), fill: P.str("transparent, white, black or #rrggbb around the picture", { default: "transparent" }),
            metadata: P.bool("PNG: write the prompt, seed and recipe into the file (default: the Export section's switch)") },
        async run(ed, a) {
            const fmt = ["png", "jpg", "webp", "tiff", "psd", "ora"].includes(a.format) ? a.format : "png";
            if (ed.saveFormatSel) ed.saveFormatSel.value = fmt;
            if (ed.saveNameInput) ed.saveNameInput.value = String(a.name || docName(ed) || "scumble");
            const before = { ...host.exportState(ed) };
            if (a.width != null || a.height != null) host.setExportSize(ed, { width: a.width, height: a.height, quality: a.quality });
            else if (a.scale != null) host.setExportSize(ed, { percent: a.scale, quality: a.quality });
            else if (a.quality != null) host.setExportSize(ed, { quality: a.quality });
            if (a.canvas_width != null || a.canvas_height != null) host.setExportSize(ed, { canvasWidth: a.canvas_width, canvasHeight: a.canvas_height, anchor: a.anchor, fill: a.fill });
            if (a.metadata != null) host.exportState(ed).metadata = !!a.metadata;   // this export only: `before` puts it back
            const saved = await withExportPath(a.path, () => ed.exportImage({ download: false }))
                .finally(() => { ed._export = before; host.syncExportRow(ed); });
            if (!saved) throw new Error(ed.status);
            return { file: saved, status: ed.status };
        },
    },
    export_layer: {
        destructive: true,
        description: "Save one layer as a PNG with transparency.",
        params: { layer: P.layer(), path: P.str("absolute target path (no dialog)") },
        async run(ed, a) { const l = findLayer(ed, a.layer); ed.activeLayerId = l.id; const saved = await withExportPath(a.path, () => ed.exportLayerPng()); if (!saved) throw new Error(ed.status); return { file: saved, status: ed.status }; },
    },
    export_mask: {
        destructive: true,
        needsImage: true, description: "Save the selection as a black and white mask PNG.",
        params: { path: P.str("absolute target path (no dialog)") },
        async run(ed, a) { const saved = await withExportPath(a.path, () => ed.exportMaskPng()); if (!saved) throw new Error(ed.status); return { file: saved, status: ed.status }; },
    },
    screenshot: {
        readOnly: true,
        needsImage: true, description: "A JPEG, base64 in `data`. what = image: the flattened picture; editor: with hidden helpers; layer: one layer alone (its own pixels, whole); base: the base picture without any layer (the before); mask: the selection in black and white (white = selected), or with `layer` that layer's mask over its place (white = the layer shows). box [x, y, w, h] in image pixels shows only that region (not with layer), up to 1:1 (max_size caps its long side): judge an inpainted area on a large picture at full resolution. scale: output pixels per image pixel; box: the region read, held to the picture.",
        params: {
            what: P.str("image, editor, layer, base or mask", { enum: SHOT_WHAT, default: "image" }), layer: P.layer("for what = layer; for what = mask the layer whose mask to show (the selection when left out)", { default: undefined }),
            box: { type: "array", items: { type: "number" }, description: "[x, y, w, h]: only this region of the picture, in image pixels (image, editor, base, mask)" },
            max_size: P.int("long side in pixels (64..4096)", { default: 1024 }), quality: P.num("JPEG quality 0.3..0.95", { default: 0.85 }), show_selection: P.bool("tint and outline the selection (image, editor, base)", { default: true }), show_layers: P.bool("outline and label the layers", { default: false }),
        },
        async run(ed, a) {
            const { canvas: c, w, h, s, src, box } = await shotCanvas(ed, a);
            const ctx = c.getContext("2d");
            const ox = box ? box.x : 0, oy = box ? box.y : 0;
            if (a.show_layers && a.what !== "layer" && a.what !== "mask") {
                ctx.strokeStyle = "#7cc7ff"; ctx.lineWidth = 1; ctx.font = "12px sans-serif"; ctx.fillStyle = "#7cc7ff";
                for (const l of ed.layers) { if (l.kind === "filter" || !l.visible) continue; ctx.strokeRect((l.x - ox) * s, (l.y - oy) * s, l.w * s, l.h * s); ctx.fillText(l.name, (l.x - ox) * s + 3, (l.y - oy) * s + 13); }
            }
            const url = c.toDataURL("image/jpeg", Math.min(0.95, Math.max(0.3, +a.quality || 0.85)));
            // with a box the picture's own size, and the region read
            return { width: w, height: h, scale: s, image_width: box ? ed.width : src.w, image_height: box ? ed.height : src.h, ...(box ? { box } : {}), mime: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
        },
    },
};
