// A recipe's API-format graph against a node list's specs (an /object_info answer; the fixtures' copy is
// tools/refs/comfy_templates/object_info.json), for the plain-Node tests of graphs that have not run yet
// (tools/ph3_test.js §3, tools/recipes_test.js §15):
//   const { specKind, specProblems } = require("./node_specs.js");
// The specs are the saved node list's, with two written by hand: MiniMaxH3ImageConditioning from the open pull request
// Comfy-Org/ComfyUI#17655 (comfy_extras/nodes_minimax_h3.py there; not in a released ComfyUI when written, 2026-11-10) and
// JsonExtractString from ComfyUI 0.44's comfy_extras/nodes_string.py.
// A combo of model files is not checked (the saved list is one machine's folder); every other combo, number, text and
// switch is, and a link must name a node of the graph. Both spec shapes: the old ([options], {...}) and V3's
// ("COMBO", { options }), a growing input (COMFY_AUTOGROW_V3: "images.image_1" ... by its template's names, or by its
// prefix and max: "images.image_0" .. "images.image_<max - 1>"; at least its min of them given) and a dynamic combo
// (COMFY_DYNAMICCOMBO_V3: its value one of the options' keys, the chosen option's inputs as "name.sub"). A class the
// node list lacks is not checked.
"use strict";

const MODEL_FILE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;

/** What an input spec is: a combo, a growing input's names, a dynamic combo, a number / text / switch, or a socket. */
function specKind(spec) {
    const [t, o = {}] = Array.isArray(spec) ? spec : [spec];
    if (Array.isArray(t)) return { kind: "combo", options: t };
    if (t === "COMBO") return { kind: "combo", options: o.options || [] };
    if (t === "COMFY_AUTOGROW_V3") {
        const tpl = o.template || {};
        // ComfyUI's TemplateNames lists its names, TemplatePrefix a prefix and a max (comfy_api/latest/_io.py Autogrow)
        const names = Array.isArray(tpl.names) ? tpl.names
            : typeof tpl.prefix === "string" && Number.isInteger(tpl.max) ? Array.from({ length: tpl.max }, (_, i) => tpl.prefix + i) : [];
        return { kind: "grow", names, min: Number.isInteger(tpl.min) ? tpl.min : 0 };
    }
    if (t === "COMFY_DYNAMICCOMBO_V3") return { kind: "dyn", options: o.options || [] };
    if (t === "INT" || t === "FLOAT" || t === "STRING" || t === "BOOLEAN") return { kind: t, o };
    return { kind: "socket" };
}

/** Every fault of a graph against the specs, as "node.input ..." lines; none for a sound graph. */
function specProblems(g, info) {
    const out = [];
    const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && Number.isInteger(v[1]);
    for (const [id, n] of Object.entries(g)) {
        const decl = info[n.class_type] && info[n.class_type].input;
        if (!decl) continue;
        const ins = n.inputs || {};
        const known = new Map();
        for (const [k, spec] of Object.entries({ ...(decl.required || {}), ...(decl.optional || {}) })) {
            const s = specKind(spec);
            if (s.kind === "grow") {
                for (const name of s.names) known.set(`${k}.${name}`, { kind: "socket" });
                const given = s.names.filter((name) => `${k}.${name}` in ins).length;
                if (given < s.min) out.push(`${id}.${k} takes at least ${s.min} input${s.min === 1 ? "" : "s"}, has ${given}`);
                continue;
            }
            known.set(k, s);
            if (s.kind !== "dyn") continue;
            const chosen = s.options.find((x) => x.key === ins[k]);
            const sub = (chosen && chosen.inputs) || {};
            for (const [sk, sspec] of Object.entries({ ...(sub.required || {}), ...(sub.optional || {}) })) known.set(`${k}.${sk}`, specKind(sspec));
            for (const sk of Object.keys(sub.required || {})) if (!(`${k}.${sk}` in ins)) out.push(`${id}.${k}.${sk} missing`);
        }
        for (const [k, spec] of Object.entries(decl.required || {})) if (specKind(spec).kind !== "grow" && !(k in ins)) out.push(`${id}.${k} missing`);
        for (const [k, v] of Object.entries(ins)) {
            const s = known.get(k);
            if (!s) { out.push(`${id}.${k} unknown to ${n.class_type}`); continue; }
            if (isLink(v)) { if (!g[v[0]]) out.push(`${id}.${k} links to ${v[0]}, no node of the graph`); continue; }
            if (s.kind === "socket") out.push(`${id}.${k} is no link`);
            else if (s.kind === "combo") { if (!s.options.some((x) => MODEL_FILE.test(String(x))) && !s.options.includes(v)) out.push(`${id}.${k}=${JSON.stringify(v)} not among its options`); }
            else if (s.kind === "dyn") { if (!s.options.some((x) => x.key === v)) out.push(`${id}.${k}=${JSON.stringify(v)} not among its options`); }
            else if (s.kind === "INT" || s.kind === "FLOAT") {
                const okType = s.kind === "INT" ? Number.isInteger(v) : typeof v === "number" && Number.isFinite(v);
                if (!okType || (s.o.min !== undefined && v < s.o.min) || (s.o.max !== undefined && v > s.o.max)) out.push(`${id}.${k}=${JSON.stringify(v)} out of range or no ${s.kind}`);
            } else if (s.kind === "STRING" && typeof v !== "string") out.push(`${id}.${k} is no text`);
            else if (s.kind === "BOOLEAN" && typeof v !== "boolean") out.push(`${id}.${k} is no boolean`);
        }
    }
    return out;
}

module.exports = { MODEL_FILE, specKind, specProblems };
