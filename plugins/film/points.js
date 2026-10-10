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
        hint: "Control points: click adds a point (drag to size it), drag the centre to move, the ring to resize, Delete removes it. Sliders for the point are in its layer row.",
        drawAlways: true,
        onDown(doc, ev) {
            if (!doc.loaded) return;
            const view = viewOf(doc);
            let layer = pointsLayer(doc);
            if (layer) {
                const h = hitTest(layer, ev, view);
                if (h) {
                    layer._fpSel = h.pt.id;
                    const dragMode = h.mode === "ring" ? "r" : h.mode;
                    drag = {
                        docId: doc.id,
                        layerId: layer.id,
                        mode: dragMode,
                        ptId: h.pt.id,
                        start: [ev.x, ev.y],
                        orig: { x: h.pt.x, y: h.pt.y, r: h.pt.r, ry: h.pt.ry, angle: h.pt.angle },
                        changed: false,
                    };
                    doc.editor.activeLayerId = layer.id;
                    doc.editor.renderLayers();
                    doc.draw();
                    return;
                }
            }
            if (!ev.inside) return;
            if (!layer) layer = pointsLayer(doc, { create: true });
            if (!layer) return;
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
            if (!drag || drag.docId !== doc.id) return;
            const layer = doc.rawLayer(drag.layerId);
            const points = (layer.params.points || []).map((q) => ({ ...q }));
            const pt = points.find((q) => q.id === drag.ptId);
            if (!pt) return;
            const dx = ev.x - drag.start[0], dy = ev.y - drag.start[1];
            if (drag.mode === "move") {
                pt.x = Math.round(drag.orig.x + dx);
                pt.y = Math.round(drag.orig.y + dy);
            } else if (drag.mode === "new") {
                const ex = ev.x - pt.x, ey = ev.y - pt.y;
                const d = Math.hypot(ex, ey);
                if (d < 6) return;
                pt.r = Math.max(4, Math.round(d));
                if (pt.shape === "ellipse") {
                    pt.angle = Math.round((Math.atan2(ey, ex) * 180 / Math.PI) * 10) / 10;
                    pt.ry = Math.max(2, Math.round(0.6 * pt.r * 10) / 10);
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
            const info = pt.shape === "ellipse"
                ? `Point ${pt.id}: ${pt.x}, ${pt.y}, r ${pt.r} px, ry ${pt.ry} px, angle ${pt.angle}\u00B0`
                : `Point ${pt.id}: ${pt.x}, ${pt.y}, radius ${pt.r} px`;
            doc.status(info);
        },
        onUp(doc) {
            if (!drag || drag.docId !== doc.id) return;
            const layer = doc.rawLayer(drag.layerId);
            if (drag.changed) {
                const points = (layer.params.points || []).map((q) => ({ ...q }));
                if (drag.mode === "move") {
                    const pt = points.find((q) => q.id === drag.ptId);
                    if (pt) pt.color = sampleColor(doc, layer, pt.x, pt.y);
                }
                doc.setFilterParams(layer.id, { points });
            }
            drag = null;
            doc.editor.renderLayers();
            doc.draw();
        },
        onKey(doc, ev) {
            const layer = pointsLayer(doc);
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
            if (!layer || !layer.visible) return;
            const activeLayer = doc.editor.activeLayer && doc.editor.activeLayer();
            if (!view.active && activeLayer !== layer) return;
            const points = Array.isArray(layer.params.points) ? layer.params.points : [];
            const s = view.scale, lw = 1.5 * view.dpr / s;
            ctx.lineWidth = lw;
            ctx.font = `${12 * view.dpr / s}px system-ui, sans-serif`;
            ctx.textBaseline = "middle";
            ctx.textAlign = "center";
            for (const q of points) {
                const sel = q.id === layer._fpSel;
                const angleRad = ((q.angle || 0) * Math.PI) / 180;
                const ry = q.shape === "ellipse" ? (q.ry != null ? q.ry : Math.round(0.6 * q.r)) : q.r;
                ctx.strokeStyle = sel ? "#ffd166" : "rgba(255,255,255,0.9)";
                ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 3 * view.dpr;
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
                const cr = 9 * view.dpr / s;
                ctx.fillStyle = sel ? "#ffd166" : "rgba(255,255,255,0.9)";
                ctx.beginPath(); ctx.arc(q.x, q.y, cr, 0, Math.PI * 2); ctx.fill();
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
        for (const s of ["circle", "ellipse"]) {
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
            ["r", "Size", 4, 4000, 1, "px"],
            ...(sel.shape === "ellipse" ? [
                ["ry", "Height", 1, 4000, 1, "px"],
                ["angle", "Angle", -180, 180, 1, "\u00B0"],
            ] : []),
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
            description: "Add a control point (local adjustment) to the control points layer (the active one, the topmost one, or a new one). Weights: radial falloff times colour similarity to the pixel under the point.",
            params: {
                x: { type: "number", description: "centre x in image pixels", required: true },
                y: { type: "number", description: "centre y in image pixels", required: true },
                shape: { type: "string", enum: ["circle", "ellipse"], description: "point shape (default circle)" },
                radius: { type: "number", description: "radius in pixels (default 10 % of the long side)" },
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
                if (shape !== "circle" && shape !== "ellipse") {
                    throw new Error("unknown shape: " + shape);
                }
                const layer = pointsLayer(doc, { create: true });
                if (!layer) throw new Error("could not create the control points layer");
                const r = a.radius != null ? +a.radius : defaultRadius(doc);
                const ry = a.height != null ? +a.height : Math.round(0.6 * r);
                const angle = a.angle != null ? +a.angle : 0;
                const soft = a.softness != null ? +a.softness : 75;
                const x = Number.isFinite(+a.x) ? +a.x : Math.round((doc.width || 512) / 2);
                const y = Number.isFinite(+a.y) ? +a.y : Math.round((doc.height || 384) / 2);
                const { points, pt } = addPoint(doc, layer, x, y, r, {
                    shape,
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

    return { filter, tool, command, follow, reset: () => { drag = null; } };
}
