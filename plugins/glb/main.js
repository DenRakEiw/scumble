// GLB layer plugin, stage 1: a 3D object (.glb / .gltf) placed in the picture through a dialog
// that shows the picture as the backdrop, rendered with alpha into an ordinary paint layer,
// optionally with a depth layer (role control) for a depth ControlNet. The object stays
// editable: the file lives in the local file store, the parameters in the plugin's storage
// keyed by the layer id, and "Edit 3D object" re-renders into the same layer.
//
//   panel    "3D object" in the Image pane: place, the objects of this document, edit
//   actions  Place 3D object (.glb), Edit 3D object (Plugins menu)
//   commands glb.place, glb.edit, glb.info for scripts and MCP
//
// The value is the inpainting workflow, not the render: place the object with the right
// pose, then Generate over it with a denoise below 1 and the model paints light and material
// into the scene. render.js holds the three.js side, dialog.js the dialog.

import { api } from "/editor/host.js";
import { GlbRenderer, DEFAULTS, normalise, alphaBounds, crop } from "./render.js";
import { openDialog } from "./dialog.js";

const LAYER_NAME = "3D object";
const HELP = "Place a .glb or .gltf model in the picture: the dialog shows the picture behind the object, drag turns it, the wheel scales it, the sliders set position, distance, focal length and light. The render becomes an ordinary layer (T moves it, Delete removes it) and stays editable here. Matching the picture's light is the generation model's job: select the object, Generate with a denoise below 1.";
const SUBFOLDER = "inpaint_canvas";

let renderer = null;             // one WebGL context for the plugin, made on first use
const models = new Map();        // file key -> parsed model

export function activate(scumble) {
    const { ui } = scumble;
    const R = () => renderer || (renderer = new GlbRenderer());

    // ---- storage: { objects: { [layerId]: { ref, name, params, depthId } }, last: params } ---------
    const store = () => scumble.storage.get() || {};
    const objects = () => ({ ...(store().objects || {}) });
    function remember(layerId, entry) {
        const all = objects();
        all[layerId] = entry;
        const keys = Object.keys(all);
        if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete all[k];   // the oldest go
        scumble.storage.set({ objects: all, last: entry.params });
    }
    function forget(layerId) { const all = objects(); delete all[layerId]; scumble.storage.set({ objects: all }); }
    const entryOf = (layerId) => objects()[layerId] || null;

    // ---- the file: into the local store like layer pixels, so a reload finds it -------------------
    async function storeFile(bytes, name) {
        const safe = String(name || "model.glb").replace(/[^a-z0-9._-]/gi, "_");
        const fd = new FormData();
        fd.append("image", new Blob([bytes], { type: "model/gltf-binary" }), safe);
        fd.append("subfolder", SUBFOLDER);
        fd.append("type", "input");
        fd.append("overwrite", "false");
        const r = await fetch(api.apiURL("/upload/image"), { method: "POST", body: fd });
        if (!r.ok) throw new Error(`could not store ${safe} (${r.status})`);
        const j = await r.json();
        return { filename: j.name, subfolder: j.subfolder || SUBFOLDER, type: j.type || "input" };
    }
    async function fetchModel(ref) {
        const key = `${ref.type || "input"}/${ref.subfolder || ""}/${ref.filename}`;
        if (models.has(key)) return models.get(key);
        const r = await fetch(api.apiURL("/view?" + new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" })));
        if (!r.ok) throw new Error(`the model file ${ref.filename} is not in the local store (${r.status})`);
        const buf = await r.arrayBuffer();
        const model = /\.gltf$/i.test(ref.filename) ? await R().load(new TextDecoder().decode(buf)) : await R().load(buf);
        models.set(key, model);
        return model;
    }

    // ---- render and place --------------------------------------------------------------------------
    /** The colour layer (cropped to the object, placed in document pixels) and, when asked, the depth frame over black. */
    function renderFor(doc, model, p) {
        const fit = R().fit(doc.width, doc.height);
        const colour = R().render(model, p, fit.w, fit.h);
        const b = alphaBounds(colour);
        if (!b) throw new Error("the object is outside the picture (or too small to see): change position, distance or scale");
        const out = { canvas: crop(colour, b), x: b.x / fit.k, y: b.y / fit.k, w: b.w / fit.k, h: b.h / fit.k, render: fit };
        if (p.depthLayer) {
            const dep = R().depth(model, p, fit.w, fit.h);
            const frame = scumble.makeCanvas(fit.w, fit.h);
            const ctx = frame.getContext("2d");
            ctx.fillStyle = "#000"; ctx.fillRect(0, 0, fit.w, fit.h);
            ctx.drawImage(dep, 0, 0);
            out.depth = frame;
        }
        return out;
    }
    const imageDataOf = (c) => c.getContext("2d").getImageData(0, 0, c.width, c.height);

    /**
     * Render the object into a layer: a new one, or the layer `layerId` replaced in place (its
     * pixels through setPixels for the undo step, its placement through set_layer).
     */
    async function place(doc, { ref, name, params, layerId = null }) {
        if (!doc.loaded) throw new Error("Load an image first.");
        const p = normalise(params || {});
        const model = await fetchModel(ref);
        const r = renderFor(doc, model, p);
        const layerName = name || (ref.filename || LAYER_NAME).replace(/\.(glb|gltf)$/i, "").replace(/ \(\d+\)$/, "") || LAYER_NAME;   // the store's "(1)" suffix is not a name
        let layer;
        const existing = layerId && doc.layers().find((l) => l.id === layerId);
        if (existing) {
            doc.setPixels(layerId, imageDataOf(r.canvas));
            layer = await doc.run("set_layer", { layer: layerId, x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)), active: true });
        } else {
            layer = doc.addLayer(r.canvas, { name: layerName, x: r.x, y: r.y, w: r.w, h: r.h });
        }
        const prev = entryOf(layer.id);
        let depthLayer = null;
        const prevDepth = prev && prev.depthId && doc.layers().find((l) => l.id === prev.depthId);
        if (r.depth) {
            if (prevDepth) {
                doc.setPixels(prevDepth.id, imageDataOf(r.depth));
                depthLayer = await doc.run("set_layer", { layer: prevDepth.id, x: 0, y: 0, w: doc.width, h: doc.height, active: false });
            } else {
                depthLayer = doc.addLayer(r.depth, { name: `${layerName} depth`, x: 0, y: 0, w: doc.width, h: doc.height, activate: false });
                depthLayer = await doc.run("set_layer", { layer: depthLayer.id, role: "control", visible: false });
            }
        } else if (prevDepth) {
            await doc.run("remove_layer", { layer: prevDepth.id });
        }
        remember(layer.id, { ref, name: layerName, params: p, depthId: depthLayer ? depthLayer.id : null });
        doc.status(`${layerName}: ${Math.round(r.w)} × ${Math.round(r.h)} at ${Math.round(r.x)}, ${Math.round(r.y)}${r.depth ? ", depth layer updated" : ""}. Edit it again under 3D object; T moves and scales it.`);
        return { layer: doc.layer(layer.id), depthLayer: depthLayer ? doc.layer(depthLayer.id) : null, params: p, ref, render: r.render };
    }

    /** The 3D layers of a document: those the storage knows, in layer order. */
    function objectsOf(doc) {
        const all = objects();
        return doc.layers().filter((l) => all[l.id]).map((l) => ({ layer: l, entry: all[l.id] }));
    }
    function pickFile() {
        return new Promise((resolve) => {
            const inp = document.createElement("input");
            inp.type = "file"; inp.accept = ".glb,.gltf"; inp.style.display = "none";
            inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; inp.remove(); resolve(f || null); });
            inp.addEventListener("cancel", () => { inp.remove(); resolve(null); });
            document.body.appendChild(inp);
            inp.click();
        });
    }
    async function refFromFile(file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return storeFile(bytes, file.name);
    }

    /** The dialog for a new object (file picked here) or an existing layer, then place. */
    async function placeInteractive(doc, layerId = null) {
        if (!doc.loaded) { doc.status("Load an image first."); return null; }
        let ref, params, name;
        if (layerId) {
            const e = entryOf(layerId);
            if (!e) { doc.status("This layer was not made by the 3D object plugin (or its settings are gone)."); return null; }
            ref = e.ref; params = e.params; name = e.name;
        } else {
            const file = await pickFile();
            if (!file) return null;
            doc.status(`Reading ${file.name} ...`);
            ref = await refFromFile(file);
            params = { ...DEFAULTS, ...(store().last || {}) };
            name = file.name.replace(/\.(glb|gltf)$/i, "");
        }
        const model = await fetchModel(ref);
        const answer = await openDialog({ scumble, doc, model, renderer: R(), params: normalise(params), title: name });
        if (!answer) { doc.status("3D object cancelled."); return null; }
        return place(doc, { ref, name, params: answer, layerId });
    }

    // ---- panel --------------------------------------------------------------------------------------
    scumble.panels.register({
        id: "panel",
        title: "3D object",
        pane: "image",
        open: false,
        build(box, doc) {
            box.appendChild(ui.el("div", "shell-help", HELP));
            const row = ui.el("div", "scumble-plugin-row");
            row.appendChild(ui.button("Place 3D object...", "Pick a .glb / .gltf file and place it in the picture", () => placeInteractive(doc).catch((err) => doc.status(String(err.message || err)))));
            box.appendChild(row);
            const list = ui.el("div", "glb-list");
            box.appendChild(list);
            const refresh = () => {
                list.innerHTML = "";
                if (!doc.loaded) return;
                for (const { layer } of objectsOf(doc)) {
                    const r = ui.el("div", "scumble-plugin-row");
                    r.appendChild(ui.el("span", "scumble-plugin-label", layer.name));
                    r.appendChild(ui.button("Edit", "Reopen the 3D dialog for this layer and replace its pixels", () => placeInteractive(doc, layer.id).catch((err) => doc.status(String(err.message || err)))));
                    list.appendChild(r);
                }
            };
            refresh();
            scumble.events.on("changed", (ev) => { if (ev.doc && ev.doc.id === doc.id) refresh(); });
        },
    });

    // ---- Plugins menu ----------------------------------------------------------------------------------
    scumble.actions.register({ id: "place", label: "Place 3D object (.glb)...", run: (doc) => placeInteractive(doc) });
    scumble.actions.register({ id: "edit", label: "Edit 3D object", run: (doc) => { const a = doc.activeLayer(); return placeInteractive(doc, a ? a.id : null); } });
    scumble.events.on("removed", () => { /* documents go, the storage keeps the entries for the restored session */ });

    // ---- commands -----------------------------------------------------------------------------------
    const PARAMS = {
        position: { type: "object", description: "{ x, y } where the object's centre lands, as fractions of the picture (0..1, default 0.5 / 0.55)" },
        depth: { type: "number", description: "distance from the camera in object units (the model is 1 unit on its longest side; default 3)" },
        rotation: { type: "object", description: "{ x, y, z } in degrees (default y 30)" },
        scale: { type: "number", description: "size multiplier (default 1)" },
        fov: { type: "number", description: "camera field of view in degrees (default 40; small = long lens)" },
        light: { type: "object", description: "{ azimuth, elevation, intensity, ambient }: the key light's direction in degrees and strength, the room light's strength" },
        shadow: { type: "boolean", description: "a soft contact shadow on an invisible ground under the object (default true)" },
        depth_layer: { type: "boolean", description: "also write a depth layer (near = white, role control) for a depth ControlNet (default false)" },
        name: { type: "string", description: "layer name (default the file name)" },
    };
    scumble.commands.register("place", {
        description: "Render a 3D object (.glb / .gltf) into a new layer, placed in the picture by position, distance, rotation and scale. The file is copied into the local store and the layer stays editable with glb.edit.",
        params: { path: { type: "string", description: "absolute path of a .glb / .gltf file" }, filename: { type: "string", description: "instead of path: a file already in the local store (from an earlier glb.place)" }, ...PARAMS },
        needsImage: true,
        scope: "doc",
        async run(doc, a) {
            let ref;
            let name = a.name;
            if (a.path) { const r = await window.scumble.file.read(String(a.path)); ref = await storeFile(r.data, r.name); name = name || String(r.name).replace(/\.(glb|gltf)$/i, ""); }
            else if (a.filename) ref = { filename: String(a.filename), subfolder: SUBFOLDER, type: "input" };
            else throw new Error("pass path (a .glb / .gltf file) or filename (a file in the local store)");
            return place(doc, { ref, name, params: a });
        },
    });
    scumble.commands.register("edit", {
        description: "Re-render a 3D object layer with changed parameters (only the given ones change); the layer keeps its id, the depth layer follows.",
        params: { layer: { type: "string", description: "the 3D object layer: id, name, or \"active\"", default: "active" }, ...PARAMS },
        needsImage: true,
        scope: "doc",
        async run(doc, a) {
            const l = doc.layer(a.layer || "active");
            const e = entryOf(l.id);
            if (!e) throw new Error(`${l.name} is not a 3D object layer of this plugin`);
            const merged = { ...e.params };
            for (const k of ["depth", "scale", "fov", "shadow", "depth_layer"]) if (a[k] != null) merged[k === "depth_layer" ? "depthLayer" : k] = a[k];
            if (a.position) { if (a.position.x != null) merged.x = a.position.x; if (a.position.y != null) merged.y = a.position.y; }
            if (a.rotation) { if (a.rotation.x != null) merged.rotX = a.rotation.x; if (a.rotation.y != null) merged.rotY = a.rotation.y; if (a.rotation.z != null) merged.rotZ = a.rotation.z; }
            if (a.light) { if (a.light.azimuth != null) merged.lightAz = a.light.azimuth; if (a.light.elevation != null) merged.lightEl = a.light.elevation; if (a.light.intensity != null) merged.lightInt = a.light.intensity; if (a.light.ambient != null) merged.ambient = a.light.ambient; }
            return place(doc, { ref: e.ref, name: a.name || e.name, params: merged, layerId: l.id });
        },
    });
    scumble.commands.register("info", {
        description: "The 3D object layers of this document with their parameters, and the parameter defaults.",
        params: {},
        scope: "doc",
        run(doc) {
            return { defaults: DEFAULTS, objects: doc.loaded ? objectsOf(doc).map(({ layer, entry }) => ({ layer: layer.id, name: layer.name, file: entry.ref.filename, params: entry.params, depthLayer: entry.depthId || null })) : [], renderer: renderer ? { maxSide: renderer.maxSide } : null };
        },
    });

    scumble.log("loaded");
}

export function deactivate() {
    models.clear();
    if (renderer) { renderer.dispose(); renderer = null; }
}
