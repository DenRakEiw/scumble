// The Image menu's *Split into Layers...*: the editor's own question with a prompt field and a Text recognition switch
// put in, and the model, the layer count and the size as its rows. It is also the confirmation before the paid run: its
// line says which model runs, on which host (the recipe's chosen provider where it has a layer mode, else BytePlus
// ModelArk), and how many layers it asks for. The run itself is the command `split_layers`
// (renderer/editor/splitlayers.js).

import { commands } from "./commands.js";
import { host } from "./editor/host.js";
import { failKind } from "./editor/inpaint_status.js";
import { SPLIT_LABEL, SPLIT_TIERS, SPLIT_COUNT_DEFAULT, layerRecipes, layerSpecOf, splitJob, chosenIn } from "./editor/splitlayers.js";

/** The count a model starts with: the default where it takes one, else its ceiling (shown, not sent). */
const startCount = (spec) => (spec.count ? Math.min(SPLIT_COUNT_DEFAULT, spec.max) : spec.max);

/** The dialog's line for a model on its host and a count. `r` the recipe resolved to that host. */
function noteFor(r, count, spec) {
    const name = r.name || r.id;
    const label = r.providerLabel || r.provider;
    const where = /^BytePlus ModelArk/.test(label) ? "BytePlus ModelArk" : label;
    const asked = spec.count ? `asks for up to ${count} layer${count === 1 ? "" : "s"} and a base` : `finds its own layers, up to ${spec.max}, and a base`;
    const price = spec.price || `${where} charges your account.`;
    return `${name} on ${where} ${asked}. ${price} The layers land above everything in one new group, as one undo step.`;
}

/** Open it on `editor`. A refusal goes to the status line, as a menu entry's does. */
export async function openSplitDialog(editor) {
    if (!editor) return;
    const chosen = chosenIn(host);
    const recipes = layerRecipes(host.shell.recipes(), chosen);
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
    // an emptied box or a 0 is the model's starting count, never its dearest
    const count = (values, spec) => { const n = Math.round(+values.count); return n >= 1 ? Math.min(spec.max, n) : startCount(spec); };
    const rawOf = (id) => recipes.find((x) => x.id === id);
    const specOf = (id) => layerSpecOf(rawOf(id), chosen(rawOf(id)));
    // the recipe on the host its split runs on, as the line names it
    const rOf = (id) => host.shell.resolveRecipe(rawOf(id), specOf(id).provider);
    const n0 = startCount(first.spec);
    const asked = editor.ask({
        title: SPLIT_LABEL,
        fields: [
            { key: "model", label: "Model", type: "select", wide: true, value: first.r.id, options: recipes.map((x) => ({ value: x.id, label: x.name || x.id })) },
            { key: "source", label: "Picture", type: "select", wide: true, value: sources[0].value, options: sources },
            { key: "count", label: "Layers, at most", value: n0, min: 1, max: first.spec.max, disabled: !first.spec.count },
            { key: "size", label: "Size", type: "select", value: "auto", disabled: !first.spec.tiers, options: SPLIT_TIERS.map((t) => ({ value: t, label: t === "auto" ? "Auto" : t })) },
            { key: "note", type: "note", text: noteFor(first.r, n0, first.spec) },
        ],
        ok: "Split",
        onChange: (key, values, set) => {
            const spec = specOf(values.model);
            if (key === "model") {
                set("count", { value: startCount(spec), disabled: !spec.count });
                // a host that takes no size answers at its own: the row goes back to Auto and stays there
                set("size", spec.tiers ? { disabled: false } : { value: "auto", disabled: true });
            }
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
    const syncText = () => { switchRow.hidden = !specOf(box.querySelector('select[data-key="model"]').value).text; };
    syncText();
    prompt.focus();
    const answer = await asked;
    if (!answer) { editor.setStatus(`${SPLIT_LABEL}: nothing was sent.`); return; }
    const spec = specOf(answer.model);
    const args = { doc: editor.node.id, recipe: answer.model, size: answer.size, prompt: prompt.value.trim(), timeout: 1800 };
    if (answer.source === "layer") args.source = active.id;
    if (spec.count) args.count = count(answer, spec);
    if (spec.text) args.text_recognition = text.checked;
    if (!spec.tiers) args.size = "auto";
    // the run's own line says how it went (renderer/editor/splitlayers.js); the dialog is gone
    await commands.run("split_layers", args).catch((err) => console.warn("Split into layers", err));
}
