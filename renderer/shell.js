// The shell around the editor: connection bar, recipe picker, progress, tabs (one editor
// per document), the settings dialog (ComfyUI connection with auth, API provider keys,
// recipes, local files) and the menu commands.
import { host, api } from "./editor/host.js";
import { InpaintEditor, STYLE as EDITOR_STYLE } from "./editor/inpaint_canvas.js";
import { setPixelsOptions } from "./editor/inpaint_pixels.js";
import { commands, docSummary } from "./commands.js";
import * as plugins from "./plugins.js";
import { waitForUser, editorOf } from "./assistant_wait.js";
import { beforeCall as snapshotTurn, watchUserEdits, forgetDocument } from "./assistant_turns.js";
import { initAssistant, toggleAssistant, assistantOpen, resetAssistant } from "./assistant.js";
import { initHelp, toggleHelp, helpOpen } from "./help.js";
import { initSkins, applySkin, reloadSkins } from "./skins.js";
import * as dialogs from "./dialogs.js";
import { remap, compare, checkNote, normalize as normalizeTokens } from "./editor/reftokens.js";
import * as realism from "./editor/realism.js";
import { failKind } from "./editor/inpaint_status.js";

/** failKind for an error that came over IPC (its fields stay behind): a cancelled or busy save or open is plain. */
function ipcKind(err) {
    return /(?:was cancell?ed|is already being saved|is already being opened)/i.test(String((err && err.message) || err)) ? "info" : failKind(err);
}
import { getSecretGreeting, getScumbleWord, getScumbleLogo, runBrainfuck } from "./easteregg.js";
import { shellState } from "./shell_state.js";
import { addCloudMode, downloadErrors, fmtBytes, importRecipe, keysNote, lmProviders, lmRows, lmSave, lmSuggest, loadProviders, loadRecipes, memoryReads, modeOf, openGeneration, openSettings, providerKeyState, refreshFileStats, renderCompat, renderHelpers, renderPlugins, renderPrompts, renderRecipeList, renderTileMode, resolveRecipe, saveCompat, selectRecipe, showKeysNote } from "./shell_settings.js";
import { GEN_ASPECTS, genAspectFree, genEditor, genField, genFillAspects, genFillProviders, genFillRecipes, genFillSizes, genInstruction, genOpenSeq, genPresetOf, genSize, genSyncNote, genSyncRefs, genSyncSize, genSyncTemplateNote, genTransparencyRow, isPassRecipe, newCanvasChoices, newCanvasChosen, openGenerateNew, openUpscale, upEditor, upFactors, upFillFactors, upFillProviders, upNoteFactor, upResyncPass, upSyncNote } from "./shell_generate.js";
import { REPO_URL, announceUpdate, releasePage, renderNetwork, renderUpdate, showStarNote, skipUpdate, updateAction, updateLinks, updateQuestionDetail } from "./shell_updates.js";
import { cardMemory, cardShortfall, logMatches, logRow, logState, openConsole, renderLog, watchMemory } from "./shell_watch.js";

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
    const pixelMemory = (err) => { if (err && err.name === "PixelMemoryError" && host.editor) host.editor.setStatus(err.message, failKind(err)); };
    window.addEventListener("error", (e) => { send("error", "uncaught: " + (e.message || e), e.error && e.error.stack); pixelMemory(e.error); });
    window.addEventListener("unhandledrejection", (e) => { send("error", "unhandled: " + ((e.reason && (e.reason.message || e.reason)) || e), e.reason && e.reason.stack); pixelMemory(e.reason); });
})();

// docs/PLAN_BCE.md §E1: the scheme's COOP / COEP headers make the window cross-origin isolated, which the tile arena's
// SharedArrayBuffer needs; without it the worker pool copies tiles, which works but costs the copies
try { window.scumble.log.add({ level: crossOriginIsolated ? "info" : "warn", source: "renderer", message: `cross-origin isolated: ${crossOriginIsolated}` }); } catch (_) { /* preload missing */ }
try {
    const greeting = getSecretGreeting();
    if (typeof window !== "undefined") {
        /** @type {any} */ (window).scumbleGreeting = getSecretGreeting;
        /** @type {any} */ (window).scumbleWord = getScumbleWord;
        /** @type {any} */ (window).runBrainfuck = runBrainfuck;
        /** @type {any} */ (window).scumbleLogo = getScumbleLogo;
    }
    const style = "color: #e28743; font-weight: bold; font-family: monospace;";
    getScumbleLogo().then((logo) => console.log(`%c${logo}%c${greeting}`, "color: #c4663b; font-family: monospace; line-height: 1.15;", style),
        () => console.log(`%c${greeting}`, style));
} catch (_) { /* ignore */ }

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
    genSeed: $("gen-seed"), genSeedRandom: $("gen-seed-random"), genSizeNote: $("gen-size-note"), genBoxNote: $("gen-box-note"),
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
    netCurl: $("set-net-curl"), netNote: $("set-net-note"),
    updateBar: $("shell-update"), updateAuto: $("set-update-auto"), updateCheck: $("set-update-check"), updateInstall: $("set-update-install"), updateNote: $("set-update-note"), updateHelp: $("set-update-help"), updateHelpNotify: $("set-update-help-notify"), updateNotes: $("set-update-notes"),
    helpersDevice: $("set-helpers-device"), helpersSam2: $("set-helpers-sam2"), helpersDir: $("set-helpers-dir"), helpersBrowse: $("set-helpers-browse"), helpersDefault: $("set-helpers-default"), helpersOpen: $("set-helpers-open"), helpersScan: $("set-helpers-scan"), helpersScanNote: $("set-helpers-scan-note"),
    helpersModels: $("set-helpers-models"), helpersNote: $("set-helpers-note"), hfToken: $("set-hf-token"), hfSave: $("set-hf-save"), hfClear: $("set-hf-clear"), hfState: $("set-hf-state"),
};

shellState.settings = await window.scumble.settings.get();
shellState.lastStatus = { state: "disconnected", message: "not connected" };
shellState.lastProbe = null;
// the canvas-only view (canvasOnly below): { ed, wasFullScreen, view, fitted, rulers, w, h } while it is on, and
// whether the window is full screen (main tells, F11 and the OS included)
shellState.canvasOnlyState = null;
shellState.windowFullScreen = false;
ui.url.value = (shellState.settings.comfy && shellState.settings.comfy.url) || "http://127.0.0.1:8188";

// ---- documents (tabs) --------------------------------------------------------------------

host.configure({ mount: $("editor-host"), nodeParams: shellState.settings.nodeParams, apiSize: shellState.settings.apiSize, embedRecipe: shellState.settings.embedRecipe, llmRefPictures: refPicturesOn(shellState.settings), realism: shellState.settings.realism, depthDetail: (shellState.settings.depth && shellState.settings.depth.detail) || "standard", relight: shellState.settings.relight });
// settings.key as stored, as host.loadKeyValues() would read it: status.key (and the assistant's ask card, which shows
// what a key_screen without `trust` sends) report the stored values before a key or the Key dialog has run once
host.keyStored = (shellState.settings && shellState.settings.key) || null;
host._keyLoaded = true;

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
let atlasMB = (shellState.settings.memory && shellState.settings.memory.atlasMB) != null ? Math.max(16, shellState.settings.memory.atlasMB) : 512;

/** The undo history's depth (settings.history, Settings › Memory): every open editor now, and every new one. */
function historyDepth() {
    const h = shellState.settings.history || {};
    return { steps: Math.min(500, Math.max(5, Math.round(+h.steps) || 30)), mb: Math.min(8192, Math.max(64, Math.round(+h.mb) || 384)) };
}
function applyHistoryDepth(ed) {
    const d = historyDepth();
    for (const e of ed ? [ed] : host.editors()) e.setUndoDepth({ steps: d.steps, bytes: d.mb * 1048576 });
}

function newDocument(id) {
    const editor = new InpaintEditor({ id: id || host.nextId++, title: "Scumble" });
    editor.newCanvasTab = () => newCanvasInTab(editor).catch((err) => { console.warn("new canvas tab", err); editor.setStatus(`New: ${err.message || err}`, "error"); });   // New keeps a document with work in it (issue #12)
    editor.onSettingSet = (target, value) => host.rememberValues(editor, [[target, value]]);   // a row you set stays the recipe's (issue #12)
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

/**
 * The editor's New in the app (issue #12): a document with work in it stays as it is and the new canvas opens in a tab
 * of its own (the editor's New button calls this through `editor.newCanvasTab`; the node's editor has none and asks to
 * replace, as before). A tab with nothing to lose takes the canvas in place. A New cancelled in the new tab closes it.
 */
async function newCanvasInTab(editor) {
    if (!host.replaceLoss(editor)) return editor.newCanvas();
    const fresh = newDocument();
    activate(fresh);
    await fresh.newCanvas();
    if (!fresh.base && host.editors().includes(fresh)) {
        await closeDocument(fresh, { force: true, remember: false });
        if (host.editors().includes(editor)) activate(editor);
    }
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
async function closeDocument(editor, { force = false, remember = true } = {}) {
    if (!editor || !host.editors().includes(editor)) return false;
    // a render on the user's ComfyUI counts (busy() leaves it out): its result lands nowhere once the tab is closed
    // (one the bar no longer follows, deleted from ComfyUI's queue or ended unseen, does not count)
    const rendering = !!(editor._localRuns && [...editor._localRuns].some((id) => !editor.runProgress || editor.runProgress.wants(id)));
    // a run in the title row stops with the tab (host.removeEditor cancels it): an API run's provider may still charge
    // a job it already had, a picture run on the user's ComfyUI lands nothing. A tab with no picture asks too while a
    // run holds it (Generate new, whose paid job would stop unasked); a save going on is named beside the run
    const runs = host.runsOf ? host.runsOf(editor) : [];
    const paid = runs.find((t) => t.provider && t.provider !== "comfyui");
    const what = [editor._docSaving ? "saving" : "",
        paid ? `a run on ${paid.label || paid.provider}: closing stops it, and the provider may still charge it`
            : runs.length ? "a run on your ComfyUI: closing stops it, and its result would be lost"
                : rendering && !busy(editor) ? "a render on your ComfyUI; its result would be lost" : ""].filter(Boolean);
    const why = what.length ? ` (${what.join("; ")})` : "";
    if (!force && (editor.base || runs.length) && (busy(editor) || rendering) && !(await dialogs.confirm(`${docName(editor)} is still working${why}. Close it anyway?`, { ok: "Close", danger: true }))) return false;
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
    // remember false (close_document's, a --run's own tabs): not on File › Reopen Closed Tab, nor in the autosave's list
    if (remember) { try { await host.rememberClosed(editor); } catch (err) { console.warn("closed tab", err); } }
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
        if (host.editor) host.editor.setStatus("Could not reopen the tab: " + String((err && err.message) || err), failKind(err));
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
host.shell = { newDocument, activate, closeDocument, selectRecipe: (id, provider) => selectRecipe(id, provider), recipes: () => shellState.recipes, resolveRecipe, modeOf: (r) => modeOf(r), openSettings, openGenerateNew: (ed) => openGenerateNew(ed), openUpscale: (ed) => openUpscale(ed), genField: () => genField, genSyncRefs: () => genSyncRefs(),
    // New with a model (item 34, docs/PLAN_NEW_PRESETS.md section 8): the models with their aspects and size classes, the
    // preset New made (remembered, its recipe selected), and what Generate new offers for a recipe on a provider
    newCanvasChoices: (ed) => newCanvasChoices(ed), newCanvasChosen: (ed, target) => newCanvasChosen(ed, target), genPresetOf: (r, pid) => genPresetOf(r, pid),
    // list_recipes' readiness (docs/PLAN_0_1_42.md F2a): a resolved recipe's key or in-app model ({ ok, text } or null for
    // a ComfyUI recipe), and the API providers with whether a key is stored, as booleans only (never the key's hint)
    keyState: (r) => providerKeyState(r),
    providerKeys: () => shellState.providers.map((p) => ({ id: p.id, label: p.label, key: !!(p.key && p.key.set), shares_key: p.sharesKey || null })) };
ui.tabAdd.addEventListener("click", () => activate(newDocument()));

// ---- connection --------------------------------------------------------------------------

function showStatus(st) {
    shellState.lastStatus = st;
    // no ComfyUI at the URL (main's `absent`): a calm grey dot, not the red one of a real error
    ui.dot.className = "dot " + (st.state || "") + (st.absent ? " absent" : "");
    ui.statusText.textContent = st.message || st.state || "";
    ui.statusText.title = [st.hint || st.url, st.devices, st.auth ? "with auth headers" : ""].filter(Boolean).join("\n");
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
    shellState.settings = await window.scumble.settings.get();
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
        shellState.lastProbe = p;
        const lines = [];
        const line = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };
        lines.push(line("ok", `ComfyUI ${p.version} reached in ${p.latency} ms` + (p.os ? ` (${p.os}, Python ${p.python})` : "")));
        for (const d of p.devices) lines.push(line("", `  ${d.name}` + (d.vramTotal ? `, VRAM ${fmtGb(d.vramFree)} free of ${fmtGb(d.vramTotal)}` : "")));
        if (p.queue) lines.push(line("", `  queue: ${p.queue.running} running, ${p.queue.pending} pending`));
        lines.push(line(p.node ? "ok" : "bad", p.node ? `Inpaint Canvas node pack ${p.nodeVersion || "present"}` : "Inpaint Canvas node pack missing: install it there with git clone https://github.com/DenRakEiw/ComfyUI-InpaintCanvas in custom_nodes, then restart ComfyUI"));
        for (const r of shellState.recipes.filter((x) => x.kind !== "provider")) {
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

shellState.recipes = [];
shellState.providers = [];
ui.recipe.addEventListener("change", () => selectRecipe(ui.recipe.value));

// The editor's local / api / cloud select: switch to the recipe last used in that mode (else the first one).
host.onModeChanged = (mode, editor) => {
    const cur = shellState.recipes.find((x) => x.id === ui.recipe.value);
    if (cur && modeOf(cur) === mode) return;
    const want = (shellState.settings.recipeByMode || {})[mode];
    const r = shellState.recipes.find((x) => x.id === want && modeOf(x) === mode && x.task !== "relight") || shellState.recipes.find((x) => modeOf(x) === mode && x.task !== "relight");
    if (r) { selectRecipe(r.id); return; }
    if (cur) { editor.genSettings.mode = modeOf(cur); editor.syncGenControls(); }
    editor.setStatus(mode === "api" ? "No API recipe: add a provider key in Settings (Ctrl+,) › API providers."
        : mode === "cloud" ? "No Comfy Cloud recipe yet: open a workflow or one of Comfy's templates in the ComfyUI window on Comfy Cloud and Save as new recipe, or import one exported from Comfy Cloud (Settings › Recipes)."
        : "No ComfyUI recipe installed.", "warn");
};
ui.recipeImport.addEventListener("click", () => importRecipe());
ui.recipeFolder.addEventListener("click", () => window.scumble.recipes.openFolder());

// The template list at start. It used to sit inside saveCompat(), where only saving the
// compatible endpoint ever ran it, so the "Generate a new image" dialog offered no template
// until the Settings dialog had been opened once.
host.promptTemplateIds = { upsample: "", generate: "", ...(shellState.settings.promptTemplates || {}) };
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
/** The general aspects (the dialog's list without "free"): what a variant that names none of its own is offered. */
const GEN_GENERAL = GEN_ASPECTS.filter((a) => a !== "free");
shellState.genRemapOff = null;      // the field as a remap target of genEditor while the dialog is open
shellState.genPrevious = null;      // the text before an upsample (Revert)

ui.genMode.addEventListener("change", () => genFillRecipes());
ui.genRecipe.addEventListener("change", () => genFillProviders());
ui.genProvider.addEventListener("change", () => { genFillAspects(); genFillSizes(); genTransparencyRow(); genSyncNote(); genSyncRefs(); });
ui.genTemplate.addEventListener("change", () => {
    genSyncTemplateNote();
    window.scumble.settings.set({ promptTemplates: { ...(shellState.settings.promptTemplates || {}), generate: ui.genTemplate.value } }).then((s) => { shellState.settings = s; }).catch(() => { /* not fatal */ });
});
// a tier counted by area names a class per aspect (Oxen's 1024 px: 2 MP at 1:1, 1 MP at 16:9): the labels follow it
ui.genAspect.addEventListener("change", () => genFillSizes());
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
    if (shellState.genRemapOff) { shellState.genRemapOff(); shellState.genRemapOff = null; }
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
        shellState.genPrevious = carry(before);
        genField.setText(text);
        const note = cmp ? checkNote(cmp) : "";
        ui.genUpsampleNote.textContent = `${text.split(/\s+/).length} words in ${res.seconds.toFixed(1)} s${res.note ? ", " + res.note : ""}.${note ? " " + note : ""}`;
        const revert = document.createElement("button");
        revert.type = "button";
        revert.id = "gen-upsample-revert";
        revert.textContent = "Revert";
        revert.title = "Put the prompt from before the upsample back";
        revert.addEventListener("click", () => {
            if (stale() || shellState.genPrevious == null) return;
            // the old text follows the references too
            genField.setText(remap(shellState.genPrevious, now, ed ? ed.refLabels() : now));
            shellState.genPrevious = null;
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
    // the answer replaces the picture, its layers and the undo history: a tab with work in it stays as it is and the
    // new picture goes into a tab of its own, which takes the reference layers along (issue #12); a tab with nothing
    // to lose (no picture yet, an untouched blank canvas) takes it in place
    ui.genGo.disabled = true;
    let fresh = null;
    if (host.replaceLoss(ed)) {
        ui.genState.textContent = "opening a new tab ...";
        try { fresh = await host.newTabFrom(ed); } catch (err) { console.warn("new tab", err); }
        if (!fresh) { ui.genState.textContent = "Could not open a new tab for the picture."; ui.genGo.disabled = false; return; }
    }
    const target = fresh || ed;
    // which layer each token means at the click (a change after it refuses rather than re-points); the new tab's
    // reference layers keep their ids, so the tokens mean the same pictures there
    const refs = Object.fromEntries([...target.refLabels()].map(([lid, n]) => ["img" + n, lid]));
    const [w, h] = genSize();
    ui.genState.textContent = "running ...";
    try {
        await selectRecipe(id, ui.genProvider.value || undefined);
        // a chosen aspect goes along as itself (the same size as genSize), so a ratio channel is asked for
        // "3:2", not the reduced ratio of the rounded 1024 x 688 ("64:43")
        const args = genAspectFree()
            ? { doc: target.node.id, prompt, width: w, height: h, timeout: 900 }
            : { doc: target.node.id, prompt, aspect: ui.genAspect.value, resolution: +ui.genResolution.value || 1024, timeout: 900 };
        if (Object.keys(refs).length) args.refs = refs;
        if (!ui.genSeedRandom.checked) args.seed = Math.abs(Math.round(+ui.genSeed.value) || 0);
        if (!ui.genAlphaRow.hidden && ui.genAlpha.checked) args.background = "transparent";
        const out = await commands.run("generate_new", args);
        ui.gen.close();
        ui.genState.textContent = "";
        activate(target);
        console.log("[generate_new]", out);
    } catch (err) {
        ui.genState.textContent = String(err.message || err);
        // a run that failed leaves no tab behind: the document it came from is back in front, as it was; a run still
        // going there (the wait timed out on a busy queue) keeps its tab, so its answer has a place to land
        if (fresh && host.editors().includes(fresh) && !busy(fresh)) {
            await closeDocument(fresh, { force: true, remember: false });
            if (host.editors().includes(ed)) activate(ed);
        }
    } finally {
        ui.genGo.disabled = false;
    }
});
host.on("realism", upResyncPass);

// each control writes settings.realism whole (host.setRealismValues fills the rest; the key is `intensity`)
ui.upPassStyle.addEventListener("change", () => { host.setRealismValues({ style: ui.upPassStyle.value }); });
ui.upPassPreset.addEventListener("change", () => { host.setRealismValues({ preset: ui.upPassPreset.value }); });
ui.upPassStrength.addEventListener("input", () => { ui.upPassStrengthV.textContent = (+ui.upPassStrength.value).toFixed(2); });
ui.upPassStrength.addEventListener("change", () => { host.setRealismValues({ intensity: +ui.upPassStrength.value }); });

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
    const pass = isPassRecipe(shellState.recipes.find((r) => r.id === id));
    ui.upGo.disabled = true;
    try {
        // the pass selects no recipe: it would become the window's, and the next Generate would run its box route
        // nor is it remembered as the upscaler last used (the Image menu opens it directly)
        if (!pass) selectRecipe(id, ui.upProvider.value || undefined);
        if (!pass && shellState.settings.upscaleRecipe !== id) window.scumble.settings.set({ upscaleRecipe: id }).then((s) => { shellState.settings = s; }).catch(() => { /* not fatal */ });
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
        ed.setStatus(String(err.message || err), failKind(err));
    } finally {
        ui.upGo.disabled = false;
    }
});

// the llm object is read fresh and spread, as the other llm writers do, so the endpoint and the rows stay
ui.promptRefPics.addEventListener("change", async () => {
    const on = ui.promptRefPics.checked;
    host.llmRefPictures = on;
    const set = await window.scumble.settings.get();
    shellState.settings = await window.scumble.settings.set({ llm: { ...(set.llm || {}), refPictures: on } });
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

shellState.helpersRenderTimer = null;
window.scumble.helpers.onProgress((ev) => {
    if (ev.error) downloadErrors[ev.id] = ev.error;
    if (!ui.settings.open) return;
    clearTimeout(shellState.helpersRenderTimer);
    shellState.helpersRenderTimer = setTimeout(async () => { try { renderHelpers(await window.scumble.helpers.status()); } catch (_) { /* closing */ } }, ev.done || ev.error ? 0 : 250);
});
host.onHelpersChanged = (st) => { if (ui.settings.open) renderHelpers(st); };
// SAM2, matting and depth fell back to main's thread for the session (electron/main/onnx/helpers.js _fallBack, once):
// a warning line, and once more after the helper calls in flight wrote their own lines, so the note is what stays
window.scumble.helpers.onNotice((n) => {
    if (!n || !n.message) return;
    const say = () => { if (host.editor) host.editor.setStatus(String(n.message), n.kind === "error" ? "error" : "warn"); };
    const waiting = host.helperCalls > 0;
    say();
    if (waiting) host.whenHelpersIdle().then(() => setTimeout(say, 800));
});

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

shellState.providerTimer = null;
const cancelButton = $("shell-cancel");
// the title row's Cancel (an API run that does not come back): main stops waiting, the tab's status line says so
if (cancelButton) cancelButton.addEventListener("click", () => { cancelButton.disabled = true; host.cancelProviderRuns(); });
host.onProviderRuns = (runs) => {
    clearInterval(shellState.providerTimer); shellState.providerTimer = null;
    if (cancelButton) { cancelButton.hidden = !runs.length; cancelButton.disabled = false; }
    if (!runs.length) { ui.progress.hidden = true; ui.progress.classList.remove("indeterminate"); ui.progressBar.style.left = ""; renderTabs(); return; }
    ui.progress.hidden = false;
    ui.progress.classList.add("indeterminate");
    const tick = () => {
        const r = runs[0];
        ui.progressText.textContent = `${r.label || r.provider} · ${Math.round((Date.now() - r.started) / 1000)} s${runs.length > 1 ? ` (+${runs.length - 1})` : ""}`;
    };
    tick();
    shellState.providerTimer = setInterval(tick, 1000);
    renderTabs();
};
setInterval(() => { watchMemory(); }, 30000);

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
const UPDATE_LABELS = { install: ui.updateInstall.textContent, barTitle: ui.updateBar.title };
shellState.lastUserInput = 0;            // a key, a click or a wheel turn anywhere: the question does not cut into typing
for (const type of ["keydown", "pointerdown", "wheel"]) window.addEventListener(type, () => { shellState.lastUserInput = Date.now(); }, { capture: true, passive: true });

window.scumble.updates.onStatus((s) => { renderUpdate(s); announceUpdate(s); });
// a status from before this window listened (a window reloaded after a crash): main's `announced` says whether it asked
window.scumble.updates.status().then((s) => { renderUpdate(s); announceUpdate(s); }, () => { /* no updater */ });
if (window.scumble.starNote) window.scumble.starNote().then(showStarNote, () => { /* an older main */ });
ui.updateCheck.addEventListener("click", async () => { renderUpdate(await window.scumble.updates.check()); });
ui.updateInstall.addEventListener("click", () => updateAction());
ui.updateBar.addEventListener("click", () => updateAction());
ui.netCurl.addEventListener("change", async () => { shellState.settings = await window.scumble.settings.set({ network: { ...(shellState.settings.network || {}), curl: ui.netCurl.checked } }); renderNetwork(); });
ui.updateAuto.addEventListener("change", async () => { shellState.settings = await window.scumble.settings.set({ updates: { ...(shellState.settings.updates || {}), check: ui.updateAuto.checked } }); });

// the assistant's two numbers and the one button that deletes everything it stored (A6)
ui.setAsKeep.addEventListener("change", async () => {
    const v = Math.min(200, Math.max(1, Math.round(Number(ui.setAsKeep.value) || 20)));
    ui.setAsKeep.value = v;
    shellState.settings = await window.scumble.settings.set({ assistant: { ...(shellState.settings.assistant || {}), keepChats: v } });
});
ui.setAsSteps.addEventListener("change", async () => {
    const v = Math.min(100, Math.max(1, Math.round(Number(ui.setAsSteps.value) || 25)));
    ui.setAsSteps.value = v;
    shellState.settings = await window.scumble.settings.set({ assistant: { ...(shellState.settings.assistant || {}), maxSteps: v } });
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
        shellState.settings = await window.scumble.settings.get();
        ui.setAsKeep.value = Math.max(1, Math.round(Number((shellState.settings.assistant || {}).keepChats) || 20));
        ui.setAsSteps.value = Math.max(1, Math.round(Number((shellState.settings.assistant || {}).maxSteps) || 25));
        ui.setAsNote.textContent = "every chat, screenshot and log line of the assistant is gone; the keys are untouched";
    } catch (err) {
        ui.setAsNote.textContent = "could not delete: " + ((err && err.message) || err);
    }
});

ui.setGpuLimit.addEventListener("change", async () => {
    const v = Math.max(0, Math.round(Number(ui.setGpuLimit.value) || 0));
    ui.setGpuLimit.value = v;
    shellState.settings = await window.scumble.settings.set({ memory: { ...(shellState.settings.memory || {}), gpuLimitMB: v } });
});
ui.setCardMin.addEventListener("change", async () => {
    const v = Math.max(0, Math.round(Number(ui.setCardMin.value) || 0));
    ui.setCardMin.value = v;
    shellState.settings = await window.scumble.settings.set({ memory: { ...(shellState.settings.memory || {}), cardMinFreeMB: v } });
});
ui.setAtlas.addEventListener("change", async () => {
    const v = Math.max(16, Math.round(Number(ui.setAtlas.value) || 0));
    ui.setAtlas.value = v;
    shellState.settings = await window.scumble.settings.set({ memory: { ...(shellState.settings.memory || {}), atlasMB: v } });
    applyAtlasBudget(v);
});
for (const [input, key, min, max] of [[ui.setUndoSteps, "steps", 5, 500], [ui.setUndoMB, "mb", 64, 8192]]) {
    input.addEventListener("change", async () => {
        const v = Math.min(max, Math.max(min, Math.round(Number(input.value) || 0)));
        input.value = v;
        shellState.settings = await window.scumble.settings.set({ history: { ...historyDepth(), [key]: v } });
        applyHistoryDepth();
    });
}
ui.setTiles.addEventListener("change", async () => {
    shellState.settings = await window.scumble.settings.set({ tiles: ui.setTiles.checked });
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
    // an undo's files being stored again (InpaintEditor.recheckRestoredFiles: a base upload, layers marked for the rounds
    // below): the bundle would name the file that is gone
    for (const until = Date.now() + 30000; eds.some((ed) => ed._fileCheck) && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
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
        ed.setStatus("Not saved: " + ipcMessage(err), ipcKind(err));
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
        if (host.editor) host.editor.setStatus(`Could not open ${name}: ${ipcMessage(err)}`, ipcKind(err));
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
            else if (host.editor) host.editor.setStatus(`${f.name} has no path on disk; open it with File › Open.`, "info");
        }
    })();
}, true);
window.scumble.documents.onOpenRequest(async (paths) => { for (const p of paths || []) await openDocumentFromUi(p); });
// documents named by a second start (a double click on a .scumble); the start takes the first ones itself, after the
// session's tabs are back
shellState.takesPending = false;
window.scumble.documents.onPending(async () => { if (shellState.takesPending) await openPendingDocuments(); });
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
    window.scumble.window.isFullScreen().then((on) => { shellState.windowFullScreen = !!on; }, () => { /* no window */ });
    window.scumble.window.onFullScreenChange((on) => {
        shellState.windowFullScreen = !!on;
        if (!on && shellState.canvasOnlyState) leaveCanvasOnly({ fullScreenGone: true });
    });
} catch (_) { /* an older preload */ }
// a tab switch ends the view, from wherever it comes (the tab bar, a command, a document opened), and so does closing
// its tab: removeEditor() makes the next tab the active one before it activates it, so no "activate" is heard for that
host.on("activate", ({ editor }) => { if (shellState.canvasOnlyState && shellState.canvasOnlyState.ed !== editor) leaveCanvasOnly(); });
host.on("removed", ({ editor }) => { if (shellState.canvasOnlyState && shellState.canvasOnlyState.ed === editor) leaveCanvasOnly(); });

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
    if (shellState.canvasOnlyState || !ed || !ed.canvas) return Promise.resolve();
    const st = shellState.canvasOnlyState = { ed, wasFullScreen: shellState.windowFullScreen, view: { ...ed.view }, fitted: ed._fitted, rulers: ed.showRulers, w: ed.width, h: ed.height };
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
    const st = shellState.canvasOnlyState;
    if (!st) return Promise.resolve();
    shellState.canvasOnlyState = null;
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
    if (!(r > 0)) { ed.setStatus("The radius has to be a number of pixels.", "warn"); return; }
    try { await ed.frequencySeparation({ radius: r }); } catch (err) { ed.setStatus(`Frequency separation failed: ${err.message || err}`, failKind(err)); }
}

/** The canvas-only view on (`true`), off (`false`) or toggled (left out); resolves with the state after. */
async function canvasOnly(on) {
    const want = on === undefined ? !shellState.canvasOnlyState : !!on;
    await (want ? enterCanvasOnly() : leaveCanvasOnly());
    return !!shellState.canvasOnlyState;
}

function isCanvasOnly() {
    return !!shellState.canvasOnlyState;
}

/** Help and the assistant are columns beside the picture: asked for in the canvas-only view, the view ends, and one that is open already just shows. */
function showColumn(isOpen, toggle) {
    if (shellState.canvasOnlyState) {
        leaveCanvasOnly();
        if (isOpen()) return;
    }
    toggle();
}

// Tab toggles the view, Escape leaves it. Registered here, before any editor opens, so it runs before the editor's own
// capture listener: Tab is free there, and Escape stays the editor's while it has something to cancel. Not in a text
// field, a dialog (Help, the assistant, Settings) or the editor's question; Shift+Tab and Ctrl+Tab are not the view's.
window.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" && !(e.key === "Escape" && shellState.canvasOnlyState)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (document.querySelector("dialog:modal")) return;   // Settings and the like, also when their focused field was re-rendered away
    const t = e.target;
    // under the view the Help and assistant columns are covered: a key that lands there is the view's (the assistant's
    // question is drawn over the picture and keeps its own keys)
    const covered = shellState.canvasOnlyState && t && t.closest && t.closest("#help, #assistant") && !t.closest(".as-ask");
    if (!covered && t && t.closest && t.closest("dialog[open], [data-own-keys]")) return;   // a panel of its own (the Key dialog) keeps Tab
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
    else if (cmd === "new-relight-layer" || cmd === "relight") { if (host.editor) host.editor.addFilterLayer("relight"); }
    else if (cmd === "realism-pass") { if (host.editor) openUpscale(host.editor, { recipe: realism.RECIPE_ID }); }
    else if (cmd === "split-layers") { if (host.editor) import("./splitdialog.js").then((m) => m.openSplitDialog(host.editor)).catch((err) => console.warn("the Split dialog", err)); }
    else if (cmd === "key-screen") { if (host.editor) import("./keydialog.js").then((m) => m.openKeyDialog(host.editor)).catch((err) => console.warn("the Key dialog", err)); }
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
// the tips first and on their own: an autosave that cannot be read must not leave the library empty, or the next tip
// change would write that empty list over the stored tips
try { await host.loadBrushTips(); } catch (err) { console.warn("brush tips", err); }
try {
    const saved = startMode === "safe" ? null : await window.scumble.state.load();
    if (saved) await host.restore(saved);
} catch (err) {
    console.warn("no autosaved state", err);
}
if (!host.editors().length) newDocument();
activate(host.editor);
if (startMode === "safe") host.editor.setStatus("The window crashed twice while it restored your documents: they are kept, Settings › Local files › Earlier states opens them.", "warn");
await loadProviders();
await loadRecipes();
host.presets = shellState.settings.recipePresets || {};
host.loras = shellState.settings.recipeLoras || {};
host.recipeValues = shellState.settings.recipeValues || {};   // the Settings rows you last set, per recipe (issue #12)
await host.refreshHelpers();
await host.refreshLLMs();
selectRecipe(shellState.settings.recipe);
// documents named at the start (a double click, a second start): after the session's tabs are back and the recipe is
// chosen (an open compares the document's recipe with it)
shellState.takesPending = true;
await openPendingDocuments();

/**
 * The window's side of the Comfy Cloud notes (S6; the fix contract of 0.1.49, section 2): main reads every note it
 * has not handed to this page (none while no window is visible), and the window asks one at a time; an event or the
 * timer that comes while an ask runs makes exactly one more ask after it. While main keeps jobs, the next ask comes
 * 90 s later (one timer at a time; an ask that starts otherwise replaces it). `api` and `recheckMs` are what the
 * gates stand in for.
 */
export const cloudJobs = {
    api: {
        recover: () => (window.scumble.providers && typeof window.scumble.providers.recoverCloudJobs === "function" ? window.scumble.providers.recoverCloudJobs() : null),
        ack: (jobId) => window.scumble.providers.ackCloudJob(jobId),
    },
    recheckMs: 90000,
    asking: false,
    again: false,
    timer: null,
    said: "",     // the counts the line in front named last: an ask that brings nothing new does not say them again
    asks: 0,
};

// Comfy Cloud results that came in after Scumble closed, or that a run of this session could not bring
// (docs/PLAN_COMFY_SDK.md S6): each opens as a document of its own; main says when its notes changed (a run kept one,
// a hidden window was shown)
if (window.scumble.providers && typeof window.scumble.providers.onCloudJobsChanged === "function") {
    window.scumble.providers.onCloudJobsChanged(() => { recoverCloudResults(); });
}
recoverCloudResults();
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
/**
 * A recipe saved from the ComfyUI window under a new id takes the LoRA rows of the recipe it was saved from (item 50,
 * docs/PLAN_LORAS.md §3.2; main's comfyview:saved names it `from`); Save to recipe keeps the id, so nothing moves, and
 * a graph saved from no recipe starts with none. Whether rows were copied; exported for the `loras` gate.
 */
export async function copySavedLoras({ id, from } = {}) {
    if (!id || !from || from === id) return false;
    const rows = host.loraRows(from);
    if (!rows.length) return false;
    await host.saveLoras(id, rows.map((r) => ({ ...r })));
    return true;
}

// a graph saved from the ComfyUI window (item 35 V3): the recipes again, and the saved one selected
window.scumble.comfyView.onSaved(async ({ id, message, from }) => {
    try { await copySavedLoras({ id, from }); } catch (err) { console.warn("loras of the saved recipe", err); }
    await loadRecipes();
    if (ui.settings.open) renderRecipeList();
    selectRecipe(id);
    if (host.editor && message) host.editor.setStatus(message);
});
const comfyEditButton = $("shell-comfy-edit");
if (comfyEditButton) comfyEditButton.addEventListener("click", () => openRecipeInComfy(ui.recipe.value));

/**
 * One ask (the start's, main's onCloudJobsChanged, the 90 s timer): each picture of a job that finished opens as a
 * new document in the background (the document in front stays in front, which names them), and its note goes once
 * the picture is in; the line in front says what main keeps, by why it keeps it.
 */
async function recoverCloudResults() {
    const c = cloudJobs;
    if (c.asking) { c.again = true; return; }
    c.asking = true;
    clearTimeout(c.timer);
    c.timer = null;
    let r = null;
    try {
        c.asks++;
        r = await c.api.recover();
        const opened = await openCloudResults((r && r.pictures) || []);
        const counts = r ? cloudCountWords(r) : "";
        const say = [opened, counts && (opened || counts !== c.said) ? counts : ""].filter(Boolean).join(" ");
        c.said = counts;
        if (say && host.editor) host.editor.setStatus(say, "info");
    } catch (err) {
        console.warn("cloud jobs:", err && err.message);
    } finally {
        c.asking = false;
        if (c.again) { c.again = false; recoverCloudResults(); }
        else if (r && r.kept > 0) c.timer = setTimeout(() => { c.timer = null; recoverCloudResults(); }, c.recheckMs);
    }
}

/** What main keeps, one sentence per reason (Comfy Cloud running/unanswered/unread, or a kept local file), or "". */
function cloudCountWords(r) {
    const n = (k) => Math.max(0, Math.floor(+r[k] || 0));
    const out = [];
    if (!r.skipped) {
        const running = n("running"), unanswered = n("unanswered"), unread = n("unread");
        if (running) out.push(running === 1 ? "1 Comfy Cloud job is still running: Scumble opens its picture when it is done." : `${running} Comfy Cloud jobs are still running: Scumble opens their pictures when they are done.`);
        if (unanswered) out.push(unanswered === 1 ? "Comfy did not answer about 1 Comfy Cloud job: Scumble asks again in 90 s." : `Comfy did not answer about ${unanswered} Comfy Cloud jobs: Scumble asks again in 90 s.`);
        if (unread) out.push(unread === 1 ? "1 finished Comfy Cloud job could not be downloaded yet: Scumble tries again in 90 s." : `${unread} finished Comfy Cloud jobs could not be downloaded yet: Scumble tries again in 90 s.`);
    }
    const localUnread = n("localUnread");
    if (localUnread) out.push(localUnread === 1 ? "1 kept provider result could not be read from disk yet: Scumble tries again in 90 s." : `${localUnread} kept provider results could not be read from disk yet: Scumble tries again in 90 s.`);
    return out.join(" ");
}

/**
 * Opens brought-back pictures as background documents; a picture that does not open keeps its note (main hands it
 * to this page once, so the next start asks). `earlier`: the note was written before this start (else a run of this
 * session could not bring its picture). The line for the document in front naming the new tabs, or "".
 */
async function openCloudResults(pictures) {
    const opened = [];
    const labels = new Set();
    let allEarlier = true;
    for (const p of pictures) {
        const ed = newDocument();
        const isComfy = !p.provider || p.provider === "comfycloud";
        const provLabel = isComfy ? "Comfy Cloud" : String(p.providerLabel || p.provider);
        const article = /^[aeiou]/i.test(provLabel) ? "An" : "A";
        const slug = isComfy ? "comfy-cloud" : (String(p.provider || provLabel).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider");
        const ext = /jpe?g/i.test(p.mime || "") ? "jpg" : /webp/i.test(p.mime || "") ? "webp" : "png";
        const name = `${slug}-${String(p.jobId).slice(0, 8)}.${ext}`;
        await ed.loadFile(new File([p.bytes], name, { type: p.mime || "image/png" }), { ask: false });
        const earlier = p.earlier !== false;
        if (!ed.base) {
            ed.setStatus(!p.provider
                ? `${ed.status} This Comfy Cloud result${earlier ? " of an earlier run" : ""} could not be opened; Scumble asks Comfy for it again at the next start.`
                : `${ed.status} This ${provLabel} result${earlier ? " of an earlier run" : ""} could not be opened; Scumble tries its kept file again at the next start.`, "error");
            continue;
        }
        const when = p.started ? new Date(p.started).toLocaleString() : "earlier";
        const model = p.model || provLabel;
        ed.setStatus(earlier
            ? `${article} ${provLabel} result ${isComfy ? "that came in after Scumble closed" : "kept from an earlier session"} (${model}, started ${when}): opened as a document of its own.`
            : `${article} ${provLabel} result its run could not bring at the time (${model}, started ${when}): opened as a document of its own.`);
        try { await cloudJobs.api.ack(p.jobId); } catch (_) { /* the next start brings it again */ }
        opened.push(ed);
        labels.add(provLabel);
        if (!earlier) allEarlier = false;
    }
    if (!opened.length || !host.editor || opened.includes(host.editor)) return "";
    // "of an earlier run" only when each came in after Scumble closed, not for a picture a run of this session missed
    const ofEarlier = allEarlier ? " of an earlier run" : "";
    const singleProv = labels.size === 1 ? [...labels][0] : null;
    const singleArt = singleProv && /^[aeiou]/i.test(singleProv) ? "An" : "A";
    const lead = singleProv
        ? (opened.length === 1 ? `${singleArt} ${singleProv} result` : `${opened.length} ${singleProv} results`)
        : `${opened.length} provider results`;
    return `${lead}${ofEarlier} opened in ${opened.length === 1 ? "a tab" : "tabs"} of ${opened.length === 1 ? "its" : "their"} own: ${opened.map((e) => docName(e)).join(", ")}.`;
}

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
    const r = shellState.recipes.find((x) => x.id === id);
    const say = (text, kind) => { if (host.editor) host.editor.setStatus(text, kind); };
    if (!r) return say("No recipe is selected.");
    const cloud = r.kind === "provider" && cloudGraphOf(r);
    if (r.kind === "provider" && !cloud) return say(`"${r.name || r.id}" runs through a provider, not through ComfyUI: it has no graph to edit.`);
    window.scumble.comfyView.open(cloud ? { recipe: r.id, target: "cloud" } : { recipe: r.id }).catch((err) => say(String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, ""), failKind(err)));
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

export { newDocument, activate, closeDocument, canvasOnly, isCanvasOnly, openSettings, openConsole, selectRecipe, loadRecipes, importRecipe, testConnection, connect, commands, plugins, watchMemory, cardMemory, cardShortfall, saveBeforeRestart, recoverCloudResults, showKeysNote, keysNote, openGenerateNew, upFactors, openUpscale, memoryReads, renderUpdate, releasePage, updateLinks, updateQuestionDetail, announceUpdate, skipUpdate, $, cloudGraphOf, historyDepth, openRecipeInComfy, refPicturesOn, syncAuthRows, ui, GEN_GENERAL, UPDATE_LABELS, busy };
