// The @img tokens of renderer/editor/reftokens.js (docs/PLAN_REFS.md C1 / C2) in plain Node, no Electron:
//   node tools/reftokens_test.js
// The grammar against tools/refs_cases.json, the file main's electron/main/providers/refs.js is tested on too (and
// main's TOKEN is checked to be the same source), the label maps, the remap through every change that renumbers the
// references, markers for a send (fed on into main's resolveMarkers once), names for a route without pictures, the
// check of a rewrite against its request, and a caret carried through a change.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${!ok && detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => JSON.stringify(v instanceof Map ? [...v] : v);
/** check that `got` equals `want` (JSON), saying both when not */
const same = (what, got, want) => check(what, eq(got, want), `got ${show(got)}, want ${show(want)}`);

async function section(name, fn) {
    try { await fn(); } catch (err) { check(name + " ran to its end", false, String(err && err.stack || err).split(/\r?\n/).slice(0, 3).join(" ")); }
}

const labels = (...ids) => new Map(ids.map((id, i) => [id, i + 1]));
const tokensOf = (T, text) => T.parse(text).filter((s) => s.type === "token").map((s) => (s.n != null ? { text: s.text, n: s.n } : { text: s.text, id: s.id }));

async function main() {
    const T = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "reftokens.js")).href);
    const cases = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs_cases.json"), "utf8"));
    const refs = require(path.join(ROOT, "electron", "main", "providers", "refs.js"));

    await section("0. exports", async () => {
        same("the module exports exactly C1's names", Object.keys(T).sort(),
            ["TOKEN", "checkNote", "clean", "compare", "diffRange", "hasTokens", "labelMap", "mapOffset", "namesFor", "normalize", "parse", "referenceName", "referencesRule", "referencesText", "remap", "sameLabels", "toMarkers"]);
        check("TOKEN is a source string", typeof T.TOKEN === "string");
        check("main's TOKEN is the same grammar, without flags", refs.TOKEN.source === T.TOKEN && refs.TOKEN.flags === "", `${refs.TOKEN.source} /${refs.TOKEN.flags}`);
    });

    await section("1. grammar (refs_cases.json)", async () => {
        check("refs_cases.json has grammar cases", Array.isArray(cases.grammar) && cases.grammar.length >= 30, String(cases.grammar && cases.grammar.length));
        for (const c of cases.grammar) {
            const label = JSON.stringify(c.text);
            same(`parse ${label}`, tokensOf(T, c.text), c.tokens);
            check(`hasTokens ${label} is ${c.tokens.length > 0}`, T.hasTokens(c.text) === c.tokens.length > 0);
            const segs = T.parse(c.text);
            check(`parse ${label} gives the text back`, segs.map((s) => s.text).join("") === c.text);
            check(`parse ${label} merges plain text`, segs.every((s, i) => !(i && s.type === "text" && segs[i - 1].type === "text")) && segs.every((s) => s.text.length > 0));
            const found = [...c.text.matchAll(new RegExp(refs.TOKEN.source, "g"))].map((m) => m[0]);
            same(`main's TOKEN finds the same in ${label}`, found, c.tokens.map((t) => t.text));
        }
        same("parse of an empty text", T.parse(""), []);
        same("parse of null", T.parse(null), []);
        same("parse keeps text around a token", T.parse("a @img1, b"), [{ type: "text", text: "a " }, { type: "token", text: "@img1", n: 1 }, { type: "text", text: ", b" }]);
        // a regex shared across calls with /g would alternate true / false here
        check("hasTokens answers the same on every call", [1, 2, 3, 4].every(() => T.hasTokens("from @img1")));
        check("parse answers the same on every call", eq(T.parse("@img1 @img2"), T.parse("@img1 @img2")) && tokensOf(T, "@img1 @img2").length === 2);
        check("hasTokens of a text without @", T.hasTokens("image 2") === false && T.hasTokens(null) === false);
    });

    await section("2. boundaries", async () => {
        const table = [
            ["@image2", []],
            ["@img12", [{ text: "@img12", n: 12 }]],
            ["@img0", []],
            ["@img1234", []],
            ["x@img1", []],
            ["@img1,", [{ text: "@img1", n: 1 }]],
            ["@IMG1 @Img2", [{ text: "@IMG1", n: 1 }, { text: "@Img2", n: 2 }]],
            ["@img?Labc", [{ text: "@img?Labc", id: "Labc" }]],
            ["@IMG?Labc", [{ text: "@IMG?Labc", id: "Labc" }]],
            ["@img?labc", []],
            ["@img?LAbc", []],
            ["@img1-2", []],
            ["email@img1", []],
        ];
        for (const [text, want] of table) same(`boundary ${JSON.stringify(text)}`, tokensOf(T, text), want);
    });

    await section("3. normalize", async () => {
        same("the prefix only", T.normalize("@IMG2 and @Img?Labc, @iMg?LAbc, x@IMG1"), "@img2 and @img?Labc, @iMg?LAbc, x@IMG1");
        same("a normalised text stays", T.normalize("from @img2 and @img?Lk3"), "from @img2 and @img?Lk3");
        same("a text without @", T.normalize("plain words"), "plain words");
        check("anything but a string comes back as it is", T.normalize(null) === null && T.normalize(undefined) === undefined && T.normalize(5) === 5);
    });

    await section("4. labelMap and sameLabels", async () => {
        same("top first, from 1", [...T.labelMap([{ id: "La" }, { id: "Lb" }, { id: "Lc" }])], [["La", 1], ["Lb", 2], ["Lc", 3]]);
        check("no layers, no labels", T.labelMap([]).size === 0 && T.labelMap(null).size === 0);
        const m = labels("La", "Lb");
        check("a copy is the same", T.sameLabels(m, new Map(m)));
        check("the same pairs in another order are the same", T.sameLabels(m, new Map([["Lb", 2], ["La", 1]])));
        check("a swap is not the same", !T.sameLabels(m, labels("Lb", "La")));
        check("one more is not the same", !T.sameLabels(m, labels("La", "Lb", "Lc")));
        check("null and empty are the same", T.sameLabels(null, new Map()) && T.sameLabels(null, null));
        check("null and a label are not", !T.sameLabels(null, m) && !T.sameLabels(m, null));
    });

    await section("5. remap", async () => {
        const ab = labels("La", "Lb"), abc = labels("La", "Lb", "Lc");
        const text = "jacket from @img2, style of @img1";
        same("swap img1 and img2 in one pass", T.remap(text, ab, labels("Lb", "La")), "jacket from @img1, style of @img2");
        same("a swap with a token twice", T.remap("@img1 @img2 @img1", ab, labels("Lb", "La")), "@img2 @img1 @img2");
        // hide the top one: the other moves up, the hidden one's tokens park with its id
        const hidden = T.remap(text, ab, labels("Lb"));
        same("hide parks the hidden layer's tokens", hidden, "jacket from @img1, style of @img?La");
        same("show brings the text back", T.remap(hidden, labels("Lb"), ab), text);
        // delete the middle one, then undo
        const all = "a @img1 b @img2 c @img3";
        const deleted = T.remap(all, abc, labels("La", "Lc"));
        same("delete parks and renumbers", deleted, "a @img1 b @img?Lb c @img2");
        same("undo of the delete brings the text back", T.remap(deleted, labels("La", "Lc"), abc), all);
        // two deletes, undone one by one
        const one = T.remap(all, abc, labels("Lb", "Lc"));
        const two = T.remap(one, labels("Lb", "Lc"), labels("Lb"));
        same("the first of two deletes", one, "a @img?La b @img1 c @img2");
        same("the second of two deletes", two, "a @img?La b @img1 c @img?Lc");
        const back = T.remap(T.remap(two, labels("Lb"), labels("Lb", "Lc")), labels("Lb", "Lc"), abc);
        same("two undos bring the text back", back, all);
        // merge: La (img1) merged down into Lb (img2); the absorbed id takes the survivor's label
        const merged = new Map([...labels("Lb", "Lc"), ["La", 1]]);
        same("merge: the absorbed layer's tokens take the survivor's label", T.remap("@img1 and @img2 and @img3", abc, merged), "@img1 and @img1 and @img2");
        // merged into a hidden reference: the survivor has no label, so the absorbed id parks (an alias to nothing too)
        same("merge into a hidden reference parks the absorbed id", T.remap("@img1 and @img2", ab, new Map([["Lc", 1], ["La", undefined]])), "@img?La and @img?Lb");
        // duplicate / add: the new reference gets the next number, nothing moves
        check("add: the text is unchanged", T.remap(text, ab, abc) === text);
        same("add: a waiting @img3 binds to the new layer", T.remap("hat from @img3", ab, abc), "hat from @img3");
        same("add: then it follows that layer", T.remap("hat from @img3", abc, labels("Lc", "La", "Lb")), "hat from @img1");
        same("unknown numbers stay, normalised", T.remap("@img3 and @IMG4 over @img1", ab, labels("Lb", "La")), "@img3 and @img4 over @img2");
        same("a parked token unparks when its layer gets a label", T.remap("the @IMG?Lc hat", ab, abc), "the @img3 hat");
        same("a parked token without a label stays parked, normalised", T.remap("the @IMG?Ld hat", ab, abc), "the @img?Ld hat");
        same("an empty map (a new image) keeps the text as typed", T.remap("from @img1", null, new Map()), "from @img1");
        const rebuilt = "jacket from @img2, @img?Lz and @img7";
        check("a rebuild (the same map) rewrites nothing", T.remap(rebuilt, ab, new Map(ab)) === rebuilt);
        const plain = "no tokens in here";
        check("a text without @ comes back as it is", T.remap(plain, ab, labels("Lb", "La")) === plain);
        check("an empty text and null come back as they are", T.remap("", ab, ab) === "" && T.remap(null, ab, ab) === null);
    });

    await section("6. toMarkers", async () => {
        const ab = labels("La", "Lb");
        const text = "coat from @img1, hat from @img2";
        same("with the Original first", T.toMarkers(text, ab, [null, "La", "Lb"]), { text: "coat from {@ref:1}, hat from {@ref:2}", errors: [] });
        same("without the Original", T.toMarkers(text, ab, ["La", "Lb"]), { text: "coat from {@ref:0}, hat from {@ref:1}", errors: [] });
        same("the order sent, not the label", T.toMarkers(text, ab, [null, "Lb", "La"]).text, "coat from {@ref:2}, hat from {@ref:1}");
        same("an upper-case token", T.toMarkers("@IMG2", ab, ["La", "Lb"]).text, "{@ref:1}");
        same("sent null only validates", T.toMarkers("@IMG1 and @img2", ab, null), { text: "@IMG1 and @img2", errors: [] });
        same("a literal marker", T.toMarkers("put {@ref:0} here", ab, ["La"]).errors, [{ kind: "literal", token: "{@ref:" }]);
        same("a literal marker in any case", T.toMarkers("{@REF:1}", ab, null).errors, [{ kind: "literal", token: "{@ref:" }]);
        same("a parked token", T.toMarkers("from @img?Lz", ab, ["La", "Lb"]), { text: "from @img?Lz", errors: [{ kind: "parked", token: "@img?Lz", id: "Lz" }] });
        same("an unknown number", T.toMarkers("from @img3", ab, ["La", "Lb"]), { text: "from @img3", errors: [{ kind: "unknown", token: "@img3", n: 3 }] });
        same("a layer that is not sent", T.toMarkers("from @img1 and @img2", ab, [null, "La"]), { text: "from {@ref:1} and @img2", errors: [{ kind: "unsent", token: "@img2", n: 2, id: "Lb" }] });
        same("validation still finds the rest", T.toMarkers("@img?Lz @img3 {@ref:1}", ab, null).errors.map((e) => e.kind), ["literal", "parked", "unknown"]);
        same("an error once per kind and token", T.toMarkers("@img3 @IMG3 @img3", ab, ["La"]).errors, [{ kind: "unknown", token: "@img3", n: 3 }]);
        same("no labels: every live token is unknown", T.toMarkers("@img1", null, [null]).errors, [{ kind: "unknown", token: "@img1", n: 1 }]);
        // on into main: the renderer's marker resolved by refs.js to the route's name (refs_cases.json's first vector)
        const v = cases.markers[0];
        const sent = T.toMarkers("the coat from @img1", labels("La"), [null, "La"]);
        same("the marker the renderer writes is the one main resolves", sent.text, v.text);
        same("main names it", refs.resolveMarkers(sent.text, v.pictures, v.pattern).text, v.out);
    });

    await section("7. namesFor", async () => {
        const table = { img1: "jacket", "?Lb": "dress" };
        const calls = [];
        const names = (key) => { calls.push(key); return table[key] == null ? null : table[key]; };
        const r = T.namesFor("@img1 over @img?Lb, @IMG1 again, @img3", names);
        same("the text with names", r.text, "jacket over dress, jacket again, @img3");
        same("replaced, normalised, once each", r.replaced, [{ token: "@img1", name: "jacket" }, { token: "@img?Lb", name: "dress" }]);
        same("missing", r.missing, ["@img3"]);
        same("names() is asked once per key", calls, ["img1", "?Lb", "img3"]);
        const bad = T.namesFor("crisp @img1", () => "@img2 {@ref:1} coat");
        same("a name is cleaned", bad.text, "crisp img2 ref:1 coat");
        check("a cleaned name brings no token and no marker", !T.hasTokens(bad.text) && !bad.text.includes("{@ref:"));
        same("undefined is missing too", T.namesFor("@img?Lq", () => undefined), { text: "@img?Lq", replaced: [], missing: ["@img?Lq"] });
        same("a text without tokens", T.namesFor("plain", () => "x"), { text: "plain", replaced: [], missing: [] });
    });

    await section("8. clean", async () => {
        same("quotes, @, braces and line breaks", T.clean('  the "red"\r\njacket @home {x}  '), "the red jacket home x");
        same("a name holding a token and a marker", T.clean("@img2 {@ref:1} coat"), "img2 ref:1 coat");
        same("at most 60 characters", T.clean("x".repeat(70)), "x".repeat(60));
        same("trimmed after the cut", T.clean("a".repeat(59) + " b"), "a".repeat(59));
        const face = String.fromCodePoint(0x1f600);
        const cut = T.clean("a".repeat(59) + face + "tail");
        check("the cut counts characters, not code units", cut === "a".repeat(59) + face, JSON.stringify(cut));
        check("unnamed when nothing is left", ["", "   ", '@{}"', null, undefined].every((x) => T.clean(x) === "unnamed"));
        same("a number", T.clean(7), "7");
    });

    await section("9. compare", async () => {
        same("dropped, invented and a literal (26d1's case e)", T.compare("the coat from @img2", "the coat from @img1 as in image 3", [2]),
            { dropped: ["@img2"], invented: ["@img1"], literals: ["image 3"] });
        same("a literal the request holds itself is no finding", T.compare("as in image 3, @img1", "As in Image 3, with @img1", [1]),
            { dropped: [], invented: [], literals: [] });
        same("img1 without the @", T.compare("@img1 coat", "the img1 coat", [1]), { dropped: ["@img1"], invented: [], literals: ["img1"] });
        same("the other literal forms, as found, once each", T.compare("", "<image2>, <frame>1</frame>, {@ref:0}, picture 4, Bild 2, reference_5, <image2>", []).literals,
            ["<image2>", "<frame>1</frame>", "{@ref:0}", "picture 4", "Bild 2", "reference_5"]);
        same("a literal written twice counts once", T.compare("", "image 3 and then Image 3", null).literals, ["image 3"]);
        same("tokens are sets, normalised", T.compare("@img2 and @img2", "@IMG2", [2]), { dropped: [], invented: [], literals: [] });
        same("a token is no literal", T.compare("@img1", "@img1 and @img3", [1]), { dropped: [], invented: ["@img3"], literals: [] });
        same("a parked token in the answer is invented", T.compare("@img1", "@img1 @img?Lz", [1]).invented, ["@img?Lz"]);
        same("a number allowed beyond the request", T.compare("@img2", "@img2 @img1", [1, 2]).invented, []);
        same("a number that runs into a word is no literal", T.compare("", "picture 2x sharper, image 4k, img2b, but image 5.", []).literals, ["image 5"]);
        same("without allowed only the request counts", T.compare("@img2", "@img2 @img1").invented, ["@img1"]);
    });

    await section("10. diffRange and mapOffset", async () => {
        same("a replacement", T.diffRange("abcdef", "abXYZef"), { start: 2, endA: 4, endB: 5 });
        same("an insertion", T.diffRange("abc", "abXc"), { start: 2, endA: 2, endB: 3 });
        same("a deletion", T.diffRange("hello big world", "hello world"), { start: 6, endA: 10, endB: 6 });
        same("no change", T.diffRange("same", "same"), { start: 4, endA: 4, endB: 4 });
        const a = "abcdef", b = "abXYZef";
        check("before the change stays", T.mapOffset(1, a, b) === 1 && T.mapOffset(2, a, b) === 2);
        check("inside the change goes to its end", T.mapOffset(3, a, b) === 5, String(T.mapOffset(3, a, b)));
        check("after the change shifts", T.mapOffset(4, a, b) === 5 && T.mapOffset(6, a, b) === 7);
        check("at an insertion point stays before it", T.mapOffset(2, "abc", "abXc") === 2);
        check("after a deletion shifts back", T.mapOffset(15, "hello big world", "hello world") === 11);
        check("clamped to the texts", T.mapOffset(-3, a, b) === 0 && T.mapOffset(99, a, b) === b.length);
        // a surrogate pair is never split: two emoji that share their first code unit
        const x = "x" + String.fromCodePoint(0x1f600) + "y", y = "x" + String.fromCodePoint(0x1f603) + "y";
        same("a surrogate pair is not split", T.diffRange(x, y), { start: 1, endA: 3, endB: 3 });
        // a remap @img2 -> @img?L1k3: the caret stays after the same word, not at the same number
        const before = "the coat from @img2, and the hat";
        const after = T.remap(before, labels("Lk", "L1k3"), labels("Lk"));
        same("the remap parks the token", after, "the coat from @img?L1k3, and the hat");
        const word = (text, w) => text.indexOf(w) + w.length;
        check("a caret after a word before the token stays", T.mapOffset(word(before, "coat"), before, after) === word(after, "coat"));
        check("a caret after the token stays after it", T.mapOffset(word(before, "@img2"), before, after) === word(after, "@img?L1k3"));
        const at = T.mapOffset(word(before, ", and"), before, after);
        check("a caret after a word behind the token stays after that word", after.slice(0, at).endsWith("@img?L1k3, and") && at === word(after, ", and"), String(at));
        check("a caret at the end stays at the end", T.mapOffset(before.length, before, after) === after.length);
    });

    await section("11. the upsample pieces (26d1)", async () => {
        const one = [{ id: "La", n: 2, name: 'the "red"\njacket @x' }];
        const two = [{ id: "La", n: 1, name: "jacket" }, { id: "Lb", n: 3, name: "" }];
        same("referenceName cleans the name", T.referenceName(one[0]), '@img2 (the layer "the red jacket x")');
        same("referencesText: nothing without references", [T.referencesText([]), T.referencesText(null)], ["", ""]);
        same("referencesText: one", T.referencesText(one), ' The request names this reference image by token: @img2 (the layer "the red jacket x").');
        same("referencesText: two, an empty name is unnamed", T.referencesText(two),
            ' The request names these reference images by token: @img1 (the layer "jacket"), @img3 (the layer "unnamed").');
        same("referencesRule: nothing without references", T.referencesRule([]), "");
        const rule = T.referencesRule(two);
        check("referencesRule lists the tokens", rule.startsWith("Reference tokens: keep every token of the request (@img1, @img3) exactly as written"), rule);
        check("referencesRule forbids numbers", rule.endsWith('never name a picture by a number such as "image 2".'), rule);
        same("checkNote: nothing when all is kept", [T.checkNote({ dropped: [], invented: [], literals: [] }), T.checkNote(null)], ["", ""]);
        same("checkNote: every part", T.checkNote(T.compare("the coat from @img2", "the coat from @img1 as in image 3", [2])),
            'Check the tokens: the rewrite dropped @img2; added @img1; wrote "image 3".');
        same("checkNote: one part, two tokens", T.checkNote({ dropped: ["@img1", "@img2"], invented: [], literals: [] }), "Check the tokens: the rewrite dropped @img1, @img2.");
        check("checkNote never says failed", !/failed/i.test(T.checkNote({ dropped: ["@img1"], invented: ["@img2"], literals: ["failed 1"] }).replace(/"failed 1"/, "")));
    });

    const failed = results.filter((x) => !x).length;
    console.log(`${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.log("[FAIL] " + (err && err.stack || err)); console.log("FAIL"); process.exit(1); });
