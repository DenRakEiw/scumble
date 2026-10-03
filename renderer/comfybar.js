// The ComfyUI window's bar and start page (electron/main/comfyview.js, docs/PLAN_COMFY_VIEW.md §2.1, §2.5). Main
// sends the window's state; the bar shows it and asks main for Reload and Settings. It has no window.scumble.
"use strict";

(() => {
    const $ = (id) => document.getElementById(id);
    const bar = window.comfybar;

    function show(s) {
        if (!s) return;
        const withPage = s.phase === "page" || s.phase === "loading";
        $("cb-host").textContent = s.host ? `My ComfyUI · ${s.host}` : "";
        $("cb-host").title = s.url || "";
        $("cb-recipe").textContent = s.recipe ? `Editing: ${s.recipe}` : "No recipe";
        $("cb-recipe").title = s.recipe ? (s.recipeLoaded ? "This recipe's graph is loaded in the page" : "The graph goes into the page once ComfyUI is ready") : "";
        $("cb-recipe-note").hidden = !s.recipeNote;
        $("cb-recipe-note").textContent = s.recipeNote || "";
        $("cb-recipe-note").title = s.recipeNote || "";
        $("cb-loading").hidden = s.phase !== "loading";
        $("cb-start").hidden = withPage;
        $("cb-why").textContent = (s.message || "") + (s.recipe && !withPage ? ` The recipe "${s.recipe}" opens here once a ComfyUI answers.` : "");
        document.body.classList.toggle("cb-full", !withPage);
    }

    $("cb-reload").addEventListener("click", () => bar.reload().then(show, () => {}));
    $("cb-retry").addEventListener("click", () => bar.reload().then(show, () => {}));
    $("cb-connect").addEventListener("click", () => bar.openSettings().catch(() => {}));
    bar.onState(show);
    bar.state().then(show, () => {});
})();
