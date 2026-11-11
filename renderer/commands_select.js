// the selection commands: moved out of commands.js (item 56 S12, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./editor/host.js";
import { loadImageEl, makeCanvas } from "./editor/inpaint_canvas.js";
import { normalizeLimit } from "./editor/inpaint_weights.js";
import { P, SEL_MODES, bounds, clampInt, findLayer, pointList, selMode, touch, until } from "./commands_util.js";

/** @typedef {import("./commands.js").Command} Command */

/** @satisfies {Record<string, Command>} */
export const SelectCommandsPart = {
    // -- selection --
    select_rect: {
        needsImage: true, description: "Select a rectangle in image pixels.",
        params: { x: P.int("left", { required: true }), y: P.int("top", { required: true }), w: P.int("width (alias width)", { required: true }), h: P.int("height (alias height)", { required: true }), mode: P.selMode() },
        async run(ed, a) {
            const mode = selMode(a.mode);
            const x = +a.x || 0, y = +a.y || 0, w = +a.w || +a.width || 0, h = +a.h || +a.height || 0;
            if (!ed.selectRectangle([x, y, x + w, y + h], mode)) throw new Error(`empty rectangle ${x},${y} ${w}×${h} on a ${ed.width}×${ed.height} image`);
            return { selection: bounds(ed) };
        },
    },
    select_all: { needsImage: true, description: "Select the whole image.", params: {}, async run(ed) { ed.selectRectangle([0, 0, ed.width, ed.height], "replace"); return { selection: bounds(ed) }; } },
    select_none: { needsImage: true, description: "Clear the selection.", params: {}, async run(ed) { ed.clearSelection(); return { selection: bounds(ed) }; } },
    select_invert: { needsImage: true, description: "Invert the selection.", params: {}, async run(ed) { await ed.invertSelection(); return { selection: bounds(ed) }; } },
    select_feather: { needsImage: true, description: "Soften the selection edge by a gaussian blur.", params: { radius: P.num("radius in pixels", { default: 8 }) }, async run(ed, a) { await ed.featherSelection(+a.radius || 8); return { selection: bounds(ed), status: ed.status }; } },
    select_grow: { needsImage: true, description: "Grow (positive) or shrink (negative) the selection.", params: { px: P.int("pixels (alias pixels)", { required: true }) }, async run(ed, a) { const n = Math.round(+(a.px != null ? a.px : a.pixels) || 0); if (n) await ed.growSelection(n); return { selection: bounds(ed) }; } },
    select_from_layer: {
        needsImage: true, description: "Selection from a layer's opaque pixels (its alpha).",
        params: { layer: P.layer() },
        async run(ed, a) { const l = findLayer(ed, a.layer); ed.activeLayerId = l.id; ed.selectionFromLayer(); touch(ed); return { selection: bounds(ed), layer: l.id }; },
    },
    select_mask: {
        needsImage: true, description: "Selection from a mask: an array of width × height values (image size, >0 = selected), or a base64 PNG (white = selected).",
        params: { mask: P.obj("array of width*height values, or a base64 PNG string", { required: true }), mode: P.selMode() },
        async run(ed, a) {
            const mode = selMode(a.mode);
            const W = ed.width, H = ed.height;
            let m;
            if (typeof a.mask === "string") {
                const img = await loadImageEl("data:image/png;base64," + a.mask.replace(/^data:[^,]*,/, ""));
                const c = makeCanvas(W, H);
                const ctx = c.getContext("2d");
                ctx.drawImage(img, 0, 0, W, H);
                const d = ctx.getImageData(0, 0, W, H).data;
                m = new Uint8Array(W * H);
                for (let i = 0, j = 0; i < m.length; i++, j += 4) m[i] = d[j] > 127 && d[j + 3] > 127 ? 1 : 0;
            } else {
                const src = a.mask && a.mask.length != null ? a.mask : null;
                if (!src || src.length !== W * H) throw new Error(`mask must hold ${W * H} values (${W} × ${H})`);
                m = new Uint8Array(W * H);
                for (let i = 0; i < m.length; i++) m[i] = src[i] > 0 ? 1 : 0;
            }
            ed.applyMaskToSelection(m, mode);
            return { selection: bounds(ed) };
        },
    },
    select_by_text: {
        needsImage: true, description: "Select an object by describing it (\"the car\", \"sky\"). Runs the segmentation model on the connected ComfyUI (SAM3); waits for the mask.",
        params: { text: P.str("what to select", { required: true }), mode: P.selMode(), threshold: P.num("0.05..0.95, the model's default when omitted"), timeout: P.timeout(300) },
        async run(ed, a) {
            if (!ed.segInput) throw new Error("the editor has no segmentation controls");
            if (ed.segmentPending) throw new Error("a segmentation is still running");
            const text = String(a.text || "").trim();
            if (!text) throw new Error("text missing, e.g. \"the car\"");
            ed.segInput.value = text;
            ed.segMode = SEL_MODES.includes(a.mode) ? a.mode : "replace";
            if (a.threshold != null && ed.segThreshold) ed.segThreshold.value = Math.min(0.95, Math.max(0.05, +a.threshold || 0.3));
            const before = ed.status;
            await ed.segmentByText();
            if (!ed.segmentPending) throw new Error(ed.status !== before ? ed.status : "segmentation did not start");
            const ok = await until(() => !ed.segmentPending, clampInt(a.timeout, 5, 3600, 300) * 1000);
            if (!ok) throw new Error("segmentation timed out: " + ed.status);
            await until(() => !/^(Segmenting|Asking)/.test(ed.status || ""), 30000);
            if (/failed|could not/i.test(ed.status)) throw new Error(ed.status);
            return { selection: bounds(ed), status: ed.status };
        },
    },
    select_point: {
        needsImage: true, description: "Select what SAM2 (in-app) sees at a point; needs a downloaded SAM2 model (Settings › Helpers). Points: label 1 = inside, 0 = outside.",
        params: { x: P.num("x of the point"), y: P.num("y of the point"), points: P.obj("instead of x/y: [{x, y, label}] with several points"), box: P.obj("optional [x0, y0, x1, y1] box prompt"), mode: P.selMode() },
        async run(ed, a) {
            const mode = selMode(a.mode);
            if (!host.objectsInApp()) throw new Error("no SAM2 model is downloaded (Settings › Helpers)");
            // a run that resizes the document holds it: the mask would land in the old geometry
            if (ed.resizingRun && ed.resizingRun()) throw new Error("A run is still going on this document: wait for it, or Cancel.");
            const pts = Array.isArray(a.points) && a.points.length ? a.points.map((p) => ({ x: +p.x, y: +p.y, label: p.label == null ? 1 : +p.label })) : (a.x != null && a.y != null ? [{ x: +a.x, y: +a.y, label: 1 }] : []);
            const box = Array.isArray(a.box) && a.box.length === 4 ? a.box.map(Number) : null;
            if (!pts.length && !box) throw new Error("pass x and y, or points");
            if (pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("pass x and y, or points");
            const res = await host.segmentLogits(ed, pts, box, null);
            await ed.selectLogits(res, { mode, label: "Object selection", box });
            return { selection: bounds(ed), score: res.score };
        },
    },
    // docs/PLAN_0_1_42.md F2b: the magic wand and the ellipse / polygon / lasso tools without a pointer
    select_color: {
        needsImage: true,
        description: "Magic wand: select the area of similar colour at x, y, as the Magic wand tool (W) does. tolerance: how far each channel may differ (0..255); contiguous: only the area connected to x, y (false: every similar pixel of the picture); sample: image (the visible picture) or layer (one layer's own pixels; that layer becomes the active one). Runs in the app, no model or server needed: flat backgrounds, skies, studio walls. One undo step.",
        params: {
            x: P.num("x in image pixels", { required: true }), y: P.num("y in image pixels", { required: true }),
            tolerance: P.int("0..255 per channel", { default: 32 }),
            contiguous: P.bool("only the area connected to x, y", { default: true }),
            sample: P.str("image or layer", { enum: ["image", "layer"], default: "image" }),
            layer: P.layer("with sample layer: the layer whose pixels are read"),
            mode: P.selMode(),
        },
        async run(ed, a) {
            const x = +a.x, y = +a.y;
            if (a.x == null || a.y == null || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("pass x and y in image pixels");
            if (x < 0 || y < 0 || x >= ed.width || y >= ed.height) throw new Error(`${x}, ${y} is outside the ${ed.width} × ${ed.height} picture`);
            const mode = selMode(a.mode);
            const tol = a.tolerance == null || a.tolerance === "" ? 32 : +a.tolerance;
            if (!Number.isFinite(tol) || tol < 0 || tol > 255) throw new Error(`tolerance must be 0..255, not ${JSON.stringify(a.tolerance)}`);
            const contiguous = a.contiguous == null ? true : a.contiguous === true || a.contiguous === "true" ? true : a.contiguous === false || a.contiguous === "false" ? false : null;
            if (contiguous == null) throw new Error(`contiguous takes true or false, not ${JSON.stringify(a.contiguous)}`);
            const sample = a.sample == null || a.sample === "" ? "image" : String(a.sample);
            if (sample !== "image" && sample !== "layer") throw new Error(`sample must be image or layer, not ${JSON.stringify(a.sample)}`);
            let layer = null;
            if (sample === "layer") {
                layer = findLayer(ed, a.layer);
                if (layer.kind === "filter") throw new Error(`${layer.name} is a filter layer: it has no pixels of its own (sample image reads what it does to the picture)`);
            } else if (a.layer != null && a.layer !== "" && a.layer !== "active") throw new Error("layer goes with sample layer; sample image reads the visible picture");
            // the wand reads the active layer for sample layer while it floods, so that layer stays active (select_from_layer
            // does the same); the options are the tool's own for the call only: wandSelect takes them before its first await
            if (layer && ed.activeLayerId !== layer.id) { ed.activeLayerId = layer.id; ed.renderLayers(); }
            const keep = ed.fillOpts;
            let job;
            try { ed.fillOpts = { ...(keep || {}), tolerance: Math.round(tol), contiguous, sample }; job = ed.wandSelect(x, y, mode); } finally { ed.fillOpts = keep; }
            await job;
            return { selection: bounds(ed), status: ed.status, layer: layer ? layer.id : undefined };
        },
    },
    select_shape: {
        needsImage: true,
        description: "Select an ellipse (x, y, w, h: its bounding box) or a polygon / lasso (points: three or more [x, y] in image pixels, closed from the last back to the first), as the Ellipse, Polygon and Lasso tools do, with replace, add or subtract. feather softens the new shape's edge by a gaussian blur of that radius (the rest of the selection keeps its own edge). Saves sending a whole mask through select_mask. One undo step.",
        params: {
            shape: P.str("ellipse, or polygon / lasso (the same: a closed outline through the points)", { required: true, enum: ["ellipse", "polygon", "lasso"] }),
            x: P.num("ellipse: left of its box"), y: P.num("ellipse: top of its box"), w: P.num("ellipse: width (alias width)"), h: P.num("ellipse: height (alias height)"),
            points: P.obj("polygon / lasso: [[x, y], ...], at least three"),
            feather: P.num("radius of the soft edge in pixels, 0..512", { default: 0 }),
            mode: P.selMode(),
        },
        async run(ed, a) {
            const shape = String(a.shape || "");
            const mode = selMode(a.mode);
            const feather = a.feather == null || a.feather === "" ? 0 : +a.feather;
            if (!Number.isFinite(feather) || feather < 0 || feather > 512) throw new Error(`feather must be 0..512 pixels, not ${JSON.stringify(a.feather)}`);
            const W = ed.width, H = ed.height;
            let path, box, label;
            if (shape === "ellipse") {
                const x = +a.x, y = +a.y, w = +(a.w != null ? a.w : a.width), h = +(a.h != null ? a.h : a.height);
                if (a.x == null || a.y == null || ![x, y, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) throw new Error("an ellipse needs x, y, w and h (its bounding box; w and h above 0)");
                box = [x, y, x + w, y + h]; label = "Ellipse selection";
                path = (ctx) => { ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); };
            } else if (shape === "polygon" || shape === "lasso") {
                const pts = pointList(a.points, "points");
                if (pts.length < 3) throw new Error(`a ${shape} needs at least three points`);
                if (pts.length > 100000) throw new Error(`a ${shape} takes at most 100,000 points`);
                box = [Infinity, Infinity, -Infinity, -Infinity];
                for (const [px, py] of pts) { box[0] = Math.min(box[0], px); box[1] = Math.min(box[1], py); box[2] = Math.max(box[2], px); box[3] = Math.max(box[3], py); }
                label = shape === "lasso" ? "Lasso selection" : "Polygon selection";
                path = (ctx) => { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); };
            } else throw new Error(`shape must be ellipse, polygon or lasso, not ${JSON.stringify(a.shape)}`);
            // drawn into a canvas of the shape's box on the picture (with room for the blur), never one of the picture's size
            const reach = feather > 0 ? Math.ceil(feather * 3) + 2 : 0;
            const X0 = Math.max(0, Math.floor(box[0] - reach)), Y0 = Math.max(0, Math.floor(box[1] - reach));
            const X1 = Math.min(W, Math.ceil(box[2] + reach)), Y1 = Math.min(H, Math.ceil(box[3] + reach));
            if (X1 <= X0 || Y1 <= Y0) throw new Error(`the ${shape} lies outside the ${W} × ${H} picture`);
            const c = makeCanvas(X1 - X0, Y1 - Y0);
            const ctx = c.getContext("2d");
            if (feather > 0) ctx.filter = `blur(${feather}px)`;
            ctx.translate(-X0, -Y0);
            ctx.fillStyle = "#ff0000";
            path(ctx);
            ctx.fill();
            // the ellipse's own box is its extent (as the tool's drag gives it); a polygon's and a soft edge's are scanned
            ed.applyShapeToSelection(c, mode, shape === "ellipse" && !feather ? box : null, [X0, Y0], label);
            const sel = bounds(ed);
            ed.setStatus(`${label.replace(/ selection$/, "")} ${mode === "replace" ? "selected" : mode === "add" ? "added" : "subtracted"}${feather ? `, its edge feathered by ${feather} px` : ""}.`);
            return { selection: sel };
        },
    },
    select_range: {
        needsImage: true,
        description: "Select by depth (0 near .. 1 far; needs depth_map), luminosity (0 black .. 1 white) or colour similarity (1 = the colour): between lo and hi, softened over fLo below and fHi above.",
        params: {
            source: P.enum("depth, luma or color", ["depth", "luma", "color"], "depth"),
            lo: P.num("0..1", { required: true }),
            hi: P.num("0..1", { required: true }),
            fLo: P.num("feather below lo, 0..1", { default: 0 }),
            fHi: P.num("feather above hi, 0..1", { default: 0 }),
            invert: P.bool("select outside the range", { default: false }),
            color: P.str("#rrggbb, for source color"),
            tol: P.num("0..100, colour tolerance", { default: 30 }),
            mode: P.selMode(),
        },
        async run(ed, a) {
            const mode = selMode(a.mode);
            const source = a.source == null ? "depth" : String(a.source);
            if (!["depth", "luma", "color"].includes(source)) {
                throw new Error(`source must be one of depth, luma, color (got ${JSON.stringify(a.source)})`);
            }
            const limit = normalizeLimit({
                source,
                lo: a.lo,
                hi: a.hi,
                fLo: a.fLo,
                fHi: a.fHi,
                invert: a.invert,
                color: a.color,
                tol: a.tol,
            });
            const res = await ed.selectRange(limit, mode);
            return { selection: bounds(ed), seconds: res ? res.seconds : 0, status: ed.status };
        },
    },
};
