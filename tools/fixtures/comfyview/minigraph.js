// A small stand-in for ComfyUI's LiteGraph graph, for the ComfyUI window's Parameters list (item 66): the fields and
// calls the window's page scripts use (electron/main/comfyparams.js exposeScript, VALUES_JS) and nothing more. Used in
// plain Node by tools/comfyparams_test.js and in the stub page of tools/comfyview_test.py (evaluated there by CDP).
//
//   const m = __miniGraph(prompt, () => workflowId, widgets);  m.graph (app.graph), m.graphToPrompt (app.graphToPrompt)
//
// `widgets` ("<node>|<input>" -> value): the widget values of inputs the prompt wires to the canvas node (an API
// prompt holds the link there, and the page's widget keeps a value of its own).
//
// Every widget input has its socket (`widget: { name }`), as ComfyUI's frontend has had since 1.16; the Inpaint Canvas
// node shows its setting outputs as the node's own frontend does (js/inpaint_node.js syncSettingOutputs in the node
// repo): the fixed 13, the setting outputs up to one past the highest connected one, then box_prompt and elements, a
// link's origin_slot following its output. Not a real graph: no types, no subgraphs, no groups.
(function (root) {
    "use strict";
    const FIXED = 13, SLOTS = 8, TAIL = ["box_prompt", "elements"];
    const settingOf = (o) => { const m = o && /^setting_(\d+)$/.exec(String(o.name || "")); return m ? Number(m[1]) : 0; };

    function make(prompt, workflowId, widgets) {
        const g = { _nodes: [], links: {}, last: 0, dirty: 0 };
        g.getNodeById = (id) => g._nodes.find((n) => String(n.id) === String(id)) || null;
        g.setDirtyCanvas = () => { g.dirty++; };

        function syncCanvas(c) {
            let highest = 0;
            for (const o of c.outputs) if (settingOf(o) && o.links && o.links.length) highest = Math.max(highest, settingOf(o));
            const want = Math.min(SLOTS, highest + 1);
            const fixed = c.outputs.slice(0, FIXED);
            const settings = [];
            for (let n = 1; n <= SLOTS; n++) {
                const o = c.outputs.find((x) => settingOf(x) === n);
                if (o && ((o.links && o.links.length) || n <= want)) settings.push(o);
                else if (!o && n <= want) settings.push({ name: `setting_${n}`, type: "*", links: [] });
            }
            const tail = TAIL.map((t) => c.outputs.find((o) => o.name === t) || { name: t, type: "*", links: [] });
            c.outputs = fixed.concat(settings, tail);
            c.outputs.forEach((o, i) => { for (const id of o.links || []) if (g.links[id]) g.links[id].origin_slot = i; });
        }

        function node(id, n) {
            const me = { id, type: n.class_type, title: (n._meta && n._meta.title) || n.class_type, inputs: [], outputs: [], widgets: [] };
            for (const [name, v] of Object.entries(n.inputs || {})) {
                const canvasLink = Array.isArray(v) && prompt[v[0]] && prompt[v[0]].class_type === "InpaintCanvas" && +v[1] >= FIXED;
                if (canvasLink) {
                    // a Settings row: a widget input linked to a setting output; its widget keeps a value
                    const k = `${id}|${name}`;
                    me.widgets.push({ name, value: widgets && Object.prototype.hasOwnProperty.call(widgets, k) ? widgets[k] : null });
                    me.inputs.push({ name, type: "*", link: null, src: v, widget: { name } });
                } else if (Array.isArray(v)) me.inputs.push({ name, type: "*", link: null, src: v });
                else { me.widgets.push({ name, value: v }); me.inputs.push({ name, type: typeof v, link: null, widget: { name } }); }
            }
            me.connect = function (slot, target, tslot) {
                if (typeof tslot === "string") tslot = target.inputs.findIndex((i) => i.name === tslot);
                const inp = target && target.inputs[tslot];
                if (!inp || !this.outputs[slot]) return null;
                if (inp.link != null) target.disconnectInput(tslot);
                const l = { id: ++g.last, origin_id: this.id, origin_slot: slot, target_id: target.id, target_slot: tslot };
                g.links[l.id] = l;
                (this.outputs[slot].links = this.outputs[slot].links || []).push(l.id);
                inp.link = l.id;
                if (this.onConnectionsChange) this.onConnectionsChange();
                return l;
            };
            me.disconnectInput = function (slot) {
                const inp = this.inputs[slot];
                if (!inp || inp.link == null) return false;
                const l = g.links[inp.link];
                delete g.links[inp.link];
                inp.link = null;
                const o = l && g.getNodeById(l.origin_id);
                if (o) {
                    const out = o.outputs[l.origin_slot];
                    if (out) out.links = (out.links || []).filter((x) => x !== l.id);
                    if (o.onConnectionsChange) o.onConnectionsChange();
                }
                return true;
            };
            return me;
        }

        for (const [id, n] of Object.entries(prompt || {})) if (n && typeof n === "object") g._nodes.push(node(id, n));
        const canvas = g._nodes.find((n) => n.type === "InpaintCanvas") || null;
        if (canvas) {
            canvas.outputs = Array.from({ length: FIXED }, (_, i) => ({ name: `fixed_${i}`, type: "*", links: [] }))
                .concat(Array.from({ length: SLOTS }, (_, i) => ({ name: `setting_${i + 1}`, type: "*", links: [] })))
                .concat(TAIL.map((t) => ({ name: t, type: "*", links: [] })));
        }
        // the prompt's links (a recipe's: a Settings row's input reads the canvas node's backend slot 13 + index - 1)
        for (const t of g._nodes) {
            t.inputs.forEach((inp, k) => {
                if (!inp.src) return;
                const [sid, slot] = inp.src;
                delete inp.src;
                const s = g.getNodeById(sid);
                if (!s) return;
                while (s.outputs.length <= slot) s.outputs.push({ name: `out_${s.outputs.length}`, type: "*", links: [] });
                s.connect(+slot, t, k);
            });
        }
        if (canvas) { syncCanvas(canvas); canvas.onConnectionsChange = () => syncCanvas(canvas); }

        async function graphToPrompt() {
            const output = {};
            for (const n of g._nodes) {
                const inputs = {};
                for (const inp of n.inputs) {
                    if (inp.link != null) { const l = g.links[inp.link]; inputs[inp.name] = [String(l.origin_id), l.origin_slot]; }
                    else if (inp.widget) { const w = n.widgets.find((x) => x.name === inp.widget.name); inputs[inp.name] = w ? w.value : null; }
                }
                output[n.id] = { class_type: n.type, inputs, _meta: { title: n.title } };
            }
            const workflow = {
                id: typeof workflowId === "function" ? workflowId() : workflowId,
                nodes: g._nodes.map((n) => ({ id: n.id, type: n.type, outputs: n.outputs.map((o) => ({ name: o.name, links: (o.links || []).slice() })) })),
                links: Object.values(g.links).map((l) => [l.id, l.origin_id, l.origin_slot, l.target_id, l.target_slot, "*"]),
            };
            return { output, workflow };
        }
        return { graph: g, graphToPrompt, canvas };
    }
    root.__miniGraph = make;
})(globalThis);
