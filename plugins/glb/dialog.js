// The 3D dialog: the picture as the backdrop, the object rendered over it at preview size,
// drag turns the object, Shift+drag moves it, the wheel scales it, sliders for everything.
// A native <dialog>, so Escape closes it (the editor lets keys inside an open dialog through).

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
.glb-dialog { background:#232323; color:#ddd; border:1px solid #444; border-radius:8px; padding:0; max-width:calc(100vw - 40px); font:12px system-ui, sans-serif; }
.glb-dialog::backdrop { background:rgba(0,0,0,0.6); }
.glb-body { display:flex; gap:12px; padding:12px; }
.glb-stage { position:relative; background:#111 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23333'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23333'/%3E%3C/svg%3E"); cursor:grab; user-select:none; touch-action:none; }
.glb-stage canvas { display:block; }
.glb-side { width:250px; display:flex; flex-direction:column; gap:4px; overflow:auto; max-height:80vh; }
.glb-side label { display:grid; grid-template-columns:78px 1fr 48px; align-items:center; gap:6px; }
.glb-side label span:last-child { text-align:right; color:#aaa; font-variant-numeric:tabular-nums; }
.glb-side input[type=range] { width:100%; min-width:0; }
.glb-side .glb-tick { display:flex; gap:6px; align-items:center; }
.glb-title { padding:10px 12px 0; font-weight:600; }
.glb-hint { color:#999; margin:2px 0 6px; }
.glb-buttons { display:flex; gap:8px; justify-content:flex-end; padding:0 12px 12px; }
.glb-buttons button { font:inherit; padding:5px 14px; border-radius:4px; border:1px solid #555; background:#333; color:#ddd; cursor:pointer; }
.glb-buttons button.glb-primary { background:#2b7a3d; border-color:#2b7a3d; color:#fff; }
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
        const stage = document.createElement("div");
        stage.className = "glb-stage";
        const view = document.createElement("canvas");
        view.width = sw; view.height = sh;
        stage.appendChild(view);
        body.appendChild(stage);
        const backdrop = scumble.makeCanvas(sw, sh);
        try { backdrop.getContext("2d").drawImage(doc.flatten(), 0, 0, sw, sh); } catch (_) { /* an empty document: the chequerboard shows */ }

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
            try { ctx.drawImage(renderer.render(model, p, sw, sh), 0, 0); } catch (err) { scumble.warn("preview", err); }
        };
        const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(draw); } };
        const syncSliders = () => { for (const [key, o] of Object.entries(inputs)) { o.inp.value = p[key]; o.val.textContent = o.fmt(p[key]); } };

        // pointer: drag turns (Shift: moves), wheel scales
        let drag = null;
        stage.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, shift: e.shiftKey, p: { ...p } }; stage.setPointerCapture(e.pointerId); e.preventDefault(); });
        stage.addEventListener("pointermove", (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (drag.shift) { p.x = drag.p.x + dx / sw; p.y = drag.p.y + dy / sh; }
            else { p.rotY = ((drag.p.rotY + dx * 0.5 + 180) % 360 + 360) % 360 - 180; p.rotX = Math.max(-180, Math.min(180, drag.p.rotX + dy * 0.5)); }
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
