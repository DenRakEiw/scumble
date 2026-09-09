// Recipes: the shipped ones in <app>/recipes, the user's in <userData>/recipes. A recipe
// is an API-format prompt with a fixed canvas node id (ComfyUI recipes) or a provider
// call (API recipes); see docs/RECIPES.md. This file lists them and imports a user's
// ComfyUI workflow (UI format from Save / Export, or API format from Export (API)) that
// contains an Inpaint Canvas node.
"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const { app } = require("electron");

const FIXED_OUTPUTS = 13;   // InpaintCanvas outputs before setting_1 (nodes.py RETURN_NAMES)
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
const SKIP_TYPES = new Set(["Note", "MarkdownNote", "PrimitiveNode", "Reroute"]);

function userDir() {
    return path.join(app.getPath("userData"), "recipes");
}

async function readDir(dir, source) {
    const out = [];
    let names = [];
    try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".json")).sort(); } catch (_) { return out; }
    for (const n of names) {
        try {
            const r = JSON.parse(await fsp.readFile(path.join(dir, n), "utf8"));
            r.id = r.id || n.replace(/\.json$/, "");
            r.file = n;
            r.source = source;
            r.kind = r.kind === "provider" ? "provider" : "comfy";
            out.push(normalize(r));
        } catch (err) {
            console.warn("recipe", n, "unreadable:", err.message);
        }
    }
    return out;
}

/**
 * Provider recipes are model-centric: `providers` maps a provider id to the variant that
 * runs the model there ({ model, input, fields, fixed, settings, options, note }) and
 * `default` names the home provider. A recipe with a top-level `provider` (the old shape,
 * the smoke test's loopback) becomes a one-provider recipe.
 */
function normalize(r) {
    if (r.kind !== "provider") return r;
    if (!r.providers || typeof r.providers !== "object" || !Object.keys(r.providers).length) {
        const id = r.provider || "loopback";
        r.providers = { [id]: { model: r.model || "", input: r.input || "fill", fields: r.fields || null, fixed: r.fixed || null, settings: r.settings || [], options: r.options || null, note: r.note || "" } };
        r.default = id;
    }
    r.providerIds = Object.keys(r.providers);
    if (!r.default || !r.providers[r.default]) r.default = r.providerIds[0];
    return r;
}

async function list(builtinDir) {
    const builtin = await readDir(builtinDir, "builtin");
    const user = await readDir(userDir(), "user");
    const seen = new Set(user.map((r) => r.id));
    return [...user, ...builtin.filter((r) => !seen.has(r.id))];
}

async function remove(id) {
    const safe = String(id || "").replace(/[^A-Za-z0-9._-]/g, "");
    if (!safe) throw new Error("bad recipe id");
    await fsp.unlink(path.join(userDir(), safe + ".json"));
    return true;
}

async function save(recipe) {
    await fsp.mkdir(userDir(), { recursive: true });
    const file = path.join(userDir(), recipe.id + ".json");
    await fsp.writeFile(file, JSON.stringify(recipe, null, 2) + "\n", "utf8");
    return file;
}

function slug(name) {
    return String(name || "recipe").toLowerCase().replace(/\.json$/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "recipe";
}

// ---- conversion ----------------------------------------------------------------------

/** Widget input names of a node class in widgets_values order, with the seed control slots marked. */
function widgetNames(info) {
    const out = [];
    if (!info || !info.input) return out;
    for (const group of ["required", "optional"]) {
        for (const [name, spec] of Object.entries(info.input[group] || {})) {
            if (!Array.isArray(spec)) continue;
            const type = spec[0], opts = spec[1] || {};
            const isWidget = Array.isArray(type) || WIDGET_TYPES.has(type);
            if (!isWidget || opts.forceInput) continue;
            out.push({ name, spec });
            const control = opts.control_after_generate || ((type === "INT") && (name === "seed" || name === "noise_seed"));
            if (control) out.push({ name: null, control: true });   // "randomize" / "fixed" takes one slot
        }
    }
    return out;
}

/** A spec for the recipe file: combo lists shrink to the chosen value (the live list comes from /object_info at run time). */
function storedSpec(spec, value) {
    if (!Array.isArray(spec)) return undefined;
    if (Array.isArray(spec[0])) return [[value !== undefined ? value : spec[0][0]], {}];
    if (spec[0] === "COMBO") return [[value !== undefined ? value : ((spec[1] && spec[1].options) || [""])[0]], {}];
    return spec;
}

function specDefault(spec) {
    if (!Array.isArray(spec)) return undefined;
    const type = spec[0], opts = spec[1] || {};
    if (opts.default !== undefined) return opts.default;
    if (Array.isArray(type)) return type[0];
    if (type === "COMBO") return Array.isArray(opts.options) ? opts.options[0] : undefined;
    if (type === "INT" || type === "FLOAT") return 0;
    if (type === "BOOLEAN") return false;
    return "";
}

/**
 * A UI-format workflow (nodes / links) -> API-format prompt plus the recipe fields.
 * `objectInfo` is the server's /object_info (widget order and setting specs).
 *
 * Subgraphs (definitions.subgraphs) are flattened the way ComfyUI executes them: an
 * inner node gets the id "<instance id>:<inner id>", links from the subgraph's input
 * node (-10) take the instance's incoming link (or its promoted widget value), links
 * into the output node (-20) are followed when something outside reads that output.
 */
function fromWorkflow(wf, objectInfo, meta) {
    const defs = new Map(((wf.definitions && wf.definitions.subgraphs) || []).map((d) => [d.id, d]));
    const nodes = new Map();       // flat id -> node (with _prefix)
    const links = new Map();       // flat link id -> { id, origin, originSlot, target, targetSlot, type }
    const instances = new Map();   // flat id of a subgraph instance -> { def, prefix }
    const overrides = new Map();   // "<flat node id>|<input index>" -> promoted widget value

    /** The promoted widget value of subgraph input k on an instance node (its widgets_values follow the widget inputs in order). */
    function instanceWidgetValue(inst, k) {
        const values = Array.isArray(inst.widgets_values) ? inst.widgets_values : [];
        let vi = 0;
        for (let i = 0; i < (inst.inputs || []).length; i++) {
            const inp = inst.inputs[i];
            if (!inp.widget) continue;
            if (i === k) return values[vi];
            vi += 1;
            if (inp.type === "INT" && (inp.name === "seed" || inp.name === "noise_seed")) vi += 1;   // control_after_generate slot
        }
        return undefined;
    }

    function parseLink(l) {
        if (Array.isArray(l)) return { id: l[0], origin: String(l[1]), originSlot: +l[2], target: String(l[3]), targetSlot: +l[4], type: l[5] };
        if (l && l.id != null) return { id: l.id, origin: String(l.origin_id), originSlot: +l.origin_slot, target: String(l.target_id), targetSlot: +l.target_slot, type: l.type };
        return null;
    }

    function addGraph(gNodes, gLinks, prefix, inst) {
        const pid = (id) => prefix + String(id);
        for (const raw of gLinks || []) {
            const l = parseLink(raw);
            if (!l) continue;
            if (l.origin === "-10") {
                // from the subgraph's input node: the instance's incoming link, else its promoted widget value
                const inp = inst && (inst.inputs || [])[l.originSlot];
                const outer = inp && inp.link != null ? links.get(inst._prefix + String(inp.link)) : null;
                // the promoted widget on the instance holds the current value (the inner
                // node's widgets_values can be stale); it is the input's value when nothing
                // is linked, and the value a setting link replaced otherwise
                const v = inst ? instanceWidgetValue(inst, l.originSlot) : undefined;
                if (v !== undefined) overrides.set(`${pid(l.target)}|${l.targetSlot}`, v);
                if (!outer) continue;
                l.origin = outer.origin; l.originSlot = outer.originSlot;
            } else {
                l.origin = pid(l.origin);
            }
            l.target = l.target === "-20" ? prefix + "-20" : pid(l.target);
            links.set(pid(l.id), l);
        }
        for (const n of gNodes || []) {
            const node = { ...n, id: pid(n.id), _prefix: prefix };
            nodes.set(node.id, node);
            if (defs.has(n.type)) {
                const def = defs.get(n.type);
                instances.set(node.id, { def, prefix: node.id + ":" });
                addGraph(def.nodes, def.links, node.id + ":", node);
            }
        }
    }
    addGraph(wf.nodes, wf.links, "", null);

    const canvasNodes = Array.from(nodes.values()).filter((n) => n.type === "InpaintCanvas");
    if (!canvasNodes.length) throw new Error("This workflow has no Inpaint Canvas node.");
    if (canvasNodes.length > 1) throw new Error("This workflow has more than one Inpaint Canvas node; a recipe needs exactly one.");
    const canvasNode = canvasNodes[0];
    const canvasId = canvasNode.id;

    /** Follow a link back through reroutes, primitives, bypassed nodes and subgraph outputs to a real source. */
    function resolveLink(l, depth = 0) {
        if (!l || depth > 80) return null;
        const src = nodes.get(l.origin);
        if (!src) return null;
        if (instances.has(l.origin)) {
            const inner = Array.from(links.values()).find((x) => x.target === l.origin + ":-20" && x.targetSlot === l.originSlot);
            return inner ? resolveLink(inner, depth + 1) : null;
        }
        if (src.type === "Reroute") {
            const inp = (src.inputs || [])[0];
            return inp && inp.link != null ? resolveLink(links.get(src._prefix + String(inp.link)), depth + 1) : null;
        }
        if (src.type === "PrimitiveNode") return { primitive: true };
        if (src.mode === 4) {
            // bypassed: the output passes an input of the same type through (same slot first)
            const outType = (src.outputs || [])[l.originSlot] && src.outputs[l.originSlot].type;
            const ins = src.inputs || [];
            const cand = (ins[l.originSlot] && ins[l.originSlot].type === outType && ins[l.originSlot].link != null ? ins[l.originSlot] : null) || ins.find((i) => i.type === outType && i.link != null);
            return cand ? resolveLink(links.get(src._prefix + String(cand.link)), depth + 1) : null;
        }
        if (src.mode === 2) return { muted: true };
        return { id: l.origin, slot: l.originSlot };
    }
    const resolve = (node, linkId) => resolveLink(links.get(node._prefix + String(linkId)));

    const prompt = {};
    const widgetValues = new Map();   // flat id -> { input: widget value } before links replaced them
    const missingTypes = new Set();
    for (const n of nodes.values()) {
        const id = n.id;
        if (SKIP_TYPES.has(n.type) || instances.has(id) || n.mode === 2 || n.mode === 4) continue;
        const info = objectInfo[n.type];
        if (!info) missingTypes.add(n.type);
        const inputs = {};
        if (id !== canvasId) {
            const names = widgetNames(info);
            const values = Array.isArray(n.widgets_values) ? n.widgets_values : [];
            let vi = 0;
            for (const w of names) {
                if (vi >= values.length) break;
                const v = values[vi++];
                if (w.name) inputs[w.name] = v;
            }
            widgetValues.set(id, { ...inputs });
        }
        (n.inputs || []).forEach((inp, idx) => {
            if (inp.link == null) return;
            if (id === canvasId && (inp.name === "result" || inp.name === "result_local")) return;
            const ov = overrides.get(`${id}|${idx}`);
            if (ov !== undefined && !links.has(n._prefix + String(inp.link))) { inputs[inp.name] = ov; return; }
            const src = resolve(n, inp.link);
            if (!src || src.primitive) return;       // primitives: the target's widgets_values hold the value
            if (src.muted) { delete inputs[inp.name]; return; }
            inputs[inp.name] = [src.id, src.slot];
        });
        prompt[id] = { class_type: n.type, inputs, ...(n.title ? { _meta: { title: n.title } } : {}) };
    }
    // links whose source was dropped (muted, unknown) leave dangling refs
    for (const node of Object.values(prompt)) {
        for (const [k, v] of Object.entries(node.inputs)) if (Array.isArray(v) && !prompt[v[0]]) delete node.inputs[k];
    }

    const wired = (name) => {
        const inp = (canvasNode.inputs || []).find((i) => i.name === name);
        const src = inp && inp.link != null ? resolve(canvasNode, inp.link) : null;
        return src && src.id ? `${src.id}:${src.slot}` : null;
    };
    const resultLocal = wired("result_local"), resultApi = wired("result");
    if (!resultLocal && !resultApi) throw new Error("Nothing is wired into the Inpaint Canvas node's result or result_local input, so no result could come back.");

    // setting outputs: the first real (non-instance) consumer of setting_n, found on the flattened links
    const settings = [];
    (canvasNode.outputs || []).forEach((o, i) => {
        if (i < FIXED_OUTPUTS || !o || !o.links || !o.links.length) return;
        const l = Array.from(links.values()).find((x) => x.origin === canvasId && x.originSlot === i && !instances.has(x.target) && !x.target.endsWith("-20") && prompt[x.target]);
        if (!l) return;
        const target = nodes.get(l.target);
        const tin = (target.inputs || [])[l.targetSlot];
        if (!tin) return;
        const info = objectInfo[target.type];
        const spec = info && info.input && ((info.input.required && info.input.required[tin.name]) || (info.input.optional && info.input.optional[tin.name])) || null;
        const node = prompt[l.target];
        const current = node.inputs[tin.name];
        if (Array.isArray(current)) {
            const ov = overrides.get(`${l.target}|${l.targetSlot}`);
            const wv = widgetValues.get(l.target) || {};
            node.inputs[tin.name] = ov !== undefined ? ov : (wv[tin.name] !== undefined ? wv[tin.name] : specDefault(spec));
        }
        const stored = storedSpec(spec, node.inputs[tin.name]);
        settings.push({ index: i - FIXED_OUTPUTS + 1, node: l.target, input: tin.name, label: `${target.title || target.type} · ${tin.name}`, ...(stored ? { spec: stored } : {}) });
    });

    const mode = resultLocal ? "local" : "api";
    const needs = Array.from(new Set(Object.values(prompt).map((n) => n.class_type)));
    const notes = [];
    if (resultLocal && resultApi) notes.push("both result inputs were wired; the recipe uses result_local (mode local)");
    if (missingTypes.size) notes.push("node types unknown to this server: " + Array.from(missingTypes).join(", "));
    if (instances.size) notes.push(`${instances.size} subgraph${instances.size > 1 ? "s" : ""} flattened`);
    return {
        kind: "comfy", mode, canvas: canvasId, result: resultLocal || resultApi, needs, settings, prompt,
        description: `Imported from ${meta.file} on ${meta.date}.` + (notes.length ? " " + notes.join("; ") + "." : ""),
        notes,
    };
}

/** An API-format prompt (Export (API), or the node's own saved prompt) -> recipe fields. */
function fromPrompt(src, objectInfo, meta) {
    const prompt = JSON.parse(JSON.stringify(src));
    const canvasIds = Object.keys(prompt).filter((id) => prompt[id] && prompt[id].class_type === "InpaintCanvas");
    if (!canvasIds.length) throw new Error("This prompt has no Inpaint Canvas node.");
    if (canvasIds.length > 1) throw new Error("This prompt has more than one Inpaint Canvas node; a recipe needs exactly one.");
    const canvasId = canvasIds[0];
    const canvas = prompt[canvasId];
    const asRef = (v) => (Array.isArray(v) && v.length === 2 ? `${v[0]}:${v[1]}` : (typeof v === "string" && v ? v : null));
    const resultLocal = asRef(canvas.inputs.result_source_local) || asRef(canvas.inputs.result_local);
    const resultApi = asRef(canvas.inputs.result_source) || asRef(canvas.inputs.result);
    if (!resultLocal && !resultApi) throw new Error("The Inpaint Canvas node has no result_source / result_source_local; nothing would come back.");
    canvas.inputs = {};
    const settings = [];
    for (const [id, node] of Object.entries(prompt)) {
        if (!node || !node.inputs) continue;
        for (const [name, v] of Object.entries(node.inputs)) {
            if (!Array.isArray(v) || String(v[0]) !== canvasId || +v[1] < FIXED_OUTPUTS) continue;
            const info = objectInfo[node.class_type];
            const spec = info && info.input && ((info.input.required && info.input.required[name]) || (info.input.optional && info.input.optional[name])) || null;
            node.inputs[name] = specDefault(spec);
            const stored = storedSpec(spec, node.inputs[name]);
            settings.push({ index: +v[1] - FIXED_OUTPUTS + 1, node: id, input: name, label: `${(node._meta && node._meta.title) || node.class_type} · ${name}`, ...(stored ? { spec: stored } : {}) });
        }
    }
    settings.sort((a, b) => a.index - b.index);
    const mode = resultLocal ? "local" : "api";
    const needs = Array.from(new Set(Object.values(prompt).map((n) => n.class_type)));
    const notes = [];
    if (resultLocal && resultApi) notes.push("both result inputs were wired; the recipe uses result_local (mode local)");
    return { kind: "comfy", mode, canvas: canvasId, result: resultLocal || resultApi, needs, settings, prompt, description: `Imported from ${meta.file} on ${meta.date}.` + (notes.length ? " " + notes.join("; ") + "." : ""), notes };
}

function looksLikePrompt(obj) {
    const vals = Object.values(obj || {});
    return vals.length > 0 && vals.every((v) => v && typeof v === "object" && typeof v.class_type === "string");
}

/**
 * Import a workflow file. `objectInfo` comes from the connected server (null when
 * offline: API-format files still work, UI-format files need the widget order).
 */
async function importFile(file, objectInfo) {
    const text = await fsp.readFile(file, "utf8");
    let data;
    try { data = JSON.parse(text); } catch (err) { throw new Error("Not a JSON file: " + err.message); }
    const meta = { file: path.basename(file), date: new Date().toISOString().slice(0, 10) };
    let recipe;
    if (data && data.kind && data.prompt && data.canvas) {
        recipe = { ...data };            // a Scumble recipe file
    } else if (data && data.kind === "provider" && data.provider) {
        recipe = { ...data };
    } else if (data && Array.isArray(data.nodes)) {
        if (!objectInfo) throw new Error("Reading a workflow saved from the ComfyUI UI needs the node definitions: connect to ComfyUI first (or export the workflow in API format).");
        recipe = fromWorkflow(data, objectInfo, meta);
    } else if (looksLikePrompt(data)) {
        recipe = fromPrompt(data, objectInfo || {}, meta);
    } else if (data && data.workflow && Array.isArray(data.workflow.nodes)) {
        if (!objectInfo) throw new Error("Reading a workflow saved from the ComfyUI UI needs the node definitions: connect to ComfyUI first.");
        recipe = fromWorkflow(data.workflow, objectInfo, meta);
    } else {
        throw new Error("This file is neither a ComfyUI workflow, an API-format prompt nor a Scumble recipe.");
    }
    const stem = path.basename(file).replace(/\.json$/i, "");
    recipe.id = recipe.id && data.kind ? slug(recipe.id) : slug(stem);
    recipe.name = recipe.name || stem;
    // never shadow a shipped recipe silently
    recipe.id = recipe.id.replace(/^flux2_klein_local$/, "flux2_klein_local_imported");
    const saved = await save(recipe);
    return { ...recipe, file: path.basename(saved), source: "user" };
}

module.exports = { list, remove, save, importFile, fromWorkflow, fromPrompt, userDir };
