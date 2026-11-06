// The LoRAs section of the Generate tab (item 50, docs/PLAN_LORAS.md §3.2): up to five rows per recipe, each a LoRA
// from the server's list, a strength and an on / off tick, kept in settings.recipeLoras for every document
// (host.loras, host.saveLoras); a run splices the switched-on rows into the queued copy of the graph (host.js
// queueGenerate, renderer/editor/loras.js spliceLoras).
//
// App-only DOM: host.applyRecipe calls ensure() for every editor on every recipe change; it is not in
// tools/build_node.py FILES (the node's own editor takes a Load LoRA node in its graph). The section goes through
// ed.addSection (inpaint_modal.js, the plugin panels' hook) and is then moved to right after the Settings section, so
// the shipped editor files stay as they are. It never imports host.js (host.js imports it): host is passed in.
//
// The picker is a non-modal <dialog> in the editor's root: the editor's and the shell's key handlers leave a key inside
// an open dialog alone (inpaint_canvas.js _docKey, shell.js), so Escape, Enter and the arrows reach its search field.
// A row under a resting pointer is never picked by hover (Chromium sends a move of no distance after the layout, the
// CLAUDE.md popup trap): the cursor follows the mouse only on a real move.
//
// Each row's info line (LR3, `.ipc-lora-info`): the base-model hint host.loraInfo reads (grey "looks like FLUX 3",
// "metadata says SDXL", "in folder klein"; amber when the file's tensor names fit another family than the recipe's,
// loras.js loraHint; never a refusal) and the trigger words as chips that append to the prompt. The picker shows the
// recipe's family first (folders named for it, files whose hint fits it) and the rest behind *Show all*.
//
// A Comfy Cloud recipe (LR5, host.loraSource "cloud"): the rows name files of Comfy Cloud's lists (host.readCloudLoras:
// the account's own imports, shown first as "Your imports", then Comfy Cloud's catalog), and a name typed in the search
// goes as written (an import made since, a name the lists lack): nothing is refused on a name there, main splices the
// rows and Comfy's own check answers a wrong one. No hint line (the file is Comfy Cloud's, not one Scumble can read).

import { MAX_LORAS, normalizeName, loraStem, loraFolder, groupByFolder, filterNames, strengthRange, clampStrength,
    recipeFamily, familyLabel, familyGroups, loraHint, appendWord } from "./loras.js";

/** The spinner's range and step (a typed value may go to the node's own range, clampStrength). */
const SPIN = { min: -2, max: 2, step: 0.05 };
/** The picker's one open instance (one at a time in the window). */
let picker = null;

function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

/** A strength as the field shows it: "1.0", "0.85", "-2.0". */
function strengthText(v) {
    const s = String(Math.round((+v || 0) * 1000) / 1000);
    return /[.e]/.test(s) ? s : s + ".0";
}

/** Whether the server answers now: the shell's last status (host.connected is never set back after a connect). */
function serverUp(host) {
    const st = host.server && host.server.state;
    return !!host.connected && (st === "connected" || st === "missing-node");
}

/** Whether `name` is in the server's list, "/" and "\\" alike (a separator-only difference is sent in its spelling). */
function listed(names, name) {
    const n = normalizeName(name);
    return names.some((x) => normalizeName(x) === n);
}

/**
 * The section of `ed`, made on the first call (ed.addSection, then moved to right after Settings), then rendered for the
 * selected recipe. Called by host.applyRecipe.
 */
export function ensure(host, ed) {
    if (!ed || typeof ed.addSection !== "function") return null;
    if (!ed._loraPanel) {
        const p = { section: null, summary: null, count: null, box: null, list: null, add: null, note: null, key: "", recipeId: null };
        const details = ed.addSection("LoRAs", false, (d, sum) => {
            p.summary = sum;
            sum.appendChild(mk("span", "ipc-grow"));
            p.count = mk("span", "ipc-lora-count");
            sum.appendChild(p.count);
            p.box = mk("div", "ipc-sec ipc-loras");
            p.list = mk("div", "ipc-lora-rows");
            const foot = mk("div", "ipc-lora-foot");
            p.add = mk("button", "ipc-ib ipc-small ipc-lora-add", "+");
            p.add.type = "button";
            p.add.setAttribute("aria-label", "Add a LoRA");
            p.add.addEventListener("click", () => addRow(host, ed));
            p.note = mk("span", "ipc-lora-note");
            foot.append(p.add, p.note);
            p.box.append(p.list, foot);
            d.appendChild(p.box);
        }, "gen");
        details.classList.add("ipc-lora-section");
        // after the Settings rows, before History (addSection appends to the pane's end, after Crop and the plugin panels)
        const after = ed.settingsList && ed.settingsList.closest && ed.settingsList.closest("details");
        if (after && after.parentNode) after.parentNode.insertBefore(details, after.nextSibling);
        p.section = details;
        ed._loraPanel = p;
    }
    render(host, ed);
    return ed._loraPanel;
}

/** Every editor's section again (the rows are the recipe's, shared by all documents). */
export function renderAll(host) {
    for (const ed of host.editors ? host.editors() : []) { try { render(host, ed); } catch (err) { console.warn("loras section", err); } }
}

/**
 * The section for the selected recipe: hidden with the reason in its summary's title when the recipe takes no rows
 * (host.loraTakes), else its rows. Nothing is rebuilt while what it shows is the same (a re-render on a status change
 * must not take the focus out of a strength being typed).
 */
export function render(host, ed) {
    const p = ed && ed._loraPanel;
    if (!p || !p.section) return;
    const r = host.recipe;
    const t = host.loraTakes(r);
    const cloud = t.takes && host.loraSource(r) === "cloud";
    // Comfy Cloud's lists are read once the section shows for a Comfy Cloud recipe (the section is drawn again then)
    if (cloud && !host._cloudLoras && !host._cloudLorasRead) host.readCloudLoras();
    const rows = t.takes ? host.loraRows(r) : [];
    const names = t.takes ? host.loraNamesFor(r) : [];
    // each named row's hint (the first look starts the read; the section is drawn again when it is in); none on Comfy
    // Cloud, whose files Scumble cannot read
    const infos = rows.map((row) => (row.name && !cloud && host.loraInfo ? host.loraInfo(row.name) : null));
    const fam = t.takes ? recipeFamily(r) : null;
    const key = JSON.stringify([r ? r.id : null, t, cloud, rows, names, infos, fam]);
    if (picker && picker.ed === ed && (!r || picker.recipeId !== r.id || !t.takes || picker.index >= rows.length)) closePicker();
    if (key === p.key) return;
    p.key = key;
    p.recipeId = r ? r.id : null;
    p.section.hidden = !t.takes;
    p.section.dataset.reason = t.takes ? "" : t.reason || "";
    p.section.dataset.source = cloud ? "cloud" : t.takes ? "comfy" : "";
    p.summary.title = !t.takes ? t.reason || ""
        : cloud ? `LoRAs for ${r.name || r.id}: up to ${MAX_LORAS}, from Comfy Cloud's lists (your own imports and its catalog) or a name typed in the picker, loaded in this order between the recipe's model loader and what reads the model. Kept per recipe for every document; a switched-off row is not sent.`
            : `LoRAs for ${r.name || r.id}: up to ${MAX_LORAS}, from your ComfyUI's list, loaded in this order between the recipe's model loader and what reads the model. Kept per recipe for every document; a switched-off row is not sent.`;
    const on = rows.filter((x) => x.on).length;
    p.count.textContent = rows.length ? `${on} on` : "";
    p.count.title = rows.length ? `${on} of ${rows.length} switched on` : "";
    p.list.replaceChildren(...rows.map((row, i) => rowEl(host, ed, row, i, names, infos[i], fam, cloud)));
    const full = rows.length >= MAX_LORAS;
    p.add.disabled = !t.takes || full;
    p.add.title = full ? `Five LoRAs per recipe: remove one (\u00d7) to add another.` : "Add a LoRA row and pick its file";
    p.note.textContent = full ? "Five LoRAs per recipe." : rows.length ? "" : cloud ? "Add a LoRA from Comfy Cloud's lists (up to five per recipe)." : "Add a LoRA from your ComfyUI's list (up to five per recipe).";
}

/** One row: the tick, the name (opens the picker), the strength, ×, and the line with the hint and the trigger chips. */
function rowEl(host, ed, row, i, names, inf, fam, cloud) {
    const r = host.recipe;
    const el = mk("div", "ipc-lora-row" + (row.on ? "" : " ipc-lora-off"));
    el.dataset.index = String(i);
    const tick = mk("input", "ipc-lora-on");
    tick.type = "checkbox";
    tick.checked = row.on;
    tick.title = row.on ? "Switched on: a run loads this LoRA. Untick to leave it out." : "Switched off: a run leaves this LoRA out. Tick to load it.";
    tick.setAttribute("aria-label", "Load this LoRA");
    tick.addEventListener("change", () => updateRows(host, r, (rs) => { if (rs[i]) rs[i].on = tick.checked; }));
    const name = mk("button", "ipc-sel ipc-lora-name");
    name.type = "button";
    const missing = !!row.name && names.length > 0 && !listed(names, row.name);
    name.appendChild(mk("span", "ipc-lora-stem", row.name ? loraStem(row.name) : "Pick a LoRA"));
    if (!row.name) name.classList.add("ipc-lora-empty");
    if (missing) {
        // on Comfy Cloud a mark, never a refusal (an import made since the lists were read, a name typed by hand)
        name.classList.add(cloud ? "ipc-lora-unlisted" : "ipc-lora-missing");
        name.appendChild(mk("span", "ipc-lora-miss", cloud ? "(not in Comfy Cloud's lists)" : "(not on the server)"));
    }
    name.title = !row.name ? (cloud ? "Pick a LoRA from Comfy Cloud's lists, or type its file name" : "Pick a LoRA from your ComfyUI's list")
        : missing && cloud ? `${row.name} is in neither of Comfy Cloud's lists (your imports, its catalog): a run sends it as written, and Comfy Cloud refuses the run if your account has no such file.`
            : missing ? `${row.name} is not on the server: put the file in models/loras (and refresh ComfyUI), or pick another one. A run with this row switched on is refused.`
                : `${row.name}\nClick to pick another one.`;
    name.addEventListener("click", (e) => { e.preventDefault(); if (picker && picker.ed === ed && picker.index === i) closePicker(); else openPicker(host, ed, i); });
    const range = strengthRange(host.objectInfo);
    const str = mk("input", "ipc-num ipc-lora-strength");
    str.type = "number";
    str.min = String(SPIN.min); str.max = String(SPIN.max); str.step = String(SPIN.step);
    str.value = strengthText(row.strength);
    str.title = `Strength (${SPIN.min} .. ${SPIN.max} on the arrows; a typed value up to ${range.min} .. ${range.max}). 1.0 is the LoRA as trained, 0 leaves it out.`;
    str.setAttribute("aria-label", "Strength");
    str.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); str.blur(); } });
    str.addEventListener("change", () => {
        const v = clampStrength(str.value, host.objectInfo);
        if (v == null) { str.value = strengthText(row.strength); return; }
        str.value = strengthText(v);
        if (v !== row.strength) updateRows(host, r, (rs) => { if (rs[i]) rs[i].strength = v; });
    });
    const del = mk("button", "ipc-mini ipc-lora-del", "\u00d7");
    del.type = "button";
    del.title = row.name ? `Remove ${loraStem(row.name)} from this recipe's LoRAs` : "Remove this row";
    del.setAttribute("aria-label", "Remove");
    del.addEventListener("click", () => updateRows(host, r, (rs) => { rs.splice(i, 1); }));
    // the base-model hint ("looks like FLUX 3", amber on a mismatch) and the trigger chips; empty, it takes no room
    const info = mk("div", "ipc-lora-info");
    if (row.name && inf) infoLine(ed, info, inf, fam);
    el.append(tick, name, str, del, info);
    return el;
}

/** What the hint's source is worth, as its tooltip says. */
const FROM = {
    keys: "Read from the file's tensor names.",
    metadata: "From the file's own metadata, which may be wrong (some trainers write a default there).",
    folder: "From the folder's name alone: the file itself could not be read here.",
};

/** The hint (grey, or amber when the tensor names fit another family than the recipe's) and the trigger chips. */
function infoLine(ed, box, inf, fam) {
    const h = loraHint(inf.fam, fam);
    if (h) {
        const line = mk("span", "ipc-lora-hint" + (h.kind === "mismatch" ? " ipc-lora-amber" : ""), h.text);
        line.title = h.kind === "mismatch"
            ? `${FROM.keys} Nothing is refused: a run loads it anyway, and ComfyUI's console then shows "lora key not loaded" lines for what does not fit.`
            : (FROM[inf.fam.from] || "") + (fam && inf.fam.from === "keys" ? ` This recipe runs ${familyLabel(fam)}.` : "");
        box.appendChild(line);
    }
    for (const word of inf.triggers || []) {
        const chip = mk("button", "ipc-mini ipc-lora-chip", word);
        chip.type = "button";
        chip.title = `Append "${word}" to the prompt (a trigger word this LoRA was trained with)`;
        chip.addEventListener("click", (e) => {
            e.preventDefault();
            ed.setPromptText(appendWord(ed.promptText, word));
            ed.notifyChanged();
        });
        box.appendChild(chip);
    }
}

/** The rows of `r` changed by `fn` (a copy of the stored ones), stored for the recipe, every section drawn again. */
function updateRows(host, r, fn) {
    if (!r) return Promise.resolve();
    const rows = host.loraRows(r).map((x) => ({ ...x }));
    fn(rows);
    const saved = host.saveLoras(r.id, rows.slice(0, MAX_LORAS));   // host.loras is the new object before the write ends
    renderAll(host);
    return saved;
}

/** **+**: a row at strength 1.0, switched on, its picker open. */
function addRow(host, ed) {
    const r = host.recipe;
    if (!r || !host.loraTakes(r).takes) return;
    const n = host.loraRows(r).length;
    if (n >= MAX_LORAS) return;
    updateRows(host, r, (rs) => { rs.push({ name: "", strength: 1, on: true }); });
    openPicker(host, ed, n);
}

// ---- the picker ------------------------------------------------------------------------------------------------------

/** The open picker, for a test: `{ ed, index, el, search, names(), rows() }`, or null. */
export function openPickerState() {
    if (!picker) return null;
    const pk = picker;
    return { ed: pk.ed, index: pk.index, el: pk.el, search: pk.search, cursor: pk.items[pk.cursor] || null, names: () => pk.names.slice(), rows: () => pk.items.slice() };
}

/** Close the picker (Escape, a pick, a press outside it, a recipe change). */
export function closePicker() {
    const pk = picker;
    if (!pk) return;
    picker = null;
    window.removeEventListener("pointerdown", pk.outside, true);
    try { if (pk.el.open) pk.el.close(); } catch (_) { /* gone with its editor */ }
    pk.el.remove();
}

/**
 * The picker for row `index` of the selected recipe, at its name button: a search over the server's names, the names
 * grouped by subfolder, ↑ / ↓ / Enter / Escape, a click picks. The list is read again when it opens (a file copied into
 * models/loras since the connect is there by then). Not connected: it says so, and the row keeps its name.
 */
export function openPicker(host, ed, index) {
    closePicker();
    const p = ed && ed._loraPanel;
    const r = host.recipe;
    if (!p || !r || !ed.root) return null;
    const rows = host.loraRows(r);
    if (index < 0 || index >= rows.length) return null;
    const anchor = p.list.querySelector(`.ipc-lora-row[data-index="${index}"] .ipc-lora-name`) || p.add;
    const cloud = host.loraSource(r) === "cloud";
    const dlg = mk("dialog", "ipc-lorapop");
    dlg.setAttribute("aria-label", "Pick a LoRA");
    if (cloud) dlg.dataset.source = "cloud";
    const head = mk("div", "ipc-lp-head");
    const title = mk("span", "ipc-lp-title", cloud ? "LoRAs on Comfy Cloud" : "LoRAs on your ComfyUI");
    const total = mk("span", "ipc-lp-total");
    head.append(title, total);
    const search = mk("input", "ipc-lp-search");
    search.type = "text";
    search.placeholder = cloud ? "Search, or type a file name" : "Search by name or folder";
    search.spellcheck = false;
    search.setAttribute("aria-label", "Search the LoRAs");
    const list = mk("div", "ipc-lp-list");
    list.setAttribute("role", "listbox");
    const note = mk("div", "ipc-lp-note");
    // Comfy Cloud: where the account's own LoRAs come from, and that a typed name goes as written
    const cloudNote = mk("div", "ipc-lp-note ipc-lp-cloudnote", cloud ? CLOUD_NOTE : "");
    cloudNote.hidden = !cloud;
    const foot = mk("div", "ipc-lp-foot", "\u2191\u2193 Navigate \u00b7 \u23ce Pick \u00b7 Esc Close");
    dlg.append(head, search, list, note, cloudNote, foot);
    // the editor never sees a press in it (its root acts on pointer events); a press on a row keeps the focus in the search
    for (const type of ["pointerdown", "pointerup", "click", "dblclick", "wheel", "contextmenu"]) dlg.addEventListener(type, (e) => e.stopPropagation());
    dlg.addEventListener("mousedown", (e) => { if (e.target !== search) e.preventDefault(); });
    const pk = {
        host, ed, index, recipeId: r.id, el: dlg, search, list, note, total, anchor, cloud,
        names: cloud ? host.loraNamesFor(r) : serverUp(host) ? host.loraNames() : [], up: cloud ? cloudUp(host) : serverUp(host), current: rows[index].name, items: [], cursor: -1,
        outside: null, family: recipeFamily(r), showAll: false,
    };
    pk.outside = (e) => {
        if (!dlg.isConnected) { closePicker(); return; }
        if (dlg.contains(e.target)) return;
        // a press on this row's name button (drawn again since, maybe) is its click's to answer: it closes the picker
        const nb = e.target && e.target.closest ? e.target.closest(".ipc-lora-name") : null;
        const row = nb && p.list.contains(nb) ? nb.closest(".ipc-lora-row") : null;
        if (row && row.dataset.index === String(index)) return;
        closePicker();
    };
    search.addEventListener("input", () => fill(pk, false));
    // the keys on the dialog: the search's, or the dialog's own while the search is off (not connected, no files)
    dlg.tabIndex = -1;
    dlg.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); move(pk, e.key === "ArrowDown" ? 1 : -1); }
        else if (e.key === "Enter") { e.preventDefault(); const it = pk.items[pk.cursor]; if (it) pick(pk, it); }
        else if (e.key === "Escape") { e.preventDefault(); closePicker(); try { anchor.focus({ preventScroll: true }); } catch (_) { /* gone */ } }
    });
    // a close the dialog makes itself (Chromium fires cancel, not always close, on a real Escape: CLAUDE.md)
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); closePicker(); });
    dlg.addEventListener("close", () => { if (picker === pk) closePicker(); });
    ed.root.appendChild(dlg);
    picker = pk;
    dlg.show();
    fill(pk, true);
    place(dlg, ed.root, anchor);
    window.addEventListener("pointerdown", pk.outside, true);
    // after the click that opened it: the editor's root takes the focus on a click on any button (inpaint_canvas.js
    // bindEvents), which would leave the search without its keys
    const focus = () => { if (picker === pk) { try { (search.disabled ? dlg : search).focus({ preventScroll: true }); } catch (_) { /* gone */ } } };
    focus();
    setTimeout(focus, 0);
    if (pk.up || cloud) {
        Promise.resolve(host.refreshLoraNamesFor(r)).then((names) => {
            if (picker !== pk) { renderAll(host); return; }
            const up = cloud ? cloudUp(host) : pk.up;
            if (JSON.stringify(names) !== JSON.stringify(pk.names) || up !== pk.up || cloud) {
                pk.names = names.slice();
                pk.up = up;
                fill(pk, false);
                if (document.activeElement === dlg && !search.disabled) focus();
            }
            renderAll(host);   // the rows' "(not on the server)" follow the list read again
        }).catch(() => { /* the list as it was */ });
    }
    return pk;
}

/** The group of the account's own imports on Comfy Cloud. */
const OWN_GROUP = "Your imports";

/** The picker's line under a Comfy Cloud list. */
const CLOUD_NOTE = "Your imports: the LoRAs Comfy Cloud lists as your own (imported on its site, Creator plan or higher). One not listed can be typed in the search; the name goes as written.";

/** Whether Comfy Cloud's lists were read with a stored key (null: not read yet). */
function cloudUp(host) {
    const c = host._cloudLoras;
    return c ? !!c.key : null;
}

/** The list for the search's text now: the groups, the cursor on the row's own name or the first match. */
function fill(pk, first) {
    const q = pk.search.value;
    const prev = !first && pk.items[pk.cursor] ? pk.items[pk.cursor].name : null;
    pk.items = [];
    const nodes = [];
    const all = pk.names;
    const c = pk.cloud ? pk.host._cloudLoras : null;
    if (pk.cloud && !all.length) {
        // Comfy Cloud: the search stays open, a typed name goes as written
        pk.search.disabled = false;
        pk.note.textContent = pk.up === null ? "Reading Comfy Cloud's lists \u2026"
            : c && c.error ? `Comfy Cloud's lists could not be read (${c.error}); a file name typed above goes as written.`
                : !pk.up ? `${c && c.stale ? "The Comfy Cloud key was stored on another PC or Windows account: type it again" : "No Comfy Cloud key yet"} (Settings \u203a API providers), so its lists cannot be read; a file name typed above goes as written.`
                    : "Comfy Cloud lists no LoRA files for this key; a file name typed above goes as written.";
    } else if (!pk.cloud && !pk.up) {
        pk.note.textContent = "Connect ComfyUI to pick LoRAs (Settings \u203a ComfyUI). The row keeps its name.";
        pk.search.disabled = true;
    } else if (!pk.cloud && !all.length) {
        pk.note.textContent = "Your ComfyUI lists no LoRA files: put .safetensors files in its models/loras folder (and refresh ComfyUI).";
        pk.search.disabled = true;
    } else {
        pk.search.disabled = false;
        const hits = filterNames(all, q);
        pk.note.textContent = hits.length || pk.cloud ? "" : `No LoRA matches "${q.trim()}".`;
        // Comfy Cloud: the account's own imports first, as a group of their own, outside the family split
        const own = new Set(c && Array.isArray(c.own) ? c.own : []);
        const mine = pk.cloud ? hits.filter((n) => own.has(n)) : [];
        const rest = pk.cloud ? hits.filter((n) => !own.has(n)) : hits;
        // the recipe's family first (folders named for it, files whose hint fits it), the rest behind Show all
        const split = familyGroups(groupByFolder(rest), pk.family, (n) => { const i = pk.host.loraInfo(n, { read: false }); return i ? i.fam : null; });
        if (first && !pk.showAll && pk.current && split.rest.some((g) => g.names.some((n) => normalizeName(n) === normalizeName(pk.current)))) pk.showAll = true;
        const shown = [...(mine.length ? [{ folder: OWN_GROUP, names: mine, own: true }] : []), ...(pk.showAll ? [...split.first, ...split.rest] : split.first)];
        for (const g of shown) {
            const head = mk("div", "ipc-lp-group" + (g.own ? " ipc-lp-own" : ""));
            head.append(mk("span", "ipc-lp-folder", g.folder || (pk.cloud ? "Comfy Cloud's catalog" : "(root)")), mk("span", "ipc-lp-n", String(g.names.length)));
            nodes.push(head);
            for (const name of g.names) {
                const i = pk.items.length;
                const b = mk("button", "ipc-lp-row");
                b.type = "button";
                b.tabIndex = -1;
                b.setAttribute("role", "option");
                b.title = name;
                b.dataset.name = name;
                b.append(mk("span", "ipc-lp-mark", normalizeName(name) === normalizeName(pk.current) ? "\u2713" : ""), mk("span", "ipc-lp-stem", loraStem(name)));
                // the mouse moves the cursor only when it really moves (a list that opens under a resting pointer keeps
                // its row for Enter)
                b.addEventListener("pointermove", (e) => {
                    if ((!e.movementX && !e.movementY) || pk.cursor === i) return;
                    pk.cursor = i;
                    mark(pk, false);
                });
                b.addEventListener("click", (e) => { e.preventDefault(); pick(pk, pk.items[i]); });
                pk.items.push({ name, el: b });
                nodes.push(b);
            }
        }
        if (split.rest.length) {
            const n = split.rest.reduce((a, g) => a + g.names.length, 0);
            const label = familyLabel(pk.family);
            const more = mk("button", "ipc-lp-more", pk.showAll ? `Only the ${label} folders` : `Show all (${n} more in ${split.rest.length} other folder${split.rest.length === 1 ? "" : "s"})`);
            more.type = "button";
            more.tabIndex = -1;
            more.title = pk.showAll ? `Show the folders that look made for ${label} alone` : `This recipe runs ${label}: its folders come first. Show the others too.`;
            more.addEventListener("click", (e) => { e.preventDefault(); pk.showAll = !pk.showAll; fill(pk, false); });
            nodes.push(more);
        }
    }
    // Comfy Cloud: a typed name no list holds goes as written (an import made since the lists were read)
    const typed = q.trim();
    if (pk.cloud && typed && !all.some((n) => normalizeName(n) === normalizeName(typed))) {
        const name = /\.[a-z0-9]{2,12}$/i.test(typed) ? typed : typed + ".safetensors";
        const i = pk.items.length;
        const b = mk("button", "ipc-lp-row ipc-lp-typed");
        b.type = "button";
        b.tabIndex = -1;
        b.setAttribute("role", "option");
        b.title = `${name}: sent as written; Comfy Cloud refuses the run if your account has no such file`;
        b.dataset.name = name;
        b.append(mk("span", "ipc-lp-mark", ""), mk("span", "ipc-lp-stem", `Use “${name}” as typed`));
        b.addEventListener("pointermove", (e) => { if ((!e.movementX && !e.movementY) || pk.cursor === i) return; pk.cursor = i; mark(pk, false); });
        b.addEventListener("click", (e) => { e.preventDefault(); pick(pk, pk.items[i]); });
        pk.items.push({ name, el: b, typed: true });
        nodes.push(b);
    }
    pk.note.hidden = !pk.note.textContent;
    pk.total.textContent = pk.up && all.length ? (q.trim() ? `${pk.items.filter((it) => !it.typed).length} of ${all.length}` : `${all.length} files`) : "";
    pk.list.replaceChildren(...nodes);
    const want = prev != null ? prev : first ? pk.current : null;
    const at = want ? pk.items.findIndex((it) => it.name === want || normalizeName(it.name) === normalizeName(want)) : -1;
    pk.cursor = at >= 0 ? at : pk.items.length ? 0 : -1;
    mark(pk, true);
}

/** The cursor's row marked, and scrolled into view when the keys moved it. */
function mark(pk, scroll) {
    pk.items.forEach((it, i) => it.el.classList.toggle("ipc-lp-cur", i === pk.cursor));
    const cur = pk.items[pk.cursor];
    if (scroll && cur && cur.el.scrollIntoView) cur.el.scrollIntoView({ block: "nearest" });
}

/** ↑ / ↓, wrapping. */
function move(pk, d) {
    const n = pk.items.length;
    if (!n) return;
    pk.cursor = pk.cursor < 0 ? (d > 0 ? 0 : n - 1) : (pk.cursor + d + n) % n;
    mark(pk, true);
}

/** The picked name into the row (the server's spelling), the picker closed. */
function pick(pk, it) {
    if (!it || picker !== pk) return;
    const { host, ed, index, recipeId } = pk;
    closePicker();
    const r = host.recipe;
    if (!r || r.id !== recipeId) return;
    updateRows(host, r, (rs) => { if (rs[index]) rs[index].name = it.name; });
    // the rows were drawn again: the focus goes back to this row's new name button
    const p = ed._loraPanel;
    const nb = p && p.list.querySelector(`.ipc-lora-row[data-index="${index}"] .ipc-lora-name`);
    try { if (nb) nb.focus({ preventScroll: true }); } catch (_) { /* not focusable */ }
}

/** Below the anchor, or above it when the room below is short; inside the editor's root. */
function place(box, root, anchor) {
    const rb = root.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    const w = box.offsetWidth || 300, h = box.offsetHeight || 320;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    const left = clamp(a.right - rb.left - w, 4, rb.width - w - 4);
    const below = rb.bottom - a.bottom;
    const top = below < h + 10 && a.top - rb.top > below ? a.top - rb.top - h - 4 : a.bottom - rb.top + 4;
    box.style.left = `${left}px`;
    box.style.top = `${clamp(top, 4, rb.height - h - 4)}px`;
}

/** The folder a name sits in, as the picker's groups name it (for a test). */
export function folderLabel(name) {
    return loraFolder(name) || "(root)";
}
