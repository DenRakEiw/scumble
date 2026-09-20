// The editor's dialog, built once per document: buildEditorModal() puts the top bar, the tool
// column, the canvas and the side panel together, and one function per panel fills it. Moved here
// from InpaintEditor.buildModal() on 2026-09-20 (CLAUDE.md, the split of inpaint_canvas.js); the
// code is the method's, with `this` as the `ed` parameter. Every function writes its elements onto
// the editor, as the method did: they are construction, not state of their own.
import { host } from "./host.js";
import { el, iconButton, miniButton, selectInput, numberInput, hostText, REF_FITS, REF_DEFAULTS, UPSAMPLE_CASES, randomSeed } from "./inpaint_canvas.js";

/**
 * The whole dialog of one editor. The order is the one the method had, and the two joints it kept
 * in local variables are passed on: `root` and `body` hold the parts, and the side panel's
 * `section` adds a block to the tab that is current.
 */
export function buildEditorModal(ed) {
    const root = el("div", "ipc-modal");
    root.tabIndex = 0;
    ed.root = root;

    buildTopBar(ed, root);

    // body
    const body = el("div", "ipc-body");
    buildTools(ed, body);
    buildView(ed, body);

    const { side, section, toGenPane } = buildSidePanel(ed);
    buildLayers(ed);
    buildReferences(ed);
    buildSelection(ed, section);
    buildCanvasPanel(ed, section);
    buildExport(ed, section);
    toGenPane();
    buildPrompt(ed, section);
    buildGenerate(ed, section);
    buildSettings(ed, section);
    buildHistory(ed, section);
    buildCrop(ed, section);

    let paneId = "image";
    try { paneId = localStorage.getItem("ipc.pane") || "image"; } catch (_) { /* no storage */ }
    ed.showPane(paneId);
    body.appendChild(side);
    root.appendChild(body);

    const bottom = el("div", "ipc-bottom");
    ed.statusEl = el("span", null, ed.status);
    bottom.appendChild(ed.statusEl);
    bottom.appendChild(el("span", "ipc-kbd", host.overlay ? "Wheel: zoom · Space/middle: pan · [ ]: size · Esc: close" : "Wheel: zoom · Space/middle: pan · [ ]: size · Ctrl+Enter: generate"));
    root.appendChild(bottom);

    ed.bindEvents();
    ed.setTool("select");
    ed.renderLayers();
    ed.renderHistory();
    ed.renderInfo();
    ed.resizeObserver = new ResizeObserver(() => ed.resizeCanvas());
    ed.resizeObserver.observe(ed.viewEl);
    host.editorBuilt(ed);
}

/** The top bar: file buttons, the brush controls, the tip, the view toggles, the mode select and Generate. */
function buildTopBar(ed, root) {
    // top bar
    const top = el("div", "ipc-top");
    if (host.overlay) top.appendChild(el("span", "ipc-title", "Inpaint Canvas"));
    ed.fileInput = document.createElement("input");
    ed.fileInput.type = "file";
    ed.fileInput.accept = "image/*";
    ed.fileInput.style.display = "none";
    ed.fileInput.addEventListener("change", () => {
        const f = ed.fileInput.files && ed.fileInput.files[0];
        if (f) ed.loadFile(f);
        ed.fileInput.value = "";
    });
    top.appendChild(ed.fileInput);
    top.appendChild(iconButton("newfile", "New: an empty white canvas. Everything in this editor (layers, results, selection, history) is discarded; you are asked first.", () => ed.newCanvas(), "New"));
    if (host.generateNewAvailable && host.generateNewAvailable()) {
        top.appendChild(iconButton("sparkle", "Generate new: make the base image from the prompt alone, no image needed. Model, size and seed are in the dialog.", () => host.openGenerateNew(ed), "Generate new"));
    }
    top.appendChild(iconButton("load", "Load an image as the base layer (Ctrl+drop replaces the image; a plain drop adds a layer)", () => ed.fileInput.click(), "Load"));
    top.appendChild(iconButton("save", "Save the finished image (Ctrl+S): all visible layers with their filters, without control and reference layers, into ComfyUI's output folder. Name and format in the Canvas section.", () => ed.exportImage(), "Save"));

    const slider = (label, min, max, value, fmt, onInput) => {
        const lab = el("label", null, label);
        const inp = document.createElement("input");
        inp.type = "range"; inp.min = min; inp.max = max; inp.value = value;
        const val = el("span", null, fmt(value));
        inp.addEventListener("input", () => { onInput(+inp.value); val.textContent = fmt(+inp.value); });
        lab.appendChild(inp); lab.appendChild(val);
        top.appendChild(lab);
        return { input: inp, value: val };
    };
    ed.sizeCtl = slider("Size", 2, 400, ed.brushSize, (v) => v + "px", (v) => { ed.brushSize = v; ed.draw(); });
    ed.hardCtl = slider("Hardness", 0, 100, Math.round(ed.hardness * 100), (v) => v + "%", (v) => {
        // the slider edits the hardness of the active tool: the eraser has its own
        if (ed.tool === "erase") ed.eraseHardness = v / 100; else ed.hardness = v / 100;
        try { localStorage.setItem(ed.tool === "erase" ? "ipc.eraseHardness" : "ipc.hardness", String(v / 100)); } catch (_) { /* ignore */ }
    });
    ed.hardCtl.input.title = "Brush hardness. The eraser keeps its own value (soft by default); the slider shows the active tool's.";
    ed.opacCtl = slider("Opacity", 1, 100, 100, (v) => v + "%", (v) => { ed.brushOpacity = v / 100; });

    const colorLabel = el("label", null, "Color");
    ed.colorLabel = colorLabel;
    ed.colorInput = document.createElement("input");
    ed.colorInput.type = "color";
    ed.colorInput.value = ed.color;
    ed.colorInput.title = "Paint color";
    ed.colorInput.addEventListener("input", () => { ed.color = ed.colorInput.value; });
    colorLabel.appendChild(ed.colorInput);
    top.appendChild(colorLabel);

    // brush tip: the built-in round dab, or a stamp imported from a .abr or an image
    const tipLabel = el("label", null, "Tip");
    ed.tipLabel = tipLabel;
    ed.tipThumb = document.createElement("canvas");
    ed.tipThumb.width = 48; ed.tipThumb.height = 24;
    ed.tipThumb.className = "ipc-tipthumb";
    ed.tipThumb.style.width = "48px"; ed.tipThumb.style.height = "24px"; ed.tipThumb.style.position = "static";   // .ipc-view canvas is absolute and 100 %
    ed.tipThumb.title = "The tip that will land on the canvas";
    tipLabel.appendChild(ed.tipThumb);
    ed.tipSel = selectInput(["Round"], "Round", "The brush tip. Round is the built-in soft dab; the others were imported from a .abr or an image file.");
    ed.tipSel.addEventListener("change", () => ed.setBrushTip(ed.tipSel.value === "Round" ? "" : ed.tipSel.value));
    tipLabel.appendChild(ed.tipSel);
    ed.tipFile = document.createElement("input");
    ed.tipFile.type = "file";
    ed.tipFile.accept = ".abr,.png,.jpg,.jpeg,.webp";
    ed.tipFile.multiple = true;
    ed.tipFile.style.display = "none";
    ed.tipFile.addEventListener("change", () => { const f = Array.from(ed.tipFile.files || []); ed.tipFile.value = ""; ed.importBrushFiles(f); });
    tipLabel.appendChild(ed.tipFile);
    tipLabel.appendChild(iconButton("upload", "Import brush tips from a Photoshop .abr file or from images. A .abr may hold dozens of tips; all of them are added.", () => ed.tipFile.click(), "Import"));
    ed.tipRemoveBtn = iconButton("trash", "Remove this tip from the list", () => ed.removeBrushTip(ed.brushTipId));
    tipLabel.appendChild(ed.tipRemoveBtn);
    // the tip's own settings, shown while an imported tip is active (the round dab has hardness instead)
    const spacingLabel = el("label", null, "Spacing");
    ed.spacingCtl = document.createElement("input");
    ed.spacingCtl.type = "range"; ed.spacingCtl.min = 1; ed.spacingCtl.max = 200; ed.spacingCtl.value = 25;
    ed.spacingCtl.title = "Distance between stamps as a share of the tip's size; a .abr brings its own value";
    const spacingVal = el("span", null, "25%");
    ed.spacingCtl.addEventListener("input", () => { spacingVal.textContent = ed.spacingCtl.value + "%"; const t = ed.brushTip(); if (t) { t.spacing = +ed.spacingCtl.value / 100; ed._tipStamp = null; } });
    ed.spacingCtl.addEventListener("change", () => ed.brushTipsChanged());
    ed.spacingVal = spacingVal;
    spacingLabel.appendChild(ed.spacingCtl); spacingLabel.appendChild(spacingVal);
    const rotateLabel = el("label", null);
    ed.tipRotateCb = document.createElement("input");
    ed.tipRotateCb.type = "checkbox";
    ed.tipRotateCb.title = "Rotate the tip to follow the stroke direction, the way a flat brush turns in the hand";
    ed.tipRotateCb.addEventListener("change", () => { ed.tipRotate = ed.tipRotateCb.checked; try { localStorage.setItem("ipc.tipRotate", ed.tipRotate ? "1" : "0"); } catch (_) { /* ignore */ } });
    try { ed.tipRotate = localStorage.getItem("ipc.tipRotate") === "1"; } catch (_) { ed.tipRotate = false; }
    ed.tipRotateCb.checked = !!ed.tipRotate;
    rotateLabel.appendChild(ed.tipRotateCb); rotateLabel.appendChild(el("span", null, "Follow stroke"));
    ed.tipOnlyEls = [spacingLabel, rotateLabel];
    top.appendChild(tipLabel); top.appendChild(spacingLabel); top.appendChild(rotateLabel);
    // view toggles
    const viewBox = el("span", "ipc-viewbox");
    ed.rulersBtn = iconButton("ruler", "Rulers (Ctrl+Shift+R). Drag a guide out of a ruler; drag it back to remove it; double-click a ruler clears all guides. Layers snap to guides.", () => ed.toggleRulers());
    ed.rulersBtn.classList.toggle("ipc-toggle-on", ed.showRulers);
    viewBox.appendChild(ed.rulersBtn);
    ed.gridBtn = iconButton("grid", "Grid (Ctrl+Shift+G): lines every 64 px", () => ed.toggleGrid());
    ed.gridBtn.classList.toggle("ipc-toggle-on", ed.showGrid);
    viewBox.appendChild(ed.gridBtn);
    ed.peekBtn = iconButton("peek", "Before / after: the base image without any layer. Hold \\ for a quick look, click to toggle.", () => { ed.peekBase = !ed.peekBase; ed.peekHold = false; ed.peekBtn.classList.toggle("ipc-toggle-on", ed.peekBase); ed.draw(); });
    viewBox.appendChild(ed.peekBtn);
    viewBox.appendChild(iconButton("fit", "Fit to view (F); 1 shows 100 %", () => ed.fitView()));
    top.appendChild(viewBox);

    top.appendChild(el("span", "ipc-grow"));
    ed.modeSel = selectInput(["api", "local"], "api", "Which chain the result comes back from: API = the result input, Local = the result_local input. Only that chain runs.");
    ed.modeSel.classList.add("ipc-mode");
    ed.modeSel.addEventListener("change", () => { ed.genSettings.mode = ed.modeSel.value; ed.syncGenControls(); ed.renderInfo(); ed.notifyChanged(); host.modeChanged(ed, ed.modeSel.value); });
    top.appendChild(ed.modeSel);
    ed.generateBtn = iconButton("play", "Queue the workflow (Ctrl+Enter). The result comes back as a new layer.", () => ed.generate(), "Generate");
    ed.generateBtn.classList.add("ipc-primary");
    top.appendChild(ed.generateBtn);
    if (host.overlay) {
        // over the graph the editor needs its own way out; in the app it is the window
        const closeBtn = iconButton("close", "Close editor (Esc)", () => ed.close());
        closeBtn.classList.add("ipc-danger");
        top.appendChild(closeBtn);
    }
    root.appendChild(top);
}

/** The tool column: one button per tool, the groups with their flyouts, undo / redo and flatten. */
function buildTools(ed, body) {
    const tools = el("div", "ipc-tools");
    ed.toolsEl = tools;
    ed.toolButtons = {};
    const addTool = (id, title) => {
        const b = iconButton(id, title, () => ed.setTool(id));
        ed.toolButtons[id] = b;
        tools.appendChild(b);
    };
    ed._addTool = addTool;
    // Tool groups: one button per family, the button shows the family's current tool; hover,
    // right-click or hold opens the flyout with all of them (Photoshop / Krita style).
    ed.toolGroups = [];
    ed.toolGroupOf = {};
    const addGroup = (items, actions = []) => {
        const g = { items, tools: items.map((i) => i.tool), current: items[0].tool, actions, btn: null };
        const btn = el("button", "ipc-ib ipc-groupbtn");
        btn.type = "button";
        // click: the group's current tool at once. The flyout opens on right-click, on holding the
        // button (300 ms) or on a click on the corner triangle; it never opens on hover, so moving
        // down the column stays quiet.
        btn.addEventListener("click", (e) => {
            e.stopPropagation(); e.preventDefault();
            clearTimeout(g._hold);
            if (g._held) { g._held = false; return; }
            const r = btn.getBoundingClientRect();
            if (e.clientX > r.right - 12 && e.clientY > r.bottom - 12) { ed.openFlyout(g, btn); return; }
            ed.closeFlyout();
            ed.setTool(g.current);
        });
        btn.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); ed.openFlyout(g, btn); });
        btn.addEventListener("pointerdown", (e) => { if (e.button === 0) { g._held = false; g._hold = setTimeout(() => { g._held = true; ed.openFlyout(g, btn); }, 300); } });
        btn.addEventListener("pointerup", () => clearTimeout(g._hold));
        btn.addEventListener("pointerleave", () => clearTimeout(g._hold));
        g.btn = btn;
        ed.toolGroups.push(g);
        for (const it of items) ed.toolGroupOf[it.tool] = g;
        tools.appendChild(btn);
        ed.refreshGroupButton(g);
        return g;
    };

    tools.appendChild(el("div", "ipc-grp", "Select"));
    addGroup([
        { tool: "select", label: "Selection brush", key: "B", title: "Paint selection (B): adds to the selection, Alt subtracts" },
        { tool: "deselect", label: "Deselect brush", key: "D", title: "Erase from selection (D)" },
    ], [
        { icon: "loop", label: "Close loops", title: "Close loops: end a brush stroke where it started and the inside is filled too. Also for the subtract brush.", toggle: () => ed.fillEnclosed, onClick: () => { ed.fillEnclosed = !ed.fillEnclosed; ed.setStatus(ed.fillEnclosed ? "Close loops on: end a stroke where it started to fill the inside." : "Close loops off."); } },
    ]);
    addGroup([
        { tool: "rect", label: "Rectangle", key: "R", title: "Rectangle selection (R): replaces the selection, Shift adds, Alt subtracts, Ctrl keeps it square. Drag inside an existing selection to move its outline." },
        { tool: "ellipse", label: "Ellipse", key: "Shift+R", title: "Ellipse selection (Shift+R): replaces the selection, Shift adds, Alt subtracts, Ctrl keeps it a circle. Drag inside an existing selection to move its outline." },
        { tool: "lasso", label: "Lasso", key: "L", title: "Lasso selection (L): replaces the selection, Shift adds, Alt subtracts" },
        { tool: "polygon", label: "Polygon", key: "Shift+L", title: "Polygon selection (Shift+L): click point by point, click the first point, double-click or Enter to close, Backspace removes the last point, Esc cancels. Replaces the selection, Shift adds, Alt subtracts." },
    ]);
    addGroup([
        { tool: "object", label: "Object", key: "O", title: "Object selection (O): hover to see objects, click to select, click again to deselect. Shift adds, Alt subtracts." },
        { tool: "wand", label: "Magic wand", key: "W", title: "Magic wand (W): selects the area of similar colour under the cursor. Tolerance, contiguous and the sample source are in the bar above the canvas. Shift adds, Alt subtracts." },
    ]);
    ed.quickMaskBtn = iconButton("quickmask", "Quick mask (Q): while on, the paint and erase tools edit the selection (paint selects, erase deselects, the bucket works like the wand) and the selection is shown as a red tint.", () => ed.toggleQuickMask());
    tools.appendChild(ed.quickMaskBtn);
    tools.appendChild(el("div", "ipc-sep"));
    tools.appendChild(el("div", "ipc-grp", "Layer"));
    addTool("paint", "Paint on the active layer (P). On the base it creates a paint layer. Alt+click picks a colour, Shift+click draws a straight line.");
    addTool("erase", "Erase from the active layer (E)");
    addGroup([
        { tool: "smudge", label: "Smudge", key: "Shift+S", title: "Smudge (Shift+S): drag pixels along the stroke, like a finger in wet paint. Strength in the bar above the canvas; on the base it first makes a copy layer." },
        { tool: "clone", label: "Clone stamp", key: "S", title: "Clone stamp (S): Alt+click sets the source, then paint to copy from there onto the active layer. Aligned keeps the offset between strokes; Sample chooses the visible image or the layer." },
        { tool: "heal", label: "Healing brush", key: "J", title: "Healing brush (J): like the clone stamp, but the copied texture takes on the colour and brightness of where it lands." },
    ]);
    addGroup([
        { tool: "bucket", label: "Bucket fill", key: "G", title: "Bucket fill (G): fills the connected area of similar colour under the cursor on the active layer, limited to the selection. Tolerance, contiguous and the sample source are in the bar above the canvas." },
        { tool: "gradient", label: "Gradient", key: "Shift+G", title: "Gradient (Shift+G): drag on the active layer to draw a gradient from the colour to transparent, white or black (linear or radial, bar above the canvas), limited to the selection." },
    ], [
        { icon: "fill", label: "Fill selection", key: "Shift+F", title: "Fill the selection with the colour on the active layer (Shift+F)", onClick: () => ed.fillSelection() },
    ]);
    addTool("shape", "Shape (Y): draw a filled or outlined shape on the active layer, limited to the selection. "
        + "Rectangle and ellipse are dragged out (Shift keeps them square, Alt draws from the centre); polygon, polyline and Bezier are "
        + "clicked point by point (click the first point or press Enter to finish, Backspace takes one back, Esc cancels; on a Bezier "
        + "point, drag while clicking to curve the line); freehand follows the cursor. Kind, fill, outline and corner radius are in the "
        + "bar above the canvas.");
    addTool("eyedropper", "Eyedropper (I): click to pick the colour under the cursor from the visible image. Alt+click with the brush does the same.");
    addTool("transform", "Move / scale / rotate the active layer (T). Drag inside to move, corners scale (Shift: free aspect), edges scale one axis, drag just outside a corner to rotate (Shift snaps to 15°). Rotation is applied with Enter.");
    addTool("text", "Text (Shift+T): click on the canvas to add a text layer, click a text layer to select it, drag to move it, double-click to edit it on the canvas.");
    addTool("hand", "Pan (H, Space or middle mouse)");
    addTool("canvas", "Canvas size (C): drag the frame's edges or corners outward to extend the canvas (outpainting), inward to crop; applied when you release, Ctrl+Z takes it back. Snaps to 8 px, Alt for single pixels.");
    tools.appendChild(el("div", "ipc-sep"));
    tools.appendChild(iconButton("undo", "Undo (Ctrl+Z)", () => ed.undoStep()));
    tools.appendChild(iconButton("redo", "Redo (Ctrl+Shift+Z)", () => ed.redoStep()));
    tools.appendChild(el("div", "ipc-sep"));
    tools.appendChild(iconButton("flatten", "Flatten all visible layers into the base", () => ed.flatten()));
    body.appendChild(tools);
}

/** The canvas itself, its drop hint and the two bars above it. */
function buildView(ed, body) {
    ed.viewEl = el("div", "ipc-view");
    ed.canvas = document.createElement("canvas");
    ed.ctx = ed.canvas.getContext("2d");
    ed.viewEl.appendChild(ed.canvas);
    ed.dropHint = el("div", "ipc-drop", "Load an image, paste it (Ctrl+V) or drop it here.\nThen paint a selection and press Generate.\nOnce an image is loaded, dropped files become new layers (Shift: reference, Ctrl: replace the image).");
    ed.viewEl.appendChild(ed.dropHint);
    ed.buildSubbar();
    ed.buildOptsBar();
    body.appendChild(ed.viewEl);
}

/** The side panel with its two tabs. `section` adds a details block to the tab that is current; `toGenPane` makes that the Generate tab, as the method did at its half-way point. */
function buildSidePanel(ed) {
    // side panel
    const side = el("div", "ipc-side");
    // two tabs: Image (layers, selection, canvas, export) and Generate (prompt, settings, history, crop)
    const tabBar = el("div", "ipc-tabs");
    ed.panes = { image: el("div", "ipc-pane"), gen: el("div", "ipc-pane") };
    ed.tabButtons = {};
    for (const [id, label, title] of [["image", "Image", "Layers, selection, canvas, export"], ["gen", "Generate", "Prompt, generation settings, history, crop"]]) {
        const b = el("button", "ipc-tab", label);
        b.type = "button";
        b.title = title;
        b.addEventListener("click", (e) => { e.stopPropagation(); ed.showPane(id); });
        ed.tabButtons[id] = b;
        tabBar.appendChild(b);
    }
    side.appendChild(tabBar);
    side.appendChild(ed.panes.image);
    side.appendChild(ed.panes.gen);
    let pane = ed.panes.image;
    const section = (title, open, build) => {
        const d = document.createElement("details");
        d.open = open;
        const sum = el("summary", null, title);
        d.appendChild(sum);
        build(d, sum);
        pane.appendChild(d);
        return d;
    };
    ed.addSection = (title, open, build, paneId) => { const prev = pane; pane = ed.panes[paneId] || prev; try { return section(title, open, build); } finally { pane = prev; } };
    return { side, section, toGenPane: () => { pane = ed.panes.gen; } };
}

/** The layer list and the buttons above it. */
function buildLayers(ed) {
    const layersHead = el("h4", null, "Layers");
    layersHead.appendChild(el("span", "ipc-grow"));
    const fileInput = (onFiles) => {
        const inp = document.createElement("input");
        inp.type = "file"; inp.accept = "image/*"; inp.multiple = true; inp.style.display = "none";
        inp.addEventListener("change", () => { const files = Array.from(inp.files || []); inp.value = ""; if (files.length) onFiles(files); });
        layersHead.appendChild(inp);
        return inp;
    };
    ed.imageInput = fileInput((files) => ed.addImageLayers(files, "none", { place: "fit" }));
    ed.refInput = fileInput((files) => ed.addImageLayers(files, "reference"));
    ed.fontInput = fileInput((files) => ed.addFontFiles(files));
    ed.fontInput.accept = ".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2";
    layersHead.appendChild(miniButton("image", "Import images as layers (one layer per file, part of the image, fitted to the canvas). Dropping files on this list does the same.", () => ed.imageInput.click()));
    layersHead.appendChild(miniButton("fx", "Add a filter layer (film grain, sharpen, blur, levels, curves, brightness / contrast, hue / saturation, colour balance, black & white, invert, LUT, vignette). It filters everything below it; give it a mask to limit where it applies.", () => ed.addFilterLayer()));
    layersHead.appendChild(miniButton("plus", "Add a paint layer (Ctrl+Shift+N)", () => ed.addPaintLayer()));
    ed.panes.image.appendChild(layersHead);
    ed.layerList = el("div", "ipc-list");
    ed.layerList.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); ed.layerList.classList.add("ipc-dropping"); });
    ed.layerList.addEventListener("dragleave", () => ed.layerList.classList.remove("ipc-dropping"));
    ed.layerList.addEventListener("drop", (e) => {
        e.preventDefault(); e.stopPropagation();
        ed.layerList.classList.remove("ipc-dropping");
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f.type.startsWith("image/"));
        if (files.length) ed.addImageLayers(files, e.shiftKey ? "reference" : "none", e.shiftKey ? {} : { place: "fit" });
    });
    ed.panes.image.appendChild(ed.layerList);
}

/** The reference list: pictures that travel with the crop but are not part of the image. */
function buildReferences(ed) {
    // references: their own list, they are not part of the image
    const refHead = el("h4", null, "References");
    refHead.title = "Reference images travel with crop_image as extra batch images (Flux.2 / Kontext multi-reference). They are not part of the image. Hidden references are not sent.";
    ed.refCount = el("span", "ipc-refcount", "");
    refHead.appendChild(ed.refCount);
    refHead.appendChild(el("span", "ipc-grow"));
    ed.refFitSel = selectInput(REF_FITS, REF_DEFAULTS.fit, "How a reference is brought to the crop's size: pad scales it to fit and fills the rest with the image's border colour, crop scales to cover and cuts the middle, stretch distorts.");
    ed.refFitSel.classList.add("ipc-narrow");
    ed.refFitSel.addEventListener("change", () => { ed.refSettings.fit = ed.refFitSel.value; ed.notifyChanged(); });
    refHead.appendChild(ed.refFitSel);
    refHead.appendChild(miniButton("refImage", "Add reference images (one per file). Shift+drop on the canvas or a drop on this list does the same.", () => ed.refInput.click()));
    ed.panes.image.appendChild(refHead);
    ed.refList = el("div", "ipc-list ipc-reflist");
    ed.refList.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); ed.refList.classList.add("ipc-dropping"); });
    ed.refList.addEventListener("dragleave", () => ed.refList.classList.remove("ipc-dropping"));
    ed.refList.addEventListener("drop", (e) => {
        e.preventDefault(); e.stopPropagation();
        ed.refList.classList.remove("ipc-dropping");
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f.type.startsWith("image/"));
        if (files.length) ed.addImageLayers(files, "reference");
    });
    ed.panes.image.appendChild(ed.refList);
}

/** Selection: grow, feather, the stored selections, selection by text and the object tool. */
function buildSelection(ed, section) {
    section("Selection", true, (d) => {
        const sec = el("div", "ipc-sec");
        ed.growInput = numberInput(16, 1, 1024, "Pixels to grow or shrink by", 60);
        sec.appendChild(el("span", null, "by"));
        sec.appendChild(ed.growInput);
        sec.appendChild(el("span", null, "px"));
        const selRow = el("div", "ipc-sec");
        const clrSel = iconButton("clear", "Clear the selection (Ctrl+D)", () => ed.clearSelection(), "None");
        clrSel.classList.add("ipc-small");
        selRow.appendChild(clrSel);
        const inv = iconButton("invert", "Invert the selection (Ctrl+I)", () => ed.invertSelection(), "Invert");
        inv.classList.add("ipc-small");
        selRow.appendChild(inv);
        ed.antsBtn = iconButton("ants", "Selection display: marching ants outline (on) or red tint (off)", () => {
            ed.selectionDisplay = ed.selectionDisplay === "ants" ? "tint" : "ants";
            try { localStorage.setItem("ipc.selectionDisplay", ed.selectionDisplay); } catch (_) { /* ignore */ }
            ed.antsBtn.classList.toggle("ipc-toggle-on", ed.selectionDisplay === "ants");
            ed.draw();
            ed.setStatus(ed.selectionDisplay === "ants" ? "Selection shown as an outline." : "Selection shown as a red tint.");
        }, "Ants");
        ed.antsBtn.classList.add("ipc-small");
        ed.antsBtn.classList.toggle("ipc-toggle-on", ed.selectionDisplay === "ants");
        selRow.appendChild(ed.antsBtn);
        d.appendChild(selRow);
        const grow = iconButton("grow", "Grow the selection by n pixels", () => ed.growSelection(+ed.growInput.value), "Grow");
        grow.classList.add("ipc-small");
        sec.appendChild(grow);
        const shrink = iconButton("shrink", "Shrink the selection by n pixels", () => ed.growSelection(-ed.growInput.value), "Shrink");
        shrink.classList.add("ipc-small");
        sec.appendChild(shrink);
        const from = iconButton("fromLayer", "Replace the selection with the opaque area of the active layer", () => ed.selectionFromLayer(), "Layer");
        from.classList.add("ipc-small");
        selRow.appendChild(from);
        const clr = iconButton("erase", "Delete the selected pixels of the active layer (Del). Invert the selection first to keep only the selection.", () => ed.clearSelectedPixels(), "Delete px");
        clr.classList.add("ipc-small");
        selRow.appendChild(clr);
        ed.featherInput = numberInput(8, 1, 512, "Feather radius in pixels", 52);
        sec.appendChild(el("span", "ipc-gap", ""));
        sec.appendChild(ed.featherInput);
        const fe = iconButton("blur", "Feather: soften the selection's edge by the radius (a gaussian blur of the selection mask)", () => ed.featherSelection(+ed.featherInput.value), "Feather");
        fe.classList.add("ipc-small");
        sec.appendChild(fe);
        d.appendChild(sec);

        // saved selections (stored with the workflow)
        const sv = el("div", "ipc-sec");
        const save = iconButton("save", "Store the current selection with the workflow", () => ed.saveSelection(), "Save selection");
        save.classList.add("ipc-small");
        sv.appendChild(save);
        ed.selectionsSel = selectInput([], "", "Saved selections");
        ed.selectionsSel.classList.add("ipc-narrow");
        sv.appendChild(ed.selectionsSel);
        const load = iconButton("fromLayer", "Load the saved selection (replaces; Shift+click adds, Alt+click subtracts)", (e) => ed.loadSelection(ed.selectionsSel.selectedIndex, e && e.altKey ? "subtract" : (e && e.shiftKey ? "add" : "replace")), "Load");
        load.classList.add("ipc-small");
        sv.appendChild(load);
        sv.appendChild(miniButton("trash", "Delete the saved selection", () => ed.deleteSelection(ed.selectionsSel.selectedIndex), "ipc-del"));
        d.appendChild(sv);
        ed.renderSelectionList();

        // select by text
        const seg = el("div", "ipc-sec");
        const row = el("div", "ipc-seg");
        ed.segInput = document.createElement("input");
        ed.segInput.type = "text";
        ed.segInput.placeholder = "Select by text, e.g. shirt (empty: from the prompt)";
        ed.segInput.spellcheck = false;
        ed.segInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); ed.segmentByText(); } if (e.key === "Escape") { ed.segInput.blur(); ed.root.focus({ preventScroll: true }); } });
        row.appendChild(ed.segInput);
        ed.segBtn = iconButton("magic", "Run the segmentation model and turn the result into a selection (Enter in the field)", () => ed.segmentByText(), "Go");
        ed.segBtn.classList.add("ipc-small", "ipc-primary");
        row.appendChild(ed.segBtn);
        seg.appendChild(row);
        const modes = el("div", "ipc-modes");
        ed.segModeButtons = {};
        for (const [id, label, title] of [["replace", "Replace", "Replace the selection"], ["add", "Add", "Add to the selection"], ["subtract", "Subtract", "Remove from the selection"]]) {
            const b = el("button", "ipc-ib", label); b.type = "button"; b.title = title;
            b.addEventListener("click", (e) => { e.stopPropagation(); ed.segMode = id; for (const [k, x] of Object.entries(ed.segModeButtons)) x.classList.toggle("ipc-active", k === id); });
            ed.segModeButtons[id] = b;
            modes.appendChild(b);
        }
        ed.segMode = "replace";
        ed.segModeButtons.replace.classList.add("ipc-active");
        seg.appendChild(modes);
        const thrLab = el("label", null, "Threshold");
        ed.segThreshold = numberInput(0.3, 0.05, 0.95, "Detection threshold: lower finds more, higher is stricter", 56);
        ed.segThreshold.step = 0.05;
        thrLab.appendChild(ed.segThreshold);
        seg.appendChild(thrLab);
        const qualLab = el("label", null, "");
        ed.segQualityLab = qualLab;
        ed.segQuality = document.createElement("input");
        ed.segQuality.type = "checkbox";
        ed.segQuality.title = "HQ: use the large SAM model with GroundingDINO + SAM (slower, finer edges). Not used by SAM3.";
        qualLab.appendChild(ed.segQuality);
        qualLab.appendChild(el("span", null, "HQ"));
        seg.appendChild(qualLab);
        const srcLab = el("label", null, "Source");
        ed.segSourceSel = selectInput(["image", "active layer"], "image", "What the model sees: the flattened image, or only the active layer (the result is clipped to that layer)");
        ed.segSourceSel.addEventListener("change", () => { if (ed.tool === "object") ed.ensureObjects(); });
        srcLab.appendChild(ed.segSourceSel);
        seg.appendChild(srcLab);
        ed.segBackendSel = selectInput(["auto"], "auto", "Segmentation backend");
        ed.segBackendSel.addEventListener("change", () => ed.updateSegQuality());
        seg.appendChild(ed.segBackendSel);
        d.appendChild(seg);
    });
}

/** Canvas: size, extend, the frame and the local files. */
function buildCanvasPanel(ed, section) {
    section("Canvas", false, (d) => {
        const sec = el("div", "ipc-sec");
        const grid = el("div", "ipc-row4");
        ed.extendInputs = {};
        for (const [key, label] of [["top", "Top"], ["right", "Right"], ["bottom", "Bottom"], ["left", "Left"]]) {
            grid.appendChild(el("span", null, label));
            ed.extendInputs[key] = numberInput(0, -8192, 8192, `Pixels to add at the ${key} (negative: crop)`, 64);
            ed.extendInputs[key].addEventListener("input", () => ed.draw());
            grid.appendChild(ed.extendInputs[key]);
        }
        sec.appendChild(grid);
        const fillLab = el("label", null, "Border");
        ed.extendFillSel = selectInput(["stretch edges", "average color", "grey", "green", "black", "noise"], "average color",
            "What fills the new border before the model sees it: stretched edge pixels, the image's average colour, neutral grey, green (edit models), black, or random noise (latent models).");
        ed.extendFillSel.addEventListener("change", () => { ed.cropSettings.extendFill = ed.extendFillSel.value; ed.notifyChanged(); });
        fillLab.appendChild(ed.extendFillSel);
        sec.appendChild(fillLab);
        const ext = iconButton("extend", "Extend the canvas (outpainting) by the pixels above, negative values crop; the canvas tool (C) sets them by dragging the frame. A new border becomes the selection.", () => ed.applyCanvasFrame(), "Apply");
        ext.classList.add("ipc-small");
        sec.appendChild(ext);
        ed.canvasInfo = el("span", null, "");
        sec.appendChild(ed.canvasInfo);
        d.appendChild(sec);

        // resize the whole image
        const rs = el("div", "ipc-sec");
        rs.appendChild(el("span", null, "Resize"));
        ed.resizeW = numberInput(0, 8, 16384, "New width", 64);
        ed.resizeH = numberInput(0, 8, 16384, "New height", 64);
        ed.resizeLock = document.createElement("input");
        ed.resizeLock.type = "checkbox"; ed.resizeLock.checked = true; ed.resizeLock.title = "Keep the aspect ratio";
        ed.resizeW.addEventListener("input", () => { if (ed.resizeLock.checked && ed.width) ed.resizeH.value = Math.max(8, Math.round(+ed.resizeW.value * ed.height / ed.width)); });
        ed.resizeH.addEventListener("input", () => { if (ed.resizeLock.checked && ed.height) ed.resizeW.value = Math.max(8, Math.round(+ed.resizeH.value * ed.width / ed.height)); });
        rs.appendChild(ed.resizeW);
        rs.appendChild(el("span", null, "×"));
        rs.appendChild(ed.resizeH);
        const lockLab = el("label", null, ""); lockLab.appendChild(ed.resizeLock); lockLab.appendChild(el("span", null, "aspect")); rs.appendChild(lockLab);
        const rbtn = iconButton("resize", "Scale the image, all layers and the selection to the new size (undoable)", () => ed.resizeImage(+ed.resizeW.value, +ed.resizeH.value), "Resize");
        rbtn.classList.add("ipc-small");
        rs.appendChild(rbtn);
        d.appendChild(rs);

        // files
        const files = el("div", "ipc-sec");
        const clean = iconButton("broom", "Delete the node's own working files in input/output/temp inpaint_canvas that no workflow uses: not this or any open editor, not any saved workflow, not younger than two minutes. Images you loaded or saved keep their names and are never touched. Asks before deleting.", () => ed.cleanupFiles(), "Clean up files");
        clean.classList.add("ipc-small");
        files.appendChild(clean);
        ed.cleanupInfo = el("span", null, "");
        files.appendChild(ed.cleanupInfo);
        d.appendChild(files);
    });
}

/** Export: the file name, the format and what a save writes. */
function buildExport(ed, section) {
    section("Export", true, (d) => {
        const exp = el("div", "ipc-sec");
        exp.appendChild(el("span", null, "Save as"));
        ed.saveNameInput = document.createElement("input");
        ed.saveNameInput.type = "text";
        ed.saveNameInput.className = "ipc-num";
        ed.saveNameInput.style.width = "120px";
        ed.saveNameInput.value = "inpaint_canvas";
        ed.saveNameInput.title = "File name (a counter is added when it exists)";
        ed.saveNameInput.spellcheck = false;
        ed.saveNameInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") ed.exportImage(); });
        exp.appendChild(ed.saveNameInput);
        ed.saveFormatSel = selectInput(["png", "jpg", "webp", "psd", "ora"], "png", "PNG keeps the workflow inside the file (drop it onto ComfyUI to load it again), JPEG and WebP are smaller. PSD and ORA (OpenRaster, for GIMP and others) keep the layers: name, position, opacity, visibility, blend mode; filter layers are baked into the merged image only.");
        exp.appendChild(ed.saveFormatSel);
        const dl = iconButton("download", hostText("downloadTip", "Save the image to a file (Ctrl+S)"), () => ed.exportImage({ download: true }), hostText("downloadLabel", "Save as"));
        dl.classList.add("ipc-small");
        exp.appendChild(dl);
        const lay = iconButton("image", hostText("exportLayerTip", "Save the active layer alone as a PNG file with transparency"), () => ed.exportLayerPng(), "Layer");
        lay.classList.add("ipc-small");
        exp.appendChild(lay);
        const msk = iconButton("mask", hostText("exportMaskTip", "Save the selection as a black and white mask PNG file"), () => ed.exportMaskPng(), "Mask");
        msk.classList.add("ipc-small");
        exp.appendChild(msk);
        d.appendChild(exp);

    });
}

/** Prompt: the text fields, the templates and the upsampler. */
function buildPrompt(ed, section) {
    section("Prompt", true, (d) => {
        const wrap = el("div", "ipc-prompt");
        ed.promptInput = document.createElement("textarea");
        ed.promptInput.placeholder = "Describe what should appear in the selection. Available as the node's prompt output.";
        ed.promptInput.spellcheck = false;
        ed.promptInput.addEventListener("input", () => { ed.promptText = ed.promptInput.value; });
        ed.promptInput.addEventListener("change", () => ed.notifyChanged());
        ed.promptInput.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { ed.promptInput.blur(); ed.root.focus({ preventScroll: true }); }
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); ed.generate(); }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") { e.preventDefault(); ed.upsamplePrompt(); }
        });
        wrap.appendChild(ed.promptInput);
        ed.negativeInput = document.createElement("textarea");
        ed.negativeInput.placeholder = "Negative prompt (local mode, SDXL-class models). Available as the node's negative output.";
        ed.negativeInput.spellcheck = false;
        ed.negativeInput.rows = 2;
        ed.negativeInput.addEventListener("input", () => { ed.negativeText = ed.negativeInput.value; });
        ed.negativeInput.addEventListener("change", () => ed.notifyChanged());
        ed.negativeInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { ed.negativeInput.blur(); ed.root.focus({ preventScroll: true }); } });
        wrap.appendChild(ed.negativeInput);
        d.appendChild(wrap);

        // prompt upsampling
        const up = el("div", "ipc-sec ipc-upsample");
        const caseLab = el("label", null, "Use case");
        ed.upCaseSel = selectInput(UPSAMPLE_CASES, "auto", "What the rewritten prompt is for. auto = an editing instruction (Flux.2, Kontext, Klein), or outpaint when the selection touches the border. fill / add / remove write a description of the finished area for inpaint models.");
        ed.upCaseSel.addEventListener("change", () => { ed.upsampleSettings.useCase = ed.upCaseSel.value; ed.notifyChanged(); });
        caseLab.appendChild(ed.upCaseSel);
        up.appendChild(caseLab);
        ed.upBackendSel = selectInput(["auto"], "auto", "Language model used for upsampling");
        ed.upBackendSel.addEventListener("change", () => { ed.upsampleSettings.backend = ed.upBackendSel.value; ed.notifyChanged(); });
        up.appendChild(ed.upBackendSel);
        ed.upBtn = iconButton("magic", "Upsample (Ctrl+U): a vision-language model rewrites the prompt for the selected area and use case. Short requests work best; the small local model is most reliable with English.", () => ed.upsamplePrompt(), "Upsample");
        ed.upBtn.classList.add("ipc-small", "ipc-primary");
        up.appendChild(ed.upBtn);
        ed.upRevertBtn = iconButton("restore", "Put the previous prompt back", () => ed.revertPrompt(), "Revert");
        ed.upRevertBtn.classList.add("ipc-small");
        ed.upRevertBtn.disabled = true;
        up.appendChild(ed.upRevertBtn);
        d.appendChild(up);
    });
}

/** Generate: mode, seed, denoise, the provider's own rows and the helper models. */
function buildGenerate(ed, section) {
    section("Generate", true, (d) => {
        const sec = el("div", "ipc-sec ipc-gen");
        const denLab = el("label", null, "Denoise");
        denLab.title = "Denoise strength for a local sampler (denoise output). 1.0 repaints the selection completely, lower values keep more of what is there (refine).";
        ed.denoiseInput = document.createElement("input");
        ed.denoiseInput.type = "range";
        ed.denoiseInput.min = 0.05; ed.denoiseInput.max = 1; ed.denoiseInput.step = 0.05; ed.denoiseInput.value = 1;
        ed.denoiseInput.title = "Denoise strength, emitted on the node's denoise output";
        ed.denoiseInput.addEventListener("keydown", (e) => e.stopPropagation());
        ed.denoiseInput.addEventListener("click", (e) => e.stopPropagation());
        ed.denoiseVal = el("b", null, "1.00");
        ed.denoiseInput.addEventListener("input", () => {
            ed.genSettings.denoise = Math.min(1, Math.max(0.05, Math.round((+ed.denoiseInput.value || 1) * 100) / 100));
            ed.denoiseVal.textContent = ed.genSettings.denoise.toFixed(2);
            ed.renderInfo(); ed.draw();
        });
        ed.denoiseInput.addEventListener("change", () => ed.notifyChanged());
        denLab.appendChild(ed.denoiseInput);
        denLab.appendChild(ed.denoiseVal);
        sec.appendChild(denLab);
        const seedLab = el("label", null, "Seed");
        seedLab.title = "Seed emitted on the node's seed output";
        ed.seedInput = numberInput(0, 0, 4294967295, "Seed value", 96);
        ed.seedInput.addEventListener("change", () => { ed.genSettings.seed = Math.max(0, Math.floor(+ed.seedInput.value || 0)); ed.genSettings.seedRandom = false; ed.seedRandom.checked = false; ed.notifyChanged(); });
        seedLab.appendChild(ed.seedInput);
        sec.appendChild(seedLab);
        const rndLab = el("label", null, "");
        ed.seedRandom = document.createElement("input");
        ed.seedRandom.type = "checkbox";
        ed.seedRandom.checked = true;
        ed.seedRandom.title = "New random seed for every Generate";
        ed.seedRandom.addEventListener("change", () => { ed.genSettings.seedRandom = ed.seedRandom.checked; ed.notifyChanged(); });
        rndLab.appendChild(ed.seedRandom);
        rndLab.appendChild(el("span", null, "random"));
        sec.appendChild(rndLab);
        const dice = iconButton("dice", "Roll a new seed now", () => { ed.genSettings.seed = randomSeed(); ed.seedInput.value = ed.genSettings.seed; ed.notifyChanged(); });
        dice.classList.add("ipc-small");
        sec.appendChild(dice);
        const freeBtn = iconButton("broom", "Free the helper models (Qwen-VL, SAM3, SAM2, RMBG) from VRAM now. In local mode this happens by itself before a run whenever a helper was used; in API mode they stay loaded.", () => ed.freeHelperModels(), "Free VRAM");
        freeBtn.classList.add("ipc-small");
        sec.appendChild(freeBtn);
        ed.refineBtn = iconButton("refine", "Refine (local mode): re-run the selection at the denoise below without fill and without a feathered mask; the seam stays soft when stitching.", () => {
            ed.genSettings.refine = !ed.genSettings.refine;
            if (ed.genSettings.refine && ed.genSettings.denoise >= 1) { ed.genSettings.denoise = 0.5; ed.denoiseInput.value = 0.5; }
            ed.syncGenControls(); ed.renderInfo(); ed.notifyChanged();
            ed.setStatus(ed.genSettings.refine ? `Refine on: denoise ${ed.genSettings.denoise}, plain selection mask, no fill.` : "Refine off.");
        }, "Refine");
        ed.refineBtn.classList.add("ipc-small");
        sec.appendChild(ed.refineBtn);
        host.buildGenerateExtras(ed, sec);
        d.appendChild(sec);
    });
}

/** Settings: the recipe's own inputs (the panel is rendered by renderSettings). */
function buildSettings(ed, section) {
    section("Settings", true, (d) => {
        ed.settingsList = el("div", "ipc-sec ipc-settings");
        d.appendChild(ed.settingsList);
        ed.renderSettings();
    });
}

/** History: the runs of this document. */
function buildHistory(ed, section) {
    section("History", true, (d, sum) => {
        sum.appendChild(el("span", "ipc-grow"));
        const clr = miniButton("trash", "Clear the history list (layers and files stay)", () => ed.clearHistory(), "ipc-del");
        clr.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
        ed.compareBtn = miniButton("compare", "Compare two results side by side (the two newest, or Ctrl+click a thumbnail for A and Shift+click for B). Drag the divider; Esc or click again ends it.", () => ed.toggleCompare());
        ed.compareBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
        sum.appendChild(ed.compareBtn);
        sum.appendChild(clr);
        ed.historyList = el("div", "ipc-hist");
        d.appendChild(ed.historyList);
    });
}

/** Crop: what the node sends, and the numbers that describe it. */
function buildCrop(ed, section) {
    section("Crop", true, (d) => {
        const sec = el("div", "ipc-sec ipc-cropset");
        const onChange = () => {
            ed.cropSettings = {
                ...ed.cropSettings,
                context: ed.cropContextSel.value === "auto" ? "auto" : "manual",
                feather: ed.cropFeatherSel.value === "auto" ? "auto" : "manual",
                fill: ed.cropFillSel.value,
                colorMatch: ed.cropColorMatch.checked,
                withOriginal: ed.cropOriginal.checked,
                align: ed.cropAlign.checked,
                paste: ed.cropPasteSel.value === "whole crop" ? "crop" : "selection",
            };
            ed.renderInfo();
            ed.draw();
            ed.notifyChanged();
        };
        const row = (label, control, title) => {
            const l = el("label", null, label);
            if (title) l.title = title;
            l.appendChild(control);
            sec.appendChild(l);
        };
        ed.cropContextSel = selectInput(["auto", "manual"], "auto", "Context around the selection: auto sizes it from the selection (at least 512 px), manual uses the node's padding widget");
        ed.cropFeatherSel = selectInput(["auto", "manual"], "auto", "Mask edge: auto grows and feathers the mask from the selection size, manual blurs by the node's feather widget");
        ed.cropFillSel = selectInput(["none", "neutral", "blur", "border", "green"], "none", "How the selected area is filled in crop_image before the model sees it. Green is for edit models (\"fill the green area\").");
        ed.cropColorMatch = document.createElement("input");
        ed.cropColorMatch.type = "checkbox";
        ed.cropColorMatch.checked = true;
        ed.cropOriginal = document.createElement("input");
        ed.cropOriginal.type = "checkbox";
        ed.cropOriginal.checked = false;
        ed.cropAlign = document.createElement("input");
        ed.cropAlign.type = "checkbox";
        ed.cropAlign.checked = true;
        ed.cropAlign.addEventListener("change", onChange);
        ed.cropPasteSel = selectInput(["selection", "whole crop"], "selection", "What of the result is pasted back: only the selection (soft edge along the selection), or the whole returned rectangle with a soft border at its edge. Edit models re-render the crop as a whole; whole crop keeps their result intact and avoids doubled contours at the selection border.");
        ed.cropPasteSel.addEventListener("change", onChange);
        for (const c of [ed.cropContextSel, ed.cropFeatherSel, ed.cropFillSel]) c.addEventListener("change", onChange);
        ed.cropColorMatch.addEventListener("change", onChange);
        ed.cropOriginal.addEventListener("change", onChange);
        row("Context", ed.cropContextSel);
        row("Feather", ed.cropFeatherSel);
        row("Paste", ed.cropPasteSel, "Only the selection, or the whole returned rectangle");
        row("Fill", ed.cropFillSel);
        row("Original", ed.cropOriginal, "With a fill mode: crop_image becomes a batch of two, the filled crop first and the untouched crop second, so an edit model (Flux.2, Kontext) sees what is under the green area. The stitch uses the first result image. Not for VAE Encode chains.");
        row("Color match", ed.cropColorMatch, "Match the result's colors and brightness to the surroundings when it is stitched back");
        row("Align", ed.cropAlign, "Register the result to the unchanged surroundings before stitching (affine fit on the ring around the selection). Fixes doubled contours when the model shifted or slightly rescaled the content. Applied only when it measurably improves the match.");
        d.appendChild(sec);
        ed.infoEl = el("div", "ipc-info");
        d.appendChild(ed.infoEl);
    });
}
