// @ts-check
// the layer commands: moved out of commands.js (item 56 S12, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./editor/host.js";
import { BLEND_MODES } from "./editor/inpaint_canvas.js";
import { MASK_OPS, P, TRANSFORM_MODES, clampInt, findGroup, findLayer, groupSummary, layerSummary, mergedClip, pendingSize, pointList, refuseLayer, touch, until } from "./commands_util.js";

/** @typedef {import("./commands.js").Command} Command */

/** @satisfies {Record<string, Command>} */
export const LayerCommandsPart = {
    // -- layers --
    list_layers: { readOnly: true, description: "All layers bottom to top with their properties; `selected` lists the layers selected with the active one; `groups` the folders (a layer's `group` is the innermost it is in, `parent` a group's).", params: {}, async run(ed) { return { active: ed.activeLayerId, selected: ed.selectedLayers ? ed.selectedLayers().map((l) => l.id) : [], layers: ed.layers.map((l) => layerSummary(ed, l)), groups: (ed.groups || []).map((g) => groupSummary(ed, g)) }; } },
    set_active_layer: {
        description: "Make a layer the active one, or select several (`layers`: they move and scale together with the move tool, merge with Ctrl+E, delete together; the first becomes active).",
        params: { layer: P.layer("the layer: id, name or unique name fragment", { default: "" }), layers: { type: "array", items: { type: "string" }, description: "several layers (ids, names or unique name fragments) to select together" } },
        async run(ed, a) {
            if (Array.isArray(a.layers) && a.layers.length) {
                const ls = a.layers.map((x) => findLayer(ed, x, { allowActive: false }));
                if (ls.some((l) => ed.isReference(l)) && ls.length > 1) throw new Error("reference layers are selected one at a time");
                const sel = ed.selectLayers(ls.map((l) => l.id), { active: a.layer ? findLayer(ed, a.layer, { allowActive: false }).id : null });
                touch(ed);
                return { active: ed.activeLayerId, selected: sel.map((l) => l.id), layers: sel.map((l) => layerSummary(ed, l)) };
            }
            if (!a.layer) throw new Error("give `layer` or `layers`");
            const l = findLayer(ed, a.layer, { allowActive: false });
            if (ed.selectLayers) ed.selectLayers([l.id]); else ed.activeLayerId = l.id;
            touch(ed); if (ed.updateSubbar) ed.updateSubbar();
            return layerSummary(ed, l);
        },
    },
    set_layer: {
        description: "Change a layer: name, visible, opacity (0..1 or percent), blend, locked, alpha_lock, clip (clipped to the layer below: shown only where that layer has pixels; its own undo step), role, colour match (0..100 %, match_source surroundings / below), geometry x y w h, active.",
        params: { layer: P.layer(), name: P.str(""), visible: P.bool(""), opacity: P.num("0..1 (or 0..100)"), blend: P.str("the blend mode", { enum: BLEND_MODES }), locked: P.bool(""), alpha_lock: P.bool(""), clip: P.bool("clip to the layer below (true) or release (false)"), role: P.str("none, reference or control", { enum: ["none", "reference", "control"] }), match: P.num("colour match strength 0..100"), match_source: P.str("surroundings or below", { enum: ["surroundings", "below"] }), x: P.int(""), y: P.int(""), w: P.int("width (alias width); without h the aspect is kept"), h: P.int("height (alias height)"), active: P.bool("also make it the active layer") },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (a.name != null) l.name = String(a.name);
            if (a.visible != null) { l.visible = !!a.visible; ed.refsMutated(); }
            if (a.opacity != null) l.opacity = Math.min(1, Math.max(0, +a.opacity > 1 ? +a.opacity / 100 : +a.opacity));
            if (a.blend != null) {
                // a typo drew as normal on every path before (no site checks the name): refused here
                if (!BLEND_MODES.includes(String(a.blend))) throw new Error(`blend "${a.blend}" is not one of ${BLEND_MODES.join(", ")}`);
                l.blend = String(a.blend);
            }
            if (a.locked != null) l.locked = !!a.locked;
            if (a.alpha_lock != null) l.alphaLock = !!a.alpha_lock;
            if (a.clip != null && !!a.clip !== !!l.clip && !ed.setLayerClip(l, !!a.clip, { only: true })) throw new Error(ed.status);
            if (a.role != null) {
                if (!["none", "reference", "control"].includes(a.role)) throw new Error("role must be none, reference or control");
                ed.setLayerRole(l, a.role);
            }
            if (a.match != null || a.match_source != null) {
                if (l.kind === "filter") throw new Error("filter layers have no colour match");
                l.match = l.match || { strength: 0, source: "surroundings" };
                if (a.match != null) { const m = +a.match; l.match.strength = Math.min(100, Math.max(0, Math.round(m > 0 && m < 1 ? m * 100 : m))); }
                // the editor calls the pixels under the layer "underneath"; "below" was stored as it came and read as surroundings
                if (a.match_source != null) { if (!["surroundings", "below", "underneath"].includes(a.match_source)) throw new Error("match_source must be surroundings or below"); l.match.source = a.match_source === "surroundings" ? "surroundings" : "underneath"; }
                ed.markMatchChanged(l);
            }
            const geo = ["x", "y", "w", "h"].some((k) => a[k] != null) || a.width != null || a.height != null;
            if (geo) {
                if (l.kind === "filter") throw new Error("filter layers cover the whole canvas");
                ed.pushUndo({ kind: "transform", id: l.id, label: "Layer geometry" });
                if (a.x != null) l.x = Math.round(+a.x);
                if (a.y != null) l.y = Math.round(+a.y);
                const w = a.w != null ? a.w : a.width, h = a.h != null ? a.h : a.height;
                if (w != null && h == null) { const k = +w / l.w; l.w = Math.max(1, Math.round(+w)); l.h = Math.max(1, Math.round(l.h * k)); }
                else { if (w != null) l.w = Math.max(1, Math.round(+w)); if (h != null) l.h = Math.max(1, Math.round(+h)); }
            }
            if (a.active) ed.activeLayerId = l.id;
            touch(ed);
            return layerSummary(ed, l);
        },
    },
    add_paint_layer: {
        needsImage: true, description: "Add an empty transparent paint layer at canvas size.",
        params: { name: P.str("layer name") },
        async run(ed, a) { const l = ed.addPaintLayer(); if (!l) throw new Error(ed.status); if (a.name) { l.name = String(a.name); touch(ed); } return layerSummary(ed, l); },
    },
    remove_layer: { destructive: true, description: "Delete a layer. Refused on a locked layer.", params: { layer: P.layer("", { required: true }) }, async run(ed, a) { const l = findLayer(ed, a.layer); refuseLayer(ed, l); ed.removeLayer(l.id); return { removed: l.id, layers: ed.layers.length }; } },
    frequency_separation: {
        description: "Frequency separation of the selection's box (or of the whole picture up to 16 MP): two layers on top, 'Low frequency' (its blur of radius px, normal) and 'High frequency' (the detail, linear light), which together give the picture back. One undo step; the high layer becomes active.",
        params: { radius: P.num("the blur radius in pixels (default: 0.4 % of the picture's short side)") },
        async run(ed, a) { const r = await ed.frequencySeparation({ radius: a.radius }); if (!r) throw new Error(ed.status); return r; },
    },
    dodge_burn_layer: {
        description: "A dodge & burn layer on top: a paint layer in soft light where white paint lightens and black darkens. Empty by default (the same picture as 50 % grey, no memory until painted); grey fills it with 50 % grey. One undo step; the layer becomes active.",
        params: { grey: P.bool("fill it with 50 % grey (Photoshop's habit; about 600 MB at 15000 x 10000)") },
        async run(ed, a) { const l = ed.dodgeBurnLayer({ grey: !!a.grey }); if (!l) throw new Error(ed.status); return layerSummary(ed, l); },
    },
    duplicate_layer: { description: "Duplicate a layer (the copy sits above it).", params: { layer: P.layer() }, async run(ed, a) { const l = findLayer(ed, a.layer); const c = ed.duplicateLayer(l); if (!c) throw new Error(ed.status); return layerSummary(ed, c); } },
    merge_down: { destructive: true, description: "Merge a layer into the one below it (into the base image if it is the lowest).", params: { layer: P.layer() }, async run(ed, a) { const l = findLayer(ed, a.layer); const n = ed.layers.length; await ed.mergeDown(l); if (ed.layers.length === n && ed.layers.includes(l)) throw new Error(ed.status); return { layers: ed.layers.map((x) => layerSummary(ed, x)), status: ed.status }; } },
    move_layer: {
        description: "Reorder a layer: to = up, down, top, bottom, or delta = ±n. A step goes past the next layer, into a group next to it or out of its own group at its end; top and bottom leave every group.",
        params: { layer: P.layer("", { required: true }), to: P.str("up, down, top or bottom", { enum: ["up", "down", "top", "bottom"] }), delta: P.int("steps up (positive) or down") },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (a.to === "top" || a.to === "bottom") ed.moveLayer(l.id, 0, { undo: true, to: a.to });
            else {
                const delta = a.to === "up" ? 1 : a.to === "down" ? -1 : Math.round(+a.delta || 0);
                if (delta) ed.moveLayer(l.id, delta, { undo: true });
            }
            return { index: ed.layers.indexOf(l), group: l.group || null, layers: ed.layers.map((x) => x.name) };
        },
    },
    // axis x is the editor's "h" (left to right), y its "v": until 0.1.42 both reached the editor as a vertical flip
    flip_layer: { description: "Mirror a layer: axis x mirrors it left to right (horizontally), axis y top to bottom (vertically). Refused on a locked or a filter layer.", params: { layer: P.layer(), axis: P.str("x (left to right) or y (top to bottom)", { enum: ["x", "y"], default: "x" }) }, async run(ed, a) { const l = findLayer(ed, a.layer); refuseLayer(ed, l, "flipped"); ed.activeLayerId = l.id; ed.flipLayer(a.axis === "y" || a.axis === "vertical" ? "v" : "h"); return layerSummary(ed, l); } },
    center_layer: { description: "Centre a layer on the canvas. Refused on a locked or a filter layer.", params: { layer: P.layer() }, async run(ed, a) { const l = findLayer(ed, a.layer); refuseLayer(ed, l, "centred"); ed.activeLayerId = l.id; ed.centerLayer(); return layerSummary(ed, l); } },
    // item 42: the layer menu's "Match edges to the layer below"; a refusal is an answer (aligned false and the reason), not an error
    match_edges: {
        needsImage: true,
        description: "Match a layer's edges to the picture under it: an inpaint result that came back slightly shifted or scaled (edit models re-render the whole crop) is fitted on its own edge ring (its opaque pixels near its transparent part or its mask's border) against the composite of the layers below, and moved (a whole-pixel shift) or resampled to match, one undo step (a live mask is baked in when it is resampled). The fit is kept only within 8 % scale, 0.03 shear and 5 % shift and when the edge difference drops by 3 % or more; otherwise nothing changes and the answer says why (aligned false, reason: flat area, fit out of range, no gain, ring too small, no fit found, text layer). apply false only reports the fit. scale and shift as the node's stitch reports them; centre: how far the layer's middle moved, in image pixels; before / after: the mean edge difference in levels of 255; how: moved, resampled or null. Refused on a locked or a filter layer.",
        params: { layer: P.layer(), apply: P.bool("false: only fit and report, change nothing", { default: true }) },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            refuseLayer(ed, l, "matched");
            if (ed.textEdit) ed.endTextEdit(true);
            ed.selectLayers([l.id]);
            const from = { x: l.x, y: l.y, w: l.w, h: l.h };
            const r = ed.matchEdges(l, { apply: a.apply !== false });
            if (r.how) touch(ed);
            const { matrix: _m, ...rest } = r;
            return { ...layerSummary(ed, l), ...rest, from, status: ed.status };
        },
    },
    transform_layer: {
        needsImage: true,
        description: "Transform one layer, baked into its pixels in one undo step, as the move tool's Rotate / Distort / Warp and its quarter turns. mode rotate: by `angle` degrees clockwise about the layer's middle (a text layer stays editable: the angle goes into the text, as set_text's angle); rotate90: a quarter turn (`dir` cw or ccw) without resampling; distort: the layer's four corners to `corners` (a perspective: [[x, y] top left, top right, bottom right, bottom left] in image pixels); warp: the layer bent on a grid of n × n cells: `points` holds the (n + 1) × (n + 1) grid points row by row from the top left, in image pixels (unbent they are x + w·i/n, y + h·j/n of the layer's box). Distort and warp turn a text layer into pixels; a live mask is baked into the pixels, a switched-off one dropped (undo brings both back). The layer keeps the resolution of its pixels. Refused on a locked or a filter layer; the base is no layer (rotate_canvas and straighten_canvas turn the whole picture). from: the layer's box before; changed false: nothing to do (an angle of 0).",
        params: {
            layer: P.layer(),
            mode: P.str("rotate, rotate90, distort or warp", { required: true, enum: TRANSFORM_MODES }),
            angle: P.num("rotate: degrees clockwise"),
            dir: P.str("rotate90: cw (clockwise) or ccw", { enum: ["cw", "ccw"], default: "cw" }),
            corners: { type: "array", items: { type: "array", items: { type: "number" } }, description: "distort: four [x, y] in image pixels, the new top left, top right, bottom right and bottom left corner" },
            n: P.int("warp: grid cells per side, 1..16", { default: 4 }),
            points: { type: "array", items: { type: "array", items: { type: "number" } }, description: "warp: (n + 1) × (n + 1) [x, y] grid points in image pixels, row by row from the top left" },
        },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            refuseLayer(ed, l, "transformed");
            const mode = String(a.mode || "");
            if (!TRANSFORM_MODES.includes(mode)) throw new Error(`mode must be one of ${TRANSFORM_MODES.join(", ")}`);
            // the arguments first, so a wrong one leaves the editor as it was
            let deg = 0, dir = 1, pts = null, n = 0;
            if (mode === "rotate") {
                deg = +a.angle;
                if (a.angle == null || a.angle === "" || !Number.isFinite(deg)) throw new Error("rotate needs angle (degrees clockwise)");
            } else if (mode === "rotate90") {
                if (a.dir != null && a.dir !== "" && a.dir !== "cw" && a.dir !== "ccw") throw new Error("dir must be cw or ccw");
                dir = a.dir === "ccw" ? -1 : 1;
            } else if (mode === "distort") {
                pts = pointList(a.corners, "corners");
                if (pts.length !== 4) throw new Error(`distort needs four corners (top left, top right, bottom right, bottom left), not ${pts.length}`);
            } else {
                n = clampInt(a.n == null || a.n === "" ? 4 : a.n, 1, 16, 4);
                if (a.n != null && a.n !== "" && n !== +a.n) throw new Error("n must be a whole number of grid cells, 1..16");
                pts = pointList(a.points, "points");
                if (pts.length !== (n + 1) * (n + 1)) throw new Error(`warp with n ${n} needs ${(n + 1) * (n + 1)} points ((n + 1) × (n + 1), row by row), not ${pts.length}`);
            }
            // a mode that bakes (rotate, distort, warp; not a text's angle) reads the layer's own pixels as one canvas (the
            // mask step and the bake): a layer past that (a full-size paint layer of a document over 268 MP) is refused
            // before anything changes, not half way after the undo step
            if (mode !== "rotate90" && !(mode === "rotate" && l.kind === "text" && l.text)) {
                const pw = l.px ? l.px.width : 0, ph = l.px ? l.px.height : 0;
                if (pw > 65535 || ph > 65535 || pw * ph > 268435456) throw new Error(`layer ${l.name || l.id} is ${pw} × ${ph} px, more than one canvas holds (65,535 px a side, 268 megapixels): ${mode} needs its pixels as one canvas`);
            }
            if (ed.textEdit) ed.endTextEdit(true);
            // an open transform in the editor (a preview, not applied) goes, as Esc would; the modes take one layer
            if (ed.pending) ed.cancelPending();
            ed.selectLayers([l.id]);
            const from = { x: l.x, y: l.y, w: l.w, h: l.h };
            const px0 = l.px, text0 = l.text;
            if (mode === "rotate90") ed.rotateLayer90(dir);
            else if (mode === "rotate" && l.kind === "text" && l.text) {
                // a text stays text: its angle grows, about its middle (the move tool's Rotate on a text does the same)
                const now = (layerSummary(ed, l).text || {}).angle || 0;
                await ed.setTextAngle(l, now + deg, { label: "Rotate" });
            } else {
                ed.startPending(mode);
                const p = ed.pending;
                if (!p || p.layer !== l) { if (ed.pending) ed.cancelPending(); throw new Error(ed.status || "the layer cannot be transformed"); }
                if (mode === "rotate") p.angle = deg * Math.PI / 180;
                else if (mode === "distort") { p.points = pts; p.H = null; }
                else { p.n = n; p.points = pts; }
                // the size the baked pixels get, before anything changes: a shape past one canvas (or a corner at infinity)
                // would fail half way, after the undo step and the mask
                const size = pendingSize(ed, p);
                if (!size) { ed.cancelPending(); throw new Error(`the ${mode} sends a corner to infinity: give corners that make a four-sided shape`); }
                if (size.w > 65535 || size.h > 65535 || size.w * size.h > 268435456) { ed.cancelPending(); throw new Error(`the ${mode} makes ${size.w} × ${size.h} px of pixels, more than one canvas holds (65,535 px a side, 268 megapixels)`); }
                ed.applyPending();
                if (ed.pending) { ed.cancelPending(); throw new Error(ed.status || "the transform was not applied"); }
            }
            const changed = l.px !== px0 || l.text !== text0;
            if (changed) touch(ed);
            return { ...layerSummary(ed, l), mode, from, changed, status: ed.status };
        },
    },
    copy_to_layer: {
        needsImage: true,
        description: "Copy the selected pixels of a layer, or of the visible picture with merged, into a new layer at the same place (Ctrl+C, or Ctrl+Shift+C, then Ctrl+V); with nothing selected the whole layer or the whole picture. cut takes the selected pixels out of the layer (the whole layer when nothing is selected), as Ctrl+X. to_doc pastes into another tab at the same coordinates. The new layer goes on top and becomes active, one undo step in the tab it lands in (a cut is a step of its own in this tab). The clipboard the user's Ctrl+V reads stays as it was. A typical use: lift an object out of the picture onto a layer of its own, then move it (set_layer x, y) or transform_layer it. Refused: a filter layer (no pixels; merged copies the picture), a cut of a locked layer or of the merged picture.",
        params: {
            layer: P.layer("the layer to copy from (id, name, a unique part of the name, or \"active\"); ignored with merged"),
            merged: P.bool("the visible picture (every visible layer with its filters, without reference and control layers) instead of one layer", { default: false }),
            cut: P.bool("take the pixels out of the layer (not with merged)", { default: false }),
            to_doc: P.int("the tab to paste into (default this one)"),
            name: P.str("the new layer's name (default \"<layer> copy\", or \"Paste n\" for the picture)"),
        },
        async run(ed, a) {
            const merged = !!a.merged, cut = !!a.cut;
            if (merged && cut) throw new Error("cut takes pixels out of one layer: the merged picture cannot be cut (copy it, then hide or mask what should go)");
            let target = ed;
            if (a.to_doc != null && a.to_doc !== "") {
                target = host.editorById(a.to_doc);
                if (!target) throw new Error(`no document with id ${a.to_doc} (open: ${host.editors().map((e) => e.node.id).join(", ") || "none"})`);
                if (!target.base || !target.width) throw new Error(`document ${a.to_doc} has no picture to paste into: load_image or new_canvas there first`);
            }
            const l = merged ? null : findLayer(ed, a.layer);
            if (l && l.kind === "filter") throw new Error(`layer ${l.name || l.id} is a filter layer: it has no pixels to copy (merged true copies the visible picture)`);
            if (l && cut) refuseLayer(ed, l);
            const prev = ed.clipboard;   // every tab shares it: the user's Ctrl+V reads it afterwards
            let made = null, clip = null;
            try {
                if (merged) clip = await mergedClip(ed);
                else {
                    ed.activeLayerId = l.id;
                    // a cut takes pixels; with the layer's mask in edit mode the editor would hide them in the mask instead
                    const edit = l.maskEdit;
                    if (cut) l.maskEdit = false;
                    try { clip = ed.copySelection({ cut }); } finally { if (cut && ed.layers.includes(l)) l.maskEdit = edit; }
                }
                if (!clip) throw new Error(ed.status || "nothing was copied");
                ed.clipboard = clip;
                target.pushUndo({ kind: "layers", label: "Paste" });
                made = target.pasteClipboard();
                if (!made) throw new Error(target.status || "nothing was pasted");
                if (a.name != null && String(a.name).trim()) made.name = String(a.name).trim();
            } finally { ed.clipboard = prev; }
            touch(target);
            if (target !== ed) touch(ed);
            return { ...layerSummary(target, made), doc: target.node.id, source: merged ? "merged" : l.id, cut, status: target.status };
        },
    },
    align_layers: {
        description: "Align the selected layers (or `layers`, which get selected) on an edge or a centre, or distribute them with equal gaps, within the box around them or within the canvas (one layer aligns to the canvas). Filter and locked layers stay put. One undo step.",
        params: {
            layers: { type: "array", items: { type: "string" }, description: "the layers (ids, names or unique name fragments); default: the selected layers" },
            align: P.str("the edge or centre to line up", { enum: ["left", "hcenter", "right", "top", "vcenter", "bottom"] }),
            distribute: P.str("equal gaps along x (horizontal) or y (vertical); three layers at least within the selection, two across the canvas", { enum: ["x", "y"] }),
            to: P.str("selection (the box around the layers) or canvas", { enum: ["selection", "canvas"], default: "selection" }),
        },
        async run(ed, a) {
            if (!a.align === !a.distribute) throw new Error("give `align` or `distribute`");
            if (Array.isArray(a.layers) && a.layers.length) ed.selectLayers(a.layers.map((x) => findLayer(ed, x, { allowActive: false }).id));
            const opts = { to: a.to === "canvas" ? "canvas" : "selection" };
            const moved = a.align ? ed.alignLayers(a.align, opts) : ed.distributeLayers(a.distribute === "y" ? "y" : "x", opts);
            if (!moved.length && !/already in place/.test(ed.status)) throw new Error(ed.status);
            return { moved: moved.map((l) => l.id), layers: ed.alignTargets().map((l) => layerSummary(ed, l)) };
        },
    },
    group_layers: {
        description: "Put layers into a new group, a folder in the layer list (the selected layers, or `layers`): its eye hides and its lock locks all of them; it has no opacity or blend mode of its own. The group takes the place of the topmost of them; a group whose layers are all given goes in whole. One undo step; the group's layers become the selection.",
        params: {
            layers: { type: "array", items: { type: "string" }, description: "the layers (ids, names or unique name fragments); default: the selected layers" },
            name: P.str("the group's name (default Group n)"),
        },
        async run(ed, a) {
            const ls = Array.isArray(a.layers) && a.layers.length ? a.layers.map((x) => findLayer(ed, x, { allowActive: false })) : ed.selectedLayers();
            if (ls.some((l) => ed.isReference(l))) throw new Error("a reference layer is in no group");
            const g = ed.groupLayersNow(ls, { name: a.name || null });
            if (!g) throw new Error(ed.status);
            touch(ed);
            return groupSummary(ed, g);
        },
    },
    ungroup_layers: {
        description: "Dissolve a group: its layers and groups stay where they are, in the group around it. One undo step.",
        params: { group: P.str("the group: id or name", { required: true }) },
        async run(ed, a) { const g = findGroup(ed, a.group); ed.ungroup(g.id); touch(ed); return { ungrouped: g.id, groups: ed.groups.map((x) => groupSummary(ed, x)) }; },
    },
    set_group: {
        description: "Change a group: name, visible (hides every layer in it, their own eyes stay), locked (locks every layer in it), collapsed (folded in the layer list). The switches take no undo step, as a layer's eye and lock; a new name does.",
        params: { group: P.str("the group: id or name", { required: true }), name: P.str(""), visible: P.bool(""), locked: P.bool(""), collapsed: P.bool("") },
        async run(ed, a) {
            const g = findGroup(ed, a.group);
            if (a.name != null && String(a.name).trim()) ed.renameGroup(g.id, a.name);
            for (const k of ["visible", "locked", "collapsed"]) if (a[k] != null) ed.setGroupFlag(g.id, k, !!a[k]);
            touch(ed);
            return groupSummary(ed, ed.groupById(g.id) || g);
        },
    },
    flatten: { destructive: true, needsImage: true, description: "Flatten all visible layers into the base image.", params: {}, async run(ed) { await ed.flatten(); return { layers: ed.layers.length, status: ed.status }; } },
    cutout_layer: {
        description: "Remove the background of a layer with the cutout model the editor is set to (in-app when a matting model is downloaded); the mask becomes the layer's transparency.",
        params: { layer: P.layer(), timeout: P.timeout(300) },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            if (ed.cutoutPending) throw new Error("a background removal is still running");
            // "done": the in-app model finished inside the call; "started": a ComfyUI run the editor finishes later; false:
            // nothing started (or the in-app run failed), and the status says why
            const run = await ed.cutoutLayer(l);
            if (!run) throw new Error(ed.status);
            if (run === "started") {
                const ok = await until(() => !ed.cutoutPending, clampInt(a.timeout, 5, 3600, 300) * 1000);
                if (!ok) throw new Error("background removal timed out: " + ed.status);
                if (/failed|could not apply/i.test(ed.status)) throw new Error(ed.status);
            }
            return layerSummary(ed, l);
        },
    },
    set_mask: {
        description: "Change a layer's mask (white = the layer shows): invert it; reveal (all) or hide (all) - a white or a black mask, added when the layer has none, else replacing it; from_selection (the selection shows) or hide_selection (the selection is hidden); from_layer (copy another layer's mask); disable / enable (the mask stays with the layer but is not drawn, PSD's \"disabled\"); apply (baked into the pixels; not on a filter layer) or remove. One undo step; every operation but disable switches the mask on.",
        params: {
            layer: P.layer(),
            op: P.str("what to do", { required: true, enum: MASK_OPS }),
            source: P.layer("from_layer: the layer whose mask is copied", { default: undefined }),
        },
        async run(ed, a) {
            const l = findLayer(ed, a.layer);
            const op = String(a.op || "");
            if (!MASK_OPS.includes(op)) throw new Error(`op must be one of ${MASK_OPS.join(", ")}`);
            if (op === "from_layer") {
                if (a.source === undefined || a.source === null || a.source === "") throw new Error("from_layer needs source");
                const srcLayer = findLayer(ed, a.source);
                const ok = await ed.maskOp(l, op, { source: srcLayer });
                if (!ok) throw new Error(ed.status || `the mask operation ${op} did nothing`);
            } else {
                if (!l.maskPx && ["invert", "enable", "disable", "apply", "remove"].includes(op)) throw new Error(`${l.name} has no mask`);
                if ((op === "from_selection" || op === "hide_selection") && !ed.getBounds()) throw new Error("nothing is selected");
                // the switch standing that way already is no error: nothing changes, no step is pushed, the tab stays as it was
                if ((op === "enable" && !l.maskOff) || (op === "disable" && !!l.maskOff)) {
                    return { ...layerSummary(ed, l), changed: false, status: `${l.name}: the mask is already ${op === "disable" ? "switched off" : "on"}.` };
                }
                const ok = await ed.maskOp(l, op);
                if (!ok) throw new Error(ed.status || `the mask operation ${op} did nothing`);
            }
            touch(ed);
            return { ...layerSummary(ed, l), changed: true, status: ed.status };
        },
    },
};
