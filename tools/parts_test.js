// renderer/editor/inpaint_parts.js installParts in plain Node (item 56, docs/PLAN_SPLIT.md §2): methods arrive
// non-enumerable and with their text, accessors stay accessors, `this` and `.name` are the target's, a name that is
// already there or comes twice throws and installs nothing, a part with statics throws, plain objects install onto a
// plain object. Run: node tools/parts_test.js
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

let failed = 0, passed = 0;
function check(name, ok, info) {
    if (ok) passed++; else failed++;
    console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${info ? " -- " + info : ""}`);
}
function throws(fn, re) {
    try { fn(); return false; } catch (err) { return re.test(String(err && err.message)); }
}

(async () => {
    const { installParts } = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "inpaint_parts.js")).href);

    class Ed {
        constructor() { this.v = 2; }
        own() { return "own"; }
        static make() { return new Ed(); }
    }
    class PartA {
        twice() { return this.v * 2; }
        get half() { return this.v / 2; }
        set half(x) { this.v = x * 2; }
        async later() { return this.own(); }
    }
    class PartB {
        *gen() { yield this.v; }
        [Symbol.for("scumble.tag")]() { return "tag"; }
    }
    const names = installParts(Ed, [PartA, PartB]);
    const e = new Ed();
    check("every method and accessor of both parts is installed, in order, without `constructor`",
        names.map(String).join(",") === "twice,half,later,gen,Symbol(scumble.tag)", names.map(String).join(","));
    check("`this` is the instance", e.twice() === 4 && [...e.gen()][0] === 2 && e[Symbol.for("scumble.tag")]() === "tag");
    const d = Object.getOwnPropertyDescriptor(Ed.prototype, "half");
    check("an accessor stays an accessor (get and set)", !!d && typeof d.get === "function" && typeof d.set === "function" && !("value" in d));
    e.half = 5;
    check("the setter writes through `this`", e.v === 10 && e.half === 5);
    check("methods are non-enumerable, as class methods are", !Object.keys(Ed.prototype).length && !Object.getOwnPropertyDescriptor(Ed.prototype, "twice").enumerable);
    check("a method keeps its own name and text", Ed.prototype.twice.name === "twice" && Ed.prototype.twice.toString() === "twice() { return this.v * 2; }", Ed.prototype.twice.toString());
    check("a prototype method called with a fake `this` works (maps_test / limit_test call them so)", Ed.prototype.twice.call({ v: 7 }) === 14);
    check("an async method resolves through the class's own method", (await e.later()) === "own");
    check("the class's statics and constructor stay", typeof Ed.make === "function" && Ed.make() instanceof Ed && Ed.prototype.constructor === Ed);

    class Clash { own() { return "x"; } }
    class Fresh { fresh() { return 1; } }
    check("a name already on the target throws", throws(() => installParts(Ed, [Fresh, Clash]), /Clash\.own is already on Ed\.prototype/));
    check("... and installs nothing of the call", !Object.prototype.hasOwnProperty.call(Ed.prototype, "fresh"));
    class Dup1 { same() {} }
    class Dup2 { same() {} }
    check("a name in two parts throws, naming both", throws(() => installParts(Ed, [Dup1, Dup2]), /Dup2\.same is also in Dup1/));
    check("... and installs nothing", !Object.prototype.hasOwnProperty.call(Ed.prototype, "same"));
    class WithStatic { m() {} static s() {} }
    check("a part with a static member throws (statics stay in the class)", throws(() => installParts(Ed, [WithStatic]), /static members \(s\)/));
    check("a part that is no class throws", throws(() => installParts(Ed, [{ m() {} }]), /is not a class/));

    const host = { a: 1, get b() { return this.a + 1; } };
    const hp = { c() { return this.a + 10; }, get d() { return this.b * 2; } };
    installParts(host, [hp]);
    const hd = Object.getOwnPropertyDescriptor(host, "d");
    check("a plain object takes a plain object part: methods, accessors, `this`", host.c() === 11 && host.d === 4 && typeof hd.get === "function" && Object.keys(host).join(",") === "a,b,c,d");
    check("a plain object part whose name the object has throws", throws(() => installParts(host, [{ a: 2 }]), /\.a is already on the target/) && host.a === 1);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
