// Sample plugin for Scumble: one of every extension point, kept short so it reads as a
// template. The `scumble` object is documented in docs/PLUGINS.md.
//
//   filter   Posterize (CPU code + a GLSL fragment for the WebGL2 path)
//   panel    "Sample" in the Image pane: document facts and a Desaturate button
//   actions  Desaturate active layer, Selection to new layer (Plugins menu)
//   tool     Colour probe (K): hover to read the colour under the cursor
//   command  sample.mean_color for scripts and MCP

let probeCache = null;   // { doc, data } the flattened pixels while the probe tool is active

export function activate(scumble) {
    const { ui } = scumble;

    // ---- filter: posterize --------------------------------------------------------------------
    scumble.filters.register({
        id: "posterize",
        label: "Posterize (sample)",
        params: [
            { key: "levels", label: "Levels", type: "number", min: 2, max: 32, step: 1, default: 6 },
            { key: "mono", label: "Monochrome", type: "bool", default: false },
        ],
        // CPU path: src is a canvas, return a new canvas of the same size
        apply(src, p) {
            const out = scumble.makeCanvas(src.width, src.height);
            const ctx = out.getContext("2d");
            ctx.drawImage(src, 0, 0);
            const img = ctx.getImageData(0, 0, src.width, src.height);
            const d = img.data;
            const n = Math.max(2, Math.round(p.levels || 6));
            const q = (v) => Math.round(Math.floor(v / 256 * n) * 255 / (n - 1));
            for (let i = 0; i < d.length; i += 4) {
                if (p.mono) { const l = q(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); d[i] = d[i + 1] = d[i + 2] = l; }
                else { d[i] = q(d[i]); d[i + 1] = q(d[i + 1]); d[i + 2] = q(d[i + 2]); }
            }
            ctx.putImageData(img, 0, 0);
            return out;
        },
        // GPU path: same maths as a fragment; uniforms are declared by type and filled per run
        glsl: {
            uniforms: { u_levels: "float", u_mono: "bool" },
            values: (p) => ({ u_levels: Math.max(2, Math.round(p.levels || 6)), u_mono: !!p.mono }),
            code: `
                float q(float v) { return floor(floor(v * 255.0 / 256.0 * u_levels) * 255.0 / (u_levels - 1.0) + 0.5) / 255.0; }
                vec4 shade(vec4 c, vec2 uv) {
                    if (u_mono) { float l = q(dot(c.rgb, vec3(0.299, 0.587, 0.114))); return vec4(l, l, l, c.a); }
                    return vec4(q(c.r), q(c.g), q(c.b), c.a);
                }`,
        },
    });

    // ---- pixel work shared by the panel button and the menu action ----------------------------
    function desaturate(doc) {
        const layer = doc.activeLayer();
        if (!layer) { doc.status("Select a layer first (the base image cannot be changed in place; duplicate it)."); return null; }
        if (layer.kind === "filter") { doc.status(`${layer.name} is a filter layer.`); return null; }
        const px = doc.getPixels(layer.id);
        const d = px.data.data;
        for (let i = 0; i < d.length; i += 4) { const l = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); d[i] = d[i + 1] = d[i + 2] = l; }
        doc.setPixels(layer.id, px.data);
        doc.status(`${layer.name} desaturated (Ctrl+Z takes it back).`);
        return layer.id;
    }

    function selectionToLayer(doc) {
        const sel = doc.selection();
        if (!sel) { doc.status("Nothing selected."); return null; }
        const { x, y, w, h } = sel.bounds;
        const flat = doc.getPixels();               // the whole picture at image size
        const out = new ImageData(w, h);
        const W = sel.width;
        for (let yy = 0; yy < h; yy++) {
            for (let xx = 0; xx < w; xx++) {
                const i = (y + yy) * W + (x + xx);
                if (!sel.mask[i]) continue;
                const s = i * 4, t = (yy * w + xx) * 4;
                out.data[t] = flat.data.data[s]; out.data[t + 1] = flat.data.data[s + 1]; out.data[t + 2] = flat.data.data[s + 2]; out.data[t + 3] = flat.data.data[s + 3];
            }
        }
        const layer = doc.addLayer(out, { name: "Selection copy", x, y });
        doc.status(`${layer.name} added (${w} × ${h}).`);
        return layer.id;
    }

    // ---- panel ----------------------------------------------------------------------------------
    scumble.panels.register({
        id: "info",
        title: "Sample",
        pane: "image",
        open: false,
        build(box, doc) {
            const line = ui.el("div", "shell-help", "");
            const update = () => { line.textContent = doc.loaded ? `${doc.name}: ${doc.width} × ${doc.height}, ${doc.layers().length} layer${doc.layers().length === 1 ? "" : "s"}` : "No image loaded."; };
            update();
            box.appendChild(line);
            box.appendChild(ui.button("Desaturate active layer", "Turns the active layer grey through getPixels / setPixels", () => desaturate(doc)));
            box.appendChild(ui.button("Selection to new layer", "Copies the selected pixels of the flattened picture into a new layer", () => selectionToLayer(doc)));
            scumble.events.on("changed", (ev) => { if (ev.doc && ev.doc.id === doc.id) update(); });
        },
    });

    // ---- actions (Plugins menu) ----------------------------------------------------------------
    scumble.actions.register({ id: "desaturate", label: "Desaturate active layer", run: (doc) => desaturate(doc) });
    scumble.actions.register({ id: "selection_layer", label: "Selection to new layer", run: (doc) => selectionToLayer(doc) });

    // ---- tool: colour probe ---------------------------------------------------------------------
    const probe = (doc, ev) => {
        if (!doc.loaded || !ev.inside) return;
        if (!probeCache || probeCache.doc !== doc.id) probeCache = { doc: doc.id, data: doc.getPixels().data };
        const x = Math.floor(ev.x), y = Math.floor(ev.y);
        const i = (y * probeCache.data.width + x) * 4, d = probeCache.data.data;
        const hex = "#" + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
        doc.status(`${x}, ${y}: rgb(${d[i]}, ${d[i + 1]}, ${d[i + 2]}) ${hex}${ev.button === 0 && ev.raw.type === "pointerdown" ? " (copied)" : ""}`);
        return hex;
    };
    scumble.tools.register({
        id: "probe",
        label: "Probe",
        title: "Colour probe (sample plugin): hover to read the colour under the cursor, click to copy it as hex",
        icon: "eyedropper",
        key: "K",
        hint: "Colour probe: hover over the image; click copies the hex value.",
        onSelect: () => { probeCache = null; },
        onHover: (doc, ev) => probe(doc, ev),
        onDown: (doc, ev) => { const hex = probe(doc, ev); if (hex && navigator.clipboard) navigator.clipboard.writeText(hex).catch(() => {}); },
    });
    scumble.events.on("changed", (ev) => { if (probeCache && ev.doc && ev.doc.id === probeCache.doc) probeCache = null; });

    // ---- command -------------------------------------------------------------------------------
    scumble.commands.register("mean_color", {
        description: "Mean colour of the selection (or the whole picture) as rgb and hex.",
        params: {},
        needsImage: true,
        run(doc) {
            const flat = doc.getPixels().data.data;
            const sel = doc.selection();
            let r = 0, g = 0, b = 0, n = 0;
            for (let i = 0, j = 0; i < flat.length; i += 4, j++) {
                if (sel && !sel.mask[j]) continue;
                r += flat[i]; g += flat[i + 1]; b += flat[i + 2]; n++;
            }
            if (!n) return { pixels: 0 };
            const c = [r, g, b].map((v) => Math.round(v / n));
            return { pixels: n, rgb: c, hex: "#" + c.map((v) => v.toString(16).padStart(2, "0")).join(""), selection: sel ? sel.bounds : null };
        },
    });

    scumble.log("loaded");
}

export function deactivate() {
    probeCache = null;
}
