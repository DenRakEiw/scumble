// The Image menu's *Split into Layers...*: the editor's own question with a prompt field and a Text recognition switch
// put in, and the model, the layer count and the size as its rows. It is also the confirmation before the paid run: its
// line says which model runs and how many layers it asks for. The run itself is the command `split_layers`
// (renderer/editor/splitlayers.js).

import { commands } from "./commands.js";
import { host } from "./editor/host.js";
import { failKind } from "./editor/inpaint_status.js";
import { SPLIT_LABEL, SPLIT_TIERS, SPLIT_COUNT_DEFAULT, layerRecipes, layerSpecOf, splitJob } from "./editor/splitlayers.js";

/** The count a model starts with: the default where it takes one, else its ceiling (shown, not sent). */
const startCount = (spec) => (spec.options ? Math.min(SPLIT_COUNT_DEFAULT, spec.max) : spec.max);

/** The dialog's line for a model and a count. */
function noteFor(r, count, spec) {
    const name = r.name || r.id;
    const asked = spec.options ? `asks for up to ${count} layer${count === 1 ? "" : "s"} and a base` : `finds its own layers, up to ${spec.max}, and a base`;
    const price = r.id === "seedream_5_5" ? "Its price is not on BytePlus's public list yet." : "BytePlus charges your account.";
    return `${name} on BytePlus ModelArk ${asked}. ${price} The layers land above everything in one new group, as one undo step.`;
}

/** Open it on `editor`. A refusal goes to the status line, as a menu entry's does. */
export async function openSplitDialog(editor) {
    if (!editor) return;
    const recipes = layerRecipes(host.shell.recipes());
    const active = editor.activeLayer && editor.activeLayer();
    const canLayer = active && active.kind !== "filter" && active.px;
    const selected = host.recipe && recipes.find((x) => x.id === host.recipe.id);
    const recipe = selected ? selected.id : recipes[0] && recipes[0].id;
    // what can go now: the picture past the model's size may still have a layer that fits
    const check = (layer) => { try { return { job: splitJob(host, editor, { recipe, layer }) }; } catch (err) { return { err }; } };
    const picture = check(null);
    const own = canLayer ? check(active) : null;
    const first = picture.job || (own && own.job);
    if (!first) { editor.setStatus(String(picture.err.message || picture.err), failKind(picture.err)); return; }
    const sources = [...(picture.job ? [{ value: "picture", label: `The visible picture (${editor.width} × ${editor.height})` }] : []), ...(own && own.job ? [{ value: "layer", label: `Layer: ${active.name}` }] : [])];
    const count = (values, spec) => Math.min(spec.max, Math.max(1, Math.round(+values.count) || spec.max));
    const specOf = (id) => layerSpecOf(recipes.find((x) => x.id === id));
    const rOf = (id) => recipes.find((x) => x.id === id);
    const n0 = startCount(first.spec);
    const asked = editor.ask({
        title: SPLIT_LABEL,
        fields: [
            { key: "model", label: "Model", type: "select", wide: true, value: first.r.id, options: recipes.map((x) => ({ value: x.id, label: x.name || x.id })) },
            { key: "source", label: "Picture", type: "select", wide: true, value: sources[0].value, options: sources },
            { key: "count", label: "Layers, at most", value: n0, min: 1, max: first.spec.max, disabled: !first.spec.options },
            { key: "size", label: "Size", type: "select", value: "auto", options: SPLIT_TIERS.map((t) => ({ value: t, label: t === "auto" ? "Auto" : t })) },
            { key: "note", type: "note", text: noteFor(first.r, n0, first.spec) },
        ],
        ok: "Split",
        onChange: (key, values, set) => {
            const spec = specOf(values.model);
            if (key === "model") set("count", { value: startCount(spec), disabled: !spec.options });
            set("note", { text: noteFor(rOf(values.model), key === "model" ? startCount(spec) : count(values, spec), spec) });
            syncText();
        },
    });
    // the question is up (ask mounts it at once): the prompt and the switch, which its form has no field kind for
    const box = editor.askOpen.querySelector(".ipc-askbox");
    const grid = box.querySelector(".ipc-askfields");
    const prompt = document.createElement("input");
    prompt.type = "text";
    prompt.className = "ipc-askinput";
    prompt.placeholder = "What to separate (optional: without it the model finds the major elements)";
    box.insertBefore(prompt, grid);
    const switchRow = document.createElement("label");
    switchRow.className = "ipc-askfield";
    switchRow.style.flexDirection = "row";
    switchRow.style.alignItems = "center";
    const text = document.createElement("input");
    text.type = "checkbox";
    switchRow.appendChild(text);
    switchRow.appendChild(document.createTextNode("Text recognition"));
    grid.appendChild(switchRow);
    const syncText = () => { switchRow.hidden = !specOf(box.querySelector('select[data-key="model"]').value).options; };
    syncText();
    prompt.focus();
    const answer = await asked;
    if (!answer) { editor.setStatus(`${SPLIT_LABEL}: nothing was sent.`); return; }
    const spec = specOf(answer.model);
    const args = { doc: editor.node.id, recipe: answer.model, size: answer.size, prompt: prompt.value.trim(), timeout: 1800 };
    if (answer.source === "layer") args.source = active.id;
    if (spec.options) { args.count = count(answer, spec); args.text_recognition = text.checked; }
    // the run's own line says how it went (renderer/editor/splitlayers.js); the dialog is gone
    await commands.run("split_layers", args).catch((err) => console.warn("Split into layers", err));
}
