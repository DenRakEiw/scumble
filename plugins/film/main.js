// Film pack: the first real plugin on the Scumble plugin API (docs/PLUGINS.md), a Nik
// Collection / FilmPack style set of filter layers. filters.js holds the filter types,
// points.js the control points (filter + tool + layer-row control), looks.js the data,
// common.js the shared maths. This module registers everything and adds the "Film looks"
// panel (one thumbnail per stock), the Plugins menu actions and the commands.

import { makeFilters, lookStage } from "./filters.js";
import { makePoints } from "./points.js";
import { STOCKS, STOCK_BY_ID, GROUPS } from "./looks.js";
import { makeRunner, makeCanvas, TRADEMARK } from "./common.js";

const LOOK_ID = "film.look";

export function activate(scumble) {
    const { ui } = scumble;
    const run = makeRunner(scumble);

    // ---- filters ----------------------------------------------------------------------------------
    // chain: every filter here runs through makeRunner / common.js, which resolve a GPU
    // surface only where they really read pixels, so the editor's filter chain can hand
    // them a texture instead of a canvas (docs/PERFORMANCE.md, phase 5 step 2).
    for (const def of makeFilters(scumble)) scumble.filters.register({ ...def, chain: true });
    const points = makePoints(scumble);
    scumble.filters.register({ ...points.filter, chain: true });
    scumble.tools.register(points.tool);
    scumble.commands.register(points.command.name, points.command.def);

    // ---- apply a stock to the active look layer or a new one -----------------------------------------
    function applyLook(doc, presetId, { strength } = {}) {
        const stock = STOCK_BY_ID[presetId];
        const params = { preset: stock ? stock.id : "custom" };
        if (strength != null) params.strength = Math.max(0, Math.min(100, +strength));
        const active = doc.activeLayer();
        if (active && active.kind === "filter" && active.filter === LOOK_ID) {
            const l = doc.rawLayer(active.id);
            l.name = stock ? stock.label.replace(/ \(.*\)$/, "") : l.name;
            const out = doc.setFilterParams(active.id, params);
            doc.editor.renderLayers();
            doc.status(`${l.name}: film look changed.`);
            return out;
        }
        return doc.run("add_filter", { type: LOOK_ID, params, name: stock ? stock.label.replace(/ \(.*\)$/, "") : undefined });
    }

    // ---- panel: one thumbnail per stock -----------------------------------------------------------
    scumble.panels.register({
        id: "looks",
        title: "Film looks",
        pane: "image",
        open: false,
        build(box, doc) {
            box.classList.add("film-panel");
            const head = ui.el("div", "film-head");
            const groupSel = document.createElement("select");
            groupSel.className = "ipc-sel";
            groupSel.title = "Film group";
            for (const g of ["All", ...GROUPS]) { const o = document.createElement("option"); o.value = g; o.textContent = g; groupSel.appendChild(o); }
            groupSel.value = (scumble.storage.get() || {}).group || "Colour negative";
            groupSel.addEventListener("keydown", (e) => e.stopPropagation());
            head.appendChild(groupSel);
            const note = ui.el("span", "film-note", "Click a stock: it becomes the active film look layer or a new one.");
            note.title = TRADEMARK;
            head.appendChild(note);
            box.appendChild(head);
            const grid = ui.el("div", "film-grid");
            box.appendChild(grid);
            const cells = new Map();   // stock id -> canvas

            const buildGrid = () => {
                grid.innerHTML = "";
                cells.clear();
                const g = groupSel.value;
                for (const s of STOCKS) {
                    if (g !== "All" && s.group !== g) continue;
                    const cell = ui.el("div", "film-cell");
                    cell.title = `${s.label}${s.iso ? ` · ISO ${s.iso}` : ""} · ${s.group}. ${TRADEMARK}`;
                    const cv = document.createElement("canvas");
                    cv.width = 96; cv.height = 64;
                    cell.appendChild(cv);
                    cell.appendChild(ui.el("span", null, s.label.replace(/ \(.*\)$/, "")));
                    cell.addEventListener("click", (e) => { e.stopPropagation(); Promise.resolve(applyLook(doc, s.id)).catch((err) => doc.status(String(err.message || err))); });
                    grid.appendChild(cell);
                    cells.set(s.id, cv);
                }
            };

            let timer = null, busy = false, dirty = true;
            const render = () => {
                dirty = false;
                if (!doc.loaded) { for (const cv of cells.values()) { const c = cv.getContext("2d"); c.clearRect(0, 0, cv.width, cv.height); } return; }
                if (busy) { dirty = true; return; }
                busy = true;
                try {
                    const flat = doc.flatten();
                    const k = Math.min(96 / flat.width, 64 / flat.height);
                    const base = makeCanvas(Math.max(1, Math.round(flat.width * k)), Math.max(1, Math.round(flat.height * k)));
                    const bctx = base.getContext("2d");
                    bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = "high";
                    bctx.drawImage(flat, 0, 0, base.width, base.height);
                    for (const [id, cv] of cells) {
                        const out = lookStage(run, base, { preset: id, strength: 100 }, { cache: {}, scale: k });
                        if (cv.width !== base.width || cv.height !== base.height) { cv.width = base.width; cv.height = base.height; }
                        cv.getContext("2d").drawImage(out, 0, 0);
                    }
                } finally { busy = false; }
                if (dirty) schedule();
            };
            const visible = () => box.offsetParent !== null && box.getClientRects().length > 0;
            const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { if (visible()) render(); else dirty = true; }, 500); };

            groupSel.addEventListener("change", () => { scumble.storage.set({ group: groupSel.value }); buildGrid(); dirty = true; schedule(); });
            buildGrid();
            schedule();
            scumble.events.on("changed", (ev) => { if (ev.doc && ev.doc.id === doc.id) { dirty = true; schedule(); } });
            scumble.events.on("activate", (ev) => { if (ev.doc && ev.doc.id === doc.id && dirty) schedule(); });
            // a collapsed section renders nothing; render when it comes into view
            if (typeof IntersectionObserver === "function") {
                const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting) && dirty) schedule(); });
                io.observe(grid);
            }
        },
    });

    // ---- Plugins menu ----------------------------------------------------------------------------------
    const addFilter = (type, name) => (doc) => doc.run("add_filter", { type, name });
    scumble.actions.register({ id: "add_look", label: "Film look layer", run: addFilter(LOOK_ID) });
    scumble.actions.register({ id: "add_bw", label: "Black & white film layer", run: addFilter("film.bw") });
    scumble.actions.register({ id: "add_halation", label: "Halation layer", run: addFilter("film.halation") });
    scumble.actions.register({ id: "add_leak", label: "Light leak layer", run: addFilter("film.light_leak") });
    scumble.actions.register({ id: "add_frame", label: "Frame layer", run: addFilter("film.frame") });
    scumble.actions.register({ id: "add_points", label: "Control points layer (tool: U)", run: (doc) => { const r = addFilter("film.points", "Control points")(doc); doc.editor.setTool("film.point"); return r; } });

    // ---- commands ---------------------------------------------------------------------------------------
    scumble.commands.register("looks", {
        description: "The film stocks of the film look filter: id, label, group, ISO, grain character, tone curve class.",
        params: { group: { type: "string", description: "only this group (Colour negative, Slide, Black & white, Cine, Special & artistic)" } },
        scope: "app",
        run(doc, a) {
            const list = STOCKS.filter((s) => !a.group || s.group.toLowerCase() === String(a.group).toLowerCase());
            return { stocks: list.map((s) => ({ id: s.id, label: s.label, group: s.group, iso: s.iso, grain: s.grain, toe: s.toe, shoulder: s.shoulder, halation: s.halation })), note: TRADEMARK };
        },
    });
    scumble.commands.register("apply_look", {
        description: "Apply a film stock: changes the active film look layer, or adds one on top (see film.looks for the ids).",
        params: { preset: { type: "string", description: "stock id (film.looks), or custom", required: true }, strength: { type: "number", description: "0..100" } },
        needsImage: true,
        scope: "doc",
        run(doc, a) {
            if (a.preset !== "custom" && !STOCK_BY_ID[a.preset]) throw new Error(`unknown stock "${a.preset}" (see film.looks)`);
            return applyLook(doc, a.preset, { strength: a.strength });
        },
    });

    scumble.log(`loaded: ${STOCKS.length} stocks, ${GROUPS.length} groups`);
}

export function deactivate() {}
