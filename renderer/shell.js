// The shell around the editor: connection bar, recipe picker, progress, menu commands.
import { host, api } from "./editor/host.js";
import { InpaintEditor } from "./editor/inpaint_canvas.js";

const $ = (id) => document.getElementById(id);
const ui = {
    recipe: $("shell-recipe"), recipeNote: $("shell-recipe-note"), url: $("shell-url"), connect: $("shell-connect"),
    dot: $("shell-dot"), statusText: $("shell-status-text"), progress: $("shell-progress"), progressBar: $("shell-progress-bar"), progressText: $("shell-progress-text"),
};

let settings = await window.scumble.settings.get();
ui.url.value = (settings.comfy && settings.comfy.url) || "http://127.0.0.1:8188";

// ---- editor ----------------------------------------------------------------------------

const editor = new InpaintEditor({ id: 1, title: "Scumble" });
host.attach(editor, { mount: $("editor-host"), nodeParams: settings.nodeParams });
editor.open();
window.editor = editor;   // for tests and the devtools console

// ---- connection --------------------------------------------------------------------------

function showStatus(st) {
    ui.dot.className = "dot " + (st.state || "");
    ui.statusText.textContent = st.message || st.state || "";
    ui.statusText.title = [st.url, st.devices].filter(Boolean).join("\n");
    if (st.state === "connected" || st.state === "missing-node") host.onConnected(st).catch((err) => console.error(err));
}

async function connect() {
    const url = ui.url.value.trim();
    settings = await window.scumble.settings.set({ comfy: { ...(settings.comfy || {}), url } });
    showStatus(await window.scumble.comfy.connect(url));
}

ui.connect.addEventListener("click", connect);
ui.url.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); connect(); } });
window.scumble.comfy.onStatus(showStatus);
showStatus(await window.scumble.comfy.status());

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
selectRecipe(settings.recipe);

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

// ---- menu and files ----------------------------------------------------------------------

window.scumble.file.onOpened(({ name, data }) => {
    const type = /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.webp$/i.test(name) ? "image/webp" : "image/png";
    editor.loadFile(new File([data], name, { type }));
});
window.scumble.onMenu((cmd) => {
    if (cmd === "save") editor.exportImage();
    else if (cmd === "settings") ui.url.focus();
    else if (cmd === "guide") window.scumble.openExternal("https://github.com/DenRakEiw/ComfyUI-InpaintCanvas#readme");
});

// ---- restore the last session ------------------------------------------------------------

try {
    const state = await window.scumble.state.load();
    if (state) await host.restore(state);
} catch (err) {
    console.warn("no autosaved state", err);
}
