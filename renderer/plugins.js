// Plugins: JavaScript modules in <userData>/plugins/<id>/ (or the built-in ones shipped
// in <app>/plugins/), each with a plugin.json manifest and an entry module that exports
// `activate(scumble)` (and optionally `deactivate()`). The `scumble` object handed to a
// plugin is built here (makeApi): documents with pixel access, the command core, and the
// extension points filter / panel / action / tool. Everything a plugin registers is
// tracked per plugin, so disabling or reloading it takes all of it out again without a
// restart. See docs/PLUGINS.md for the API as a user sees it.

import { host } from "./editor/host.js";
import { commands, findLayer, layerSummary, touch, bounds } from "./commands.js";
import { FILTERS, FILTER_IDS, filterDefaults } from "./editor/inpaint_filters.js";
import { registerGLFilter, unregisterGLFilter } from "./editor/inpaint_filters_gl.js";
import { el, icon, makeCanvas } from "./editor/inpaint_canvas.js";

export const API_VERSION = 1;
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

const plugins = new Map();   // id -> entry { id, manifest, module, api, regs, loaded, error, errors: [] }

function newRegs() {
    return { filters: new Set(), panels: new Map(), actions: new Map(), tools: new Map(), commands: new Set(), listeners: [] };
}

function report(entry, where, err) {
    const msg = String((err && err.message) || err);
    console.error(`plugin ${entry.id}: ${where}:`, err);
    entry.errors.push(`${where}: ${msg}`);
    if (entry.errors.length > 8) entry.errors.shift();
    if (host.editor) { try { host.editor.setStatus(`Plugin ${entry.manifest.name || entry.id}: ${where}: ${msg}`); } catch (_) { /* ignore */ } }
    if (onChanged) onChanged();
}

let onChanged = null;   // set by the shell: () => void (the Settings › Plugins list)
export function setOnChanged(fn) { onChanged = fn; }

// ---- the document a plugin sees ------------------------------------------------------------

/**
 * A thin wrapper around one editor (tab). Pixel access goes through ImageData: getPixels
 * reads a layer's own canvas (or the flattened picture), setPixels writes it back with an
 * undo step. `editor` is the raw editor for what the wrapper does not cover (unstable API).
 */
export class Document {
    constructor(editor) { this.editor = editor; }
    get id() { return this.editor.node.id; }
    get width() { return this.editor.width || 0; }
    get height() { return this.editor.height || 0; }
    get loaded() { return !!this.editor.base; }
    get active() { return host.isActive(this.editor); }
    get name() { const r = this.editor.base && this.editor.base.ref; return r ? String(r.filename || "image").replace(/\.[a-z0-9]+$/i, "") : "Untitled"; }

    status(text) { this.editor.setStatus(String(text)); }
    run(name, args = {}) { return commands.run(name, { ...args, doc: this.id }); }

    layers() { return this.editor.layers.map((l) => layerSummary(this.editor, l)); }
    layer(key) { return layerSummary(this.editor, findLayer(this.editor, key)); }
    activeLayer() { const l = this.editor.activeLayer(); return l ? layerSummary(this.editor, l) : null; }
    /** The raw layer object (canvas, mask, params ...); unstable, prefer the summaries. */
    rawLayer(key) { return findLayer(this.editor, key); }

    /** The flattened picture (every visible layer, without helpers) as a canvas at image size. */
    flatten() { this._need(); return this.editor.flattenToCanvas({ forRun: true }); }

    /**
     * Pixels as ImageData. Without a layer: the flattened picture (x, y = 0, canvas size =
     * image size). With a layer: its own canvas (unmasked, at the layer's pixel size) plus
     * where it sits on the canvas (x, y, w, h in image pixels; w, h may differ from the
     * canvas size when the layer is scaled).
     */
    getPixels(layerKey) {
        this._need();
        if (layerKey == null || layerKey === "") {
            const c = this.flatten();
            return { data: c.getContext("2d").getImageData(0, 0, c.width, c.height), x: 0, y: 0, w: c.width, h: c.height, layer: null };
        }
        const l = findLayer(this.editor, layerKey);
        if (l.kind === "filter") throw new Error(`${l.name} is a filter layer: it has no pixels of its own`);
        const c = l.canvas;
        return { data: c.getContext("2d").getImageData(0, 0, c.width, c.height), x: l.x, y: l.y, w: l.w, h: l.h, layer: l.id };
    }

    /**
     * Write ImageData into a layer (its own canvas; the size must match, or the canvas is
     * replaced and the layer keeps its placement). One undo step. Filter and locked layers
     * refuse.
     */
    setPixels(layerKey, imageData, { undo = true } = {}) {
        this._need();
        const l = findLayer(this.editor, layerKey);
        if (l.kind === "filter") throw new Error(`${l.name} is a filter layer`);
        if (l.locked) throw new Error(`${l.name} is locked`);
        if (!imageData || !imageData.width || !imageData.data) throw new Error("setPixels needs an ImageData");
        if (undo) this.editor.pushUndo({ kind: l.canvas.width === imageData.width && l.canvas.height === imageData.height ? "layer" : "layerfull", id: l.id });
        if (l.canvas.width !== imageData.width || l.canvas.height !== imageData.height) l.canvas = makeCanvas(imageData.width, imageData.height);
        l.canvas.getContext("2d").putImageData(imageData, 0, 0);
        l.ref = null; l._fcache = null;
        this.editor.markLayerChanged(l);
        this.editor.renderLayers();
        this.editor.draw();
        return layerSummary(this.editor, l);
    }

    /** A new paint layer from ImageData or a canvas, placed at x, y (default 0, 0) with its own size. */
    addLayer(source, { name, x = 0, y = 0, w, h, activate = true } = {}) {
        this._need();
        let c;
        if (source instanceof ImageData) { c = makeCanvas(source.width, source.height); c.getContext("2d").putImageData(source, 0, 0); }
        else if (source && source.getContext) c = source;
        else if (source == null) c = makeCanvas(this.width, this.height);
        else throw new Error("addLayer needs an ImageData, a canvas or nothing");
        this.editor.paintCounter += 1;
        const layer = this.editor.addLayer({
            name: name || "Paint " + this.editor.paintCounter, kind: "paint", ref: null, canvas: c,
            x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w || c.width)), h: Math.max(1, Math.round(h || c.height)), dirty: true,
        }, { activate });
        return layerSummary(this.editor, layer);
    }

    /** The selection as a Uint8Array of width × height (1 = selected) plus its bounds, or null without a selection. */
    selection() {
        this._need();
        const b = bounds(this.editor);
        if (!b) return null;
        const W = this.width, H = this.height;
        const d = this.editor.selection.getContext("2d").getImageData(0, 0, W, H).data;
        const mask = new Uint8Array(W * H);
        for (let i = 0, j = 3; i < mask.length; i++, j += 4) mask[i] = d[j] > 127 ? 1 : 0;
        return { mask, bounds: b, width: W, height: H };
    }

    /** Set the selection from a Uint8Array (width × height, >0 = selected); mode replace, add or subtract. */
    setSelection(mask, mode = "replace") {
        this._need();
        if (!mask || mask.length !== this.width * this.height) throw new Error(`the mask must hold ${this.width * this.height} values`);
        const m = mask instanceof Uint8Array ? mask : Uint8Array.from(mask, (v) => (v > 0 ? 1 : 0));
        this.editor.applyMaskToSelection(m, mode);
        return bounds(this.editor);
    }

    undo() { return this.editor.undoStep(); }
    redo() { return this.editor.redoStep(); }
    /** After changes made on raw layer objects: caches off, lists and canvas fresh. */
    refresh() { touch(this.editor); }

    _need() { if (!this.editor.base || !this.editor.width) throw new Error("no image loaded"); }
}

// ---- registries -------------------------------------------------------------------------------

function fullId(entry, id) {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`"${id}" is not a valid id (letters, digits, - and _)`);
    return `${entry.id}.${id}`;
}

function registerFilter(entry, def) {
    if (!def || typeof def !== "object") throw new Error("filters.register needs a definition object");
    const id = fullId(entry, def.id);
    if (FILTERS[id]) throw new Error(`filter "${id}" is already registered`);
    if (typeof def.apply !== "function") throw new Error(`filter "${id}": apply(canvas, params, info) is required (the CPU path)`);
    const params = (def.params || []).map((p) => {
        if (!p || typeof p.key !== "string") throw new Error(`filter "${id}": every param needs a key`);
        const type = p.type || "number";
        const out = { key: p.key, label: p.label || p.key, type, default: p.default };
        if (type === "number") { out.min = p.min == null ? 0 : +p.min; out.max = p.max == null ? 100 : +p.max; out.step = p.step == null ? 1 : +p.step; if (p.unit) out.unit = p.unit; if (out.default == null) out.default = out.min; }
        else if (type === "select") { out.options = (p.options || []).map((o) => (typeof o === "string" ? { id: o, label: o } : o)); if (out.default == null && out.options.length) out.default = out.options[0].id; }
        else if (type === "bool") out.default = !!p.default;
        else if (type === "custom") { /* the plugin's own control */ }
        else throw new Error(`filter "${id}": unknown param type "${type}" (number, select, bool, custom)`);
        for (const k of ["keepPreset", "notWithPlate", "onlyWithPlate"]) if (p[k]) out[k] = true;
        return out;
    });
    const apply = (src, p, info) => {
        try { return def.apply(src, p, info) || src; }
        catch (err) { report(entry, `filter ${def.id}`, err); return src; }
    };
    FILTERS[id] = { label: def.label || def.id, params, apply, plugin: entry.id, control: typeof def.control === "function" ? def.control : undefined };
    FILTER_IDS.push(id);
    if (def.glsl) {
        if (typeof def.glsl.code !== "string") throw new Error(`filter "${id}": glsl.code must be the fragment source defining vec4 shade(vec4 color, vec2 uv)`);
        registerGLFilter(id, { code: def.glsl.code, uniforms: def.glsl.uniforms || {}, values: typeof def.glsl.values === "function" ? def.glsl.values : () => ({}) });
    }
    entry.regs.filters.add(id);
    refreshFilterLayers(id);
    return id;
}

function unregisterFilter(entry, id) {
    if (!entry.regs.filters.has(id)) return;
    delete FILTERS[id];
    const i = FILTER_IDS.indexOf(id);
    if (i >= 0) FILTER_IDS.splice(i, 1);
    unregisterGLFilter(id);
    entry.regs.filters.delete(id);
    refreshFilterLayers(id);
}

function refreshFilterLayers(id) {
    for (const ed of host.editors()) {
        let any = false;
        for (const l of ed.layers) if (l.kind === "filter" && l.filter === id) { l.params = { ...filterDefaults(id), ...(l.params || {}) }; ed.markFilterChanged(l); any = true; }
        try { ed.renderLayers(); if (any) ed.draw(); } catch (_) { /* not built yet */ }
    }
}

function registerPanel(entry, def) {
    if (!def || typeof def.build !== "function") throw new Error("panels.register needs { id, title, build(container, doc, scumble) }");
    const id = fullId(entry, def.id);
    if (entry.regs.panels.has(id)) throw new Error(`panel "${id}" is already registered`);
    const reg = { id, def: { ...def, title: def.title || def.id, pane: def.pane === "gen" ? "gen" : "image", open: def.open !== false }, els: new Map() };
    entry.regs.panels.set(id, reg);
    for (const ed of host.editors()) mountPanel(entry, reg, ed);
    return id;
}

function mountPanel(entry, reg, ed) {
    if (!ed.addSection || reg.els.has(ed)) return;
    try {
        const d = ed.addSection(reg.def.title, reg.def.open, (details) => {
            const box = el("div", "ipc-sec scumble-plugin-panel");
            details.appendChild(box);
            try { reg.def.build(box, new Document(ed), entry.api); } catch (err) { report(entry, `panel ${reg.def.id}`, err); box.appendChild(el("div", "scumble-plugin-error", String((err && err.message) || err))); }
        }, reg.def.pane);
        reg.els.set(ed, d);
    } catch (err) { report(entry, `panel ${reg.def.id}`, err); }
}

function unregisterPanel(entry, id) {
    const reg = entry.regs.panels.get(id);
    if (!reg) return;
    for (const [ed, d] of reg.els) {
        try { if (typeof reg.def.destroy === "function") reg.def.destroy(d.querySelector(".scumble-plugin-panel"), new Document(ed)); } catch (err) { report(entry, `panel ${reg.def.id} destroy`, err); }
        d.remove();
    }
    entry.regs.panels.delete(id);
}

let menuTimer = null;
function syncMenu() {
    clearTimeout(menuTimer);
    menuTimer = setTimeout(() => {
        const items = [];
        for (const entry of plugins.values()) for (const reg of entry.regs.actions.values()) items.push({ id: reg.id, label: reg.def.label, accelerator: reg.def.accelerator || null });
        window.scumble.plugins.menu(items).catch((err) => console.warn("plugin menu", err));
    }, 50);
}

function registerAction(entry, def) {
    if (!def || typeof def.run !== "function") throw new Error("actions.register needs { id, label, run(doc, scumble) }");
    const id = fullId(entry, def.id);
    if (entry.regs.actions.has(id)) throw new Error(`action "${id}" is already registered`);
    entry.regs.actions.set(id, { id, def: { ...def, label: def.label || def.id } });
    syncMenu();
    return id;
}

function unregisterAction(entry, id) {
    if (entry.regs.actions.delete(id)) syncMenu();
}

/** Run an action by its full id on an editor (the active one by default). */
export async function runAction(id, ed = host.editor) {
    for (const entry of plugins.values()) {
        const reg = entry.regs.actions.get(id);
        if (!reg) continue;
        if (!ed) throw new Error("no document is open");
        try { return await reg.def.run(new Document(ed), entry.api); }
        catch (err) { report(entry, `action ${reg.def.id}`, err); throw err; }
    }
    throw new Error(`no plugin action "${id}"`);
}

function registerTool(entry, def) {
    if (!def || typeof def !== "object") throw new Error("tools.register needs { id, label, title, onDown/onMove/onUp(doc, ev) }");
    const id = fullId(entry, def.id);
    if (entry.regs.tools.has(id)) throw new Error(`tool "${id}" is already registered`);
    const reg = { id, def: { ...def, label: def.label || def.id, title: def.title || def.label || def.id }, buttons: new Map() };
    entry.regs.tools.set(id, reg);
    for (const ed of host.editors()) mountTool(entry, reg, ed);
    return id;
}

function toolButtonHtml(def) {
    if (typeof def.icon === "string" && def.icon.trim().startsWith("<svg")) return def.icon;
    if (typeof def.icon === "string" && def.icon) { try { const h = icon(def.icon); if (!h.includes("undefined")) return h; } catch (_) { /* fall through */ } return `<span class="scumble-tool-glyph">${def.icon.slice(0, 2)}</span>`; }
    return `<span class="scumble-tool-glyph">${String(def.label || "?").slice(0, 2)}</span>`;
}

function mountTool(entry, reg, ed) {
    if (!ed.toolsEl || reg.buttons.has(ed)) return;
    if (!ed._pluginToolsGrp) {
        ed.toolsEl.appendChild(el("div", "ipc-sep"));
        ed._pluginToolsGrp = el("div", "ipc-grp", "Plugins");
        ed.toolsEl.appendChild(ed._pluginToolsGrp);
    }
    const b = el("button", "ipc-ib scumble-plugin-tool");
    b.type = "button";
    b.title = reg.def.title + (reg.def.key ? ` (${reg.def.key})` : "");
    b.innerHTML = toolButtonHtml(reg.def);
    b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); ed.setTool(reg.id); });
    ed.toolsEl.appendChild(b);
    ed.toolButtons[reg.id] = b;
    reg.buttons.set(ed, b);
    ed._pluginToolsGrp.hidden = false;
}

function unregisterTool(entry, id) {
    const reg = entry.regs.tools.get(id);
    if (!reg) return;
    for (const [ed, b] of reg.buttons) {
        b.remove();
        delete ed.toolButtons[id];
        if (ed.tool === id) ed.setTool("select");
        if (ed._pluginToolsGrp && !Object.keys(ed.toolButtons).some((k) => k.includes("."))) ed._pluginToolsGrp.hidden = true;
    }
    entry.regs.tools.delete(id);
}

function toolReg(id) {
    for (const entry of plugins.values()) { const reg = entry.regs.tools.get(id); if (reg) return { entry, reg }; }
    return null;
}

function pointerEvent(e, ix, iy, ed) {
    return { x: ix, y: iy, shift: !!e.shiftKey, alt: !!e.altKey, ctrl: !!(e.ctrlKey || e.metaKey), button: e.button, pressure: e.pressure, pointerType: e.pointerType, inside: ix >= 0 && iy >= 0 && ix < ed.width && iy < ed.height, raw: e };
}

/** Called by host.pluginPointer (patched into the editor's pointer handlers). */
function pointer(ed, phase, e, ix, iy, p) {
    if (phase === "down") {
        const t = toolReg(ed.tool);
        if (!t) return false;
        if (!ed.base && !t.reg.def.allowEmpty) { ed.setStatus("Load an image first."); return true; }
        ed.pointer = { kind: "plugin", tool: t.reg.id, start: [ix, iy], last: [ix, iy] };
        try { if (t.reg.def.onDown) t.reg.def.onDown(new Document(ed), pointerEvent(e, ix, iy, ed)); } catch (err) { report(t.entry, `tool ${t.reg.def.id}`, err); }
        return true;
    }
    if (phase === "move") {
        const cur = ed.pointer;
        if (cur && cur.kind === "plugin") {
            const t = toolReg(cur.tool);
            cur.last = [ix, iy];
            if (t) { try { if (t.reg.def.onMove) t.reg.def.onMove(new Document(ed), pointerEvent(e, ix, iy, ed)); } catch (err) { report(t.entry, `tool ${t.reg.def.id}`, err); } }
            return true;
        }
        if (cur) return false;
        const t = toolReg(ed.tool);
        if (!t) return false;
        try { if (t.reg.def.onHover) t.reg.def.onHover(new Document(ed), pointerEvent(e, ix, iy, ed)); } catch (err) { report(t.entry, `tool ${t.reg.def.id}`, err); }
        ed.draw();
        return true;
    }
    if (phase === "up") {
        const t = toolReg(p && p.tool);
        if (t) { try { if (t.reg.def.onUp) t.reg.def.onUp(new Document(ed), pointerEvent(e, ix, iy, ed)); } catch (err) { report(t.entry, `tool ${t.reg.def.id}`, err); } }
        return true;
    }
    return false;
}

/** Called by host.pluginKey for single-key shortcuts (no Ctrl / Alt); "Shift+X" allowed. */
function key(ed, e, k) {
    const match = (spec) => {
        if (!spec) return false;
        const parts = String(spec).toLowerCase().split("+").map((s) => s.trim());
        const want = parts[parts.length - 1];
        const shift = parts.includes("shift");
        return want === k && shift === !!e.shiftKey;
    };
    for (const entry of plugins.values()) {
        for (const reg of entry.regs.tools.values()) if (match(reg.def.key)) { ed.setTool(reg.id); return true; }
        for (const reg of entry.regs.actions.values()) if (match(reg.def.key)) { runAction(reg.id, ed).catch(() => {}); return true; }
    }
    return false;
}

function toolChanged({ editor, tool, prev }) {
    const was = toolReg(prev), now = toolReg(tool);
    if (was && was.reg.id !== tool) { try { if (was.reg.def.onDeselect) was.reg.def.onDeselect(new Document(editor)); } catch (err) { report(was.entry, `tool ${was.reg.def.id}`, err); } }
    if (now) {
        try { if (now.reg.def.onSelect) now.reg.def.onSelect(new Document(editor)); } catch (err) { report(now.entry, `tool ${now.reg.def.id}`, err); }
        if (now.reg.def.hint && (!editor.status || !editor.status.startsWith(now.reg.def.hint))) editor.setStatus(now.reg.def.hint);
    }
}

// ---- the API object one plugin gets ----------------------------------------------------------

function makeApi(entry) {
    const m = entry.manifest;
    const docOf = (ed) => (ed ? new Document(ed) : null);
    const api = {
        version: API_VERSION,
        id: entry.id,
        name: m.name || entry.id,
        manifest: { ...m },
        /** URL of a file inside the plugin folder (fetch it, or use it as an image src). */
        url: (rel) => `/plugins/${entry.id}/${String(rel).replace(/^\/+/, "")}`,
        log: (...a) => console.log(`[${entry.id}]`, ...a),
        warn: (...a) => console.warn(`[${entry.id}]`, ...a),

        commands: {
            run: (name, args) => commands.run(name, args),
            call: (name, args) => commands.call(name, args),
            list: () => commands.describe(),
            /** Add a command: { description, params, scope, needsImage, run(doc, args) }; the editor is wrapped as a Document. */
            register(name, def) {
                const id = fullId(entry, name);
                commands.register(id, { ...def, run: (ed, args) => def.run(docOf(ed), args, api) }, entry.id);
                entry.regs.commands.add(id);
                return id;
            },
        },

        documents: {
            active: () => docOf(host.editor),
            all: () => host.editors().map(docOf),
            byId: (id) => docOf(host.editorById(id)),
        },

        filters: { register: (def) => registerFilter(entry, def), unregister: (id) => unregisterFilter(entry, id.includes(".") ? id : `${entry.id}.${id}`) },
        panels: { register: (def) => registerPanel(entry, def), unregister: (id) => unregisterPanel(entry, id.includes(".") ? id : `${entry.id}.${id}`) },
        actions: { register: (def) => registerAction(entry, def), unregister: (id) => unregisterAction(entry, id.includes(".") ? id : `${entry.id}.${id}`), run: (id) => runAction(id.includes(".") ? id : `${entry.id}.${id}`) },
        tools: { register: (def) => registerTool(entry, def), unregister: (id) => unregisterTool(entry, id.includes(".") ? id : `${entry.id}.${id}`) },

        events: {
            /** built, activate, changed, tool, removed: fn({ doc, ... }); returns the off() function. */
            on(type, fn) {
                const wrapped = (data) => { try { fn({ ...data, doc: docOf(data.editor) }); } catch (err) { report(entry, `on ${type}`, err); } };
                const off = host.on(type, wrapped);
                entry.regs.listeners.push(off);
                return off;
            },
        },

        storage: {
            get: () => window.scumble.plugins.getData(entry.id),
            set: (patch) => window.scumble.plugins.setData(entry.id, patch || {}),
        },

        ui: {
            status: (text) => { if (host.editor) host.editor.setStatus(String(text)); },
            confirm: (text) => window.confirm(String(text)),
            el,
            icon,
            button(label, title, onClick) {
                const b = el("button", "ipc-ib ipc-small", label);
                b.type = "button"; b.title = title || "";
                b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); try { onClick(e); } catch (err) { report(entry, "button", err); } });
                return b;
            },
            slider(label, { min = 0, max = 100, step = 1, value = 0, unit = "" } = {}, onChange) {
                const row = el("div", "scumble-plugin-row");
                row.appendChild(el("span", "scumble-plugin-label", label));
                const input = document.createElement("input");
                input.type = "range"; input.min = min; input.max = max; input.step = step; input.value = value;
                const val = el("span", "scumble-plugin-value", `${value}${unit}`);
                input.addEventListener("input", () => { val.textContent = `${input.value}${unit}`; try { onChange(+input.value, false); } catch (err) { report(entry, "slider", err); } });
                input.addEventListener("change", () => { try { onChange(+input.value, true); } catch (err) { report(entry, "slider", err); } });
                input.addEventListener("keydown", (e) => e.stopPropagation());
                row.appendChild(input); row.appendChild(val);
                return row;
            },
        },

        makeCanvas,
        /** The app's host object and the raw editors: unstable, for what the API does not cover. */
        host,
    };
    return api;
}

// ---- loading --------------------------------------------------------------------------------

async function load(p) {
    const entry = { id: p.id, manifest: p, module: null, api: null, regs: newRegs(), loaded: false, error: p.error || null, errors: [] };
    plugins.set(p.id, entry);
    if (p.error) return entry;
    try {
        const mod = await import(`/plugins/${encodeURIComponent(p.id)}/${p.entry}?v=${Date.now()}`);
        entry.module = mod;
        entry.api = makeApi(entry);
        const fn = typeof mod.activate === "function" ? mod.activate : (typeof mod.default === "function" ? mod.default : null);
        if (!fn) throw new Error("the entry module exports no activate(scumble) function");
        await fn(entry.api);
        entry.loaded = true;
    } catch (err) {
        entry.error = String((err && err.stack) || err);
        console.error(`plugin ${p.id} failed to load:`, err);
        removeRegs(entry);
    }
    if (onChanged) onChanged();
    return entry;
}

function removeRegs(entry) {
    for (const id of Array.from(entry.regs.filters)) unregisterFilter(entry, id);
    for (const id of Array.from(entry.regs.panels.keys())) unregisterPanel(entry, id);
    for (const id of Array.from(entry.regs.actions.keys())) unregisterAction(entry, id);
    for (const id of Array.from(entry.regs.tools.keys())) unregisterTool(entry, id);
    for (const id of Array.from(entry.regs.commands)) commands.unregister(id, entry.id);
    for (const off of entry.regs.listeners) { try { off(); } catch (_) { /* ignore */ } }
    entry.regs = newRegs();
}

async function unload(entry) {
    if (entry.loaded && entry.module && typeof entry.module.deactivate === "function") {
        try { await entry.module.deactivate(entry.api); } catch (err) { console.warn(`plugin ${entry.id} deactivate:`, err); }
    }
    removeRegs(entry);
    entry.loaded = false;
    plugins.delete(entry.id);
    if (onChanged) onChanged();
}

/** Load every enabled plugin that is not loaded yet; unload those disabled or gone. */
export async function loadPlugins() {
    const list = await fetchList();
    const present = new Set(list.map((p) => p.id));
    for (const entry of Array.from(plugins.values())) {
        const p = list.find((x) => x.id === entry.id);
        if (!present.has(entry.id) || !p.enabled) await unload(entry);
    }
    for (const p of list) if (p.enabled && !plugins.has(p.id)) await load(p);
    return listPlugins();
}

/** Unload everything and load again from disk (fresh manifests and modules). */
export async function reloadPlugins() {
    for (const entry of Array.from(plugins.values())) await unload(entry);
    return loadPlugins();
}

export async function setEnabled(id, on) {
    await window.scumble.plugins.setEnabled(id, on);
    return loadPlugins();
}

/** For Settings › Plugins and the list_plugins command: manifests, state, what each registered. */
export function listPlugins(fresh) {
    const out = [];
    const known = fresh || lastList;
    for (const p of known) {
        const entry = plugins.get(p.id);
        out.push({
            id: p.id, name: p.name || p.id, version: p.version || "", description: p.description || "", author: p.author || "", homepage: p.homepage || "",
            source: p.source, dir: p.dir, enabled: !!p.enabled, loaded: !!(entry && entry.loaded), error: (entry && entry.error) || p.error || null, errors: entry ? entry.errors.slice() : [],
            registered: entry ? {
                filters: Array.from(entry.regs.filters), panels: Array.from(entry.regs.panels.keys()), actions: Array.from(entry.regs.actions.keys()).map((id) => ({ id, label: entry.regs.actions.get(id).def.label })),
                tools: Array.from(entry.regs.tools.keys()), commands: Array.from(entry.regs.commands),
            } : { filters: [], panels: [], actions: [], tools: [], commands: [] },
        });
    }
    return out;
}

let lastList = [];
/** The manifests as the main process sees them (fresh from disk); listPlugins() merges the state. */
export async function fetchList() {
    lastList = await window.scumble.plugins.list();
    return lastList;
}

// new editors get the panels and tools of every loaded plugin
host.on("built", ({ editor }) => {
    for (const entry of plugins.values()) {
        for (const reg of entry.regs.panels.values()) mountPanel(entry, reg, editor);
        for (const reg of entry.regs.tools.values()) mountTool(entry, reg, editor);
    }
});
host.on("tool", toolChanged);

export const pluginHost = { pointer, key, runAction, list: () => listPlugins(), reload: reloadPlugins, load: loadPlugins, setEnabled, entries: () => plugins };
host.plugins = pluginHost;
