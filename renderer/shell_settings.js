// the Settings dialog: recipes and their groups, API providers, the local endpoint, language models, prompt templates, helpers, plugins, openSettings, earlier states, the tile mode: moved out of shell.js (item 56 S14b, docs/PLAN_SPLIT.md), text unchanged.

import * as dialogs from "./dialogs.js";
import * as plugins from "./plugins.js";
import { host } from "./editor/host.js";
import { glFiltersAvailable } from "./editor/inpaint_filters_gl.js";
import { refreshAssistantModels } from "./assistant.js";
import { renderAppearance } from "./skins.js";
import { failKind } from "./editor/inpaint_status.js";
import { shellState } from "./shell_state.js";
import { renderNetwork, renderUpdate, wholeMB } from "./shell_updates.js";
import { cardMemory, gpuMemoryMB } from "./shell_watch.js";
import { $, cloudGraphOf, historyDepth, openRecipeInComfy, refPicturesOn, syncAuthRows, ui } from "./shell.js";

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
    shellState.recipes = await window.scumble.recipes.list();
    // ComfyUI first, then the model families in a fixed order, unknown families after, names within
    const rank = (r) => { const i = FAMILY_ORDER.indexOf(familyOf(r)); return i < 0 ? FAMILY_ORDER.length : i; };
    shellState.recipes.sort((a, b) => rank(a) - rank(b) || familyOf(a).localeCompare(familyOf(b)) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
    const cur = shellState.recipes.find((r) => r.id === (ui.recipe.value || shellState.settings.recipe) && r.task !== "relight");
    renderRecipeOptions(cur ? modeOf(cur) : (ui.recipe.dataset.mode || "local"));
}

/** The recipe select lists the recipes of one mode: the editor's local / api / cloud select switches between them. */
function renderRecipeOptions(mode) {
    ui.recipe.innerHTML = "";
    ui.recipe.dataset.mode = mode;
    const shown = shellState.recipes.filter((r) => modeOf(r) === mode && r.task !== "relight");
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
    const p = shellState.providers.find((x) => x.id === id);
    return (p && p.label) || (id === "loopback" ? "Loopback" : id === "inapp" ? "In-app" : id);
}

/** The provider a model recipe runs on: the remembered choice, else the recipe's default. */
function chosenProvider(r) {
    if (r.kind !== "provider" || !r.providers) return null;
    // Relight's provider is each relight layer's route (its panel): a choice an older build stored is not read
    const want = r.task === "relight" ? null : (shellState.settings.recipeProviders || {})[r.id];
    return want && r.providers[want] ? want : (r.default || Object.keys(r.providers)[0]);
}

/** The recipe with the chosen provider's variant merged in (what host and the commands see). */
function resolveRecipe(r, pid = chosenProvider(r)) {
    if (!pid) return r;
    const v = r.providers[pid] || {};
    return { ...r, provider: pid, providerLabel: providerLabel(pid), model: v.model || "", input: v.input || "fill", fields: v.fields || null, fixed: v.fixed || null, settings: v.settings || [], options: v.options || null, note: v.note || "", text: v.text || null, limits: v.limits || null, edit: v.edit !== false, task: r.task || "edit", factor: v.factor || null, usesPrompt: !!v.usesPrompt, refs: v.refs || null, loras: v.loras };
}

function providerKeyState(r) {
    if (r.kind !== "provider") return null;
    const p = shellState.providers.find((x) => x.id === r.provider);
    if (r.provider === "inapp") {
        // no key: the model in the app's model folder (Settings › Helpers)
        return host.presentHelpers("inpaint").some((m) => m.id === r.model) ? { ok: true } : { ok: false, text: "the LaMa model is not downloaded yet: Settings (Ctrl+,) › Helpers (in-app models)" };
    }
    if (!p) return r.provider === "loopback" ? { ok: true } : { ok: false, text: `unknown provider "${r.provider}"` };
    if (p.key && p.key.stale) return { ok: false, text: `the ${p.label} key was stored on another PC or Windows account: type it again in Settings (Ctrl+,) › API providers` };
    return p.key && p.key.set ? { ok: true } : { ok: false, text: `no ${p.label} key yet: Settings (Ctrl+,) › API providers` };
}

async function rememberProvider(recipeId, providerId) {
    const map = { ...(shellState.settings.recipeProviders || {}), [recipeId]: providerId };
    shellState.settings = await window.scumble.settings.set({ recipeProviders: map });
}

function selectRecipe(id, providerId) {
    // a relight recipe is never the window's recipe (the Relight panel and the relight command pick it by the layer's
    // route): its id (a graph saved from the ComfyUI window, an import) keeps the recipe in use and stores nothing. That
    // recipe goes through the rest again, which puts the select back after loadRecipes() rebuilt its options.
    if (shellState.recipes.some((x) => x.id === id && x.task === "relight")) {
        const keep = [host.recipe && host.recipe.id, shellState.settings.recipe].find((k) => k && shellState.recipes.some((x) => x.id === k && x.task !== "relight"));
        if (keep) { id = keep; providerId = undefined; }
    }
    const raw = shellState.recipes.find((x) => x.id === id && x.task !== "relight") || shellState.recipes.find((x) => x.task !== "relight") || shellState.recipes[0];
    if (!raw) { ui.recipeNote.textContent = "no recipes found"; return; }
    if (providerId && raw.providers && raw.providers[providerId]) {
        shellState.settings.recipeProviders = { ...(shellState.settings.recipeProviders || {}), [raw.id]: providerId };
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
    const byMode = { ...(shellState.settings.recipeByMode || {}), [modeOf(raw)]: raw.id };
    if (shellState.settings.recipe !== r.id || (shellState.settings.recipeByMode || {})[modeOf(raw)] !== raw.id) window.scumble.settings.set({ recipe: r.id, recipeByMode: byMode }).then((s) => { shellState.settings = s; });
    if (ui.settings.open) syncRecipeRows();
}

/** Update the meta text and the provider selects of the recipe rows without rebuilding them. */
function syncRecipeRows() {
    for (const row of ui.recipes.querySelectorAll(".shell-recipe")) {
        const r = shellState.recipes.find((x) => x.id === row.dataset.id);
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
    syncGroupHeads();
}

/** Provider name for the recipe select; "(no key)" marks a provider with no API key stored yet. */
function providerOptionLabel(pid) {
    const p = shellState.providers.find((x) => x.id === pid);
    return providerLabel(pid) + (p && !(p.key && p.key.set) ? " (no key)" : "");
}

function recipeMeta(r) {
    if (r.kind !== "provider") return `ComfyUI · ${r.mode || "local"} · ${Object.keys(r.prompt || {}).length} nodes`;
    if (r.task === "relight") return "each relight layer picks its route in its Relight panel";
    const v = resolveRecipe(r);
    const ks = providerKeyState(v);
    return `${v.model || ""}${ks && !ks.ok ? (v.provider === "inapp" ? " · model not downloaded" : " · no key") : ""}`;
}

// ---- Settings' two long lists as collapsible groups (item 39, docs/PLAN_SETTINGS.md) ---------------------------------
// The open state lives in localStorage, never in the DOM: both lists are rebuilt after every save, import or removal.
const OPEN_KEY = "shell.settings.open";
function openState() {
    try { const v = JSON.parse(localStorage.getItem(OPEN_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch (_) { return {}; }
}
function rememberOpen(id, open) {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify({ ...openState(), [id]: !!open })); } catch (_) { /* a per-window convenience */ }
}
/** A `<details>` group of the Settings dialog: open as stored, else as `byDefault`; its body is returned. */
function settingsGroup(parent, id, byDefault) {
    const d = document.createElement("details");
    d.className = "shell-group";
    d.dataset.group = id;
    const stored = openState()[id];
    d.open = stored === undefined ? !!byDefault : !!stored;
    d.addEventListener("toggle", () => rememberOpen(id, d.open));
    const sum = document.createElement("summary");
    d.appendChild(sum);
    const body = document.createElement("div");
    body.className = "shell-group-body";
    d.appendChild(body);
    parent.appendChild(d);
    return body;
}

// the recipes by mode, in the words of the editor's local / api / cloud select
const RECIPE_GROUPS = [["local", "ComfyUI"], ["cloud", "Comfy Cloud"], ["api", "API models"]];

/** A group's line: its name, how many, how many are ready to run (keys, models) and the recipe in use when inside. */
function recipeGroupHead(mode, label) {
    const items = shellState.recipes.filter((r) => modeOf(r) === mode);
    const keyed = items.filter((r) => (r.kind === "provider" && r.task !== "relight") || cloudModeOf(r));
    const ready = keyed.filter((r) => { const ks = providerKeyState(resolveRecipe(r)); return !ks || ks.ok; }).length;
    const using = host.recipe && items.find((r) => r.id === host.recipe.id);
    return `${label} (${items.length})${keyed.length ? ` · ${ready} ready` : ""}${using ? ` · in use: ${using.name || using.id}` : ""}`;
}

function syncGroupHeads() {
    for (const d of ui.recipes.querySelectorAll("details.shell-group")) {
        const g = RECIPE_GROUPS.find(([m]) => "recipes." + m === d.dataset.group);
        if (g) d.querySelector("summary").textContent = recipeGroupHead(g[0], g[1]);
    }
}

function renderRecipeList() {
    ui.recipes.innerHTML = "";
    const activeMode = host.recipe ? modeOf(shellState.recipes.find((x) => x.id === host.recipe.id) || host.recipe) : null;
    const bodies = new Map();
    for (const [mode] of RECIPE_GROUPS) {
        if (!shellState.recipes.some((r) => modeOf(r) === mode)) continue;
        bodies.set(mode, settingsGroup(ui.recipes, "recipes." + mode, mode === activeMode));
    }
    let lastFamily = null, lastMode = null;
    for (const r of shellState.recipes) {
        const mode = modeOf(r);
        const body = bodies.get(mode);
        // the API models get the picker's family headings (Google, OpenAI, ...)
        if (mode === "api" && (familyOf(r) !== lastFamily || lastMode !== mode)) {
            const h = document.createElement("div");
            h.className = "shell-recipe-family";
            h.textContent = familyOf(r);
            body.appendChild(h);
        }
        lastFamily = familyOf(r); lastMode = mode;
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
        if (r.kind === "provider" && r.task !== "relight" && r.providerIds && r.providerIds.length) {
            // which provider runs this model; the key state shows in the option label (not Relight's: the Relight
            // panel's route picks its provider)
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
            // the Realism Pass and Relight run on the user's own ComfyUI only: no Cloud copy
            if (r.task === "pass" || r.task === "relight") cell.append(edit); else cell.append(edit, copy);
            row.appendChild(cell);
        } else {
            row.appendChild(document.createElement("span"));
        }
        if (r.task === "relight") {
            row.appendChild(document.createElement("span"));
        } else {
            const use = document.createElement("button");
            use.type = "button"; use.textContent = "Use";
            use.addEventListener("click", () => selectRecipe(r.id));
            row.appendChild(use);
        }
        // Remove only on the user's own recipes (imports, Cloud copies, saved graphs): a shipped one cannot be removed
        if (r.source === "user") {
            const del = document.createElement("button");
            del.type = "button"; del.textContent = "Remove"; del.title = "Delete this recipe of yours";
            del.addEventListener("click", async () => {
                if (!(await dialogs.confirm(`Remove the recipe "${r.name || r.id}"?`, { ok: "Remove", danger: true }))) return;
                try { await window.scumble.recipes.remove(r.id); await loadRecipes(); renderRecipeList(); selectRecipe(shellState.settings.recipe); } catch (err) { ui.recipeNoteSet.textContent = String(err.message || err); }
            });
            row.appendChild(del);
        } else {
            row.appendChild(document.createElement("span"));
        }
        body.appendChild(row);
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
        const msg = `Imported "${r.name}" (${what})` + (r.notes && r.notes.length ? ": " + r.notes.join("; ") : ".");
        ui.recipeNoteSet.textContent = msg;
        if (!ui.settings.open && host.editor) host.editor.setStatus(msg, "info");
        return r;
    } catch (err) {
        const msg = String(err.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
        ui.recipeNoteSet.textContent = msg;
        if (!ui.settings.open && host.editor) host.editor.setStatus(msg, failKind(err));
        return null;
    }
}

// ---- providers (keys) ----------------------------------------------------------------

async function loadProviders() {
    shellState.providers = await window.scumble.providers.list();
}

async function renderProviders() {
    const info = await window.scumble.keys.list();
    ui.providers.innerHTML = "";
    // one collapsible group, the rows and their order as they were (the user, 2026-10-07); open while no key is stored
    const shown = shellState.providers.filter((p) => !p.sharesKey);
    const keyed = shown.filter((p) => p.key && p.key.set).length;
    const list = settingsGroup(ui.providers, "providers", keyed === 0);
    list.parentNode.querySelector("summary").textContent = `Keys (${shown.length} providers) · ${keyed} stored`;
    for (const p of shellState.providers) {
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
        list.appendChild(row);
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
    shellState.settings = await window.scumble.settings.set({ llm: { ...(set.llm || {}), models: rows } });
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
        shellState.settings = await window.scumble.settings.set({ promptTemplates: { ...(shellState.settings.promptTemplates || {}), upsample: sel.value } });
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
        name.title = `${({ sam2: "objects (SAM2)", matting: "background removal", inpaint: "the Remove tool (inpainting)", depth: "depth maps (Select by depth, Limit by depth)" })[m.kind] || m.kind} · ${m.source} · ${m.license}`;
        row.appendChild(name);
        const info = document.createElement("span");
        info.className = "shell-model-info";
        const dl = st.downloads && st.downloads[m.id];
        const err = downloadErrors[m.id];
        // a model of several files (SAM2's encoder and decoder): the file it is at and the whole download's bytes
        // (models.js Downloader.running(): index, count, setReceived, setTotal); one file keeps its own bytes
        const many = !!dl && dl.count > 1 && dl.setTotal > 0;
        if (dl) {
            info.textContent = many
                ? `downloading ${dl.file} · file ${dl.index} of ${dl.count} · ${fmtBytes(dl.setReceived)} of ${fmtBytes(dl.setTotal)}`
                : `downloading ${dl.file} · ${fmtBytes(dl.received)} of ${fmtBytes(dl.total || m.size)}`;
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
            fill.style.width = Math.round(100 * (many ? dl.setReceived / dl.setTotal : dl.received / (dl.total || m.size || 1))) + "%";
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

// ---- settings dialog ---------------------------------------------------------------------

function fmtBytes(b) {
    return b >= 1024 * 1024 * 1024 ? (b / 1024 ** 3).toFixed(2) + " GB" : b >= 1024 * 1024 ? (b / 1024 ** 2).toFixed(1) + " MB" : Math.round(b / 1024) + " kB";
}

/**
 * The memory line of Settings > Performance, written when its reads land (P18): openSettings does not wait for it,
 * since the card's read (electron/main/gpumem.js) starts nvidia-smi or a PowerShell counter, which held the dialog back
 * on almost every open. Only the newest call writes the line.
 */
let gpuMemSeq = 0;
/** The line's two reads; a test replaces them to hold a read open (the contextBridge object cannot be wrapped). */
export const memoryReads = { process: () => gpuMemoryMB(), card: () => cardMemory() };
async function refreshGpuMemory() {
    const seq = ++gpuMemSeq;
    ui.setGpuMem.textContent = "Reading the GPU's memory ...";
    try {
        const [mb, card] = await Promise.all([memoryReads.process(), memoryReads.card()]);
        if (seq !== gpuMemSeq) return;
        const cardText = card ? (card.totalMB ? ` The card holds ${card.usedMB} of ${card.totalMB} MB (everything on it, read through ${card.source}).` : ` The card holds ${card.usedMB} MB in all (read through ${card.source}; its size is not reported).`) : " The card's own memory cannot be read here (no nvidia-smi, no counters).";
        ui.setGpuMem.textContent = `The GPU process is using ${mb} MB right now.${cardText} A background tab keeps its filtered copies, its display pyramids and the compositor's textures until they are released here.`;
    } catch (_) { if (seq === gpuMemSeq) ui.setGpuMem.textContent = ""; }
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

async function openSettings() {
    shellState.settings = await window.scumble.settings.get();
    ui.setUrl.value = (shellState.settings.comfy && shellState.settings.comfy.url) || ui.url.value;
    const auth = (shellState.settings.comfy && shellState.settings.comfy.auth) || { type: "none" };
    ui.authType.value = auth.type || "none";
    ui.authUser.value = auth.user || "";
    ui.authHeader.value = auth.header || "";
    ui.authSecret.value = "";
    syncAuthRows();
    ui.setConn.textContent = shellState.lastStatus.message || shellState.lastStatus.state || "";
    ui.setProbe.hidden = true;
    ui.setPruneNote.textContent = "";
    ui.recipeNoteSet.textContent = "";
    ui.setGpu.textContent = glFiltersAvailable() ? "Filter layers run on the GPU (WebGL2); the CPU code is the fallback." : "WebGL2 is not available here: filter layers run on the CPU.";
    // the same whole numbers the change handlers below write, so a stored value (typed by hand, or one the
    // browser suggested while a field still had coarser steps) always passes the form's own validation:
    // an invalid number input keeps the dialog's Close from submitting
    const mem = shellState.settings.memory || {};
    ui.setGpuLimit.value = wholeMB(mem.gpuLimitMB, 0, 3072);
    ui.setCardMin.value = wholeMB(mem.cardMinFreeMB, 0, 2048);
    ui.setAtlas.value = wholeMB(mem.atlasMB, 16, 512);
    const depth = historyDepth();
    ui.setUndoSteps.value = depth.steps;
    ui.setUndoMB.value = depth.mb;
    const as = shellState.settings.assistant || {};
    ui.setAsKeep.value = Math.max(1, Math.round(Number(as.keepChats) || 20));
    ui.setAsSteps.value = Math.max(1, Math.round(Number(as.maxSteps) || 25));
    ui.setAsNote.textContent = "";
    await renderTileMode();
    refreshGpuMemory();   // not awaited (P18): the card's read starts nvidia-smi or a PowerShell counter
    try {
        const info = await window.scumble.info();
        ui.setAbout.textContent = `Scumble ${info.version} · Electron ${info.electron} · ${info.platform} · data in ${info.userData}${info.portable ? " (portable copy)" : ""}.${info.comfySdk ? ` Comfy Cloud and Comfy Router run through Comfy's official TypeScript SDK (@comfyorg/sdk ${info.comfySdk}, MIT).` : ""} Green and blue screen keying by CorridorKey 2.0 from Corridor Digital (Corridor Key Licence, a CC BY-NC-SA 4.0 variant), used with permission in this free app; it builds on C-RADIOv4 (NVIDIA), MoGe-2 (Microsoft) and RVM (Google DeepMind), which its node pack downloads from their publishers onto your ComfyUI. Film names are trademarks of their owners; the looks are Scumble's own approximations, not licensed products. NVIDIA, RTX and DLSS are trademarks of NVIDIA Corporation; Scumble is not affiliated with or endorsed by NVIDIA, and the Realism Pass (Windows only, RTX only) runs only what you installed on your own ComfyUI.`;
    } catch (_) { /* ignore */ }
    ui.updateAuto.checked = !(shellState.settings.updates && shellState.settings.updates.check === false);
    ui.netCurl.checked = !(shellState.settings.network && shellState.settings.network.curl === false);
    renderNetwork();
    ui.promptRefPics.checked = refPicturesOn(shellState.settings);
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

export { addCloudMode, chosenProvider, cloudModeOf, downloadErrors, fmtBytes, importRecipe, lmProviders, lmRows, lmSave, lmSuggest, loadProviders, loadRecipes, modeOf, openGeneration, openSettings, providerKeyState, providerLabel, providerOptionLabel, refreshFileStats, renderCompat, renderHelpers, renderPlugins, renderPrompts, renderRecipeList, renderTileMode, resolveRecipe, saveCompat, selectRecipe };
