// Boxes in the prompt (item 28 S1, docs/PLAN_BOXES.md §8), in plain Node, no Electron, no key and no network:
//   node tools/boxes_test.js
// electron/main/providers/boxes.js is the API under test on the main side: the 0 to 1000 grid (BFL's own example),
// the shape check, one FLUX 3 row per kind against the FLUX 3 layout (the Original shifting the reference slots as
// the markers do), the refusals, the instruction sentences, a text run's layout rows and applyBoxes' prompt.
// renderer/editor/boxes.js (an ES module, imported as tools/comfyrefs_test.js imports comfyrefs.js) on the renderer
// side: the frame, pixels to fractions with a crop that cuts the selection, the selection as a box, the small-box
// test. The request shapes follow docs.bfl.ai/flux_3 as read on 2026-10-01.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const PROV = path.join(ROOT, "electron", "main", "providers");
const boxes = require(path.join(PROV, "boxes.js"));
const flux3 = require(path.join(PROV, "flux3.js"));
const refs = require(path.join(PROV, "refs.js"));

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e && e.message || String(e); } };

const PNG = Buffer.alloc(64);
/** A request as index.js holds it when boxes.js runs: FLUX 3 options, references [Original?, refs..]. */
function req(extra = {}) {
    return {
        provider: "bfl", model: "flux-3-image", kind: "edit", options: { schema: "flux3", boxes: "flux3", max_images: 10 },
        prompt: "make the door red", negative: "", image: PNG, references: [], original: 0, refName: "image {n}", boxes: [], ...extra,
    };
}
const box = (extra = {}) => ({ id: "edit_1", kind: "new", rect: [0.25, 0.25, 0.75, 0.75], src: null, ref: null, desc: "a red door", ...extra });

(async () => {
    // ---- 1. the grid --------------------------------------------------------------------------------------------------
    console.log("--- 1. the 0 to 1000 grid ---");
    // BFL's helper: to_bbox(384, 108, 1536, 972, 1920, 1080) = [100, 200, 900, 800] ([top, left, bottom, right])
    check("BFL's example: a 384,108 to 1536,972 box in 1920 x 1080 is [100, 200, 900, 800]", eq(boxes.grid([384 / 1920, 108 / 1080, 1536 / 1920, 972 / 1080]), [100, 200, 900, 800]), short(boxes.grid([384 / 1920, 108 / 1080, 1536 / 1920, 972 / 1080])));
    check("the whole frame is [0, 0, 1000, 1000]", eq(boxes.grid([0, 0, 1, 1]), [0, 0, 1000, 1000]), "");
    check("rounding: 0.0004 is 0, 0.0005 is 1; a top that rounds to 1000 steps back to 999", eq(boxes.grid([0.0004, 0.9996, 0.0005, 1]), [999, 0, 1000, 1]), short(boxes.grid([0.0004, 0.9996, 0.0005, 1])));
    check("a box that rounds to nothing is widened to 1 cell (at the far edge, backwards)", eq(boxes.grid([0.3, 0.3, 0.3002, 0.3003]), [300, 300, 301, 301]) && eq(boxes.grid([0.9998, 0.9999, 1, 1]), [999, 999, 1000, 1000]), short([boxes.grid([0.3, 0.3, 0.3002, 0.3003]), boxes.grid([0.9998, 0.9999, 1, 1])]));
    check("the schema: options.boxes 'flux3' is known, 'ideogram4' not yet, nothing without it", boxes.schemaOf(req()) === "flux3" && boxes.schemaOf({ options: { boxes: "ideogram4" } }) === null && boxes.schemaOf({ options: { schema: "flux3" } }) === null && boxes.schemaOf({}) === null, "");

    // ---- 2. the shape check ---------------------------------------------------------------------------------------------
    console.log("\n--- 2. the shape check ---");
    check("null or [] is nothing, a well-formed list passes as it is", eq(boxes.checkBoxes(null), []) && eq(boxes.checkBoxes([]), []) && boxes.checkBoxes([box()]).length === 1, "");
    let e = throws(() => boxes.checkBoxes({}));
    check("not a list refuses", /not a list: nothing was sent/.test(e), e);
    e = throws(() => boxes.checkBoxes([box({ id: "Edit_1" })]));
    check("an id with a capital refuses, naming the box", /^Box Edit_1: the id is not/.test(e), e);
    e = throws(() => boxes.checkBoxes([box({ id: "edit" })]));
    check("an id without a number refuses", /^Box edit: the id/.test(e), e);
    e = throws(() => boxes.checkBoxes([box(), box({ desc: "two" })]));
    check("the same id twice refuses", /^Box edit_1: the id is used twice/.test(e), e);
    e = throws(() => boxes.checkBoxes([box({ kind: "place" })]));
    check("an unknown kind refuses", /kind "place" is not new, keep, move, remove or from/.test(e), e);
    e = throws(() => boxes.checkBoxes([box({ rect: [0.5, 0.2, 0.4, 0.8] })]));
    check("rect with l >= r refuses", /rect is not \[l, t, r, b\]/.test(e), e);
    e = throws(() => boxes.checkBoxes([box({ rect: [0, 0, 1.2, 1] })]));
    check("rect past 1 refuses", /rect is not/.test(e), e);
    e = throws(() => boxes.checkBoxes([box({ src: [0, 0, 1, 1] })]));
    check("a new box with a src refuses", /a new box has no src/.test(e), e);
    e = throws(() => boxes.checkBoxes([box({ kind: "keep" })]));
    check("a keep box without a src refuses", /src is not/.test(e), e);
    e = throws(() => boxes.checkBoxes([box({ kind: "from", src: [0, 0, 1, 1] })]));
    check("a from box without a ref refuses", /a from box needs ref/.test(e), e);
    e = throws(() => boxes.checkBoxes([box({ ref: 0 })]));
    check("a ref on a new box refuses", /only a from box has a ref/.test(e), e);
    e = throws(() => boxes.checkBoxes([box({ desc: 5 })]));
    check("a desc that is not a string refuses", /desc is not a string/.test(e), e);
    e = throws(() => boxes.checkBoxes([null]));
    check("a box that is not an object refuses by its place", /^Box #1: not an object/.test(e), e);

    // ---- 3. the rows of an edit ---------------------------------------------------------------------------------------
    console.log("\n--- 3. the rows of an edit ---");
    const r2 = req({ references: [PNG, PNG], original: 1 });   // the crop images[0], the Original images[1], @img1 images[2]
    const lay2 = flux3.layout(r2);
    check("the FLUX 3 layout: the crop is ref_image_0, the Original ref_image_1, the first reference layer ref_image_2", boxes.frameName(lay2) === "ref_image_0" && boxes.pictureName(lay2, 0, "x") === "ref_image_1" && boxes.pictureName(lay2, 1, "x") === "ref_image_2", "");
    let rows = boxes.rowsFlux3({ ...r2, boxes: [box()] }, lay2);
    check("new: from and src_bbox null, tgt_bbox the rect", eq(rows, [{ id: "edit_1", from: null, src_bbox: null, tgt_bbox: [250, 250, 750, 750], desc: "a red door" }]), short(rows));
    rows = boxes.rowsFlux3({ ...r2, boxes: [box({ id: "log_1", kind: "keep", src: [0.1, 0.2, 0.3, 0.4], rect: [0.1, 0.2, 0.3, 0.4] })] }, lay2);
    check("keep: from the frame, the same box twice", eq(rows, [{ id: "log_1", from: "ref_image_0", src_bbox: [200, 100, 400, 300], tgt_bbox: [200, 100, 400, 300], desc: "a red door" }]), short(rows));
    rows = boxes.rowsFlux3({ ...r2, boxes: [box({ id: "sofa_1", kind: "move", src: [0.1, 0.2, 0.3, 0.4], rect: [0.6, 0.2, 0.8, 0.4] })] }, lay2);
    check("move: from the frame, src_bbox where it is, tgt_bbox the new place", eq(rows, [{ id: "sofa_1", from: "ref_image_0", src_bbox: [200, 100, 400, 300], tgt_bbox: [200, 600, 400, 800], desc: "a red door" }]), short(rows));
    rows = boxes.rowsFlux3({ ...r2, boxes: [box({ id: "cat_1", kind: "remove", src: [0.1, 0.2, 0.3, 0.4] })] }, lay2);
    check("remove: from the frame, tgt_bbox null", eq(rows, [{ id: "cat_1", from: "ref_image_0", src_bbox: [200, 100, 400, 300], tgt_bbox: null, desc: "a red door" }]), short(rows));
    rows = boxes.rowsFlux3({ ...r2, boxes: [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 1, rect: [0.5, 0.5, 1, 1] })] }, lay2);
    check("from the first reference layer (ref 1, after the Original): from ref_image_2, src_bbox in that picture", eq(rows, [{ id: "lamp_1", from: "ref_image_2", src_bbox: [0, 0, 1000, 1000], tgt_bbox: [500, 500, 1000, 1000], desc: "a red door" }]), short(rows));
    rows = boxes.rowsFlux3({ ...r2, boxes: [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 0 })] }, lay2);
    check("from the Original (ref 0): from ref_image_1", rows[0].from === "ref_image_1", short(rows));
    const r1 = req({ references: [PNG], original: 0 });   // no Original: @img1 is images[1]
    rows = boxes.rowsFlux3({ ...r1, boxes: [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 0 })] }, flux3.layout(r1));
    check("without the Original the first reference layer (ref 0) is ref_image_1, as the markers shift", rows[0].from === "ref_image_1", short(rows));
    e = throws(() => boxes.rowsFlux3({ ...r2, boxes: [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 2 })] }, lay2));
    check("a from box past the pictures refuses (reference picture 3 of 2)", /^Box lamp_1 takes reference picture 3, which this run does not send/.test(e), e);
    const stripped = req({ references: [], original: 0 });   // checkPictures took the references out
    e = throws(() => boxes.rowsFlux3({ ...stripped, boxes: [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 0 })] }, flux3.layout(stripped)));
    check("a from box whose picture was stripped refuses", /which this run does not send/.test(e), e);
    rows = boxes.rowsFlux3({ ...r2, boxes: [box({ desc: "put {@ref:1} next to {@ref:0}" })] }, lay2);
    check("the desc's markers become the route's names (image 3, image 2), as in the prompt", rows[0].desc === "put image 3 next to image 2", short(rows[0].desc));
    e = throws(() => boxes.rowsFlux3({ ...r2, boxes: [box({ desc: "put {@ref:5} here" })] }, lay2));
    check("a desc naming a picture that is not sent refuses", /^Box edit_1 names reference picture 6, which this run does not send/.test(e), e);
    rows = boxes.rowsFlux3({ ...r2, boxes: [box({ desc: "  a\nred \t door  " + "x".repeat(500) })] }, lay2);
    check("the desc is folded to one line and cut at 400 characters", rows[0].desc.startsWith("a red door x") && !/\s{2}|\n/.test(rows[0].desc) && rows[0].desc.length === 400, rows[0].desc.length);
    rows = boxes.rowsFlux3({ ...r2, boxes: [box(), box({ id: "edit_2", rect: [0, 0, 0.5, 0.5] })] }, lay2);
    check("several boxes give several rows in order", rows.length === 2 && rows[0].id === "edit_1" && rows[1].id === "edit_2", short(rows.map((r) => r.id)));

    // ---- 4. a text run --------------------------------------------------------------------------------------------------
    console.log("\n--- 4. a text run (Generate new) ---");
    const rt = req({ kind: "text", image: null, references: [PNG], original: 0 });
    const layT = flux3.textLayout(rt);
    rows = boxes.rowsFlux3({ ...rt, boxes: [box({ desc: "a lamp like {@ref:0}" })] }, layT);
    check("a layout row: { id, bbox, desc }, no from, the reference ref_image_0 named 'image 1' in the desc", eq(rows, [{ id: "edit_1", bbox: [250, 250, 750, 750], desc: "a lamp like image 1" }]), short(rows));
    e = throws(() => boxes.rowsFlux3({ ...rt, boxes: [box({ id: "sofa_1", kind: "move", src: [0, 0, 0.5, 0.5] })] }, layT));
    check("a move box on a new image refuses (no source)", /^Box sofa_1 is a move box, and a new image has no source to keep or move/.test(e), e);
    check("the text layout has no frame", boxes.frameName(layT) === null, "");

    // ---- 5. the instruction ----------------------------------------------------------------------------------------------
    console.log("\n--- 5. the instruction sentences ---");
    const ins = (prompt, bs, lay) => boxes.instructionFlux3(prompt, bs, lay, boxes.rowsFlux3({ ...r2, kind: lay === layT ? "text" : "edit", boxes: bs }, lay));
    check("new: 'Add <edit_1> in its box.', opened with 'In <ref_image_0>,' since the prompt names no frame", ins("make the door red", [box()], lay2) === "make the door red In <ref_image_0>, add <edit_1> in its box.", short(ins("make the door red", [box()], lay2)));
    check("from: 'Place <lamp_1> from <ref_image_2> in its box.'", ins("the lamp", [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 1 })], lay2) === "the lamp In <ref_image_0>, place <lamp_1> from <ref_image_2> in its box.", short(ins("the lamp", [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 1 })], lay2)));
    const four = [box({ id: "sofa_1", kind: "move", src: [0, 0, 0.5, 0.5] }), box({ id: "cat_1", kind: "remove", src: [0, 0, 0.5, 0.5] }), box({ id: "log_1", kind: "keep", src: [0, 0, 0.5, 0.5] })];
    check("move, remove, keep sentences, the first opened with the frame", ins("tidy up", four, lay2) === "tidy up In <ref_image_0>, move <sofa_1> to its new box. Remove <cat_1>. Keep <log_1> unchanged.", short(ins("tidy up", four, lay2)));
    check("a box the prompt names by <id> gets no sentence", ins("put <edit_1> here, a red door", [box()], lay2) === "put <edit_1> here, a red door", short(ins("put <edit_1> here, a red door", [box()], lay2)));
    check("a prompt that names <ref_image_0> gets no 'In' opener", ins("In <ref_image_0> paint the wall", [box()], lay2) === "In <ref_image_0> paint the wall Add <edit_1> in its box.", short(ins("In <ref_image_0> paint the wall", [box()], lay2)));
    check("a text run gets no opener (no frame)", ins("a lighthouse", [box()], layT) === "a lighthouse Add <edit_1> in its box.", short(ins("a lighthouse", [box()], layT)));
    check("an empty prompt is the sentences alone", ins("", [box()], lay2) === "In <ref_image_0>, add <edit_1> in its box.", short(ins("", [box()], lay2)));

    // ---- 6. applyBoxes ---------------------------------------------------------------------------------------------------
    console.log("\n--- 6. applyBoxes ---");
    let a = boxes.applyBoxes({ ...r2, boxes: [box()] }, lay2);
    check("the prompt: the instruction, a space, the JSON rows; one row; no notes", a.prompt === 'make the door red In <ref_image_0>, add <edit_1> in its box. [{"id":"edit_1","from":null,"src_bbox":null,"tgt_bbox":[250,250,750,750],"desc":"a red door"}]' && a.rows.length === 1 && eq(a.notes, []), short(a.prompt));
    check("the rows parse back as JSON after the last space", eq(JSON.parse(a.prompt.slice(a.prompt.lastIndexOf(" [") + 1)), a.rows), "");
    e = throws(() => boxes.applyBoxes({ ...r2, options: { schema: "flux3" }, boxes: [box()] }, lay2));
    check("a variant without options.boxes refuses here (index.js never calls it then)", /^Boxes: no row format for "null"/.test(e), e);
    e = throws(() => boxes.applyBoxes({ ...r2, boxes: [box({ id: "bad id" })] }, lay2));
    check("the shape check runs first", /^Box bad id: the id is not/.test(e), e);
    a = boxes.applyBoxes({ ...r2, prompt: "image 3 goes {@ref:1}", boxes: [box({ kind: "from", src: [0, 0, 1, 1], ref: 1, desc: "{@ref:1}" })] }, lay2);
    check("a marker left in the prompt stays (index.js resolved it before): the rows' desc is resolved", a.prompt.startsWith("image 3 goes {@ref:1} In <ref_image_0>, place <edit_1> from <ref_image_2> in its box. ") && a.rows[0].desc === "image 3", short(a.prompt));

    // ---- 7. the renderer's module --------------------------------------------------------------------------------------
    console.log("\n--- 7. renderer/editor/boxes.js ---");
    const R = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "boxes.js")).href);
    const frame = R.frameOf({ bbox: [100, 50, 800, 600], emitted: [1024, 880] });
    check("frameOf: planCrop's bbox [x, y, w, h] as { x, y, w, h }", eq(frame, { x: 100, y: 50, w: 800, h: 600 }), short(frame));
    check("toFrame: pixels inside the crop as fractions", eq(R.toFrame([300, 200, 500, 350], frame), [0.25, 0.25, 0.5, 0.5]), short(R.toFrame([300, 200, 500, 350], frame)));
    check("toFrame: a crop that cuts the selection clamps it to the frame", eq(R.toFrame([0, 0, 500, 350], frame), [0, 0, 0.5, 0.5]) && eq(R.toFrame([500, 350, 2000, 2000], frame), [0.5, 0.5, 1, 1]), short(R.toFrame([0, 0, 500, 350], frame)));
    check("toFrame: a rectangle outside the crop is null, a 1/1000-thin one too", R.toFrame([0, 0, 100, 50], frame) === null && R.toFrame([900, 700, 1000, 800], frame) === null && R.toFrame([300, 200, 300.4, 350], frame) === null, "");
    check("toFrame: a bad rectangle or frame is null", R.toFrame(null, frame) === null && R.toFrame([1, 2, 3], frame) === null && R.toFrame([0, 0, 1, 1], { x: 0, y: 0, w: 0, h: 0 }) === null && R.toFrame([NaN, 0, 1, 1], frame) === null, "");
    const sb = R.selectionBox([300, 200, 500, 350], frame, { prompt: "a red\ndoor" });
    check("selectionBox: the bounds as editor.selectionBounds gives them (x1, y1 exclusive), kind new, the folded prompt as desc", eq(sb, { id: "edit_1", kind: "new", rect: [0.25, 0.25, 0.5, 0.5], src: null, ref: null, desc: "a red door" }), short(sb));
    const fb = R.selectionBox([300, 200, 500, 350], frame, { prompt: "put {@ref:1} here", pair: { label: "img1", id: "L3", ref: 1 } });
    check("selectionBox with a pair: kind from, the reference's index, the whole picture as src, the markers kept in the desc", eq(fb, { id: "edit_1", kind: "from", rect: [0.25, 0.25, 0.5, 0.5], src: [0, 0, 1, 1], ref: 1, desc: "put {@ref:1} here" }), short(fb));
    check("selectionBox with a pair that has no picture (ref -1) is a new box", R.selectionBox([300, 200, 500, 350], frame, { prompt: "x", pair: { label: "img1", id: "L3", ref: -1 } }).kind === "new", "");
    check("selectionBox: no selection or a selection outside the crop is null", R.selectionBox(null, frame, { prompt: "x" }) === null && R.selectionBox([0, 0, 50, 20], frame, { prompt: "x" }) === null, "");
    check("the whole crop selected is [0, 0, 1, 1]", eq(R.selectionBox([100, 50, 900, 650], frame, { prompt: "x" }).rect, [0, 0, 1, 1]), "");
    check("smallBox: under 48 px a side at the emitted size", R.smallBox([0, 0, 0.04, 0.5], [1024, 880]) === true && R.smallBox([0, 0, 0.5, 0.05], [1024, 880]) === true && R.smallBox([0, 0, 0.05, 0.06], [1024, 880]) === false && R.SMALL_PX === 48, "");
    check("the id pattern and the desc limit are the same on both sides", R.BOX_ID.source === boxes.BOX_ID.source && R.DESC_MAX === boxes.DESC_MAX, "");
    check("every box the renderer makes passes main's shape check", boxes.checkBoxes([sb]).length === 1 && boxes.checkBoxes([fb]).length === 1, "");
    check("the two resolvers agree on the desc: main names the renderer's marker", boxes.rowsFlux3({ ...r2, boxes: [fb] }, lay2)[0].desc === "put image 3 here", "");
    check("refs.js's resolver on the same desc gives the same name", refs.resolveMarkers(fb.desc, lay2.pictures, "image {n}").text === "put image 3 here", "");

    // ---- 9. a plugin's boxes (S2, docs/PLAN_BOXES.md §9): image pixels and layer ids into the request's shape ---------
    // the frame is the crop of §8 (100, 50, 800 x 600); the reference "Cat" (layer L3, picture index 1) sits at 500, 350, 200 x 100
    const pctx = { mode: "edit", schema: "flux3", frame, selection: null, references: [{ index: 1, layerId: "L3", name: "Cat", frame: { x: 500, y: 350, w: 200, h: 100 } }] };
    let pb = R.pluginBoxes([{ id: "cat_1", kind: "new", rect: [300, 200, 500, 350], desc: "a\n  cat" }], pctx);
    check("pluginBoxes: a new box in image pixels becomes fractions of the frame, the desc folded", eq(pb, { boxes: [{ id: "cat_1", kind: "new", rect: [0.25, 0.25, 0.5, 0.5], src: null, ref: null, desc: "a cat" }], notes: [] }), short(pb));
    pb = R.pluginBoxes([{ id: "cat_1", kind: "move", rect: [300, 200, 500, 350], src: [100, 50, 300, 200] }], pctx);
    check("pluginBoxes: a move box's src is mapped into the frame too, a missing desc is empty", pb.boxes[0].kind === "move" && eq(pb.boxes[0].src, [0, 0, 0.25, 0.25]) && pb.boxes[0].desc === "", short(pb));
    pb = R.pluginBoxes([{ id: "cat_1", kind: "from", rect: [300, 200, 500, 350], layer: "L3" }], pctx);
    check("pluginBoxes: a from box names a layer; the core writes the picture's index and the whole picture as src", eq(pb.boxes[0], { id: "cat_1", kind: "from", rect: [0.25, 0.25, 0.5, 0.5], src: [0, 0, 1, 1], ref: 1, desc: "" }), short(pb));
    pb = R.pluginBoxes([{ id: "cat_1", kind: "from", rect: [300, 200, 500, 350], layer: "L3", src: [500, 350, 600, 400] }], pctx);
    check("pluginBoxes: a from box's src in image pixels is measured in the layer's own frame", eq(pb.boxes[0].src, [0, 0, 0.5, 0.5]), short(pb));
    pb = R.pluginBoxes([{ id: "cat_1", kind: "new", rect: [0, 0, 50, 20] }, { id: "dog_1", kind: "new", rect: [300, 200, 500, 350] }, { id: "ox_1", kind: "keep", rect: [300, 200, 500, 350], src: [0, 0, 50, 20] }], pctx);
    check("pluginBoxes: a box (or a source) outside the frame is dropped with a note naming it, the others go", pb.boxes.length === 1 && pb.boxes[0].id === "dog_1" && pb.notes.length === 2 && /^Box cat_1 lies outside the crop/.test(pb.notes[0]) && /^Box ox_1: its source lies outside the crop/.test(pb.notes[1]), short(pb));
    pb = R.pluginBoxes([{ id: "edit_1", kind: "new", rect: [300, 200, 500, 350] }, { id: "edit_1", kind: "new", rect: [300, 200, 500, 350] }], pctx, { taken: [sb] });
    check("pluginBoxes: a duplicate id gets the next free number, across sources (the S1 box holds edit_1)", eq(pb.boxes.map((b) => b.id), ["edit_2", "edit_3"]), short(pb.boxes.map((b) => b.id)));
    let code = null, msg = null;
    try { R.pluginBoxes([{ id: "cat_1", kind: "from", rect: [300, 200, 500, 350], layer: "L9" }], pctx, { nameOf: (id) => `the layer "Dog" (${id})` }); } catch (e) { code = e.code; msg = e.message; }
    check("pluginBoxes: a from box whose layer this run does not send refuses with the layer's name (code layer)", code === "layer" && /^Box cat_1: the layer "Dog" \(L9\) is not a reference picture of this run: nothing was sent\.$/.test(msg), msg);
    code = null;
    try { R.pluginBoxes([{ id: "Cat", kind: "new", rect: [300, 200, 500, 350] }], pctx); } catch (e) { code = e.code; msg = e.message; }
    check("pluginBoxes: a bad id is a shape error (the plugin's bug, reported and skipped by the core)", code === "shape" && /^Box Cat: the id/.test(msg), msg);
    check("pluginBoxes: a bad kind, a bad rect, a src on a new box, a from box without a layer, a keep box without a src",
        /kind "x"/.test(throws(() => R.pluginBoxes([{ id: "a_1", kind: "x", rect: [0, 0, 1, 1] }], pctx)))
        && /rect is not/.test(throws(() => R.pluginBoxes([{ id: "a_1", kind: "new", rect: [5, 0, 1, 1] }], pctx)))
        && /no src/.test(throws(() => R.pluginBoxes([{ id: "a_1", kind: "new", rect: [300, 200, 500, 350], src: [0, 0, 1, 1] }], pctx)))
        && /needs layer/.test(throws(() => R.pluginBoxes([{ id: "a_1", kind: "from", rect: [300, 200, 500, 350] }], pctx)))
        && /src is not/.test(throws(() => R.pluginBoxes([{ id: "a_1", kind: "keep", rect: [300, 200, 500, 350] }], pctx))), "");
    check("pluginBoxes: null or [] is no box, a non-list is a shape error", eq(R.pluginBoxes(null, pctx), { boxes: [], notes: [] }) && eq(R.pluginBoxes([], pctx).boxes, []) && /list/.test(throws(() => R.pluginBoxes({}, pctx))), "");
    check("pluginBoxes: on a new image the note says image, not crop", /outside the image/.test(R.pluginBoxes([{ id: "a_1", kind: "new", rect: [0, 0, 50, 20] }], { ...pctx, mode: "new" }).notes[0]), "");
    const pall = R.pluginBoxes([
        { id: "cat_1", kind: "from", rect: [300, 200, 500, 350], layer: "L3" }, { id: "dog_1", kind: "new", rect: [300, 200, 500, 350], desc: "a dog" },
        { id: "ox_1", kind: "move", rect: [300, 200, 500, 350], src: [100, 50, 300, 200] }, { id: "ox_2", kind: "remove", rect: [300, 200, 500, 350], src: [100, 50, 300, 200] },
    ], pctx).boxes;
    check("every plugin box passes main's shape check and makes a FLUX 3 row (the from box naming the reference's slot)",
        boxes.checkBoxes(pall).length === 4 && boxes.rowsFlux3({ ...r2, boxes: pall }, lay2).length === 4 && typeof boxes.rowsFlux3({ ...r2, boxes: pall }, lay2)[0].from === "string", short(boxes.rowsFlux3({ ...r2, boxes: pall }, lay2)));
    check("the kinds are the same set on both sides", eq([...R.KINDS].sort(), [...boxes.KINDS].sort()), "");
    // a desc may name a reference layer as {@layer:id} (S3a: the Boxes plugin writes an @img token that way): it becomes
    // the {@ref:i} marker main resolves; a layer this run does not send refuses like a from box
    pb = R.pluginBoxes([{ id: "cat_1", kind: "new", rect: [300, 200, 500, 350], desc: "put {@layer:L3} on the sofa" }], pctx);
    check("pluginBoxes: {@layer:L3} in a desc becomes {@ref:1}, the layer's picture index", pb.boxes[0].desc === "put {@ref:1} on the sofa", short(pb.boxes[0]));
    check("main then names it: image 3 (the crop, the Original, then the reference)", boxes.rowsFlux3({ ...r2, boxes: pb.boxes }, lay2)[0].desc === "put image 3 on the sofa", "");
    code = null;
    try { R.pluginBoxes([{ id: "cat_1", kind: "new", rect: [300, 200, 500, 350], desc: "put {@layer:L9} here" }], pctx, { nameOf: (id) => `the layer "Dog" (${id})` }); } catch (e) { code = e.code; msg = e.message; }
    check("pluginBoxes: {@layer:} of a layer this run does not send refuses with the layer's name (code layer)", code === "layer" && /^Box cat_1 names the layer "Dog" \(L9\), which is not a reference picture of this run: nothing was sent\.$/.test(msg), msg);
    check("LAYER_MARK is exported and matches only the braces form", R.LAYER_MARK instanceof RegExp && "x {@layer:L12} y @img1".replace(R.LAYER_MARK, "<$1>") === "x <L12> y @img1", "");

    // ---- 10. the Boxes plugin's clipboard formatter (plugins/boxes/format.js) against main's rows -------------------
    // the same boxes in image pixels, main's rows through the renderer's mapping (as a run does it) and the plugin's rows
    // straight from pixels: the grid, the kinds and the instruction agree
    console.log("\n--- 10. plugins/boxes/format.js (Copy rows) ---");
    const F = await import(pathToFileURL(path.join(ROOT, "plugins", "boxes", "format.js")).href);
    const docFrame = { x: 0, y: 0, w: 1920, h: 1080 };
    check("format.grid: BFL's example from pixels", eq(F.grid([384, 108, 1536, 972], docFrame), [100, 200, 900, 800]), short(F.grid([384, 108, 1536, 972], docFrame)));
    check("format.grid equals main's grid of the renderer's fractions on a crop", eq(F.grid([300, 200, 500, 350], frame), boxes.grid(R.toFrame([300, 200, 500, 350], frame))) && eq(F.grid([0, 0, 500, 350], frame), boxes.grid(R.toFrame([0, 0, 500, 350], frame))), "");
    check("format.grid: a thin box is at least 1 apart, the far edge clamped", eq(F.grid([1919.8, 1079.8, 1920, 1080], docFrame), [999, 999, 1000, 1000]), short(F.grid([1919.8, 1079.8, 1920, 1080], docFrame)));
    const pxBoxes = [
        { id: "dog_1", kind: "new", rect: [100, 100, 400, 300], src: null, layer: null, desc: "a dog", text: null },
        { id: "log_1", kind: "keep", rect: [800, 600, 1000, 700], src: [800, 600, 1000, 700], layer: null, desc: "a log", text: null },
        { id: "ox_1", kind: "move", rect: [1200, 200, 1500, 500], src: [200, 500, 500, 800], layer: null, desc: "an ox", text: null },
        { id: "cat_1", kind: "remove", rect: [600, 100, 700, 200], src: [600, 100, 700, 200], layer: null, desc: "a cat", text: null },
        { id: "lamp_1", kind: "from", rect: [1500, 700, 1800, 1000], src: null, layer: "L3", desc: "the lamp", text: null },
        { id: "far_1", kind: "new", rect: [3000, 3000, 3200, 3100], src: null, layer: null, desc: "outside", text: null },
    ];
    const nameOf = (id) => (id === "L3" ? "ref_image_2" : null);
    const fr = F.rowsFlux3(pxBoxes, docFrame, { nameOf });
    const viaCore = R.pluginBoxes(pxBoxes.map((b) => ({ ...b, src: b.kind === "new" ? undefined : b.src, layer: b.kind === "from" ? b.layer : undefined })), { mode: "edit", schema: "flux3", frame: docFrame, references: [{ index: 1, layerId: "L3", name: "Lamp", frame: { x: 0, y: 0, w: 1920, h: 1080 } }] });
    const mainRows = boxes.rowsFlux3({ ...r2, boxes: viaCore.boxes }, lay2);
    check("format.rowsFlux3: five rows, the box outside the picture noted and left out (as the core does)", fr.rows.length === 5 && fr.notes.length === 1 && /far_1 lies outside/.test(fr.notes[0]) && viaCore.boxes.length === 5 && /far_1 lies outside/.test(viaCore.notes[0]), short(fr.notes));
    check("format.rowsFlux3: the rows equal main's rows for the same boxes", eq(fr.rows, mainRows), short(fr.rows) + " vs " + short(mainRows));
    const ft = F.rowsText(pxBoxes, docFrame);
    check("format.rowsText: new boxes only ({ id, bbox, desc }), the others noted", ft.rows.length === 1 && eq(ft.rows[0], { id: "dog_1", bbox: [93, 52, 278, 208], desc: "a dog" }) && ft.notes.length === 5, short(ft));
    check("format.rowsText equals main's text rows", eq(ft.rows, boxes.rowsFlux3({ ...req({ kind: "text" }), boxes: viaCore.boxes.filter((b) => b.kind === "new") }, flux3.layout(req({ kind: "text" }))).map((r) => r)), "");
    const fi = F.instructionFlux3("make it night", pxBoxes, fr.rows);
    const mi = boxes.instructionFlux3("make it night", viaCore.boxes, lay2, mainRows);
    check("format.instructionFlux3 equals main's instruction (one sentence per box, In <ref_image_0> first)", fi === mi && fi.startsWith("make it night In <ref_image_0>, add <dog_1> in its box. Keep <log_1> unchanged."), short(fi));
    const ct = F.clipboardText("make it night", pxBoxes, docFrame, { nameOf });
    check("format.clipboardText: the instruction, a space and the JSON rows, as a run sends it", ct.text === `${mi} ${JSON.stringify(mainRows)}` && ct.rows.length === 5, short(ct.text));
    check("format.clipboardText on a new image: rowsText and no In <ref_image_0>", /^make it night Add <dog_1> in its box\. \[\{"id":"dog_1","bbox"/.test(F.clipboardText("make it night", pxBoxes, docFrame, { mode: "new" }).text), short(F.clipboardText("make it night", pxBoxes, docFrame, { mode: "new" }).text));
    check("format.rowsFlux3: a from box whose layer is not shown is noted, a part of the layer measured in the layer's frame",
        F.rowsFlux3([pxBoxes[4]], docFrame, { nameOf: () => null }).notes.length === 1
        && eq(F.rowsFlux3([{ ...pxBoxes[4], src: [500, 350, 600, 400], layerFrame: { x: 500, y: 350, w: 200, h: 100 } }], docFrame, { nameOf }).rows[0].src_bbox, [0, 0, 500, 500]), "");

    // ---- 11. the Boxes tool's frame (S3c): stitch.js planFrame against the run's planCrop on a real mask --------------
    // planFrame plans from the editor's cached bounds, the run from the selection's mask: the same crop either way
    console.log("\n--- 11. stitch.js planFrame (the crop frame the Boxes tool draws) ---");
    const S = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "stitch.js")).href);
    const recipeLimits = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", "flux3.json"), "utf8")).limits;
    const W = 1600, H = 1000;
    const maskOf = (b) => {
        const data = new Float32Array(W * H);
        for (let y = b[1]; y < b[3]; y++) data.fill(1, y * W + b[0], y * W + b[2]);
        return { data, w: W, h: H, ox: 0, oy: 0, fullW: W, fullH: H };
    };
    const fakeEditor = (b, crop) => ({ width: W, height: H, getBounds: () => b, genSettings: { mode: "api", denoise: 1 }, cropSettings: { context: "auto", feather: "auto", fill: "none", paste: "selection", ...crop }, base: null });
    const settingsOf = (ed, params, limits) => ({ width: ed.width, height: ed.height, gen: { ...ed.genSettings }, crop: { ...ed.cropSettings }, params: { ...params }, limits: limits ? { ...limits } : null, base: null });
    const cases = [
        ["FLUX 3 limits, auto context, a wide selection", [300, 400, 900, 520], {}, { padding: 0, target_size: 0, feather: 0, multiple_of: 16 }, { ...recipeLimits, mode: "max" }],
        ["FLUX 3 limits, a selection at the corner", [0, 0, 120, 90], {}, { padding: 0, target_size: 0, feather: 0, multiple_of: 16 }, { ...recipeLimits, mode: "max" }],
        ["manual context 40 px, no limits (a local recipe), paste crop", [500, 300, 760, 610], { context: "manual", paste: "crop" }, { padding: 40, target_size: 0, feather: 8, multiple_of: 64 }, null],
        ["manual context, target size 1024, FLUX 3 limits", [1200, 100, 1590, 990], { context: "manual" }, { padding: 64, target_size: 1024, feather: 8, multiple_of: 16 }, { ...recipeLimits, mode: "crop" }],
    ];
    for (const [what, b, crop, params, limits] of cases) {
        const ed = fakeEditor(b, crop);
        const f = S.planFrame(ed, params, limits);
        const p = S.planCrop(settingsOf(ed, params, limits), maskOf(b));
        const want = { x: p.x0, y: p.y0, w: p.cw, h: p.ch, emitted: [p.ew, p.eh], paste: p.info.paste, aspect: p.info.aspect };
        check(`planFrame equals planCrop on the mask: ${what}`, eq(f, want), short(f) + " vs " + short(want));
    }
    check("planFrame: no selection is null", S.planFrame(fakeEditor(null, {}), {}, null) === null, "");
    // a marquee at fractional coordinates: getBounds() holds the drag box floored and ceiled, a pixel wider than the
    // alpha >= 128 box the run reads; planFrame scans it exact (the review's case: the wider box tips 1:1 to 5:4)
    {
        const W2 = 4000, H2 = 3000, exact = [1001, 801, 1404, 1101], loose = [1000, 800, 1405, 1102];
        const data = new Float32Array(W2 * H2);
        for (let y = exact[1]; y < exact[3]; y++) data.fill(1, y * W2 + exact[0], y * W2 + exact[2]);
        let scans = 0;
        const ed2 = { width: W2, height: H2, getBounds: () => loose, scanBoundsIn: (b) => { scans++; return b === loose ? exact : null; }, selectionSeq: 7, genSettings: { mode: "api", denoise: 1 }, cropSettings: { context: "auto", feather: "auto", fill: "none", paste: "selection" }, base: null };
        const params = { padding: 0, target_size: 0, feather: 0, multiple_of: 16 }, limits = { ...recipeLimits, mode: "max" };
        const f = S.planFrame(ed2, params, limits);
        const p = S.planCrop(settingsOf(ed2, params, limits), { data, w: W2, h: H2, ox: 0, oy: 0, fullW: W2, fullH: H2 });
        const wide = S.planCrop(settingsOf(ed2, params, limits), { bounds: loose, fullW: W2, fullH: H2 });
        check("planFrame scans a loose getBounds() box exact: the run's crop, not the wider box's", eq([f.x, f.y, f.w, f.h, f.aspect], [p.x0, p.y0, p.cw, p.ch, p.info.aspect]) && p.info.aspect !== wide.info.aspect, short([f, p.info.bbox, p.info.aspect, wide.info.aspect]));
        S.planFrame(ed2, params, limits);
        const once = scans === 1;
        ed2.selectionSeq++;
        S.planFrame(ed2, params, limits);
        check("planFrame scans once per selection change", once && scans === 2, String(scans));
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
