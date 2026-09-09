// Film pack: control points (U-Point style local adjustments). A filter layer holds a list of
// points; every point has a radius, a colour tolerance and adjustments (exposure, contrast,
// saturation, warmth, structure). A pixel's weight for a point is a radial falloff times the
// colour similarity to the colour sampled under the point when it was placed, so a point on
// the sky changes the sky and not the roof inside the circle. The tool (U) places, moves and
// resizes points on the canvas; the layer row shows sliders for the selected point.

import { PRELUDE, luma, clamp01, sstep, mix, loop, blur, num, pct, makeRunner, shader, makeCanvas } from "./common.js";

const FILTER_ID = "film.points";
const MAX_POINTS = 64;

const POINTS = shader("control points", { u_pts: "sampler2D", u_count: "int", u_blur: "sampler2D", u_useBlur: "bool", u_strength: "float" }, `
vec3 opp(vec3 c) { float L = luma(c); return vec3(L, c.r - L, c.b - L); }
vec4 shade(vec4 c, vec2 uv) {
    vec2 p = uv * u_size;
    vec3 o3 = opp(c.rgb);
    float ev = 0.0, con = 0.0, sat = 0.0, warm = 0.0, str = 0.0, wsum = 0.0;
    for (int i = 0; i < ${MAX_POINTS}; i++) {
        if (i >= u_count) break;
        vec4 a = texelFetch(u_pts, ivec2(0, i), 0);
        vec4 col = texelFetch(u_pts, ivec2(1, i), 0);
        vec4 adj = texelFetch(u_pts, ivec2(2, i), 0);
        vec4 adj2 = texelFetch(u_pts, ivec2(3, i), 0);
        float dist = distance(p, a.xy) / max(a.z, 1.0);
        float wd = 1.0 - sstep(0.25, 1.0, dist);
        if (wd <= 0.0) continue;
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
const sigmaOf = (tol) => 0.04 + clamp01(tol / 100) * 0.6;

/** The points as rows of a 4 x N float texture (pixel values scaled for previews). */
function pointsTexture(points, scale) {
    const n = Math.min(MAX_POINTS, points.length);
    const data = new Float32Array(4 * 4 * Math.max(1, n));
    for (let i = 0; i < n; i++) {
        const p = points[i], o = i * 16, c = p.color || [0.5, 0, 0];
        data[o] = p.x * scale; data[o + 1] = p.y * scale; data[o + 2] = Math.max(1, p.r * scale); data[o + 3] = sigmaOf(num(p.tol, 50));
        data[o + 4] = c[0]; data[o + 5] = c[1]; data[o + 6] = c[2]; data[o + 7] = 0;
        data[o + 8] = num(p.ev, 0); data[o + 9] = num(p.contrast, 0) / 100; data[o + 10] = num(p.sat, 0) / 100; data[o + 11] = num(p.warmth, 0) / 100;
        data[o + 12] = num(p.structure, 0) / 100; data[o + 13] = 0; data[o + 14] = 0; data[o + 15] = 0;
    }
    return { data, width: 4, height: Math.max(1, n), n };
}

/** Colour under image point x, y (3 x 3 mean) from the layer's cached input, else from `fallback()`. */
function sampleColor(layer, x, y, fallback) {
    const s = layer && layer._fxCache && layer._fxCache.sample;
    let canvas, sx, sy;
    if (s) { canvas = s.canvas; sx = s.sx; sy = s.sy; }
    else { canvas = fallback(); sx = 1; sy = 1; }
    const ctx = canvas.getContext("2d");
    const cx = Math.round(x * sx), cy = Math.round(y * sy);
    const x0 = Math.max(0, cx - 1), y0 = Math.max(0, cy - 1);
    const w = Math.min(3, canvas.width - x0), h = Math.min(3, canvas.height - y0);
    if (w <= 0 || h <= 0) return [0.5, 0, 0];
    const d = ctx.getImageData(x0, y0, w, h).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return opp(r / n / 255, g / n / 255, b / n / 255);
}

export function makePoints(scumble) {
    const run = makeRunner(scumble);
    const { ui } = scumble;
    let drag = null;   // { docId, layerId, mode, pt, start, orig, changed }

    // ---- the filter ---------------------------------------------------------------------------
    const filter = {
        id: "points",
        label: "Control points",
        params: [
            { key: "points", label: "Points", type: "custom", default: [] },
            { key: "strength", label: "Strength", min: 0, max: 100, step: 1, default: 100, unit: "%", keepPreset: true },
        ],
        control: (layer, param, callbacks) => buildControl(layer, param, callbacks),
        apply(src, p, info) {
            const cache = info.cache || (info.cache = {});
            // a small copy of the input for colour sampling when a point is placed (image coordinates via sx, sy)
            const scale = info.scale || 1;
            const imgW = src.width / scale, imgH = src.height / scale;
            const k = Math.min(1, 256 / Math.max(src.width, src.height));
            const small = makeCanvas(Math.round(src.width * k), Math.round(src.height * k));
            small.getContext("2d").drawImage(src, 0, 0, small.width, small.height);
            cache.sample = { canvas: small, sx: small.width / imgW, sy: small.height / imgH };
            const points = Array.isArray(p.points) ? p.points : [];
            const strength = pct(p.strength, 100);
            if (!points.length || strength <= 0) return src;
            const tex = pointsTexture(points, scale);
            const useBlur = points.some((q) => num(q.structure, 0) !== 0);
            const b = useBlur ? blur(src, 4 * scale) : null;
            return run(POINTS, src, { u_pts: tex, u_count: tex.n, u_blur: b, u_useBlur: useBlur, u_strength: strength }, info, () => {
                const d = tex.data, n = tex.n;
                return loop(src, (c, x, y, j, g) => {
                    const px = x + 0.5, py = y + 0.5;
                    const o3 = opp(c[0], c[1], c[2]);
                    let ev = 0, con = 0, sat = 0, warm = 0, str = 0, wsum = 0;
                    for (let i = 0; i < n; i++) {
                        const o = i * 16;
                        const dist = Math.hypot(px - d[o], py - d[o + 1]) / Math.max(d[o + 2], 1);
                        const wd = 1 - sstep(0.25, 1, dist);
                        if (wd <= 0) continue;
                        const d0 = o3[0] - d[o + 4], d1 = o3[1] - d[o + 5], d2 = o3[2] - d[o + 6];
                        const dd = d0 * d0 + 4 * (d1 * d1 + d2 * d2);
                        const w = wd * Math.exp(-dd / (2 * d[o + 3] * d[o + 3]));
                        ev += w * d[o + 8]; con += w * d[o + 9]; sat += w * d[o + 10]; warm += w * d[o + 11]; str += w * d[o + 12]; wsum += w;
                    }
                    if (wsum <= 0) return;
                    const e = Math.pow(2, ev);
                    let r = c[0] * e, gg = c[1] * e, bb = c[2] * e;
                    const L = luma(r, gg, bb);
                    r = L + (r - L) * (1 + sat); gg = L + (gg - L) * (1 + sat); bb = L + (bb - L) * (1 + sat);
                    r = 0.5 + (r - 0.5) * (1 + con); gg = 0.5 + (gg - 0.5) * (1 + con); bb = 0.5 + (bb - 0.5) * (1 + con);
                    r *= 1 + warm / 3; bb *= 1 - warm / 3;
                    if (useBlur) { const dL = luma(c[0], c[1], c[2]) - luma(g[0], g[1], g[2]); r += dL * str * 1.5; gg += dL * str * 1.5; bb += dL * str * 1.5; }
                    c[0] = mix(c[0], clamp01(r), strength); c[1] = mix(c[1], clamp01(gg), strength); c[2] = mix(c[2], clamp01(bb), strength);
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
        const pt = { id, x: Math.round(x), y: Math.round(y), r: Math.round(r), tol: 50, ev: 0, contrast: 0, sat: 0, warmth: 0, structure: 0, ...attrs };
        pt.color = attrs.color || sampleColor(layer, pt.x, pt.y, () => doc.flatten());
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
            const q = points[i], d = Math.hypot(ev.x - q.x, ev.y - q.y);
            if (Math.abs(d - q.r) < tol) return { pt: q, mode: "resize" };
            if (d < Math.max(tol * 1.5, q.r * 0.12)) return { pt: q, mode: "move" };
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
                    drag = { docId: doc.id, layerId: layer.id, mode: h.mode, ptId: h.pt.id, start: [ev.x, ev.y], orig: { x: h.pt.x, y: h.pt.y, r: h.pt.r }, changed: false };
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
            drag = { docId: doc.id, layerId: layer.id, mode: "new", ptId: pt.id, start: [ev.x, ev.y], orig: { x: pt.x, y: pt.y, r: pt.r }, changed: true };
            doc.status(`Point ${pt.id} added: drag to set its size, then adjust it in the layer row.`);
        },
        onMove(doc, ev) {
            if (!drag || drag.docId !== doc.id) return;
            const layer = doc.rawLayer(drag.layerId);
            const points = (layer.params.points || []).map((q) => ({ ...q }));
            const pt = points.find((q) => q.id === drag.ptId);
            if (!pt) return;
            const dx = ev.x - drag.start[0], dy = ev.y - drag.start[1];
            if (drag.mode === "move") { pt.x = Math.round(drag.orig.x + dx); pt.y = Math.round(drag.orig.y + dy); }
            else {
                const d = Math.hypot(ev.x - pt.x, ev.y - pt.y);
                if (drag.mode === "new" && d < 6) return;
                pt.r = Math.max(4, Math.round(d));
            }
            drag.changed = true;
            doc.setFilterParams(layer.id, { points }, { preview: true });
            doc.status(`Point ${pt.id}: ${pt.x}, ${pt.y}, radius ${pt.r} px`);
        },
        onUp(doc) {
            if (!drag || drag.docId !== doc.id) return;
            const layer = doc.rawLayer(drag.layerId);
            if (drag.changed) {
                const points = (layer.params.points || []).map((q) => ({ ...q }));
                if (drag.mode === "move") { const pt = points.find((q) => q.id === drag.ptId); if (pt) pt.color = sampleColor(layer, pt.x, pt.y, () => doc.flatten()); }
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
            if (ev.key === "Escape" && layer._fpSel != null) { layer._fpSel = null; doc.editor.renderLayers(); doc.draw(); return true; }
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
                ctx.strokeStyle = sel ? "#ffd166" : "rgba(255,255,255,0.9)";
                ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 3 * view.dpr;
                ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, Math.PI * 2); ctx.stroke();
                if (sel) { ctx.setLineDash([4 * lw, 4 * lw]); ctx.beginPath(); ctx.arc(q.x, q.y, q.r * 0.25, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
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
    const SLIDERS = [
        ["r", "Size", 4, 4000, 1, "px"],
        ["tol", "Tolerance", 0, 100, 1, "%"],
        ["ev", "Exposure", -2, 2, 0.05, " EV"],
        ["contrast", "Contrast", -100, 100, 1, ""],
        ["sat", "Saturation", -100, 100, 1, ""],
        ["warmth", "Warmth", -100, 100, 1, ""],
        ["structure", "Structure", -100, 100, 1, ""],
    ];

    function buildControl(layer, param, callbacks) {
        const wrap = ui.el("div", "film-points");
        for (const evn of ["click", "pointerdown", "dblclick", "keydown"]) wrap.addEventListener(evn, callbacks.stop);
        const points = Array.isArray(layer.params.points) ? layer.params.points : [];
        const redraw = () => { for (const e of scumble.host.editors()) if (e.layers.includes(layer)) { e.draw(); break; } };
        const rerender = () => { for (const e of scumble.host.editors()) if (e.layers.includes(layer)) { e.renderLayers(); break; } };
        if (!points.length) {
            wrap.appendChild(ui.el("div", "shell-help", "No points yet: pick the Control point tool (U) and click on the image. Drag while placing to set the size."));
            return wrap;
        }
        const chips = ui.el("div", "film-chips");
        for (const q of points) {
            const b = ui.el("button", "film-chip" + (q.id === layer._fpSel ? " film-chip-on" : ""), String(q.id));
            b.type = "button";
            b.title = `Point ${q.id} at ${q.x}, ${q.y}, radius ${q.r} px`;
            b.addEventListener("click", () => { layer._fpSel = q.id; rerender(); redraw(); });
            chips.appendChild(b);
        }
        wrap.appendChild(chips);
        const sel = selected(layer);
        if (!sel) { wrap.appendChild(ui.el("div", "shell-help", "Click a number (or a point on the image) to edit it.")); return wrap; }
        const maxR = Math.max(200, Math.round(Math.max(...points.map((q) => q.r), 1) * 2));
        for (const [key, label, min, max0, step, unit] of SLIDERS) {
            const max = key === "r" ? Math.max(maxR, sel.r) : max0;
            const row = ui.slider(label, { min, max, step, value: num(sel[key], key === "tol" ? 50 : 0), unit }, (value, final) => {
                callbacks.begin();
                const pts = (layer.params.points || []).map((q) => (q.id === sel.id ? { ...q, [key]: value } : q));
                layer.params.points = pts;
                if (final) callbacks.commit(); else callbacks.preview();
                if (key === "r") redraw();
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
                radius: { type: "number", description: "radius in pixels (default 10 % of the long side)" },
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
                const layer = pointsLayer(doc, { create: true });
                if (!layer) throw new Error("could not create the control points layer");
                const { points, pt } = addPoint(doc, layer, +a.x, +a.y, a.radius != null ? +a.radius : defaultRadius(doc), {
                    tol: a.tolerance != null ? +a.tolerance : 50, ev: num(a.exposure, 0), contrast: num(a.contrast, 0), sat: num(a.saturation, 0), warmth: num(a.warmth, 0), structure: num(a.structure, 0),
                });
                const summary = doc.setFilterParams(layer.id, { points });
                doc.editor.renderLayers();
                return { layer: summary.id, point: pt, points: points.length };
            },
        },
    };

    return { filter, tool, command, reset: () => { drag = null; } };
}
