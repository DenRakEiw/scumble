// The shell around the editor: connection bar, recipe picker, progress, tabs (one editor
// per document), the settings dialog (ComfyUI connection with auth, API provider keys,
// recipes, local files) and the menu commands.
import { host, api } from "./editor/host.js";
import { InpaintEditor, STYLE as EDITOR_STYLE } from "./editor/inpaint_canvas.js";
import { glFiltersAvailable } from "./editor/inpaint_filters_gl.js";
import { setPixelsOptions } from "./editor/inpaint_pixels.js";
import { commands, docSummary } from "./commands.js";
import * as plugins from "./plugins.js";
import { waitForUser, editorOf, userBusy } from "./assistant_wait.js";
import { beforeCall as snapshotTurn, watchUserEdits, forgetDocument } from "./assistant_turns.js";
import { initAssistant, toggleAssistant, assistantOpen, resetAssistant, refreshAssistantModels, assistantActivity } from "./assistant.js";
import { initHelp, toggleHelp, helpOpen } from "./help.js";
import { initSkins, applySkin, reloadSkins, renderAppearance } from "./skins.js";
import * as dialogs from "./dialogs.js";
import { PromptField, RefBar } from "./editor/prompt_field.js";
import { remap, compare, checkNote, normalize as normalizeTokens, referencesText, referencesRule } from "./editor/reftokens.js";
import * as realism from "./editor/realism.js";
import * as comfyprompt from "./editor/comfyprompt.js";

// the editor's style, in the app's cascade layer (docs/SKINS.md): created here before the first editor, so the
// editor's own injectStyle() finds it and adds nothing; a skin's rules then beat it as they beat shell.css
if (!document.getElementById("ipc-style")) {
    const s = document.createElement("style");
    s.id = "ipc-style";
    s.textContent = "@layer app {\n" + EDITOR_STYLE + "\n}";
    document.head.appendChild(s);
}

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
    // the renderer's memory limit for pixels (PixelMemoryError, renderer/editor/inpaint_arena.js) reached where nothing
    // catches it, a stroke or a timer: the status line says so, as it does for an operation that catches it
    const pixelMemory = (err) => { if (err && err.name === "PixelMemoryError" && host.editor) host.editor.setStatus(err.message); };
    window.addEventListener("error", (e) => { send("error", "uncaught: " + (e.message || e), e.error && e.error.stack); pixelMemory(e.error); });
    window.addEventListener("unhandledrejection", (e) => { send("error", "unhandled: " + ((e.reason && (e.reason.message || e.reason)) || e), e.reason && e.reason.stack); pixelMemory(e.reason); });
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
    genProviderRow: $("gen-provider-row"), genNote: $("gen-note"), genPrompt: null, genRefbar: $("gen-refbar"), genPromptHost: $("gen-prompt-host"),
    genUpsample: $("gen-upsample"), genUpsampleGo: $("gen-upsample-go"), genUpsampleNote: $("gen-upsample-note"),
    genAspect: $("gen-aspect"), genResolution: $("gen-resolution"), genWidth: $("gen-width"), genHeight: $("gen-height"),
    genSeed: $("gen-seed"), genSeedRandom: $("gen-seed-random"), genSizeNote: $("gen-size-note"),
    genAlpha: $("gen-alpha"), genAlphaRow: $("gen-alpha-row"),
    genState: $("gen-state"), genGo: $("gen-go"), genCancel: $("gen-cancel"),
    genTemplate: $("gen-template"), genTemplateNote: $("gen-template-note"),
    up: $("up-dialog"), upRecipe: $("up-recipe"), upProvider: $("up-provider"), upProviderRow: $("up-provider-row"),
    upNote: $("up-note"), upScopeSel: $("up-scope-sel"), upScopeDoc: $("up-scope-doc"), upFactor: $("up-factor"),
    upFactorRow: $("up-factor-row"), upSizeNote: $("up-size-note"), upPromptRow: $("up-prompt-row"), upPrompt: $("up-prompt"), upState: $("up-state"), upGo: $("up-go"),
    upPassRow: $("up-pass-row"), upPassStyle: $("up-pass-style"), upPassStrength: $("up-pass-strength"), upPassStrengthV: $("up-pass-strength-v"), upPassPreset: $("up-pass-preset"),
    promptList: $("set-prompts"), promptImport: $("set-prompt-import"), promptFolder: $("set-prompt-folder"), promptNote: $("set-prompt-note"),
    promptRefPics: $("set-prompt-refpics"),
    compatUrl: $("set-compat-url"), compatModel: $("set-compat-model"), compatModels: $("set-compat-models"),
    compatKey: $("set-compat-key"), compatKeySave: $("set-compat-key-save"), compatKeyClear: $("set-compat-key-clear"),
    compatKeyState: $("set-compat-key-state"), compatTest: $("set-compat-test"), compatState: $("set-compat-state"),
    lmProvider: $("set-lm-provider"), lmModel: $("set-lm-model"), lmModels: $("set-lm-models"), lmLabel: $("set-lm-label"),
    lmUpsample: $("set-lm-upsample"), lmAssistant: $("set-lm-assistant"), lmVision: $("set-lm-vision"),
    lmAdd: $("set-lm-add"), lmState: $("set-lm-state"), lmList: $("set-lm-list"),
    recipes: $("set-recipes"), recipeImport: $("set-recipe-import"), recipeFolder: $("set-recipe-folder"), recipeNoteSet: $("set-recipe-note"),
    plugins: $("set-plugins"), pluginsReload: $("set-plugins-reload"), pluginsFolder: $("set-plugins-folder"), pluginsNote: $("set-plugins-note"),
    skins: $("set-skins"), skinsReload: $("set-skins-reload"), skinsFolder: $("set-skins-folder"), skinsNote: $("set-skins-note"),
    setFiles: $("set-files"), setOpenFiles: $("set-open-files"), setPrune: $("set-prune"), setPruneNote: $("set-prune-note"), setGens: $("set-gens"), setGensOpen: $("set-gens-open"), setGensNote: $("set-gens-note"), setGpu: $("set-gpu"), setGpuLimit: $("set-gpu-limit"), setCardMin: $("set-card-min"), setAtlas: $("set-atlas"), setUndoSteps: $("set-undo-steps"), setUndoMB: $("set-undo-mb"), setGpuMem: $("set-gpu-mem"), setAsKeep: $("set-as-keep"), setAsSteps: $("set-as-steps"), setAsReset: $("set-as-reset"), setAsNote: $("set-as-note"),
    setTiles: $("set-tiles"), setTilesNote: $("set-tiles-note"), setTilesRestart: $("set-tiles-restart"), setAbout: $("set-about"), aboutRepo: $("set-about-repo"), aboutStar: $("set-about-star"), aboutShare: $("set-about-share"),
    shareRow: $("set-about-share-row"), shareCopy: $("set-share-copy"), shareTargets: $("set-share-targets"), shareNote: $("set-share-note"),
    log: $("log-dialog"), logLevel: $("log-level"), logFilter: $("log-filter"), logCopy: $("log-copy"), logOpen: $("log-open"), logClear: $("log-clear"), logList: $("log-list"), logPath: $("log-path"),
    updateBar: $("shell-update"), updateAuto: $("set-update-auto"), updateCheck: $("set-update-check"), updateInstall: $("set-update-install"), updateNote: $("set-update-note"), updateHelp: $("set-update-help"), updateHelpNotify: $("set-update-help-notify"), updateNotes: $("set-update-notes"),
    helpersDevice: $("set-helpers-device"), helpersSam2: $("set-helpers-sam2"), helpersDir: $("set-helpers-dir"), helpersBrowse: $("set-helpers-browse"), helpersDefault: $("set-helpers-default"), helpersOpen: $("set-helpers-open"), helpersScan: $("set-helpers-scan"), helpersScanNote: $("set-helpers-scan-note"),
    helpersModels: $("set-helpers-models"), helpersNote: $("set-helpers-note"), hfToken: $("set-hf-token"), hfSave: $("set-hf-save"), hfClear: $("set-hf-clear"), hfState: $("set-hf-state"),
};

let settings = await window.scumble.settings.get();
let lastStatus = { state: "disconnected", message: "not connected" };
let lastProbe = null;
// the canvas-only view (canvasOnly below): { ed, wasFullScreen, view, fitted, rulers, w, h } while it is on, and
// whether the window is full screen (main tells, F11 and the OS included)
let canvasOnlyState = null;
let windowFullScreen = false;
ui.url.value = (settings.comfy && settings.comfy.url) || "http://127.0.0.1:8188";

// ---- documents (tabs) --------------------------------------------------------------------

host.configure({ mount: $("editor-host"), nodeParams: settings.nodeParams, apiSize: settings.apiSize, embedRecipe: settings.embedRecipe, llmRefPictures: refPicturesOn(settings), realism: settings.realism });

/** settings.llm.refPictures: the reference pictures go to the upsampling model unless it is false (absent = on, 26d2). */
function refPicturesOn(set) {
    return ((set && set.llm) || {}).refPictures !== false;
}

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

/** The undo history's depth (settings.history, Settings › Memory): every open editor now, and every new one. */
function historyDepth() {
    const h = settings.history || {};
    return { steps: Math.min(500, Math.max(5, Math.round(+h.steps) || 30)), mb: Math.min(8192, Math.max(64, Math.round(+h.mb) || 384)) };
}
function applyHistoryDepth(ed) {
    const d = historyDepth();
    for (const e of ed ? [ed] : host.editors()) e.setUndoDepth({ steps: d.steps, bytes: d.mb * 1048576 });
}

function newDocument(id) {
    const editor = new InpaintEditor({ id: id || host.nextId++, title: "Scumble" });
    editor.atlasMB = atlasMB;
    // a recipe brings its Settings rows here; the editor's own text speaks of wiring the node
    editor.noSettingsText = "This recipe has no settings of its own.";
    applyHistoryDepth(editor);
    host.addEditor(editor);
    editor.open();
    addCloudMode(editor);
    host.attachBrushTips(editor);      // the shared tip library and its save hook
    renderTabs();
    return editor;
}

function activate(editor) {
    host.activate(editor);
    window.editor = editor;   // for tests and the devtools console: always the active one
    renderTabs();
}

/** The tab's name: its .scumble file's stem, else the picture's file name (host.documentName). */
function docName(editor) {
    return host.documentName(editor);
}

function busy(editor) {
    return !!(editor.pending || editor.segmentPending || editor.cutoutPending || editor.upsamplePending || editor.objectsPending || editor._loading || editor.providerPending || editor._docSaving);
}

let tabSignature = "";

/** What the tab bar shows of a tab: busy dot, name, the "*" of unsaved changes, a save's or an open's progress. */
function tabKey(ed) {
    const p = ed._docProgress;
    return (busy(ed) ? "1" : "0") + (host.documentDirty(ed) ? "*" : "") + docName(ed) + (p ? `#${p.kind}${p.pct == null ? "" : p.pct}` : "") + (host.isActive(ed) ? "!" : "");
}

/** Cheap poll for the busy and the unsaved marker: a run or helper in a background tab shows a dot, a change a "*". */
setInterval(() => {
    const sig = host.editors().map(tabKey).join("|");
    if (sig !== tabSignature) renderTabs();
}, 1000);

let lastTitle = null;
/** The window title: the active document and its "*" (main adds the agents line, main.js showAgents). */
function syncTitle() {
    const ed = host.editor;
    const t = ed && ed.base ? `${docName(ed)}${host.documentDirty(ed) ? " *" : ""}` : "";
    if (t !== lastTitle) { lastTitle = t; try { window.scumble.setTitle(t); } catch (_) { /* an older preload */ } }
}

function renderTabs() {
    const list = ui.tabs;
    list.innerHTML = "";
    tabSignature = host.editors().map(tabKey).join("|");
    for (const ed of host.editors()) {
        const tab = document.createElement("div");
        tab.className = "shell-tab" + (host.isActive(ed) ? " active" : "");
        const where = ed.docFile && ed.docFile.path ? `\n${ed.docFile.path}` : ed.base ? "\nnot saved as a document yet" : "";
        tab.title = ed.base ? `${docName(ed)} · ${ed.width} × ${ed.height} · ${ed.layers.length} layer${ed.layers.length === 1 ? "" : "s"}${where}` : "Empty document";
        const dirty = host.documentDirty(ed);
        const name = document.createElement("span");
        name.className = "shell-tab-name" + (busy(ed) ? " shell-tab-busy" : "");
        name.textContent = (busy(ed) ? "● " : "") + docName(ed) + (dirty ? " *" : "");
        tab.appendChild(name);
        const p = ed._docProgress;
        if (p) {
            // a save's or an open's progress, with a cross that cancels it (the old file stays as it was)
            const chip = document.createElement("span");
            chip.className = "shell-tab-progress";
            chip.textContent = `${p.kind === "open" ? "Opening" : "Saving"}${p.pct == null ? "..." : ` ${p.pct} %`}`;
            const stop = document.createElement("span");
            stop.className = "shell-tab-progress-cancel"; stop.textContent = "×"; stop.title = p.kind === "open" ? "Cancel the open" : "Cancel the save (the file stays as it was)";
            stop.addEventListener("click", (e) => { e.stopPropagation(); host.cancelDocumentJob(ed); });
            chip.appendChild(stop);
            tab.appendChild(chip);
        }
        const close = document.createElement("span");
        close.className = "shell-tab-close"; close.textContent = "×"; close.title = "Close tab (Ctrl+W)";
        close.addEventListener("click", (e) => { e.stopPropagation(); closeDocument(ed); });
        tab.appendChild(close);
        tab.addEventListener("click", () => activate(ed));
        tab.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); closeDocument(ed); } });
        list.appendChild(tab);
    }
    syncTitle();
}

/**
 * Close a tab (docs/PLAN_DOCUMENTS.md §5.3): one with changes, or a picture never saved as a document, asks Save /
 * Don't Save / Cancel; one its file holds closes without a question; `force` (the close_document command) asks nothing.
 * The tab leaves the bar at once and goes on the closed list (Reopen Closed Tab) with its layers uploaded, then the
 * editor is destroyed. Resolves true when it closed.
 */
async function closeDocument(editor, { force = false } = {}) {
    if (!editor || !host.editors().includes(editor)) return false;
    if (!force && editor.base && busy(editor) && !(await dialogs.confirm(`${docName(editor)} is still working${editor._docSaving ? " (saving)" : ""}. Close it anyway?`, { ok: "Close", danger: true }))) return false;
    if (!force && editor.base && !editor._docSaving && host.documentDirty(editor)) {
        const choice = await host.askDocument({ kind: "close", name: editor.docFile ? editor.docFile.name : docName(editor), hasFile: !!editor.docFile });
        if (choice === "cancel" || !host.editors().includes(editor)) return false;
        if (choice === "save") {
            const r = await saveDocumentFromUi(editor);
            if (!r || !host.editors().includes(editor)) return false;      // cancelled or failed: the tab stays
        }
    }
    if (editor._docSaving) host.cancelDocumentJob(editor);        // closing anyway cancels its save; the file stays as it was
    // a turn snapshot of this document goes with the tab (A7): its clones hold tiles
    try { forgetDocument(editor.node && editor.node.id); } catch (err) { console.warn(err); }
    host.removeEditor(editor);
    editor.root.classList.add("shell-hidden");
    if (!host.editors().length) newDocument();
    activate(host.editor);
    host.saveAll();
    try { await host.rememberClosed(editor); } catch (err) { console.warn("closed tab", err); }
    try { editor.destroy(); } catch (err) { console.warn(err); }
    return true;
}

/** File › Reopen Closed Tab (Ctrl+Shift+T). */
async function reopenClosedTab() {
    try {
        const ed = await host.reopenClosed();
        if (!ed && host.editor) host.editor.setStatus("No closed tab to reopen.");
        renderTabs();
    } catch (err) {
        if (host.editor) host.editor.setStatus("Could not reopen the tab: " + String((err && err.message) || err));
    }
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
host.shell = { newDocument, activate, closeDocument, selectRecipe: (id, provider) => selectRecipe(id, provider), recipes: () => recipes, resolveRecipe, modeOf: (r) => modeOf(r), openSettings, openGenerateNew: (ed) => openGenerateNew(ed), openUpscale: (ed) => openUpscale(ed), genField: () => genField, genSyncRefs: () => genSyncRefs(),
    // list_recipes' readiness (docs/PLAN_0_1_42.md F2a): a resolved recipe's key or in-app model ({ ok, text } or null for
    // a ComfyUI recipe), and the API providers with whether a key is stored, as booleans only (never the key's hint)
    keyState: (r) => providerKeyState(r),
    providerKeys: () => providers.map((p) => ({ id: p.id, label: p.label, key: !!(p.key && p.key.set), shares_key: p.sharesKey || null })) };
ui.tabAdd.addEventListener("click", () => activate(newDocument()));

// ---- connection --------------------------------------------------------------------------

function showStatus(st) {
    lastStatus = st;
    ui.dot.className = "dot " + (st.state || "");
    ui.statusText.textContent = st.message || st.state || "";
    ui.statusText.title = [st.url, st.devices, st.auth ? "with auth headers" : ""].filter(Boolean).join("\n");
    ui.setConn.textContent = st.message || st.state || "";
    const comfyButton = document.getElementById("shell-comfy");
    if (comfyButton) comfyButton.title = `ComfyUI's own page${st.url ? " at " + st.url : ""} in a window of its own (Ctrl+Shift+K)`;
    // every status, not only connected ones: the Realism Pass checks the live state (host.connected is never set back)
    host.setServerStatus(st);
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
        lines.push(line(p.node ? "ok" : "bad", p.node ? `Inpaint Canvas node pack ${p.nodeVersion || "present"}` : "Inpaint Canvas node pack missing: install it there with git clone https://github.com/DenRakEiw/ComfyUI-InpaintCanvas in custom_nodes, then restart ComfyUI"));
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

const FAMILY_ORDER = ["ComfyUI", "Comfy Cloud", "In-app", "Google", "OpenAI", "Black Forest Labs", "ByteDance", "Qwen"];
/** A Comfy Cloud recipe running on Comfy Cloud: its graph variant is the chosen one (as the host's recipeMode reads it). */
const cloudModeOf = (r) => cloudGraphOf(r) && chosenProvider(r) === "comfycloud";
const familyOf = (r) => (cloudModeOf(r) ? "Comfy Cloud" : r.kind === "provider" ? (r.family || "API providers") : "ComfyUI");
/**
 * local = a ComfyUI recipe on the result_local chain, api = a provider recipe or a ComfyUI recipe of API nodes, cloud =
 * a Comfy Cloud recipe, a graph of its own run on Comfy Cloud (item 35 V6).
 */
const modeOf = (r) => (cloudModeOf(r) ? "cloud" : r.kind === "provider" || r.mode === "api" ? "api" : "local");

/**
 * The editor's local / api select gets the app's third mode, cloud (item 35 V6): the select is built by the editor,
 * which the node shares, so the option is added here once the editor is open.
 */
function addCloudMode(editor) {
    const sel = editor.modeSel;
    if (!sel || Array.from(sel.options).some((o) => o.value === "cloud")) return;
    sel.add(new Option("comfy cloud", "cloud"));
    sel.title = "Which recipes the picker in the title row lists: local = ComfyUI recipes on your ComfyUI, api = model providers, comfy cloud = Comfy Cloud recipes (they run on Comfy Cloud with your Comfy Cloud key).";
    editor.syncGenControls();
}

async function loadRecipes() {
    recipes = await window.scumble.recipes.list();
    // ComfyUI first, then the model families in a fixed order, unknown families after, names within
    const rank = (r) => { const i = FAMILY_ORDER.indexOf(familyOf(r)); return i < 0 ? FAMILY_ORDER.length : i; };
    recipes.sort((a, b) => rank(a) - rank(b) || familyOf(a).localeCompare(familyOf(b)) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
    const cur = recipes.find((r) => r.id === (ui.recipe.value || settings.recipe));
    renderRecipeOptions(cur ? modeOf(cur) : (ui.recipe.dataset.mode || "local"));
}

/** The recipe select lists the recipes of one mode: the editor's local / api / cloud select switches between them. */
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
    return (p && p.label) || (id === "loopback" ? "Loopback" : id === "inapp" ? "In-app" : id);
}

/** The provider a model recipe runs on: the remembered choice, else the recipe's default. */
function chosenProvider(r) {
    if (r.kind !== "provider" || !r.providers) return null;
    const want = (settings.recipeProviders || {})[r.id];
    return want && r.providers[want] ? want : (r.default || Object.keys(r.providers)[0]);
}

/** The recipe with the chosen provider's variant merged in (what host and the commands see). */
function resolveRecipe(r, pid = chosenProvider(r)) {
    if (!pid) return r;
    const v = r.providers[pid] || {};
    return { ...r, provider: pid, providerLabel: providerLabel(pid), model: v.model || "", input: v.input || "fill", fields: v.fields || null, fixed: v.fixed || null, settings: v.settings || [], options: v.options || null, note: v.note || "", text: v.text || null, limits: v.limits || null, edit: v.edit !== false, task: r.task || "edit", factor: v.factor || null, usesPrompt: !!v.usesPrompt, refs: v.refs || null };
}

function providerKeyState(r) {
    if (r.kind !== "provider") return null;
    const p = providers.find((x) => x.id === r.provider);
    if (r.provider === "inapp") {
        // no key: the model in the app's model folder (Settings › Helpers)
        return host.presentHelpers("inpaint").some((m) => m.id === r.model) ? { ok: true } : { ok: false, text: "the LaMa model is not downloaded yet: Settings (Ctrl+,) › Helpers (in-app models)" };
    }
    if (!p) return r.provider === "loopback" ? { ok: true } : { ok: false, text: `unknown provider "${r.provider}"` };
    if (p.key && p.key.stale) return { ok: false, text: `the ${p.label} key was stored on another PC or Windows account: type it again in Settings (Ctrl+,) › API providers` };
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
    ui.recipeNote.style.color = ks && !ks.ok ? "var(--sc-warn, #e0a05a)" : "";
    host.setRecipe(r);
    const comfyEdit = $("shell-comfy-edit");
    if (comfyEdit) comfyEdit.hidden = raw.kind === "provider" && !cloudGraphOf(raw);
    const byMode = { ...(settings.recipeByMode || {}), [modeOf(raw)]: raw.id };
    if (settings.recipe !== r.id || (settings.recipeByMode || {})[modeOf(raw)] !== raw.id) window.scumble.settings.set({ recipe: r.id, recipeByMode: byMode }).then((s) => { settings = s; });
    if (ui.settings.open) syncRecipeRows();
}
ui.recipe.addEventListener("change", () => selectRecipe(ui.recipe.value));

// The editor's local / api / cloud select: switch to the recipe last used in that mode (else the first one).
host.onModeChanged = (mode, editor) => {
    const cur = recipes.find((x) => x.id === ui.recipe.value);
    if (cur && modeOf(cur) === mode) return;
    const want = (settings.recipeByMode || {})[mode];
    const r = recipes.find((x) => x.id === want && modeOf(x) === mode) || recipes.find((x) => modeOf(x) === mode);
    if (r) { selectRecipe(r.id); return; }
    if (cur) { editor.genSettings.mode = modeOf(cur); editor.syncGenControls(); }
    editor.setStatus(mode === "api" ? "No API recipe: add a provider key in Settings (Ctrl+,) › API providers."
        : mode === "cloud" ? "No Comfy Cloud recipe yet: open a workflow or one of Comfy's templates in the ComfyUI window on Comfy Cloud and Save as new recipe, or import one exported from Comfy Cloud (Settings › Recipes)."
        : "No ComfyUI recipe installed.");
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
    return `${v.model || ""}${ks && !ks.ok ? (v.provider === "inapp" ? " · model not downloaded" : " · no key") : ""}`;
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
        } else if (r.kind !== "provider") {
            // a ComfyUI recipe has no provider to pick: its graph opens in the ComfyUI window (item 35 V2), and a copy
            // without the Inpaint Canvas node runs on Comfy Cloud (V5c)
            const cell = document.createElement("span");
            cell.className = "shell-recipe-actions";
            const edit = document.createElement("button");
            edit.type = "button"; edit.textContent = "Edit in ComfyUI"; edit.title = "Open this recipe's graph in the ComfyUI window";
            edit.addEventListener("click", () => openRecipeInComfy(r.id));
            const copy = document.createElement("button");
            copy.type = "button"; copy.textContent = "Cloud copy"; copy.title = "Save a copy without the Inpaint Canvas node that runs on Comfy Cloud (your Comfy Cloud key)";
            copy.addEventListener("click", () => cloudCopyOf(r));
            // the Realism Pass runs on the user's own ComfyUI only (docs/PLAN_0_1_42.md §1): no Cloud copy
            if (r.task === "pass") cell.append(edit); else cell.append(edit, copy);
            row.appendChild(cell);
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
            if (!(await dialogs.confirm(`Remove the recipe "${r.name || r.id}"?`, { ok: "Remove", danger: true }))) return;
            try { await window.scumble.recipes.remove(r.id); await loadRecipes(); renderRecipeList(); selectRecipe(settings.recipe); } catch (err) { ui.recipeNoteSet.textContent = String(err.message || err); }
        });
        row.appendChild(del);
        ui.recipes.appendChild(row);
    }
    syncRecipeRows();
}

/** Settings › Recipes, Cloud copy: the recipe without its Inpaint Canvas node, as a Comfy Cloud recipe (item 35 V5c). */
async function cloudCopyOf(r) {
    ui.recipeNoteSet.textContent = "";
    try {
        const c = await window.scumble.recipes.cloudCopy(r.id);
        await loadRecipes();
        renderRecipeList();
        selectRecipe(c.id);
        ui.recipeNoteSet.textContent = `${c.replaced ? "Replaced" : "Saved"} "${c.name}": it runs on your Comfy Cloud key (API providers)` + (c.notes && c.notes.length ? ": " + c.notes.join("; ") : ".");
    } catch (err) {
        ui.recipeNoteSet.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
    }
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
        if (p.sharesKey) continue;   // Comfy Router runs on the Comfy Cloud row's key
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
        // a key stored on another PC or Windows account (DPAPI cannot read it here, keys.js stale): kept, never cleared
        // by itself, replaced by the one typed here
        state.className = "shell-key-state" + (k.stale ? " shell-warn" : k.set ? " set" : "");
        clear.disabled = !k.set;
        state.textContent = k.stale ? "stored on another PC or Windows account: type it again" : k.set ? `key set (…${k.hint})` : "no key";
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
    showKeysNote(info);
}

/** Writes keysNote(info) into the API keys section. */
export function showKeysNote(info) {
    const note = keysNote(info);
    ui.keysNote.textContent = note.text;
    ui.keysNote.classList.toggle("shell-warn", note.warn);
    return note;
}

/**
 * What the API keys section says about the credential store. On Linux Chromium falls back to
 * `basic_text` when no keyring (GNOME Keyring, KWallet) answers: safeStorage still "works", but
 * with a fixed key, so the keys are obfuscated, not encrypted, and the user has to be told.
 */
export function keysNote(info) {
    if (!info || !info.available) return { warn: true, text: "This system offers no credential store (safeStorage unavailable): keys cannot be saved." };
    if (info.backend === "basic_text") {
        return { warn: true, text: "No keyring answered (basic_text): keys in secrets.json are only obfuscated, not encrypted, and anyone who can read your profile folder can read them. Install and unlock a keyring (GNOME Keyring or KWallet), then restart Scumble (a key that reads as unset afterwards has to be entered again)." };
    }
    return { warn: false, text: `Keys are encrypted with the system credential store (${info.backend}) and stored in secrets.json; they never leave this machine except in the request to the provider itself.` };
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
// the prompt field with reference chips (docs/PLAN_REFS.md 26f): the tab's references, named as the dialog's model gets them
let genField = null;
let genInfo = null;          // host.refLayout's answer for the dialog's model (not the tab's recipe)
let genInfoSeq = 0;
let genRemapOff = null;      // the field as a remap target of genEditor while the dialog is open
let genPrevious = null;      // the text before an upsample (Revert)
let genOpenSeq = 0;          // counts the dialog's openings: an upsample answer belongs to the one it was asked in

/** The prompt field, made once (after genEditor exists, since its bar asks for the references at once). */
function genMountField() {
    if (genField) return;
    genField = new PromptField({
        placeholder: "what the picture shows; type @ to name a reference image",
        refs: () => (genEditor ? genEditor.refContext(genInfo) : null),
        popupRoot: ui.gen,
        // a picture pasted, dropped or chosen here becomes a reference layer of the tab (a white canvas first in an
        // empty tab, which Generate new replaces)
        addReferences: async (files) => {
            const ids = genEditor ? await genEditor.addReferencesForPrompt(files) : [];
            await genSyncRefs();
            return ids;
        },
        preview: (id, canvas) => { if (genEditor) genEditor.refPreview(id, canvas); },
    });
    genField.el.id = "gen-prompt";
    genField.el.spellcheck = false;
    ui.genPromptHost.appendChild(genField.el);
    new RefBar(genField, { mount: ui.genRefbar });
    ui.genPrompt = genField.el;
}

/**
 * What each reference goes as with the dialog's model: an API variant's text route (host.refLayout kind "text"), a
 * local recipe's batch with the white canvas as picture 1, all of it selected (generate_new's local path); then the
 * chips and the bar are drawn again. The last call wins.
 */
async function genSyncRefs() {
    if (!genEditor || !genField) return;
    const seq = ++genInfoSeq;
    const r = recipes.find((x) => x.id === ui.genRecipe.value);
    let info = null;
    try {
        if (r && r.kind === "provider" && ui.genProvider.value) {
            info = await host.refLayout(genEditor, { recipe: resolveRecipe(r, ui.genProvider.value), kind: "text" }, { keep: false });
        } else if (r && r.kind !== "provider" && r.task !== "upscale") {
            const gen = { ...genEditor.genSettings, mode: r.mode === "api" ? "api" : "local" };
            info = await host.refLayout(genEditor, { recipe: r, state: { hasSelection: true, crop: genEditor.cropSettings, gen } }, { keep: false });
        }
    } catch (err) { console.warn("generate new: reference layout", err); }
    if (seq !== genInfoSeq) return;
    genInfo = info;
    genField.refresh();
}

/** The recipes that can start from nothing, for the mode the dialog is on (cloud: the Comfy Cloud recipes, V6). */
function genRecipesFor(mode) {
    // an upscaler or the Realism Pass makes nothing from a prompt: both work on a picture
    return recipes.filter((r) => (mode === "local" ? r.kind === "comfy" && r.task !== "upscale" && r.task !== "pass" : r.kind === "provider" && (mode === "cloud") === cloudModeOf(r) && genProviderIds(r).length));
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
        o.textContent = mode === "local" ? "no ComfyUI recipe installed" : mode === "cloud" ? "no Comfy Cloud recipe makes new images" : "no API model with a text-to-image endpoint";
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
    genSyncRefs();
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

/**
 * The instruction for "Upsample prompt" in this dialog: a template, or the plain rewrite. `refs`: the references the
 * prompt names ([{ id, n, name }], 26d1): the template's {references} and the token rule, or the same after the plain
 * rewrite's request.
 */
function genInstruction(text, refs = []) {
    const t = host.promptTemplates.find((x) => x.id === ui.genTemplate.value);
    const [w, h] = genSize();
    const ctx = { prompt: text, aspect: ui.genAspect.value === "free" ? `${w}:${h}` : ui.genAspect.value, width: w, height: h, useCase: "generate", references: refs };
    if (t) return host.fillPromptTemplate(t, ctx);
    const plain = `Rewrite this into one rich prompt for an image model. Keep every subject, colour and material the request names. Describe only what is seen, as one paragraph, no lists, no preamble, no quotes. Request: ${text}`;
    return refs.length ? `${plain}\n\n${referencesText(refs).trim()} ${referencesRule(refs)}` : plain;
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
    genOpenSeq++;
    if (!ui.genAspect.options.length) {
        for (const a of GEN_ASPECTS) {
            const o = document.createElement("option");
            o.value = a;
            o.textContent = a === "free" ? "free (width × height)" : a;
            ui.genAspect.appendChild(o);
        }
        ui.genAspect.value = "1:1";
    }
    // the dialog opens on the editor's mode (local, api or cloud) when that has a recipe for a new image
    const curRaw = host.recipe && recipes.find((x) => x.id === host.recipe.id);
    const curMode = curRaw ? (curRaw.kind === "comfy" ? "local" : modeOf(curRaw)) : "api";
    ui.genMode.value = genRecipesFor(curMode).length ? curMode : (genRecipesFor("local").length ? "local" : "api");
    if (!ui.genResolution.options.length) ui.genResolution.value = "1024";
    genMountField();
    genInfo = null;
    genFillRecipes();
    genFillUpsample();
    genFillTemplates();
    // the tab's prompt with its @img tokens as chips (26f): they name the reference layers, which go along where the
    // model takes them; the field follows the references like the tab's own prompt while the dialog is open
    genField.setText(genEditor.promptText || "", { history: "reset" });
    genPrevious = null;
    if (genRemapOff) genRemapOff();
    const field = genField;
    genRemapOff = genEditor.addRemapTarget({ get value() { return field.el.value; }, setText: (t, o) => { field.setText(t, o); genSyncRefs(); } });
    // the boxes take 64 to 8192 (genSize clamps to that too): a larger document shows what will be asked for
    ui.genWidth.value = Math.max(64, Math.min(8192, genEditor.width || 1024));
    ui.genHeight.value = Math.max(64, Math.min(8192, genEditor.height || 1024));
    ui.genSeed.value = genEditor.genSettings.seed;
    ui.genSeedRandom.checked = !!genEditor.genSettings.seedRandom;
    ui.genState.textContent = "";
    ui.genUpsampleNote.textContent = "";
    genSyncSize();
    ui.gen.showModal();
    genField.focus();
}

ui.genMode.addEventListener("change", genFillRecipes);
ui.genRecipe.addEventListener("change", genFillProviders);
ui.genProvider.addEventListener("change", () => { genFillSizes(); genTransparencyRow(); genSyncNote(); genSyncRefs(); });
ui.genTemplate.addEventListener("change", () => {
    genSyncTemplateNote();
    window.scumble.settings.set({ promptTemplates: { ...(settings.promptTemplates || {}), generate: ui.genTemplate.value } }).then((s) => { settings = s; }).catch(() => { /* not fatal */ });
});
ui.genAspect.addEventListener("change", genSyncSize);
ui.genResolution.addEventListener("change", genSyncSize);
for (const el of [ui.genWidth, ui.genHeight]) el.addEventListener("input", genSyncSize);
ui.gen.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });
// Escape with the @ picker or the swap menu open closes that, not the dialog (a file input's cancel bubbles here too)
ui.gen.addEventListener("cancel", (e) => {
    if (e.target !== ui.gen || !genField || !genField.popupOpen()) return;
    e.preventDefault();
    genField.closePopups();
});
ui.gen.addEventListener("close", () => {
    if (genRemapOff) { genRemapOff(); genRemapOff = null; }
    if (genField) genField.closePopups();
});

ui.genUpsampleGo.addEventListener("click", async () => {
    const backend = host.upsampleBackends().find((b) => b.id === ui.genUpsample.value);
    if (!backend) return;
    // the dialog and the tab of the click: an answer that comes back after the dialog was closed or opened again (for
    // another tab, say) is dropped, never written into that other prompt
    const ed = genEditor, seq = genOpenSeq;
    const stale = () => seq !== genOpenSeq || ed !== genEditor || !ui.gen.open;
    const before = genField.el.value;
    if (!before.trim()) { ui.genUpsampleNote.textContent = "Write something first."; return; }
    // the @img tokens (26d1): the request and its labels as they are now, the references it names
    const labels = ed ? ed.refLabels() : new Map();
    const request = remap(before, labels, labels).trim();
    const why = ed ? ed.upsampleRefProblems(request, labels) : "";
    if (why) { ui.genUpsampleNote.textContent = `Upsampling needs every @img token to name a shown reference: ${why}.`; return; }
    const refs = ed ? ed.namedRefs(request, labels) : [];
    ui.genUpsampleGo.disabled = true;
    ui.genUpsampleNote.textContent = "asking " + backend.label.replace(/ \(.*\)$/, "") + " ...";
    try {
        // the named reference pictures go along while the setting is on (26d2)
        const images = host.llmRefPictures && refs.length && ed ? await host.llmPictures(ed, refs) : [];
        if (stale()) return;
        const res = await host.askLLM(backend, genInstruction(request, refs), null, images);
        if (stale()) return;
        let text = normalizeTokens(String(res.text || "").trim());
        // checked in the numbering of the click, then carried to the references of now (a hide or a move meanwhile);
        // Revert's text is carried the same way, so it names the same layers the answer does
        const cmp = refs.length ? compare(request, text, refs.map((x) => x.n)) : null;
        const now = ed ? ed.refLabels() : labels;
        const carry = (t) => remap(t, labels, now);
        if (cmp) { cmp.dropped = cmp.dropped.map(carry); cmp.invented = cmp.invented.map(carry); }
        text = carry(text);
        genPrevious = carry(before);
        genField.setText(text);
        const note = cmp ? checkNote(cmp) : "";
        ui.genUpsampleNote.textContent = `${text.split(/\s+/).length} words in ${res.seconds.toFixed(1)} s${res.note ? ", " + res.note : ""}.${note ? " " + note : ""}`;
        const revert = document.createElement("button");
        revert.type = "button";
        revert.id = "gen-upsample-revert";
        revert.textContent = "Revert";
        revert.title = "Put the prompt from before the upsample back";
        revert.addEventListener("click", () => {
            if (stale() || genPrevious == null) return;
            // the old text follows the references too
            genField.setText(remap(genPrevious, now, ed ? ed.refLabels() : now));
            genPrevious = null;
            revert.remove();
        });
        ui.genUpsampleNote.append(" ", revert);
    } catch (err) {
        if (!stale()) ui.genUpsampleNote.textContent = String(err.message || err);
    } finally {
        // a stale answer leaves the button to the dialog that is open now
        if (!stale()) ui.genUpsampleGo.disabled = false;
    }
});

ui.genGo.addEventListener("click", async () => {
    const ed = genEditor || host.editor;
    if (!ed) return;
    const id = ui.genRecipe.value;
    if (!id) { ui.genState.textContent = "No model to run this on."; return; }
    const prompt = (genField.el.value || "").trim();
    if (!prompt) { ui.genState.textContent = "Write a prompt first."; genField.focus(); return; }
    // which layer each token means at the click (a change after it refuses rather than re-points)
    const refs = Object.fromEntries([...ed.refLabels()].map(([lid, n]) => ["img" + n, lid]));
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
        if (Object.keys(refs).length) args.refs = refs;
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

// ---- Upscale: the selection or the whole picture through an upscale recipe -----------

let upEditor = null;
// the scope chosen before the Realism Pass entry forced the whole picture: back when another entry is chosen
let upScopeBeforePass = null;
// how the prompt's @img tokens go to an upscaler (as the layers' names); the pass sends no prompt, so it shows none
let upRefNote = "";
// the factor last shown for an upscaler: the pass's 1× would otherwise be kept as the next upscaler's factor (a paid run
// that enlarges nothing); the pass keeps its own (1× until another is picked: an upscaler's 2× never carries over to
// the pass, which would make the document larger)
let upLastFactor = 0;
let upPassFactor = 1;

/**
 * The dialog's entries, in the recipe list's order: the upscale recipes (`task: "upscale"`: API models and upscale
 * models on ComfyUI) and the Realism Pass (`task: "pass"`: the whole picture at 1x, docs/PLAN_0_1_42.md R3b).
 */
function upRecipes() {
    return recipes.filter((r) => r.task === "upscale" || r.task === "pass");
}

const isPassRecipe = (r) => !!r && r.task === "pass";

/** The factors a variant offers: its `steps`, else whole numbers min..max; none when the model picks. */
export function upFactors(v) {
    const f = (v && v.factor) || { default: 2, min: 1, max: 4 };
    if (f.fixed) return [];
    if (Array.isArray(f.steps) && f.steps.length) return f.steps.slice();
    const out = [];
    for (let x = Math.ceil(f.min); x <= Math.floor(f.max); x++) out.push(x);
    return out.length ? out : [f.default];
}

function upVariant() {
    const r = recipes.find((x) => x.id === ui.upRecipe.value);
    return { r, v: (r && r.providers && r.providers[ui.upProvider.value]) || null };
}

function upFillRecipes() {
    const list = upRecipes();
    const keep = ui.upRecipe.value;
    ui.upRecipe.innerHTML = "";
    for (const r of list) {
        const o = document.createElement("option");
        o.value = r.id;
        o.textContent = r.name || r.id;
        ui.upRecipe.appendChild(o);
    }
    if (!list.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "no upscale recipe installed";
        ui.upRecipe.appendChild(o);
    }
    const cur = host.recipe && (host.recipe.task === "upscale" || isPassRecipe(host.recipe)) ? host.recipe.id : settings.upscaleRecipe;
    if (list.some((r) => r.id === cur)) ui.upRecipe.value = cur;
    else if (list.some((r) => r.id === keep)) ui.upRecipe.value = keep;
    upFillProviders();
}

function upFillProviders() {
    const r = recipes.find((x) => x.id === ui.upRecipe.value);
    const ids = (r && r.providerIds) || [];
    ui.upProviderRow.hidden = ids.length < 2;
    const keep = ui.upProvider.value;
    ui.upProvider.innerHTML = "";
    for (const pid of ids) {
        const o = document.createElement("option");
        o.value = pid;
        o.textContent = providerOptionLabel(pid);
        ui.upProvider.appendChild(o);
    }
    if (r && ids.includes(chosenProvider(r))) ui.upProvider.value = chosenProvider(r);
    else if (ids.includes(keep)) ui.upProvider.value = keep;
    upFillFactors();
}

/** An entry's factors as [value, text] pairs: none when the model picks its own. */
function upFactorOptions(r, v) {
    // the Realism Pass refines at the picture's own size, or makes it larger by DLSS's modes (R-U: 1.7× is its 1.724x)
    if (isPassRecipe(r)) return realism.MODES.map((m) => [m.factor, m.text]);
    // a ComfyUI upscaler has no variant: an upscale model picks its own factor (none shown), RTX Video Super Resolution
    // takes one (its recipe's `factor.input`); the stitch fits the answer to the box either way
    const comfy = !v && r && r.kind !== "provider" && r.factor && !r.factor.fixed ? { factor: r.factor } : null;
    return (v ? upFactors(v) : comfy ? upFactors(comfy) : []).map((f) => [f, `${f}×`]);
}

function upFillFactors() {
    const { r, v } = upVariant();
    const list = upFactorOptions(r, v);
    const keep = isPassRecipe(r) ? upPassFactor : ui.upFactor.dataset.pass ? upLastFactor : +ui.upFactor.value || 0;
    ui.upFactor.innerHTML = "";
    for (const [f, text] of list) {
        const o = document.createElement("option");
        o.value = String(f);
        o.textContent = text;
        ui.upFactor.appendChild(o);
    }
    ui.upFactorRow.hidden = !list.length;
    const values = list.map(([f]) => f);
    const dflt = v && v.factor ? v.factor.default : r && r.kind !== "provider" && r.factor && !r.factor.fixed ? r.factor.default : values[0];
    if (values.length) ui.upFactor.value = String(values.includes(keep) ? keep : (values.includes(dflt) ? dflt : values[0]));
    ui.upFactor.dataset.pass = isPassRecipe(r) ? "1" : "";
    upNoteFactor();
    upSyncNote();
}

/** Remember an upscaler's factor and the pass's apart, so neither carries over to the other. */
function upNoteFactor() {
    if (!ui.upFactor.options.length) return;
    if (ui.upFactor.dataset.pass) upPassFactor = +ui.upFactor.value || 1;
    else upLastFactor = +ui.upFactor.value || 0;
}

/** The open dialog's Realism Pass entry again, as the server, its node list or settings.realism are now. */
function upResyncPass() {
    if (ui.up.open && isPassRecipe(upVariant().r)) upSyncNote();
}
host.on("realism", upResyncPass);

/** What the run will send and get back, and why the whole-picture mode may be refused. */
function upSyncNote() {
    const ed = upEditor || host.editor;
    const { r, v } = upVariant();
    ui.upPassRow.hidden = !isPassRecipe(r);
    ui.upState.textContent = isPassRecipe(r) ? "" : upRefNote;
    if (isPassRecipe(r)) { upSyncPass(ed); return; }
    // another entry after the pass: the selection usable again, and the scope chosen before the pass back
    ui.upScopeSel.disabled = false;
    ui.upScopeSel.parentElement.title = "";
    if (upScopeBeforePass) { (upScopeBeforePass === "selection" ? ui.upScopeSel : ui.upScopeDoc).checked = true; upScopeBeforePass = null; }
    const comfy = !!r && r.kind !== "provider";
    ui.upScopeDoc.disabled = false;
    // only an upscaler that takes guidance (Clarity, Magnific Creative: `usesPrompt`) shows the prompt
    ui.upPromptRow.hidden = !(v && v.usesPrompt);
    if (comfy) {
        // the whole picture through the recipe's graph (host.runComfyUpscale, the classes it queues), or the selection's
        // box through the node, whose stitch fits the answer back into it (the recipe's `needs`)
        const doc = ui.upScopeDoc.checked;
        let lacks = [], shape = "";
        if (doc) shape = comfyprompt.wholePictureRefusal(r);
        if (host.connected && !shape) {
            const classes = doc ? comfyprompt.wholePictureClasses(r) : (r.needs || []);
            lacks = classes.filter((n) => host.objectInfo && !host.objectInfo[n]);
        }
        const why = !host.connected ? " Not connected to ComfyUI: Settings › ComfyUI."
            : lacks.length ? ` The server lacks these node types: ${lacks.join(", ")}.` : "";
        ui.upNote.textContent = (r.description || "") + why;
        // a factor the recipe takes (RTX Video Super Resolution); an upscale model picks its own (none shown)
        const f = r.factor && !r.factor.fixed ? +ui.upFactor.value || r.factor.default : null;
        if (doc) {
            const W = (ed && ed.width) || 0, H = (ed && ed.height) || 0;
            const refusal = shape || (!(ed && ed.base && W && H) ? "Load an image first." : host.upscaleSizeRefusal(r, W, H, f, "picture"));
            const back = f != null ? `about ${Math.round(W * f)} × ${Math.round(H * f)} comes back` : "the model's larger answer comes back";
            ui.upSizeNote.textContent = refusal || `${W} × ${H} (the base picture alone) goes out to your ComfyUI, ${back} and becomes the picture; every layer, mask and the selection scale along. A cut-out picture comes back opaque on this route, black where it was transparent.`;
            ui.upGo.disabled = !!why || !!refusal;
            return;
        }
        const sel = !!(ed && ed.getBounds && ed.getBounds());
        // the box the node cuts, its answer and the size limits
        let refusal = "", sized = "";
        if (sel && f != null && ed.cropRect) {
            const [, , cw, ch] = ed.cropRect();
            const m = Math.max(1, +(host.nodeParams && host.nodeParams.multiple_of) || 8);
            const bw = realism.fitSpan(cw, ed.width, m), bh = realism.fitSpan(ch, ed.height, m);
            refusal = host.upscaleSizeRefusal(r, bw, bh, f, "box");
            sized = ` The box with its context (${bw} × ${bh}) comes back at about ${Math.round(bw * f)} × ${Math.round(bh * f)} and is fitted back into it by the node's stitch.`;
        }
        ui.upSizeNote.textContent = !sel
            ? "Select an area first, or pick the whole picture: on the selection an upscaler on ComfyUI sharpens the selection's box."
            : refusal || (f != null
                ? `The selection's box (with its context) goes out at its own size.${sized}`
                : "The selection's box (with its context) goes out at its own size; the model's larger answer is fitted back into it by the node's stitch.");
        ui.upGo.disabled = !sel || !!why || !!refusal;
        return;
    }
    if (!r || !v) { ui.upNote.textContent = ""; ui.upSizeNote.textContent = ""; ui.upGo.disabled = true; return; }
    const pid = ui.upProvider.value;
    const key = (providers.find((p) => p.id === pid) || {}).key;
    const missing = pid === "loopback" || (key && key.set) ? "" : ` No ${providerLabel(pid)} key stored yet: Settings › API providers.`;
    ui.upNote.textContent = (r.description || "") + missing;
    const doc = ui.upScopeDoc.checked;
    const f = v.factor && !v.factor.fixed ? +ui.upFactor.value || v.factor.default : null;
    const max = (v.limits && v.limits.max) || 2048;
    // an answer cap (limits.out: RTX Video Super Resolution on Comfy Cloud), refused here as host.runUpscale refuses it
    const capped = { limits: v.limits };
    let text = "", ok = true;
    if (ed && ed.width) {
        if (doc) {
            const long = Math.max(ed.width, ed.height);
            const over = host.upscaleOutRefusal(capped, ed.width, ed.height, f, "picture");
            if (long > max) { ok = false; text = `The picture is ${ed.width} × ${ed.height}; this model takes at most ${max} px on the long side. Upscale a selection instead.`; }
            else if (over) { ok = false; text = over; }
            else text = f ? `${ed.width} × ${ed.height} goes out, about ${Math.round(ed.width * f)} × ${Math.round(ed.height * f)} comes back and becomes the picture.` : `${ed.width} × ${ed.height} goes out; the model picks the size that comes back.`;
        } else {
            // the box as runUpscale will send it (held to the limits), only where the answer has a cap
            const fr = v.limits && v.limits.out && f != null ? host.upscaleFrame(ed, v.limits) : null;
            const over = fr ? host.upscaleOutRefusal(capped, fr.emitted[0], fr.emitted[1], f, "sent") : "";
            if (over) { ok = false; text = over; }
            else text = `The selection's box (with its context) goes out at its own size, up to ${max} px on the long side, and the sharper answer is fitted back into it.`;
        }
    }
    ui.upSizeNote.textContent = text;
    ui.upGo.disabled = !ok;
}

/**
 * The Realism Pass entry (docs/PLAN_0_1_42.md R3b, R-U): the whole picture only, at 1× (refine) or 1.5× to 3× (the
 * picture made larger first), its Style / Strength / Preset row (settings.realism, the app's), and Upscale greyed with
 * the reason the server (§3.3) or the picture's size gives (1×: §3.5's cap; above: realism.fitPlan, a picture whose
 * output would pass the cap scaled down instead, the note says to what); host.realismWhole refuses the same before
 * anything is read.
 */
function upSyncPass(ed) {
    const L = realism.LABEL;
    if (!upScopeBeforePass) upScopeBeforePass = ui.upScopeSel.checked ? "selection" : "document";
    ui.upScopeDoc.disabled = false;
    ui.upScopeDoc.checked = true;
    ui.upScopeSel.disabled = true;
    ui.upScopeSel.parentElement.title = `${L} runs over the whole picture.`;
    ui.upPromptRow.hidden = true;
    ui.upProviderRow.hidden = true;
    upFillPassRow();
    const support = host.realismSupport();
    const W = (ed && ed.width) || 0, H = (ed && ed.height) || 0;
    const mode = realism.modeFor(+ui.upFactor.value || 1) || realism.MODES[0];
    const plan = mode.factor > 1 && W && H ? realism.fitPlan(W, H, mode.factor) : null;
    const size = !(ed && ed.base && W && H) ? `${L}: load an image first.` : plan ? plan.refusal : realism.wholeRefusal(W, H);
    ui.upNote.textContent = support.ok
        ? [`DLSS 5 Neural Rendering over the whole visible picture, on your own ComfyUI: generated skin, hair and fabric look less waxy.`, support.note].filter(Boolean).join(" ")
        : support.reason;
    const rest = `no colour match; a second run stacks. ${L} runs over the whole picture: the selection is not used.`;
    ui.upSizeNote.textContent = size || (plan
        ? `${W} × ${H} goes out at ${mode.text}${plan.scaled ? `, scaled down to ${plan.fit[0]} × ${plan.fit[1]} first (its output is capped at ${realism.CAP_TEXT})` : ""}: the picture becomes ${plan.doc[0]} × ${plan.doc[1]}, every layer scaled along, and the pass comes back as a new layer above it (under the filter layers at the top, which stay live), ${rest} One Ctrl+Z takes both back.`
        : `${W} × ${H} goes out at 1× and comes back as a new layer above the picture (under the filter layers at the top, which stay live), ${rest}`);
    ui.upGo.disabled = !support.ok || !!size;
}

/** The pass row's controls as settings.realism is now (a refused model preset shows its fallback, Default, here). */
function upFillPassRow() {
    const fill = (sel, list) => {
        if (sel.options.length === list.length) return;
        sel.innerHTML = "";
        for (const x of list) { const o = document.createElement("option"); o.value = x; o.textContent = x; sel.appendChild(o); }
    };
    fill(ui.upPassStyle, realism.STYLES);
    fill(ui.upPassPreset, realism.MODEL_PRESETS);
    const v = host.realismValues();
    ui.upPassStyle.value = v.style;
    ui.upPassPreset.value = v.preset;
    ui.upPassStrength.value = String(v.intensity);
    ui.upPassStrengthV.textContent = v.intensity.toFixed(2);
}

// each control writes settings.realism whole (host.setRealismValues fills the rest; the key is `intensity`)
ui.upPassStyle.addEventListener("change", () => { host.setRealismValues({ style: ui.upPassStyle.value }); });
ui.upPassPreset.addEventListener("change", () => { host.setRealismValues({ preset: ui.upPassPreset.value }); });
ui.upPassStrength.addEventListener("input", () => { ui.upPassStrengthV.textContent = (+ui.upPassStrength.value).toFixed(2); });
ui.upPassStrength.addEventListener("change", () => { host.setRealismValues({ intensity: +ui.upPassStrength.value }); });

/**
 * The dialog. Nothing changes until Upscale is pressed; then the recipe (and provider) is selected, so its
 * settings stay in the Settings panel afterwards, and the `upscale` command runs, the path agents take too. The
 * Realism Pass entry selects no recipe and runs `realism_pass`. `opts.recipe`: the entry to show chosen (the Image
 * menu's Realism Pass item).
 */
export function openUpscale(editor, opts = {}) {
    upEditor = editor || host.editor;
    if (!upEditor) return;
    upFillRecipes();
    if (opts.recipe && upRecipes().some((r) => r.id === opts.recipe)) { ui.upRecipe.value = opts.recipe; upFillProviders(); }
    const hasSel = !!(upEditor.getBounds && upEditor.getBounds());
    upScopeBeforePass = null;
    (hasSel ? ui.upScopeSel : ui.upScopeDoc).checked = true;
    // an upscale sends no reference picture: the prompt's @img tokens come in as the layers' names
    const named = host.refNames(upEditor, upEditor.promptText || "");
    upRefNote = named.note;
    ui.upPrompt.value = named.text;
    upSyncNote();
    ui.up.showModal();
}

ui.upRecipe.addEventListener("change", upFillProviders);
ui.upProvider.addEventListener("change", upFillFactors);
ui.upFactor.addEventListener("change", () => { upNoteFactor(); upSyncNote(); });
ui.upScopeSel.addEventListener("change", upSyncNote);
ui.upScopeDoc.addEventListener("change", upSyncNote);
ui.up.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });

ui.upGo.addEventListener("click", async () => {
    const ed = upEditor || host.editor;
    if (!ed) return;
    const id = ui.upRecipe.value;
    if (!id) { ui.upState.textContent = "No upscale recipe to run."; return; }
    const pass = isPassRecipe(recipes.find((r) => r.id === id));
    ui.upGo.disabled = true;
    try {
        // the pass selects no recipe: it would become the window's, and the next Generate would run its box route
        // nor is it remembered as the upscaler last used (the Image menu opens it directly)
        if (!pass) selectRecipe(id, ui.upProvider.value || undefined);
        if (!pass && settings.upscaleRecipe !== id) window.scumble.settings.set({ upscaleRecipe: id }).then((s) => { settings = s; }).catch(() => { /* not fatal */ });
        const args = { doc: ed.node.id, timeout: 1800 };
        if (!pass) args.scope = ui.upScopeDoc.checked ? "document" : "selection";
        if (!ui.upFactorRow.hidden) args.factor = +ui.upFactor.value;
        if (!pass && !ui.upPromptRow.hidden) args.prompt = (ui.upPrompt.value || "").trim();
        // the dialog closes as soon as the run starts; the status line and the busy marker (the title row's timer, its
        // Cancel) follow it. A person waits: the pass gets 1800 s, past the command's default made for agents
        const run = commands.run(pass ? "realism_pass" : "upscale", args);
        ui.up.close();
        activate(ed);
        console.log("[upscale]", await run);
    } catch (err) {
        ed.setStatus(String(err.message || err));
    } finally {
        ui.upGo.disabled = false;
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

// the llm object is read fresh and spread, as the other llm writers do, so the endpoint and the rows stay
ui.promptRefPics.addEventListener("change", async () => {
    const on = ui.promptRefPics.checked;
    host.llmRefPictures = on;
    const set = await window.scumble.settings.get();
    settings = await window.scumble.settings.set({ llm: { ...(set.llm || {}), refPictures: on } });
});

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
        name.title = `${({ sam2: "objects (SAM2)", matting: "background removal", inpaint: "the Remove tool (inpainting)" })[m.kind] || m.kind} · ${m.source} · ${m.license}`;
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
                if (!(await dialogs.confirm(`Delete the files of ${m.label} (${fmtBytes(m.bytes)})?`, { ok: "Delete", danger: true }))) return;
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
    // skins are listed under Settings › Appearance (renderer/skins.js), not here
    const list = plugins.listPlugins().filter((p) => p.kind !== "skin");
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
        const gen = r.generate || [];
        if (gen.length) regs.push(`${gen.length} box source${gen.length > 1 ? "s" : ""}`);
        if (p.loaded) body.appendChild(Object.assign(document.createElement("div"), { className: "shell-plugin-regs", textContent: regs.length ? "registers " + regs.join(", ") : "registers nothing", title: [...r.filters, ...r.panels, ...r.actions.map((a) => a.id), ...r.tools, ...r.commands, ...gen].join("\n") }));
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
    try { const list = (await plugins.reloadPlugins()).filter((p) => p.kind !== "skin"); ui.pluginsNote.textContent = `${list.filter((p) => p.loaded).length} of ${list.length} loaded.`; }
    catch (err) { ui.pluginsNote.textContent = String(err.message || err); }
    finally { ui.pluginsReload.disabled = false; renderPlugins(); }
    // a skin's folder may have changed too (docs/SKINS.md)
    try { await reloadSkins(); } catch (err) { console.warn("skins", err); }
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
const cancelButton = $("shell-cancel");
// the title row's Cancel (an API run that does not come back): main stops waiting, the tab's status line says so
if (cancelButton) cancelButton.addEventListener("click", () => { cancelButton.disabled = true; host.cancelProviderRuns(); });
host.onProviderRuns = (runs) => {
    clearInterval(providerTimer); providerTimer = null;
    if (cancelButton) { cancelButton.hidden = !runs.length; cancelButton.disabled = false; }
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

// ---- earlier states (electron/main/autosave.js) ------------------------------------------

async function renderGenerations() {
    ui.setGensNote.textContent = "";
    let list = [];
    try { list = await window.scumble.state.generations(); } catch (err) { ui.setGensNote.textContent = String(err.message || err); }
    ui.setGens.replaceChildren();
    for (const g of list) {
        const o = document.createElement("option");
        o.value = g.id;
        o.textContent = `${g.label}: ${g.docs} document${g.docs === 1 ? "" : "s"}, ${new Date(g.time).toLocaleString()}`;
        ui.setGens.appendChild(o);
    }
    ui.setGens.disabled = ui.setGensOpen.disabled = !list.length;
    if (!list.length) {
        const o = document.createElement("option");
        o.textContent = "none yet";
        ui.setGens.appendChild(o);
    }
}

/** Open the documents of an earlier state as new tabs, beside the ones that are open. */
async function openGeneration(id) {
    const saved = await window.scumble.state.loadGeneration(id);
    let bundle = null;
    try { bundle = JSON.parse(saved); } catch (_) { bundle = null; }
    const docs = bundle && Array.isArray(bundle.docs) ? bundle.docs.filter((d) => d && typeof d.state === "string" && d.state.length > 2) : [];
    if (!docs.length) return 0;
    // new ids, so no open tab is overwritten (host.restore puts a state into the tab with its id)
    const fresh = docs.map((d) => ({ id: host.nextId++, state: d.state }));
    const before = host.editors().length;
    await host.restore(JSON.stringify({ version: 2, active: fresh[fresh.length - 1].id, nextId: host.nextId, docs: fresh }));
    return host.editors().length - before;
}

ui.setGensOpen.addEventListener("click", async () => {
    ui.setGensOpen.disabled = true;
    try {
        const n = await openGeneration(ui.setGens.value);
        ui.setGensNote.textContent = n ? `${n} document${n === 1 ? "" : "s"} opened as tabs.` : "That state holds no document.";
    } catch (err) {
        ui.setGensNote.textContent = String(err.message || err);
    } finally {
        ui.setGensOpen.disabled = false;
    }
});

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
    const depth = historyDepth();
    ui.setUndoSteps.value = depth.steps;
    ui.setUndoMB.value = depth.mb;
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
        ui.setAbout.textContent = `Scumble ${info.version} · Electron ${info.electron} · ${info.platform} · data in ${info.userData}${info.portable ? " (portable copy)" : ""}. Film names are trademarks of their owners; the looks are Scumble's own approximations, not licensed products. NVIDIA, RTX and DLSS are trademarks of NVIDIA Corporation; Scumble is not affiliated with or endorsed by NVIDIA, and the Realism Pass (Windows only, RTX only) runs only what you installed on your own ComfyUI.`;
    } catch (_) { /* ignore */ }
    ui.updateAuto.checked = !(settings.updates && settings.updates.check === false);
    ui.promptRefPics.checked = refPicturesOn(settings);
    try { renderUpdate(await window.scumble.updates.status()); } catch (_) { /* ignore */ }
    refreshFileStats();
    renderGenerations();
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
    try { await renderAppearance(ui); } catch (err) { ui.skinsNote.textContent = String(err.message || err); }
    if (!ui.settings.open) ui.settings.showModal();
}

ui.setOpenFiles.addEventListener("click", () => window.scumble.files.openFolder());
ui.setPrune.addEventListener("click", async () => {
    ui.setPrune.disabled = true;
    try {
        const keep = host.referencedFileKeys();
        const dry = await window.scumble.files.prune({ keep, dryRun: true });
        if (!dry.files) { ui.setPruneNote.textContent = "Nothing to remove."; return; }
        if (!(await dialogs.confirm(`Remove ${dry.files} file${dry.files === 1 ? "" : "s"} (${fmtBytes(dry.bytes)}) that no open document references?`, { ok: "Remove", danger: true }))) { ui.setPruneNote.textContent = "Kept."; return; }
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

/** A copy that does not update itself (a portable or other unpacked copy, electron/main/portable.js updateMode). */
const notifyMode = (s) => !!(s && s.mode === "notify");

function updateText(s) {
    if (!s) return "";
    if (s.state === "dev") return "Not packaged: updates are checked in the installed app only.";
    if (s.state === "store") return `Scumble ${s.current} from the Microsoft Store: the Store installs its updates.`;
    if (s.state === "available") {
        return s.skip && s.skip === s.version
            ? `Scumble ${s.version} is out. You skipped it; Download still opens its release page.`
            : `Scumble ${s.version} is out. This copy does not update itself: Download opens its release page.`;
    }
    if (s.state === "checking") return "Checking for updates ...";
    if (s.state === "latest") return s.manual ? `Scumble ${s.current} is up to date.` : "";
    if (s.state === "downloading") return `Downloading Scumble ${s.version} ... ${s.percent == null ? "" : s.percent + "%"}`;
    if (s.state === "downloaded") {
        return s.skip && s.skip === s.version
            ? `Scumble ${s.version} is downloaded. You skipped it, so it is not installed when Scumble closes; Install installs it now.`
            : `Scumble ${s.version} is downloaded: Install restarts into it now, otherwise it is installed when Scumble closes.`;
    }
    if (s.state === "error") return `Update check failed: ${s.error}`;
    return "";
}

let shownUpdate = null;            // the status the Updates section and the title row show (what their buttons act on)
const UPDATE_LABELS = { install: ui.updateInstall.textContent, barTitle: ui.updateBar.title };

export function renderUpdate(s) {
    shownUpdate = s || null;
    ui.updateNote.textContent = updateText(s);
    // a copy that does not update itself offers the release page instead of an install (state "available")
    const notify = notifyMode(s);
    const offered = !!(s && (notify ? s.state === "available" : s.state === "downloaded"));
    // the release notes of the offered version, as text: they come from GitHub, so they
    // never touch innerHTML
    const notes = s && s.notes && (s.state === "downloaded" || s.state === "downloading" || s.state === "available") ? s.notes : "";
    ui.updateNotes.textContent = notes;
    ui.updateNotes.hidden = !notes;
    ui.updateInstall.hidden = !offered;
    ui.updateInstall.textContent = notify ? "Download" : UPDATE_LABELS.install;
    ui.updateCheck.disabled = !!(s && (s.state === "checking" || s.state === "downloading"));
    // the Store copy is updated by the Store: no feed to check, nothing to switch off
    const store = !!(s && s.state === "store");
    ui.updateCheck.hidden = store;
    ui.updateAuto.parentElement.hidden = store;
    ui.updateHelp.hidden = store || notify;
    ui.updateHelpNotify.hidden = !notify;
    ui.updateBar.hidden = !offered;
    ui.updateBar.title = notify ? "A new version is out; this copy does not update itself: open its release page" : UPDATE_LABELS.barTitle;
    ui.updateBar.textContent = !offered ? "" : notify ? `Download ${s.version}` : `Update to ${s.version}`;
}

/** The release page Download opens: the one main names (electron/main/updater.js releaseUrl), else the tag's. */
export function releasePage(s) {
    if (s && typeof s.url === "string" && /^https:\/\/github\.com\/DenRakEiw\/scumble\/releases\//.test(s.url)) return s.url;
    const v = String((s && s.version) || "").replace(/^v/, "");
    return /^[0-9A-Za-z.+-]+$/.test(v) ? `https://github.com/DenRakEiw/scumble/releases/tag/v${v}` : "https://github.com/DenRakEiw/scumble/releases/latest";
}

/** How Download opens the page (main allows http(s) only); a test replaces `open`. */
export const updateLinks = { open: (url) => window.scumble.openExternal(url) };

/** Download in a copy that does not update itself: the release page in the browser, nothing installed. */
function downloadUpdate(s) {
    try { updateLinks.open(releasePage(s)); } catch (_) { return false; }
    return true;
}

/** The title row's button and Settings › Updates' Install / Download. */
function updateAction() {
    return notifyMode(shownUpdate) ? downloadUpdate(shownUpdate) : installUpdate();
}

// ---- the question when an update is ready (CLAUDE.md item 32, docs/PLAN_0_1_38.md A1) ----------------------------

let lastUpdate = null;            // the newest status (from main, or a test's)
const updateAsked = new Set();    // the versions this window asked about (main keeps the same for the start: `announced`)
let updateAsking = false;
let lastUserInput = 0;            // a key, a click or a wheel turn anywhere: the question does not cut into typing
for (const type of ["keydown", "pointerdown", "wheel"]) window.addEventListener(type, () => { lastUserInput = Date.now(); }, { capture: true, passive: true });

/** What the question waits for now, or null: another question (the assistant's too), a modal panel, the restore, an edit. */
function updateQuestionWaits() {
    if (dialogs.openCount() > 0) return "a question";
    if (Array.from(document.querySelectorAll("dialog[open]")).some((d) => d.matches(":modal"))) return "a dialog";
    if (assistantActivity().asking) return "the assistant's question";
    if (host._restoring) return "the restore";
    if (host.editors().some((ed) => userBusy(ed))) return "an edit";
    if (Date.now() - lastUserInput < 3000) return "typing";
    return null;
}

/**
 * The question's detail: each change's bold lead from the release notes (`s.headlines`, electron/main/updater.js),
 * at most `lines` of them; notes without such leads as text, cut at a line break near `chars`; then what Later and
 * Skip do. The whole notes stay in Settings › Updates.
 */
export function updateQuestionDetail(s, { lines = 8, chars = 1500 } = {}) {
    const parts = [];
    const heads = s && Array.isArray(s.headlines) ? s.headlines.filter(Boolean).map(String) : [];
    if (heads.length) {
        const shown = heads.slice(0, lines).map((h) => "• " + h);
        if (heads.length > lines) shown.push(`… and ${heads.length - lines} more in Settings › Updates.`);
        parts.push("What changed:\n" + shown.join("\n"));
    } else if (s && s.notes) {
        const text = String(s.notes).trim();
        let cut = text.length;
        if (text.length > chars) {
            cut = text.lastIndexOf("\n", chars);
            if (cut < chars / 2) cut = text.lastIndexOf(" ", chars);
            if (cut < chars / 2) cut = chars;
        }
        parts.push("What changed:\n" + text.slice(0, cut).trimEnd() + (cut < text.length ? "\n…, the rest in Settings › Updates." : ""));
    }
    parts.push(notifyMode(s)
        ? "Later asks again at the next start. Skip this version leaves it out until a newer one comes; the Download button in the title row still opens its page."
        : "Later installs it when you close Scumble. Skip this version leaves it out until a newer one comes; the Update button in the title row still installs it.");
    return parts.join("\n\n");
}

/**
 * Ask once when an update is downloaded: Restart and update, Later, Skip this version. In a copy that does not update
 * itself (`mode` "notify", a portable copy) ask once when a new version is out instead: Download (its release page in
 * the browser), Later, Skip this version. Not after a check the user
 * started (Settings › Updates shows that answer), not for a version this start asked about or the user skipped, and
 * never over another question, a modal panel, the restore at start or an edit in progress: it waits for those, and
 * gives up when a newer status replaces this one meanwhile. The Store copy and dev never reach "downloaded". Resolves
 * with the index of the button pressed, or false when it did not ask.
 */
export async function announceUpdate(s) {
    if (s) lastUpdate = s;
    const notify = notifyMode(s);
    const offered = (u) => !!(u && u.state === (notifyMode(u) ? "available" : "downloaded"));
    const v = offered(s) && !s.manual && s.version ? String(s.version) : null;
    if (!v || updateAsking || updateAsked.has(v) || s.announced === v || s.skip === v || (settings.updates || {}).skip === v) return false;
    const current = (u) => !!(offered(u) && notifyMode(u) === notify && !u.manual && String(u.version) === v);
    updateAsking = true;
    try {
        while (updateQuestionWaits()) {
            await new Promise((r) => setTimeout(r, 500));
            if (!current(lastUpdate)) return false;
        }
        const now = lastUpdate;
        updateAsked.add(v);
        window.scumble.updates.announced(v).catch(() => { /* this window still remembers it */ });
        if (notify) {
            const n = await dialogs.ask({
                title: `Scumble ${v} is out`,
                message: "This copy does not update itself. Download the new zip and unpack it where you unpacked this one, so its Scumble folder lands on this one: the data folder stays.",
                detail: updateQuestionDetail(now),
                buttons: ["Download", "Later", "Skip this version"],
                defaultId: 0,
                cancelId: 1,
                // it opens unasked: a key the user was typing answers Later
                focusId: 1,
            });
            if (n === 0) downloadUpdate(now);
            else if (n === 2) await skipUpdate(v);
            return n;
        }
        const i = await dialogs.ask({
            title: `Scumble ${v} is ready`,
            message: `You have ${now.current}. Restart and update saves your documents, installs ${v} and starts it; the documents come back as they were.`,
            detail: updateQuestionDetail(now),
            buttons: ["Restart and update", "Later", "Skip this version"],
            defaultId: 0,
            cancelId: 1,
            // it opens unasked: a key the user was typing answers Later, never the restart
            focusId: 1,
        });
        if (i === 0) await installUpdate();
        else if (i === 2) await skipUpdate(v);
        return i;
    } finally {
        updateAsking = false;
        // a newer version arrived while this one waited or was asked
        if (lastUpdate && lastUpdate !== s && offered(lastUpdate) && String(lastUpdate.version) !== v) announceUpdate(lastUpdate);
    }
}

/**
 * Skip a version (null: none): no question for it, and it is not installed when Scumble closes (main reads
 * settings.updates.skip, electron/main/updater.js setSkip). Install and the title row's button still install it.
 */
export async function skipUpdate(version) {
    const updates = { ...(settings.updates || {}) };
    if (version) updates.skip = String(version); else delete updates.skip;
    settings = await window.scumble.settings.set({ updates });
    return settings.updates;
}

/**
 * Restart into the downloaded update: the title row's button, Install in Settings › Updates and the question. A run in
 * flight, a working assistant or a connected agent ends with the app, so that is asked first; main saves every
 * document before the installer starts (update:install).
 */
async function installUpdate() {
    // busy() leaves out a render on the user's ComfyUI (it holds no flag while it runs): its result would be lost too
    const working = host.editors().filter((ed) => busy(ed) || (ed._localRuns && ed._localRuns.size > 0)).length;
    const as = assistantActivity();
    const what = [];
    if (working) what.push(working === 1 ? "a document is still working" : `${working} documents are still working`);
    if (as.busy) what.push("the assistant is working");
    if (as.agents) what.push(as.agents === 1 ? "an agent is connected" : `${as.agents} agents are connected`);
    if (what.length) {
        const text = what.join(", ").replace(/, ([^,]*)$/, " and $1");
        const yes = await dialogs.confirm(`${text[0].toUpperCase()}${text.slice(1)}. Restart and update anyway?`, {
            detail: "What runs now ends with the app: a run's result does not come back, and an agent's session ends.",
            ok: "Restart and update",
            danger: true,
        });
        if (!yes) return false;
    }
    let ok = false;
    try { ok = await window.scumble.updates.install(); } catch (_) { /* said below */ }
    if (!ok && host.editor) host.editor.setStatus("The update did not start; Settings › Updates offers it again.");
    return ok;
}

window.scumble.updates.onStatus((s) => { renderUpdate(s); announceUpdate(s); });
// a status from before this window listened (a window reloaded after a crash): main's `announced` says whether it asked
window.scumble.updates.status().then((s) => { renderUpdate(s); announceUpdate(s); }, () => { /* no updater */ });

// ---- item 40: the star line after an update ------------------------------------------------------------
const REPO_URL = "https://github.com/DenRakEiw/scumble";

/** The quiet line on the first start of a new version (main decides, once per version): never a modal, closed for good. */
function showStarNote(text) {
    if (!text || document.getElementById("shell-star")) return;
    const bar = document.createElement("div");
    bar.id = "shell-star";
    const say = document.createElement("span");
    say.textContent = text;
    const star = document.createElement("a");
    star.href = "#";
    star.textContent = "Star on GitHub";
    star.addEventListener("click", (e) => { e.preventDefault(); window.scumble.openExternal(REPO_URL); bar.remove(); });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "shell-star-close";
    close.textContent = "×";
    close.title = "Close";
    close.addEventListener("click", () => bar.remove());
    bar.append(say, star, close);
    const main = document.getElementById("shell-main");
    main.parentNode.insertBefore(bar, main);
}
if (window.scumble.starNote) window.scumble.starNote().then(showStarNote, () => { /* an older main */ });
ui.updateCheck.addEventListener("click", async () => { renderUpdate(await window.scumble.updates.check()); });
ui.updateInstall.addEventListener("click", () => updateAction());
ui.updateBar.addEventListener("click", () => updateAction());
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
for (const [input, key, min, max] of [[ui.setUndoSteps, "steps", 5, 500], [ui.setUndoMB, "mb", 64, 8192]]) {
    input.addEventListener("change", async () => {
        const v = Math.min(max, Math.max(min, Math.round(Number(input.value) || 0)));
        input.value = v;
        settings = await window.scumble.settings.set({ history: { ...historyDepth(), [key]: v } });
        applyHistoryDepth();
    });
}

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
        if (upd && upd.state === "downloaded" && upd.skip !== upd.version) text.push(`Restart now also installs ${upd.version}.`);
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
    if (working.length && !(await dialogs.confirm(`${working.length === 1 ? "A document is" : working.length + " documents are"} still working. Restart anyway?`, { ok: "Restart", danger: true }))) return;
    ui.setTilesRestart.disabled = true;
    try {
        await saveBeforeRestart((text) => { ui.setTilesNote.textContent = text; });
        await window.scumble.relaunch();
    } catch (err) {
        ui.setTilesNote.textContent = String(err.message || err);
        ui.setTilesRestart.disabled = false;
    }
});

// main asks for the same before the window closes or an update's installer starts (electron/main/quit.js)
window.scumble.state.onFlush(async (reason) => {
    const when = reason === "update" ? "the update" : "closing";
    const say = (text) => { try { if (host.editor) host.editor.setStatus(text); } catch (_) { /* no editor */ } };
    // a document save in flight first, the whole flow up to main's write (docs/PLAN_DOCUMENTS.md §4.5)
    await host.docSavesIdle();
    await saveBeforeRestart(say, when);
});

/**
 * Everything a restart must not lose, saved now. The autosave bundle holds each layer's uploaded file,
 * and a layer is uploaded only 15 s after its last change (scheduleAutosave): saving the bundle alone
 * restored the pixels from before that, and a new layer never uploaded came back without its pixels at
 * all. So every edited layer and mask is uploaded first. A picture above the size getValue encodes on
 * the spot gets its selection PNG in the background (encodeSelectionSoon), so that is waited for too
 * (at most a minute), or the saved selection would be the one before. `say` gets a status line.
 */
async function saveBeforeRestart(say = () => {}, when = "the restart") {
    // a restore in progress (Earlier states, a document that waited for ComfyUI) has only part of its documents in
    // the editors: the bundle waits for it (host.js _restoring)
    for (const until = Date.now() + 60000; host._restoring && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
    const eds = host.editors();
    // a heal stroke still blending in a worker (the button is up, the gesture held until it lands: `healBlend`)
    for (const until = Date.now() + 10000; eds.some((ed) => ed.pointer && ed.pointer.healing) && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
    const edited = (ed) => ed.base && ed.layers && ed.layers.some((l) => (l.dirty && l.px) || (l.maskDirty && l.maskPx));
    if (eds.some(edited)) say(`Saving the edited layers before ${when}...`);
    // each document's layers, then the bundle, so a save cut short still keeps the documents done so far; again for
    // what changed while a pass ran (a stroke during the save), three passes at most
    for (let round = 0; round < 3 && eds.some(edited); round++) {
        for (const ed of eds) {
            if (!edited(ed) || typeof ed.syncLayers !== "function") continue;
            try { await ed.syncLayers(); } catch (err) { console.warn("saving a document's layers", err); }
            await window.scumble.state.save(JSON.stringify(host.bundle()));
        }
    }
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
        say(`Saving the selection before ${when}...`);
        await new Promise((r) => setTimeout(r, 100));
    }
    await window.scumble.state.save(JSON.stringify(host.bundle()));
}
ui.aboutRepo.addEventListener("click", (e) => { e.preventDefault(); window.scumble.openExternal(REPO_URL); });
// item 40 (electron/main/share.js): star the repo, or share it (Copy link, or a platform's own share page in the browser)
ui.aboutStar.addEventListener("click", (e) => { e.preventDefault(); window.scumble.openExternal(REPO_URL); });
ui.aboutShare.addEventListener("click", async (e) => {
    e.preventDefault();
    ui.shareRow.hidden = !ui.shareRow.hidden;
    if (ui.shareRow.hidden || ui.shareTargets.childElementCount) return;
    const { targets } = await window.scumble.shareTargets();
    for (const t of targets) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = t.label;
        b.title = `Share on ${t.label}: opens its share page in the browser`;
        b.addEventListener("click", () => { window.scumble.share(t.id); });
        ui.shareTargets.appendChild(b);
    }
});
ui.shareCopy.addEventListener("click", async () => {
    const r = await window.scumble.share("copy");
    ui.shareNote.textContent = r === "copied" ? "Link copied" : "";
});

// keys typed into the dialog must not reach the editor's window-level shortcut handler
ui.settings.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });

// ---- menu and files ----------------------------------------------------------------------

window.scumble.file.onOpened(({ name, data }) => {
    const type = /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.webp$/i.test(name) ? "image/webp" : /\.tiff?$/i.test(name) ? "image/tiff" : "image/png";
    openInto(new File([data], name, { type }));
});
// ---- .scumble documents (docs/PLAN_DOCUMENTS.md): save, save as, open ------------------------------------------

/** An error of a main-process call without Electron's "Error invoking remote method ..." prefix. */
const ipcMessage = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");

/** Save the active (or given) document; a failure goes to its status line and leaves the tab as it was. */
async function saveDocumentFromUi(ed, opts = {}) {
    if (!ed) return null;
    if (!ed.base) { ed.setStatus("Nothing to save yet: load or create a picture first."); return null; }
    try {
        const r = await host.saveDocument(ed, opts);
        renderTabs();
        return r;
    } catch (err) {
        ed.setStatus("Not saved: " + ipcMessage(err));
        return null;
    }
}

async function openDocumentFromUi(file) {
    try {
        const r = await host.openDocument(file);
        renderTabs();
        return r;
    } catch (err) {
        const name = String(file).split(/[\\/]/).pop();
        if (host.editor) host.editor.setStatus(`Could not open ${name}: ${ipcMessage(err)}`);
        return null;
    }
}

window.scumble.documents.onProgress((p) => host.documentProgress(p));

// a .scumble dropped anywhere on the window opens as a document; the capture phase runs before the editor's own drop
// handler, which would load it as a picture (images dropped with it are left out)
window.addEventListener("dragover", (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) e.preventDefault();
}, true);
window.addEventListener("drop", (e) => {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => /\.scumble$/i.test(f.name));
    if (!files.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    (async () => {
        for (const f of files) {
            const p = window.scumble.documents.pathOf(f);
            if (p) await openDocumentFromUi(p);
            else if (host.editor) host.editor.setStatus(`${f.name} has no path on disk; open it with File › Open.`);
        }
    })();
}, true);
window.scumble.documents.onOpenRequest(async (paths) => { for (const p of paths || []) await openDocumentFromUi(p); });
// documents named by a second start (a double click on a .scumble); the start takes the first ones itself, after the
// session's tabs are back
let takesPending = false;
window.scumble.documents.onPending(async () => { if (takesPending) await openPendingDocuments(); });
async function openPendingDocuments() {
    try { for (const p of await window.scumble.documents.takePending()) await openDocumentFromUi(p); } catch (err) { console.warn("documents to open", err); }
}

// Ctrl+S saves the document, Ctrl+Shift+S is Save As, Ctrl+Shift+E exports the picture (the user, 2026-09-26, §9).
// The editor binds Ctrl+S to the picture export and Ctrl+E (Shift ignored) to merge down, and the ComfyUI node keeps
// that; in the app this capture listener runs first (it is registered before any editor opens) and keeps the keys
// from it. preventDefault also keeps the menu's accelerators for the same keys from firing a second time.
window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = String(e.key || "").toLowerCase();
    if (k !== "s" && !(k === "e" && e.shiftKey)) return;
    const t = e.target;
    if (t && t.closest && t.closest("dialog[open]")) return;       // a dialog's own keys
    const ed = host.editor;
    if (ed && ed.askOpen) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!ed || e.repeat) return;
    if (k === "e") ed.exportImage();
    else saveDocumentFromUi(ed, { as: e.shiftKey });
}, true);

// ---- the canvas-only view (item 24, docs/PLAN_0_1_31.md §1) --------------------------------------------------------
//
// Tab hides the shell's chrome and the editor's (bars, tools, panels, rulers) and the picture fills the screen; Tab again
// or Escape returns. The view is the shell's alone: the editor and the ComfyUI node know nothing of it. The window goes
// full screen for it unless it already was, the picture is fitted, and leaving puts the view, the rulers and the window
// back as they were. A tab switch, a closed tab and a full screen ended from outside (F11, the OS) end it too. Help and
// the assistant stay open under the picture (shell.css); asking for one of them ends the view.

try {
    window.scumble.window.isFullScreen().then((on) => { windowFullScreen = !!on; }, () => { /* no window */ });
    window.scumble.window.onFullScreenChange((on) => {
        windowFullScreen = !!on;
        if (!on && canvasOnlyState) leaveCanvasOnly({ fullScreenGone: true });
    });
} catch (_) { /* an older preload */ }
// a tab switch ends the view, from wherever it comes (the tab bar, a command, a document opened), and so does closing
// its tab: removeEditor() makes the next tab the active one before it activates it, so no "activate" is heard for that
host.on("activate", ({ editor }) => { if (canvasOnlyState && canvasOnlyState.ed !== editor) leaveCanvasOnly(); });
host.on("removed", ({ editor }) => { if (canvasOnlyState && canvasOnlyState.ed === editor) leaveCanvasOnly(); });

/** What the editor's Escape cancels first (its _docKey chain): while one is set, Escape is the editor's, not the view's. */
function editorHasEscape(ed) {
    return !!(ed.pending || ed.polyPoints || ed.shapePoints || (ed.tool === "canvas" && ed.extendPending && ed.extendPending())
        || (ed.tool === "canvas" && ed.pointer && ["frame", "framemove", "framerotate", "straighten"].includes(ed.pointer.kind))
        || ed.flyout || (ed.tipPicker && ed.tipPicker.isOpen) || ed.textEdit || ed.compare);
}

/** The view's size changed with the chrome: fit or redraw once (resizeCanvas does that itself when the size changed). */
function settleView(ed, fit) {
    const size = ed.canvas.width + "x" + ed.canvas.height;
    ed.resizeCanvas();
    if (ed.canvas.width + "x" + ed.canvas.height !== size) return;
    if (fit && ed.width) ed.fitView(); else ed.draw();
}

function enterCanvasOnly() {
    const ed = host.editor;
    if (canvasOnlyState || !ed || !ed.canvas) return Promise.resolve();
    const st = canvasOnlyState = { ed, wasFullScreen: windowFullScreen, view: { ...ed.view }, fitted: ed._fitted, rulers: ed.showRulers, w: ed.width, h: ed.height };
    document.body.classList.add("shell-canvas-only");
    if (ed.closeTipPicker) ed.closeTipPicker();   // it hangs from the options bar, which the view hides
    // the keys go to the picture: the view may come from the menu with the focus in a panel it now covers
    ed.root.focus({ preventScroll: true });
    ed.showRulers = false;       // not toggleRulers(): the user's setting in localStorage stays as it is
    const old = $("shell-canvas-hint");
    if (old) old.remove();       // a new element starts the fade again
    const hint = document.createElement("div");
    hint.id = "shell-canvas-hint";
    hint.textContent = "Tab or Esc to return";
    document.body.appendChild(hint);
    // fitted now, and again by the editor's resize observer when the window is full screen (it refits while _fitted)
    ed._fitted = true;
    settleView(ed, true);
    if (st.wasFullScreen) return Promise.resolve();
    return window.scumble.window.setFullScreen(true).catch((err) => console.warn("canvas only: full screen", err));
}

/** `fullScreenGone`: the window left full screen by itself (F11, the OS), so there is nothing to undo there. */
function leaveCanvasOnly({ fullScreenGone = false } = {}) {
    const st = canvasOnlyState;
    if (!st) return Promise.resolve();
    canvasOnlyState = null;
    document.body.classList.remove("shell-canvas-only");
    const hint = $("shell-canvas-hint");
    if (hint) hint.remove();
    const ed = st.ed;
    if (host.editors().includes(ed)) {        // a closed tab has nothing to put back
        // the rulers as the user last set them: Ctrl+Shift+R in the view counts (its button follows every toggle)
        ed.showRulers = ed.rulersBtn ? ed.rulersBtn.classList.contains("ipc-toggle-on") : st.rulers;
        // the old view only for the same picture: after a crop, an extend or a new image it stays fitted
        const same = ed.width === st.w && ed.height === st.h;
        if (same) { Object.assign(ed.view, st.view); ed._fitted = st.fitted; } else ed._fitted = true;
        settleView(ed, !same);
    }
    if (st.wasFullScreen || fullScreenGone) return Promise.resolve();
    return window.scumble.window.setFullScreen(false).catch((err) => console.warn("canvas only: full screen", err));
}

/** Image > Frequency Separation...: the radius asked for (the editor's own dialog), then the two layers (PLAN_0_1_31 §4 step 8). */
async function frequencySeparation() {
    const ed = host.editor;
    if (!ed || !ed.base) return;
    const def = Math.max(2, Math.round(Math.min(ed.width, ed.height) * 0.004));
    const v = await ed.ask({ title: "Frequency separation", message: `The blur radius in pixels: detail finer than it goes to the high layer, colour and tone to the low one. ${ed.getBounds() ? "The selection's box is split." : "The whole picture is split (select an area for a large one)."}`, value: String(def), ok: "Split" });
    if (v == null || v === false) return;
    const r = Math.round(+v);
    if (!(r > 0)) { ed.setStatus("The radius has to be a number of pixels."); return; }
    try { await ed.frequencySeparation({ radius: r }); } catch (err) { ed.setStatus(`Frequency separation failed: ${err.message || err}`); }
}

/** The canvas-only view on (`true`), off (`false`) or toggled (left out); resolves with the state after. */
async function canvasOnly(on) {
    const want = on === undefined ? !canvasOnlyState : !!on;
    await (want ? enterCanvasOnly() : leaveCanvasOnly());
    return !!canvasOnlyState;
}

function isCanvasOnly() {
    return !!canvasOnlyState;
}

/** Help and the assistant are columns beside the picture: asked for in the canvas-only view, the view ends, and one that is open already just shows. */
function showColumn(isOpen, toggle) {
    if (canvasOnlyState) {
        leaveCanvasOnly();
        if (isOpen()) return;
    }
    toggle();
}

// Tab toggles the view, Escape leaves it. Registered here, before any editor opens, so it runs before the editor's own
// capture listener: Tab is free there, and Escape stays the editor's while it has something to cancel. Not in a text
// field, a dialog (Help, the assistant, Settings) or the editor's question; Shift+Tab and Ctrl+Tab are not the view's.
window.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" && !(e.key === "Escape" && canvasOnlyState)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (document.querySelector("dialog:modal")) return;   // Settings and the like, also when their focused field was re-rendered away
    const t = e.target;
    // under the view the Help and assistant columns are covered: a key that lands there is the view's (the assistant's
    // question is drawn over the picture and keeps its own keys)
    const covered = canvasOnlyState && t && t.closest && t.closest("#help, #assistant") && !t.closest(".as-ask");
    if (!covered && t && t.closest && t.closest("dialog[open]")) return;
    if (!covered && t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    const ed = host.editor;
    if (!ed || ed.askOpen) return;
    if (e.key === "Escape" && editorHasEscape(ed)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) canvasOnly();       // Escape gets here only while the view is on, so it only ever leaves
}, true);

/** A command of the app menu (main's `send("menu", cmd)`); exported so a gate can call it. */
export function menuCommand(cmd) {
    if (cmd === "save") host.editor && host.editor.exportImage();
    else if (cmd === "save-document") saveDocumentFromUi(host.editor);
    else if (cmd === "save-document-as") saveDocumentFromUi(host.editor, { as: true });
    else if (cmd === "reopen-closed") reopenClosedTab();
    else if (cmd === "settings") openSettings();
    else if (cmd === "console") openConsole();
    else if (cmd === "help") showColumn(helpOpen, toggleHelp);
    else if (cmd === "canvas-only") canvasOnly();
    else if (cmd.startsWith("canvas:turn:")) {
        const op = { 1: 1, "-1": -1, 2: 2, h: "h", v: "v" }[cmd.slice(12)];
        if (op !== undefined && host.editor) host.editor.turnDocument(op);
    }
    else if (cmd === "frequency-separation") frequencySeparation();
    else if (cmd === "dodge-burn-layer" || cmd === "dodge-burn-layer:grey") { if (host.editor) host.editor.dodgeBurnLayer({ grey: cmd.endsWith(":grey") }); }
    else if (cmd === "realism-pass") { if (host.editor) openUpscale(host.editor, { recipe: realism.RECIPE_ID }); }
    else if (cmd === "new-tab") activate(newDocument());
    else if (cmd === "close-tab") closeDocument(host.editor);
    else if (cmd === "next-tab") cycleTab(1);
    else if (cmd === "prev-tab") cycleTab(-1);
    else if (cmd === "import-recipe") importRecipe();
    else if (cmd === "reload-plugins") plugins.reloadPlugins().then(async (all) => { const list = all.filter((p) => p.kind !== "skin"); try { await reloadSkins(); } catch (err) { console.warn("skins", err); } if (host.editor) host.editor.setStatus(`Plugins reloaded: ${list.filter((p) => p.loaded).length} of ${list.length} loaded.`); });
    else if (cmd.startsWith("skin:")) applySkin(cmd.slice(5)).catch(() => { /* the Appearance note says why */ });
    else if (cmd === "assistant") showColumn(assistantOpen, toggleAssistant);
    else if (cmd === "link-copied") host.editor && host.editor.setStatus("Link copied: paste it wherever you share it.");
    else if (cmd === "mcp-copied") host.editor && host.editor.setStatus("MCP registration copied. Paste it into your client; see docs/MCP.md.");
    else if (cmd === "settings-updates") openSettings().then(() => { const h = Array.from(ui.settings.querySelectorAll("h3")).find((x) => x.textContent === "Updates"); if (h) h.scrollIntoView(); });
    else if (cmd === "settings-plugins") openSettings().then(() => { const h = Array.from(ui.settings.querySelectorAll("h3")).find((x) => x.textContent === "Plugins"); if (h) h.scrollIntoView(); });
    else if (cmd === "comfy-edit-recipe") openRecipeInComfy(ui.recipe.value);
    else if (cmd === "settings-comfy") openSettings().then(() => { const h = Array.from(ui.settings.querySelectorAll("h3")).find((x) => x.textContent === "ComfyUI"); if (h) h.scrollIntoView(); if (ui.setUrl) ui.setUrl.focus(); });
    else if (cmd === "settings-appearance") openSettings().then(() => { const h = Array.from(ui.settings.querySelectorAll("h3")).find((x) => x.textContent === "Appearance"); if (h) h.scrollIntoView(); });
    else if (cmd.startsWith("plugin:")) plugins.runAction(cmd.slice(7)).catch(() => { /* reported by the plugin host */ });
}

window.scumble.onMenu(menuCommand);

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
                // labelled by the command, so the Undo history says what the assistant did
                const label = `Assistant: ${String(name).replace(/_/g, " ")}`;
                try { ed.pushUndo(meta.undo.id ? { kind: meta.undo.kind, id: meta.undo.id, label } : { kind: meta.undo.kind, label }); }
                catch (err) { console.warn("assistant: the undo step could not be pushed", err); }
            }
        }
    }
    reply(await commands.call(name, args || {}));
});

// ---- start: the skin, plugins, restore the last session, then connect ----------------------

// before any editor: the canvas colours that follow the skin are read once here (renderer/skins.js)
try { await initSkins(); } catch (err) { console.warn("skins", err); }
dialogs.listen(window.scumble.dialogs);     // main's questions (main.js askWindow) in the app's own dialog
try {
    await plugins.loadPlugins();
} catch (err) {
    console.warn("plugins", err);
}
// "safe": the window came back after a second crash in a row (electron/main/quit.js): the state it was restoring is
// set aside as an earlier state, and this start does not try it a third time
let startMode = "normal";
try { startMode = await window.scumble.state.startMode(); } catch (_) { /* an older main */ }
try {
    const saved = startMode === "safe" ? null : await window.scumble.state.load();
    await host.loadBrushTips();
    if (saved) await host.restore(saved);
} catch (err) {
    console.warn("no autosaved state", err);
}
if (!host.editors().length) newDocument();
activate(host.editor);
if (startMode === "safe") host.editor.setStatus("The window crashed twice while it restored your documents: they are kept, Settings › Local files › Earlier states opens them.");
await loadProviders();
await loadRecipes();
host.presets = settings.recipePresets || {};
await host.refreshHelpers();
await host.refreshLLMs();
selectRecipe(settings.recipe);
// documents named at the start (a double click, a second start): after the session's tabs are back and the recipe is
// chosen (an open compares the document's recipe with it)
takesPending = true;
await openPendingDocuments();
showStatus(await window.scumble.comfy.status());
window.scumble.commands.ready();
// the assistant's column (docs/PLAN_ASSISTANT.md A5): built last, so its window key listener is
// registered before any editor question's, and it sees a chat key first
initAssistant({ openSettings });
watchUserEdits();
const assistantButton = $("shell-assistant");
if (assistantButton) assistantButton.addEventListener("click", () => toggleAssistant());
// Help (docs/PLAN_HELP.md): the manual and its chat, beside the assistant's column
initHelp({ openSettings }).catch((err) => console.warn("help:", err.message));
const helpButton = $("shell-help");
if (helpButton) helpButton.addEventListener("click", () => toggleHelp());
// ComfyUI's own page in a window of its own (electron/main/comfyview.js, docs/PLAN_COMFY_VIEW.md §2.1): it opens on
// the ComfyUI of Settings › ComfyUI, or on its start page when there is none to show
const comfyButton = $("shell-comfy");
if (comfyButton) comfyButton.addEventListener("click", () => window.scumble.comfyView.open().catch((err) => console.warn("comfyui window:", err.message)));
// a graph saved from the ComfyUI window (item 35 V3): the recipes again, and the saved one selected
window.scumble.comfyView.onSaved(async ({ id, message }) => {
    await loadRecipes();
    if (ui.settings.open) renderRecipeList();
    selectRecipe(id);
    if (host.editor && message) host.editor.setStatus(message);
});
const comfyEditButton = $("shell-comfy-edit");
if (comfyEditButton) comfyEditButton.addEventListener("click", () => openRecipeInComfy(ui.recipe.value));

/** Whether a provider recipe is a Comfy Cloud recipe with a graph of its own (item 35 V5). */
function cloudGraphOf(r) {
    const v = r && r.providers && r.providers.comfycloud;
    return !!(v && v.options && v.options.graph);
}

/**
 * A recipe's graph in the ComfyUI window: a ComfyUI recipe's (item 35 V2), or a Comfy Cloud recipe's, shown on Comfy
 * Cloud (V5c); any other provider recipe has none, which the status line says.
 */
function openRecipeInComfy(id) {
    const r = recipes.find((x) => x.id === id);
    const say = (text) => { if (host.editor) host.editor.setStatus(text); };
    if (!r) return say("No recipe is selected.");
    const cloud = r.kind === "provider" && cloudGraphOf(r);
    if (r.kind === "provider" && !cloud) return say(`"${r.name || r.id}" runs through a provider, not through ComfyUI: it has no graph to edit.`);
    window.scumble.comfyView.open(cloud ? { recipe: r.id, target: "cloud" } : { recipe: r.id }).catch((err) => say(String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, "")));
}

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

export { newDocument, activate, closeDocument, canvasOnly, isCanvasOnly, openSettings, openConsole, selectRecipe, loadRecipes, importRecipe, testConnection, connect, commands, plugins, watchMemory, cardMemory, cardShortfall, saveBeforeRestart };
