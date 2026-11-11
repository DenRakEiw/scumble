// the depth, state, log and brush commands: moved out of commands.js (item 56 S12, docs/PLAN_SPLIT.md), text unchanged.

import { BRUSH_MAX } from "./editor/inpaint_canvas.js";
import { P, clampInt, findLayer } from "./commands_util.js";

/** @typedef {import("./commands.js").Command} Command */

let COMMANDS = null;

/** @satisfies {Record<string, Command>} */
export const DepthCommandsPart = {
    depth_map: {
        needsImage: true,
        description: "Compute or refresh the document's depth map (Depth Anything V2 Small).",
        params: {
            force: P.bool("recompute even if already present and fresh", { default: false }),
            edges: P.int("edge snap strength 0..100; 0 keeps the plain sample", { minimum: 0, maximum: 100 }),
            detail: P.enum("standard, fine (2x2) or finest (3x3)", ["standard", "fine", "finest"], "standard"),
        },
        async run(ed, a) {
            const force = a.force === true || a.force === "true";
            const existing = ed.maps && ed.maps.depth;
            const edgesVal = a.edges !== undefined && a.edges !== null ? Math.max(0, Math.min(100, Math.round(+a.edges))) : null;
            const detail = a.detail || "standard";
            const existingDetail = existing && existing.meta && existing.meta.detail
                ? (existing.meta.detail.route === "large" ? "large" : (existing.meta.detail.grid === 3 ? "finest" : "fine"))
                : "standard";
            let map;
            if (!force && existing && existing.data && existingDetail === detail) {
                if (edgesVal !== null) {
                    ed.setMapMeta("depth", { snap: { ...(existing.meta?.snap || {}), strength: edgesVal } });
                }
                map = ed.maps.depth;
            } else {
                map = await ed.ensureDepthMap({ force: true, edges: edgesVal, detail });
            }
            if (!map || (!map.data && !map.u16)) throw new Error("depth map computation failed");
            const meta = map.meta || map;
            return {
                ok: true,
                width: map.w,
                height: map.h,
                provider: meta.provider,
                raw_bounds: meta.rawBounds || null,
                stale: ed.isDepthStale ? (await ed.checkDepthStale?.() ?? ed.isDepthStale()) : false,
                edges: (meta.snap && meta.snap.strength) || 0,
                guide: !!map.guide,
                detail: meta.detail || null,
            };
        },
    },
    sample_depth: {
        needsImage: true,
        readOnly: true,
        description: "Sample the document's depth map at (x, y) in image pixels (Depth Anything V2 Small). Returns normalized depth (0..1, near to far), 16-bit depth (0..65535), raw disparity, disparity bounds, resolution, provider and whether the map is stale. Requires running depth_map first.",
        params: {
            x: P.num("x in image pixels", { required: true }),
            y: P.num("y in image pixels", { required: true }),
        },
        async run(ed, a) {
            const x = +a.x, y = +a.y;
            if (a.x == null || a.y == null || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("pass x and y in image pixels");
            if (x < 0 || y < 0 || x >= ed.width || y >= ed.height) throw new Error(`${x}, ${y} is outside the ${ed.width} × ${ed.height} picture`);
            const depthObj = (ed.maps && ed.maps.depth) || ed.depth;
            const u16 = (depthObj && (depthObj.data || depthObj.u16)) || null;
            if (!depthObj || !u16) throw new Error("run depth_map first");
            const dw = depthObj.w, dh = depthObj.h;
            const gx = Math.max(0, Math.min(dw - 1, Math.floor((x / ed.width) * dw)));
            const gy = Math.max(0, Math.min(dh - 1, Math.floor((y / ed.height) * dh)));
            const u16Val = u16[gy * dw + gx];
            const meta = depthObj.meta || depthObj;
            let rawVal = null;
            if (meta.raw && meta.rw && meta.rh) {
                const rx = Math.max(0, Math.min(meta.rw - 1, Math.floor((x / ed.width) * meta.rw)));
                const ry = Math.max(0, Math.min(meta.rh - 1, Math.floor((y / ed.height) * meta.rh)));
                rawVal = meta.raw[ry * meta.rw + rx];
            }
            return {
                x: Math.floor(x),
                y: Math.floor(y),
                depth: Math.round((u16Val / 65535) * 100000) / 100000,
                u16: u16Val,
                raw_disparity: rawVal != null ? Math.round(rawVal * 10000) / 10000 : null,
                near: meta.hi != null ? Math.round(meta.hi * 10000) / 10000 : null,
                far: meta.lo != null ? Math.round(meta.lo * 10000) / 10000 : null,
                raw_bounds: meta.rawBounds || null,
                width: dw,
                height: dh,
                provider: meta.provider,
                stale: ed.isDepthStale ? ed.isDepthStale() : false,
            };
        },
    },
    depth_edit: {
        needsImage: true,
        description: "Change the document's depth map inside the selection (soft edges count partly): flatten to the median (or to `value`, 0 near .. 1 far), offset by `value` (-1..1, + is farther), or smooth by `value` (0..1). One undo step.",
        params: {
            op: P.enum("flatten, offset or smooth", ["flatten", "offset", "smooth"]),
            value: P.num("see op"),
        },
        async run(ed, a) {
            const op = String(a.op || "").trim().toLowerCase();
            if (!["flatten", "offset", "smooth"].includes(op)) {
                throw new Error("op must be flatten, offset or smooth");
            }
            if (!ed.maps || !ed.maps.depth) {
                throw new Error("run depth_map first");
            }
            if (!ed.getBounds()) {
                throw new Error("make a selection first");
            }
            const val = a.value !== undefined && a.value !== null ? +a.value : null;
            const res = await ed.editDepth(op, val);
            if (!res) throw new Error("depth edit failed");
            return res;
        },
    },
    depth_from_layer: {
        needsImage: true,
        description: "Create the document's depth map from an existing layer (white is near, black is far). The layer must cover the whole picture.",
        params: {
            layer: P.layer("the layer: id, name or unique name fragment", { required: true }),
            invert: P.bool("invert: treat black as near instead of white", { default: false }),
        },
        async run(ed, a) {
            if (a.layer === undefined || a.layer === null || a.layer === "") {
                throw new Error("layer parameter required");
            }
            const l = findLayer(ed, a.layer);
            const invert = !!a.invert;
            const map = await ed.depthFromLayer(l, { invert });
            if (!map) throw new Error("depth from layer failed");
            return {
                w: map.w,
                h: map.h,
                source: "layer",
            };
        },
    },
    get_state: { readOnly: true, description: "The document's state JSON (the node's canvas_state without the selection bitmaps).", params: {}, async run(ed) { const v = JSON.parse(ed.getValue() || "{}"); delete v.selection; delete v.selections; return v; } },
    set_status: {
        description: "Write a line into the document's status bar. An error or warn line shows red, blinks five times (not under reduced motion) and stays red until the next line.",
        params: { text: P.str("", { required: true }), kind: P.enum("error, warn or info (plain); left out, the text decides (a failure or a missing download shows red)", ["error", "warn", "info"]) },
        async run(ed, a) {
            const kind = a.kind == null || a.kind === "" ? undefined : String(a.kind);
            if (kind && !["error", "warn", "info"].includes(kind)) throw new Error(`kind must be error, warn or info, not ${JSON.stringify(a.kind)}`);
            ed.setStatus(String(a.text), kind ? { kind } : undefined);
            return { status: ed.status, kind: ed.statusKind || "info" };
        },
    },

    // -- log --
    read_log: {
        readOnly: true,
        scope: "app",
        description: "The app's log (what the app, its providers and helpers reported; errors carry the request shape and the stack): the last entries, newest last. Also in Help > Console and in <userData>/logs/scumble.log.",
        params: { level: P.str("all, warn (warnings and errors) or error", { enum: ["all", "warn", "error"], default: "all" }), after: P.int("only entries with an id above this (from an earlier call)", { default: 0 }), limit: P.int("at most this many entries (default 200)", { default: 200 }) },
        async run(_ed, a) {
            const all = await window.scumble.log.list({ after: a.after | 0 });
            const lvl = a.level || "all";
            const picked = all.filter((e) => lvl === "all" || (lvl === "error" ? e.level === "error" : e.level !== "info"));
            const limit = Math.max(1, Math.min(2000, a.limit | 0 || 200));
            return { entries: picked.slice(-limit), total: all.length, file: await window.scumble.log.file() };
        },
    },

    // -- brush --
    list_brush_tips: {
        readOnly: true,
        description: "The brush tips available under Tip: the built-in round dab and the imported ones (from Photoshop .abr files or images), with the active one and the brush settings of this document.",
        params: {},
        async run(ed) {
            const tips = [{ id: "round", name: "Round", builtIn: true }, ...(ed.brushTips || []).map((t) => ({ id: t.id, name: t.name, width: t.canvas.width, height: t.canvas.height, spacing: t.spacing || 0, source: t.source || "" }))];
            return { active: ed.brushTipId || "round", size: ed.brushSize, hardness: Math.round((ed.hardness || 0) * 100), eraseHardness: Math.round((ed.eraseHardness || 0) * 100), opacity: Math.round((ed.brushOpacity == null ? 1 : ed.brushOpacity) * 100), flow: Math.round((ed.brushFlow == null ? 1 : ed.brushFlow) * 100), follow: !!ed.tipRotate, tips };
        },
    },
    set_brush: {
        description: "Brush settings of this document: the tip (round, or an imported tip by id or name), size in pixels, hardness, opacity and flow in percent, the tip's spacing in percent of its size, and whether the tip follows the stroke direction. Every parameter is optional.",
        params: {
            tip: P.str("round, or the id or name of an imported tip (list_brush_tips)"),
            size: P.int("brush size in image pixels (2..1000)"),
            hardness: P.num("0..100 for the paint brush (the eraser keeps its own, see erase_hardness)"),
            erase_hardness: P.num("0..100 for the eraser"),
            opacity: P.num("brush opacity 0..100"),
            flow: P.num("brush flow 5..100: below 100 a stroke builds up where it overlaps itself"),
            spacing: P.num("stamp spacing of the active imported tip, in percent of its size (1..200)"),
            follow: P.bool("rotate an imported tip with the stroke direction"),
        },
        async run(ed, a) {
            if (a.tip != null) {
                const want = String(a.tip);
                if (/^round$/i.test(want) || want === "") ed.setBrushTip("");
                else {
                    const t = (ed.brushTips || []).find((x) => x.id === want) || (ed.brushTips || []).find((x) => x.name === want) || (ed.brushTips || []).filter((x) => x.name.toLowerCase().includes(want.toLowerCase()));
                    const hit = Array.isArray(t) ? (t.length === 1 ? t[0] : null) : t;
                    if (!hit) throw new Error(`no brush tip "${want}"${Array.isArray(t) && t.length > 1 ? ` (${t.length} match: ${t.map((x) => x.name).join(", ")})` : ""}`);
                    ed.setBrushTip(hit.id);
                }
            }
            if (a.size != null) { const v = clampInt(a.size, 2, BRUSH_MAX, ed.brushSize); if (ed.setBrushSize && ed.sizeCtl) ed.setBrushSize(v); else ed.brushSize = v; }
            const pct = (v) => Math.max(0, Math.min(1, (+v) / 100));
            if (a.hardness != null && Number.isFinite(+a.hardness)) { ed.hardness = pct(a.hardness); if (ed.tool !== "erase" && ed.hardCtl) { ed.hardCtl.input.value = Math.round(ed.hardness * 100); ed.hardCtl.value.textContent = Math.round(ed.hardness * 100) + "%"; } }
            if (a.erase_hardness != null && Number.isFinite(+a.erase_hardness)) { ed.eraseHardness = pct(a.erase_hardness); if (ed.tool === "erase" && ed.hardCtl) { ed.hardCtl.input.value = Math.round(ed.eraseHardness * 100); ed.hardCtl.value.textContent = Math.round(ed.eraseHardness * 100) + "%"; } }
            if (a.opacity != null && Number.isFinite(+a.opacity)) { ed.brushOpacity = Math.max(0.01, pct(a.opacity)); if (ed.opacCtl) { ed.opacCtl.input.value = Math.round(ed.brushOpacity * 100); ed.opacCtl.value.textContent = Math.round(ed.brushOpacity * 100) + "%"; } }
            if (a.flow != null && Number.isFinite(+a.flow)) { ed.brushFlow = Math.max(0.05, pct(a.flow)); if (ed.flowCtl) { ed.flowCtl.input.value = Math.round(ed.brushFlow * 100); ed.flowCtl.value.textContent = Math.round(ed.brushFlow * 100) + "%"; } }
            if (a.spacing != null && Number.isFinite(+a.spacing)) {
                const t = ed.brushTip();
                if (!t) throw new Error("spacing belongs to an imported tip; pick one first (tip)");
                t.spacing = Math.max(0.01, Math.min(2, (+a.spacing) / 100));
                ed._tipStamp = null;
                ed.syncTipControls();
                ed.brushTipsChanged();
            }
            if (a.follow != null) { ed.tipRotate = !!a.follow; if (ed.tipRotateCb) ed.tipRotateCb.checked = ed.tipRotate; }
            ed.draw();
            return (await COMMANDS.list_brush_tips.run(ed));
        },
    },
};

export function bindDepthCommands(C) { COMMANDS = C; }
