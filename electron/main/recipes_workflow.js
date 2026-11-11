// @ts-check
// readWidgets, storedSpec, specDefault and fromWorkflow (the import of a ComfyUI UI graph): moved out of recipes.js (item 56 S11, docs/PLAN_SPLIT.md), text unchanged.
"use strict";

const { FIXED_OUTPUTS, SKIP_TYPES, UI_WIDGETS, WIDGET_TYPES, backendOutputName, tailOutputs } = require("./recipes_store");

// ---- conversion ----------------------------------------------------------------------

/**
 * A node's widget values by name, read in `widgets_values` order from its class's inputs: a dynamic combo
 * (COMFY_DYNAMICCOMBO_V3: SaveImageAdvanced's format, TextGenerate's sampling_mode) takes its slot and then the slots of
 * the chosen option's own widgets, named "<combo>.<widget>" as a run takes them; a seed's control takes a slot.
 * @param {any} info
 * @param {any[]} values
 */
function readWidgets(info, values) {
    /** @type {Record<string, any>} */
    const inputs = {};
    let at = 0;
    const walk = (/** @type {any} */ groups, /** @type {string} */ prefix) => {
        for (const group of ["required", "optional"]) {
            for (const [name, spec] of Object.entries((groups && groups[group]) || {})) {
                if (!Array.isArray(spec) || at >= values.length) continue;
                const type = spec[0], opts = spec[1] || {}, key = prefix + name;
                if (type === "COMFY_DYNAMICCOMBO_V3") {
                    const v = values[at++];
                    inputs[key] = v;
                    const opt = (opts.options || []).find((/** @type {any} */ o) => o && o.key === v);
                    if (opt) walk(opt.inputs, key + ".");
                    continue;
                }
                if (!(Array.isArray(type) || WIDGET_TYPES.has(type)) || opts.forceInput) continue;
                inputs[key] = values[at++];
                if (opts.control_after_generate || (type === "INT" && (name === "seed" || name === "noise_seed"))) at++;   // "randomize" / "fixed"
            }
        }
    };
    walk(info && info.input, "");
    return inputs;
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
 *
 * `opts.noCanvas` (item 35 V5c, a graph exported from Comfy Cloud): a workflow without the Inpaint Canvas node is
 * flattened too, and only { prompt, needs, notes } come back (fromCloudGraph makes the recipe).
 */
function fromWorkflow(wf, objectInfo, meta, opts) {
    const defs = new Map(((wf.definitions && wf.definitions.subgraphs) || []).map((d) => [d.id, d]));
    const nodes = new Map();       // flat id -> node (with _prefix)
    const links = new Map();       // flat link id -> { id, origin, originSlot, target, targetSlot, type }
    const instances = new Map();   // flat id of a subgraph instance -> { def, prefix }
    const overrides = new Map();   // "<flat node id>|<input index>" -> promoted widget value

    /**
     * The instance's input for subgraph input k. The newer subgraph format lists on the instance only the inputs it
     * shows, in an order of its own (Comfy's image-edit templates, 2026-10: 19 of 30, reordered), so the input is found
     * by the definition's name for slot k (none when the instance does not show it); a definition without names is read by
     * position, as the older format was.
     */
    function instanceInput(inst, def, k) {
        const name = def && Array.isArray(def.inputs) && def.inputs[k] ? def.inputs[k].name : null;
        if (name != null) {
            // a named slot the instance does not show takes its value from widgets_values, never another input's link
            const byName = (inst.inputs || []).find((i) => i && i.name === name);
            return byName || null;
        }
        return (inst.inputs || [])[k];
    }

    /**
     * The promoted widget value of subgraph input k on an instance node. Newer instances keep one value per widget-typed
     * input of the definition, in the definition's order (their widgets_values has exactly that many entries); older
     * ones follow the instance's own widget inputs, with a slot after a seed for control_after_generate.
     */
    function instanceWidgetValue(inst, k, def) {
        const values = Array.isArray(inst.widgets_values) ? inst.widgets_values : [];
        const defInputs = def && Array.isArray(def.inputs) ? def.inputs : null;
        if (defInputs) {
            const widgetSlots = defInputs.map((d, i) => (d && WIDGET_TYPES.has(String(d.type)) ? i : -1)).filter((i) => i >= 0);
            if (widgetSlots.length && widgetSlots.length === values.length) {
                const at = widgetSlots.indexOf(k);
                return at >= 0 ? values[at] : undefined;
            }
        }
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

    function addGraph(gNodes, gLinks, prefix, inst, def) {
        const pid = (id) => prefix + String(id);
        for (const raw of gLinks || []) {
            const l = parseLink(raw);
            if (!l) continue;
            if (l.origin === "-10") {
                // from the subgraph's input node: the instance's incoming link, else its promoted widget value
                const inp = inst ? instanceInput(inst, def, l.originSlot) : null;
                const outer = inp && inp.link != null ? links.get(inst._prefix + String(inp.link)) : null;
                // the promoted widget on the instance holds the current value (the inner
                // node's widgets_values can be stale); it is the input's value when nothing
                // is linked, and the value a setting link replaced otherwise
                const v = inst ? instanceWidgetValue(inst, l.originSlot, def) : undefined;
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
            // a muted or bypassed subgraph runs none of its inner nodes (Comfy's Flux.2 Klein templates hold a second,
            // bypassed one): it stays a plain node, which the prompt skips and a link reads through as a bypass
            if (defs.has(n.type) && n.mode !== 2 && n.mode !== 4) {
                const def = defs.get(n.type);
                instances.set(node.id, { def, prefix: node.id + ":" });
                addGraph(def.nodes, def.links, node.id + ":", node, def);
            }
        }
    }
    addGraph(wf.nodes, wf.links, "", null);

    const canvasNodes = Array.from(nodes.values()).filter((n) => n.type === "InpaintCanvas");
    const noCanvas = !!(opts && opts.noCanvas);
    if (!canvasNodes.length && !noCanvas) throw new Error("This workflow has no Inpaint Canvas node.");
    if (canvasNodes.length > 1) throw new Error("This workflow has more than one Inpaint Canvas node; a recipe needs exactly one.");
    const canvasNode = canvasNodes[0] || null;
    const canvasId = canvasNode ? canvasNode.id : null;

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
    const resolve = (/** @type {any} */ node, /** @type {any} */ linkId) => resolveLink(links.get(node._prefix + String(linkId)));

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
            const named = n.widgets_values_named;
            if (named && typeof named === "object" && !Array.isArray(named)) {
                // a Comfy Cloud export names its widget values: they stand for themselves (a class the node list does
                // not know, a dynamic combo's widgets); for a known class only what it declares goes
                const declared = info && info.input ? new Set([...Object.keys(info.input.required || {}), ...Object.keys(info.input.optional || {})]) : null;
                for (const [k, v] of Object.entries(named)) if (!UI_WIDGETS.has(k) && (!declared || declared.has(k.split(".")[0]))) inputs[k] = v;
            } else Object.assign(inputs, readWidgets(info, Array.isArray(n.widgets_values) ? n.widgets_values : []));
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
    if (!canvasNode) {
        const flatNotes = [];
        if (missingTypes.size) flatNotes.push("node types unknown to the node list it was read with: " + Array.from(missingTypes).join(", "));
        if (instances.size) flatNotes.push(`${instances.size} subgraph${instances.size > 1 ? "s" : ""} flattened`);
        return { prompt, needs: Array.from(new Set(Object.values(prompt).map((n) => n.class_type))), notes: flatNotes };
    }

    const wired = (name) => {
        const inp = (canvasNode.inputs || []).find((i) => i.name === name);
        const src = inp && inp.link != null ? resolve(canvasNode, inp.link) : null;
        return src && src.id ? `${src.id}:${src.slot}` : null;
    };
    const resultLocal = wired("result_local"), resultApi = wired("result");
    if (!resultLocal && !resultApi) throw new Error("Nothing is wired into the Inpaint Canvas node's result or result_local input, so no result could come back.");

    // the outputs by name: a setting at its backend slot, the tail outputs (box_prompt, elements) as tailOutputs says
    const tailNotes = tailOutputs(prompt, canvasId, (slot) => { const o = (canvasNode.outputs || [])[slot]; return o && o.name ? o.name : backendOutputName(slot); });
    // setting outputs: the first real (non-instance) consumer of setting_n, found on the flattened links
    const settings = [];
    (canvasNode.outputs || []).forEach((o, i) => {
        if (i < FIXED_OUTPUTS || !o || !o.links || !o.links.length) return;
        const named = /^setting_([1-8])$/.exec(o.name || "");
        if (o.name && !named) return;   // a tail output: tailOutputs took its consumers
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
        settings.push({ index: named ? +named[1] : i - FIXED_OUTPUTS + 1, node: l.target, input: tin.name, label: `${target.title || target.type} · ${tin.name}`, ...(stored ? { spec: stored } : {}) });
    });

    const mode = resultLocal ? "local" : "api";
    const needs = Array.from(new Set(Object.values(prompt).map((n) => n.class_type)));
    const notes = [...tailNotes];
    if (resultLocal && resultApi) notes.push("both result inputs were wired; the recipe uses result_local (mode local)");
    if (missingTypes.size) notes.push("node types unknown to this server: " + Array.from(missingTypes).join(", "));
    if (instances.size) notes.push(`${instances.size} subgraph${instances.size > 1 ? "s" : ""} flattened`);
    return {
        kind: "comfy", mode, canvas: canvasId, result: resultLocal || resultApi, needs, settings, prompt,
        description: `Imported from ${meta.file} on ${meta.date}.` + (notes.length ? " " + notes.join("; ") + "." : ""),
        notes,
    };
}

module.exports = { fromWorkflow, specDefault, storedSpec };
