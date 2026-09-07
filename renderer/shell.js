// The shell around the editor: connection bar, recipe picker, progress, tabs (one editor
// per document), the settings dialog and the menu commands.
import { host, api } from "./editor/host.js";
import { InpaintEditor } from "./editor/inpaint_canvas.js";
import { glFiltersAvailable } from "./editor/inpaint_filters_gl.js";

const $ = (id) => document.getElementById(id);
const ui = {
    recipe: $("shell-recipe"), recipeNote: $("shell-recipe-note"), url: $("shell-url"), connect: $("shell-connect"),
    dot: $("shell-dot"), statusText: $("shell-status-text"), progress: $("shell-progress"), progressBar: $("shell-progress-bar"), progressText: $("shell-progress-text"),
    tabs: $("shell-tab-list"), tabAdd: $("shell-tab-add"),
    settings: $("shell-settings"), setUrl: $("set-url"), setConnect: $("set-connect"), setConn: $("set-conn"), setFiles: $("set-files"),
    setOpenFiles: $("set-open-files"), setPrune: $("set-prune"), setPruneNote: $("set-prune-note"), setGpu: $("set-gpu"), setAbout: $("set-about"),
};

let settings = await window.scumble.settings.get();
let lastStatus = { state: "disconnected", message: "not connected" };
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
    return !!(editor.pending || editor.segmentPending || editor.cutoutPending || editor.upsamplePending || editor.objectsPending || editor._loading);
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

function closeDocument(editor) {
    if (!editor) return;
    if (editor.base && busy(editor) && !window.confirm(`${docName(editor)} is still working. Close it anyway?`)) return;
    if (editor.base && !window.confirm(`Close ${docName(editor)}? The document stays in the local file store, but it leaves the tab bar.`)) return;
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
ui.tabAdd.addEventListener("click", () => activate(newDocument()));

// ---- connection --------------------------------------------------------------------------

function showStatus(st) {
    lastStatus = st;
    ui.dot.className = "dot " + (st.state || "");
    ui.statusText.textContent = st.message || st.state || "";
    ui.statusText.title = [st.url, st.devices].filter(Boolean).join("\n");
    ui.setConn.textContent = st.message || st.state || "";
    if (st.state === "connected" || st.state === "missing-node") host.onConnected(st).catch((err) => console.error(err));
}

async function connect(url) {
    url = (url || ui.url.value).trim();
    ui.url.value = url; ui.setUrl.value = url;
    settings = await window.scumble.settings.set({ comfy: { ...(settings.comfy || {}), url } });
    showStatus(await window.scumble.comfy.connect(url));
}

ui.connect.addEventListener("click", () => connect());
ui.url.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); connect(); } });
window.scumble.comfy.onStatus(showStatus);

// ---- recipes ---------------------------------------------------------------------------

const recipes = await window.scumble.recipes.list();
for (const r of recipes) {
    const o = document.createElement("option");
    o.value = r.id; o.textContent = r.name || r.id;
    ui.recipe.appendChild(o);
}
function selectRecipe(id) {
    const r = recipes.find((x) => x.id === id) || recipes[0];
    if (!r) { ui.recipeNote.textContent = "no recipes found"; return; }
    ui.recipe.value = r.id;
    ui.recipeNote.textContent = r.description || "";
    ui.recipeNote.title = r.description || "";
    host.setRecipe(r);
    if (settings.recipe !== r.id) window.scumble.settings.set({ recipe: r.id }).then((s) => { settings = s; });
}
ui.recipe.addEventListener("change", () => selectRecipe(ui.recipe.value));

// ---- progress ----------------------------------------------------------------------------

api.addEventListener("progress", ({ detail }) => {
    if (!detail || !detail.max) return;
    ui.progress.hidden = false;
    const pct = Math.round((detail.value / detail.max) * 100);
    ui.progressBar.style.width = pct + "%";
    ui.progressText.textContent = `${detail.value} / ${detail.max}`;
    if (detail.value >= detail.max) setTimeout(() => { ui.progress.hidden = true; }, 800);
});
api.addEventListener("execution_error", () => { ui.progress.hidden = true; });
api.addEventListener("execution_interrupted", () => { ui.progress.hidden = true; });
api.addEventListener("executed", () => setTimeout(renderTabs, 50));

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
    ui.setUrl.value = ui.url.value;
    ui.setConn.textContent = lastStatus.message || lastStatus.state || "";
    ui.setPruneNote.textContent = "";
    ui.setGpu.textContent = glFiltersAvailable() ? "Filter layers run on the GPU (WebGL2); the CPU code is the fallback." : "WebGL2 is not available here: filter layers run on the CPU.";
    try {
        const info = await window.scumble.info();
        ui.setAbout.textContent = `Scumble ${info.version} · Electron ${info.electron} · ${info.platform} · data in ${info.userData}`;
    } catch (_) { /* ignore */ }
    refreshFileStats();
    if (!ui.settings.open) ui.settings.showModal();
}

ui.setConnect.addEventListener("click", () => connect(ui.setUrl.value));
ui.setUrl.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); connect(ui.setUrl.value); } });
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
});

// ---- start: restore the last session, then connect ---------------------------------------

try {
    const saved = await window.scumble.state.load();
    if (saved) await host.restore(saved);
} catch (err) {
    console.warn("no autosaved state", err);
}
if (!host.editors().length) newDocument();
activate(host.editor);
selectRecipe(settings.recipe);
showStatus(await window.scumble.comfy.status());

export { newDocument, activate, closeDocument, openSettings };
