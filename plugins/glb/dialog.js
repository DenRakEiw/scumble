// The 3D dialog: the picture as the backdrop, the object rendered over it at preview size,
// drag turns the object, Shift+drag moves it, the wheel scales it, sliders for everything.
// A native <dialog>, so Escape closes it (the editor lets keys inside an open dialog through).

import { frameOf, framePlan } from "./render.js";

const SLIDERS = [
    ["x", "X", -0.5, 1.5, 0.005, (v) => Math.round(v * 100) + " %"],
    ["y", "Y", -0.5, 1.5, 0.005, (v) => Math.round(v * 100) + " %"],
    ["depth", "Distance", 0.3, 20, 0.05, (v) => v.toFixed(2)],
    ["scale", "Scale", 0.02, 8, 0.01, (v) => v.toFixed(2) + " ×"],
    ["rotX", "Tilt", -180, 180, 1, (v) => Math.round(v) + "°"],
    ["rotY", "Turn", -180, 180, 1, (v) => Math.round(v) + "°"],
    ["rotZ", "Roll", -180, 180, 1, (v) => Math.round(v) + "°"],
    ["fov", "Focal (fov)", 10, 120, 1, (v) => Math.round(v) + "°"],
    ["lightAz", "Light from", -180, 180, 1, (v) => Math.round(v) + "°"],
    ["lightEl", "Light height", 0, 90, 1, (v) => Math.round(v) + "°"],
    ["lightInt", "Light", 0, 6, 0.05, (v) => v.toFixed(2)],
    ["ambient", "Ambient", 0, 3, 0.05, (v) => v.toFixed(2)],
];

const CSS = `
.glb-dialog { background:var(--sc-surface, #232323); color:var(--sc-fg, #ddd); border:1px solid var(--sc-border, #444); border-radius:var(--sc-radius-lg, 8px); padding:0; max-width:calc(100vw - 40px); font:12px var(--sc-font, system-ui, sans-serif); }
.glb-dialog::backdrop { background:var(--sc-backdrop, rgba(0,0,0,0.6)); }
.glb-body { display:flex; gap:12px; padding:12px; }
.glb-stage { position:relative; background:#111 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23333'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23333'/%3E%3C/svg%3E"); cursor:grab; user-select:none; touch-action:none; }
.glb-stage canvas { display:block; }
.glb-side { width:250px; display:flex; flex-direction:column; gap:4px; overflow:auto; max-height:80vh; }
.glb-side label { display:grid; grid-template-columns:78px 1fr 48px; align-items:center; gap:6px; }
.glb-side label span:last-child { text-align:right; color:var(--sc-fg-2, #aaa); font-variant-numeric:tabular-nums; }
.glb-side input[type=range] { width:100%; min-width:0; }
.glb-side .glb-tick { display:flex; gap:6px; align-items:center; }
.glb-title { padding:10px 12px 0; font-weight:600; }
.glb-hint { color:var(--sc-muted, #999); margin:2px 0 6px; }
.glb-buttons { display:flex; gap:8px; justify-content:flex-end; padding:0 12px 12px; }
.glb-buttons button { font:inherit; padding:5px 14px; border-radius:var(--sc-radius, 4px); border:1px solid var(--sc-border, #555); background:var(--sc-btn, #333); color:var(--sc-fg, #ddd); cursor:pointer; }
.glb-buttons button.glb-primary { background:var(--sc-go, #2b7a3d); border-color:var(--sc-go, #2b7a3d); color:var(--sc-on-active, #fff); }
`;

let cssDone = false;
function ensureCss() {
    if (cssDone) return;
    const s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
    cssDone = true;
}

/**
 * Open the dialog for `model` over `doc`'s picture with the parameters `params`. Resolves
 * with the final parameters on Place, null on Cancel / Escape.
 */
export function openDialog({ scumble, doc, model, renderer, params, title }) {
    ensureCss();
    const p = { ...params };
    return new Promise((resolve) => {
        const dlg = document.createElement("dialog");
        dlg.className = "glb-dialog";
        dlg.appendChild(Object.assign(document.createElement("div"), { className: "glb-title", textContent: `3D object: ${title || "model"}` }));
        const body = document.createElement("div");
        body.className = "glb-body";
        dlg.appendChild(body);

        // the stage: the picture scaled to fit, the object rendered over it
        const maxW = Math.min(820, window.innerWidth - 340), maxH = Math.min(560, window.innerHeight - 160);
        const k = Math.min(maxW / doc.width, maxH / doc.height, 1);
        const sw = Math.max(64, Math.round(doc.width * k)), sh = Math.max(64, Math.round(doc.height * k));
        // the object's own frame (upright, x / y are fractions of it) and where it lies in the picture now: the preview
        // renders the frame at the stage's scale and draws it through the frame's matrix, as the placement does
        const frame = frameOf(p, doc.width, doc.height);
        // (at most about 4 MP: a frame far larger than the picture, after a small crop, is not rendered at full size per frame)
        const plan = framePlan(frame, (w, h) => { const kk = Math.min(k, Math.sqrt(4e6 / (w * h))); return { w: Math.max(1, Math.round(w * kk)), h: Math.max(1, Math.round(h * kk)), k: kk }; });
        const ssx = sw / doc.width, ssy = sh / doc.height, D = plan.toDoc;
        const stageMatrix = [ssx * D[0], ssy * D[1], ssx * D[2], ssy * D[3], ssx * D[4], ssy * D[5]];
        // a move on the stage in the frame's units (the frame's matrix undone), and along its axes at the screen's size
        const [fa, fb, fc, fd] = frame.m, fdet = fa * fd - fb * fc;
        const toFrame = (X, Y) => [(fd * X - fc * Y) / fdet, (-fb * X + fa * Y) / fdet];
        const fax = Math.hypot(fa, fb), fay = Math.hypot(fc, fd);
        const stage = document.createElement("div");
        stage.className = "glb-stage";
        const view = document.createElement("canvas");
        view.width = sw; view.height = sh;
        stage.appendChild(view);
        body.appendChild(stage);
        const backdrop = scumble.makeCanvas(sw, sh);
        // `settled` (C6 c3): the picture's levels are built in the app's worker, so opening this dialog over a large
        // document does not hold the window while they are made. The dialog is up at once with the chequerboard and
        // the object on it; the picture arrives a frame or two later and the preview is drawn again.
        doc.flatten({ maxSize: Math.max(sw, sh), settled: true })
            .then((flat) => { backdrop.getContext("2d").drawImage(flat, 0, 0, sw, sh); schedule(); })
            .catch(() => { /* an empty document, or one closed while it was read: the chequerboard shows */ });

        const side = document.createElement("div");
        side.className = "glb-side";
        body.appendChild(side);
        side.appendChild(Object.assign(document.createElement("div"), { className: "glb-hint", textContent: "Drag: turn · Shift+drag: move · wheel: scale · Escape: cancel" }));
        const inputs = {};
        for (const [key, label, min, max, step, fmt] of SLIDERS) {
            const lab = document.createElement("label");
            lab.appendChild(Object.assign(document.createElement("span"), { textContent: label }));
            const inp = document.createElement("input");
            inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = p[key];
            const val = Object.assign(document.createElement("span"), { textContent: fmt(p[key]) });
            inp.addEventListener("input", () => { p[key] = +inp.value; val.textContent = fmt(p[key]); schedule(); });
            inp.addEventListener("keydown", (e) => e.stopPropagation());
            lab.appendChild(inp); lab.appendChild(val);
            side.appendChild(lab);
            inputs[key] = { inp, val, fmt };
        }
        const tick = (key, label, title) => {
            const lab = document.createElement("label");
            lab.className = "glb-tick";
            const cb = document.createElement("input");
            cb.type = "checkbox"; cb.checked = !!p[key]; cb.title = title;
            cb.addEventListener("change", () => { p[key] = cb.checked; schedule(); });
            lab.appendChild(cb); lab.appendChild(Object.assign(document.createElement("span"), { textContent: label }));
            side.appendChild(lab);
        };
        tick("shadow", "Ground shadow", "A soft contact shadow on an invisible ground under the object");
        tick("depthLayer", "Depth layer for a ControlNet", "Also write a depth layer (near = white, role control), hidden");
        const buttons = document.createElement("div");
        buttons.className = "glb-buttons";
        const cancel = Object.assign(document.createElement("button"), { textContent: "Cancel", type: "button" });
        const ok = Object.assign(document.createElement("button"), { textContent: "Place", type: "button", className: "glb-primary" });
        buttons.appendChild(cancel); buttons.appendChild(ok);
        dlg.appendChild(buttons);

        // the preview: coalesced to one render per frame
        let pending = false;
        const draw = () => {
            pending = false;
            const ctx = view.getContext("2d");
            ctx.clearRect(0, 0, sw, sh);
            ctx.drawImage(backdrop, 0, 0);
            try {
                const img = renderer.render(model, p, plan.fit.w, plan.fit.h, plan.aspect);
                ctx.save();
                ctx.imageSmoothingEnabled = true;
                ctx.setTransform(...stageMatrix);
                ctx.drawImage(img, 0, 0);
                ctx.restore();
            } catch (err) { scumble.warn("preview", err); }
        };
        const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(draw); } };
        const syncSliders = () => { for (const [key, o] of Object.entries(inputs)) { o.inp.value = p[key]; o.val.textContent = o.fmt(p[key]); } };

        // pointer: drag turns (Shift: moves), wheel scales
        let drag = null;
        stage.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, shift: e.shiftKey, p: { ...p } }; stage.setPointerCapture(e.pointerId); e.preventDefault(); });
        stage.addEventListener("pointermove", (e) => {
            if (!drag) return;
            // the move on screen in the object's upright frame (a turned, mirrored, scaled or straightened picture: undone)
            const sx = e.clientX - drag.x, sy = e.clientY - drag.y;
            if (drag.shift) {
                const [fx, fy] = toFrame(sx / ssx, sy / ssy);
                p.x = drag.p.x + fx / frame.w; p.y = drag.p.y + fy / frame.h;
            } else {
                const [ux, uy] = toFrame(sx, sy), dx = ux * fax, dy = uy * fay;
                p.rotY = ((drag.p.rotY + dx * 0.5 + 180) % 360 + 360) % 360 - 180; p.rotX = Math.max(-180, Math.min(180, drag.p.rotX + dy * 0.5));
            }
            syncSliders(); schedule();
        });
        const endDrag = () => { drag = null; };
        stage.addEventListener("pointerup", endDrag); stage.addEventListener("pointercancel", endDrag);
        stage.addEventListener("wheel", (e) => { e.preventDefault(); p.scale = Math.max(0.02, Math.min(8, p.scale * Math.pow(1.1, -e.deltaY / 100))); syncSliders(); schedule(); }, { passive: false });
        dlg.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });

        let done = false;
        const finish = (value) => { if (done) return; done = true; try { dlg.close(); } catch (_) { /* already closed */ } dlg.remove(); resolve(value); };
        cancel.addEventListener("click", () => finish(null));
        ok.addEventListener("click", () => finish({ ...p }));
        // Escape reaches the dialog as a cancel event; Chromium does not always follow it with close
        dlg.addEventListener("cancel", () => finish(null));
        dlg.addEventListener("close", () => finish(null));
        document.body.appendChild(dlg);
        dlg.showModal();
        draw();
    });
}
