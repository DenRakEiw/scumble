// The shell around the editor: connection bar, recipe picker, progress, tabs (one editor
// per document), the settings dialog (ComfyUI connection with auth, API provider keys,
// recipes, local files) and the menu commands.
import { host, api } from "./editor/host.js";
import { InpaintEditor } from "./editor/inpaint_canvas.js";
import { glFiltersAvailable } from "./editor/inpaint_filters_gl.js";
import { setPixelsOptions } from "./editor/inpaint_pixels.js";
import { commands, docSummary } from "./commands.js";
import * as plugins from "./plugins.js";
import { waitForUser, editorOf } from "./assistant_wait.js";
import { beforeCall as snapshotTurn, watchUserEdits, forgetDocument } from "./assistant_turns.js";
import { initAssistant, toggleAssistant, resetAssistant, refreshAssistantModels } from "./assistant.js";

const $ = (id) => document.getElementById(id);

// the editor's pixel access (docs/PLAN_BCE.md C1, electron/main/main.js): a dev build is strict, so the
// old layer.canvas / layer.mask / editor.selection names throw instead of warning (SCUMBLE_STRICT=0 turns
// it off; a packaged build and the ComfyUI node warn once); --pixels-copy makes toCanvas() hand out
// copies, the gates' check that nothing writes into one; `tiles` is the backend every editor of this window
// takes (docs/PLAN_BCE.md §C2 step b, §C7: --tiles / --no-tiles, SCUMBLE_TILES, settings.tiles, else on)
if (window.scumble && window.scumble.pixels) {
    const p = window.scumble.pixels;
    setPixelsOptions({ strict: !!p.strict, copy: !!p.copy, ...(typeof p.tiles === "boolean" ? { tiles: p.tiles, tilesFrom: p.tilesFrom || null } : {}) });
}

// ---- log capture: the renderer's console.warn / error and its uncaught errors go to the
// main process's log (electron/main/log.js); the originals still print for DevTools ----
(() => {
    const send = (level, message, detail) => { try { window.scumble.log.add({ level, source: "renderer", message, detail }); } catch (_) { /* preload missing */ } };
    const text = (a) => a.map((x) => (x instanceof Error ? (x.stack || x.message) : (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch (_) { return String(x); } })()))).join(" ");
    for (const [name, level] of [["warn", "warn"], ["error", "error"]]) {
        const orig = console[name].bind(console);
        console[name] = (...a) => { send(level, text(a)); orig(...a); };
    }
    window.addEventListener("error", (e) => send("error", "uncaught: " + (e.message || e), e.error && e.error.stack));
    window.addEventListener("unhandledrejection", (e) => send("error", "unhandled: " + ((e.reason && (e.reason.message || e.reason)) || e), e.reason && e.reason.stack));
})();

// docs/PLAN_BCE.md §E1: the scheme's COOP / COEP headers make the window cross-origin isolated, which the tile arena's
// SharedArrayBuffer needs; without it the worker pool copies tiles, which works but costs the copies
try { window.scumble.log.add({ level: crossOriginIsolated ? "info" : "warn", source: "renderer", message: `cross-origin isolated: ${crossOriginIsolated}` }); } catch (_) { /* preload missing */ }

const ui = {
    recipe: $("shell-recipe"), recipeNote: $("shell-recipe-note"), url: $("shell-url"), connect: $("shell-connect"),
    dot: $("shell-dot"), statusText: $("shell-status-text"), progress: $("shell-progress"), progressBar: $("shell-progress-bar"), progressText: $("shell-progress-text"),
    tabs: $("shell-tab-list"), tabAdd: $("shell-tab-add"),
    settings: $("shell-settings"), setUrl: $("set-url"), setConnect: $("set-connect"), setTest: $("set-test"), setConn: $("set-conn"), setProbe: $("set-probe"),
    authType: $("set-auth-type"), authUser: $("set-auth-user"), authUserRow: $("set-auth-user-row"), authHeader: $("set-auth-header"), authHeaderRow: $("set-auth-header-row"),
    authSecret: $("set-auth-secret"), authSecretRow: $("set-auth-secret-row"), authSecretLabel: $("set-auth-secret-label"),
    providers: $("set-providers"), keysNote: $("set-keys-note"),
    gen: $("gen-dialog"), genMode: $("gen-mode"), genRecipe: $("gen-recipe"), genProvider: $("gen-provider"),
    genProviderRow: $("gen-provider-row"), genNote: $("gen-note"), genPrompt: $("gen-prompt"),
    genUpsample: $("gen-upsample"), genUpsampleGo: $("gen-upsample-go"), genUpsampleNote: $("gen-upsample-note"),
    genAspect: $("gen-aspect"), genResolution: $("gen-resolution"), genWidth: $("gen-width"), genHeight: $("gen-height"),
    genSeed: $("gen-seed"), genSeedRandom: $("gen-seed-random"), genSizeNote: $("gen-size-note"),
    genAlpha: $("gen-alpha"), genAlphaRow: $("gen-alpha-row"),
    genState: $("gen-state"), genGo: $("gen-go"), genCancel: $("gen-cancel"),
    genTemplate: $("gen-template"), genTemplateNote: $("gen-template-note"),
    promptList: $("set-prompts"), promptImport: $("set-prompt-import"), promptFolder: $("set-prompt-folder"), promptNote: $("set-prompt-note"),
    compatUrl: $("set-compat-url"), compatModel: $("set-compat-model"), compatModels: $("set-compat-models"),
    compatKey: $("set-compat-key"), compatKeySave: $("set-compat-key-save"), compatKeyClear: $("set-compat-key-clear"),
    compatKeyState: $("set-compat-key-state"), compatTest: $("set-compat-test"), compatState: $("set-compat-state"),
    lmProvider: $("set-lm-provider"), lmModel: $("set-lm-model"), lmModels: $("set-lm-models"), lmLabel: $("set-lm-label"),
    lmUpsample: $("set-lm-upsample"), lmAssistant: $("set-lm-assistant"), lmVision: $("set-lm-vision"),
    lmAdd: $("set-lm-add"), lmState: $("set-lm-state"), lmList: $("set-lm-list"),
    recipes: $("set-recipes"), recipeImport: $("set-recipe-import"), recipeFolder: $("set-recipe-folder"), recipeNoteSet: $("set-recipe-note"),
    plugins: $("set-plugins"), pluginsReload: $("set-plugins-reload"), pluginsFolder: $("set-plugins-folder"), pluginsNote: $("set-plugins-note"),
    setFiles: $("set-files"), setOpenFiles: $("set-open-files"), setPrune: $("set-prune"), setPruneNote: $("set-prune-note"), setGpu: $("set-gpu"), setGpuLimit: $("set-gpu-limit"), setCardMin: $("set-card-min"), setAtlas: $("set-atlas"), setGpuMem: $("set-gpu-mem"), setAsKeep: $("set-as-keep"), setAsSteps: $("set-as-steps"), setAsReset: $("set-as-reset"), setAsNote: $("set-as-note"),
    setTiles: $("set-tiles"), setTilesNote: $("set-tiles-note"), setTilesRestart: $("set-tiles-restart"), setAbout: $("set-about"), aboutRepo: $("set-about-repo"),
    log: $("log-dialog"), logLevel: $("log-level"), logFilter: $("log-filter"), logCopy: $("log-copy"), logOpen: $("log-open"), logClear: $("log-clear"), logList: $("log-list"), logPath: $("log-path"),
    updateBar: $("shell-update"), updateAuto: $("set-update-auto"), updateCheck: $("set-update-check"), updateInstall: $("set-update-install"), updateNote: $("set-update-note"), updateNotes: $("set-update-notes"),
    helpersDevice: $("set-helpers-device"), helpersSam2: $("set-helpers-sam2"), helpersDir: $("set-helpers-dir"), helpersBrowse: $("set-helpers-browse"), helpersDefault: $("set-helpers-default"), helpersOpen: $("set-helpers-open"), helpersScan: $("set-helpers-scan"), helpersScanNote: $("set-helpers-scan-note"),
    helpersModels: $("set-helpers-models"), helpersNote: $("set-helpers-note"), hfToken: $("set-hf-token"), hfSave: $("set-hf-save"), hfClear: $("set-hf-clear"), hfState: $("set-hf-state"),
};

let settings = await window.scumble.settings.get();
let lastStatus = { state: "disconnected", message: "not connected" };
let lastProbe = null;
ui.url.value = (settings.comfy && settings.comfy.url) || "http://127.0.0.1:8188";

// ---- documents (tabs) --------------------------------------------------------------------

host.configure({ mount: $("editor-host"), nodeParams: settings.nodeParams, apiSize: settings.apiSize });

/**
 * The compositor's tile atlas budget (settings.memory.atlasMB, docs/PLAN_BCE.md §C3). Kept on every
 * editor, so a compositor made later takes it too; the change reaches the open ones at once.
 */
function applyAtlasBudget(mb) {
    atlasMB = Math.max(16, Math.round(mb) || 512);
    for (const ed of host.editors()) {
        ed.atlasMB = atlasMB;
        try { if (ed._compositor && ed._compositor.setAtlasBudget) ed._compositor.setAtlasBudget(atlasMB * 1048576); } catch (_) { /* no compositor */ }
    }
}
let atlasMB = (settings.memory && settings.memory.atlasMB) != null ? Math.max(16, settings.memory.atlasMB) : 512;

function newDocument(id) {
    const editor = new InpaintEditor({ id: id || host.nextId++, title: "Scumble" });
    editor.atlasMB = atlasMB;
    host.addEditor(editor);
    editor.open();
    host.attachBrushTips(editor);      // the shared tip library and its save hook
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
    // a turn snapshot of this document goes with the tab (A7): its clones hold tiles
    try { forgetDocument(editor.node && editor.node.id); } catch (err) { console.warn(err); }
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
host.shell = { newDocument, activate, closeDocument, selectRecipe: (id, provider) => selectRecipe(id, provider), recipes: () => recipes, resolveRecipe, openSettings, openGenerateNew: (ed) => openGenerateNew(ed) };
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

const FAMILY_ORDER = ["ComfyUI", "Google", "OpenAI", "Black Forest Labs", "ByteDance", "Qwen"];
const familyOf = (r) => (r.kind === "provider" ? (r.family || "API providers") : "ComfyUI");
/** local = a ComfyUI recipe on the result_local chain, api = a provider recipe or a ComfyUI recipe of API nodes. */
const modeOf = (r) => (r.kind === "provider" || r.mode === "api" ? "api" : "local");

async function loadRecipes() {
    recipes = await window.scumble.recipes.list();
    // ComfyUI first, then the model families in a fixed order, unknown families after, names within
    const rank = (r) => { const i = FAMILY_ORDER.indexOf(familyOf(r)); return i < 0 ? FAMILY_ORDER.length : i; };
    recipes.sort((a, b) => rank(a) - rank(b) || familyOf(a).localeCompare(familyOf(b)) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
    const cur = recipes.find((r) => r.id === (ui.recipe.value || settings.recipe));
    renderRecipeOptions(cur ? modeOf(cur) : (ui.recipe.dataset.mode || "local"));
}

/** The recipe select lists the recipes of one mode: the editor's local / api select switches between them. */
function renderRecipeOptions(mode) {
    ui.recipe.innerHTML = "";
    ui.recipe.dataset.mode = mode;
    const shown = recipes.filter((r) => modeOf(r) === mode);
    // ComfyUI recipes first, then the model recipes grouped by family (Google, OpenAI, ...)
    const families = ["ComfyUI"];
    for (const r of shown) { const f = familyOf(r); if (!families.includes(f)) families.push(f); }
    for (const label of families) {
        const items = shown.filter((r) => familyOf(r) === label);
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
    return { ...r, provider: pid, providerLabel: providerLabel(pid), model: v.model || "", input: v.input || "fill", fields: v.fields || null, fixed: v.fixed || null, settings: v.settings || [], options: v.options || null, note: v.note || "", text: v.text || null, limits: v.limits || null, edit: v.edit !== false };
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
    if (ui.recipe.dataset.mode !== modeOf(raw)) renderRecipeOptions(modeOf(raw));
    ui.recipe.value = r.id;
    const ks = providerKeyState(r);
    const via = r.kind === "provider" ? ` (via ${r.providerLabel}${r.model ? ", " + r.model : ""})` : "";
    ui.recipeNote.textContent = ks && !ks.ok ? ks.text : (r.description || "") + via;
    ui.recipeNote.title = [r.description, r.note].filter(Boolean).join("\n") + via;
    ui.recipeNote.style.color = ks && !ks.ok ? "#e0a05a" : "";
    host.setRecipe(r);
    const byMode = { ...(settings.recipeByMode || {}), [modeOf(raw)]: raw.id };
    if (settings.recipe !== r.id || (settings.recipeByMode || {})[modeOf(raw)] !== raw.id) window.scumble.settings.set({ recipe: r.id, recipeByMode: byMode }).then((s) => { settings = s; });
    if (ui.settings.open) syncRecipeRows();
}
ui.recipe.addEventListener("change", () => selectRecipe(ui.recipe.value));

// The editor's local / api select: switch to the recipe last used in that mode (else the first one).
host.onModeChanged = (mode, editor) => {
    const cur = recipes.find((x) => x.id === ui.recipe.value);
    if (cur && modeOf(cur) === mode) return;
    const want = (settings.recipeByMode || {})[mode];
    const r = recipes.find((x) => x.id === want && modeOf(x) === mode) || recipes.find((x) => modeOf(x) === mode);
    if (r) { selectRecipe(r.id); return; }
    if (cur) { editor.genSettings.mode = modeOf(cur); editor.syncGenControls(); }
    editor.setStatus(mode === "api" ? "No API recipe: add a provider key in Settings (Ctrl+,) › API providers." : "No ComfyUI recipe installed.");
};

/** Update the meta text and the provider selects of the recipe rows without rebuilding them. */
function syncRecipeRows() {
    for (const row of ui.recipes.querySelectorAll(".shell-recipe")) {
        const r = recipes.find((x) => x.id === row.dataset.id);
        if (!r) continue;
        row.classList.toggle("active", host.recipe && host.recipe.id === r.id);
        const sel = row.querySelector("select");
        if (sel) {
            // the option labels carry the key state, so they need a refresh after a key was saved or cleared
            for (const o of sel.options) o.textContent = providerOptionLabel(o.value);
            sel.value = chosenProvider(r);
        }
        const meta = row.querySelector(".shell-recipe-meta");
        if (meta) meta.textContent = recipeMeta(r);
    }
}

/** Provider name for the recipe select; "(no key)" marks a provider with no API key stored yet. */
function providerOptionLabel(pid) {
    const p = providers.find((x) => x.id === pid);
    return providerLabel(pid) + (p && !(p.key && p.key.set) ? " (no key)" : "");
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
                o.value = pid; o.textContent = providerOptionLabel(pid);
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
        const ids = r.providerIds || [];
        const what = r.kind === "provider"
            ? `${ids.length} provider${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`
            : `${r.mode}, ${Object.keys(r.prompt || {}).length} nodes, ${(r.settings || []).length} settings`;
        ui.recipeNoteSet.textContent = `Imported "${r.name}" (${what})` + (r.notes && r.notes.length ? ": " + r.notes.join("; ") : ".");
        return r;
    } catch (err) {
        ui.recipeNoteSet.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
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
            try { await window.scumble.keys.set(p.id, input.value); input.value = ""; await loadProviders(); await renderProviders(); selectRecipe(ui.recipe.value); host.refreshLLMs(); } catch (err) { state.textContent = String(err.message || err); }
        });
        row.appendChild(save);
        const clear = document.createElement("button");
        clear.type = "button"; clear.textContent = "Clear";
        clear.addEventListener("click", async () => { await window.scumble.keys.clear(p.id); await loadProviders(); await renderProviders(); selectRecipe(ui.recipe.value); host.refreshLLMs(); });
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
        if (p.balance && k.set) {
            // a query of what the key has left (ToAPIs: GET /v1/balance, free; OpenRouter: GET /api/v1/key); it also shows the key works
            state.append(" · ");
            const b = document.createElement("a");
            b.href = "#"; b.textContent = "check balance"; b.className = "shell-balance";
            const out = document.createElement("span");
            out.className = "shell-balance-out";
            b.addEventListener("click", async (e) => {
                e.preventDefault();
                out.textContent = " checking ...";
                try {
                    const r = await window.scumble.providers.balance(p.id);
                    // `note` says what the number is where it is not the account's balance (OpenRouter: the key's own limit)
                    out.textContent = r.unlimited ? " unlimited" : (r.usd != null ? ` $${r.usd.toFixed(2)} left${r.note ? ` (${r.note})` : ""}` : (r.note ? ` ${r.note}` : " no balance in the answer"));
                } catch (err) {
                    out.textContent = " " + String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
                }
            });
            state.appendChild(b);
            state.appendChild(out);
        }
        row.appendChild(state);
        ui.providers.appendChild(row);
    }
    ui.keysNote.textContent = info.available
        ? `Keys are encrypted with the system credential store (${info.backend}) and stored in secrets.json; they never leave this machine except in the request to the provider itself.`
        : "This system offers no credential store (safeStorage unavailable): keys cannot be saved.";
}

// ---- local / OpenAI-compatible endpoint (prompt upsampling, electron/main/llm.js) ----------

/**
 * The URL and the model of the endpoint, plus its optional key. Saving either one writes
 * settings.llm.compat and refreshes the editors' upsample lists, so the new backend shows
 * up without reopening the dialog (same as the provider key rows).
 */
async function renderCompat() {
    const set = await window.scumble.settings.get();
    const c = (set.llm || {}).compat || {};
    ui.compatUrl.value = c.url || "";
    ui.compatModel.value = c.model || "";
    const info = await window.scumble.keys.list();
    const k = (info.keys || {}).compat || {};
    ui.compatKeyState.className = "shell-key-state" + (k.set ? " set" : "");
    ui.compatKeyState.textContent = k.set ? `key set (…${k.hint})` : "no key";
    ui.compatKeyClear.disabled = !k.set;
}

async function saveCompat() {
    const set = await window.scumble.settings.get();
    const llm = { ...(set.llm || {}), compat: { url: ui.compatUrl.value.trim(), model: ui.compatModel.value.trim() } };
    await window.scumble.settings.set({ llm });
    await host.refreshLLMs();
}

// The template list at start. It used to sit inside saveCompat(), where only saving the
// compatible endpoint ever ran it, so the "Generate a new image" dialog offered no template
// until the Settings dialog had been opened once.
host.promptTemplateIds = { upsample: "", generate: "", ...(settings.promptTemplates || {}) };
await host.refreshPromptTemplates();

for (const el of [ui.compatUrl, ui.compatModel]) {
    el.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
    el.addEventListener("change", () => { saveCompat().catch((err) => { ui.compatState.textContent = String(err.message || err); }); });
}

ui.compatKey.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); ui.compatKeySave.click(); } });
ui.compatKeySave.addEventListener("click", async () => {
    try { await window.scumble.keys.set("compat", ui.compatKey.value); ui.compatKey.value = ""; await renderCompat(); await host.refreshLLMs(); }
    catch (err) { ui.compatState.textContent = String(err.message || err); }
});
ui.compatKeyClear.addEventListener("click", async () => {
    await window.scumble.keys.clear("compat");
    await renderCompat();
    await host.refreshLLMs();
});

ui.compatTest.addEventListener("click", async () => {
    const url = ui.compatUrl.value.trim();
    if (!url) { ui.compatState.textContent = "Enter a URL first."; return; }
    ui.compatTest.disabled = true;
    ui.compatState.textContent = "asking " + url + " ...";
    try {
        await saveCompat();
        const models = await window.scumble.llm.models(url);
        ui.compatModels.innerHTML = "";
        for (const id of models) { const o = document.createElement("option"); o.value = id; ui.compatModels.appendChild(o); }
        ui.compatState.textContent = models.length
            ? `${models.length} model${models.length === 1 ? "" : "s"}: ${models.slice(0, 3).join(", ")}${models.length > 3 ? " ..." : ""}`
            : "the server answered, but lists no models";
        if (!ui.compatModel.value && models.length) { ui.compatModel.value = models[0]; await saveCompat(); }
    } catch (err) {
        ui.compatState.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    } finally {
        ui.compatTest.disabled = false;
    }
});

// ---- language models the user added (Settings > Language models) ----------------------

// electron/main/llm_custom.js keeps the rows in settings.llm.models; both pickers read them
// from there (the editor's Upsample list through llm.list(), the assistant's through its own
// models()). The dialog only ever writes the whole list back.
let lmProviders = [];

/**
 * The rows as they are stored right now. The dialog reads the file, not the window's cached
 * settings: the endpoint above writes settings.llm without touching that cache, and a stale
 * read here would write its old URL back.
 */
async function lmRows() {
    const set = await window.scumble.settings.get();
    return Array.isArray((set.llm || {}).models) ? (set.llm || {}).models : [];
}

async function lmSave(rows) {
    const set = await window.scumble.settings.get();
    settings = await window.scumble.settings.set({ llm: { ...(set.llm || {}), models: rows } });
    await renderModels();
    await host.refreshLLMs();
    refreshAssistantModels();
}

async function renderModels() {
    // read every time: a key saved above changes what the rows say, and the list is small
    try { lmProviders = await window.scumble.llm.providers(); } catch (_) { lmProviders = lmProviders || []; }
    const keep = ui.lmProvider.value;
    ui.lmProvider.innerHTML = "";
    for (const p of lmProviders) {
        const o = document.createElement("option");
        o.value = p.provider;
        o.textContent = p.label + (p.hasKey || !p.needsKey ? "" : " — no key");
        ui.lmProvider.appendChild(o);
    }
    if (keep) ui.lmProvider.value = keep;
    lmPlaceholder();
    ui.lmList.innerHTML = "";
    const rows = await lmRows();
    for (const r of rows) {
        const p = lmProviders.find((x) => x.provider === r.provider);
        const row = document.createElement("div");
        row.className = "shell-provider shell-lm-row";
        const label = document.createElement("span");
        label.textContent = p ? p.label : r.provider;
        row.appendChild(label);
        const what = document.createElement("span");
        what.className = "shell-note";
        what.textContent = r.label ? `${r.label} — ${r.model}` : r.model;
        what.title = r.model;
        row.appendChild(what);
        const uses = document.createElement("span");
        uses.className = "shell-uses";
        const used = [];
        if (r.upsample !== false) used.push("upsampling");
        if (r.assistant !== false) used.push("assistant");
        if (r.vision === false) used.push("no picture");
        uses.textContent = used.join(" · ") || "not used";
        row.appendChild(uses);
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "Remove";
        del.addEventListener("click", async () => {
            const next = (await lmRows()).filter((x) => !(x.provider === r.provider && String(x.model || "").trim() === String(r.model || "").trim()));
            await lmSave(next);
        });
        row.appendChild(del);
        ui.lmList.appendChild(row);
    }
    if (!rows.length) {
        const empty = document.createElement("p");
        empty.className = "shell-note";
        empty.textContent = "No models of your own yet; the built-in ones are in the pickers anyway.";
        ui.lmList.appendChild(empty);
    }
}

/** One of the provider's own ids as the placeholder of the id field. No request. */
function lmPlaceholder() {
    const p = lmProviders.find((x) => x.provider === ui.lmProvider.value);
    ui.lmModel.placeholder = (p && p.curated && p.curated[0]) || "the model id of that provider";
    if (ui.lmProvider.value !== "openrouter") ui.lmModels.innerHTML = "";
}

/**
 * OpenRouter's live list of models that take tools, as suggestions for the id field. It is read
 * when the user turns to that field or picks the provider, not merely because the dialog opened:
 * a settings dialog should not talk to a host by itself.
 */
async function lmSuggest() {
    lmPlaceholder();
    if (ui.lmProvider.value !== "openrouter" || ui.lmModels.childNodes.length) return;
    try {
        const list = await window.scumble.assistant.openrouterModels();
        for (const m of (list || []).slice(0, 400)) {
            const o = document.createElement("option");
            o.value = m.id;
            o.label = m.label || m.id;
            ui.lmModels.appendChild(o);
        }
    } catch (_) { /* the suggestions are a convenience */ }
}

ui.lmProvider.addEventListener("change", () => { lmSuggest(); });
ui.lmModel.addEventListener("focus", () => { lmSuggest(); });
for (const el of [ui.lmModel, ui.lmLabel]) {
    el.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); ui.lmAdd.click(); } });
}
ui.lmAdd.addEventListener("click", async () => {
    const model = ui.lmModel.value.trim();
    if (!model) { ui.lmState.textContent = "Enter a model id first."; return; }
    const provider = ui.lmProvider.value;
    const rows = (await lmRows()).slice();
    if (rows.some((r) => r.provider === provider && String(r.model || "").trim() === model)) {
        ui.lmState.textContent = "That model is already on the list.";
        return;
    }
    rows.push({
        provider,
        model,
        label: ui.lmLabel.value.trim(),
        upsample: ui.lmUpsample.checked,
        assistant: ui.lmAssistant.checked,
        vision: ui.lmVision.checked,
    });
    try {
        await lmSave(rows);
        ui.lmModel.value = "";
        ui.lmLabel.value = "";
        const p = lmProviders.find((x) => x.provider === provider);
        ui.lmState.textContent = p && p.needsKey && !p.hasKey
            ? `Added. ${p.label} has no key yet — add it under API providers above.`
            : "Added.";
    } catch (err) {
        ui.lmState.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    }
});

// ---- Generate new: a base image from the prompt alone --------------------------------

const GEN_ASPECTS = ["free", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"];
const GEN_RESOLUTIONS = [768, 1024, 1280, 1536, 2048, 3072, 4096];

let genEditor = null;

/** The recipes that can start from nothing, for the mode the dialog is on. */
function genRecipesFor(mode) {
    return recipes.filter((r) => (mode === "local" ? r.kind === "comfy" : r.kind === "provider" && genProviderIds(r).length));
}

/** The providers of a model recipe that have a text-to-image shape. */
function genProviderIds(r) {
    return (r.providerIds || []).filter((pid) => r.providers && r.providers[pid] && r.providers[pid].text);
}

function genFillRecipes() {
    const mode = ui.genMode.value;
    const list = genRecipesFor(mode);
    const keep = ui.genRecipe.value;
    ui.genRecipe.innerHTML = "";
    for (const r of list) {
        const o = document.createElement("option");
        o.value = r.id;
        o.textContent = r.name || r.id;
        ui.genRecipe.appendChild(o);
    }
    if (!list.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = mode === "local" ? "no ComfyUI recipe installed" : "no API model with a text-to-image endpoint";
        ui.genRecipe.appendChild(o);
    }
    if (list.some((r) => r.id === keep)) ui.genRecipe.value = keep;
    else if (list.some((r) => r.id === settings.recipe)) ui.genRecipe.value = settings.recipe;
    genFillProviders();
}

/** The long sides the chosen model offers; a local recipe takes any size. */
function genSizes() {
    const r = recipes.find((x) => x.id === ui.genRecipe.value);
    if (!r || r.kind !== "provider") return GEN_RESOLUTIONS;
    const v = (r.providers || {})[ui.genProvider.value] || {};
    const list = v.text && Array.isArray(v.text.sizes) && v.text.sizes.length ? v.text.sizes : GEN_RESOLUTIONS;
    return list.slice().sort((a, b) => a - b);
}

function genFillSizes() {
    const list = genSizes();
    const keep = +ui.genResolution.value || 1024;
    ui.genResolution.innerHTML = "";
    for (const px of list) {
        const o = document.createElement("option");
        o.value = String(px);
        o.textContent = `${px} px`;
        ui.genResolution.appendChild(o);
    }
    // keep what was chosen when the model offers it, otherwise the nearest it does offer
    const pick = list.includes(keep) ? keep : list.reduce((best, px) => (Math.abs(px - keep) < Math.abs(best - keep) ? px : best), list[0]);
    ui.genResolution.value = String(pick);
    genSyncSize();
}

function genFillProviders() {
    const r = recipes.find((x) => x.id === ui.genRecipe.value);
    const ids = r && r.kind === "provider" ? genProviderIds(r) : [];
    ui.genProviderRow.hidden = !ids.length;
    const keep = ui.genProvider.value;
    ui.genProvider.innerHTML = "";
    for (const pid of ids) {
        const o = document.createElement("option");
        o.value = pid;
        o.textContent = providerOptionLabel(pid);
        ui.genProvider.appendChild(o);
    }
    if (ids.includes(keep)) ui.genProvider.value = keep;
    else if (ids.includes((settings.recipeProviders || {})[r && r.id])) ui.genProvider.value = settings.recipeProviders[r.id];
    else if (r && ids.includes(r.default)) ui.genProvider.value = r.default;
    genFillSizes();
    genTransparencyRow();
    genSyncNote();
}

/** Does the chosen provider variant take a `background` parameter (docs/RECIPES.md)? */
function genTransparencyRow() {
    const r = recipes.find((x) => x.id === ui.genRecipe.value);
    const v = (r && r.providers && r.providers[ui.genProvider.value]) || {};
    const rows = (v.text && v.text.settings) || v.settings || [];
    const ok = !!r && r.kind === "provider" && rows.some((s) => s.key === "background");
    ui.genAlphaRow.hidden = !ok;
    if (!ok) ui.genAlpha.checked = false;
}

function genSyncNote() {
    const r = recipes.find((x) => x.id === ui.genRecipe.value);
    if (!r) { ui.genNote.textContent = ""; return; }
    if (r.kind === "comfy") {
        ui.genNote.textContent = "Runs on your ComfyUI: a flat canvas of the size below goes through the recipe and the answer becomes the image. Any size, the model settings are the ones in the Settings panel.";
        return;
    }
    const v = (r.providers || {})[ui.genProvider.value] || {};
    const t = v.text || {};
    const key = (providers.find((p) => p.id === ui.genProvider.value) || {}).key;
    const missing = key && key.set ? "" : " No key stored for this provider yet.";
    const sizes = genSizes();
    const range = sizes.length > 1 ? `long side ${sizes[0]} to ${sizes[sizes.length - 1]} px` : `long side ${sizes[0]} px`;
    ui.genNote.textContent = `${t.model || "?"} at ${providerLabel(ui.genProvider.value)}, ${range}. The size is a request, the model answers with what it supports.${missing}`;
}

function genAspectFree() {
    return ui.genAspect.value === "free";
}

function genSyncSize() {
    ui.gen.classList.toggle("gen-free-size", genAspectFree());
    ui.gen.classList.toggle("gen-fixed", !genAspectFree());
    const [w, h] = genSize();
    ui.genSizeNote.textContent = `${w} × ${h} px`;
}

/** What the dialog asks for, always a multiple of 16. */
function genSize() {
    const round16 = (v) => Math.max(64, Math.min(8192, Math.round(v / 16) * 16));
    if (genAspectFree()) return [round16(+ui.genWidth.value || 1024), round16(+ui.genHeight.value || 1024)];
    const [aw, ah] = ui.genAspect.value.split(":").map(Number);
    const long = +ui.genResolution.value || 1024;
    return aw >= ah ? [round16(long), round16(long * ah / aw)] : [round16(long * aw / ah), round16(long)];
}

function genFillTemplates() {
    const list = host.promptTemplatesFor("generate");
    const keep = ui.genTemplate.value || (settings.promptTemplates || {}).generate || "";
    ui.genTemplate.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Plain rewrite (built in)";
    ui.genTemplate.appendChild(none);
    for (const t of list) {
        const o = document.createElement("option");
        o.value = t.id;
        o.textContent = t.name + (t.source === "user" ? " (yours)" : "");
        ui.genTemplate.appendChild(o);
    }
    if (list.some((t) => t.id === keep)) ui.genTemplate.value = keep;
    genSyncTemplateNote();
}

function genSyncTemplateNote() {
    const t = host.promptTemplates.find((x) => x.id === ui.genTemplate.value);
    ui.genTemplateNote.textContent = t ? t.description || "" : "The prompt is rewritten richer, without a house style.";
}

/** The instruction for "Upsample prompt" in this dialog: a template, or the plain rewrite. */
function genInstruction(text) {
    const t = host.promptTemplates.find((x) => x.id === ui.genTemplate.value);
    const [w, h] = genSize();
    const ctx = { prompt: text, aspect: ui.genAspect.value === "free" ? `${w}:${h}` : ui.genAspect.value, width: w, height: h, useCase: "generate" };
    if (t) return host.fillPromptTemplate(t, ctx);
    return `Rewrite this into one rich prompt for a text-to-image model. Keep every subject, colour and material the request names. Describe only what is seen, as one paragraph, no lists, no preamble, no quotes. Request: ${text}`;
}

function genFillUpsample() {
    const list = host.upsampleBackends();
    const keep = ui.genUpsample.value;
    ui.genUpsample.innerHTML = "";
    for (const b of list) {
        const o = document.createElement("option");
        o.value = b.id;
        o.textContent = b.label;
        ui.genUpsample.appendChild(o);
    }
    if (!list.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "no language model (Settings › API providers, or a local endpoint)";
        ui.genUpsample.appendChild(o);
    }
    if (list.some((b) => b.id === keep)) ui.genUpsample.value = keep;
    ui.genUpsampleGo.disabled = !list.length;
}

/**
 * The dialog. It writes nothing until Generate is pressed; then it selects the recipe (and
 * the provider) the user picked, so the tab keeps working with that model afterwards, and
 * runs the `generate_new` command, which is the same path the MCP tool and the test take.
 */
export async function openGenerateNew(editor) {
    genEditor = editor || host.editor;
    if (!genEditor) return;
    if (!ui.genAspect.options.length) {
        for (const a of GEN_ASPECTS) {
            const o = document.createElement("option");
            o.value = a;
            o.textContent = a === "free" ? "free (width × height)" : a;
            ui.genAspect.appendChild(o);
        }
        ui.genAspect.value = "1:1";
    }
    ui.genMode.value = genRecipesFor(host.recipe && host.recipe.kind === "comfy" ? "local" : "api").length
        ? (host.recipe && host.recipe.kind === "comfy" ? "local" : "api")
        : (genRecipesFor("local").length ? "local" : "api");
    if (!ui.genResolution.options.length) ui.genResolution.value = "1024";
    genFillRecipes();
    genFillUpsample();
    genFillTemplates();
    ui.genPrompt.value = genEditor.promptText || "";
    // the boxes take 64 to 8192 (genSize clamps to that too): a larger document shows what will be asked for
    ui.genWidth.value = Math.max(64, Math.min(8192, genEditor.width || 1024));
    ui.genHeight.value = Math.max(64, Math.min(8192, genEditor.height || 1024));
    ui.genSeed.value = genEditor.genSettings.seed;
    ui.genSeedRandom.checked = !!genEditor.genSettings.seedRandom;
    ui.genState.textContent = "";
    ui.genUpsampleNote.textContent = "";
    genSyncSize();
    ui.gen.showModal();
    ui.genPrompt.focus();
}

ui.genMode.addEventListener("change", genFillRecipes);
ui.genRecipe.addEventListener("change", genFillProviders);
ui.genProvider.addEventListener("change", () => { genFillSizes(); genTransparencyRow(); genSyncNote(); });
ui.genTemplate.addEventListener("change", () => {
    genSyncTemplateNote();
    window.scumble.settings.set({ promptTemplates: { ...(settings.promptTemplates || {}), generate: ui.genTemplate.value } }).then((s) => { settings = s; }).catch(() => { /* not fatal */ });
});
ui.genAspect.addEventListener("change", genSyncSize);
ui.genResolution.addEventListener("change", genSyncSize);
for (const el of [ui.genWidth, ui.genHeight]) el.addEventListener("input", genSyncSize);
ui.gen.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });

ui.genUpsampleGo.addEventListener("click", async () => {
    const backend = host.upsampleBackends().find((b) => b.id === ui.genUpsample.value);
    if (!backend) return;
    const text = (ui.genPrompt.value || "").trim();
    if (!text) { ui.genUpsampleNote.textContent = "Write something first."; return; }
    ui.genUpsampleGo.disabled = true;
    ui.genUpsampleNote.textContent = "asking " + backend.label.replace(/ \(.*\)$/, "") + " ...";
    try {
        const res = await host.askLLM(backend, genInstruction(text), null);
        ui.genPrompt.value = res.text;
        ui.genUpsampleNote.textContent = `${res.text.split(/\s+/).length} words in ${res.seconds.toFixed(1)} s${res.note ? ", " + res.note : ""}.`;
    } catch (err) {
        ui.genUpsampleNote.textContent = String(err.message || err);
    } finally {
        ui.genUpsampleGo.disabled = false;
    }
});

ui.genGo.addEventListener("click", async () => {
    const ed = genEditor || host.editor;
    if (!ed) return;
    const id = ui.genRecipe.value;
    if (!id) { ui.genState.textContent = "No model to run this on."; return; }
    const prompt = (ui.genPrompt.value || "").trim();
    if (!prompt) { ui.genState.textContent = "Write a prompt first."; ui.genPrompt.focus(); return; }
    const [w, h] = genSize();
    ui.genGo.disabled = true;
    ui.genState.textContent = "running ...";
    try {
        await selectRecipe(id, ui.genProvider.value || undefined);
        // a chosen aspect goes along as itself (the same size as genSize), so a ratio channel is asked for
        // "3:2", not the reduced ratio of the rounded 1024 x 688 ("64:43")
        const args = genAspectFree()
            ? { doc: ed.node.id, prompt, width: w, height: h, timeout: 900 }
            : { doc: ed.node.id, prompt, aspect: ui.genAspect.value, resolution: +ui.genResolution.value || 1024, timeout: 900 };
        if (!ui.genSeedRandom.checked) args.seed = Math.abs(Math.round(+ui.genSeed.value) || 0);
        if (!ui.genAlphaRow.hidden && ui.genAlpha.checked) args.background = "transparent";
        const out = await commands.run("generate_new", args);
        ui.gen.close();
        ui.genState.textContent = "";
        activate(ed);
        console.log("[generate_new]", out);
    } catch (err) {
        ui.genState.textContent = String(err.message || err);
    } finally {
        ui.genGo.disabled = false;
    }
});

// ---- prompt templates (electron/main/prompts.js) --------------------------------------

/**
 * One row per template with what it is for, plus the select that decides which one the
 * editor's Upsample button uses. The one for "Generate new" lives in that dialog.
 */
function renderPrompts() {
    const list = host.promptTemplates;
    ui.promptList.innerHTML = "";
    const row = document.createElement("div");
    row.className = "shell-provider";
    const lab = document.createElement("span");
    lab.textContent = "Upsample uses";
    row.appendChild(lab);
    const sel = document.createElement("select");
    const none = document.createElement("option");
    none.value = ""; none.textContent = "the built-in rules (per use case)";
    sel.appendChild(none);
    for (const t of list.filter((t) => !t.error && (t.use === "both" || t.use === "upsample"))) {
        const o = document.createElement("option");
        o.value = t.id; o.textContent = t.name + (t.source === "user" ? " (yours)" : "");
        sel.appendChild(o);
    }
    sel.value = host.promptTemplateIds.upsample || "";
    sel.addEventListener("change", async () => {
        host.promptTemplateIds.upsample = sel.value;
        settings = await window.scumble.settings.set({ promptTemplates: { ...(settings.promptTemplates || {}), upsample: sel.value } });
    });
    row.appendChild(sel);
    ui.promptList.appendChild(row);
    for (const t of list) {
        const r = document.createElement("div");
        r.className = "shell-provider";
        const nameEl = document.createElement("span");
        nameEl.textContent = t.name;
        r.appendChild(nameEl);
        const note = document.createElement("span");
        note.className = "shell-note";
        note.textContent = t.error ? "broken: " + t.error : `${t.description || "no description"} · ${t.use}${t.for.length ? " · for " + t.for.join(", ") : ""} · ${t.source}`;
        r.appendChild(note);
        if (t.source === "user") {
            const del = document.createElement("button");
            del.type = "button"; del.textContent = "Remove";
            del.addEventListener("click", async () => {
                await window.scumble.prompts.remove(t.id);
                await host.refreshPromptTemplates();
                renderPrompts();
            });
            r.appendChild(del);
        }
        ui.promptList.appendChild(r);
    }
    ui.promptNote.textContent = `${list.length} template${list.length === 1 ? "" : "s"}`;
}

ui.promptImport.addEventListener("click", async () => {
    try {
        const r = await window.scumble.prompts.import();
        if (!r) return;
        await host.refreshPromptTemplates();
        renderPrompts();
        ui.promptNote.textContent = `imported ${r.id}`;
    } catch (err) {
        ui.promptNote.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    }
});

ui.promptFolder.addEventListener("click", async () => {
    await window.scumble.prompts.open();
    await host.refreshPromptTemplates();
    renderPrompts();
});

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
    const sc = st.scan;
    if (sc) {
        const all = st.models || [];
        const linked = all.filter((m) => m.present && m.linked).length;
        const own = all.filter((m) => m.present && !m.linked).length;
        const other = all.filter((m) => !m.present && (m.elsewhere || []).length).length;
        const missing = all.filter((m) => !m.present && !(m.elsewhere || []).length).length;
        ui.helpersScanNote.textContent = `Scanned ${sc.files} weight files in ${sc.dirs} folders at ${new Date(sc.time).toLocaleTimeString()}: `
            + `${linked} model${linked === 1 ? "" : "s"} linked from the folder, ${own} downloaded by the app, ${other} present only as PyTorch weights (not loadable here), ${missing} not found.`
            + (sc.truncated ? " The folder has more files than the scan reads, it stopped early." : "");
    } else {
        ui.helpersScanNote.textContent = "Not scanned yet. Scan folder links the ONNX files it finds under any name (Hugging Face layout included) and reports weights in other formats.";
    }
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
        } else if (m.present && m.linked) {
            info.textContent = `linked: ${m.files.map((f) => f.rel || f.path).join(", ")} · ${fmtBytes(m.bytes)} · ${m.license}`;
            info.title = m.files.map((f) => f.path).join("\n");
            info.classList.add("present");
        } else if (m.present) {
            info.textContent = `${fmtBytes(m.bytes)} · ${m.license}${m.note ? " · " + m.note : ""}`; info.classList.add("present");
        } else {
            const part = m.files.reduce((a, f) => a + (f.partial || 0), 0);
            const other = (m.elsewhere || []).length ? ` · in this folder only as ${m.elsewhere[0]} (PyTorch weights for the ComfyUI nodes, not loadable here)` : "";
            info.textContent = `${fmtBytes(m.size)} download · ${m.license}${m.note ? " · " + m.note : ""}${part ? ` · ${fmtBytes(part)} partial, resumes` : ""}${other}`;
            if (other) info.title = "Found in other formats:\n" + m.elsewhere.join("\n");
        }
        row.appendChild(info);
        const btn = document.createElement("button");
        btn.type = "button";
        if (dl) {
            btn.textContent = "Cancel";
            btn.addEventListener("click", () => window.scumble.helpers.cancel(m.id));
        } else if (m.present && m.linked) {
            btn.textContent = "Unlink";
            btn.title = "Forget the linked files. Nothing is deleted.";
            btn.addEventListener("click", async () => {
                try { renderHelpers(await window.scumble.helpers.remove(m.id)); } catch (e) { downloadErrors[m.id] = String(e.message || e); renderHelpers(); }
                host.refreshHelpers();
            });
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
ui.helpersScan.addEventListener("click", async () => {
    ui.helpersScan.disabled = true;
    ui.helpersScanNote.textContent = "Scanning ...";
    try { renderHelpers(await window.scumble.helpers.scan()); } catch (e) { ui.helpersScanNote.textContent = String(e.message || e); }
    ui.helpersScan.disabled = false;
    host.refreshHelpers();
});
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

// ---- memory watch ------------------------------------------------------------------------
//
// A document that is not in front still holds its filtered and matched copies, its display
// pyramids and the compositor's textures - a few hundred MB at 96 MP. When the GPU process
// grows past the limit those caches are given back; the next time the tab comes forward it
// rebuilds them. The active document is never touched, and neither is anything that is
// working (docs/PERFORMANCE.md phase 6).
//
// The card as a whole counts too (docs/PLAN_TILES.md phase A, item 5): the stutter on a large
// document comes when the card is over-committed by everything on it - ComfyUI's models after
// a local render above all - and Windows pages textures out. When less than
// `settings.memory.cardMinFreeMB` of the card is free, the background tabs' caches go as
// above, and then the front tab's compositor textures and the GL pool as well (never its
// display levels: they are the next frame). The card's numbers come from the main process
// (electron/main/gpumem.js): nvidia-smi, or the WDDM counters on Windows, or nothing.
let memoryBusy = false;

/** The GPU process's private bytes in MB, or 0 when the platform does not report them. */
async function gpuMemoryMB() {
    const m = await window.scumble.metrics();
    let kb = 0;
    for (const p of m.processes || []) if (p.type === "GPU") kb += p.privateKB || p.workingSetKB || 0;
    return Math.round(kb / 1024);
}

/** The card: { usedMB, totalMB, source } or null. Never throws. */
async function cardMemory() {
    try { return (await window.scumble.gpuMemory()) || null; } catch (_) { return null; }
}

/** How short the card is of `minFree` MB, in MB (0 when it is not, or nothing is known). */
function cardShortfall(card, minFree) {
    if (!card || !minFree || !(card.totalMB > 0)) return 0;
    return Math.max(0, minFree - (card.totalMB - card.usedMB));
}

async function watchMemory() {
    if (memoryBusy) return;
    // read the limit rather than trusting the copy in `settings`: the value can be
    // changed from the settings dialog of another window, and it makes the watch testable
    const conf = await window.scumble.settings.get();
    const limit = (conf.memory && conf.memory.gpuLimitMB) || 0;
    const minFree = (conf.memory && conf.memory.cardMinFreeMB) || 0;
    if (!limit && !minFree) return;
    memoryBusy = true;
    try {
        const before = await gpuMemoryMB();
        const card = minFree ? await cardMemory() : null;
        const short = cardShortfall(card, minFree);
        const over = limit && before > limit;
        if (!over && !short) return;
        const others = host.editors().filter((ed) => ed !== host.editor && !busy(ed) && !ed.pointer);
        let freed = 0;
        for (const ed of others) { try { freed += ed.releaseCaches({ deep: false, mirrors: true }) || 0; } catch (err) { console.warn(err); } }   // mirrors: a tab on tiles gives its display canvases back too
        let front = 0;
        if (short) {
            // the card is the problem: the front tab's textures too, and the GL pool; the
            // next frame uploads what it shows again (a window of each source, not the whole)
            const ed = host.editor;
            if (ed && !busy(ed) && !ed.pointer) {
                try {
                    if (ed._compositor && ed._compositor.stats) {
                        const cst = ed._compositor.stats();
                        front += (cst.bytes || 0) + ((cst.atlas && cst.atlas.bytes) || 0);   // the tile atlas too (C3)
                    }
                    if (ed._compositor) ed._compositor.clear();
                    if (typeof ed.releaseGpu === "function") front += ed.releaseGpu() || 0;
                    ed.sceneSig = null;
                    ed.drawSoon();
                } catch (err) { console.warn(err); }
            }
        }
        const after = await gpuMemoryMB();
        const why = [over ? `GPU process ${before} MB over the ${limit} MB limit` : "", short ? `card ${card.usedMB} of ${card.totalMB} MB used, ${short} MB short of the ${minFree} MB to keep free (${card.source})` : ""].filter(Boolean).join("; ");
        console.log(`memory watch: ${why}; released ${Math.round(freed / 1048576)} MB of caches in ${others.length} background tab${others.length === 1 ? "" : "s"}${short ? ` and ${Math.round(front / 1048576)} MB of the front tab's textures` : ""}, GPU process now ${after} MB`);
    } catch (err) {
        console.warn("memory watch", err);
    } finally {
        memoryBusy = false;
    }
}
setInterval(() => { watchMemory(); }, 30000);

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
    // the same whole numbers the change handlers below write, so a stored value (typed by hand, or one the
    // browser suggested while a field still had coarser steps) always passes the form's own validation:
    // an invalid number input keeps the dialog's Close from submitting
    const mem = settings.memory || {};
    ui.setGpuLimit.value = wholeMB(mem.gpuLimitMB, 0, 3072);
    ui.setCardMin.value = wholeMB(mem.cardMinFreeMB, 0, 2048);
    ui.setAtlas.value = wholeMB(mem.atlasMB, 16, 512);
    const as = settings.assistant || {};
    ui.setAsKeep.value = Math.max(1, Math.round(Number(as.keepChats) || 20));
    ui.setAsSteps.value = Math.max(1, Math.round(Number(as.maxSteps) || 25));
    ui.setAsNote.textContent = "";
    await renderTileMode();
    try {
        const mb = await gpuMemoryMB();
        const card = await cardMemory();
        const cardText = card ? (card.totalMB ? ` The card holds ${card.usedMB} of ${card.totalMB} MB (everything on it, read through ${card.source}).` : ` The card holds ${card.usedMB} MB in all (read through ${card.source}; its size is not reported).`) : " The card's own memory cannot be read here (no nvidia-smi, no counters).";
        ui.setGpuMem.textContent = `The GPU process is using ${mb} MB right now.${cardText} A background tab keeps its filtered copies, its display pyramids and the compositor's textures until they are released here.`;
    } catch (_) { ui.setGpuMem.textContent = ""; }
    try {
        const info = await window.scumble.info();
        ui.setAbout.textContent = `Scumble ${info.version} · Electron ${info.electron} · ${info.platform} · data in ${info.userData}. Film names are trademarks of their owners; the looks are Scumble's own approximations, not licensed products.`;
    } catch (_) { /* ignore */ }
    ui.updateAuto.checked = !(settings.updates && settings.updates.check === false);
    try { renderUpdate(await window.scumble.updates.status()); } catch (_) { /* ignore */ }
    refreshFileStats();
    await loadProviders();
    await renderProviders();
    await renderCompat();
    await renderModels();
    ui.lmState.textContent = "";
    await host.refreshPromptTemplates();
    renderPrompts();
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
    // the release notes of the offered version, as text: they come from GitHub, so they
    // never touch innerHTML
    const notes = s && s.notes && (s.state === "downloaded" || s.state === "downloading") ? s.notes : "";
    ui.updateNotes.textContent = notes;
    ui.updateNotes.hidden = !notes;
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
/** A memory row's value as the row shows and stores it: a whole number of MB, at least `min`. */
function wholeMB(v, min, fallback) {
    return v == null || v === "" || !Number.isFinite(Number(v)) ? fallback : Math.max(min, Math.round(Number(v)));
}

// the assistant's two numbers and the one button that deletes everything it stored (A6)
ui.setAsKeep.addEventListener("change", async () => {
    const v = Math.min(200, Math.max(1, Math.round(Number(ui.setAsKeep.value) || 20)));
    ui.setAsKeep.value = v;
    settings = await window.scumble.settings.set({ assistant: { ...(settings.assistant || {}), keepChats: v } });
});
ui.setAsSteps.addEventListener("change", async () => {
    const v = Math.min(100, Math.max(1, Math.round(Number(ui.setAsSteps.value) || 25)));
    ui.setAsSteps.value = v;
    settings = await window.scumble.settings.set({ assistant: { ...(settings.assistant || {}), maxSteps: v } });
});
ui.setAsReset.addEventListener("click", async () => {
    // the editor's own question, not a native confirm: it says exactly what goes and what stays
    const ed = host.editor;
    const yes = ed
        ? await ed.ask({
            title: "Delete all assistant data",
            message: "Deletes every assistant chat and its screenshots, the privacy-notice dates, the assistant settings and the assistant's lines in the app log. Your API keys stay; they belong to Settings > API providers.",
            ok: "Delete", cancel: "Cancel", danger: true,
        })
        : true;
    if (!yes) return;
    ui.setAsNote.textContent = "deleting ...";
    try {
        await window.scumble.assistant.resetAll();
        resetAssistant();
        settings = await window.scumble.settings.get();
        ui.setAsKeep.value = Math.max(1, Math.round(Number((settings.assistant || {}).keepChats) || 20));
        ui.setAsSteps.value = Math.max(1, Math.round(Number((settings.assistant || {}).maxSteps) || 25));
        ui.setAsNote.textContent = "every chat, screenshot and log line of the assistant is gone; the keys are untouched";
    } catch (err) {
        ui.setAsNote.textContent = "could not delete: " + ((err && err.message) || err);
    }
});

ui.setGpuLimit.addEventListener("change", async () => {
    const v = Math.max(0, Math.round(Number(ui.setGpuLimit.value) || 0));
    ui.setGpuLimit.value = v;
    settings = await window.scumble.settings.set({ memory: { ...(settings.memory || {}), gpuLimitMB: v } });
});
ui.setCardMin.addEventListener("change", async () => {
    const v = Math.max(0, Math.round(Number(ui.setCardMin.value) || 0));
    ui.setCardMin.value = v;
    settings = await window.scumble.settings.set({ memory: { ...(settings.memory || {}), cardMinFreeMB: v } });
});
ui.setAtlas.addEventListener("change", async () => {
    const v = Math.max(16, Math.round(Number(ui.setAtlas.value) || 0));
    ui.setAtlas.value = v;
    settings = await window.scumble.settings.set({ memory: { ...(settings.memory || {}), atlasMB: v } });
    applyAtlasBudget(v);
});

/**
 * Settings › Rendering › Tile engine (docs/PLAN_BCE.md §C7). The box shows the boolean `tiles` in
 * settings.json, or the default while there is none, and writes the boolean when it is changed; opening
 * the dialog writes nothing. The note says what this window runs and what decided it (electron/main/
 * tilemode.js): the command line and SCUMBLE_TILES win over the box, and a change reaches the next start.
 */
async function renderTileMode() {
    let t;
    try { t = await window.scumble.tileMode(); } catch (err) { ui.setTilesNote.textContent = String(err.message || err); return null; }
    ui.setTiles.checked = typeof t.setting === "boolean" ? t.setting : !!t.defaultOn;
    const w = t.window || t.next;
    const onOff = (on) => (on ? "on" : "off");
    const source = (from) => (from === "command line" ? `set by ${t.argv} on the command line`
        : from === "SCUMBLE_TILES" ? `set by SCUMBLE_TILES=${t.env} in the environment`
            : from === "settings" ? "set by this box" : "the default");
    const text = [`This window runs with the tile engine ${onOff(w.on)} (${source(w.from)}).`];
    if (t.next.from === "command line") text.push(`The command line wins over this box: it decides only when Scumble is started without ${t.argv}.`);
    else if (t.next.from === "SCUMBLE_TILES") text.push("The environment wins over this box: it decides only when Scumble is started without SCUMBLE_TILES.");
    else if (t.next.on !== w.on) text.push(`After a restart Scumble runs with the tile engine ${onOff(t.next.on)}.`);
    else text.push("A change takes effect after a restart.");
    ui.setTilesRestart.hidden = t.next.on === w.on;
    if (!ui.setTilesRestart.hidden) {
        // with an update downloaded the restart goes through its installer (electron/main/restart.js)
        let upd = null;
        try { upd = await window.scumble.updates.status(); } catch (_) { /* no updater */ }
        if (upd && upd.state === "downloaded") text.push(`Restart now also installs ${upd.version}.`);
    }
    ui.setTilesNote.textContent = text.join(" ");
    ui.setTilesRestart.disabled = false;
    return t;
}
ui.setTiles.addEventListener("change", async () => {
    settings = await window.scumble.settings.set({ tiles: ui.setTiles.checked });
    await renderTileMode();
});
ui.setTilesRestart.addEventListener("click", async () => {
    const working = host.editors().filter(busy);
    if (working.length && !window.confirm(`${working.length === 1 ? "A document is" : working.length + " documents are"} still working. Restart anyway?`)) return;
    ui.setTilesRestart.disabled = true;
    try {
        await saveBeforeRestart((text) => { ui.setTilesNote.textContent = text; });
        await window.scumble.relaunch();
    } catch (err) {
        ui.setTilesNote.textContent = String(err.message || err);
        ui.setTilesRestart.disabled = false;
    }
});

/**
 * Everything a restart must not lose, saved now. The autosave bundle holds each layer's uploaded file,
 * and a layer is uploaded only 15 s after its last change (scheduleAutosave): saving the bundle alone
 * restored the pixels from before that, and a new layer never uploaded came back without its pixels at
 * all. So every edited layer and mask is uploaded first. A picture above the size getValue encodes on
 * the spot gets its selection PNG in the background (encodeSelectionSoon), so that is waited for too
 * (at most a minute), or the saved selection would be the one before. `say` gets a status line.
 */
async function saveBeforeRestart(say = () => {}) {
    const eds = host.editors();
    if (eds.some((ed) => ed.layers && ed.layers.some((l) => (l.dirty && l.px) || (l.maskDirty && l.maskPx)))) say("Saving the edited layers before the restart...");
    for (const ed of eds) if (ed.base && typeof ed.syncLayers === "function") await ed.syncLayers();
    const selectionPending = (ed) => ed.base && ed.sel && (ed._selEncoding || !ed.selectionEncoded || !ed.selectionDataUrl);
    const failed = new Set();   // an encode that could not start (toCanvas throws above the canvas limit)
    const until = Date.now() + 60000;
    for (;;) {
        for (const ed of eds) {
            if (!selectionPending(ed) || ed._selEncoding || failed.has(ed)) continue;
            try { ed.getValue(); } catch (_) { /* reported by bundle() */ }
            if (selectionPending(ed) && !ed._selEncoding) failed.add(ed);
        }
        if (!eds.some((ed) => selectionPending(ed) && !failed.has(ed)) || Date.now() > until) break;
        say("Saving the selection before the restart...");
        await new Promise((r) => setTimeout(r, 100));
    }
    await window.scumble.state.save(JSON.stringify(host.bundle()));
}
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
    else if (cmd === "console") openConsole();
    else if (cmd === "guide") window.scumble.openExternal("https://github.com/DenRakEiw/ComfyUI-InpaintCanvas#readme");
    else if (cmd === "new-tab") activate(newDocument());
    else if (cmd === "close-tab") closeDocument(host.editor);
    else if (cmd === "next-tab") cycleTab(1);
    else if (cmd === "prev-tab") cycleTab(-1);
    else if (cmd === "import-recipe") importRecipe();
    else if (cmd === "reload-plugins") plugins.reloadPlugins().then((list) => { if (host.editor) host.editor.setStatus(`Plugins reloaded: ${list.filter((p) => p.loaded).length} of ${list.length} loaded.`); });
    else if (cmd === "assistant") toggleAssistant();
    else if (cmd === "mcp-copied") host.editor && host.editor.setStatus("MCP registration copied. Paste it into your client; see docs/MCP.md.");
    else if (cmd === "settings-updates") openSettings().then(() => { const h = Array.from(ui.settings.querySelectorAll("h3")).find((x) => x.textContent === "Updates"); if (h) h.scrollIntoView(); });
    else if (cmd === "settings-plugins") openSettings().then(() => { const h = Array.from(ui.settings.querySelectorAll("h3")).find((x) => x.textContent === "Plugins"); if (h) h.scrollIntoView(); });
    else if (cmd.startsWith("plugin:")) plugins.runAction(cmd.slice(7)).catch(() => { /* reported by the plugin host */ });
});

// ---- the command bridge: main (MCP server, --cmd, the local socket) runs commands here -----

// A request of the in-app assistant carries `meta` (docs/PLAN_ASSISTANT.md §3): `wait` holds it while the
// user is in the middle of an edit (renderer/assistant_wait.js), `refuseBusy` turns it away while a run
// is in progress on the document, and a cancel that arrives while it waits means it never runs. Requests
// without `meta` (external agents, --cmd, scripts) take exactly the path they always took.
const cancelledRequests = new Set();
window.scumble.commands.onCancel(({ id }) => { if (cancelledRequests.size > 500) cancelledRequests.clear(); cancelledRequests.add(id); });
window.scumble.commands.onRequest(async ({ id, name, args, meta }) => {
    const reply = (r) => {
        let payload;
        try { payload = JSON.parse(JSON.stringify({ id, ...r })); }   // results are JSON by contract; anything else is an error, not a crash
        catch (err) { payload = { id, ok: false, error: "the result is not JSON: " + (err.message || err) }; }
        window.scumble.commands.reply(payload);
    };
    if (meta && meta.wait) {
        const why = await waitForUser(args && args.doc, name, meta.wait, () => cancelledRequests.has(id));
        if (why) { cancelledRequests.delete(id); return reply({ ok: false, error: why }); }
    }
    if (meta && cancelledRequests.delete(id)) return reply({ ok: false, error: "cancelled before it ran" });
    if (meta && meta.refuseBusy) {
        // right before the command, with no await in between: a run the user starts while the ask card is open sets
        // `providerPending` synchronously at its start, so only a check here catches it
        const ed = editorOf(args && args.doc);
        if (ed && docSummary(ed).busy) return reply({ ok: false, error: "the document is busy: a run is in progress; nothing was run" });
    }
    if (meta && meta.turn) {
        // the turn's snapshot of this document (A7), taken once per turn and document, and the
        // editor's own undo step for the calls the commands record none for. No await from here
        // to commands.call: what they hold is the state the command is about to change.
        snapshotTurn(meta, args && args.doc);
        if (meta.undo && meta.undo.kind) {
            const ed = editorOf(args && args.doc);
            if (ed && typeof ed.pushUndo === "function") {
                try { ed.pushUndo(meta.undo.id ? { kind: meta.undo.kind, id: meta.undo.id } : { kind: meta.undo.kind }); }
                catch (err) { console.warn("assistant: the undo step could not be pushed", err); }
            }
        }
    }
    reply(await commands.call(name, args || {}));
});

// ---- start: plugins, restore the last session, then connect -------------------------------

try {
    await plugins.loadPlugins();
} catch (err) {
    console.warn("plugins", err);
}
try {
    const saved = await window.scumble.state.load();
    await host.loadBrushTips();
    if (saved) await host.restore(saved);
} catch (err) {
    console.warn("no autosaved state", err);
}
if (!host.editors().length) newDocument();
activate(host.editor);
await loadProviders();
await loadRecipes();
host.presets = settings.recipePresets || {};
await host.refreshHelpers();
await host.refreshLLMs();
selectRecipe(settings.recipe);
showStatus(await window.scumble.comfy.status());
window.scumble.commands.ready();
// the assistant's column (docs/PLAN_ASSISTANT.md A5): built last, so its window key listener is
// registered before any editor question's, and it sees a chat key first
initAssistant({ openSettings });
watchUserEdits();
const assistantButton = $("shell-assistant");
if (assistantButton) assistantButton.addEventListener("click", () => toggleAssistant());

// ---- the console dialog: the log's ring buffer, filtered, growing live ----------------------

const logState = { entries: [], lastId: 0, open: false };
const fmtTime = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

function logMatches(e) {
    const lvl = ui.logLevel.value;
    if (lvl === "error" && e.level !== "error") return false;
    if (lvl === "warn" && e.level === "info") return false;
    const q = ui.logFilter.value.trim().toLowerCase();
    if (q && !(`${e.source} ${e.message} ${e.detail || ""}`.toLowerCase().includes(q))) return false;
    return true;
}

function logRow(e) {
    const row = document.createElement("div");
    row.className = `log-entry log-${e.level}`;
    row.dataset.id = e.id;
    const cell = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; row.appendChild(s); return s; };
    cell("log-time", fmtTime(e.time)); cell("log-level", e.level); cell("log-source", e.source); cell("log-message", e.message);
    if (e.detail) {
        row.title = "Click for the detail";
        row.addEventListener("click", () => {
            const open = row.querySelector(".log-detail");
            if (open) { open.remove(); return; }
            const d = document.createElement("div");
            d.className = "log-detail";
            let text = e.detail;
            try { text = JSON.stringify(JSON.parse(e.detail), null, 2); } catch (_) { /* not JSON */ }
            d.textContent = text;
            row.appendChild(d);
        });
    }
    return row;
}

function renderLog() {
    const list = ui.logList;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = "";
    const shown = logState.entries.filter(logMatches);
    if (!shown.length) { const em = document.createElement("div"); em.className = "log-empty"; em.textContent = logState.entries.length ? "Nothing matches the filter." : "Nothing logged yet."; list.appendChild(em); }
    for (const e of shown) list.appendChild(logRow(e));
    if (atBottom) list.scrollTop = list.scrollHeight;
}

async function openConsole() {
    try { logState.entries = await window.scumble.log.list({}); } catch (err) { logState.entries = [{ id: 0, time: Date.now(), level: "error", source: "renderer", message: "log unreachable: " + (err.message || err) }]; }
    logState.lastId = logState.entries.length ? logState.entries[logState.entries.length - 1].id : 0;
    try { ui.logPath.textContent = (await window.scumble.log.file()) || ""; } catch (_) { ui.logPath.textContent = ""; }
    renderLog();
    if (!ui.log.open) ui.log.showModal();
    ui.logList.scrollTop = ui.logList.scrollHeight;
    ui.logFilter.focus();
}
window.scumble.log.onEntry((e) => {
    if (!e || e.id <= logState.lastId) return;
    logState.entries.push(e);
    logState.lastId = e.id;
    if (logState.entries.length > 2000) logState.entries.splice(0, logState.entries.length - 2000);
    if (ui.log.open && logMatches(e)) {
        const empty = ui.logList.querySelector(".log-empty");
        if (empty) empty.remove();
        const atBottom = ui.logList.scrollHeight - ui.logList.scrollTop - ui.logList.clientHeight < 40;
        ui.logList.appendChild(logRow(e));
        if (atBottom) ui.logList.scrollTop = ui.logList.scrollHeight;
    }
});
ui.logLevel.addEventListener("change", renderLog);
ui.logFilter.addEventListener("input", renderLog);
ui.logFilter.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });
ui.log.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });
ui.logCopy.addEventListener("click", () => {
    const text = logState.entries.filter(logMatches).map((e) => `${new Date(e.time).toISOString()} ${e.level.toUpperCase()} [${e.source}] ${e.message}${e.detail ? "  " + e.detail : ""}`).join("\n");
    navigator.clipboard.writeText(text).then(() => { if (host.editor) host.editor.setStatus(`${logState.entries.filter(logMatches).length} log lines copied.`); }).catch(() => {});
});
ui.logOpen.addEventListener("click", () => window.scumble.log.open());
ui.logClear.addEventListener("click", async () => { await window.scumble.log.clear(); logState.entries = []; renderLog(); });
host.openConsole = () => openConsole();

export { newDocument, activate, closeDocument, openSettings, openConsole, selectRecipe, loadRecipes, importRecipe, testConnection, connect, commands, plugins, watchMemory, cardMemory, cardShortfall, saveBeforeRestart };
