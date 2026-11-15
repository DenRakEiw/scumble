// The ComfyUI window's bar and start page (electron/main/comfyview.js, docs/PLAN_COMFY_VIEW.md §2.1, §2.5). Main
// sends the window's state; the bar shows it and asks main for Reload and Settings. It has no window.scumble.
"use strict";

(() => {
    const $ = (id) => document.getElementById(id);
    const bar = window.comfybar;

    function show(s) {
        if (!s) return;
        const withPage = s.phase === "page" || s.phase === "loading";
        $("cb-host").textContent = s.host || "";
        $("cb-target").value = s.target === "cloud" ? "cloud" : "comfy";
        $("cb-cloud").hidden = s.target === "cloud";
        $("cb-connect").hidden = s.target === "cloud";
        $("cb-start").querySelector("h1").textContent = s.target === "cloud" ? "No Comfy Cloud to show." : "No ComfyUI to show.";
        $("cb-host").title = s.url || "";
        $("cb-recipe").textContent = s.recipe ? `Editing: ${s.recipe}` : "No recipe";
        $("cb-recipe").title = s.recipe ? (s.recipeLoaded ? "This recipe's graph is loaded in the page" : "The graph goes into the page once ComfyUI is ready") : "";
        $("cb-recipe-note").hidden = !s.recipeNote;
        $("cb-recipe-note").textContent = s.recipeNote || "";
        $("cb-recipe-note").title = s.recipeNote || "";
        $("cb-loading").hidden = s.phase !== "loading";
        $("cb-save").disabled = !s.canSave;
        $("cb-save").title = s.recipe ? `Overwrite the recipe "${s.recipe}" with this graph` : "This window holds no recipe: use Save as new recipe";
        $("cb-save-new").disabled = !s.canSaveNew;
        $("cb-save-note").textContent = s.saveNote || "";
        $("cb-save-note").title = s.saveNote || "";
        if (!s.canSaveNew) naming(false);
        $("cb-params").disabled = s.phase !== "page";
        if (s.phase !== "page" && paramsShown) paramsView(false);   // main hides the list with the page
        $("cb-start").hidden = withPage;
        $("cb-why").textContent = (s.message || "") + (s.recipe && !withPage ? ` The recipe "${s.recipe}" opens here once a ComfyUI answers.` : "");
        document.body.classList.toggle("cb-full", !withPage);
    }

    // Save as new recipe asks for the name in the bar itself (a dialog would be clipped to the bar's 36 px)
    function naming(on) {
        $("cb-name-row").hidden = !on;
        $("cb-save").hidden = on;
        $("cb-save-new").hidden = on;
        if (on) { $("cb-name").value = ""; $("cb-name").focus(); }
    }
    const saveNew = () => {
        const name = $("cb-name").value.trim();
        if (!name) { $("cb-name").focus(); return; }
        naming(false);
        bar.save({ asNew: true, name }).catch(() => {});
    };
    $("cb-save").addEventListener("click", () => bar.save({ asNew: false }).catch(() => {}));
    $("cb-save-new").addEventListener("click", () => naming(true));
    $("cb-name-ok").addEventListener("click", saveNew);
    $("cb-name-cancel").addEventListener("click", () => naming(false));
    $("cb-name").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveNew(); }
        else if (e.key === "Escape") { e.preventDefault(); naming(false); }
    });
    // the Parameters list (item 66): the graph's widget inputs by node, ticked where one is a Settings row (wired to a
    // setting output of the Inpaint Canvas node); main grows the bar over the page while the list is shown
    let paramsShown = false, busy = false;
    function paramsView(on) {
        paramsShown = on;
        $("cb-params-panel").hidden = !on;
        $("cb-params").setAttribute("aria-expanded", on ? "true" : "false");
        $("cb-params").classList.toggle("cb-on", on);
    }
    function paramsNote(text) {
        $("cb-params-note").hidden = !text;
        $("cb-params-note").textContent = text || "";
    }
    function renderParams(r) {
        const list = $("cb-params-list");
        list.textContent = "";
        if (!r || r.ok === false && !Array.isArray(r.nodes)) {
            $("cb-params-count").textContent = "";
            paramsNote((r && r.message) || "The page's graph could not be read.");
            return;
        }
        $("cb-params-count").textContent = r.canvas ? `${r.used} of ${r.cap} setting outputs in use` : "";
        paramsNote([r.ok === false ? r.message : "", r.note || ""].filter(Boolean).join(" "));
        if (!r.nodes.length && r.canvas) {
            const p = document.createElement("p");
            p.className = "cb-note";
            p.textContent = "The graph has no widget inputs Scumble can offer (the Inpaint Canvas node's own and linked inputs are left out).";
            list.appendChild(p);
        }
        for (const n of r.nodes) {
            const sec = document.createElement("section");
            sec.className = "cb-pnode";
            const h = document.createElement("h2");
            h.textContent = n.title;
            if (n.type && n.type !== n.title) {
                const t = document.createElement("span");
                t.className = "cb-note";
                t.textContent = ` ${n.type} #${n.id}`;
                h.appendChild(t);
            } else {
                const t = document.createElement("span");
                t.className = "cb-note";
                t.textContent = ` #${n.id}`;
                h.appendChild(t);
            }
            sec.appendChild(h);
            for (const inp of n.inputs) {
                const row = document.createElement("label");
                row.className = "cb-prow";
                const box = document.createElement("input");
                box.type = "checkbox";
                box.checked = !!inp.exposed;
                box.disabled = !inp.exposed && !!r.full;
                box.dataset.node = n.id;
                box.dataset.input = inp.name;
                box.title = inp.exposed ? `A Settings row (setting ${inp.index}): "${inp.label}"` : `Make it a Settings row: "${inp.label}"`;
                box.addEventListener("change", () => expose(n.id, inp.name, box.checked));
                const name = document.createElement("span");
                name.className = "cb-pname";
                name.textContent = inp.name;
                const kind = document.createElement("span");
                kind.className = "cb-note cb-pkind";
                kind.textContent = (inp.kind || "").toLowerCase();
                const val = document.createElement("span");
                val.className = "cb-note cb-pval";
                val.textContent = inp.value;
                val.title = inp.value;
                row.append(box, name, kind, val);
                sec.appendChild(row);
            }
            list.appendChild(sec);
        }
    }
    const lockList = (on) => { busy = on; for (const b of $("cb-params-list").querySelectorAll("input")) if (on) b.disabled = true; };
    async function readParams() {
        if (busy) return;
        lockList(true);
        try { renderParams(await bar.params.read()); } catch (err) { renderParams({ ok: false, message: String((err && err.message) || err) }); }
        finally { busy = false; }
    }
    async function expose(node, input, on) {
        if (busy) return;
        lockList(true);
        try { renderParams(await bar.params.expose(node, input, on)); } catch (err) { renderParams({ ok: false, message: String((err && err.message) || err) }); }
        finally { busy = false; }
    }
    async function toggleParams(on) {
        paramsView(on);
        try { await bar.params.shown(on); } catch (_) { /* the window went */ }
        if (on) await readParams();
    }
    $("cb-params").addEventListener("click", () => toggleParams(!paramsShown));
    $("cb-params-close").addEventListener("click", () => toggleParams(false));
    $("cb-params-refresh").addEventListener("click", () => readParams());
    $("cb-params-panel").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); toggleParams(false); } });
    $("cb-reload").addEventListener("click", () => bar.reload().then(show, () => {}));
    $("cb-retry").addEventListener("click", () => bar.reload().then(show, () => {}));
    $("cb-connect").addEventListener("click", () => bar.openSettings().catch(() => {}));
    $("cb-cloud").addEventListener("click", () => bar.setTarget("cloud").then(show, () => {}));
    $("cb-target").addEventListener("change", () => bar.setTarget($("cb-target").value).then(show, () => {}));
    bar.onState(show);
    bar.state().then(show, () => {});
    // main's questions (comfyview.js askInBar: the page's camera / microphone) in the app's own dialog; main lays the
    // bar over the whole window first, and a question waits for that size to reach this page (at most 500 ms), so it
    // never opens in the 36 px strip. It is acknowledged at once (main's 1 s fallback counts from the ask, not from the
    // showModal), and one main takes back while it waits (comfyview:dismiss) never opens: dialogs.js listen() knows a
    // question only once it is handed on, so a dismiss before that would be lost and leave an orphan modal over the bar
    const waiting = new Set();
    const roomy = () => new Promise((resolve) => {
        if (innerHeight > 60) { resolve(); return; }
        let timer = null;
        const done = () => { removeEventListener("resize", check); clearTimeout(timer); resolve(); };
        const check = () => { if (innerHeight > 60) done(); };
        addEventListener("resize", check);
        timer = setTimeout(done, 500);
    });
    const asks = bar.dialog && {
        onAsk: (cb) => bar.dialog.onAsk((m) => {
            const id = m && m.id;
            waiting.add(id);
            bar.dialog.shown(id);
            roomy().then(() => { if (waiting.delete(id)) cb(m); });
        }),
        onDismiss: (cb) => bar.dialog.onDismiss((id) => { if (!waiting.delete(id)) cb(id); }),
        shown: (id) => bar.dialog.shown(id),
        answer: (id, index) => bar.dialog.answer(id, index),
    };
    import("./dialogs.js").then((d) => d.listen(asks), (err) => console.warn("comfybar: no dialogs", err));
})();
