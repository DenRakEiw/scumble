// @ts-check
// presets and LoRAs (local and Comfy Cloud), setting files, recipe modes, setting targets, provider params: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import * as loraPanel from "./lora_panel.js";
import { refusal } from "./inpaint_status.js";
import { LORA_MODEL_CLASS, MAX_LORAS, comboOf, familyOf, loraFolder, loraMeta, loraTriggers, missingLoras, modelSource, noSourceWords, normalizeName, spliceLoras, usableRows } from "./loras.js";
import { api } from "./host_util.js";

export const HostPresetsPart = {
    // ---- setting presets: a named model / text encoder / VAE combination per recipe ----

    presets: {},   // settings.recipePresets: { [recipeId]: [{ name, values: { "node:input": value } }] }

    /** The settings a preset stores: file combos (unet_name, ckpt_name, clip_name, vae_name, lora_name ...). */
    presetTargets(editor, targets) {
        return targets.filter((t) => {
            const k = editor.settingKind(t);
            return k.kind === "combo" && /_name$/.test(t.inputName) && k.options.some((o) => /\.[a-z0-9]{2,12}$/i.test(String(o)));
        });
    },

    // ---- the rows' last values per recipe (issue #12): what you picked comes back in every tab and after a switch ----

    recipeValues: {},   // settings.recipeValues: { [recipeId]: { [target]: value } }, the Settings rows you last set

    /** The value you last set for a row of a recipe (its `target`, as the editor's settings entry holds it), or undefined. */
    rememberedValue(recipeId, target) {
        const mine = this.recipeValues && this.recipeValues[recipeId];
        return mine && Object.prototype.hasOwnProperty.call(mine, target) ? mine[target] : undefined;
    },

    /**
     * A Settings row you set in the Settings section (the editor's `onSettingSet`, which the app's shell wires here), a
     * preset you picked in its Preset row, or the rows put back by "Recipe's own values": kept as the selected recipe's
     * value for that row, so it comes back in every tab and after a switch of recipe (issue #12). A command
     * (set_settings, apply_preset) sets the document's rows only: an agent's or a test's choice is not yours.
     * @param {any} editor
     * @param {Array<[string, any]>} rows  [target, value] pairs, the target as the editor's settings entry holds it
     */
    rememberValues(editor, rows) {
        const r = this.recipe;
        if (!r || !editor || !rows.length) return;
        const mine = { ...((this.recipeValues || {})[r.id] || {}) };
        let changed = false;
        for (const [target, v] of rows) if (typeof target === "string" && mine[target] !== v) { mine[target] = v; changed = true; }
        if (!changed) return;
        this.recipeValues = { ...(this.recipeValues || {}), [r.id]: mine };
        clearTimeout(this._valuesTimer);
        this._valuesTimer = setTimeout(() => {
            window.scumble.settings.set({ recipeValues: this.recipeValues }).catch((err) => console.warn("recipe values", err));
        }, 800);
    },

    /**
     * The [target, value] pairs of `editor`'s rows for `targets` (settingTargets' shape).
     * @returns {Array<[string, any]>}
     */
    rowValues(editor, targets) {
        /** @type {Array<[string, any]>} */
        const out = [];
        for (const t of targets) {
            const target = /** @type {any} */ (t).key || `${t.node.id}:${t.inputName}`;
            const e = editor.settings[String(t.index)];
            if (e && e.target === target) out.push([target, e.value]);
        }
        return out;
    },

    /**
     * Every Settings row of the selected recipe back to the recipe file's own value (the Preset row's "Recipe's own
     * values"); the rows then count as set, so they are the recipe's values again.
     * @param {any} editor
     */
    resetToRecipeValues(editor) {
        const r = this.recipe;
        if (!r || !editor) return 0;
        this._ownValues = true;
        let targets;
        try { targets = this.settingTargets(editor); } finally { this._ownValues = false; }
        let n = 0;
        for (const t of targets) {
            const e = editor.settings[String(t.index)];
            if (!e || !t.widget) continue;
            if (e.value !== t.widget.value) { e.value = t.widget.value; n++; }
        }
        this.rememberValues(editor, this.rowValues(editor, targets));
        editor.renderSettings();
        editor.notifyChanged();
        const name = r.name || r.id;
        editor.setStatus(n ? `${name}: ${n} setting${n === 1 ? "" : "s"} back to the recipe's own value${n === 1 ? "" : "s"}.` : `${name}: the settings already hold the recipe's own values.`);
        return n;
    },

    async savePresets(recipeId, list) {
        this.presets = { ...(this.presets || {}), [recipeId]: list };
        try { await window.scumble.settings.set({ recipePresets: this.presets }); } catch (err) { console.warn("presets", err); }
    },

    // ---- LoRAs per recipe (item 50, docs/PLAN_LORAS.md §3.1, §3.3): rows spliced into the queued copy of the graph ----

    loras: {},   // settings.recipeLoras: { [recipeId]: [{ name, strength, on }] }, shared by all documents like presets

    /** The rows of a recipe (the store's whole object written, as savePresets does). */
    async saveLoras(recipeId, rows) {
        this.loras = { ...(this.loras || {}), [recipeId]: Array.isArray(rows) ? rows : [] };
        try { await window.scumble.settings.set({ recipeLoras: this.loras }); } catch (err) { console.warn("loras", err); }
    },

    /**
     * The stored rows of a recipe (`r` or its id) as the store holds them, each checked: `name` a string, `strength` a
     * finite number, `on` a boolean; an entry of another shape is dropped (a hand-edited or a newer file).
     * @returns {{ name: string, strength: number, on: boolean }[]}
     */
    loraRows(r) {
        const id = r && typeof r === "object" ? r.id : r;
        const list = id != null && this.loras && Array.isArray(this.loras[id]) ? this.loras[id] : [];
        return list.filter((row) => row && typeof row === "object" && typeof row.name === "string" && typeof row.strength === "number"
            && Number.isFinite(row.strength) && typeof row.on === "boolean").map((row) => ({ name: row.name, strength: row.strength, on: row.on }));
    },

    /** The server's LoRA files (LoraLoaderModelOnly's lora_name, either combo form); [] while the node list is unread. */
    loraNames() {
        return comboOf(this.objectInfo, LORA_MODEL_CLASS, "lora_name") || [];
    },

    /**
     * The server's LoRA files read again through /object_info/LoraLoaderModelOnly (a file copied into models/loras since
     * the connect is listed by then; the boxPromptSlot shape): kept in the node list only when that list is known (a
     * partial one would read every other node as missing). A failed read answers the list as it was.
     */
    async refreshLoraNames() {
        try {
            const res = await api.fetchApi("/object_info/" + LORA_MODEL_CLASS);
            const one = res && res.status === 200 ? await res.json() : null;
            if (one && one[LORA_MODEL_CLASS]) {
                if (this.objectInfo) {
                    this.objectInfo = { ...this.objectInfo, [LORA_MODEL_CLASS]: one[LORA_MODEL_CLASS] };
                    if (this._types) this._types[LORA_MODEL_CLASS] = { nodeData: one[LORA_MODEL_CLASS] };
                }
                return comboOf(one, LORA_MODEL_CLASS, "lora_name") || [];
            }
        } catch (_) { /* the list as it was */ }
        return this.loraNames();
    },

    // ---- the LoRA hint (LR3, docs/PLAN_LORAS.md §3.4): the base model a row's file looks made for, its trigger words ----

    _loraInfo: new Map(),   // `${server url}|${name}` -> { done, value: { fam, triggers } }, per server, name and session

    /**
     * A LoRA file's reduced safetensors header (main's loras:header: read from the ComfyUI models folder of Settings ›
     * Helpers, only while the server is this machine), or null. The `loras` gate stands in here.
     */
    async loraHeader(name) {
        try {
            const res = await window.scumble.loras.header(name);
            return (res && res.header) || null;
        } catch (_) { return null; }
    },

    /** ComfyUI's /view_metadata answer for a LoRA file reduced as main reduces a header (loraMeta), or null (a 404: no metadata; no server). */
    async loraServerMeta(name) {
        const st = this.server && this.server.state;
        if (!this.connected || (st !== "connected" && st !== "missing-node")) return null;
        try {
            const res = await api.fetchApi("/view_metadata/loras?filename=" + encodeURIComponent(name));
            if (!res || res.status !== 200) return null;
            const meta = await res.json();
            return meta && typeof meta === "object" && !Array.isArray(meta) ? { metadata: loraMeta(meta) } : null;
        } catch (_) { return null; }
    },

    /**
     * What is known of a LoRA file: `{ fam, triggers }` (familyOf over its header, else the server's metadata, else its
     * folder; loraTriggers), or null while it is read: the first ask starts the read and the LoRAs section is drawn
     * again when it is in. Kept per server, name and session (a connect starts over). `read: false` only looks.
     * @param {string} name the server's name ("klein\x.safetensors")
     * @param {{ read?: boolean }} [opts]
     * @returns {{ fam: ReturnType<typeof familyOf>, triggers: string[] } | null}
     */
    loraInfo(name, { read = true } = {}) {
        if (typeof name !== "string" || !name) return null;
        const key = `${(this.server && this.server.url) || ""}|${name}`;
        const got = this._loraInfo.get(key);
        if (got) return got.done ? got.value : null;
        if (!read) return null;   // the picker's family group asks what is known, never reads 1,200 files
        const entry = { done: false, value: null };
        this._loraInfo.set(key, entry);
        (async () => {
            let header = await this.loraHeader(name);
            if (!header) header = await this.loraServerMeta(name);
            entry.value = { fam: familyOf(header, loraFolder(name) || null), triggers: loraTriggers(header) };
        })().catch((err) => {
            console.warn("lora hint", err);
            entry.value = { fam: familyOf(null, loraFolder(name) || null), triggers: [] };
        }).then(() => {
            entry.done = true;
            if (this._loraInfo.get(key) === entry) loraPanel.renderAll(this);
        });
        return null;
    },

    /**
     * The graph a recipe's LoRA rows go into, with what modelSource reads of the recipe: a ComfyUI recipe's own graph;
     * a Comfy Cloud graph recipe (resolved to its variant) its edit graph with the variant's declaration and `cloud`
     * (main splices those, comfycloud.js withLoras, and reads them with the class-name table here: the local server's
     * node list is not Comfy Cloud's); or null (an API recipe, an upscaler, the Realism Pass, relight).
     */
    loraGraph(r) {
        if (!r || r.task === "upscale" || r.task === "pass" || r.task === "relight") return null;
        if (r.kind === "provider") {
            return this.recipeMode(r) === "cloud" ? { graph: r.options.graph, decl: { loras: r.loras, save: r.options.save }, cloud: true } : null;
        }
        if (!r.prompt) return null;
        return { graph: r.prompt, decl: r };
    },

    /** Where a recipe's LoRA rows go: "comfy" (your ComfyUI), "cloud" (Comfy Cloud) or null (none). */
    loraSource(r = this.recipe) {
        const g = this.loraGraph(r);
        return g ? (g.cloud ? "cloud" : "comfy") : null;
    },

    _cloudLoras: null,      // main's last answer of provider:cloudLoras ({ key, own, shared, assets, nodeList, error }) and `at`
    _cloudLorasRead: null,  // the read in flight

    /**
     * The LoRA files the selected recipe's rows may name: Comfy Cloud's lists for a Comfy Cloud recipe (the account's
     * own imports first, then the catalog; [] until read: cloudLoraNames starts a read), else your ComfyUI's.
     */
    loraNamesFor(r = this.recipe) {
        if (this.loraSource(r) !== "cloud") return this.loraNames();
        const c = this._cloudLoras;
        return c ? [...(c.own || []), ...(c.shared || [])] : [];
    },

    /**
     * Comfy Cloud's LoRA lists (main reads them with the stored key: GET /api/assets, the account's own and the
     * catalog, then the node list's combo), `fresh` read again (the picker's open), else a minute's copy; the LoRAs
     * sections are drawn again when an answer comes. Never refuses: a failed read leaves the last lists.
     */
    async readCloudLoras({ fresh = false } = {}) {
        if (this._cloudLorasRead && !fresh) return this._cloudLorasRead;
        const read = (async () => {
            // an answer of any kind, so the section's first look never asks again in a loop
            const none = (error) => ({ key: false, stale: false, own: [], shared: [], assets: false, nodeList: false, error, at: Date.now() });
            try {
                const got = window.scumble && window.scumble.providers && window.scumble.providers.cloudLoras ? await window.scumble.providers.cloudLoras({ fresh }) : null;
                this._cloudLoras = got && typeof got === "object" ? { ...got, at: Date.now() } : this._cloudLoras || none("no answer");
            } catch (err) {
                console.warn("Comfy Cloud LoRAs", err);
                this._cloudLoras = this._cloudLoras || none(String((err && err.message) || err).slice(0, 200));
            }
            return this._cloudLoras;
        })();
        this._cloudLorasRead = read;
        try { return await read; } finally {
            if (this._cloudLorasRead === read) this._cloudLorasRead = null;
            loraPanel.renderAll(this);
        }
    },

    /** loraNames' and refreshLoraNames' rule for the recipe's own source (Comfy Cloud's lists for a Comfy Cloud recipe). */
    async refreshLoraNamesFor(r = this.recipe) {
        if (this.loraSource(r) !== "cloud") return this.refreshLoraNames();
        await this.readCloudLoras({ fresh: true });
        return this.loraNamesFor(r);
    },

    /**
     * The LoRA rows a Comfy Cloud run of `r` sends (runProvider, runGenerate; main splices them): null when its graph
     * takes none or no row is switched on, else the usable rows, a name that differs from Comfy Cloud's lists only in its
     * separators in their spelling. Refuses more than MAX_LORAS rows before anything is made; a name the lists lack is
     * never refused (the account's own imports may be missing from them; Comfy's own check answers a wrong one).
     */
    cloudLoraRows(r) {
        const g = this.loraGraph(r);
        if (!g || !g.cloud) return null;
        const use = usableRows(this.loraRows(r));
        if (!use.length) return null;
        if (use.length > MAX_LORAS) throw refusal(`At most ${MAX_LORAS} LoRAs per recipe: ${r.name || r.id}'s rows switch on ${use.length}. Switch rows off in the LoRAs section, then try again.`, "warn");
        const names = this.loraNamesFor(r);
        return use.map((row) => {
            if (names.includes(row.name)) return row;
            const same = names.find((x) => normalizeName(x) === normalizeName(row.name));
            return same ? { ...row, name: same } : row;
        });
    },

    /**
     * Whether the selected recipe shows the LoRAs section (renderer/editor/lora_panel.js; LR4's status and list_recipes
     * read the same): `{ takes: true }`, or `{ takes: false, reason }` in a sentence (the hidden section's summary title).
     * A ComfyUI recipe takes rows when its graph has one model source (modelSource, the node list or the class table).
     */
    loraTakes(r = this.recipe) {
        const label = (r && (r.name || r.id)) || "";
        if (!r) return { takes: false, reason: "No recipe is selected." };
        if (r.task === "upscale") return { takes: false, reason: `${label} is an upscaler: it loads no model a LoRA could change.` };
        if (r.task === "pass") return { takes: false, reason: `${label} loads no model a LoRA could change.` };
        if (r.task === "relight") return { takes: false, reason: `${label} is a relight recipe: it takes no LoRA rows.` };
        // a Comfy Cloud graph recipe's rows are spliced in main (comfycloud.js withLoras); an API route takes none
        if (r.kind === "provider" && this.recipeMode(r) !== "cloud") return { takes: false, reason: `${label} runs through an API provider: LoRAs go only to your ComfyUI and Comfy Cloud.` };
        const g = this.loraGraph(r);
        if (!g) return { takes: false, reason: `${label} has no graph a LoRA could go into.` };
        const info = g.cloud ? null : this.objectInfo;
        const src = modelSource(g.graph, g.decl, info);
        if ("many" in src) return { takes: false, reason: `${label}'s graph has ${src.many.length} model loaders (${src.many.join(", ")}) and the recipe names none of them, so it takes no LoRA rows.` };
        if ("none" in src) {
            // a recipe that declares none because its graph has two loaders (cloud_ideogram_4) says which
            const why = g.decl && g.decl.loras === false ? modelSource(g.graph, { ...g.decl, loras: undefined }, info) : null;
            if (why && "many" in why) return { takes: false, reason: `${label} takes no LoRA rows: its graph has ${why.many.length} model loaders (${why.many.join(", ")}), so the recipe declares none.` };
            return { takes: false, reason: `${label} takes no LoRA rows: ${src.none}.` };
        }
        return { takes: true };
    },

    /**
     * What a run of `r` would load now, [{ name, strength }] (the PNG's tEXt chunk, workflowForPng): the switched-on
     * rows spliced into a copy of its graph, so the rule is the run's own (no model source, more than five: none).
     */
    lorasNow(r = this.recipe) {
        const g = this.loraGraph(r);
        if (!g) return [];
        const rows = this.loraRows(r);
        if (!usableRows(rows).length) return [];
        try { return spliceLoras(JSON.parse(JSON.stringify(g.graph)), g.decl, rows, g.cloud ? null : this.objectInfo).applied; } catch (_) { return []; }
    },

    /**
     * The LoRA rows a local run of `r` sends (queueGenerate, before anything is uploaded): null when its graph takes none
     * or no row is switched on; `{ rows }` in the server's spelling (a name that differs only in its separators). Refuses
     * more than MAX_LORAS rows, and a file the server's list lacks, after reading the list again; against an empty or
     * unread list nothing is refused and the names go as typed (ComfyUI's own check answers, as for the Settings rows).
     * A graph without a model source refuses nothing either, whatever its rows hold: its LoRAs section is hidden
     * (loraTakes, the same rule), so the user can neither see nor change the rows a recipe kept from before it stopped
     * taking them (an imported graph saved again with a second loader). `{ rows: [], hidden }` then, `hidden` the plain
     * line that says why they stayed out (HINT_NOTE; set_generation loras [] clears them). Only reads: the server's list
     * read again is the one thing it keeps (refreshLoraNames), so Generate new asks it before its fresh canvas too.
     */
    async loraPlan(editor, r) {
        const g = this.loraGraph(r);
        if (!g || g.cloud) return null;
        const use = usableRows(this.loraRows(r));
        if (!use.length) return null;
        const src = modelSource(g.graph, g.decl, this.objectInfo);
        if (!("node" in src)) return { rows: [], hidden: `The LoRA rows stored for this recipe stayed out: ${noSourceWords(src)}.` };
        if (use.length > MAX_LORAS) throw refusal(`At most ${MAX_LORAS} LoRAs per recipe: ${r.name || r.id}'s rows switch on ${use.length}. Switch rows off in the LoRAs section, then try again.`, "warn");
        let names = this.loraNames();
        let miss = missingLoras(use, names);
        if (!names.length || miss.some((m) => !m.server)) { names = await this.refreshLoraNames(); miss = missingLoras(use, names); }
        const lacks = miss.filter((m) => !m.server).map((m) => m.name);
        if (lacks.length) {
            const one = lacks.length === 1;
            throw new Error(`Your ComfyUI lacks ${one ? "a LoRA file" : "LoRA files"} this recipe's rows name: ${lacks.join(", ")}. Put the file${one ? "" : "s"} in models/loras (and refresh ComfyUI), pick one of the server's files in the LoRAs section, or switch the row${one ? "" : "s"} off, then try again.`);
        }
        const spelt = new Map(miss.map((m) => [m.name, m.server]));
        return { rows: use.map((row) => ({ ...row, name: spelt.get(row.name) || row.name })) };
    },

    /**
     * The preset row at the top of the editor's Settings section (called by renderSettings): a ComfyUI recipe's shipped
     * presets (its file's `presets`, any row: the Realism Pass's L and M) first, then the user's own; without shipped
     * ones the row needs two file combos (model / text encoder / VAE).
     */
    /**
     * The Preset row's data, or null when the recipe shows none (an API recipe; no shipped presets and fewer than two
     * file combos): `pts` the rows a preset stores, `presets` the list as the select shows it (the shipped ones first,
     * then the user's own; one of the user's with a shipped one's name replaces it), `matching` the one the rows hold
     * now (the user's own first), `own` the user's list, `shipped` the recipe file's. The commands list_settings and
     * apply_preset read the same (docs/PLAN_0_1_42.md F2b).
     */
    presetRow(editor, targets) {
        const r = this.recipe;
        if (!r || r.kind === "provider") return null;
        const keyOf = (t) => `${t.node.id}:${t.inputName}`;
        const shipped = Array.isArray(r.presets) ? r.presets : [];
        const files = this.presetTargets(editor, targets);
        const shippedKeys = new Set(shipped.flatMap((p) => Object.keys(p.values || {})));
        const pts = shipped.length ? targets.filter((t) => shippedKeys.has(keyOf(t)) || files.includes(t)) : files;
        if (!pts.length || (!shipped.length && pts.length < 2)) return null;
        const current = {};
        for (const t of pts) { const e = editor.settings[String(t.index)]; if (e) current[keyOf(t)] = String(e.value); }
        // the user's own (settings.recipePresets); one of a shipped one's name replaces it in the list
        const own = (this.presets || {})[r.id] || [];
        const ownNames = new Set(own.map((p) => p.name));
        const presets = [...shipped.filter((p) => !ownNames.has(p.name)).map((p) => ({ ...p, shipped: true })), ...own];
        // the user's own first: one saved with a shipped one's values stays theirs to pick and delete
        const holds = (p) => Object.entries(p.values || {}).every(([k, v]) => current[k] === String(v));
        const matching = own.find(holds) || presets.find(holds) || null;
        return { recipe: r, keyOf, shipped, own, presets, pts, matching };
    },

    renderPresets(editor, list, targets) {
        const row0 = this.presetRow(editor, targets);
        if (!row0) return;
        const { recipe: r, keyOf, shipped, own, presets, pts, matching } = row0;
        const lab = document.createElement("label");
        lab.textContent = "Preset";
        lab.title = shipped.length
            ? `${shipped.map((p) => p.name).join(" and ")} come with this recipe; Save keeps your own combination of ${pts.map((t) => t.node.title || t.inputName).join(" / ")} beside them.`
            : `A saved combination of ${pts.map((t) => t.node.title || t.inputName).join(" / ")} for this recipe. Pick the files above, then Save.`;
        const row = document.createElement("div");
        row.className = "ipc-preset-row";
        const sel = document.createElement("select");
        sel.className = "ipc-sel";
        sel.title = lab.title;
        const none = document.createElement("option");
        none.value = ""; none.textContent = presets.length ? (matching ? "" : "(custom)") : "(none saved)";
        if (!matching) sel.appendChild(none);
        for (const p of presets) { const o = document.createElement("option"); o.value = p.name; o.textContent = p.name; sel.appendChild(o); }
        // every row back to the recipe file's values (the rows otherwise start with what you last set: issue #12)
        const OWN = "\u0000own";
        const ownOpt = document.createElement("option");
        ownOpt.value = OWN; ownOpt.textContent = "Recipe's own values";
        sel.appendChild(ownOpt);
        sel.value = matching ? matching.name : "";
        sel.addEventListener("change", () => {
            if (sel.value === OWN) { this.resetToRecipeValues(editor); return; }
            const p = presets.find((x) => x.name === sel.value);
            if (!p) return;
            this.applyPreset(editor, targets, p);
            this.rememberValues(editor, this.rowValues(editor, pts));
        });
        const save = document.createElement("button");
        save.type = "button"; save.className = "ipc-ib"; save.textContent = "Save"; save.title = "Save the current combination under a name (Enter saves, Escape cancels).";
        const del = document.createElement("button");
        del.type = "button"; del.className = "ipc-ib"; del.textContent = "Delete"; del.disabled = !matching || !!matching.shipped;
        del.title = matching && matching.shipped ? `"${matching.name}" comes with the recipe and stays` : matching ? `Delete the preset "${matching.name}"` : "Delete the selected preset";
        save.addEventListener("click", () => {
            // the select becomes a name field: the first file's stem is the suggestion
            const first = pts[0] && editor.settings[String(pts[0].index)];
            const stem = first ? String(first.value).replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "") : "";
            const input = document.createElement("input");
            input.type = "text"; input.value = matching ? matching.name : stem; input.placeholder = "preset name"; input.spellcheck = false;
            const finish = async (ok) => {
                const name = input.value.trim();
                if (ok && name) {
                    const values = {};
                    for (const t of pts) { const e = editor.settings[String(t.index)]; if (e) values[keyOf(t)] = e.value; }
                    const next = own.filter((p) => p.name !== name).concat([{ name, values }]).sort((a, b) => a.name.localeCompare(b.name));
                    await this.savePresets(r.id, next);
                    for (const ed of this._editors) { try { ed.renderSettings(); } catch (_) { /* not built */ } }
                    editor.setStatus(`Preset "${name}" saved for ${r.name || r.id}.`);
                } else {
                    editor.renderSettings();
                }
            };
            input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); finish(true); } if (e.key === "Escape") { e.preventDefault(); finish(false); } });
            row.replaceChild(input, sel);
            save.textContent = "OK";
            save.onclick = () => finish(true);
            del.textContent = "Cancel"; del.disabled = false; del.onclick = () => finish(false);
            input.focus(); input.select();
        });
        del.addEventListener("click", async () => {
            if (!matching || matching.shipped || del.textContent !== "Delete") return;
            await this.savePresets(r.id, own.filter((p) => p.name !== matching.name));
            for (const ed of this._editors) { try { ed.renderSettings(); } catch (_) { /* not built */ } }
            editor.setStatus(`Preset "${matching.name}" deleted.`);
        });
        row.append(sel, save, del);
        lab.appendChild(row);
        list.appendChild(lab);
    },

    /**
     * The Settings rows of the selected local recipe whose file the server's list lacks: `[{ label, value, link }]`.
     * Until 0.1.45 such a row silently became the folder's first file (issue #4: a Flux file on most installs, and
     * "no edits done"); now the recipe's value stays (the select marks it, inpaint_canvas.js renderSettings) and the
     * run is refused with the download link from the recipe's `models`. `r` must be the selected recipe, since the
     * rows are its targets.
     */
    missingSettingFiles(editor, r = this.recipe) {
        if (!r || r !== this.recipe || !r.prompt || !editor || !editor.settings) return [];
        const out = [];
        // the prompt upsampler's rows (0.1.50 Q9): without its file the run goes as typed, with a note, not refused
        const up = new Set(((r.upsampler && r.upsampler.nodes) || []).map(String));
        for (const t of this.settingTargets()) {
            const entry = editor.settings[String(t.index)];
            if (!entry || entry.value == null || entry.value === "") continue;
            if (up.has(String(t.node.id))) continue;
            const k = editor.settingKind(t);
            if (k.kind !== "combo" || !k.options.length) continue;
            const value = String(entry.value);
            if (k.options.map(String).includes(value)) continue;
            out.push({ label: entry.label, value, link: this.modelLink(r, value) });
        }
        return out;
    },

    /** The download link a recipe's `models` gives for a file name (rows of "file (url)" per folder), or null. */
    modelLink(r, file) {
        for (const list of Object.values((r && r.models) || {})) {
            for (const row of Array.isArray(list) ? list : []) {
                const m = /^(.*?)\s*\((https?:\/\/[^)]+)\)\s*$/.exec(String(row));
                if (m && m[1] === String(file)) return m[2];
            }
        }
        return null;
    },

    /** Check if ComfyUI object info has the required models for the relight recipe; throws if missing. */
    checkComfyRelightModels(recipe, info) {
        if (!info) return;
        const loras = info.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] || [];
        const unets = info.UNETLoader?.input?.required?.unet_name?.[0] || [];
        const clips = info.CLIPLoader?.input?.required?.clip_name?.[0] || [];
        const vaes = info.VAELoader?.input?.required?.vae_name?.[0] || [];
        const checks = [
            { label: "UNet", file: "qwen_image_edit_2509_fp8_e4m3fn.safetensors", list: unets },
            { label: "Text encoder", file: "qwen_2.5_vl_7b_fp8_scaled.safetensors", list: clips },
            { label: "VAE", file: "qwen_image_vae.safetensors", list: vaes },
            { label: "Relight LoRA", file: "Qwen-Image-Edit-2509-Relight.safetensors", list: loras },
            { label: "Lightning LoRA", file: "Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors", list: loras },
        ];
        const missing = [];
        for (const item of checks) {
            if (!Array.isArray(item.list) || !item.list.includes(item.file)) {
                const link = this.modelLink(recipe, item.file);
                missing.push(`${item.label}: ${item.file}${link ? " (" + link + ")" : ""}`);
            }
        }
        if (missing.length) {
            throw new Error(`Your ComfyUI lacks ${missing.length === 1 ? "a model file this recipe needs" : "model files this recipe needs"}: ${missing.join("; ")}. Put the file in that models folder (and restart or refresh ComfyUI), then try again.`);
        }
    },

    /** The refusal for a run whose Settings rows name files the server lacks, or null when every file is there. */
    missingFilesRefusal(editor, r = this.recipe) {
        const miss = this.missingSettingFiles(editor, r);
        if (!miss.length) return null;
        const rows = miss.map((m) => `${m.label}: ${m.value}${m.link ? " (" + m.link + ")" : ""}`).join("; ");
        return `Your ComfyUI lacks ${miss.length === 1 ? "a model file this recipe needs" : "model files this recipe needs"}: ${rows}. Put the file in that models folder (and restart or refresh ComfyUI), or pick one of the server's files in the Settings panel, then try again.`;
    },

    /** A preset's values into the document's Settings rows; `{ rows, missing }` (rows named, files the server lacks). */
    applyPreset(editor, targets, preset) {
        const missing = [];
        let rows = 0;
        // every row the preset names (a shipped one may name any row, a user's names the rows it was saved from)
        for (const t of targets) {
            const v = (preset.values || {})[`${t.node.id}:${t.inputName}`];
            const e = editor.settings[String(t.index)];
            if (v == null || !e) continue;
            rows++;
            const k = editor.settingKind(t);
            if (k.kind === "combo") { if (k.options.map(String).includes(String(v))) e.value = v; else missing.push(String(v)); }
            else if (k.kind === "number") e.value = +v;
            else if (k.kind === "boolean") e.value = !!v;
            else e.value = String(v);
        }
        editor.renderSettings();
        editor.notifyChanged();
        editor.setStatus(!rows ? `Preset "${preset.name}" names no Settings row of this recipe: nothing changed.`
            : missing.length ? `Preset "${preset.name}": ${missing.join(", ")} not on the server, kept the current choice there.` : `Preset "${preset.name}" applied.`, !rows ? "info" : missing.length ? "warn" : "info");
        return { rows, missing };
    },

    /**
     * The mode a (resolved) recipe runs in: cloud for a Comfy Cloud recipe, its own graph run on Comfy Cloud (item 35
     * V6; the shell's modeOf), api for a provider recipe or a ComfyUI recipe of API nodes, else local.
     */
    recipeMode(r) {
        return r.kind === "provider" && r.provider === "comfycloud" && r.options && r.options.graph ? "cloud"
            : r.kind === "provider" || r.mode === "api" ? "api" : "local";
    },

    /**
     * A document opened, reopened or restored keeps the selected recipe's mode, not the one its file holds: the recipe
     * is the app's, and a file saved under another one would plan the crop for that mode (a local refine pass for a
     * provider run). Only the mode: the Settings values stay as the file has them.
     */
    keepRecipeMode(ed) {
        if (!this.recipe) return;
        const mode = this.recipeMode(this.recipe);
        if (ed.genSettings.mode !== mode) { ed.genSettings.mode = mode; ed.syncGenControls(); }
    },

    /** The recipe decides the mode (local / api / cloud) and the Settings panel of every editor. */
    applyRecipe(ed) {
        const r = this.recipe;
        if (!r) return;
        const mode = this.recipeMode(r);
        if (ed.genSettings.mode !== mode) { ed.genSettings.mode = mode; ed.syncGenControls(); }
        ed.settingsChanged();
        ed.syncBoxesRow();
        ed.renderInfo();
        // the LoRAs section after the Settings rows (item 50, docs/PLAN_LORAS.md §3.2): made on the first call, then re-rendered
        try { loraPanel.ensure(this, ed); } catch (err) { console.warn("loras section", err); }
    },

    /** The recipe's editable inputs in the shape settingTargets() had in the node. */
    settingTargets(editor) {
        const r = this.recipe;
        if (!r) return [];
        const out = [];
        if (r.kind === "provider") {
            // provider parameters: the recipe carries the spec itself (no /object_info). The node id names
            // the recipe and its provider, because the editor keeps a stored value while the target stays
            // the same: with one id for every provider recipe, a "standard" Channel chosen on Qwen via
            // ToAPIs ran GPT Image 2 on its maskless channel, and GPT Image 2.5's "xhigh" fell to "low"
            const nodeId = `provider/${r.id}/${r.provider}`;
            for (const s of r.settings || []) {
                const spec = s.spec || ["STRING", {}];
                const own = s.default !== undefined ? s.default : (spec[1] && spec[1].default !== undefined ? spec[1].default : (Array.isArray(spec[0]) ? spec[0][0] : undefined));
                // a row starts with the value you last set for this recipe (issue #12), else the recipe's own
                const kept = this._ownValues ? undefined : this.rememberedValue(r.id, `${nodeId}:${s.key}`);
                const value = kept !== undefined ? kept : own;
                out.push({
                    index: s.index, output: { name: `setting_${s.index}` },
                    node: { id: nodeId, title: s.label || s.key, type: r.provider },
                    inputName: s.key, spec, widget: value !== undefined ? { value } : null,
                });
            }
            return out;
        }
        if (!r.prompt) return [];
        for (const s of r.settings || []) {
            const node = r.prompt[s.node];
            if (!node) continue;
            const info = this.objectInfo && this.objectInfo[node.class_type];
            const inp = info && info.input;
            const spec = inp && ((inp.required && inp.required[s.input]) || (inp.optional && inp.optional[s.input])) || s.spec || null;
            const current = node.inputs ? node.inputs[s.input] : undefined;
            const own = s.default !== undefined ? s.default : (Array.isArray(current) ? undefined : current);
            // a row starts with the value you last set for this recipe (issue #12), else the recipe's own
            const kept = this._ownValues ? undefined : this.rememberedValue(r.id, `${r.id}/${s.node}:${s.input}`);
            const value = kept !== undefined ? kept : own;
            // the key names the recipe too: the editor keeps a stored value while the key stays the same, and Qwen
            // and Klein both load from nodes "unet", "clip" and "vae", so Klein was queued with Qwen's files
            out.push({
                index: s.index, output: { name: `setting_${s.index}` },
                node: { id: s.node, title: s.label || s.input, type: node.class_type },
                inputName: s.input, key: `${r.id}/${s.node}:${s.input}`, spec, widget: value !== undefined ? { value } : null,
            });
        }
        return out;
    },

    resultInputState(editor) {
        const r = this.recipe;
        if (!r) return { name: "result_local", wired: false, fallback: false };
        // `provider`: the run goes through runProvider / runUpscale and needs the document's run slot (`providerPending`);
        // the editor's generate() refuses it while the slot is held (the node's host never says so)
        if (r.kind === "provider") return { name: "result", wired: true, fallback: editor.genSettings.mode === "local", provider: true };
        const want = editor.genSettings.mode === "local" ? "result_local" : "result";
        const has = r.mode === "api" ? "result" : "result_local";
        return { name: has, wired: !!r.result, fallback: want !== has };
    },

    widgetValue(editor, name, fallback) {
        const v = this.nodeParams[name];
        return v == null ? fallback : +v;
    },

    /** The provider recipe's parameter values from the editor's Settings panel plus the recipe's fixed ones. */
    providerParams(editor, overrides) {
        const r = this.recipe;
        const params = {};
        for (const s of (r && r.settings) || []) {
            const entry = editor.settings[String(s.index)];
            if (entry && entry.value != null && entry.value !== "") params[s.key] = entry.value;
        }
        for (const [k, v] of Object.entries((r && r.fixed) || {})) params[k] = v;
        for (const [k, v] of Object.entries(overrides || {})) if (v != null && v !== "") params[k] = v;
        return params;
    },

    /**
     * Whether the chosen provider variant takes a `background` parameter, which is what an
     * OpenAI image model answers a transparent cut-out to. The recipe says so by carrying a
     * setting with that key (docs/RECIPES.md, "Transparent results").
     */
    supportsTransparency(use = "edit") {
        const r = this.recipe;
        if (!r || r.kind !== "provider") return false;
        const rows = use === "text" ? ((r.text && r.text.settings) || r.settings || []) : (r.settings || []);
        return rows.some((s) => s.key === "background");
    },

    /** True when this run asked the model for a transparent background. */
    wantsTransparent(params) {
        return String((params || {}).background || "").trim().toLowerCase() === "transparent";   // as ark.js reads it
    },
};
