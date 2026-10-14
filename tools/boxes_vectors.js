// Vectors for the node's Python writer of FLUX 3 box rows (docs/PLAN_NODE_BOXES.md §4 "Vectors"): every value here is
// computed by the app's own writer, electron/main/providers/boxes.js, so the node's boxes_rows.py is held to the app's
// words, rounding and JSON. Plain Node, no Electron:
//   node tools/boxes_vectors.js          writes tools/boxes_vectors.json
//   node tools/boxes_vectors.js --check  exits 1 when the file differs from a fresh run
// tools/boxes_test.js runs the check too; the node keeps a copy as tests/boxes_vectors.json (copy it again whenever this
// file or the writer changes).
//
// The shapes (fractions of the frame as the request carries them, the grid [top, left, bottom, right] 0..1000):
//   round     [x, Math.round(x)]                      JS rounding on non-negative doubles
//   grid      [rect, grid(rect)]
//   where     [g, whereWords(g)]
//   way       [a, b, wayWords(a, b)]
//   check     { boxes, error }                        checkBoxes; error null when the list passes
//   rows      { kind, frame, names, boxes, rows | error }   rowsFlux3; names maps a box's ref to its picture's name
//   caption   { prompt, boxes, rows, frame, out }     captionFlux3
//   apply     { kind, frame, names, prompt, boxes, out: { prompt, rows, notes } | error }   applyBoxes (flux3)
//   elements  { boxes, out }                          captionIdeogram4's elements of New and Text boxes on a new image
//                                                     (the shape of ComfyUI core's bounding-box elements)
// Characters outside ASCII are built with String.fromCharCode so this file stays ASCII.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PROV = path.join(ROOT, "electron", "main", "providers");
const boxes = require(path.join(PROV, "boxes.js"));
const flux3 = require(path.join(PROV, "flux3.js"));

const OUT = path.join(__dirname, "boxes_vectors.json");
const ch = (...codes) => String.fromCharCode(...codes);
const PNG = Buffer.alloc(64);

/** A request as index.js holds it when boxes.js runs (tools/boxes_test.js's req). */
function req(extra = {}) {
    return {
        provider: "bfl", model: "flux-3-image", kind: "edit", options: { schema: "flux3", boxes: "flux3", max_images: 10 },
        prompt: "make the door red", negative: "", image: PNG, references: [], original: 0, refName: "image {n}", boxes: [], ...extra,
    };
}
const box = (extra = {}) => ({ id: "edit_1", kind: "new", rect: [0.25, 0.25, 0.75, 0.75], src: null, ref: null, desc: "a red door", ...extra });
const errOf = (fn) => { try { fn(); return null; } catch (e) { return e && e.message || String(e); } };

/** The layouts a run can have: [kind, request, layout]. */
function layouts() {
    const r2 = req({ references: [PNG, PNG], original: 1 });   // the crop, the Original, one reference layer
    const r1 = req({ references: [PNG], original: 0 });         // the crop, one reference layer
    const r3 = req({ references: [PNG, PNG, PNG], original: 0 });
    const r0 = req({ references: [], original: 0 });            // the crop alone
    const rt = req({ kind: "text", image: null, references: [PNG], original: 0 });
    return {
        orig: [r2, flux3.layout(r2)], one: [r1, flux3.layout(r1)], three: [r3, flux3.layout(r3)], bare: [r0, flux3.layout(r0)],
        text: [rt, flux3.textLayout(rt)],
    };
}

/** A box's ref -> its picture's name, as main's pictureName finds it in the layout. */
function namesOf(lay, count) {
    const out = {};
    for (let i = 0; i < count; i++) { const n = errOf(() => boxes.pictureName(lay, i, "x")) ? null : boxes.pictureName(lay, i, "x"); if (n) out[String(i)] = n; }
    return out;
}

function build() {
    const V = {};
    const L = layouts();

    // ---- JS rounding ----------------------------------------------------------------------------------------------------
    V.round = [0, 0.49999999999999994, 0.5, 0.5000000000000001, 1.5, 2.5, 62.5, 187.5, 249.99999999999997, 250.5, 999.4999999999999, 999.5, 1000, 4503599627370495.5]
        .map((x) => [x, Math.round(x)]);

    // ---- the grid -------------------------------------------------------------------------------------------------------
    const rects = [
        [384 / 1920, 108 / 1080, 1536 / 1920, 972 / 1080], [0, 0, 1, 1], [0.0004, 0.9996, 0.0005, 1], [0.3, 0.3, 0.3002, 0.3003], [0.9998, 0.9999, 1, 1],
        [0.0005, 0.0125, 0.5005, 0.9995], [0.1235, 0.2505, 0.3335, 0.4445], [1 / 3, 1 / 7, 2 / 3, 6 / 7], [0.333333, 0.666666, 0.999999, 1],
        [0, 0, 0.0001, 0.0001], [0.9999, 0.9999, 1, 1], [0.4995, 0.4995, 0.5005, 0.5005],
    ];
    for (const x of [1, 3, 5, 999, 1001, 1999]) rects.push([x / 2000, x / 2000, Math.min(1, (x + 2) / 2000), Math.min(1, (x + 4) / 2000)]);
    for (const x of [64, 192, 320, 832]) rects.push([x / 1024, 0, (x + 128) / 1024, 1]);
    for (const x of [1, 77, 388, 389, 700]) rects.push([x / 777, (x + 3) / 777, Math.min(1, (x + 50) / 777), Math.min(1, (x + 51) / 777)]);
    for (const x of [1, 341, 683, 1365]) rects.push([x / 1366, x / 1366, Math.min(1, (x + 1) / 1366), 1]);
    V.grid = rects.map((r) => [r, boxes.grid(r)]);

    // ---- the place and the way in words ---------------------------------------------------------------------------------
    const grids = [];
    for (const t of [0, 150, 320, 340, 500, 660, 680, 900]) for (const l of [0, 150, 320, 340, 500, 660, 680, 900]) grids.push([t, l, Math.min(1000, t + 90), Math.min(1000, l + 90)]);
    grids.push([0, 0, 1000, 1000], [0, 0, 760, 760], [0, 0, 740, 1000], [300, 0, 366, 100], [300, 400, 367, 600], [0, 0, 1000, 600], [0, 0, 1000, 700], [333, 333, 334, 334], [0, 0, 750, 750], [0, 0, 749, 1000]);
    V.where = grids.map((g) => [g, boxes.whereWords(g)]);
    V.way = [];
    grids.forEach((a, i) => grids.forEach((b, j) => { if (i % 3 === 0 && j % 5 === 0) V.way.push([a, b, boxes.wayWords(a, b)]); }));
    V.way.push(
        [[0, 0, 500, 500], [500, 500, 1000, 1000], boxes.wayWords([0, 0, 500, 500], [500, 500, 1000, 1000])],
        [[400, 400, 600, 600], [400, 499, 600, 699], boxes.wayWords([400, 400, 600, 600], [400, 499, 600, 699])],
        [[400, 400, 600, 600], [400, 500, 600, 700], boxes.wayWords([400, 400, 600, 600], [400, 500, 600, 700])],
        [[400, 400, 600, 600], [350, 350, 650, 650], boxes.wayWords([400, 400, 600, 600], [350, 350, 650, 650])],
        [[300, 300, 700, 700], [400, 400, 600, 600], boxes.wayWords([300, 300, 700, 700], [400, 400, 600, 600])],
        [[0, 0, 100, 100], [0, 0, 100, 150], boxes.wayWords([0, 0, 100, 100], [0, 0, 100, 150])],
        [[0, 0, 150, 100], [0, 0, 100, 100], boxes.wayWords([0, 0, 150, 100], [0, 0, 100, 100])],
        [[0, 0, 0, 0], [0, 0, 0, 0], boxes.wayWords([0, 0, 0, 0], [0, 0, 0, 0])],
    );

    // ---- the shape check ------------------------------------------------------------------------------------------------
    const checks = [
        [], [box()], [box({ id: "Edit_1" })], [box({ id: "edit" })], [box(), box({ desc: "two" })], [box({ kind: "place" })],
        [box({ rect: [0.5, 0.2, 0.4, 0.8] })], [box({ rect: [0, 0, 1.2, 1] })], [box({ src: [0, 0, 1, 1] })], [box({ kind: "keep" })],
        [box({ kind: "from", src: [0, 0, 1, 1] })], [box({ ref: 0 })], [box({ desc: 5 })], [null], [box({ kind: "keep", src: [0, 0, 1, 1], text: "OPEN" })],
        [box({ text: 7 })], [box({ id: "ref_image_1" })], [box({ kind: "from", src: [0, 0, 1, 1], ref: -1 })], [box({ kind: "from", src: [0, 0, 1, 1], ref: 1.5 })],
        [box({ rect: [0, 0, 1] })], [box({ kind: "move", src: [0.2, 0.2, 0.1, 0.4] })], [box({ id: 7 })], [box({ kind: "remove", src: [0, 0, 0.5, 0.5], desc: null })],
        [box({ kind: "a very long kind name that goes on" })], [box({ text: "OPEN", desc: null })],
    ];
    V.check = checks.map((bs) => ({ boxes: bs, error: errOf(() => boxes.checkBoxes(bs)) }));

    // ---- the rows -------------------------------------------------------------------------------------------------------
    const ws = ch(0xfeff) + " a" + ch(0xa0) + "red" + ch(0x2028) + "\t door " + ch(0x3000);
    const ger = "Gr" + ch(0xf6) + ch(0xdf) + "e " + ch(0xc4) + "pfel " + ch(0x201e) + "frisch" + ch(0x201c);
    const emoji = ch(0xd83d, 0xde00);   // one astral character, two UTF-16 units
    const rowCases = [
        ["orig", [box()]],
        ["orig", [box({ id: "log_1", kind: "keep", src: [0.1, 0.2, 0.3, 0.4], rect: [0.1, 0.2, 0.3, 0.4] })]],
        ["orig", [box({ id: "sofa_1", kind: "move", src: [0.1, 0.2, 0.3, 0.4], rect: [0.6, 0.2, 0.8, 0.4] })]],
        ["orig", [box({ id: "cat_1", kind: "remove", src: [0.1, 0.2, 0.3, 0.4] })]],
        ["orig", [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 1, rect: [0.5, 0.5, 1, 1] })]],
        ["orig", [box({ id: "lamp_1", kind: "from", src: [0.1, 0.25, 0.6, 0.75], ref: 0 })]],
        ["one", [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 0 })]],
        ["three", [box({ id: "a_1", kind: "from", src: [0, 0, 0.5, 0.5], ref: 2 }), box({ id: "b_1", kind: "from", src: [0.5, 0.5, 1, 1], ref: 1 })]],
        ["orig", [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 2 })]],
        ["bare", [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 0 })]],
        ["orig", [box({ desc: "  a\nred \t door  " + "x".repeat(500) })]],
        ["orig", [box({ desc: ws })]],
        ["orig", [box({ desc: ch(0x1c) + "a" + ch(0x1d) + "b" + ch(0x85) + "c" })]],
        ["orig", [box({ desc: ger })]],
        ["orig", [box({ desc: emoji + "x".repeat(450) })]],
        ["orig", [box({ desc: "x".repeat(397) + emoji + "yz" })]],
        ["orig", [box({ desc: "quote \" back \\ slash / tab\tnul" + ch(1) + " del" + ch(0x7f) })]],
        ["orig", [box(), box({ id: "edit_2", rect: [0, 0, 0.5, 0.5] })]],
        ["orig", [box({ id: "sign_1", desc: "red neon", text: "OPEN" }), box({ id: "sale_1", desc: "", text: "SALE" }), box({ id: "nil_1", desc: null, text: "  A\nB " })]],
        ["orig", [box({ desc: null }), box({ id: "edit_2", desc: undefined })]],
        ["text", [box({ desc: "a lamp" })]],
        ["text", [box({ id: "sofa_1", kind: "move", src: [0, 0, 0.5, 0.5] })]],
        ["text", [box({ id: "it_1", kind: "keep", src: [0, 0, 0.5, 0.5] })]],
        ["text", [box({ id: "it_1", kind: "remove", src: [0, 0, 0.5, 0.5] })]],
        ["text", [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 0 })]],
        ["text", [box({ id: "sign_1", desc: "red neon", text: "  OPEN\nNOW " }), box({ id: "sign_2", desc: "", text: "SALE" })]],
        ["orig", [box({ id: "Bad_1" })]],
    ];
    V.rows = rowCases.map(([which, bs]) => {
        const [r, lay] = L[which];
        const rq = { ...r, boxes: bs };
        const out = { kind: r.kind, frame: boxes.frameName(lay), names: namesOf(lay, 4), boxes: bs };
        const e = errOf(() => boxes.rowsFlux3(rq, lay));
        if (e) out.error = e; else out.rows = boxes.rowsFlux3(rq, lay);
        return out;
    });

    // ---- the caption ----------------------------------------------------------------------------------------------------
    const long = Array.from({ length: 30 }, (_, i) => `word${i} of a long upsampled prompt`).join(", ");
    const four = [box({ id: "sofa_1", kind: "move", src: [0, 0, 0.5, 0.5] }), box({ id: "cat_1", kind: "remove", src: [0, 0, 0.5, 0.5] }), box({ id: "log_1", kind: "keep", src: [0, 0, 0.5, 0.5] })];
    const capCases = [
        ["make the door red", [box()]], ["the lamp", [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 1 })]], ["tidy up", four],
        ["put <edit_1> here, a red door", [box()]], ["In <ref_image_0> paint the wall", [box()]], ["", [box()]], ["A red door.", [box()]],
        ["remove the man", [box({ desc: "remove the man" })]], ["put image 3 here", [box({ kind: "from", src: [0, 0, 1, 1], ref: 1, desc: "put image 3 here" })]],
        [long, [box({ desc: long.slice(0, 400) })]], ["", [box({ desc: "A red scarf" })]], ["", [box({ desc: "Make the tiger pink." })]],
        ["", [box({ desc: "NASA logo" }), box({ id: "edit_2", desc: "" })]],
        ["", [box({ id: "lamp_1", kind: "move", src: [0.6, 0.6, 0.9, 0.9], rect: [0, 0, 0.6, 0.6], desc: "Move the lamp" })]],
        ["x", [box({ id: "lamp_1", kind: "move", src: [0.4, 0.4, 0.6, 0.6], rect: [0.45, 0.4, 0.65, 0.6], desc: "" }), box({ id: "cat_1", kind: "remove", src: [0.7, 0, 1, 0.3], desc: "erase the cat" }), box({ id: "log_1", kind: "keep", src: [0, 0, 0.5, 0.5], desc: "" })]],
        ["", [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 1, desc: "", rect: [0, 0.7, 0.3, 1] })]], ["Night!", [box()]], ["Really?", [box()]],
        ["x", [box({ desc: "make it pink" }), box({ id: "edit_2", desc: "" })]], ["In <ref_image_0> go", [box({ id: "cat_1", kind: "remove", src: [0, 0, 0.2, 0.2] })]],
        ["<edit_1> stays", [box()]], ["  spaced \n prompt  ", [box({ desc: "spaced prompt" })]], ["A cat", [box({ desc: "a cat" })]],
        ["Make it", [box({ desc: "Addition of a lamp" })]], ["", [box({ desc: "Adding a lamp" })]], ["", [box({ desc: "A" })]], ["", [box({ desc: "Ab" })]],
        ["", [box({ desc: "keep the vase" , kind: "keep", src: [0, 0, 0.3, 0.3] })]], ["", [box({ desc: "Remove the cat!", kind: "remove", src: [0, 0, 0.3, 0.3] })]],
        ["", [box({ desc: "delete the cat", kind: "remove", src: [0, 0, 0.3, 0.3] })]], ["", [box({ desc: "removed cat", kind: "remove", src: [0, 0, 0.3, 0.3] })]],
        ["", [box({ desc: ger })]], ["", [box({ desc: emoji + " smile" })]], ["", [box({ id: "sign_1", desc: "red neon", text: "OPEN" })]],
        ["", [box({ desc: "a dog ..." })]], ["a dog", [box({ desc: "A dog." })]], ["The red door", [box({ desc: "the red door" })]],
        ["x".repeat(395) + " more", [box({ desc: "x".repeat(395) })]], ["x".repeat(395), [box({ desc: "x".repeat(395) })]],
        ["paint " + "y".repeat(400), [box({ desc: ("paint " + "y".repeat(400)).slice(0, 400) })]],
        ["bring it", [box({ desc: "Bring the lamp" }), box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 1, desc: "Use the lamp" })]],
    ];
    V.caption = [];
    for (const [p, bs] of capCases) {
        for (const which of ["orig", "text"]) {
            const [r, lay] = L[which];
            if (which === "text" && bs.some((b) => b.kind !== "new")) continue;
            const rows = boxes.rowsFlux3({ ...r, boxes: bs }, lay);
            for (const frame of which === "text" ? [null] : ["ref_image_0", null]) V.caption.push({ prompt: p, boxes: bs, rows, frame, out: boxes.captionFlux3(p, bs, rows, frame) });
        }
    }
    // a box without a row (left out) gets no sentence
    {
        const bs = [box(), box({ id: "edit_2", desc: "a cat" })];
        const rows = boxes.rowsFlux3({ ...L.orig[0], boxes: [bs[0]] }, L.orig[1]);
        V.caption.push({ prompt: "x", boxes: bs, rows, frame: "ref_image_0", out: boxes.captionFlux3("x", bs, rows, "ref_image_0") });
        V.caption.push({ prompt: "x", boxes: bs, rows: [], frame: "ref_image_0", out: boxes.captionFlux3("x", bs, [], "ref_image_0") });
    }

    // ---- applyBoxes (FLUX 3) -------------------------------------------------------------------------------------------
    const applyCases = [
        ["orig", "make the door red", [box()]],
        ["orig", "", [box({ desc: "" }), box({ id: "keep_1", kind: "keep", src: [0, 0, 0.5, 0.5], desc: "" }), box({ id: "edit_2", desc: "" })]],
        ["orig", "", [box({ id: "only_1", desc: "" })]],
        ["orig", "tidy up", four],
        ["orig", "a red door", [box({ id: "red_door_1", desc: "a red door" })]],
        ["one", "the lamp goes here", [box({ id: "lamp_1", kind: "from", src: [0.2, 0.1, 0.8, 0.9], ref: 0, desc: "a brass lamp", rect: [0.6, 0.1, 0.95, 0.5] })]],
        ["orig", "line one\nline \"two\"", [box({ id: "sign_1", desc: "carved", text: "SAUNA" })]],
        ["orig", ger, [box({ desc: ger })]],
        ["orig", "x", [box({ id: "Bad_1" })]],
        ["orig", "x", [box({ id: "lamp_1", kind: "from", src: [0, 0, 1, 1], ref: 5 })]],
        ["text", "a lighthouse", [box(), box({ id: "sign_1", desc: "", text: "OPEN" })]],
        ["text", "a lighthouse", [box({ id: "it_1", kind: "keep", src: [0, 0, 0.5, 0.5] })]],
        ["bare", "", [box({ desc: "Make the tiger pink." }), box({ id: "edit_2", kind: "move", src: [0, 0, 0.3, 0.3], rect: [0.7, 0.7, 1, 1], desc: "the ball" })]],
        ["orig", long, [box({ desc: long.slice(0, 400) })]],
    ];
    V.apply = applyCases.map(([which, p, bs]) => {
        const [r, lay] = L[which];
        const rq = { ...r, prompt: p, boxes: bs };
        const out = { kind: r.kind, frame: boxes.frameName(lay), names: namesOf(lay, 4), prompt: p, boxes: bs };
        const e = errOf(() => boxes.applyBoxes(rq, lay));
        if (e) out.error = e;
        else { const a = boxes.applyBoxes(rq, lay); out.out = { prompt: a.prompt, rows: a.rows, notes: a.notes }; }
        return out;
    });

    // ---- the elements of ComfyUI core's shape (New and Text boxes) ------------------------------------------------------
    const elCases = [
        [box()], [box({ id: "sign_1", desc: "carved letters", text: "SAUNA" })], [box({ desc: "" }), box({ id: "sign_1", desc: null, text: " A\nB " })],
        [box({ desc: ws }), box({ id: "edit_2", rect: [0.0005, 0.5005, 0.9995, 1], desc: ger, text: emoji })],
        [box({ id: "a_1", rect: [0, 0, 1, 1] }), box({ id: "b_1", rect: [0.3, 0.3, 0.3002, 0.3003] })],
    ];
    V.elements = elCases.map((bs) => {
        const [r, lay] = L.text;
        const a = boxes.captionIdeogram4({ ...r, provider: "fal", options: { boxes: "ideogram4" }, prompt: "p", boxes: bs }, lay);
        return { boxes: bs, out: a.rows };
    });
    return V;
}

/** The file's text: each vector on a line of its own, so a diff shows which one moved. */
function text(V) {
    const parts = Object.keys(V).map((k) => `  ${JSON.stringify(k)}: [\n${V[k].map((v) => "    " + JSON.stringify(v)).join(",\n")}\n  ]`);
    return `{\n  "source": "electron/main/providers/boxes.js through tools/boxes_vectors.js",\n${parts.join(",\n")}\n}\n`;
}

module.exports = { build, text, OUT };

if (require.main === module) {
    const t = text(build());
    if (process.argv.includes("--check")) {
        const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
        if (have !== t) { console.log("FAIL: tools/boxes_vectors.json differs from a fresh run (node tools/boxes_vectors.js)"); process.exit(1); }
        console.log("ok: tools/boxes_vectors.json equals a fresh run");
    } else {
        fs.writeFileSync(OUT, t);
        const V = JSON.parse(t);
        console.log(`wrote ${path.relative(ROOT, OUT)}: ${Object.keys(V).filter((k) => k !== "source").map((k) => `${k} ${V[k].length}`).join(", ")}`);
    }
}
