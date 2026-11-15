// @ts-check
// The ComfyUI window's Parameters list (item 66, docs/PLAN_COMFY_VIEW.md "Parameters"): the inputs of the page's graph
// the user can make a row of the recipe's Settings panel, and the page scripts that do it.
//
// A Settings row is, in the recipe format, an input wired to one of the Inpaint Canvas node's setting outputs
// (recipes_graph.js toPrompt / fromPrompt): the list reads the page's API prompt (graphToPrompt's `output`) and its
// UI graph the same way fromGraph does, and a tick links the input to the node's lowest free setting output in the
// page itself (an untick takes that link away), so Save to recipe reads the rows as it always has. Everything the page
// answers is untrusted data: only these fields are read, as short strings, numbers and booleans.
"use strict";

const { FIXED_OUTPUTS, SETTING_SLOTS, backendOutputName } = require("./recipes_store");
const { canvasOutputNames } = require("./recipes_graph");

const WIDGET_KINDS = new Set(["INT", "FLOAT", "BOOLEAN", "STRING", "COMBO"]);
// the most inputs the list holds (a graph of hundreds of nodes): the rest are counted in a note
const MAX_LISTED = 400;
// a node id the page scripts take: a root graph id (LiteGraph's numbers, or a stub's word); "92:7" lies in a subgraph
const NODE_ID = /^[A-Za-z0-9_.-]{1,40}$/;
const INPUT_NAME = /^[^\u0000-\u001f"\\]{1,100}$/;

/** What kind of widget a spec (or, without one, a value) gives: INT / FLOAT / BOOLEAN / STRING / COMBO, or null. */
function kindOf(spec, value) {
    if (Array.isArray(spec)) {
        if (Array.isArray(spec[0])) return "COMBO";
        const t = String(spec[0] || "");
        return WIDGET_KINDS.has(t) ? t : null;
    }
    if (typeof value === "boolean") return "BOOLEAN";
    if (typeof value === "number") return Number.isInteger(value) ? "INT" : "FLOAT";
    if (typeof value === "string") return "STRING";
    return null;
}

/** A value as the list shows it: one line, at most 40 characters. */
function preview(value) {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    const one = String(s == null ? "" : s).replace(/\s+/g, " ");
    return one.length > 40 ? one.slice(0, 39) + "\u2026" : one;
}

/**
 * The inputs of a graph a Settings row can take. `output` is the page's API prompt, `workflow` its UI graph (for the
 * canvas node's output names; the page's visible slots), `objectInfo` the server's node list (for the widget kinds;
 * without it a kind is read from the value). Answers
 *   { canvas, nodes: [{ id, title, type, inputs: [{ name, kind, value, exposed, index, label }] }], used, cap, full,
 *     note }
 * where an `exposed` input is wired to setting output `index`. Not listed: the Inpaint Canvas node's own inputs,
 * inputs wired from other nodes, values that are no widget (an object, a list), and nodes inside a subgraph (their
 * ids hold ":"; the page scripts reach the root graph only).
 * @param {{ output: any, workflow?: any, objectInfo?: any, cap?: number }} a
 */
function listParams({ output, workflow, objectInfo, cap }) {
    const max = Math.max(0, Math.min(SETTING_SLOTS, cap == null ? SETTING_SLOTS : Math.round(+cap || 0)));
    const empty = (note) => ({ canvas: null, nodes: [], used: 0, cap: max, full: false, note });
    if (!output || typeof output !== "object" || Array.isArray(output)) return empty("The page answered no graph.");
    const ids = Object.keys(output).filter((id) => output[id] && output[id].class_type === "InpaintCanvas");
    if (!ids.length) return empty("Parameters become Settings rows through the Inpaint Canvas node, and this graph has none.");
    if (ids.length > 1) return empty("This graph has more than one Inpaint Canvas node; a recipe needs exactly one.");
    const canvas = ids[0];
    const names = canvasOutputNames(workflow);
    const nameOf = (slot) => (names && typeof names[slot] === "string" && names[slot] ? names[slot] : backendOutputName(slot));
    const info = objectInfo && typeof objectInfo === "object" ? objectInfo : {};
    const nodes = [];
    let used = 0, listed = 0, more = 0, inSubgraphs = 0;
    const order = (a, b) => { const x = Number(a), y = Number(b); return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a).localeCompare(String(b)); };
    for (const id of Object.keys(output).sort(order)) {
        const node = output[id];
        if (!node || typeof node !== "object" || String(id) === canvas || typeof node.class_type !== "string") continue;
        const inputs = node.inputs && typeof node.inputs === "object" ? node.inputs : {};
        const title = String((node._meta && typeof node._meta.title === "string" && node._meta.title) || node.class_type).slice(0, 120);
        const spec = (name) => {
            const n = info[node.class_type];
            const inp = n && n.input;
            return (inp && ((inp.required && inp.required[name]) || (inp.optional && inp.optional[name]))) || null;
        };
        const rows = [];
        for (const [name, v] of Object.entries(inputs)) {
            if (Array.isArray(v)) {
                if (String(v[0]) !== canvas || !(+v[1] >= FIXED_OUTPUTS)) continue;   // wired from another node
                const m = /^setting_(\d+)$/.exec(nameOf(+v[1]) || "");
                if (!m) continue;   // the canvas node's box_prompt or elements
                used++;
                rows.push({ name, kind: kindOf(spec(name), undefined) || "", value: `setting ${m[1]}`, exposed: true, index: +m[1], label: `${title} \u00b7 ${name}` });
                continue;
            }
            const kind = kindOf(spec(name), v);
            if (!kind || (v !== null && typeof v === "object")) continue;
            rows.push({ name, kind, value: preview(v), exposed: false, index: null, label: `${title} \u00b7 ${name}` });
        }
        if (!rows.length) continue;
        if (!NODE_ID.test(String(id))) {
            // a node inside a subgraph: counted, not offered (a row already wired there stays as the graph has it)
            inSubgraphs += rows.filter((r) => !r.exposed).length;
            const wired = rows.filter((r) => r.exposed);
            if (!wired.length) continue;
            rows.length = 0;
            rows.push(...wired);
        }
        const room = MAX_LISTED - listed;
        if (room <= 0) { more += rows.length; continue; }
        if (rows.length > room) { more += rows.length - room; rows.length = room; }
        listed += rows.length;
        nodes.push({ id: String(id), title, type: String(node.class_type).slice(0, 120), inputs: rows });
    }
    const notes = [];
    if (used >= max) notes.push(`All ${max} setting outputs of the Inpaint Canvas node are in use: untick one first.`);
    if (inSubgraphs) notes.push(`${inSubgraphs} input${inSubgraphs === 1 ? "" : "s"} inside subgraphs ${inSubgraphs === 1 ? "is" : "are"} not listed.`);
    if (more) notes.push(`${more} more input${more === 1 ? " is" : "s are"} not listed.`);
    return { canvas, nodes, used, cap: max, full: used >= max, note: notes.join(" ") };
}

/** Whether a tick's target is one the page scripts take (from the bar: untrusted). */
function validTarget(node, input) {
    return typeof node === "string" && NODE_ID.test(node) && typeof input === "string" && INPUT_NAME.test(input);
}

// LiteGraph's own fields only (the root graph): the nodes, a node by id, a link by id
const GRAPH_JS = `const g = window.app && (window.app.rootGraph || window.app.graph);
    if (!g) return { ok: false, error: "the page has no graph" };
    const all = g.nodes || g._nodes || [];
    const linkOf = (id) => (typeof g.getLink === "function" ? g.getLink(id) : g.links && (typeof g.links.get === "function" ? g.links.get(id) : g.links[id]));
    const byId = (id) => (typeof g.getNodeById === "function" ? (g.getNodeById(Number(id)) || g.getNodeById(id)) : null) || all.find((n) => String(n.id) === String(id)) || null;
    const canvases = all.filter((n) => n && n.type === "InpaintCanvas");
    if (canvases.length !== 1) return { ok: false, error: canvases.length ? "the graph has more than one Inpaint Canvas node" : "the graph has no Inpaint Canvas node" };
    const canvas = canvases[0];`;

/**
 * The page script of a tick (`on`) or an untick: the input `input` of node `node` linked to the Inpaint Canvas node's
 * lowest free setting output (the node's own frontend then shows the next free one), or that link taken away (the
 * widget keeps its value). Answers { ok, index } / { ok: false, error }.
 */
function exposeScript(node, input, on) {
    if (!validTarget(node, input)) throw new Error("not a node input the page can link");
    const id = JSON.stringify(node), name = JSON.stringify(input);
    return `(() => { try { ${GRAPH_JS}
    const node = byId(${id});
    if (!node || node === canvas) return { ok: false, error: "the graph has no node " + ${id} };
    const slots = node.inputs || [];
    const slot = slots.findIndex((i) => i && (i.name === ${name} || (i.widget && i.widget.name === ${name})));
    const settingOf = (o) => { const m = o && /^setting_(\\d+)$/.exec(String(o.name || "")); return m ? Number(m[1]) : 0; };
    const fromCanvas = (inp) => { const l = inp && inp.link != null ? linkOf(inp.link) : null; return l && String(l.origin_id) === String(canvas.id) ? l : null; };
    if (${on ? "true" : "false"}) {
        if (slot < 0) return { ok: false, error: "the node has no socket for " + ${name} + " (an older ComfyUI frontend: link it to a setting output by hand)" };
        const was = fromCanvas(slots[slot]);
        if (was) return { ok: true, index: settingOf(canvas.outputs[was.origin_slot]) };
        if (slots[slot].link != null) return { ok: false, error: ${name} + " is linked from another node" };
        let best = -1, bestN = 0;
        (canvas.outputs || []).forEach((o, i) => { const n = settingOf(o); if (n && !(o.links && o.links.length) && (best < 0 || n < bestN)) { best = i; bestN = n; } });
        if (best < 0) return { ok: false, error: "every setting output of the Inpaint Canvas node is in use" };
        const link = canvas.connect(best, node, slot);
        if (!link) return { ok: false, error: "the page did not take the link" };
        if (typeof g.setDirtyCanvas === "function") g.setDirtyCanvas(true, true);
        return { ok: true, index: bestN };
    }
    if (slot < 0 || !fromCanvas(slots[slot])) return { ok: true, index: 0 };
    node.disconnectInput(slot);
    if (typeof g.setDirtyCanvas === "function") g.setDirtyCanvas(true, true);
    return { ok: true, index: 0 };
    } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 300) }; } })()`;
}

/**
 * The part of the page's read that gives a new Settings row its value (fromGraph `values`): for every input of the
 * API prompt `p` wired to the canvas node, what the node's widget of that name holds, as JSON text. A JS expression
 * over `p` (graphToPrompt's answer), run inside the page's read (comfyview.js READ_JS).
 */
const VALUES_JS = `(() => { try {
    const g = window.app && (window.app.rootGraph || window.app.graph);
    const out = p && p.output && typeof p.output === "object" ? p.output : {};
    const canvasId = Object.keys(out).find((k) => out[k] && out[k].class_type === "InpaintCanvas");
    if (!g || canvasId == null) return "{}";
    const all = g.nodes || g._nodes || [];
    const byId = (id) => (typeof g.getNodeById === "function" ? (g.getNodeById(Number(id)) || g.getNodeById(id)) : null) || all.find((n) => String(n.id) === String(id)) || null;
    const values = {};
    let n = 0;
    for (const [id, node] of Object.entries(out)) {
        if (!node || !node.inputs || id === canvasId) continue;
        for (const [name, v] of Object.entries(node.inputs)) {
            if (!Array.isArray(v) || String(v[0]) !== String(canvasId) || ++n > 64) continue;
            const gn = byId(id);
            const w = gn && Array.isArray(gn.widgets) ? gn.widgets.find((x) => x && x.name === name) : null;
            const val = w ? w.value : undefined;
            if (typeof val === "number" || typeof val === "boolean" || (typeof val === "string" && val.length <= 10000)) values[id + "|" + name] = val;
        }
    }
    return JSON.stringify(values);
    } catch (_) { return "{}"; } })()`;

/** The read's `values` text (VALUES_JS) back as an object of plain values, or null (too long, not JSON, not flat). */
function parseValues(text) {
    if (typeof text !== "string" || text.length > 1024 * 1024) return null;
    let v;
    try { v = JSON.parse(text); } catch (_) { return null; }
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
        if (typeof k !== "string" || k.length > 200) continue;
        if ((typeof x === "number" && Number.isFinite(x)) || typeof x === "boolean" || (typeof x === "string" && x.length <= 10000)) out[k] = x;
    }
    return out;
}

module.exports = { listParams, validTarget, exposeScript, VALUES_JS, parseValues, kindOf, MAX_LISTED };
