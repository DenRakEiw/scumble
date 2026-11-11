// the commands for the app, documents, recipes, LoRAs, plugins, status and new pictures: moved out of commands.js (item 56 S12, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./editor/host.js";
import { LABEL as REALISM_LABEL } from "./editor/realism.js";
import { FAMILIES, filterNames, folderFits, groupByFolder, loraFolder, loraHint, recipeFamily } from "./editor/loras.js";
import { AREA_CAP } from "./editor/eacharea.js";
import { layerSpecOf } from "./editor/splitlayers.js";
import { FILE_PARAMS, P, VERSION, appInfo, clampInt, describe, docSummary, documentMax, fileFrom, layerSummary, loadNotes, lorasView, memoryMB, newCanvasPreset, recipeReadiness, requireImage, serverUp, status, touch } from "./commands_util.js";

/** @typedef {import("./commands.js").Command} Command */

/** @satisfies {Record<string, Command>} */
export const DocCommandsPart = {
    // -- app --
    ping: {
        readOnly: true,
        scope: "app", description: "Whether the app answers: version, the open documents, the recipe, the connection.",
        params: {},
        async run() { return appInfo(); },
    },
    list_commands: {
        readOnly: true,
        scope: "app", description: "Every command with its parameters (this table).",
        params: {},
        async run() { return { version: VERSION, commands: describe() }; },
    },
    list_documents: {
        readOnly: true,
        scope: "app", description: "The open tabs: id, name, size, layer count, which one is active.",
        params: {},
        async run() { return { active: host.editor ? host.editor.node.id : null, documents: host.editors().map(docSummary) }; },
    },
    new_document: {
        scope: "app", description: "Open a new empty tab and make it active. Returns its id (use it as `doc`).",
        params: { activate: P.bool("make it the active tab (default true)", { default: true }) },
        async run(_, a) { const ed = host.shell.newDocument(); if (a.activate !== false) host.shell.activate(ed); return docSummary(ed); },
    },
    activate_document: {
        description: "Bring a tab to the front.",
        params: { doc: P.int("the document id (from list_documents)", { required: true }) },
        async run(ed) { host.shell.activate(ed); return docSummary(ed); },
    },
    save_document: {
        destructive: true,
        needsImage: true,
        description: "Save the document as a .scumble file that reopens fully editable (layers, masks, filters, text, 3D objects, selection, prompts, result history). Without `path` it saves to the tab's file (an error when it has none); with `path` it is Save As, and the tab follows the new file unless `copy` is true. Nothing is asked: a file changed on disk is overwritten.",
        params: {
            path: P.str("absolute path ending in .scumble (Save As); omit to save to the tab's file"),
            copy: P.bool("write the file without making it the tab's file (a snapshot)", { default: false }),
            history: P.bool("include the result history and the prompts of earlier runs (default true)", { default: true }),
        },
        async run(ed, a) {
            const path = a.path != null && String(a.path).trim() ? String(a.path).trim() : null;
            if (path && !/\.scumble$/i.test(path)) throw new Error("the path must end in .scumble");
            if (!path && !(ed.docFile && ed.docFile.path)) throw new Error("this tab has no .scumble file yet: pass path");
            if (!path && a.copy) throw new Error("a copy needs a path");
            const r = await host.saveDocument(ed, { path, copy: !!a.copy, history: a.history !== false, ask: false });
            if (!r) throw new Error("the save was cancelled");
            return { path: r.path, bytes: r.bytes, entries: r.entries, ms: r.ms, notes: r.notes || [], document: docSummary(ed) };
        },
    },
    open_document: {
        scope: "app",
        description: "Open a .scumble file as a tab (the tab that already holds it is activated instead). Returns the document and notes (a newer format, a renamed file, another recipe, layers of a newer version left out).",
        params: { path: P.str("absolute path of a .scumble file", { required: true }), activate: P.bool("make it the active tab (default true)", { default: true }) },
        async run(_, a) {
            const path = String(a.path || "").trim();
            if (!/\.scumble$/i.test(path)) throw new Error("the path must end in .scumble");
            const before = host.editor;
            const r = await host.openDocument(path);
            if (a.activate === false && before && before !== r.editor && host.editors().includes(before)) host.shell.activate(before);
            const notes = [...(r.notes || [])];
            // what the load left out, once (a host that says it in its own notes is not repeated)
            if (!r.already) for (const n of loadNotes(r.editor)) if (!notes.some((x) => String(x).includes(n))) notes.push(n);
            return { ...docSummary(r.editor), already: !!r.already, notes };
        },
    },
    close_document: {
        destructive: true,
        description: "Close a tab without asking (unsaved changes are not written to its .scumble file). A run going in it stops as cancel_run stops it, and nothing lands: an API provider may still charge a job it already had. File › Reopen Closed Tab brings the tab back in this session, without the run (remember false: it does not, and the tab stays off that list and the autosave's); the document's files stay in the local store.",
        params: { remember: P.bool("put the tab on File › Reopen Closed Tab (default true)", { default: true }) },
        async run(ed, a) { const id = ed.node.id; host.shell.closeDocument(ed, { force: true, remember: a.remember !== false }); return { closed: id, documents: host.editors().map(docSummary) }; },
    },
    reopen_closed_tab: {
        scope: "app",
        description: "File › Reopen Closed Tab: the tab closed last in this session comes back as a new active tab (its layers, prompt and file as it was closed; its renders still on ComfyUI land in it again, a run it had on an API provider does not). An error when no closed tab is left. Returns the document (a new id), notes, and how many closed tabs are left.",
        params: {},
        async run() {
            if (!host.closed || !host.closed.length) throw new Error("No closed tab to reopen.");
            const ed = await host.reopenClosed();
            if (!ed) throw new Error("No closed tab to reopen.");
            // a tab whose files are not in the local store waits for ComfyUI: its status line says so
            return { ...docSummary(ed), notes: ed.base ? loadNotes(ed) : [String(ed.status || "")].filter(Boolean), closed_left: host.closed.length };
        },
    },
    list_recipes: {
        readOnly: true,
        scope: "app", description: `The recipes (ComfyUI workflows and API providers) and which one is selected. ready: whether the recipe can run now (an API recipe: a key stored for its chosen provider, or the in-app model downloaded; a recipe on the user's ComfyUI: connected and every node type it needs on the server; the ${REALISM_LABEL} recipe, task "pass": whether the connected ComfyUI can run it, with a note for RTX 30), reason when not. keys: per provider of the recipe whether it has a key (true / false). new_image: whether generate_new can make a picture with it (an API recipe: its chosen provider has a text-to-image route); edit: whether generate takes it (false: the model makes pictures from the prompt alone); sizes: the long sides its text route offers (null: any size); aspects: the aspects the Generate new dialog and new_canvas's model preset offer for it (its chosen provider's own list, else the general one); classes: its size classes for those, [{ size, name, label }] (size: the long side in pixels, name: the provider's tier such as 1k, 2K or 2 MP, null where it names none); background: whether generate_new's background transparent goes to it; layers: where split_layers can run on it, { provider (the host it runs on: the chosen provider when that one has a layer mode, else BytePlus ModelArk), max (layers besides the base), count (whether it takes a count), text_recognition (whether it takes the Text recognition switch), tiers (whether it takes a size tier; false: Auto only) }. An upscaler: factor, limits (an upscaler on the user's ComfyUI), document_max (the longest side upscale's scope document takes; null: no cap). textRefs: whether generate_new sends the shown reference layers along (an API recipe: with the chosen provider's text route; a local recipe: whether its graph reads pictures after the white canvas, which is image 1). false: the prompt alone. loras: whether the recipe takes LoRA rows (a recipe on your ComfyUI or Comfy Cloud whose graph has one model loader; set_generation loras sets them, list_loras lists the files they may name), loras_reason when not. provider_keys: every API provider and whether a key is stored for it (never the key). status has the pass's readiness for a document (its runs, its size).`,
        params: {},
        async run() {
            const cur = host.recipe;
            return {
                selected: cur ? cur.id : null, provider: cur && cur.kind === "provider" ? cur.provider : null,
                recipes: host.shell.recipes().map((r) => {
                    const v = host.shell.resolveRecipe(r);
                    const pass = r.task === "pass", up = r.task === "upscale", relight = r.task === "relight", api = r.kind === "provider";
                    // what the Generate new dialog offers for it: the chosen variant's text route (a local recipe takes any size)
                    const text = api ? v.text || null : null;
                    const makes = !up && !pass && !relight && (!api || !!text);
                    const rows = text ? text.settings || v.settings || [] : [];
                    // the aspects and size classes the Generate new dialog and new_canvas's preset offer (item 34)
                    const preset = makes && host.shell.genPresetOf ? host.shell.genPresetOf(r, api ? v.provider : "") : null;
                    // whether the recipe takes LoRA rows (item 50): the LoRAs section's own answer and its reason, on the
                    // recipe resolved to its chosen provider (a Comfy Cloud graph is told from an API route by it)
                    const lt = host.loraTakes(v);
                    return {
                        id: r.id, name: r.name || r.id, kind: r.kind || "comfy", family: r.family || null, mode: host.shell.modeOf(r), provider: v.provider || null, providers: r.providerIds || [], model: v.model || null, task: r.task || "edit",
                        ...recipeReadiness(r, v),
                        keys: api ? Object.fromEntries((r.providerIds || []).map((pid) => { const ks = host.shell.keyState(host.shell.resolveRecipe(r, pid)); return [pid, !ks || !!ks.ok]; })) : undefined,
                        new_image: makes, edit: up || pass || relight ? undefined : api ? v.edit !== false : r.edit !== false,
                        sizes: makes ? (text && Array.isArray(text.sizes) && text.sizes.length ? text.sizes.slice().sort((x, y) => x - y) : null) : undefined,
                        aspects: makes ? (preset ? preset.aspects : null) : undefined,
                        classes: makes ? (preset ? preset.classes.map((x) => ({ size: x.px, name: x.name, label: x.label })) : null) : undefined,
                        background: makes ? rows.some((s) => s.key === "background") : undefined,
                        layers: ((s) => (s ? { provider: s.provider, max: s.max, count: s.count, text_recognition: s.text, tiers: s.tiers } : undefined))(layerSpecOf(r, api ? v.provider : undefined)),
                        factor: up ? v.factor || null : undefined, limits: up && !api ? r.limits || null : undefined, document_max: up ? documentMax(r, v) : undefined,
                        usesPrompt: up ? !!v.usesPrompt : undefined,
                        textRefs: up || pass || relight ? undefined : api ? !!(v.text && v.text.refs) : ((s) => s == null || s > 1)(host.comfyPlan(null, r, 0, { hasSelection: true }).spec.slots),
                        loras: !!lt.takes, loras_reason: lt.takes ? null : lt.reason || null,
                        description: r.description || "", source: r.source || "builtin",
                    };
                }),
                provider_keys: host.shell.providerKeys ? host.shell.providerKeys() : [],
            };
        },
    },
    select_recipe: {
        destructive: true,
        scope: "app", description: "Select the recipe every tab generates with; model recipes take the provider to run on (toapis, gemini, openai, bfl, fal, replicate, wavespeed, comfycloud, openrouter, ark, minimax, oxen, magnific; list_recipes has each recipe's own), else the remembered or default one.",
        params: { id: P.str("recipe id (from list_recipes)", { required: true }), provider: P.str("provider id for a model recipe (one of its providers from list_recipes)") },
        async run(_, a) {
            const r = host.shell.recipes().find((x) => x.id === a.id);
            if (!r) throw new Error(`no recipe "${a.id}" (${host.shell.recipes().map((x) => x.id).join(", ")})`);
            if (r.task === "relight") throw new Error(`recipe "${a.id}" is a relight recipe; run it via the relight command or the Relight tool`);
            if (a.provider && !(r.providerIds || []).includes(a.provider)) throw new Error(`recipe "${a.id}" has no provider "${a.provider}" (${(r.providerIds || []).join(", ") || "none"})`);
            host.shell.selectRecipe(r.id, a.provider || undefined);
            return { selected: host.recipe ? host.recipe.id : null, kind: r.kind || "comfy", provider: host.recipe && host.recipe.kind === "provider" ? host.recipe.provider : null };
        },
    },
    // item 50 (docs/PLAN_LORAS.md §3.8): the server's LoRA files, the names set_generation loras takes
    list_loras: {
        readOnly: true,
        scope: "app", description: `The LoRA files of your ComfyUI (models/loras and its extra paths), as set_generation loras names them, grouped by subfolder: folders [{ folder ("" for models/loras itself), count, names [{ name, hint, mismatch }] }], read from the server again on each call. hint: the base model the file looks made for where Scumble has read it (the LoRAs section reads a row's file; null otherwise), mismatch: its tensor names fit another model than the selected recipe's. filter: only the names holding every word of it (any case, / and \\ alike); family: only the files of that base model, by their folder's name or a hint read before (one of ${Object.keys(FAMILIES).join(", ")}, or "recipe" for the selected recipe's own); max: the most names listed (total says how many match). connected: false while no ComfyUI answers (the list is then the last one read, often empty). recipe_family: the base model the selected recipe's LoRAs should fit, when known. While a Comfy Cloud recipe is selected (source "comfycloud"; else "comfyui"): Comfy Cloud's lists for the stored key instead, your own imports (own: true) and its catalog, no hint; connected: whether they were read; error: why not.`,
        params: {
            filter: P.str("only the names holding every word of this (any case; / and \\ alike)"),
            family: P.str(`only the files of this base model (${Object.keys(FAMILIES).join(", ")}, or "recipe" for the selected recipe's)`),
            max: P.int("the most names listed", { default: 200 }),
        },
        async run(_, a) {
            const r = host.recipe;
            const t = host.loraTakes(r);
            const recipeFam = t.takes ? recipeFamily(r) : null;
            let fam = null;
            const asked = a.family != null ? String(a.family).trim() : "";
            if (asked) {
                fam = asked === "recipe" ? recipeFam : asked;
                if (asked === "recipe" && !fam) throw new Error(`the selected recipe names no base-model family${t.takes ? "" : ` (${t.reason})`}: give a family (${Object.keys(FAMILIES).join(", ")})`);
                if (!FAMILIES[fam]) throw new Error(`unknown family "${asked}" (${Object.keys(FAMILIES).join(", ")}, or "recipe")`);
            }
            // a Comfy Cloud recipe: Comfy Cloud's lists (read with the stored key), else your ComfyUI's
            const cloud = t.takes && host.loraSource(r) === "cloud";
            const names = cloud ? await host.refreshLoraNamesFor(r) : serverUp() ? await host.refreshLoraNames() : host.loraNames();
            const connected = cloud ? !!(host._cloudLoras && host._cloudLoras.key && (host._cloudLoras.assets || host._cloudLoras.nodeList)) : serverUp();
            const own = new Set(cloud && host._cloudLoras && Array.isArray(host._cloudLoras.own) ? host._cloudLoras.own : []);
            // a hint known already (a look, never a read: the server lists over a thousand files)
            const hintOf = (n) => { if (cloud) return null; const inf = host.loraInfo(n, { read: false }); return inf ? inf.fam : null; };
            let kept = filterNames(names, a.filter);
            if (fam) kept = kept.filter((n) => folderFits({ folder: loraFolder(n), names: [n] }, fam, hintOf));
            const max = a.max == null || a.max === "" ? 200 : clampInt(a.max, 0, 100000, 200);
            let left = max;
            const folders = [];
            for (const g of groupByFolder(kept)) {
                const take = left > 0 ? g.names.slice(0, left) : [];
                left -= take.length;
                if (!take.length) continue;
                folders.push({ folder: g.folder, count: g.names.length, names: take.map((n) => {
                    const f = hintOf(n);
                    const h = f ? loraHint(f, recipeFam) : null;
                    return { name: n, hint: f ? f.label : null, mismatch: !!(h && h.kind === "mismatch"), ...(cloud ? { own: own.has(n) } : {}) };
                }) });
            }
            return {
                connected, source: cloud ? "comfycloud" : "comfyui", recipe: r ? r.id : null, recipe_family: recipeFam, filter: a.filter != null && String(a.filter).trim() ? String(a.filter).trim() : null, family: fam,
                total: kept.length, listed: max - left, folders,
                ...(cloud ? { error: (host._cloudLoras && host._cloudLoras.error) || null } : {}),
            };
        },
    },
    list_plugins: {
        readOnly: true,
        scope: "app", description: "The plugins (built-in and from the user's plugin folder), their state and what they registered.",
        params: {},
        async run() { return { plugins: host.plugins ? host.plugins.list() : [] }; },
    },
    run_action: {
        description: "Run a plugin action (a Plugins menu entry) on the document.",
        params: { id: P.str("action id (from list_plugins)", { required: true }) },
        async run(ed, a) { if (!host.plugins) throw new Error("no plugins loaded"); return { result: await host.plugins.runAction(a.id, ed) }; },
    },

    // -- document --
    status: {
        readOnly: true,
        description: `What the document holds: image size, prompt, generation settings (generation.target, when set: the document's preset for Generate new, from new_canvas with a recipe or the last generate_new, valid while the picture keeps the size it was made at), selection bounds, every layer, the reference layers (label = what @img1, @img2 in the prompt name; sent_as = the name the selected recipe's route sends that picture as), pending jobs, the recipe, and what the app is using in memory. realism: whether realism_pass (${REALISM_LABEL}) at factor 1 would start on this document now (ready; reason when not: the server, a run going on it, a local render on the user's ComfyUI included, still loading, no picture, past 7680 × 4320 or 27.9 megapixels; status answers for factor 1, and above it a picture already past that size is refused too: only a picture whose output would pass it is scaled down), note (RTX 30), and the app's style, strength and preset it sends. key: whether key_screen with its default route would start on this document now (ready; reason when not: what the route lacks, a run going, no picture), route (that default: comfyui, the user's own ComfyUI with a CorridorKey 2.0 node pack, the only route of this build; app, in Scumble, once it has an engine), the in-app engine's provider (cpu: on the CPU, no live preview) and working size, and comfy: the ComfyUI route's own readiness (ready, reason: not connected, no RTX 30+ card, no node pack, no Inpaint Canvas), the pack it keys with (pack, pack_label, verified: whether that pack has keyed with Scumble), the card (gpu), cap_mp (settings.key.cap: the largest box that goes at its own size, in megapixels of 2^20 px), keep_on_gpu and timeout (settings.key). loras: the selected recipe's LoRA rows (kept per recipe for every document; set_generation loras sets them): takes (whether its graph takes rows; reason when not), family (the base model its LoRAs should fit, when known), rows [{ name, strength, on, hint, mismatch, triggers, on_server }] (hint: the base model the file looks made for, null while unknown; mismatch: its tensor names fit another model than the recipe's, which never refuses a run; triggers: the file's trigger words; on_server: whether the server's list has it, null while the list is unread), and sent: what a run now would load, [{ name, strength }]. areas: the selection's separate areas (counted on a coarse copy of it; the parts whose crops would overlap are one area, parts smaller than a speck, max(256 px, a 20,000th of the picture), are not counted): count, each_area (whether generate each_area would run them with the selected recipe: 2 to ${AREA_CAP} areas), cap, specks, and each area's box [{ x, y, w, h }].`,
        params: {},
        async run(ed) {
            const s = status(ed);
            let info = null;
            try { info = await host.refLayout(ed, {}, { keep: false }); } catch (_) { info = null; }
            s.references = s.references.map((x) => ({ ...x, sent_as: info && x.label ? info.names.get(x.id) || null : null }));
            let areas = null;
            try { areas = await host.selectionAreas(ed); } catch (_) { areas = null; }
            return { ...s, areas, loras: lorasView(host.recipe), memory: await memoryMB() };
        },
    },
    new_canvas: {
        destructive: true,
        description: "Start a new white canvas of the given size in this tab (discards its image and layers). With recipe, aspect and size instead (a model preset, as the New dialog's Model): the canvas is made in that aspect at the size class's long side, at most 2048 px (boxes are fractions of the picture, so the class is kept for later instead of a canvas that large), the recipe is selected on its provider (for every tab, as select_recipe), and the document keeps the preset: generate_new without width, height and aspect then asks for that aspect and size class, and the Generate new dialog opens on it. list_recipes gives each recipe's aspects and classes.",
        params: {
            width: P.int("width in pixels (16..16384)", { default: 1024 }), height: P.int("height in pixels", { default: 1024 }),
            recipe: P.str("a model preset instead of width and height: the recipe id (list_recipes, one with new_image true); needs aspect and size"),
            provider: P.str("with recipe: the provider of a model recipe (one of its providers with a text-to-image route); its remembered or default one when left out"),
            aspect: P.str("with recipe: one of the aspects it offers on that provider (list_recipes aspects), e.g. 7:5"),
            size: P.int("with recipe: the size class, its long side in pixels (list_recipes classes: size), e.g. 4096 for FLUX 3's 4k"),
        },
        async run(ed, a) {
            const preset = a.recipe != null || a.provider != null || a.aspect != null || a.size != null;
            if (!preset) {
                const w = clampInt(a.width, 16, 16384, 1024), h = clampInt(a.height, 16, 16384, 1024);
                await ed.newCanvas(`${w}x${h}`);
                if (ed.width !== w || ed.height !== h) throw new Error(ed.status);
                // a preset of the picture before (item 34) does not hold for a canvas of a size given by hand, and the
                // next New opens on "Any size" as this one was made
                if (ed.genSettings && ed.genSettings.target) { delete ed.genSettings.target; ed.notifyChanged(); }
                await host.newCanvasChosen(ed, null);
                return { width: ed.width, height: ed.height };
            }
            const t = newCanvasPreset(ed, a);
            await ed.newCanvas(`${t.width}x${t.height}`);
            if (ed.width !== t.width || ed.height !== t.height) throw new Error(ed.status);
            const target = { recipe: t.recipe, provider: t.provider, aspect: t.aspect, size: t.size, width: ed.width, height: ed.height };
            ed.genSettings.target = target;
            await host.newCanvasChosen(ed, target);
            ed.notifyChanged();
            const r = host.recipe;
            return { width: ed.width, height: ed.height, target: { ...target }, recipe: r ? r.id : null, provider: r && r.kind === "provider" ? r.provider : null };
        },
    },
    load_image: {
        destructive: true,
        description: "Load an image as the base image of this tab (replaces its image, layers and history). From a local path, or by file name from the local store. An SVG is rasterised on the way in: at width x height when given (one of them keeps the aspect), else at its own declared size, else 2048 px on the long side.",
        params: { ...FILE_PARAMS, width: P.int("SVG only: the pixel width to rasterise at"), height: P.int("SVG only: the pixel height to rasterise at") },
        async run(ed, a) {
            if (ed.pending) ed.cancelPending();
            if (ed.textEdit) ed.endTextEdit(false);
            if (a.path) {
                const size = (+a.width > 0 || +a.height > 0) ? [+a.width > 0 ? Math.round(+a.width) : 0, +a.height > 0 ? Math.round(+a.height) : 0] : null;
                const prev = ed.base;   // loadFile says a failure in the status line; a tab with an image kept its old one
                await ed.loadFile(await fileFrom(a), { size, ask: false });
                if (!ed.base || ed.base === prev) throw new Error(ed.status || "the image could not be loaded");
            } else {
                if (!a.filename) throw new Error("pass path or filename");
                const ref = { filename: a.filename, subfolder: a.subfolder || "", type: a.type || "input" };
                await ed.setBaseFromRef(ref);
            }
            ed.history = []; ed.renderHistory && ed.renderHistory();
            return { width: ed.width, height: ed.height, base: ed.base.ref };
        },
    },
    add_image_layer: {
        description: "Add an image file as a new layer. role \"none\": part of the picture (fitted to the canvas, or placed at x,y with width/height); role \"reference\": a reference image for multi-reference models, not part of the picture (in an empty tab it gets a white 1024 x 1024 canvas, which generate_new replaces while the reference stays). An SVG is rasterised to fit the document first, so it stays sharp.",
        params: { ...FILE_PARAMS, role: P.str("none or reference", { enum: ["none", "reference"], default: "none" }), name: P.str("layer name (default the file name)"), x: P.int("left edge in image pixels"), y: P.int("top edge"), width: P.int("width; without height the aspect is kept"), height: P.int("height") },
        async run(ed, a) {
            const role = a.role === "reference" ? "reference" : "none";
            // a reference may start an empty tab (a white canvas under it, 26f); a picture layer needs a picture
            if (role !== "reference") requireImage(ed);
            const before = new Set(ed.layers.map((l) => l.id));
            const at = Number.isFinite(+a.x) && Number.isFinite(+a.y) ? [+a.x, +a.y] : null;
            await ed.addImageLayers([await fileFrom(a)], role, at ? { place: "at", at, blank: true } : { place: role === "reference" ? "cascade" : "fit", blank: true });
            const layer = ed.layers.find((l) => !before.has(l.id));
            if (!layer) throw new Error(ed.status || "the layer was not added");
            if (a.name) layer.name = String(a.name);
            if (at) { layer.x = Math.round(at[0]); layer.y = Math.round(at[1]); }
            if (Number.isFinite(+a.width) && Number.isFinite(+a.height) && +a.width > 0 && +a.height > 0) { layer.w = Math.round(+a.width); layer.h = Math.round(+a.height); }
            else if (Number.isFinite(+a.width) && +a.width > 0) { const k = +a.width / layer.w; layer.w = Math.round(+a.width); layer.h = Math.max(1, Math.round(layer.h * k)); }
            touch(ed);
            return layerSummary(ed, layer);
        },
    },
};
