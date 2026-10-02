// Boxes in the prompt (item 28 S1, docs/PLAN_BOXES.md §8), in plain Node, no Electron, no key and no network:
//   node tools/boxes_test.js
// electron/main/providers/boxes.js is the API under test on the main side: the 0 to 1000 grid (BFL's own example),
// the shape check, one FLUX 3 row per kind against the FLUX 3 layout (the Original shifting the reference slots as
// the markers do), the refusals, the instruction sentences, a text run's layout rows and applyBoxes' prompt.
// renderer/editor/boxes.js (an ES module, imported as tools/comfyrefs_test.js imports comfyrefs.js) on the renderer
// side: the frame, pixels to fractions with a crop that cuts the selection, the selection as a box, the small-box
// test. The request shapes follow docs.bfl.ai/flux_3 as read on 2026-10-01.
"use strict";

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
    const sb = R.selectionBox([300, 200, 499, 349], frame, { prompt: "a red\ndoor" });
    check("selectionBox: inclusive bounds (+1 on the far sides), kind new, the folded prompt as desc", eq(sb, { id: "edit_1", kind: "new", rect: [0.25, 0.25, 0.5, 0.5], src: null, ref: null, desc: "a red door" }), short(sb));
    const fb = R.selectionBox([300, 200, 499, 349], frame, { prompt: "put {@ref:1} here", pair: { label: "img1", id: "L3", ref: 1 } });
    check("selectionBox with a pair: kind from, the reference's index, the whole picture as src, the markers kept in the desc", eq(fb, { id: "edit_1", kind: "from", rect: [0.25, 0.25, 0.5, 0.5], src: [0, 0, 1, 1], ref: 1, desc: "put {@ref:1} here" }), short(fb));
    check("selectionBox with a pair that has no picture (ref -1) is a new box", R.selectionBox([300, 200, 499, 349], frame, { prompt: "x", pair: { label: "img1", id: "L3", ref: -1 } }).kind === "new", "");
    check("selectionBox: no selection or a selection outside the crop is null", R.selectionBox(null, frame, { prompt: "x" }) === null && R.selectionBox([0, 0, 50, 20], frame, { prompt: "x" }) === null, "");
    check("the whole crop selected is [0, 0, 1, 1]", eq(R.selectionBox([100, 50, 899, 649], frame, { prompt: "x" }).rect, [0, 0, 1, 1]), "");
    check("smallBox: under 48 px a side at the emitted size", R.smallBox([0, 0, 0.04, 0.5], [1024, 880]) === true && R.smallBox([0, 0, 0.5, 0.05], [1024, 880]) === true && R.smallBox([0, 0, 0.05, 0.06], [1024, 880]) === false && R.SMALL_PX === 48, "");
    check("the id pattern and the desc limit are the same on both sides", R.BOX_ID.source === boxes.BOX_ID.source && R.DESC_MAX === boxes.DESC_MAX, "");
    check("every box the renderer makes passes main's shape check", boxes.checkBoxes([sb]).length === 1 && boxes.checkBoxes([fb]).length === 1, "");
    check("the two resolvers agree on the desc: main names the renderer's marker", boxes.rowsFlux3({ ...r2, boxes: [fb] }, lay2)[0].desc === "put image 3 here", "");
    check("refs.js's resolver on the same desc gives the same name", refs.resolveMarkers(fb.desc, lay2.pictures, "image {n}").text === "put image 3 here", "");

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
