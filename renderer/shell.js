// The shell around the editor: connection bar, recipe picker, progress, tabs (one editor
// per document), the settings dialog (ComfyUI connection with auth, API provider keys,
// recipes, local files) and the menu commands.
import { host, api } from "./editor/host.js";
import { InpaintEditor } from "./editor/inpaint_canvas.js";
import { glFiltersAvailable } from "./editor/inpaint_filters_gl.js";
import { commands } from "./commands.js";
import * as plugins from "./plugins.js";

const $ = (id) => document.getElementById(id);
const ui = {
    recipe: $("shell-recipe"), recipeNote: $("shell-recipe-note"), url: $("shell-url"), connect: $("shell-connect"),
    dot: $("shell-dot"), statusText: $("shell-status-text"), progress: $("shell-progress"), progressBar: $("shell-progress-bar"), progressText: $("shell-progress-text"),
    tabs: $("shell-tab-list"), tabAdd: $("shell-tab-add"),
    settings: $("shell-settings"), setUrl: $("set-url"), setConnect: $("set-connect"), setTest: $("set-test"), setConn: $("set-conn"), setProbe: $("set-probe"),
    authType: $("set-auth-type"), authUser: $("set-auth-user"), authUserRow: $("set-auth-user-row"), authHeader: $("set-auth-header"), authHeaderRow: $("set-auth-header-row"),
    authSecret: $("set-auth-secret"), authSecretRow: $("set-auth-secret-row"), authSecretLabel: $("set-auth-secret-label"),
    providers: $("set-providers"), keysNote: $("set-keys-note"),
    recipes: $("set-recipes"), recipeImport: $("set-recipe-import"), recipeFolder: $("set-recipe-folder"), recipeNoteSet: $("set-recipe-note"),
    plugins: $("set-plugins"), pluginsReload: $("set-plugins-reload"), pluginsFolder: $("set-plugins-folder"), pluginsNote: $("set-plugins-note"),
    setFiles: $("set-files"), setOpenFiles: $("set-open-files"), setPrune: $("set-prune"), setPruneNote: $("set-prune-note"), setGpu: $("set-gpu"), setAbout: $("set-about"), aboutRepo: $("set-about-repo"),
    updateBar: $("shell-update"), updateAuto: $("set-update-auto"), updateCheck: $("set-update-check"), updateInstall: $("set-update-install"), updateNote: $("set-update-note"),
    helpersDevice: $("set-helpers-device"), helpersSam2: $("set-helpers-sam2"), helpersDir: $("set-helpers-dir"), helpersBrowse: $("set-helpers-browse"), helpersDefault: $("set-helpers-default"), helpersOpen: $("set-helpers-open"),
    helpersModels: $("set-helpers-models"), helpersNote: $("set-helpers-note"), hfToken: $("set-hf-token"), hfSave: $("set-hf-save"), hfClear: $("set-hf-clear"), hfState: $("set-hf-state"),
};

let settings = await window.scumble.settings.get();
let lastStatus = { state: "disconnected", message: "not connected" };
let lastProbe = null;
ui.url.value = (settings.comfy && settings.comfy.url) || "http://127.0.0.1:8188";

// ---- documents (tabs) --------------------------------------------------------------------

host.configure({ mount: $("editor-host"), nodeParams: settings.nodeParams });

function newDocument(id) {
    const editor = new InpaintEditor({ id: id || host.nextId++, title: "Scumble" });
    host.addEditor(editor);
    editor.open();
    renderTabs();
    return editor;
}

function activate(editor) {
    host.activate(editor);
    window.editor = editor;   // for tests and the devtools console: always the active one
    renderTabs();
}

function docName(editor) {
    if (!editor.base || !editor.base.ref) return "Untitled";
    return String(editor.base.ref.filename || "image").replace(/\.[a-z0-9]+$/i, "");
}

function busy(editor) {
    return !!(editor.pending || editor.segmentPending || editor.cutoutPending || editor.upsamplePending || editor.objectsPending || editor._loading || editor.providerPending);
}

let tabSignature = "";

/** Cheap poll for the busy marker: a run or helper in a background tab shows a dot. */
setInterval(() => {
    const sig = host.editors().map((ed) => (busy(ed) ? "1" : "0") + docName(ed)).join("|");
    if (sig !== tabSignature) renderTabs();
}, 1000);

function renderTabs() {
    const list = ui.tabs;
    list.innerHTML = "";
    tabSignature = host.editors().map((ed) => (busy(ed) ? "1" : "0") + docName(ed)).join("|");
    for (const ed of host.editors()) {
        const tab = document.createElement("div");
        tab.className = "shell-tab" + (host.isActive(ed) ? " active" : "");
        tab.title = ed.base ? `${docName(ed)} · ${ed.width} × ${ed.height} · ${ed.layers.length} layer${ed.layers.length === 1 ? "" : "s"}` : "Empty document";
        const name = document.createElement("span");
        name.className = "shell-tab-name" + (busy(ed) ? " shell-tab-busy" : "");
        name.textContent = (busy(ed) ? "● " : "") + docName(ed);
        tab.appendChild(name);
        const close = document.createElement("span");
        close.className = "shell-tab-close"; close.textContent = "×"; close.title = "Close tab (Ctrl+W)";
        close.addEventListener("click", (e) => { e.stopPropagation(); closeDocument(ed); });
        tab.appendChild(close);
        tab.addEventListener("click", () => activate(ed));
        tab.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); closeDocument(ed); } });
        list.appendChild(tab);
    }
}

function closeDocument(editor, { force = false } = {}) {
    if (!editor) return;
    if (!force && editor.base && busy(editor) && !window.confirm(`${docName(editor)} is still working. Close it anyway?`)) return;
    if (!force && editor.base && !window.confirm(`Close ${docName(editor)}? The document stays in the local file store, but it leaves the tab bar.`)) return;
    host.removeEditor(editor);
    try { editor.destroy(); } catch (err) { console.warn(err); }
    if (!host.editors().length) newDocument();
    activate(host.editor);
    host.saveAll();
}

function cycleTab(dir) {
    const eds = host.editors();
    if (eds.length < 2) return;
    const i = eds.indexOf(host.editor);
    activate(eds[(i + dir + eds.length) % eds.length]);
}

/** Open a file: into the active tab while it is empty, otherwise into a new one. */
function openInto(file) {
    let ed = host.editor;
    if (!ed || ed.base) { ed = newDocument(); activate(ed); }
    return ed.loadFile(file);
}

host.createDocument = (id) => newDocument(id);
host.onDocsChanged = () => renderTabs();
// the command core (renderer/commands.js) reaches the shell through this
host.shell = { newDocument, activate, closeDocument, selectRecipe: (id, provider) => selectRecipe(id, provider), recipes: () => recipes, resolveRecipe, openSettings };
ui.tabAdd.addEventListener("click", () => activate(newDocument()));

// ---- connection --------------------------------------------------------------------------

function showStatus(st) {
    lastStatus = st;
    ui.dot.className = "dot " + (st.state || "");
    ui.statusText.textContent = st.message || st.state || "";
    ui.statusText.title = [st.url, st.devices, st.auth ? "with auth headers" : ""].filter(Boolean).join("\n");
    ui.setConn.textContent = st.message || st.state || "";
    if (st.state === "connected" || st.state === "missing-node") host.onConnected(st).catch((err) => console.error(err));
}

/** The auth fields of the dialog as the main process wants them; secret only when typed. */
function authFromDialog() {
    const type = ui.authType.value || "none";
    const auth = { type, user: ui.authUser.value.trim(), header: ui.authHeader.value.trim() };
    const conn = { url: ui.setUrl.value.trim(), auth };
    if (type !== "none" && ui.authSecret.value !== "") conn.secret = ui.authSecret.value;
    if (type === "none") conn.secret = "";
    return conn;
}

function syncAuthRows() {
    const t = ui.authType.value;
    ui.authUserRow.hidden = t !== "basic";
    ui.authHeaderRow.hidden = t !== "header";
    ui.authSecretRow.hidden = t === "none";
    ui.authSecretLabel.textContent = t === "basic" ? "Password" : t === "bearer" ? "Token" : "Value";
}
ui.authType.addEventListener("change", syncAuthRows);

/** Connect: from the top bar (URL only, stored auth) or from the dialog (URL + auth). */
async function connect(conn) {
    if (!conn) conn = ui.url.value.trim();
    const url = typeof conn === "string" ? conn : conn.url;
    ui.url.value = url; ui.setUrl.value = url;
    const st = await window.scumble.comfy.connect(conn);
    settings = await window.scumble.settings.get();
    if (typeof conn === "object") ui.authSecret.value = "";
    showStatus(st);
}

ui.connect.addEventListener("click", () => connect());
ui.url.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); connect(); } });
window.scumble.comfy.onStatus(showStatus);

function fmtGb(b) { return (b / 1024 ** 3).toFixed(1) + " GB"; }

/** The Test button: probe without connecting, then compare the recipe's model files with the server's lists. */
async function testConnection() {
    ui.setTest.disabled = true;
    ui.setProbe.hidden = false;
    ui.setProbe.textContent = "probing " + ui.setUrl.value.trim() + " ...";
    try {
        const p = await window.scumble.comfy.probe(authFromDialog());
        lastProbe = p;
        const lines = [];
        const line = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };
        lines.push(line("ok", `ComfyUI ${p.version} reached in ${p.latency} ms` + (p.os ? ` (${p.os}, Python ${p.python})` : "")));
        for (const d of p.devices) lines.push(line("", `  ${d.name}` + (d.vramTotal ? `, VRAM ${fmtGb(d.vramFree)} free of ${fmtGb(d.vramTotal)}` : "")));
        if (p.queue) lines.push(line("", `  queue: ${p.queue.running} running, ${p.queue.pending} pending`));
        lines.push(line(p.node ? "ok" : "bad", p.node ? `Inpaint Canvas node pack ${p.nodeVersion || "present"}` : "Inpaint Canvas node pack missing: install ComfyUI-InpaintCanvas there (Manager or git clone)"));
        for (const r of recipes.filter((x) => x.kind !== "provider")) {
            const report = recipeModelReport(r, p);
            if (report) lines.push(line(report.missing.length ? "bad" : "ok", `${r.name || r.id}: ${report.text}`));
        }
        ui.setProbe.replaceChildren(...lines.flatMap((l, i) => (i ? ["\n", l] : [l])));
    } catch (err) {
        ui.setProbe.replaceChildren(Object.assign(document.createElement("span"), { className: "bad", textContent: String(err.message || err) }));
    } finally {
        ui.setTest.disabled = false;
    }
}

/** Which of the recipe's loader settings name a file the probed server lists. */
function recipeModelReport(recipe, probe) {
    if (!recipe.prompt || !probe.models) return null;
    const checks = [];
    for (const s of recipe.settings || []) {
        const node = recipe.prompt[s.node];
        if (!node) continue;
        const list = probe.models[`${node.class_type}.${s.input}`];
        if (!list) continue;
        const want = node.inputs && node.inputs[s.input];
        if (typeof want !== "string") continue;
        checks.push({ label: s.label || s.input, want, ok: list.includes(want), list });
    }
    if (!checks.length) return null;
    const missing = checks.filter((c) => !c.ok);
    const text = missing.length
        ? `${checks.length - missing.length} of ${checks.length} model files found; missing: ${missing.map((c) => `${c.label} "${c.want}"`).join(", ")} (pick another in the Settings panel)`
        : `all ${checks.length} model files present`;
    return { checks, missing, text };
}

ui.setTest.addEventListener("click", () => testConnection());
ui.setConnect.addEventListener("click", () => connect(authFromDialog()));
ui.setUrl.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); connect(authFromDialog()); } });

// ---- recipes ---------------------------------------------------------------------------

let recipes = [];
let providers = [];

const FAMILY_ORDER = ["ComfyUI", "Google", "OpenAI", "Black Forest Labs", "ByteDance", "Qwen", "LetzAI"];
const familyOf = (r) => (r.kind === "provider" ? (r.family || "API providers") : "ComfyUI");

async function loadRecipes() {
    recipes = await window.scumble.recipes.list();
    // ComfyUI first, then the model families in a fixed order, unknown families after, names within
    const rank = (r) => { const i = FAMILY_ORDER.indexOf(familyOf(r)); return i < 0 ? FAMILY_ORDER.length : i; };
    recipes.sort((a, b) => rank(a) - rank(b) || familyOf(a).localeCompare(familyOf(b)) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
    ui.recipe.innerHTML = "";
    // ComfyUI recipes first, then the model recipes grouped by family (Google, OpenAI, ...)
    const families = ["ComfyUI"];
    for (const r of recipes) { const f = familyOf(r); if (!families.includes(f)) families.push(f); }
    for (const label of families) {
        const items = recipes.filter((r) => familyOf(r) === label);
        if (!items.length) continue;
        const g = document.createElement("optgroup");
        g.label = label;
        for (const r of items) {
            const o = document.createElement("option");
            o.value = r.id; o.textContent = (r.name || r.id) + (r.source === "user" ? " (imported)" : "");
            g.appendChild(o);
        }
        ui.recipe.appendChild(g);
    }
}

function providerLabel(id) {
    const p = providers.find((x) => x.id === id);
    return (p && p.label) || (id === "loopback" ? "Loopback" : id);
}

/** The provider a model recipe runs on: the remembered choice, else the recipe's default. */
function chosenProvider(r) {
    if (r.kind !== "provider" || !r.providers) return null;
    const want = (settings.recipeProviders || {})[r.id];
    return want && r.providers[want] ? want : (r.default || Object.keys(r.providers)[0]);
}

/** The recipe with the chosen provider's variant merged in (what host and the commands see). */
function resolveRecipe(r) {
    const pid = chosenProvider(r);
    if (!pid) return r;
    const v = r.providers[pid] || {};
    return { ...r, provider: pid, providerLabel: providerLabel(pid), model: v.model || "", input: v.input || "fill", fields: v.fields || null, fixed: v.fixed || null, settings: v.settings || [], options: v.options || null, note: v.note || "" };
}

function providerKeyState(r) {
    if (r.kind !== "provider") return null;
    const p = providers.find((x) => x.id === r.provider);
    if (!p) return r.provider === "loopback" ? { ok: true } : { ok: false, text: `unknown provider "${r.provider}"` };
    return p.key && p.key.set ? { ok: true } : { ok: false, text: `no ${p.label} key yet: Settings (Ctrl+,) › API providers` };
}

async function rememberProvider(recipeId, providerId) {
    const map = { ...(settings.recipeProviders || {}), [recipeId]: providerId };
    settings = await window.scumble.settings.set({ recipeProviders: map });
}

function selectRecipe(id, providerId) {
    const raw = recipes.find((x) => x.id === id) || recipes[0];
    if (!raw) { ui.recipeNote.textContent = "no recipes found"; return; }
    if (providerId && raw.providers && raw.providers[providerId]) {
        settings.recipeProviders = { ...(settings.recipeProviders || {}), [raw.id]: providerId };
        rememberProvider(raw.id, providerId);
    }
    const r = resolveRecipe(raw);
    ui.recipe.value = r.id;
    const ks = providerKeyState(r);
    const via = r.kind === "provider" ? ` (via ${r.providerLabel}${r.model ? ", " + r.model : ""})` : "";
    ui.recipeNote.textContent = ks && !ks.ok ? ks.text : (r.description || "") + via;
    ui.recipeNote.title = [r.description, r.note].filter(Boolean).join("\n") + via;
    ui.recipeNote.style.color = ks && !ks.ok ? "#e0a05a" : "";
    host.setRecipe(r);
    if (settings.recipe !== r.id) window.scumble.settings.set({ recipe: r.id }).then((s) => { settings = s; });
    if (ui.settings.open) syncRecipeRows();
}
ui.recipe.addEventListener("change", () => selectRecipe(ui.recipe.value));

/** Update the meta text and the provider selects of the recipe rows without rebuilding them. */
function syncRecipeRows() {
    for (const row of ui.recipes.querySelectorAll(".shell-recipe")) {
        const r = recipes.find((x) => x.id === row.dataset.id);
        if (!r) continue;
        row.classList.toggle("active", host.recipe && host.recipe.id === r.id);
        const sel = row.querySelector("select");
        if (sel) sel.value = chosenProvider(r);
        const meta = row.querySelector(".shell-recipe-meta");
        if (meta) meta.textContent = recipeMeta(r);
    }
}

function recipeMeta(r) {
    if (r.kind !== "provider") return `ComfyUI · ${r.mode || "local"} · ${Object.keys(r.prompt || {}).length} nodes`;
    const v = resolveRecipe(r);
    const ks = providerKeyState(v);
    return `${v.model || ""}${ks && !ks.ok ? " · no key" : ""}`;
}

function renderRecipeList() {
    ui.recipes.innerHTML = "";
    for (const r of recipes) {
        const row = document.createElement("div");
        row.className = "shell-recipe";
        row.dataset.id = r.id;
        const name = document.createElement("span");
        name.className = "shell-recipe-name";
        name.textContent = r.name || r.id;
        name.title = r.description || "";
        const meta = document.createElement("span");
        meta.className = "shell-recipe-meta";
        meta.textContent = recipeMeta(r);
        name.appendChild(meta);
        row.appendChild(name);
        if (r.kind === "provider" && r.providerIds && r.providerIds.length) {
            // which provider runs this model; the key state shows in the option label
            const sel = document.createElement("select");
            sel.title = "Provider this model runs on";
            for (const pid of r.providerIds) {
                const o = document.createElement("option");
                const p = providers.find((x) => x.id === pid);
                o.value = pid; o.textContent = providerLabel(pid) + (p && !(p.key && p.key.set) ? " (no key)" : "");
                sel.appendChild(o);
            }
            sel.value = chosenProvider(r);
            sel.addEventListener("change", async () => {
                await rememberProvider(r.id, sel.value);
                if (host.recipe && host.recipe.id === r.id) selectRecipe(r.id); else syncRecipeRows();
            });
            row.appendChild(sel);
        } else {
            row.appendChild(document.createElement("span"));
        }
        const use = document.createElement("button");
        use.type = "button"; use.textContent = "Use";
        use.addEventListener("click", () => selectRecipe(r.id));
        row.appendChild(use);
        const del = document.createElement("button");
        del.type = "button"; del.textContent = "Remove"; del.disabled = r.source !== "user"; del.title = r.source === "user" ? "Delete this imported recipe" : "Shipped recipe";
        del.addEventListener("click", async () => {
            if (!window.confirm(`Remove the recipe "${r.name || r.id}"?`)) return;
            try { await window.scumble.recipes.remove(r.id); await loadRecipes(); renderRecipeList(); selectRecipe(settings.recipe); } catch (err) { ui.recipeNoteSet.textContent = String(err.message || err); }
        });
        row.appendChild(del);
        ui.recipes.appendChild(row);
    }
    syncRecipeRows();
}

async function importRecipe(file) {
    ui.recipeNoteSet.textContent = "";
    try {
        const r = await window.scumble.recipes.import(file || undefined);
        if (!r) return null;
        await loadRecipes();
        renderRecipeList();
        selectRecipe(r.id);
        ui.recipeNoteSet.textContent = `Imported "${r.name}" (${r.mode}, ${Object.keys(r.prompt || {}).length} nodes, ${(r.settings || []).length} settings)` + (r.notes && r.notes.length ? ": " + r.notes.join("; ") : ".");
        return r;
    } catch (err) {
        ui.recipeNoteSet.textContent = String(err.message || err);
        return null;
    }
}
ui.recipeImport.addEventListener("click", () => importRecipe());
ui.recipeFolder.addEventListener("click", () => window.scumble.recipes.openFolder());

// ---- providers (keys) ----------------------------------------------------------------

async function loadProviders() {
    providers = await window.scumble.providers.list();
}

async function renderProviders() {
    const info = await window.scumble.keys.list();
    ui.providers.innerHTML = "";
    for (const p of providers) {
        const row = document.createElement("div");
        row.className = "shell-provider";
        const label = document.createElement("span");
        label.textContent = p.label;
        row.appendChild(label);
        const input = document.createElement("input");
        input.type = "password"; input.placeholder = p.keyHint || "API key"; input.autocomplete = "off"; input.spellcheck = false;
        input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); save.click(); } });
        row.appendChild(input);
        const save = document.createElement("button");
        save.type = "button"; save.textContent = "Save";
        save.addEventListener("click", async () => {
            try { await window.scumble.keys.set(p.id, input.value); input.value = ""; await loadProviders(); await renderProviders(); selectRecipe(ui.recipe.value); } catch (err) { state.textContent = String(err.message || err); }
        });
        row.appendChild(save);
        const clear = document.createElement("button");
        clear.type = "button"; clear.textContent = "Clear";
        clear.addEventListener("click", async () => { await window.scumble.keys.clear(p.id); await loadProviders(); await renderProviders(); selectRecipe(ui.recipe.value); });
        row.appendChild(clear);
        const state = document.createElement("span");
        const k = p.key || {};
        state.className = "shell-key-state" + (k.set ? " set" : "");
        clear.disabled = !k.set;
        state.textContent = k.set ? `key set (…${k.hint})` : "no key";
        if (p.keyUrl) {
            state.append(" · ");
            const a = document.createElement("a");
            a.href = "#"; a.textContent = "get a key"; a.addEventListener("click", (e) => { e.preventDefault(); window.scumble.openExternal(p.keyUrl); });
            state.appendChild(a);
        }
        row.appendChild(state);
        ui.providers.appendChild(row);
    }
    ui.keysNote.textContent = info.available
        ? `Keys are encrypted with the system credential store (${info.backend}) and stored in secrets.json; they never leave this machine except in the request to the provider itself.`
        : "This system offers no credential store (safeStorage unavailable): keys cannot be saved.";
}

// ---- helpers (in-app models) ---------------------------------------------------------------

const downloadErrors = {};   // model id -> last error text

function renderHelpers(status) {
    const st = status || host.helpers || { models: [] };
    ui.helpersDevice.value = st.device || "auto";
    const sam2s = (st.models || []).filter((m) => m.kind === "sam2");
    ui.helpersSam2.innerHTML = "";
    for (const m of sam2s) {
        const o = document.createElement("option");
        o.value = m.id; o.textContent = m.label + (m.present ? "" : " (not downloaded)");
        ui.helpersSam2.appendChild(o);
    }
    ui.helpersSam2.value = st.sam2 || (sam2s[0] && sam2s[0].id) || "";
    ui.helpersDir.textContent = (st.dir || "") + (st.isComfyDir ? " (ComfyUI models folder, downloads go to onnx/)" : st.isDefaultDir ? " (app folder)" : "");
    ui.helpersDir.title = st.downloadDir || "";
    ui.helpersDefault.disabled = !!st.isDefaultDir;
    ui.helpersModels.innerHTML = "";
    for (const m of st.models || []) {
        const row = document.createElement("div");
        row.className = "shell-model";
        const name = document.createElement("span");
        name.textContent = m.label;
        name.title = `${m.kind === "sam2" ? "objects (SAM2)" : "background removal"} · ${m.source} · ${m.license}`;
        row.appendChild(name);
        const info = document.createElement("span");
        info.className = "shell-model-info";
        const dl = st.downloads && st.downloads[m.id];
        const err = downloadErrors[m.id];
        if (dl) {
            info.textContent = `downloading ${dl.file} · ${fmtBytes(dl.received)} of ${fmtBytes(dl.total || m.size)}`;
        } else if (err) {
            info.textContent = err; info.classList.add("error");
        } else if (m.present) {
            info.textContent = `${fmtBytes(m.bytes)} · ${m.license}${m.note ? " · " + m.note : ""}`; info.classList.add("present");
        } else {
            const part = m.files.reduce((a, f) => a + (f.partial || 0), 0);
            info.textContent = `${fmtBytes(m.size)} download · ${m.license}${m.note ? " · " + m.note : ""}${part ? ` · ${fmtBytes(part)} partial, resumes` : ""}`;
        }
        row.appendChild(info);
        const btn = document.createElement("button");
        btn.type = "button";
        if (dl) {
            btn.textContent = "Cancel";
            btn.addEventListener("click", () => window.scumble.helpers.cancel(m.id));
        } else if (m.present) {
            btn.textContent = "Remove";
            btn.addEventListener("click", async () => {
                if (!window.confirm(`Delete the files of ${m.label} (${fmtBytes(m.bytes)})?`)) return;
                try { renderHelpers(await window.scumble.helpers.remove(m.id)); } catch (e) { downloadErrors[m.id] = String(e.message || e); renderHelpers(); }
                host.refreshHelpers();
            });
        } else {
            btn.textContent = "Download";
            btn.addEventListener("click", async () => {
                delete downloadErrors[m.id];
                btn.disabled = true;
                try {
                    renderHelpers(await window.scumble.helpers.status());
                    const r = await window.scumble.helpers.download(m.id);
                    if (r) renderHelpers(r);
                } catch (e) {
                    downloadErrors[m.id] = String(e.message || e);
                }
                renderHelpers(await host.refreshHelpers());
            });
        }
        row.appendChild(btn);
        if (dl) {
            const bar = document.createElement("div");
            bar.className = "shell-model-bar";
            const fill = document.createElement("div");
            fill.style.width = Math.round(100 * dl.received / (dl.total || m.size || 1)) + "%";
            bar.appendChild(fill);
            row.appendChild(bar);
        }
        ui.helpersModels.appendChild(row);
    }
    const hf = st.hfToken || {};
    ui.hfState.textContent = hf.set ? `token set (…${hf.hint})` : "no token";
    ui.hfState.classList.toggle("set", !!hf.set);
    ui.hfClear.disabled = !hf.set;
    const rt = st.runtime || {};
    const active = Object.values(rt.active || {});
    const used = active.length ? Array.from(new Set(active)).map((p) => (rt.labels || {})[p] || p).join(", ") : null;
    const fails = Object.entries(rt.failures || {}).map(([p, e]) => `${(rt.labels || {})[p] || p}: ${e}`).join("; ");
    ui.helpersNote.textContent = `ONNX Runtime ${rt.version || "?"} · will try ${(rt.candidates || []).map((p) => (rt.labels || {})[p] || p).join(", then ")}` + (used ? ` · loaded on ${used} (${rt.loaded} session${rt.loaded === 1 ? "" : "s"})` : " · nothing loaded yet") + (fails ? ` · failed: ${fails}` : "");
}

ui.helpersDevice.addEventListener("change", async () => renderHelpers(await window.scumble.helpers.configure({ device: ui.helpersDevice.value })));
ui.helpersSam2.addEventListener("change", async () => { renderHelpers(await window.scumble.helpers.configure({ sam2: ui.helpersSam2.value })); host.refreshHelpers(); });
ui.helpersBrowse.addEventListener("click", async () => { const r = await window.scumble.helpers.browseDir(); if (r) { renderHelpers(r); host.refreshHelpers(); } });
ui.helpersDefault.addEventListener("click", async () => { renderHelpers(await window.scumble.helpers.configure({ dir: null })); host.refreshHelpers(); });
ui.helpersOpen.addEventListener("click", () => window.scumble.helpers.openFolder());
ui.hfToken.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); ui.hfSave.click(); } });
ui.hfSave.addEventListener("click", async () => {
    try { await window.scumble.keys.set("hf-token", ui.hfToken.value); ui.hfToken.value = ""; renderHelpers(await window.scumble.helpers.status()); } catch (e) { ui.hfState.textContent = String(e.message || e); }
});
ui.hfClear.addEventListener("click", async () => { await window.scumble.keys.clear("hf-token"); renderHelpers(await window.scumble.helpers.status()); });

let helpersRenderTimer = null;
window.scumble.helpers.onProgress((ev) => {
    if (ev.error) downloadErrors[ev.id] = ev.error;
    if (!ui.settings.open) return;
    clearTimeout(helpersRenderTimer);
    helpersRenderTimer = setTimeout(async () => { try { renderHelpers(await window.scumble.helpers.status()); } catch (_) { /* closing */ } }, ev.done || ev.error ? 0 : 250);
});
host.onHelpersChanged = (st) => { if (ui.settings.open) renderHelpers(st); };

// ---- plugins (Settings › Plugins) -------------------------------------------------------------

function renderPlugins() {
    const list = plugins.listPlugins();
    ui.plugins.innerHTML = "";
    if (!list.length) ui.plugins.appendChild(Object.assign(document.createElement("p"), { className: "shell-help", textContent: "No plugins found." }));
    for (const p of list) {
        const row = document.createElement("div");
        row.className = "shell-plugin";
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = p.enabled; cb.title = p.enabled ? "Disable this plugin" : "Enable this plugin";
        cb.addEventListener("change", async () => {
            cb.disabled = true;
            try { await plugins.setEnabled(p.id, cb.checked); } catch (err) { ui.pluginsNote.textContent = String(err.message || err); }
            renderPlugins();
        });
        row.appendChild(cb);
        const body = document.createElement("div");
        const name = document.createElement("div");
        name.className = "shell-plugin-name";
        name.textContent = p.name;
        const small = document.createElement("small");
        small.textContent = [p.version, p.author, p.source === "builtin" ? "built-in" : "user folder"].filter(Boolean).join(" · ");
        name.appendChild(small);
        body.appendChild(name);
        if (p.description) body.appendChild(Object.assign(document.createElement("div"), { className: "shell-plugin-desc", textContent: p.description }));
        const r = p.registered;
        const regs = [];
        if (r.filters.length) regs.push(`${r.filters.length} filter${r.filters.length > 1 ? "s" : ""}`);
        if (r.panels.length) regs.push(`${r.panels.length} panel${r.panels.length > 1 ? "s" : ""}`);
        if (r.actions.length) regs.push(`${r.actions.length} action${r.actions.length > 1 ? "s" : ""}`);
        if (r.tools.length) regs.push(`${r.tools.length} tool${r.tools.length > 1 ? "s" : ""}`);
        if (r.commands.length) regs.push(`${r.commands.length} command${r.commands.length > 1 ? "s" : ""}`);
        if (p.loaded) body.appendChild(Object.assign(document.createElement("div"), { className: "shell-plugin-regs", textContent: regs.length ? "registers " + regs.join(", ") : "registers nothing", title: [...r.filters, ...r.panels, ...r.actions.map((a) => a.id), ...r.tools, ...r.commands].join("\n") }));
        if (p.error) body.appendChild(Object.assign(document.createElement("div"), { className: "shell-plugin-error", textContent: p.error.split("\n").slice(0, 3).join("\n") }));
        else if (p.errors.length) body.appendChild(Object.assign(document.createElement("div"), { className: "shell-plugin-error", textContent: "last errors: " + p.errors.slice(-3).join(" · ") }));
        row.appendChild(body);
        const state = document.createElement("span");
        state.className = "shell-plugin-state" + (p.error ? " bad" : p.loaded ? "" : " off");
        state.textContent = p.error ? "error" : p.loaded ? "loaded" : p.enabled ? "not loaded" : "disabled";
        state.title = p.dir || "";
        row.appendChild(state);
        ui.plugins.appendChild(row);
    }
}

plugins.setOnChanged(() => { if (ui.settings.open) renderPlugins(); window.scumble.commands.changed(); });
ui.pluginsReload.addEventListener("click", async () => {
    ui.pluginsReload.disabled = true;
    ui.pluginsNote.textContent = "reloading ...";
    try { const list = await plugins.reloadPlugins(); ui.pluginsNote.textContent = `${list.filter((p) => p.loaded).length} of ${list.length} loaded.`; }
    catch (err) { ui.pluginsNote.textContent = String(err.message || err); }
    finally { ui.pluginsReload.disabled = false; renderPlugins(); }
});
ui.pluginsFolder.addEventListener("click", () => window.scumble.plugins.openFolder());

// ---- progress ----------------------------------------------------------------------------

api.addEventListener("progress", ({ detail }) => {
    if (!detail || !detail.max) return;
    ui.progress.hidden = false;
    ui.progress.classList.remove("indeterminate");
    const pct = Math.round((detail.value / detail.max) * 100);
    ui.progressBar.style.width = pct + "%";
    ui.progressText.textContent = `${detail.value} / ${detail.max}`;
    if (detail.value >= detail.max) setTimeout(() => { if (!host._providerRuns.size) ui.progress.hidden = true; }, 800);
});
api.addEventListener("execution_error", () => { if (!host._providerRuns.size) ui.progress.hidden = true; });
api.addEventListener("execution_interrupted", () => { if (!host._providerRuns.size) ui.progress.hidden = true; });
api.addEventListener("executed", () => setTimeout(renderTabs, 50));

let providerTimer = null;
host.onProviderRuns = (runs) => {
    clearInterval(providerTimer); providerTimer = null;
    if (!runs.length) { ui.progress.hidden = true; ui.progress.classList.remove("indeterminate"); ui.progressBar.style.left = ""; renderTabs(); return; }
    ui.progress.hidden = false;
    ui.progress.classList.add("indeterminate");
    const tick = () => {
        const r = runs[0];
        ui.progressText.textContent = `${r.label || r.provider} · ${Math.round((Date.now() - r.started) / 1000)} s${runs.length > 1 ? ` (+${runs.length - 1})` : ""}`;
    };
    tick();
    providerTimer = setInterval(tick, 1000);
    renderTabs();
};

// ---- settings dialog ---------------------------------------------------------------------

function fmtBytes(b) {
    return b >= 1024 * 1024 * 1024 ? (b / 1024 ** 3).toFixed(2) + " GB" : b >= 1024 * 1024 ? (b / 1024 ** 2).toFixed(1) + " MB" : Math.round(b / 1024) + " kB";
}

async function refreshFileStats() {
    try {
        const s = await window.scumble.files.stats();
        ui.setFiles.textContent = `${s.root}: ${s.files} file${s.files === 1 ? "" : "s"}, ${fmtBytes(s.bytes)}.`;
    } catch (err) { ui.setFiles.textContent = String(err.message || err); }
}

async function openSettings() {
    settings = await window.scumble.settings.get();
    ui.setUrl.value = (settings.comfy && settings.comfy.url) || ui.url.value;
    const auth = (settings.comfy && settings.comfy.auth) || { type: "none" };
    ui.authType.value = auth.type || "none";
    ui.authUser.value = auth.user || "";
    ui.authHeader.value = auth.header || "";
    ui.authSecret.value = "";
    syncAuthRows();
    ui.setConn.textContent = lastStatus.message || lastStatus.state || "";
    ui.setProbe.hidden = true;
    ui.setPruneNote.textContent = "";
    ui.recipeNoteSet.textContent = "";
    ui.setGpu.textContent = glFiltersAvailable() ? "Filter layers run on the GPU (WebGL2); the CPU code is the fallback." : "WebGL2 is not available here: filter layers run on the CPU.";
    try {
        const info = await window.scumble.info();
        ui.setAbout.textContent = `Scumble ${info.version} · Electron ${info.electron} · ${info.platform} · data in ${info.userData}. Film names are trademarks of their owners; the looks are Scumble's own approximations, not licensed products.`;
    } catch (_) { /* ignore */ }
    ui.updateAuto.checked = !(settings.updates && settings.updates.check === false);
    try { renderUpdate(await window.scumble.updates.status()); } catch (_) { /* ignore */ }
    refreshFileStats();
    await loadProviders();
    await renderProviders();
    renderRecipeList();
    try { renderHelpers(await window.scumble.helpers.status()); } catch (err) { ui.helpersNote.textContent = String(err.message || err); }
    try { await plugins.fetchList(); } catch (_) { /* ignore */ }
    ui.pluginsNote.textContent = "";
    renderPlugins();
    if (!ui.settings.open) ui.settings.showModal();
}

ui.setOpenFiles.addEventListener("click", () => window.scumble.files.openFolder());
ui.setPrune.addEventListener("click", async () => {
    ui.setPrune.disabled = true;
    try {
        const keep = host.referencedFileKeys();
        const dry = await window.scumble.files.prune({ keep, dryRun: true });
        if (!dry.files) { ui.setPruneNote.textContent = "Nothing to remove."; return; }
        if (!window.confirm(`Remove ${dry.files} file${dry.files === 1 ? "" : "s"} (${fmtBytes(dry.bytes)}) that no open document references?`)) { ui.setPruneNote.textContent = "Kept."; return; }
        const r = await window.scumble.files.prune({ keep, dryRun: false });
        ui.setPruneNote.textContent = `Removed ${r.deleted.length} file${r.deleted.length === 1 ? "" : "s"}, ${fmtBytes(r.bytes)}.`;
        refreshFileStats();
    } catch (err) {
        ui.setPruneNote.textContent = String(err.message || err);
    } finally {
        ui.setPrune.disabled = false;
    }
});
// ---- updates (electron/main/updater.js) ---------------------------------------------------

function updateText(s) {
    if (!s) return "";
    if (s.state === "dev") return "Not packaged: updates are checked in the installed app only.";
    if (s.state === "checking") return "Checking for updates ...";
    if (s.state === "latest") return s.manual ? `Scumble ${s.current} is up to date.` : "";
    if (s.state === "downloading") return `Downloading Scumble ${s.version} ... ${s.percent == null ? "" : s.percent + "%"}`;
    if (s.state === "downloaded") return `Scumble ${s.version} is downloaded; restart to install it.`;
    if (s.state === "error") return `Update check failed: ${s.error}`;
    return "";
}

function renderUpdate(s) {
    ui.updateNote.textContent = updateText(s);
    ui.updateInstall.hidden = !(s && s.state === "downloaded");
    ui.updateCheck.disabled = !!(s && (s.state === "checking" || s.state === "downloading"));
    ui.updateBar.hidden = !(s && s.state === "downloaded");
    if (s && s.state === "downloaded") ui.updateBar.textContent = `Update to ${s.version}`;
}
window.scumble.updates.onStatus(renderUpdate);
ui.updateCheck.addEventListener("click", async () => { renderUpdate(await window.scumble.updates.check()); });
ui.updateInstall.addEventListener("click", () => window.scumble.updates.install());
ui.updateBar.addEventListener("click", () => window.scumble.updates.install());
ui.updateAuto.addEventListener("change", async () => { settings = await window.scumble.settings.set({ updates: { ...(settings.updates || {}), check: ui.updateAuto.checked } }); });
ui.aboutRepo.addEventListener("click", (e) => { e.preventDefault(); window.scumble.openExternal("https://github.com/DenRakEiw/scumble"); });

// keys typed into the dialog must not reach the editor's window-level shortcut handler
ui.settings.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });

// ---- menu and files ----------------------------------------------------------------------

window.scumble.file.onOpened(({ name, data }) => {
    const type = /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.webp$/i.test(name) ? "image/webp" : "image/png";
    openInto(new File([data], name, { type }));
});
window.scumble.onMenu((cmd) => {
    if (cmd === "save") host.editor && host.editor.exportImage();
    else if (cmd === "settings") openSettings();
    else if (cmd === "guide") window.scumble.openExternal("https://github.com/DenRakEiw/ComfyUI-InpaintCanvas#readme");
    else if (cmd === "new-tab") activate(newDocument());
    else if (cmd === "close-tab") closeDocument(host.editor);
    else if (cmd === "next-tab") cycleTab(1);
    else if (cmd === "prev-tab") cycleTab(-1);
    else if (cmd === "import-recipe") importRecipe();
    else if (cmd === "reload-plugins") plugins.reloadPlugins().then((list) => { if (host.editor) host.editor.setStatus(`Plugins reloaded: ${list.filter((p) => p.loaded).length} of ${list.length} loaded.`); });
    else if (cmd === "settings-updates") openSettings().then(() => { const h = Array.from(ui.settings.querySelectorAll("h3")).find((x) => x.textContent === "Updates"); if (h) h.scrollIntoView(); });
    else if (cmd === "settings-plugins") openSettings().then(() => { const h = Array.from(ui.settings.querySelectorAll("h3")).find((x) => x.textContent === "Plugins"); if (h) h.scrollIntoView(); });
    else if (cmd.startsWith("plugin:")) plugins.runAction(cmd.slice(7)).catch(() => { /* reported by the plugin host */ });
});

// ---- the command bridge: main (MCP server, --cmd, the local socket) runs commands here -----

window.scumble.commands.onRequest(async ({ id, name, args }) => {
    const r = await commands.call(name, args || {});
    let payload;
    try { payload = JSON.parse(JSON.stringify({ id, ...r })); }   // results are JSON by contract; anything else is an error, not a crash
    catch (err) { payload = { id, ok: false, error: "the result is not JSON: " + (err.message || err) }; }
    window.scumble.commands.reply(payload);
});

// ---- start: plugins, restore the last session, then connect -------------------------------

try {
    await plugins.loadPlugins();
} catch (err) {
    console.warn("plugins", err);
}
try {
    const saved = await window.scumble.state.load();
    if (saved) await host.restore(saved);
} catch (err) {
    console.warn("no autosaved state", err);
}
if (!host.editors().length) newDocument();
activate(host.editor);
await loadProviders();
await loadRecipes();
await host.refreshHelpers();
selectRecipe(settings.recipe);
showStatus(await window.scumble.comfy.status());
window.scumble.commands.ready();

export { newDocument, activate, closeDocument, openSettings, selectRecipe, loadRecipes, importRecipe, testConnection, connect, commands, plugins };
