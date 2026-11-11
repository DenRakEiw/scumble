// @ts-check
// the export state, pixels, size row, canvas and quality: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import { refusal } from "./inpaint_status.js";
import { canvasSizeRefusal } from "./inpaint_sizelimit.js";
import { ENCODER_MAX_SIDE, EXPORT_PERCENTS, MAX_EXPORT_SIDE, capExportSide } from "./host_util.js";

export const HostExportPart = {
    // ---- export size ---------------------------------------------------------------------
    //
    // The editor's Export section saves the flattened image at its own resolution. The app
    // adds a size to it: a percentage or a free width and height, plus the encoder quality
    // for JPEG / WebP. `exportCanvas` and `exportQuality` are what the patched exportImage()
    // asks. PSD and ORA always go out at full size, because every
    // layer would have to be scaled on its own.

    /** The per-document export settings, made on first use. */
    exportState(editor) {
        // metadata: null = the app's switch (embedRecipe), true / false = this export's own answer (the export command)
        if (!editor._export) editor._export = { percent: 100, width: 0, height: 0, quality: 0.92, canvasW: 0, canvasH: 0, anchor: "mc", fill: "transparent", metadata: null };
        return editor._export;
    },

    /** The pixel size an export would have, [w, h], or null when it is the document's own. */
    exportPixels(editor) {
        const e = this.exportState(editor);
        const dw = editor.width | 0, dh = editor.height | 0;
        if (!dw || !dh) return null;
        let w, h;
        if (e.width > 0 && e.height > 0) { w = e.width; h = e.height; }
        else { w = Math.round(dw * e.percent / 100); h = Math.round(dh * e.percent / 100); }
        // a percentage past the cap keeps the picture's aspect (0.1.50 Q3); a typed size was capped when it was set
        [w, h] = capExportSide(Math.max(1, w), Math.max(1, h));
        return w === dw && h === dh ? null : [w, h];
    },

    /**
     * Down to half the size in one draw is what the browser's high-quality filter does well;
     * below that it starts skipping pixels instead of averaging them, so a big reduction is
     * walked down in halving steps. An enlargement is one draw.
     */
    resizeForExport(src, w, h) {
        let cur = src;
        while (cur.width >= w * 2 && cur.height >= h * 2 && cur.width > 1 && cur.height > 1) {
            const next = document.createElement("canvas");
            next.width = Math.max(w, Math.floor(cur.width / 2));
            next.height = Math.max(h, Math.floor(cur.height / 2));
            const c = next.getContext("2d");
            c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
            c.drawImage(cur, 0, 0, next.width, next.height);
            cur = next;
        }
        const out = document.createElement("canvas");
        out.width = w; out.height = h;
        const ctx = out.getContext("2d");
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        ctx.drawImage(cur, 0, 0, w, h);
        return out;
    },

    /** The export's canvas (the frame around the scaled picture), [w, h], or null when it is the picture's own size. */
    exportFrame(editor) {
        const e = this.exportState(editor);
        if (!(e.canvasW > 0) || !(e.canvasH > 0)) return null;
        const px = this.exportPixels(editor) || [editor.width | 0, editor.height | 0];
        const w = Math.max(1, Math.min(MAX_EXPORT_SIDE, Math.round(e.canvasW))), h = Math.max(1, Math.min(MAX_EXPORT_SIDE, Math.round(e.canvasH)));
        return w === px[0] && h === px[1] ? null : [w, h];
    },

    /** The picture placed in a bigger (or smaller: cropped) frame by the anchor, over the fill. */
    frameForExport(src, w, h, anchor, fill) {
        const out = document.createElement("canvas");
        out.width = w; out.height = h;
        const ctx = out.getContext("2d");
        if (fill && fill !== "transparent") { ctx.fillStyle = fill === "black" ? "#000000" : fill === "white" ? "#ffffff" : String(fill); ctx.fillRect(0, 0, w, h); }
        const a = String(anchor || "mc");
        const row = a[0], col = a[1];
        const x = col === "l" ? 0 : col === "r" ? w - src.width : Math.round((w - src.width) / 2);
        const y = row === "t" ? 0 : row === "b" ? h - src.height : Math.round((h - src.height) / 2);
        ctx.drawImage(src, x, y);
        return out;
    },

    /** Is the export the picture as it is (no Size row, no frame)? Then a PNG is written in bands, without a canvas (E2). */
    exportIsPlain(editor) {
        return !this.exportPixels(editor) && !this.exportFrame(editor);
    },

    /**
     * "" when the export canvas of `fmt` can be made and written, else the refusal (0.1.50 Q3, docs/BUGS.md "Size
     * limits"): a Size or Canvas row past one canvas (Chromium makes such a canvas without complaint, draws nothing into
     * it and writes no file, or an empty one), and a WebP past 16,383 px a side (written cut to that side,
     * ENCODER_MAX_SIDE). PSD and ORA keep the document's own size.
     */
    exportSizeRefusal(editor, fmt) {
        if (fmt === "psd" || fmt === "ora") return "";
        const size = this.exportPixels(editor), frame = this.exportFrame(editor);
        const smaller = " Make the Size or the Canvas row in the Export section smaller (the export command's scale, width or canvas_width).";
        const over = (size && canvasSizeRefusal(size[0], size[1], "The export")) || (frame && canvasSizeRefusal(frame[0], frame[1], "The export's canvas"));
        if (over) return over + smaller;
        const [w, h] = frame || size || [editor.width | 0, editor.height | 0];
        const cap = ENCODER_MAX_SIDE[fmt];
        if (cap && Math.max(w, h) > cap.side) {
            return `The export would be ${w.toLocaleString("en-US")} × ${h.toLocaleString("en-US")} px, and ${cap.name} holds at most ${cap.side.toLocaleString("en-US")} px a side: save it as PNG, JPEG or TIFF, or make the Size or the Canvas row smaller.`;
        }
        return "";
    },

    /** What exportImage() encodes: the flattened image, scaled when the Size row asks for it, framed when the Canvas row does. */
    async exportCanvas(editor, fmt) {
        // refused before anything is flattened or drawn (0.1.50 Q3): red, a limit
        const refused = this.exportSizeRefusal(editor, fmt);
        if (refused) throw refusal(refused, "warn");
        if (editor.relightSettled) await editor.relightSettled();
        let canvas = editor.flattenToCanvas({ forRun: true });
        if (fmt === "psd" || fmt === "ora") return canvas;
        const size = this.exportPixels(editor);
        if (size) canvas = this.resizeForExport(canvas, size[0], size[1]);
        const frame = this.exportFrame(editor);
        if (frame) { const e = this.exportState(editor); canvas = this.frameForExport(canvas, frame[0], frame[1], e.anchor, e.fill); }
        return canvas;
    },

    /** The JPEG / WebP quality exportImage() encodes with (PNG ignores it). */
    exportQuality(editor) {
        const q = +this.exportState(editor).quality;
        return Number.isFinite(q) ? Math.min(1, Math.max(0.1, q)) : 0.92;
    },

    /**
     * Set the export size from the row, a command or a script. A width or a height alone
     * keeps the aspect ratio; `percent` clears a free size again.
     */
    /**
     * @param {any} editor
     * @param {{ percent?: number, width?: number, height?: number, quality?: number, canvasWidth?: number, canvasHeight?: number, anchor?: string, fill?: string }} [size]
     */
    setExportSize(editor, { percent, width, height, quality, canvasWidth, canvasHeight, anchor, fill } = {}) {
        const e = this.exportState(editor);
        // a typed side past MAX_EXPORT_SIDE: what it became, for the status line (it was clamped without a word)
        /** @type {string[]} */
        const capNotes = [];
        const fmtSize = (w, h) => `${Math.round(w).toLocaleString("en-US")} × ${Math.round(h).toLocaleString("en-US")}`;
        if (quality != null) e.quality = Math.min(1, Math.max(0.1, +quality || 0.92));
        if (canvasWidth != null || canvasHeight != null) {
            // one of them alone keeps the frame's aspect from the picture; 0 / empty clears the frame
            const px = this.exportPixels(editor) || [editor.width | 0, editor.height | 0];
            let cw = Math.round(+canvasWidth || 0), ch = Math.round(+canvasHeight || 0);
            if (cw > 0 && !ch && canvasHeight == null && px[0]) ch = Math.max(1, Math.round(cw * px[1] / px[0]));
            if (ch > 0 && !cw && canvasWidth == null && px[1]) cw = Math.max(1, Math.round(ch * px[0] / px[1]));
            if (cw > 0 && !ch) ch = e.canvasH || px[1];
            if (ch > 0 && !cw) cw = e.canvasW || px[0];
            // past the cap: both sides down, the aspect kept, and the status line says so (0.1.50 Q3)
            if (cw > 0 && ch > 0) {
                const [fw, fh, capped] = capExportSide(cw, ch);
                if (capped) capNotes.push(`the canvas ${fmtSize(cw, ch)} became ${fmtSize(fw, fh)}`);
                cw = fw; ch = fh;
            }
            e.canvasW = Math.max(0, Math.min(MAX_EXPORT_SIDE, cw));
            e.canvasH = Math.max(0, Math.min(MAX_EXPORT_SIDE, ch));
            if (!e.canvasW || !e.canvasH) { e.canvasW = 0; e.canvasH = 0; }
        }
        if (anchor != null && /^[tmb][lcr]$/.test(String(anchor))) e.anchor = String(anchor);
        if (fill != null) e.fill = ["transparent", "white", "black"].includes(String(fill)) ? String(fill) : (/^#[0-9a-f]{6}$/i.test(String(fill)) ? String(fill) : e.fill);
        if (width != null || height != null) {
            const dw = editor.width | 0, dh = editor.height | 0;
            let w = Math.round(+width || 0), h = Math.round(+height || 0);
            if (w > 0 && !h && dw) h = Math.max(1, Math.round(w * dh / dw));
            if (h > 0 && !w && dh) w = Math.max(1, Math.round(h * dw / dh));
            if (w > 0 && h > 0) {
                const [sw, sh, capped] = capExportSide(w, h);
                if (capped) capNotes.push(`the size ${fmtSize(w, h)} became ${fmtSize(sw, sh)}`);
                w = sw; h = sh;
            }
            e.width = Math.max(0, Math.min(MAX_EXPORT_SIDE, w));
            e.height = Math.max(0, Math.min(MAX_EXPORT_SIDE, h));
            if (e.width && dw) e.percent = Math.round(e.width / dw * 1000) / 10;
        } else if (percent != null) {
            e.percent = Math.min(400, Math.max(1, +percent || 100));
            e.width = 0; e.height = 0;
        }
        this.syncExportRow(editor);
        if (capNotes.length && editor.setStatus) editor.setStatus(`An export goes up to ${MAX_EXPORT_SIDE.toLocaleString("en-US")} px a side: ${capNotes.join(", ")} (the aspect kept).`, "warn");
        return e;
    },

    /** The Size row the app appends under the editor's Export row. */
    buildExportSize(editor) {
        const anchor = editor.saveFormatSel && editor.saveFormatSel.parentElement;
        if (!anchor) return;
        const row = document.createElement("div");
        row.className = "ipc-seg scumble-export-size";
        const lab = document.createElement("span");
        lab.textContent = "Size";
        lab.title = "How big the saved file is. PSD and ORA always keep the full size.";
        row.appendChild(lab);

        const sel = document.createElement("select");
        sel.className = "ipc-sel";
        sel.style.maxWidth = "72px";
        for (const p of EXPORT_PERCENTS) {
            const o = document.createElement("option");
            o.value = String(p); o.textContent = p + " %";
            sel.appendChild(o);
        }
        const custom = document.createElement("option");
        custom.value = "custom"; custom.textContent = "custom";
        sel.appendChild(custom);
        sel.title = "A percentage of the document size; typing a width or a height switches to custom.";
        sel.addEventListener("keydown", (ev) => ev.stopPropagation());
        sel.addEventListener("change", () => {
            if (sel.value === "custom") {
                const px = this.exportPixels(editor) || [editor.width, editor.height];
                this.setExportSize(editor, { width: px[0], height: px[1] });
            } else {
                this.setExportSize(editor, { percent: +sel.value });
            }
        });
        row.appendChild(sel);

        const num = (title) => {
            const i = document.createElement("input");
            i.type = "number"; i.className = "ipc-num"; i.style.width = "58px"; i.style.minWidth = "0";
            i.min = "1"; i.max = String(MAX_EXPORT_SIDE); i.step = "1"; i.title = title;
            i.addEventListener("keydown", (ev) => ev.stopPropagation());
            return i;
        };
        const wIn = num("Width in pixels; the height follows the aspect ratio");
        const hIn = num("Height in pixels; the width follows the aspect ratio");
        wIn.addEventListener("change", () => this.setExportSize(editor, { width: +wIn.value, height: 0 }));
        hIn.addEventListener("change", () => this.setExportSize(editor, { width: 0, height: +hIn.value }));
        row.appendChild(wIn);
        const times = document.createElement("span");
        times.textContent = "×";
        row.appendChild(times);
        row.appendChild(hIn);

        // the quality gets its own line: the panel is too narrow for five controls, and it
        // only concerns JPEG and WebP anyway
        const qRow = document.createElement("div");
        qRow.className = "ipc-seg scumble-export-quality";
        const qLab = document.createElement("span");
        qLab.textContent = "Quality";
        qLab.title = "JPEG / WebP quality, 1 is the best";
        const q = document.createElement("input");
        q.type = "number"; q.className = "ipc-num"; q.style.width = "60px";
        q.min = "0.1"; q.max = "1"; q.step = "0.02"; q.title = qLab.title;
        q.addEventListener("keydown", (ev) => ev.stopPropagation());
        q.addEventListener("change", () => this.setExportSize(editor, { quality: +q.value }));
        qRow.appendChild(qLab);
        qRow.appendChild(q);

        // 3f: the prompt, seed and recipe in a PNG's text chunks; on unless the user turns it off (the user's default since
        // 0.1.32): anyone the file reaches can read them (an imported recipe carries every widget value of its workflow)
        const mRow = document.createElement("div");
        mRow.className = "ipc-seg scumble-export-metadata";
        const mLab = document.createElement("label");
        mLab.style.display = "flex"; mLab.style.alignItems = "center"; mLab.style.gap = "6px"; mLab.style.cursor = "pointer";
        mLab.title = "Write the prompt, the negative prompt, the seed and the recipe into the PNG (as text chunks). Anyone who gets the file can read them. For every document.";
        const meta = document.createElement("input");
        meta.type = "checkbox";
        meta.addEventListener("keydown", (ev) => ev.stopPropagation());
        meta.addEventListener("change", () => this.setEmbedRecipe(meta.checked));
        mLab.appendChild(meta);
        mLab.appendChild(document.createTextNode("Prompt and recipe in the PNG"));
        mRow.appendChild(mLab);

        // inside the Export section's block, not after it: its padding and row layout apply (after it, the rows sat on the
        // panel's left edge, under the width grip)
        anchor.appendChild(row);
        row.insertAdjacentElement("afterend", qRow);
        qRow.insertAdjacentElement("afterend", mRow);
        // the canvas: a frame around the (scaled) picture, for a fixed output format or a margin
        const cRow = document.createElement("div");
        cRow.className = "ipc-seg scumble-export-canvas";
        cRow.style.flexWrap = "wrap";   // the fill select goes onto a line of its own in a narrow panel instead of squeezing the fields
        const cLab = document.createElement("span");
        cLab.textContent = "Canvas";
        cLab.title = "The saved file's frame around the picture: empty = the picture's own size. Bigger adds a margin of the fill, smaller crops.";
        cRow.appendChild(cLab);
        const cw = num("Frame width in pixels; empty = the picture's size");
        const ch = num("Frame height in pixels; empty = the picture's size");
        cw.min = "0"; ch.min = "0"; cw.placeholder = "auto"; ch.placeholder = "auto";
        cw.addEventListener("change", () => this.setExportSize(editor, { canvasWidth: +cw.value || 0, canvasHeight: +ch.value || 0 }));
        ch.addEventListener("change", () => this.setExportSize(editor, { canvasWidth: +cw.value || 0, canvasHeight: +ch.value || 0 }));
        cRow.appendChild(cw);
        const ctimes = document.createElement("span");
        ctimes.textContent = "×";
        cRow.appendChild(ctimes);
        cRow.appendChild(ch);
        const anchorSel = document.createElement("select");
        anchorSel.className = "ipc-sel";
        anchorSel.style.maxWidth = "64px";
        anchorSel.title = "Where the picture sits in the frame";
        for (const [id, label] of [["tl", "top left"], ["tc", "top"], ["tr", "top right"], ["ml", "left"], ["mc", "centre"], ["mr", "right"], ["bl", "bottom left"], ["bc", "bottom"], ["br", "bottom right"]]) {
            const o = document.createElement("option"); o.value = id; o.textContent = label; anchorSel.appendChild(o);
        }
        anchorSel.addEventListener("keydown", (ev) => ev.stopPropagation());
        anchorSel.addEventListener("change", () => this.setExportSize(editor, { anchor: anchorSel.value }));
        cRow.appendChild(anchorSel);
        const fillSel = document.createElement("select");
        fillSel.className = "ipc-sel";
        fillSel.style.maxWidth = "80px";
        fillSel.title = "What fills the frame around the picture";
        for (const f of ["transparent", "white", "black"]) { const o = document.createElement("option"); o.value = f; o.textContent = f; fillSel.appendChild(o); }
        fillSel.addEventListener("keydown", (ev) => ev.stopPropagation());
        fillSel.addEventListener("change", () => this.setExportSize(editor, { fill: fillSel.value }));
        cRow.appendChild(fillSel);
        qRow.parentElement ? qRow.parentElement.insertBefore(cRow, qRow.nextSibling) : anchor.parentElement.insertBefore(cRow, anchor.nextSibling);
        editor._exportRow = { row, qRow, cRow, mRow, meta, sel, wIn, hIn, q, qLab, cw, ch, anchorSel, fillSel, doc: "" };
        editor.saveFormatSel.addEventListener("change", () => this.syncExportRow(editor));
        // the numbers follow the document: a new image, a crop or an extended canvas changes
        // them. Only a changed document size refreshes the row, so a number being typed in is
        // never overwritten underneath the cursor.
        const offChanged = this.on("changed", ({ editor: ed }) => {
            if (ed !== editor || !editor._exportRow) return;
            if (editor._exportRow.doc !== `${editor.width}x${editor.height}`) this.syncExportRow(editor);
        });
        // both listeners hold the editor: left registered, they kept every closed tab alive with its
        // layers, pyramids and undo steps until the app quit
        const offRemoved = this.on("removed", ({ editor: ed }) => {
            if (ed !== editor) return;
            offChanged();
            offRemoved();
        });
        this.syncExportRow(editor);
    },

    /** Put the state into the row: the numbers, the percentage, and what the format allows. */
    syncExportRow(editor) {
        const r = editor._exportRow;
        if (!r) return;
        const e = this.exportState(editor);
        const px = this.exportPixels(editor) || [editor.width | 0, editor.height | 0];
        r.doc = `${editor.width}x${editor.height}`;
        r.wIn.value = px[0] || "";
        r.hIn.value = px[1] || "";
        r.q.value = e.quality;
        if (r.cw) {
            r.cw.value = e.canvasW || ""; r.ch.value = e.canvasH || "";
            r.anchorSel.value = e.anchor || "mc"; r.fillSel.value = ["transparent", "white", "black"].includes(e.fill) ? e.fill : "transparent";
        }
        const exact = EXPORT_PERCENTS.find((p) => Math.abs(p - e.percent) < 0.05);
        r.sel.value = exact != null ? String(exact) : "custom";
        const fmt = (editor.saveFormatSel && editor.saveFormatSel.value) || "png";
        const layered = fmt === "psd" || fmt === "ora";
        for (const el of [r.sel, r.wIn, r.hIn, ...(r.cw ? [r.cw, r.ch, r.anchorSel, r.fillSel] : [])]) el.disabled = layered;
        r.row.title = layered ? "PSD and ORA always keep the full size" : "";
        r.qRow.hidden = !(fmt === "jpg" || fmt === "webp");
        if (r.mRow) { r.mRow.hidden = fmt !== "png"; r.meta.checked = this.embedRecipe; }
    },
};
