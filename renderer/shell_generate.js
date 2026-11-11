// Generate new, New with a model and the Upscale dialog: moved out of shell.js (item 56 S14b, docs/PLAN_SPLIT.md), text unchanged.

import * as comfyprompt from "./editor/comfyprompt.js";
import * as genpresets from "./editor/genpresets.js";
import * as realism from "./editor/realism.js";
import { host } from "./editor/host.js";
import { PromptField, RefBar } from "./editor/prompt_field.js";
import { referencesRule, referencesText } from "./editor/reftokens.js";
import { shellState } from "./shell_state.js";
import { chosenProvider, cloudModeOf, modeOf, providerLabel, providerOptionLabel, resolveRecipe, selectRecipe } from "./shell_settings.js";
import { GEN_GENERAL, ui } from "./shell.js";

// ---- Generate new: a base image from the prompt alone --------------------------------

const GEN_ASPECTS = ["free", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"];
const GEN_RESOLUTIONS = [768, 1024, 1280, 1536, 2048, 3072, 4096];

/**
 * What Generate new offers for a recipe on one of its providers (item 34, docs/PLAN_NEW_PRESETS.md section 8): the
 * variant's own aspects (genpresets.aspectsOf, else the general list) and its size classes (`text.sizes`, named by its
 * tiers as the provider counts them at `aspect`, 1:1 without one: "2k (2048 px)"); a recipe on ComfyUI takes any shape
 * and size, so it gets the general lists. Null when the variant makes no new image. The dialog, New's presets
 * (newCanvasChoices) and list_recipes all read this.
 */
function genPresetOf(r, pid, aspect = null) {
    if (!r) return null;
    if (r.kind !== "provider") return { aspects: GEN_GENERAL.slice(), classes: genpresets.classesOf(null, GEN_RESOLUTIONS) };
    const v = r.providers && pid ? r.providers[pid] : null;
    if (!v || !v.text) return null;
    return { aspects: genpresets.aspectsOf(v, GEN_GENERAL), classes: genpresets.classesOf(v, GEN_RESOLUTIONS, { provider: pid, aspect }) };
}

/**
 * The dialog's model on its provider: the raw recipe, what it offers (the classes named at the chosen aspect), and the
 * resolved recipe a run would use.
 */
function genChoice() {
    const r = shellState.recipes.find((x) => x.id === ui.genRecipe.value) || null;
    const pid = r && r.kind === "provider" ? ui.genProvider.value : "";
    const aspect = genpresets.parseAspect(ui.genAspect.value) ? ui.genAspect.value : null;
    const preset = genPresetOf(r, pid, aspect) || { aspects: GEN_GENERAL.slice(), classes: genpresets.classesOf(null, GEN_RESOLUTIONS) };
    return { r, pid, preset, resolved: r && r.kind === "provider" && pid ? resolveRecipe(r, pid) : r };
}

/**
 * A document's preset (`genSettings.target`, item 34) while it holds: the picture still has its size and the recipe is
 * one the dialog lists (in the mode it would run in). Null otherwise; a stale one is left where it is.
 */
function genTargetOf(ed) {
    const t = ed && ed.genSettings ? ed.genSettings.target : null;
    if (!genpresets.targetValid(t, ed)) return null;
    const raw = shellState.recipes.find((x) => x.id === t.recipe);
    if (!raw) return null;
    const mode = raw.kind === "comfy" ? "local" : modeOf(raw);
    if (!genRecipesFor(mode).some((x) => x.id === raw.id)) return null;
    return { mode, recipe: raw.id, provider: t.provider || null, aspect: t.aspect || "free", size: +t.size || null };
}

/** The boxes a Generate new with the dialog's model would send (host.newBoxes: the run's own rule). */
function genBoxes() {
    if (!genEditor) return { schema: null, on: false, count: 0, goes: false };
    return host.newBoxes(genEditor, genChoice().resolved);
}

/**
 * The line under the aspect (item 34): while the boxes go, an asked shape other than the document's stretches them
 * (they are fractions of the picture they were drawn on), and it says so; empty otherwise. Run with genSyncSize.
 */
function genSyncBoxNote() {
    if (!ui.genBoxNote) return;
    let note = "";
    if (genEditor && genBoxes().goes) {
        note = genpresets.stretchNote([genEditor.width || 0, genEditor.height || 0], genSize(), genChoice().preset.aspects, genAspectFree() ? null : ui.genAspect.value);
    }
    ui.genBoxNote.textContent = note;
    ui.genBoxNote.hidden = !note;
}

// ---- New with a model (item 34): the editor's New dialog asks through host.newCanvasChoices ------------------------

/** The last New preset of this session ({ model, provider, aspect, size }): what New opens on without a document's own. */
let newPresetLast = null;
const NEW_GROUPS = [["api", "API models"], ["cloud", "Comfy Cloud"], ["local", "ComfyUI"]];

/**
 * The New dialog's choices (host.newCanvasChoices): "Any size" first, then every model that makes a new image, grouped
 * API models / Comfy Cloud / ComfyUI, each with its providers (the remembered one first; a recipe on ComfyUI or a Comfy
 * Cloud graph has one entry, value ""), their aspects and size classes (each class's `labels`: its name at an aspect
 * where a tier counted by area names it otherwise than at 1:1); `pick` the preset to open on (the document's while it
 * holds; in a tab without a picture this session's last), `working` the canvas a preset makes.
 */
function newCanvasChoices(editor) {
    const entry = (value, label, r, pid) => {
        const p = genPresetOf(r, pid);
        if (!p) return null;
        const classes = p.classes.map((c) => ({ value: c.px, label: c.label }));
        for (const a of p.aspects) {
            const at = genPresetOf(r, pid, a).classes;
            classes.forEach((c, i) => {
                if (at[i] && at[i].px === c.value && at[i].label !== c.label) c.labels = { ...(c.labels || {}), [a]: at[i].label };
            });
        }
        return { value, label, aspects: p.aspects.slice(), classes };
    };
    const models = [{ value: "", label: "Any size", group: "", providers: [] }];
    for (const [mode, group] of NEW_GROUPS) {
        for (const r of genRecipesFor(mode)) {
            let providers;
            if (mode === "api") {
                const ids = genProviderIds(r), first = chosenProvider(r);
                const order = ids.includes(first) ? [first, ...ids.filter((x) => x !== first)] : ids;
                providers = order.map((pid) => entry(pid, providerOptionLabel(pid), r, pid));
            } else {
                providers = [entry("", mode === "cloud" ? "Comfy Cloud" : "ComfyUI", r, r.kind === "provider" ? chosenProvider(r) : "")];
            }
            providers = providers.filter(Boolean);
            if (providers.length) models.push({ value: r.id, label: r.name || r.id, group, providers });
        }
    }
    return { models, pick: newCanvasPick(editor, models), working: (aspect, size) => genpresets.workingSize(aspect, size) };
}

/**
 * The preset New opens on: the document's (while its picture keeps the preset's size); in a tab without a picture this
 * session's last New; else none ("Any size": a tab with a picture of its own keeps its size by default).
 */
function newCanvasPick(editor, models) {
    const t = editor && editor.genSettings ? editor.genSettings.target : null;
    const own = genpresets.targetValid(t, editor);
    const tries = [own ? { model: t.recipe, provider: t.provider || "", aspect: t.aspect || null, size: +t.size || null, doc: [editor.width, editor.height] } : null, editor && editor.base ? null : newPresetLast];
    for (const src of tries) {
        if (!src) continue;
        const m = models.find((x) => x.value && x.value === src.model);
        if (!m) continue;
        const p = m.providers.find((x) => x.value === (src.provider || "")) || m.providers[0];
        const shape = genpresets.parseAspect(src.aspect) || src.doc || null;
        const aspect = p.aspects.includes(src.aspect) ? src.aspect : (shape && genpresets.nearestAspect(shape[0], shape[1], p.aspects)) || p.aspects[0] || null;
        return { model: m.value, provider: p.value, aspect, size: genpresets.nearestSize(p.classes.map((c) => c.value), src.size) };
    }
    return null;
}

/**
 * New made a canvas for a preset (target = { recipe, provider, aspect, size, width, height }, already stored in the
 * document by the editor): remember it for the next New of this session and select its recipe on its provider, for
 * every tab as Generate new's button does (the recipe is the app's). A null target (a New of a size given by hand)
 * forgets the last preset, so the next New opens on "Any size".
 */
async function newCanvasChosen(editor, target) {
    if (!target) { newPresetLast = null; return; }
    const raw = target.recipe ? shellState.recipes.find((x) => x.id === target.recipe) : null;
    if (!raw) return;
    newPresetLast = { model: raw.id, provider: target.provider || "", aspect: target.aspect || null, size: +target.size || null };
    selectRecipe(raw.id, target.provider || undefined);
}

let genEditor = null;
// the prompt field with reference chips (docs/PLAN_REFS.md 26f): the tab's references, named as the dialog's model gets them
let genField = null;
let genInfo = null;          // host.refLayout's answer for the dialog's model (not the tab's recipe)
let genInfoSeq = 0;
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
    const r = shellState.recipes.find((x) => x.id === ui.genRecipe.value);
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
    return shellState.recipes.filter((r) => (mode === "local" ? r.kind === "comfy" && r.task !== "upscale" && r.task !== "pass" && r.task !== "relight" : r.kind === "provider" && (mode === "cloud") === cloudModeOf(r) && r.task !== "relight" && genProviderIds(r).length));
}

/** The providers of a model recipe that have a text-to-image shape. */
function genProviderIds(r) {
    return (r.providerIds || []).filter((pid) => r.providers && r.providers[pid] && r.providers[pid].text);
}

/**
 * `opening`: the dialog is being opened ({ recipe, provider, aspect, size } of the document's preset, or {} without one),
 * so the aspect is chosen afresh (genFillAspects); null on a change of the mode, model or provider.
 */
function genFillRecipes(opening = null) {
    const mode = ui.genMode.value;
    const list = genRecipesFor(mode);
    const keep = opening && opening.recipe && list.some((r) => r.id === opening.recipe) ? opening.recipe : ui.genRecipe.value;
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
    else if (list.some((r) => r.id === shellState.settings.recipe)) ui.genRecipe.value = shellState.settings.recipe;
    genFillProviders(opening);
}

/** The long sides the chosen model offers; a local recipe takes any size. */
function genSizes() {
    return genChoice().preset.classes.map((c) => c.px);
}

/** The size classes of the chosen model, labelled by its tiers ("4k (4096 px)") where it names them; `want` first. */
function genFillSizes(want = null) {
    const classes = genChoice().preset.classes;
    const keep = +want || +ui.genResolution.value || 1024;
    ui.genResolution.innerHTML = "";
    for (const c of classes) {
        const o = document.createElement("option");
        o.value = String(c.px);
        o.textContent = c.label;
        ui.genResolution.appendChild(o);
    }
    // keep what was chosen when the model offers it, otherwise the nearest it does offer
    ui.genResolution.value = String(genpresets.nearestSize(classes.map((c) => c.px), keep));
    genSyncSize();
}

/**
 * The aspects of the chosen model on its provider ("free" first, then its own list, else the general one). Opening:
 * the document's preset (`want`), else while the boxes go the aspect nearest the document, else the last choice, else
 * 1:1 or the first offered; on a change of the model: the choice when offered, else the same rule.
 */
function genFillAspects(want = null, opening = false) {
    const list = ["free", ...genChoice().preset.aspects];
    const keep = ui.genAspect.value || null;
    ui.genAspect.innerHTML = "";
    for (const a of list) {
        const o = document.createElement("option");
        o.value = a;
        o.textContent = a === "free" ? "free (width \u00d7 height)" : a;
        ui.genAspect.appendChild(o);
    }
    const doc = genEditor ? [genEditor.width || 0, genEditor.height || 0] : null;
    // a preset's aspect this variant lacks (an agent's 16:10) opens on the nearest it offers
    ui.genAspect.value = genpresets.chooseAspect(list, { want: opening ? want : keep, keep: opening && want ? want : keep, doc, boxes: genBoxes().goes }) || "free";
}

function genFillProviders(opening = null) {
    const r = shellState.recipes.find((x) => x.id === ui.genRecipe.value);
    const ids = r && r.kind === "provider" ? genProviderIds(r) : [];
    ui.genProviderRow.hidden = !ids.length;
    const keep = opening && opening.provider && r && opening.recipe === r.id && ids.includes(opening.provider) ? opening.provider : ui.genProvider.value;
    ui.genProvider.innerHTML = "";
    for (const pid of ids) {
        const o = document.createElement("option");
        o.value = pid;
        o.textContent = providerOptionLabel(pid);
        ui.genProvider.appendChild(o);
    }
    if (ids.includes(keep)) ui.genProvider.value = keep;
    else if (ids.includes((shellState.settings.recipeProviders || {})[r && r.id])) ui.genProvider.value = shellState.settings.recipeProviders[r.id];
    else if (r && ids.includes(r.default)) ui.genProvider.value = r.default;
    // the preset's aspect and class count only on the model it was made for
    const own = !!(opening && r && opening.recipe === r.id);
    genFillAspects(own ? opening.aspect : null, !!opening);
    genFillSizes(own ? opening.size : null);
    genTransparencyRow();
    genSyncNote();
    genSyncRefs();
}

/** Does the chosen provider variant take a `background` parameter (docs/RECIPES.md)? */
function genTransparencyRow() {
    const r = shellState.recipes.find((x) => x.id === ui.genRecipe.value);
    const v = (r && r.providers && r.providers[ui.genProvider.value]) || {};
    const rows = (v.text && v.text.settings) || v.settings || [];
    const ok = !!r && r.kind === "provider" && rows.some((s) => s.key === "background");
    ui.genAlphaRow.hidden = !ok;
    if (!ok) ui.genAlpha.checked = false;
}

function genSyncNote() {
    const r = shellState.recipes.find((x) => x.id === ui.genRecipe.value);
    if (!r) { ui.genNote.textContent = ""; return; }
    if (r.kind === "comfy") {
        ui.genNote.textContent = "Runs on your ComfyUI: a flat canvas of the size below goes through the recipe and the answer becomes the image. Any size, the model settings are the ones in the Settings panel.";
        return;
    }
    const v = (r.providers || {})[ui.genProvider.value] || {};
    const t = v.text || {};
    const key = (shellState.providers.find((p) => p.id === ui.genProvider.value) || {}).key;
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
    genSyncBoxNote();
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
    const keep = ui.genTemplate.value || (shellState.settings.promptTemplates || {}).generate || "";
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
    // the document's preset (item 34: New with a model, or the last Generate new on it) while its picture keeps that
    // size: the dialog opens on its mode, model, provider, aspect and size class
    const target = genTargetOf(genEditor);
    // else on the editor's mode (local, api or cloud) when that has a recipe for a new image
    const curRaw = host.recipe && shellState.recipes.find((x) => x.id === host.recipe.id);
    const curMode = curRaw ? (curRaw.kind === "comfy" ? "local" : modeOf(curRaw)) : "api";
    ui.genMode.value = target ? target.mode : genRecipesFor(curMode).length ? curMode : (genRecipesFor("local").length ? "local" : "api");
    genMountField();
    genInfo = null;
    // the aspect select is filled per model (genFillAspects): the first opening starts on 1:1 (or the first offered)
    genFillRecipes(target || {});
    genFillUpsample();
    genFillTemplates();
    // the tab's prompt with its @img tokens as chips (26f): they name the reference layers, which go along where the
    // model takes them; the field follows the references like the tab's own prompt while the dialog is open
    genField.setText(genEditor.promptText || "", { history: "reset" });
    shellState.genPrevious = null;
    if (shellState.genRemapOff) shellState.genRemapOff();
    const field = genField;
    shellState.genRemapOff = genEditor.addRemapTarget({ get value() { return field.el.value; }, setText: (t, o) => { field.setText(t, o); genSyncRefs(); } });
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
    return shellState.recipes.filter((r) => r.task === "upscale" || r.task === "pass");
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
    const r = shellState.recipes.find((x) => x.id === ui.upRecipe.value);
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
    const cur = host.recipe && (host.recipe.task === "upscale" || isPassRecipe(host.recipe)) ? host.recipe.id : shellState.settings.upscaleRecipe;
    if (list.some((r) => r.id === cur)) ui.upRecipe.value = cur;
    else if (list.some((r) => r.id === keep)) ui.upRecipe.value = keep;
    upFillProviders();
}

function upFillProviders() {
    const r = shellState.recipes.find((x) => x.id === ui.upRecipe.value);
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
    const key = (shellState.providers.find((p) => p.id === pid) || {}).key;
    const missing = pid === "loopback" || (key && key.set) ? "" : ` No ${providerLabel(pid)} key stored yet: Settings › API providers.`;
    ui.upNote.textContent = (r.description || "") + missing;
    const doc = ui.upScopeDoc.checked;
    const f = v.factor && !v.factor.fixed ? +ui.upFactor.value || v.factor.default : null;
    const max = (v.limits && v.limits.max) || 2048;
    // an answer cap (limits.out: RTX Video Super Resolution on Comfy Cloud), refused here as host.runUpscale refuses it
    // (and the canvas ceiling of a whole-picture landing, which names the largest factor of the variant that fits)
    const capped = { limits: v.limits, factor: v.factor, name: r.name, id: r.id };
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
            const fr = v.limits && (v.limits.out || v.limits.outPixels) && f != null ? host.upscaleFrame(ed, v.limits) : null;
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

export { GEN_ASPECTS, genAspectFree, genEditor, genField, genFillAspects, genFillProviders, genFillRecipes, genFillSizes, genInstruction, genOpenSeq, genPresetOf, genSize, genSyncNote, genSyncRefs, genSyncSize, genSyncTemplateNote, genTransparencyRow, isPassRecipe, newCanvasChoices, newCanvasChosen, upEditor, upFillFactors, upFillProviders, upNoteFactor, upResyncPass, upSyncNote };
