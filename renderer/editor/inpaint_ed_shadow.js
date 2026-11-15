// *Layer › Add Contact Shadow* (item 61, docs/PLAN_0_1_57.md): a plain pixel layer in multiply directly under a layer
// with transparency (a cut-out, a key, a pasted picture), its shadow from the layer's coverage (`inpaint_shadow.js`).
// The work runs on a coverage grid of the object's own box at a working scale (never a document-size canvas), and the
// layer that lands is the shadow's trimmed box at the picture's resolution.

import { contactShadow, shadowAt, shadowParams, SHADOW_DEFAULTS, SHADOW_WORK, SHADOW_WORK_PREVIEW } from "./inpaint_shadow.js";
import { makeCanvas } from "./inpaint_consts.js";
import { sampleMap } from "./inpaint_maps.js";

/** The coarse pass that finds the object inside its layer (a cut-out often spans the whole picture). */
const FIND_WORK = 512;
/** Above this many pixels the shadow layer keeps a lower resolution of its own (drawn scaled, as a result layer is). */
const FULL_CAP = 100e6;
/** Rows of the full-size layer written at a time. */
const BAND = 256;

export class ShadowPart {
    /** `layer` as the stack holds it now: an undo puts copies of the layers back, so a caller's object may be stale. */
    liveShadowLayer(layer) {
        return (layer && this.layers.find((l) => l.id === layer.id)) || layer;
    }

    /** Why `layer` can have no contact shadow (a sentence for the status line), or null when it can. */
    shadowRefusal(layer) {
        if (!this.width) return "Load an image first.";
        if (!layer || !layer.px || layer.kind === "filter") return "Select a layer with transparency (a cut-out, a key, a pasted picture) to give it a contact shadow.";
        if (this.isReference(layer) || this.isControl(layer)) return `${layer.name} is not part of the picture: it casts no shadow.`;
        if (this.isLocked(layer) && !layer.locked) return `${layer.name} is in a locked group: unlock the group first.`;
        if (this.pending && this.pending.layer === layer) return `Apply or cancel the transform of ${layer.name} first.`;
        return null;
    }

    /** `layer`'s coverage (its alpha with a live mask) over the image region `r` [x0, y0, x1, y1] at about `work` px. */
    shadowCoverage(layer, r, work) {
        const rw = r[2] - r[0], rh = r[3] - r[1];
        const s = Math.min(1, work / Math.max(rw, rh));
        const tw = Math.max(1, Math.round(rw * s)), th = Math.max(1, Math.round(rh * s));
        const sx = tw / rw, sy = th / rh;
        const c = makeCanvas(tw, th), ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        const dx = (layer.x - r[0]) * sx, dy = (layer.y - r[1]) * sy, dw = layer.w * sx, dh = layer.h * sy;
        layer.px.drawTo(ctx, dx, dy, dw, dh);
        const mask = this.liveMask(layer);
        if (mask) { ctx.globalCompositeOperation = "destination-in"; mask.drawTo(ctx, dx, dy, dw, dh); ctx.globalCompositeOperation = "source-over"; }
        const d = ctx.getImageData(0, 0, tw, th).data;
        const alpha = new Float32Array(tw * th);
        for (let i = 0; i < alpha.length; i++) alpha[i] = d[4 * i + 3] / 255;
        return { alpha, w: tw, h: th, x0: r[0], y0: r[1], sx, sy };
    }

    /**
     * The object of `layer` as a coverage grid at about `work` px on its long side: a coarse pass finds the object's
     * box inside the layer, the second draws that box alone. Null when the layer has nothing opaque in the picture.
     */
    shadowSource(layer, work = SHADOW_WORK) {
        const lb = [Math.max(0, Math.floor(layer.x)), Math.max(0, Math.floor(layer.y)), Math.min(this.width, Math.ceil(layer.x + layer.w)), Math.min(this.height, Math.ceil(layer.y + layer.h))];
        if (lb[2] - lb[0] < 1 || lb[3] - lb[1] < 1) return null;
        const coarse = this.shadowCoverage(layer, lb, FIND_WORK);
        let x0 = coarse.w, y0 = coarse.h, x1 = -1, y1 = -1;
        for (let y = 0; y < coarse.h; y++) for (let x = 0; x < coarse.w; x++) {
            if (coarse.alpha[y * coarse.w + x] < 0.02) continue;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        if (x1 < 0) return null;
        // a cell and a half of the coarse grid around it: its smoothing reaches that far
        const ob = [
            Math.max(lb[0], Math.floor(lb[0] + (x0 - 1.5) / coarse.sx)), Math.max(lb[1], Math.floor(lb[1] + (y0 - 1.5) / coarse.sy)),
            Math.min(lb[2], Math.ceil(lb[0] + (x1 + 2.5) / coarse.sx)), Math.min(lb[3], Math.ceil(lb[1] + (y1 + 2.5) / coarse.sy)),
        ];
        return this.shadowCoverage(layer, ob, work);
    }

    /** The shadow grid of a source (`shadowSource`) for the parameters; the depth map fades it where there is one. */
    shadowGrid(src, params) {
        const depth = this.maps && this.maps.depth && this.maps.depth.data ? this.maps.depth : null;
        const depthAt = depth ? (gx, gy) => sampleMap(depth, src.x0 + (gx + 0.5) / src.sx, src.y0 + (gy + 0.5) / src.sy) : null;
        return contactShadow({ alpha: src.alpha, w: src.w, h: src.h, params, depthAt });
    }

    /**
     * The shadow as layer pixels and their place: `{ px, x, y, w, h }`, null when nothing of it falls in the picture.
     * `preview`: the grid's own cells (fast, drawn scaled); else the picture's resolution (up to FULL_CAP pixels), black
     * with the shadow as its alpha.
     */
    shadowLayerData(src, grid, { preview = false } = {}) {
        if (!grid || !grid.trim) return null;
        const [tx0, ty0, tx1, ty1] = grid.trim;
        // the trimmed cells in image coordinates
        let X0 = src.x0 + (grid.x + tx0) / src.sx, Y0 = src.y0 + (grid.y + ty0) / src.sy;
        let X1 = src.x0 + (grid.x + tx1) / src.sx, Y1 = src.y0 + (grid.y + ty1) / src.sy;
        if (preview) {
            const cx0 = Math.max(tx0, Math.ceil((0 - src.x0) * src.sx - grid.x)), cy0 = Math.max(ty0, Math.ceil((0 - src.y0) * src.sy - grid.y));
            const cx1 = Math.min(tx1, Math.floor((this.width - src.x0) * src.sx - grid.x)), cy1 = Math.min(ty1, Math.floor((this.height - src.y0) * src.sy - grid.y));
            if (cx1 <= cx0 || cy1 <= cy0) return null;
            const pw = cx1 - cx0, ph = cy1 - cy0;
            const data = new Uint8ClampedArray(pw * ph * 4);
            for (let v = 0; v < ph; v++) for (let u = 0; u < pw; u++) data[(v * pw + u) * 4 + 3] = Math.round(grid.data[(cy0 + v) * grid.w + cx0 + u] * 255);
            const px = this.pixels.Layer.fromImageData({ data, width: pw, height: ph });
            return { px, x: src.x0 + (grid.x + cx0) / src.sx, y: src.y0 + (grid.y + cy0) / src.sy, w: pw / src.sx, h: ph / src.sy };
        }
        X0 = Math.max(0, Math.floor(X0)); Y0 = Math.max(0, Math.floor(Y0));
        X1 = Math.min(this.width, Math.ceil(X1)); Y1 = Math.min(this.height, Math.ceil(Y1));
        const W = X1 - X0, H = Y1 - Y0;
        if (W < 1 || H < 1) return null;
        const f = Math.min(1, Math.sqrt(FULL_CAP / (W * H)));
        const pw = Math.max(1, Math.round(W * f)), ph = Math.max(1, Math.round(H * f));
        const fx = W / pw, fy = H / ph;
        const px = this.pixels.Layer.empty(pw, ph);
        for (let b0 = 0; b0 < ph; b0 += BAND) {
            const bh = Math.min(BAND, ph - b0);
            const data = new Uint8ClampedArray(pw * bh * 4);
            let any = false;
            for (let j = 0; j < bh; j++) {
                const Y = Y0 + (b0 + j + 0.5) * fy;
                const v = (Y - src.y0) * src.sy - 0.5 - grid.y;
                const row = j * pw * 4;
                for (let i = 0; i < pw; i++) {
                    const X = X0 + (i + 0.5) * fx;
                    const a = shadowAt(grid, (X - src.x0) * src.sx - 0.5 - grid.x, v);
                    if (a > 0) { const q = Math.round(a * 255); if (q) { data[row + i * 4 + 3] = q; any = true; } }
                }
            }
            // an empty layer keeps no tiles where nothing was written
            if (any) px.writeRect({ data, width: pw, height: bh }, 0, b0, "copy");
        }
        return { px, x: X0, y: Y0, w: W, h: H };
    }

    /** Put a new shadow layer into the stack directly under `layer` (under its clipping base when it is clipped). */
    placeShadowLayer(layer, data, { name, opacity, quiet = false } = {}) {
        const out = this.addLayer({ name, kind: "paint", ref: null, px: data.px, x: data.x, y: data.y, w: data.w, h: data.h, dirty: true, blend: "multiply", opacity }, { activate: false, quiet: true });
        const base = layer.clip ? this.clipBaseOf(layer) || layer : layer;
        const now = this.layers.indexOf(out), at = this.layers.indexOf(base);
        if (at >= 0 && now > at) { this.layers.splice(now, 1); this.layers.splice(at, 0, out); }
        if (base.group) out.group = base.group;
        if (!quiet) this.layersRestacked();
        return out;
    }

    /**
     * The contact shadow of `layer` as a new layer under it (multiply, `opacity` as the layer's), one undo step
     * ("layers"). `params`: distance, softness, opacity, skew (`shadowParams`). The new layer, or null with the status
     * line saying why.
     */
    addContactShadow(layer, params = {}) {
        layer = this.liveShadowLayer(layer);
        const why = this.shadowRefusal(layer);
        if (why) { this.setStatus(why, "info"); return null; }
        const p = shadowParams(params);
        const t0 = performance.now();
        const src = this.shadowSource(layer, SHADOW_WORK);
        const grid = src && this.shadowGrid(src, p);
        if (!grid) { this.setStatus(`${layer.name} has no opaque part in the picture: it casts no shadow.`, "info"); return null; }
        const data = this.shadowLayerData(src, grid);
        if (!data) { this.setStatus(`The shadow of ${layer.name} falls outside the picture.`, "info"); return null; }
        this.pushUndo({ kind: "layers", label: "Contact shadow" });
        const out = this.placeShadowLayer(layer, data, { name: `${layer.name} shadow`, opacity: p.opacity });
        this.markLayerChanged(out);
        this.renderLayers();
        this.draw();
        const ms = Math.round(performance.now() - t0);
        this._shadowMs = ms;
        const depth = grid.footDepth != null ? ", faded by the depth map where the ground lies farther" : "";
        this.setStatus(`${out.name} added under ${layer.name} (multiply, ${Math.round(p.opacity * 100)} %${depth}) in ${ms} ms. Paint or erase on it as on any layer; Ctrl+Z takes it back.`);
        return out;
    }

    /**
     * The dialog: distance, softness, opacity and skew with the shadow shown live under the layer while it is open (a
     * preview layer at the working grid's resolution, no undo step). Apply makes the layer at the picture's resolution
     * as one undo step; Cancel leaves nothing. Resolves with the new layer or null.
     */
    async contactShadowDialog(layer = this.activeLayer()) {
        layer = this.liveShadowLayer(layer);
        const why = this.shadowRefusal(layer);
        if (why) { this.setStatus(why, "info"); return null; }
        const src = this.shadowSource(layer, SHADOW_WORK_PREVIEW);
        if (!src) { this.setStatus(`${layer.name} has no opaque part in the picture: it casts no shadow.`, "info"); return null; }
        const last = { ...SHADOW_DEFAULTS, ...(this._shadowLast || {}) };
        const pct = (v) => Math.round(v * 100);
        const prev = { layer: null, timer: 0 };
        const valuesOf = (v) => shadowParams({ distance: v.distance, softness: v.softness, opacity: v.opacity / 100, skew: v.skew });
        const show = (v) => {
            const p = valuesOf(v);
            const data = this.shadowLayerData(src, this.shadowGrid(src, p), { preview: true });
            if (!data) { if (prev.layer) { prev.layer.visible = false; this.draw(); } return; }
            // by its id: an undo from the native menu meanwhile puts copies of the layers back
            const cur = prev.layer && this.layers.find((l) => l.id === prev.layer.id);
            if (!cur) {
                prev.layer = this.placeShadowLayer(this.liveShadowLayer(layer), data, { name: `${layer.name} shadow (preview)`, opacity: p.opacity });
                prev.layer._shadowPreview = true;
            } else {
                prev.layer = cur;
                Object.assign(cur, { px: this.ownPixels(data.px), x: data.x, y: data.y, w: data.w, h: data.h, opacity: p.opacity, visible: true, _shadowPreview: true });
                this.markLayerChanged(cur);
            }
            this.draw();
        };
        const drop = () => {
            clearTimeout(prev.timer);
            if (!prev.layer) return;
            const was = prev.layer;
            prev.layer = null;
            // by its id: a step taken meanwhile (an agent's command) may hold a copy of it, which an undo puts back
            if (!this.layers.some((l) => l.id === was.id)) return;
            this.layers = this.layers.filter((l) => l.id !== was.id);
            this.layersRestacked();
        };
        show({ distance: last.distance, softness: last.softness, opacity: pct(last.opacity), skew: last.skew });
        const asked = this.ask({
            title: `Contact shadow for ${layer.name}`,
            message: "A soft shadow from the layer's shape, darkest where it meets the ground, as a multiply layer of its own under it. Distance and softness are % of the layer's height; direction shifts the far end sideways." + (this.maps && this.maps.depth && this.maps.depth.data ? " The depth map fades it where the ground lies farther than the layer's foot." : ""),
            fields: [
                { key: "distance", label: "Distance (%)", value: last.distance, min: 1, max: 300 },
                { key: "softness", label: "Softness (%)", value: last.softness, min: 0, max: 100 },
                { key: "opacity", label: "Opacity (%)", value: pct(last.opacity), min: 0, max: 100 },
                { key: "skew", label: "Direction (%)", value: last.skew, min: -100, max: 100 },
            ],
            ok: "Apply",
            onChange: (key, values) => {
                clearTimeout(prev.timer);
                // the opacity is the layer's: no new shadow for it
                if (key === "opacity" && prev.layer) { prev.layer.opacity = valuesOf(values).opacity; this.uploaded.baseHash = null; this.draw(); return; }
                prev.timer = setTimeout(() => { try { show(values); } catch (err) { console.error(err); } }, 40);
            },
        });
        // the preview stays visible: a clear backdrop, the box in the top right corner (a shadow lies low), a slider
        // under each number box
        const wrap = this.askOpen;
        if (wrap) {
            wrap.style.background = "transparent";
            wrap.style.alignItems = "flex-start";
            wrap.style.justifyContent = "flex-end";
            wrap.style.padding = "16px";
            for (const inp of wrap.querySelectorAll(".ipc-askfields input[type=number]")) {
                const range = document.createElement("input");
                range.type = "range"; range.min = inp.min; range.max = inp.max; range.step = "1"; range.value = inp.value;
                range.addEventListener("input", () => { inp.value = range.value; inp.dispatchEvent(new Event("input")); });
                inp.addEventListener("input", () => { if (range.value !== inp.value) range.value = inp.value; });
                inp.parentNode.appendChild(range);
            }
        }
        const v = await asked;
        drop();
        if (!v || typeof v !== "object") { this.setStatus("Contact shadow cancelled.", "info"); return null; }
        const p = valuesOf(v);
        this._shadowLast = p;
        const now = this.layers.find((l) => l.id === layer.id);
        if (!now) { this.setStatus("The layer went away meanwhile: no shadow made.", "info"); return null; }
        return this.addContactShadow(now, p);
    }
}
