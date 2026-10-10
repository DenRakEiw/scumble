// Film pack: control points (U-Point style local adjustments). A filter layer holds a list of
// points; every point has a radius, a colour tolerance and adjustments (exposure, contrast,
// saturation, warmth, structure). A pixel's weight for a point is a radial falloff times the
// colour similarity to the colour sampled under the point when it was placed, so a point on
// the sky changes the sky and not the roof inside the circle. The tool (U) places, moves and
// resizes points on the canvas; the layer row shows sliders for the selected point.

import { luma, loop, blur, num, pct, makeRunner, shader } from "./common.js";
import {
    normalisePoint,
    innerOf,
    pointsTexture2,
    pointsPixel,
    SHAPE_GLSL,
    mapShape,
    handlesOf,
    hitShape,
    interiorAnchor,
    lineFromDrag,
} from "./shapes.js";

const FILTER_ID = "film.points";
const MAX_POINTS = 64;

const POINTS = shader("control points", { u_pts: "sampler2D", u_count: "int", u_blur: "sampler2D", u_useBlur: "bool", u_strength: "float", u_origin: "vec2" }, `
${SHAPE_GLSL}
vec3 opp(vec3 c) { float L = luma(c); return vec3(L, c.r - L, c.b - L); }
vec4 shade(vec4 c, vec2 uv) {
    vec2 p = uv * u_size + u_origin;   // the pass's pixel in the image's pixels at this scale (C6 c1 review)
    vec3 o3 = opp(c.rgb);
    float ev = 0.0, con = 0.0, sat = 0.0, warm = 0.0, str = 0.0, wsum = 0.0;
    for (int i = 0; i < ${MAX_POINTS}; i++) {
        if (i >= u_count) break;
        float wd = shapeWeight(p, i);
        if (wd <= 0.0) continue;
        vec4 a = texelFetch(u_pts, ivec2(0, i), 0);
        vec4 col = texelFetch(u_pts, ivec2(1, i), 0);
        vec4 adj = texelFetch(u_pts, ivec2(2, i), 0);
        vec4 adj2 = texelFetch(u_pts, ivec2(3, i), 0);
        vec3 dc = o3 - col.xyz;
        float d2 = dc.x * dc.x + 4.0 * (dc.y * dc.y + dc.z * dc.z);
        float w = wd * exp(-d2 / (2.0 * a.w * a.w));
        ev += w * adj.x; con += w * adj.y; sat += w * adj.z; warm += w * adj.w; str += w * adj2.x; wsum += w;
    }
    if (wsum <= 0.0) return c;
    vec3 o = c.rgb * exp2(ev);
    float L = luma(o);
    o = L + (o - L) * (1.0 + sat);
    o = 0.5 + (o - 0.5) * (1.0 + con);
    o *= vec3(1.0 + warm / 3.0, 1.0, 1.0 - warm / 3.0);
    if (u_useBlur) { float dL = luma(c.rgb) - luma(texture(u_blur, uv).rgb); o += dL * str * 1.5; }
    return vec4(mix(c.rgb, sat3(o), u_strength), c.a);
}`);

const opp = (r, g, b) => { const L = luma(r, g, b); return [L, r - L, b - L]; };

/**
 * The colour a point compares every pixel with: the 3 x 3 mean (2 x 2 at a corner) under image point x, y of the
 * points layer's input, the picture of every layer below it, at full resolution (C6 c1). Read as an exact box of that
 * picture: padded as far as the filters below say they reach, or, below a filter no margin can give (a vignette,
 * normalise, a frame, a light leak, the film look's halation: their picture depends on the whole image), cut out of
 * the whole flatten below the points layer. A box padded by a fixed 128 px gave a point under a vignette near the
 * corner a colour 40 levels off (the C6 c1 review). It used to come from a 256 px copy of the input the last
 * full-resolution render had left (stale after any change below), or else from the whole flattened picture with the
 * points' own effect and the layers above.
 */
function sampleColor(doc, layer, x, y) {
    const cx = Math.round(x), cy = Math.round(y);
    const x0 = Math.max(0, cx - 1), y0 = Math.max(0, cy - 1);
    const x1 = Math.min(doc.width, cx + 2), y1 = Math.min(doc.height, cy + 2);
    if (x1 <= x0 || y1 <= y0) return [0.5, 0, 0];
    const canvas = doc.flatten({ box: [x0, y0, x1, y1], below: layer.id, exact: true });
    const d = canvas.getContext("2d").getImageData(0, 0, x1 - x0, y1 - y0).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return opp(r / n / 255, g / n / 255, b / n / 255);
}

/** The old-to-new matrix of a quarter turn or mirror `op` of a W x H picture (1 clockwise, -1, 2, "h", "v"), or null. */
function turnMatrix(op, W, H) {
    if (op === 1) return [0, 1, -1, 0, H, 0];
    if (op === -1) return [0, -1, 1, 0, 0, W];
    if (op === 2) return [-1, 0, 0, -1, W, H];
    if (op === "h") return [-1, 0, 0, 1, W, 0];
    if (op === "v") return [1, 0, 0, -1, 0, H];
    return null;
}

/**
 * The old-to-new image matrix [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f) of a "geometry" event
 * (PLAN_0_1_31 S7: a turn, crop, extend, resize or straighten): its `m`, or for an editor that only sends 23a's `op`,
 * the turn's; null for anything else (an unknown op is never taken for a turn).
 */
export function geometryMatrix(ev) {
    const finite = (v) => typeof v === "number" && Number.isFinite(v);
    const m = ev && Array.isArray(ev.m) && ev.m.length === 6 && ev.m.every(finite) ? ev.m : null;
    if (m && Math.abs(m[0] * m[3] - m[1] * m[2]) > 1e-12) return m.slice();
    if (!ev || !ev.from || (ev.kind != null && ev.kind !== "turn") || !finite(ev.from.width) || !finite(ev.from.height)) return null;
    return turnMatrix(ev.op, ev.from.width, ev.from.height);
}

export function makePoints(scumble) {
    const run = makeRunner(scumble);
    const { ui } = scumble;
    let drag = null;   // { docId, layerId, mode, pt, start, orig, changed }
    let drawing = null; // { pts: number[][], lastClickTime: number, lastClickPos: [number, number], cursor?: [number, number] }
    let newShape = "circle";

    // ---- the filter ---------------------------------------------------------------------------
    const filter = {
        id: "points",
        label: "Control points",
        params: [
            { key: "points", label: "Points", type: "custom", default: [] },
            { key: "strength", label: "Strength", min: 0, max: 100, step: 1, default: 100, unit: "%", keepPreset: true },
        ],
        control: (layer, param, callbacks) => buildControl(layer, param, callbacks),
        // its structure blur (4 px); 0 without it: the points are placed by `info.origin`, so a pixel's result does not depend on the pass
        reach: (p) => (Array.isArray(p.points) && p.points.some((q) => num(q.structure, 0) !== 0) ? 16 : 0),
        apply(src, p, info) {
            const scale = info.scale || 1;
            const points = Array.isArray(p.points) ? p.points.map((q) => normalisePoint(q)) : [];
            const strength = pct(p.strength, 100);
            if (!points.length || strength <= 0) return src;
            const tex = pointsTexture2(points, scale);
            const useBlur = points.some((q) => num(q.structure, 0) !== 0);
            const b = useBlur ? blur(src, 4 * scale) : null;
            // where the input's corner sits in the image, in its own pixels: a pass over a box or a view that does not start at
            // the origin placed every point that far off (C6 c1 review), and a box read over a point missed its effect
            const org = info.origin || [0, 0], ox = +org[0] || 0, oy = +org[1] || 0;
            return run(POINTS, src, { u_pts: tex, u_count: tex.n, u_blur: b, u_useBlur: useBlur, u_strength: strength, u_origin: [ox, oy] }, info, () => {
                const d = tex.data, n = tex.n;
                return loop(src, (c, x, y, j, g) => {
                    const px = x + 0.5 + ox, py = y + 0.5 + oy;
                    pointsPixel(c, px, py, d, n, useBlur, g, strength);
                }, b);
            });
        },
    };

    // ---- helpers shared by the tool, the control and the command ----------------------------
    function pointsLayer(doc, { create = false } = {}) {
        const ed = doc.editor;
        const active = ed.activeLayer && ed.activeLayer();
        if (active && active.kind === "filter" && active.filter === FILTER_ID) return active;
        for (let i = ed.layers.length - 1; i >= 0; i--) { const l = ed.layers[i]; if (l.kind === "filter" && l.filter === FILTER_ID) return l; }
        if (!create) return null;
        const l = ed.addFilterLayer(FILTER_ID);   // synchronous (doc.run would be a promise)
        if (!l) return null;
        l.name = "Control points";
        ed.renderLayers();
        return l;
    }

    function addPoint(doc, layer, x, y, r, attrs = {}) {
        const points = Array.isArray(layer.params.points) ? layer.params.points.slice() : [];
        const id = points.reduce((m, q) => Math.max(m, q.id || 0), 0) + 1;
        const shape = attrs.shape || newShape || "circle";
        const ry = attrs.ry != null ? Math.round(attrs.ry) : Math.round(0.6 * r);
        const angle = attrs.angle != null ? +attrs.angle : 0;
        const soft = attrs.soft != null ? +attrs.soft : 75;
        const pt = normalisePoint({
            id,
            shape,
            x: Math.round(x),
            y: Math.round(y),
            r: Math.round(r),
            ry,
            angle,
            soft,
            tol: 50,
            ev: 0,
            contrast: 0,
            sat: 0,
            warmth: 0,
            structure: 0,
            ...attrs,
        });
        pt.color = attrs.color || sampleColor(doc, layer, pt.x, pt.y);
        points.push(pt);
        layer._fpSel = id;
        return { points, pt };
    }

    function selected(layer) {
        const points = Array.isArray(layer.params.points) ? layer.params.points : [];
        return points.find((q) => q.id === layer._fpSel) || null;
    }

    // ---- the tool --------------------------------------------------------------------------------
    const defaultRadius = (doc) => Math.max(20, Math.round(Math.max(doc.width, doc.height) * 0.1));

    function hitTest(layer, ev, view) {
        const points = Array.isArray(layer.params.points) ? layer.params.points : [];
        const tol = 8 * view.dpr / view.scale;
        for (let i = points.length - 1; i >= 0; i--) {
            const q = points[i];
            const mode = hitShape(q, ev.x, ev.y, tol);
            if (mode) return { pt: q, mode };
        }
        return null;
    }

    const viewOf = (doc) => ({ scale: doc.editor.view.scale, dpr: window.devicePixelRatio || 1 });

    const tool = {
        id: "point",
        label: "Points",
        title: "Control points (film pack): click to add a local adjustment point, drag while placing to set its size; drag the centre to move, the ring to resize; Delete removes the selected point",
        icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 4v-2M12 22v-2M4 12h-2M22 12h-2"/></svg>',
        key: "U",
        hint: "Control points: click adds a point (drag to size it), drag the centre to move, handles to resize, Delete removes it. Sliders for the point are in its layer row.",
        drawAlways: true,
        onDown(doc, ev) {
            if (!doc.loaded) return;
            const view = viewOf(doc);
            let layer = pointsLayer(doc);

            if (drawing != null) {
                // Polygon creation in progress
                const dt = Date.now() - (drawing.lastClickTime || 0);
                const dp = Math.hypot(ev.x - drawing.lastClickPos[0], ev.y - drawing.lastClickPos[1]);
                const isDouble = dt < 300 && dp < 4;
                const dFirst = Math.hypot(ev.x - drawing.pts[0][0], ev.y - drawing.pts[0][1]);
                const isFirstNear = dFirst <= 8 * view.dpr / view.scale && drawing.pts.length >= 3;

                if (isDouble || isFirstNear) {
                    if (drawing.pts.length >= 3) {
                        const polyPts = drawing.pts.slice();
                        drawing = null;
                        if (!layer) layer = pointsLayer(doc, { create: true });
                        if (!layer) return;
                        const anc = interiorAnchor(polyPts);
                        const { points, pt } = addPoint(doc, layer, anc[0], anc[1], 20, { shape: "polygon", pts: polyPts });
                        doc.editor.activeLayerId = layer.id;
                        doc.setFilterParams(layer.id, { points });
                        doc.editor.renderLayers();
                        doc.draw();
                        doc.status(`Point ${pt.id} (polygon) added with ${polyPts.length} corners.`);
                    }
                    return;
                }
                if (drawing.pts.length < 16) {
                    drawing.pts.push([Math.round(ev.x), Math.round(ev.y)]);
                    drawing.lastClickTime = Date.now();
                    drawing.lastClickPos = [ev.x, ev.y];
                    doc.status(`Polygon point: ${drawing.pts.length} corners. Enter, double-click or first corner closes; Backspace drops corner.`);
                    doc.draw();
                } else {
                    doc.status("Polygon reaches maximum 16 corners. Enter or double-click to close.");
                }
                return;
            }

            if (layer) {
                const h = hitTest(layer, ev, view);
                if (h) {
                    layer._fpSel = h.pt.id;
                    const dragMode = h.mode === "ring" ? (h.pt.shape === "polygon" ? "move" : "r") : h.mode;
                    drag = {
                        docId: doc.id,
                        layerId: layer.id,
                        mode: dragMode,
                        ptId: h.pt.id,
                        start: [ev.x, ev.y],
                        orig: {
                            x: h.pt.x,
                            y: h.pt.y,
                            r: h.pt.r,
                            ry: h.pt.ry,
                            angle: h.pt.angle,
                            pts: h.pt.pts ? h.pt.pts.map((v) => [v[0], v[1]]) : null,
                        },
                        changed: false,
                    };
                    doc.editor.activeLayerId = layer.id;
                    doc.editor.renderLayers();
                    doc.draw();
                    return;
                }
            }
            if (!ev.inside) return;

            if (newShape === "polygon") {
                drawing = {
                    pts: [[Math.round(ev.x), Math.round(ev.y)]],
                    lastClickTime: Date.now(),
                    lastClickPos: [ev.x, ev.y],
                };
                doc.status("Polygon point: click next corner. Enter, double-click or first corner closes; Backspace drops corner; Escape cancels.");
                doc.draw();
                return;
            }

            if (!layer) layer = pointsLayer(doc, { create: true });
            if (!layer) return;

            if (newShape === "line") {
                const { points, pt } = addPoint(doc, layer, ev.x, ev.y, 20, { shape: "line", angle: 0 });
                doc.editor.activeLayerId = layer.id;
                doc.setFilterParams(layer.id, { points }, { preview: true });
                drag = {
                    docId: doc.id,
                    layerId: layer.id,
                    mode: "new_line",
                    ptId: pt.id,
                    start: [ev.x, ev.y],
                    orig: { x: pt.x, y: pt.y, r: pt.r, angle: pt.angle },
                    changed: true,
                };
                doc.status(`Point ${pt.id} (line) added: drag to set orientation and feather.`);
                return;
            }

            const { points, pt } = addPoint(doc, layer, ev.x, ev.y, defaultRadius(doc));
            doc.editor.activeLayerId = layer.id;
            doc.setFilterParams(layer.id, { points }, { preview: true });
            drag = {
                docId: doc.id,
                layerId: layer.id,
                mode: "new",
                ptId: pt.id,
                start: [ev.x, ev.y],
                orig: { x: pt.x, y: pt.y, r: pt.r, ry: pt.ry, angle: pt.angle },
                changed: true,
            };
            doc.status(`Point ${pt.id} added: drag to set its size, then adjust it in the layer row.`);
        },
        onMove(doc, ev) {
            if (drawing != null) {
                drawing.cursor = [ev.x, ev.y];
                doc.draw();
                return;
            }
            if (!drag || drag.docId !== doc.id) return;
            const layer = doc.rawLayer(drag.layerId);
            const points = (layer.params.points || []).map((q) => ({ ...q }));
            const pt = points.find((q) => q.id === drag.ptId);
            if (!pt) return;
            const dx = ev.x - drag.start[0], dy = ev.y - drag.start[1];
            if (drag.mode === "move") {
                pt.x = Math.round(drag.orig.x + dx);
                pt.y = Math.round(drag.orig.y + dy);
                if (pt.shape === "polygon" && Array.isArray(drag.orig.pts)) {
                    pt.pts = drag.orig.pts.map((v) => [Math.round(v[0] + dx), Math.round(v[1] + dy)]);
                }
            } else if (drag.mode === "new") {
                const ex = ev.x - pt.x, ey = ev.y - pt.y;
                const d = Math.hypot(ex, ey);
                if (d < 6) return;
                pt.r = Math.max(4, Math.round(d));
                if (pt.shape === "ellipse") {
                    pt.angle = Math.round((Math.atan2(ey, ex) * 180 / Math.PI) * 10) / 10;
                    pt.ry = Math.max(2, Math.round(0.6 * pt.r * 10) / 10);
                }
            } else if (drag.mode === "new_line") {
                const d = Math.hypot(ev.x - drag.start[0], ev.y - drag.start[1]);
                if (d >= 4) {
                    const line = lineFromDrag(drag.start, [ev.x, ev.y]);
                    pt.x = Math.round(line.x);
                    pt.y = Math.round(line.y);
                    pt.r = Math.max(1, Math.round(line.r));
                    pt.angle = Math.round(line.angle * 10) / 10;
                }
            } else if (drag.mode === "handleA") {
                const origA = ((drag.orig.angle || 0) * Math.PI) / 180;
                const B = [drag.orig.x + drag.orig.r * Math.cos(origA), drag.orig.y + drag.orig.r * Math.sin(origA)];
                const line = lineFromDrag([ev.x, ev.y], B);
                pt.x = Math.round(line.x);
                pt.y = Math.round(line.y);
                pt.r = Math.max(1, Math.round(line.r));
                pt.angle = Math.round(line.angle * 10) / 10;
            } else if (drag.mode === "handleB") {
                const origA = ((drag.orig.angle || 0) * Math.PI) / 180;
                const A = [drag.orig.x - drag.orig.r * Math.cos(origA), drag.orig.y - drag.orig.r * Math.sin(origA)];
                const line = lineFromDrag(A, [ev.x, ev.y]);
                pt.x = Math.round(line.x);
                pt.y = Math.round(line.y);
                pt.r = Math.max(1, Math.round(line.r));
                pt.angle = Math.round(line.angle * 10) / 10;
            } else if (drag.mode.startsWith("corner_")) {
                const idx = parseInt(drag.mode.slice(7), 10);
                if (pt.shape === "polygon" && Array.isArray(pt.pts) && pt.pts[idx]) {
                    pt.pts[idx] = [Math.round(ev.x), Math.round(ev.y)];
                }
            } else if (drag.mode === "r") {
                const ex = ev.x - pt.x, ey = ev.y - pt.y;
                const d = Math.hypot(ex, ey);
                pt.r = Math.max(4, Math.round(d));
                if (pt.shape === "ellipse") {
                    pt.angle = Math.round((Math.atan2(ey, ex) * 180 / Math.PI) * 10) / 10;
                }
            } else if (drag.mode === "ry") {
                if (pt.shape === "ellipse") {
                    const A = ((pt.angle || 0) * Math.PI) / 180;
                    const sinA = Math.sin(A), cosA = Math.cos(A);
                    const proj = -(ev.x - pt.x) * sinA + (ev.y - pt.y) * cosA;
                    pt.ry = Math.max(2, Math.round(Math.abs(proj) * 10) / 10);
                }
            }
            drag.changed = true;
            doc.setFilterParams(layer.id, { points }, { preview: true });
            let info = "";
            if (pt.shape === "ellipse") {
                info = `Point ${pt.id}: ${pt.x}, ${pt.y}, r ${pt.r} px, ry ${pt.ry} px, angle ${pt.angle}\u00B0`;
            } else if (pt.shape === "line") {
                info = `Point ${pt.id} (line): ${pt.x}, ${pt.y}, feather ${pt.r} px, angle ${pt.angle}\u00B0`;
            } else if (pt.shape === "polygon") {
                info = `Point ${pt.id} (polygon): ${pt.pts.length} corners, feather ${pt.r} px`;
            } else {
                info = `Point ${pt.id}: ${pt.x}, ${pt.y}, radius ${pt.r} px`;
            }
            doc.status(info);
        },
        onUp(doc) {
            if (!drag || drag.docId !== doc.id) return;
            const layer = doc.rawLayer(drag.layerId);
            if (drag.changed) {
                const points = (layer.params.points || []).map((q) => ({ ...q }));
                const pt = points.find((q) => q.id === drag.ptId);
                if (pt && (drag.mode === "move" || drag.mode === "new" || drag.mode === "new_line")) {
                    pt.color = sampleColor(doc, layer, pt.x, pt.y);
                }
                doc.setFilterParams(layer.id, { points });
            }
            drag = null;
            doc.editor.renderLayers();
            doc.draw();
        },
        onKey(doc, ev) {
            const layer = pointsLayer(doc);
            if (drawing != null) {
                if (ev.key === "Escape") {
                    drawing = null;
                    doc.status("Polygon creation cancelled.");
                    doc.draw();
                    return true;
                }
                if (ev.key === "Backspace") {
                    if (drawing.pts.length > 1) {
                        drawing.pts.pop();
                        doc.status(`Polygon: corner removed (${drawing.pts.length} remaining).`);
                        doc.draw();
                        return true;
                    }
                    drawing = null;
                    doc.status("Polygon creation cancelled.");
                    doc.draw();
                    return true;
                }
                if (ev.key === "Enter") {
                    if (drawing.pts.length >= 3) {
                        const polyPts = drawing.pts.slice();
                        drawing = null;
                        const l = layer || pointsLayer(doc, { create: true });
                        if (!l) return true;
                        const anc = interiorAnchor(polyPts);
                        const { points, pt } = addPoint(doc, l, anc[0], anc[1], 20, { shape: "polygon", pts: polyPts });
                        doc.editor.activeLayerId = l.id;
                        doc.setFilterParams(l.id, { points });
                        doc.editor.renderLayers();
                        doc.draw();
                        doc.status(`Point ${pt.id} (polygon) added with ${polyPts.length} corners.`);
                    } else {
                        doc.status("Polygon must have at least 3 corners.");
                    }
                    return true;
                }
            }

            if (!layer) return false;
            if (ev.key === "Delete" || ev.key === "Backspace") {
                const sel = selected(layer);
                if (!sel) return false;
                const points = (layer.params.points || []).filter((q) => q.id !== sel.id);
                layer._fpSel = points.length ? points[points.length - 1].id : null;
                doc.setFilterParams(layer.id, { points });
                doc.editor.renderLayers();
                doc.status(`Point ${sel.id} removed.`);
                return true;
            }
            if (ev.key === "Escape" && layer._fpSel != null) {
                layer._fpSel = null;
                doc.editor.renderLayers();
                doc.draw();
                return true;
            }
            return false;
        },
        draw(doc, ctx, view) {
            const layer = pointsLayer(doc);
            const activeLayer = doc.editor.activeLayer && doc.editor.activeLayer();
            const s = view.scale, lw = 1.5 * view.dpr / s;

            // Draw polygon in progress
            if (drawing && Array.isArray(drawing.pts) && drawing.pts.length) {
                ctx.lineWidth = lw;
                ctx.strokeStyle = "#ffd166";
                ctx.beginPath();
                ctx.moveTo(drawing.pts[0][0], drawing.pts[0][1]);
                for (let i = 1; i < drawing.pts.length; i++) {
                    ctx.lineTo(drawing.pts[i][0], drawing.pts[i][1]);
                }
                if (drawing.cursor) {
                    ctx.lineTo(drawing.cursor[0], drawing.cursor[1]);
                }
                ctx.stroke();

                const hr = 4.5 * view.dpr / s;
                for (let i = 0; i < drawing.pts.length; i++) {
                    const ptx = drawing.pts[i][0], pty = drawing.pts[i][1];
                    ctx.fillStyle = i === 0 ? "#ff5555" : "#ffd166";
                    ctx.beginPath();
                    ctx.arc(ptx, pty, hr, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            if (!layer || !layer.visible) return;
            if (!view.active && activeLayer !== layer) return;
            const points = Array.isArray(layer.params.points) ? layer.params.points : [];
            ctx.lineWidth = lw;
            ctx.font = `${12 * view.dpr / s}px system-ui, sans-serif`;
            ctx.textBaseline = "middle";
            ctx.textAlign = "center";

            for (const q of points) {
                const sel = q.id === layer._fpSel;
                const angleRad = ((q.angle || 0) * Math.PI) / 180;
                ctx.strokeStyle = sel ? "#ffd166" : "rgba(255,255,255,0.9)";
                ctx.shadowColor = "rgba(0,0,0,0.6)";
                ctx.shadowBlur = 3 * view.dpr;

                if (q.shape === "circle" || q.shape === "ellipse") {
                    const ry = q.shape === "ellipse" ? (q.ry != null ? q.ry : Math.round(0.6 * q.r)) : q.r;
                    ctx.beginPath();
                    ctx.ellipse(q.x, q.y, q.r, ry, angleRad, 0, Math.PI * 2);
                    ctx.stroke();
                    if (sel) {
                        const inner = innerOf(q);
                        ctx.setLineDash([4 * lw, 4 * lw]);
                        ctx.beginPath();
                        ctx.ellipse(q.x, q.y, q.r * inner, ry * inner, angleRad, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.setLineDash([]);
                        const hdls = handlesOf(q);
                        const hr = 4.5 * view.dpr / s;
                        for (const h of hdls) {
                            if (h.id === "move") continue;
                            ctx.fillStyle = "#ffd166";
                            ctx.beginPath();
                            ctx.arc(h.x, h.y, hr, 0, Math.PI * 2);
                            ctx.fill();
                        }
                    }
                } else if (q.shape === "polygon" && Array.isArray(q.pts) && q.pts.length >= 3) {
                    ctx.beginPath();
                    ctx.moveTo(q.pts[0][0], q.pts[0][1]);
                    for (let i = 1; i < q.pts.length; i++) {
                        ctx.lineTo(q.pts[i][0], q.pts[i][1]);
                    }
                    ctx.closePath();
                    ctx.stroke();
                    if (sel) {
                        const hr = 4.5 * view.dpr / s;
                        for (let i = 0; i < q.pts.length; i++) {
                            ctx.fillStyle = "#ffd166";
                            ctx.beginPath();
                            ctx.arc(q.pts[i][0], q.pts[i][1], hr, 0, Math.PI * 2);
                            ctx.fill();
                        }
                    }
                } else if (q.shape === "line") {
                    const cosA = Math.cos(angleRad), sinA = Math.sin(angleRad);
                    const r = Math.max(1, q.r || 1);
                    const T = Math.max(0.5, (r * (q.soft == null ? 75 : q.soft)) / 100);
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(0, 0, doc.width, doc.height);
                    ctx.clip();
                    const diag = Math.hypot(doc.width, doc.height);
                    const perpX = -sinA, perpY = cosA;

                    // Centre line
                    ctx.beginPath();
                    ctx.moveTo(q.x - diag * perpX, q.y - diag * perpY);
                    ctx.lineTo(q.x + diag * perpX, q.y + diag * perpY);
                    ctx.stroke();

                    // Dashed parallels at +-T
                    ctx.setLineDash([4 * lw, 4 * lw]);
                    ctx.beginPath();
                    ctx.moveTo(q.x + T * cosA - diag * perpX, q.y + T * sinA - diag * perpY);
                    ctx.lineTo(q.x + T * cosA + diag * perpX, q.y + T * sinA + diag * perpY);
                    ctx.moveTo(q.x - T * cosA - diag * perpX, q.y - T * sinA - diag * perpY);
                    ctx.lineTo(q.x - T * cosA + diag * perpX, q.y - T * sinA + diag * perpY);
                    ctx.stroke();
                    ctx.setLineDash([]);

                    // Direction segment from handle A to handle B
                    ctx.beginPath();
                    ctx.moveTo(q.x - r * cosA, q.y - r * sinA);
                    ctx.lineTo(q.x + r * cosA, q.y + r * sinA);
                    ctx.stroke();

                    if (sel) {
                        const hr = 4.5 * view.dpr / s;
                        ctx.fillStyle = "#ffd166";
                        ctx.beginPath();
                        ctx.arc(q.x - r * cosA, q.y - r * sinA, hr, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.beginPath();
                        ctx.arc(q.x + r * cosA, q.y + r * sinA, hr, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    ctx.restore();
                }

                // Center badge with point ID
                const cr = 9 * view.dpr / s;
                ctx.fillStyle = sel ? "#ffd166" : "rgba(255,255,255,0.9)";
                ctx.beginPath();
                ctx.arc(q.x, q.y, cr, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;
                ctx.fillStyle = "#111";
                ctx.fillText(String(q.id), q.x, q.y + 0.5 * view.dpr / s);
            }
        },
    };

    // ---- the control in the layer row ---------------------------------------------------------------
    function buildControl(layer, param, callbacks) {
        const wrap = ui.el("div", "film-points");
        for (const evn of ["click", "pointerdown", "dblclick", "keydown"]) wrap.addEventListener(evn, callbacks.stop);
        const points = Array.isArray(layer.params.points) ? layer.params.points : [];
        const redraw = () => { for (const e of scumble.host.editors()) if (e.layers.includes(layer)) { e.draw(); break; } };
        const rerender = () => { for (const e of scumble.host.editors()) if (e.layers.includes(layer)) { e.renderLayers(); break; } };

        const newRow = ui.el("div", "film-head");
        const newLbl = ui.el("span", "film-note", "New: ");
        newRow.appendChild(newLbl);
        for (const s of ["circle", "ellipse", "polygon", "line"]) {
            const b = ui.el("button", "film-shape-btn" + (newShape === s ? " film-shape-btn-on" : ""), s);
            b.type = "button";
            b.addEventListener("click", () => {
                newShape = s;
                rerender();
            });
            newRow.appendChild(b);
        }
        wrap.appendChild(newRow);

        if (!points.length) {
            wrap.appendChild(ui.el("div", "shell-help", "No points yet: pick the Control point tool (U) and click on the image. Drag while placing to set the size."));
            return wrap;
        }
        const chips = ui.el("div", "film-chips");
        for (const q of points) {
            const b = ui.el("button", "film-chip" + (q.id === layer._fpSel ? " film-chip-on" : ""), String(q.id));
            b.type = "button";
            const f1 = (v) => Math.round(num(v, 0) * 10) / 10;   // a resize or a straighten leaves fractions
            b.title = `Point ${q.id} at ${f1(q.x)}, ${f1(q.y)}, radius ${f1(q.r)} px`;
            b.addEventListener("click", () => { layer._fpSel = q.id; rerender(); redraw(); });
            chips.appendChild(b);
        }
        wrap.appendChild(chips);
        const sel = selected(layer);
        if (!sel) { wrap.appendChild(ui.el("div", "shell-help", "Click a number (or a point on the image) to edit it.")); return wrap; }
        const maxR = Math.max(200, Math.round(Math.max(...points.map((q) => q.r), 1) * 2));
        const sliders = [
            ...(sel.shape === "line" ? [
                ["r", "Feather", 1, 4000, 1, "px"],
                ["angle", "Angle", -180, 180, 1, "\u00B0"],
            ] : sel.shape === "polygon" ? [
                ["r", "Feather", 0, 4000, 1, "px"],
            ] : [
                ["r", "Size", 4, 4000, 1, "px"],
                ...(sel.shape === "ellipse" ? [
                    ["ry", "Height", 1, 4000, 1, "px"],
                    ["angle", "Angle", -180, 180, 1, "\u00B0"],
                ] : []),
            ]),
            ["soft", "Softness", 0, 100, 1, "%"],
            ["tol", "Tolerance", 0, 100, 1, "%"],
            ["ev", "Exposure", -2, 2, 0.05, " EV"],
            ["contrast", "Contrast", -100, 100, 1, ""],
            ["sat", "Saturation", -100, 100, 1, ""],
            ["warmth", "Warmth", -100, 100, 1, ""],
            ["structure", "Structure", -100, 100, 1, ""],
        ];
        for (const [key, label, min, max0, step, unit] of sliders) {
            const max = (key === "r" || key === "ry") ? Math.max(maxR, sel[key] || 1) : max0;
            const defVal = key === "soft" ? 75 : key === "tol" ? 50 : key === "ry" ? Math.round(0.6 * sel.r) : 0;
            const row = ui.slider(label, { min, max, step, value: num(sel[key], defVal), unit }, (value, final) => {
                callbacks.begin();
                const pts = (layer.params.points || []).map((q) => (q.id === sel.id ? { ...q, [key]: value } : q));
                layer.params.points = pts;
                if (final) callbacks.commit(); else callbacks.preview();
                if (key === "r" || key === "ry" || key === "angle" || key === "soft") redraw();
            });
            row.classList.add("film-row");
            wrap.appendChild(row);
        }
        const del = ui.button("Remove point", `Remove point ${sel.id}`, () => {
            callbacks.begin();
            const pts = (layer.params.points || []).filter((q) => q.id !== sel.id);
            layer.params.points = pts;
            layer._fpSel = pts.length ? pts[pts.length - 1].id : null;
            callbacks.commit();
            rerender(); redraw();
        });
        del.classList.add("film-del");
        wrap.appendChild(del);
        return wrap;
    }

    // ---- command ---------------------------------------------------------------------------------
    const command = {
        name: "add_point",
        def: {
            description: "Add a control point (local adjustment) to the control points layer (the active one, the topmost one, or a new one). Weights: shape falloff times colour similarity to the pixel under the point.",
            params: {
                x: { type: "number", description: "centre x in image pixels" },
                y: { type: "number", description: "centre y in image pixels" },
                shape: { type: "string", enum: ["circle", "ellipse", "polygon", "line"], description: "point shape (default circle)" },
                vertices: { type: "array", items: { type: "array" }, description: "polygon: 3 to 16 [x, y] corners in image px" },
                radius: { type: "number", description: "radius or feather in pixels (default 10 % of the long side)" },
                height: { type: "number", description: "ellipse: the second radius in px (default 60 % of radius)" },
                angle: { type: "number", description: "degrees, clockwise from +x in image coordinates" },
                softness: { type: "number", description: "diffusion 0..100 (default 75)" },
                tolerance: { type: "number", description: "colour tolerance 0..100 (default 50; low = only the colour under the point)" },
                exposure: { type: "number", description: "EV -2..2" },
                contrast: { type: "number", description: "-100..100" },
                saturation: { type: "number", description: "-100..100" },
                warmth: { type: "number", description: "-100..100" },
                structure: { type: "number", description: "-100..100 (local detail, negative softens)" },
            },
            needsImage: true,
            scope: "doc",
            run(doc, a) {
                const shape = a.shape || "circle";
                if (shape !== "circle" && shape !== "ellipse" && shape !== "polygon" && shape !== "line") {
                    throw new Error("unknown shape: " + shape);
                }
                let pts = null;
                if (shape === "polygon") {
                    if (!Array.isArray(a.vertices) || a.vertices.length < 3 || a.vertices.length > 16) {
                        throw new Error("polygon must have 3 to 16 vertices");
                    }
                    pts = a.vertices.map((v) => [Number.isFinite(+v[0]) ? +v[0] : 0, Number.isFinite(+v[1]) ? +v[1] : 0]);
                }
                const layer = pointsLayer(doc, { create: true });
                if (!layer) throw new Error("could not create the control points layer");
                const r = a.radius != null ? +a.radius : defaultRadius(doc);
                const ry = a.height != null ? +a.height : Math.round(0.6 * r);
                const angle = a.angle != null ? +a.angle : 0;
                const soft = a.softness != null ? +a.softness : 75;
                const anc = pts ? interiorAnchor(pts) : null;
                const x = Number.isFinite(+a.x) ? +a.x : (anc ? anc[0] : Math.round((doc.width || 512) / 2));
                const y = Number.isFinite(+a.y) ? +a.y : (anc ? anc[1] : Math.round((doc.height || 384) / 2));
                const { points, pt } = addPoint(doc, layer, x, y, r, {
                    shape,
                    pts,
                    ry,
                    angle,
                    soft,
                    tol: a.tolerance != null ? +a.tolerance : 50,
                    ev: num(a.exposure, 0),
                    contrast: num(a.contrast, 0),
                    sat: num(a.saturation, 0),
                    warmth: num(a.warmth, 0),
                    structure: num(a.structure, 0),
                });
                const summary = doc.setFilterParams(layer.id, { points });
                doc.editor.renderLayers();
                return { layer: summary.id, point: pt, points: points.length };
            },
        },
    };

    let CLIPBOARD = null;

    const copyCommand = {
        name: "copy_points",
        def: {
            description: "Copy control points from the active or topmost control points layer into the clipboard.",
            readOnly: true,
            params: {
                ids: { type: "array", items: { type: "integer" }, description: "point IDs to copy (copies all points if omitted)" },
            },
            needsImage: true,
            scope: "doc",
            run(doc, a) {
                const layer = pointsLayer(doc, { create: false });
                if (!layer || !layer.params || !Array.isArray(layer.params.points) || !layer.params.points.length) {
                    throw new Error("no control points to copy");
                }
                const pts = layer.params.points;
                const filterIds = Array.isArray(a.ids) && a.ids.length ? a.ids.map(Number) : null;
                const chosen = filterIds ? pts.filter((q) => filterIds.includes(q.id)) : pts;
                if (!chosen.length) throw new Error("no matching control points found");
                CLIPBOARD = {
                    points: JSON.parse(JSON.stringify(chosen)),
                    width: doc.width || 512,
                    height: doc.height || 384,
                };
                return { copied: chosen.length };
            },
        },
    };

    const pasteCommand = {
        name: "paste_points",
        def: {
            description: "Paste control points from the clipboard onto the control points layer (creating one if needed). Scales positions and sizes to match the destination picture.",
            params: {
                resample_color: { type: "boolean", description: "sample colour under each anchor in the destination picture (default true)" },
            },
            needsImage: true,
            scope: "doc",
            run(doc, a) {
                if (!CLIPBOARD || !Array.isArray(CLIPBOARD.points) || !CLIPBOARD.points.length) {
                    throw new Error("clipboard has no control points to paste");
                }
                const layer = pointsLayer(doc, { create: true });
                if (!layer) throw new Error("could not create the control points layer");
                const dw = doc.width || 512, dh = doc.height || 384;
                const sw = CLIPBOARD.width || dw, sh = CLIPBOARD.height || dh;
                const sx = dw / sw, sy = dh / sh;
                const sr = Math.sqrt(Math.abs(sx * sy));
                const m = [sx, 0, 0, sy, 0, 0];
                const existing = Array.isArray(layer.params.points) ? layer.params.points.slice() : [];
                let nextId = existing.reduce((max, q) => Math.max(max, q.id || 0), 0) + 1;
                const resample = a.resample_color !== false;
                const pasted = [];
                for (const orig of CLIPBOARD.points) {
                    const mapped = mapShape(orig, m, sr);
                    mapped.id = nextId++;
                    if (resample) {
                        mapped.color = sampleColor(doc, layer, mapped.x, mapped.y);
                    }
                    pasted.push(mapped);
                    existing.push(mapped);
                }
                layer._fpSel = pasted[pasted.length - 1].id;
                const summary = doc.setFilterParams(layer.id, { points: existing });
                doc.editor.renderLayers();
                doc.editor.draw();
                return { layer: summary.id, point: pasted[pasted.length - 1], points: existing.length, pasted: pasted.length };
            },
        },
    };

    /**
     * The whole picture changed its geometry (the "geometry" event, `m` its old-to-new matrix from `geometryMatrix`):
     * every control-points layer's points move with it, their radii scale by sqrt(|det m|). Points that land outside the
     * new picture stay (a crop keeps pixels outside too). Exact numbers, no rounding: a quarter turn gives what 23a's
     * turn did (H - y, x), a crop whole pixels, a resize or a straighten fractions. New params and point objects without
     * an undo step of their own: the change's step holds the old ones and an undo puts them back (it sends no event).
     */
    function follow(doc, m) {
        const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        for (const l of doc.layers()) {
            if (l.filter !== FILTER_ID) continue;
            const raw = doc.rawLayer(l.id);
            const pts = raw.params && Array.isArray(raw.params.points) ? raw.params.points : [];
            if (!pts.length) continue;
            raw.params = { ...raw.params, points: pts.map((q) => mapShape(normalisePoint(q), m, s)) };
            doc.refresh(l.id);
        }
    }

    return {
        filter,
        tool,
        command,
        commands: [command, copyCommand, pasteCommand],
        follow,
        reset: () => {
            drag = null;
            drawing = null;
        },
    };
}
