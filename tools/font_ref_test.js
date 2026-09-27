// Which file a text layer's font is loaded from (renderer/editor/inpaint_text.js `ensureFont`), in plain Node, no
// Electron:
//   node tools/font_ref_test.js
// The editor's `./host.js` is swapped for a stand-in (a module hook, Node 22.15+), and FontFace / document.fonts /
// fetch are stand-ins that record what was asked. The case of docs/BUGS.md (the .scumble review): an open imported a
// document's "MyFont.ttf" as "MyFont (1).ttf" because the mirror held other bytes under that name; the layer keeps the
// family "MyFont" and its fontRef names the renamed file, and the search by family found the local file first. Now the
// layer's own file comes first, every file is drawn under a name of its own (two files of one family in one session
// both draw as themselves), a file that does not load falls back to the family, and a text without a fontRef, a
// bundled family and an unknown one behave as before.
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const nodeModule = require("node:module");

let failures = 0;
function check(what, ok, detail) {
    if (!ok) failures++;
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

if (typeof nodeModule.registerHooks !== "function") {
    console.log(`[FAIL] this test needs module.registerHooks (Node 22.15 or later); this is ${process.version}`);
    process.exit(1);
}

// ---- stand-ins -------------------------------------------------------------------------------

const HOST = "export const api = { apiURL: (p) => globalThis.__fontTest.apiURL(p), fetchApi: (p) => globalThis.__fontTest.fetchApi(p) };";
nodeModule.registerHooks({
    resolve(specifier, context, next) {
        if (specifier === "./host.js" && context.parentURL && context.parentURL.endsWith("/renderer/editor/inpaint_text.js")) {
            return { url: "data:text/javascript," + encodeURIComponent(HOST), shortCircuit: true };
        }
        return next(specifier, context);
    },
});

const ref = (filename) => ({ filename, subfolder: "inpaint_canvas/fonts", type: "input" });
const made = [];      // every FontFace constructed: { family, src, weight }
const added = [];     // every face added to document.fonts
globalThis.__fontTest = {
    apiURL: (p) => "http://comfy" + p,
    // the user's fonts: MyFont.ttf (the local one) and a Roboto of their own
    fetchApi: async () => ({ status: 200, json: async () => [ref("MyFont.ttf"), ref("Roboto.ttf")] }),
};
globalThis.fetch = async () => ({ json: async () => [{ family: "Roboto", file: "Roboto[wdth,wght].ttf", category: "sans", variable: true }] });
globalThis.FontFace = class {
    constructor(family, src, desc) { this.family = family; this.src = src; this.weight = desc && desc.weight; made.push(this); }
    async load() { if (/missing/.test(this.src)) throw new Error("404"); return this; }
};
globalThis.document = { fonts: { add: (f) => added.push(f) } };

// the file a name was registered from, by the query's filename
const fileOf = (name) => { const f = made.find((x) => x.family === name); return f ? decodeURIComponent(/filename=([^&"]*)/.exec(f.src)[1].replace(/\+/g, " ")) : null; };

async function main() {
    const T = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "inpaint_text.js")).href);
    const list = await T.loadFontList();
    check("the stand-ins give a bundled Roboto and two user fonts", list.map((f) => f.family + (f.ref ? ":" + f.ref.filename : "")).join() === "Roboto,MyFont:MyFont.ttf,Roboto:Roboto.ttf", JSON.stringify(list));

    // the imported document's layer: family MyFont, its file renamed on open (and not in the user list, which is not re-read)
    const imported = await T.ensureFont("MyFont", ref("MyFont (1).ttf"));
    check("a layer's own file wins over the family's local file", fileOf(imported) === "MyFont (1).ttf", `${imported} from ${fileOf(imported)}`);
    const local = await T.ensureFont("MyFont", ref("MyFont.ttf"));
    check("the local file's layer gets the local file", fileOf(local) === "MyFont.ttf", `${local} from ${fileOf(local)}`);
    check("the two files draw under names of their own, not the family", imported && local && imported !== local && imported !== "MyFont" && local !== "MyFont", `${imported} / ${local}`);

    const n = made.length;
    const again = await T.ensureFont("MyFont", ref("MyFont (1).ttf"));
    check("the same file again is loaded once", again === imported && made.length === n, `${again}, ${made.length - n} new faces`);
    const byFamily = await T.ensureFont("MyFont", null);
    check("a text without a fontRef finds the family's user font (the same face)", byFamily === local && made.length === n, `${byFamily}, ${made.length - n} new faces`);

    const warn = console.warn, warned = [];
    console.warn = (...a) => warned.push(a.map(String).join(" "));
    let fell;
    try { fell = await T.ensureFont("MyFont", ref("missing.ttf")); } finally { console.warn = warn; }
    check("a file that does not load falls back to the family, with a warning", fell === local && warned.length === 1 && /missing\.ttf/.test(warned[0]), `${fell} from ${fileOf(fell)}; ${warned.join(" | ")}`);

    const bundled = await T.ensureFont("Roboto", null);
    const face = made.find((f) => f.family === "Roboto");
    check("a bundled family without a fontRef is the bundled font, under its family name", bundled === "Roboto" && face && /Roboto%5Bwdth|Roboto\[wdth/.test(face.src) && face.weight === "100 900", `${bundled} ${face && face.src}`);
    const own = await T.ensureFont("Roboto", ref("Roboto.ttf"));
    check("a user file of a bundled family's name is drawn from the file the layer names", fileOf(own) === "Roboto.ttf" && own !== "Roboto", `${own} from ${fileOf(own)}`);

    check("an unknown family without a file is null (the caller falls back)", (await T.ensureFont("NoSuchFont", null)) === null);
    check("no family is null", (await T.ensureFont("", ref("MyFont.ttf"))) === null);
    check("every face that loaded went into document.fonts once", new Set(added).size === added.length && added.every((f) => !/missing/.test(f.src)), `${added.length} added`);

    // an upload that overwrites a file of the same name drops its stale face
    T.addUserFont(ref("MyFont (1).ttf"));
    const reloaded = await T.ensureFont("MyFont", ref("MyFont (1).ttf"));
    check("a re-uploaded file is loaded again, under a new name", reloaded && reloaded !== imported && fileOf(reloaded) === "MyFont (1).ttf", `${imported} -> ${reloaded}`);

    console.log(failures ? `\n${failures} FAILED` : "\nall ok");
    process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
