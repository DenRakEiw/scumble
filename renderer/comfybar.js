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
    $("cb-reload").addEventListener("click", () => bar.reload().then(show, () => {}));
    $("cb-retry").addEventListener("click", () => bar.reload().then(show, () => {}));
    $("cb-connect").addEventListener("click", () => bar.openSettings().catch(() => {}));
    bar.onState(show);
    bar.state().then(show, () => {});
})();
