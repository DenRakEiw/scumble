// The Realism Pass (item 37, docs/PLAN_0_1_42.md R1 "Tests"), in plain Node, no Electron, no ComfyUI and no network:
//   node tools/realism_test.js
// renderer/editor/realism.js (an ES module, imported as tools/boxes_test.js imports renderer/editor/boxes.js) is the
// API under test: the GPU generation by the pack's rule, the server check of plan table 3.3 on ComfyUI's torch devices
// (only cuda devices count; none listed is left to the pack), the size check of 3.5 against the pack's even rounding
// and its 7680 x 4320 cap, the crop span the canvas node makes at the pass's multiple of 2 (fitSpan against the node's
// _fit_span_to_multiple written out here), the DLSS5Settings inputs of a run, the hint for every message of the pack
// (tools/refs/dlss5/messages.json, verbatim to the pack's f-strings at HEAD 796ed59), the per-key fill of
// settings.realism, and the label every text carries. The defaults are checked against recipes/realism_pass.json and
// electron/main/settings.js DEFAULTS.realism (loaded with electron stood in for, as tools/settings_migration_test.js does).
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const EXACT_LABEL = "Realism Pass (Windows only, RTX only)";

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > 400 ? s.slice(0, 400) + " ..." : s; };
const throws = (fn) => { try { fn(); return null; } catch (e) { return (e && e.message) || String(e); } };

/** The pack's _even (dlss5/settings.py:80-81): max(2, int(math.floor(value / 2.0 + 0.5)) * 2), written out here. */
const packEven = (v) => Math.max(2, Math.floor(v / 2.0 + 0.5) * 2);
/** What the pack accepts for a w x h picture at `factor` (settings.py:84-105, session.py:151-155), written out here. */
function packAccepts(w, h, factor) {
    if (Math.min(w, h) < 64) return false;
    const ow = packEven(w * factor), oh = packEven(h * factor);
    return Math.max(ow, oh) <= 7680 && Math.min(ow, oh) <= 4320;
}
/**
 * The canvas node's _fit_span_to_multiple (ComfyUI-InpaintCanvas nodes.py:502-521), written out here with Python's
 * floor division: the span [a0, a1) grown symmetrically to a multiple of m inside [0, limit), or shrunk to the largest
 * multiple that fits; when not even one multiple fits, the span is left as it is. -> [a0, a1]
 */
function nodeFitSpan(a0, a1, limit, m) {
    const fdiv = (a, b) => Math.floor(a / b);
    const size = a1 - a0;
    let target = -fdiv(-size, m) * m;
    if (target > limit) {
        target = fdiv(limit, m) * m;
        if (target <= 0) return [a0, a1];
    }
    const extra = target - size;
    a0 -= fdiv(extra, 2);
    a1 = a0 + target;
    if (a0 < 0) { a1 -= a0; a0 = 0; }
    if (a1 > limit) { a0 -= a1 - limit; a1 = limit; }
    return [Math.max(0, a0), a1];
}

(async () => {
    const R = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "realism.js")).href);
    const L = R.LABEL;
    /** Every text an answer of the module gave, for the label check at the end. */
    const texts = [];
    const keep = (s) => { if (typeof s === "string" && s) texts.push(s); return s; };

    // ---- 0. the constants -----------------------------------------------------------------------------------------
    console.log("--- 0. the constants ---");
    check("LABEL is exactly 'Realism Pass (Windows only, RTX only)'", L === EXACT_LABEL, JSON.stringify(L));
    check("RECIPE_ID is realism_pass", R.RECIPE_ID === "realism_pass", R.RECIPE_ID);
    check("NODES are the pack's two nodes a pass needs", eq(R.NODES, ["DLSS5Settings", "DLSS5EnhanceImages"]), short(R.NODES));
    check("STYLES are the pack's table", eq(R.STYLES, ["Default", "Natural", "Cinematic"]), short(R.STYLES));
    check("MODEL_PRESETS are the pack's table", eq(R.MODEL_PRESETS, ["Default", "J", "K", "L", "M"]), short(R.MODEL_PRESETS));
    check("the caps: 7680 long, 4320 short, 64 the smallest side", R.MAX_LONG === 7680 && R.MAX_SHORT === 4320 && R.MIN_SIDE === 64, short([R.MAX_LONG, R.MAX_SHORT, R.MIN_SIDE]));
    check("PASS_MULTIPLE is 2 (DLSS needs even sides only; the pass's canvas multiple_of)", R.PASS_MULTIPLE === 2, String(R.PASS_MULTIPLE));
    check("realismDefaults are style Default, intensity 1, preset L, timeout 300", eq(R.realismDefaults, { style: "Default", intensity: 1, preset: "L", timeout: 300 }), short(R.realismDefaults));
    check("realismDefaults are frozen", Object.isFrozen(R.realismDefaults), "");

    // ---- 1. gpuGeneration --------------------------------------------------------------------------------------------
    console.log("\n--- 1. gpuGeneration (the pack's rule: 'RTX' in the name, then /RTX\\s+(\\d{2})/) ---");
    const gens = [
        ["cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync", 50],
        ["NVIDIA GeForce RTX 5090", 50],
        ["NVIDIA GeForce RTX 4060 Laptop GPU", 40],
        ["cuda:0 NVIDIA GeForce RTX 4090 : native", 40],
        ["NVIDIA GeForce RTX 3090 Ti", 30],
        ["NVIDIA GeForce RTX 3060", 30],
        ["NVIDIA GeForce RTX 2080", 20],
        ["NVIDIA GeForce RTX 2080 SUPER", 20],
        ["NVIDIA GeForce GTX 1080", 0],
        ["Quadro RTX 8000", 80],
        ["NVIDIA RTX A6000", 0],
        ["NVIDIA RTX PRO 6000 Blackwell", 0],
        ["cpu", 0],
        ["cuda:0 AMD Radeon RX 7900 XTX", 0],
        ["", 0],
    ];
    for (const [name, want] of gens) {
        const got = R.gpuGeneration(name);
        check(`gpuGeneration(${JSON.stringify(name)}) is ${want}`, got === want, String(got));
    }
    check("gpuGeneration(undefined) and (null) are 0", R.gpuGeneration(undefined) === 0 && R.gpuGeneration(null) === 0, short([R.gpuGeneration(undefined), R.gpuGeneration(null)]));

    // ---- 2. serverSupport (plan table 3.3) ---------------------------------------------------------------------------
    console.log("\n--- 2. serverSupport (plan table 3.3) ---");
    const ALL = { InpaintCanvas: {}, ImageFromBatch: {}, DLSS5Settings: {}, DLSS5EnhanceImages: {} };
    const without = (...names) => { const o = { ...ALL }; for (const n of names) delete o[n]; return o; };
    const G5090 = "cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync";
    const G4090 = "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync";
    const G3090 = "cuda:0 NVIDIA GeForce RTX 3090 Ti : cudaMallocAsync";
    const G2080 = "cuda:0 NVIDIA GeForce RTX 2080 : cudaMallocAsync";
    const ok = (extra = {}) => ({ state: "connected", os: "nt", gpus: [G5090], objectInfo: ALL, ...extra });
    const sup = (arg) => { const s = R.serverSupport(arg); keep(s.reason); keep(s.note); return s; };
    const shape = (s) => s && ["ok", "show", "reason", "gpu", "generation", "experimental", "note"].every((k) => k in s);

    // not connected
    for (const state of ["disconnected", "connecting", "error", undefined]) {
        const s = sup({ ...ok(), state });
        check(`state ${JSON.stringify(state)}: hidden, refused, 'needs your own ComfyUI'`, shape(s) && s.ok === false && s.show === "hidden"
            && s.reason === `${L} needs your own ComfyUI: connect it under Settings › ComfyUI (Windows, an RTX 30, 40 or 50 card, the ComfyUI-DLSS5-Enhancer node pack).`, short(s));
    }
    {
        const s = sup(undefined);
        check("no argument at all: hidden and refused (no throw)", s.ok === false && s.show === "hidden" && /needs your own ComfyUI/.test(s.reason), short(s));
        const s2 = sup({ state: "disconnected", os: "linux", gpus: [G2080], objectInfo: null });
        check("not connected wins over every other reason", /needs your own ComfyUI/.test(s2.reason), s2.reason);
    }
    // the server's os
    for (const o of ["nt", "win32"]) {
        const s = sup(ok({ os: o }));
        check(`os ${JSON.stringify(o)} is Windows: ready`, s.ok === true && s.show === "ready" && s.reason === "", short(s));
    }
    for (const o of ["linux", "posix", "darwin"]) {
        const s = sup(ok({ os: o }));
        check(`os ${JSON.stringify(o)}: hidden, 'runs only on a ComfyUI on Windows; this one runs on ${o}.'`, s.ok === false && s.show === "hidden"
            && s.reason === `${L} runs only on a ComfyUI on Windows; this one runs on ${o}.`, short(s));
    }
    for (const o of ["", undefined, null]) {
        const s = sup(ok({ os: o }));
        check(`an unreported os (${JSON.stringify(o)}) does not refuse: ready`, s.ok === true && s.show === "ready", short(s));
    }
    {
        const s = sup(ok({ os: "linux", gpus: [G2080], objectInfo: without("DLSS5Settings") }));
        check("os linux with an RTX 2080 and nodes missing: the os reason first", /runs only on a ComfyUI on Windows/.test(s.reason), s.reason);
    }
    // the card
    {
        const s = sup(ok({ gpus: [G5090] }));
        check("RTX 5090 on Windows with every node: ready, gpu named without cuda:0 and the allocator, generation 50, not experimental",
            s.ok === true && s.show === "ready" && s.gpu === "NVIDIA GeForce RTX 5090" && s.generation === 50 && s.experimental === false && s.note === "", short(s));
    }
    {
        const s = sup(ok({ gpus: [G3090] }));
        check("RTX 30: allowed (ready) with experimental and the Ampere note (Q8)", s.ok === true && s.show === "ready" && s.experimental === true && s.generation === 30
            && s.note === `${L}: RTX 30 cards need the pack's experimental runtime pair for Ampere (see the pack's README); without it the pass fails.`, short(s));
    }
    {
        const s = sup(ok({ gpus: [G2080] }));
        check("RTX 2080: hidden, names the card", s.ok === false && s.show === "hidden" && s.generation === 20 && s.gpu === "NVIDIA GeForce RTX 2080"
            && s.reason === `${L} needs an RTX 30, 40 or 50 card on your ComfyUI's machine; it shows NVIDIA GeForce RTX 2080.`, short(s));
    }
    // The device rule: ComfyUI's /system_stats devices[].name are torch devices ("cuda:0 <name> : <allocator>" from
    // comfy/model_management.py get_torch_device_name; DirectML's is "privateuseone", the CPU's "cpu"). Only names
    // matching /^\s*cuda:\d+/i count. A refusal needs at least one cuda device and none of RTX 30 or later by the pack's
    // name rule; it names every cuda device. Otherwise the card is the first cuda device of RTX 30 or later, and no cuda
    // device listed at all is left to the pack (its own refusal is the final word, hint() turns it into a sentence).
    const G1080 = "cuda:0 NVIDIA GeForce GTX 1080 : cudaMallocAsync";
    const notRefusedByCard = (s) => !/needs an RTX 30, 40 or 50 card/.test(s.reason);
    const cardRefusal = (shown) => `${L} needs an RTX 30, 40 or 50 card on your ComfyUI's machine; it shows ${shown}.`;
    {
        const s = sup(ok({ gpus: [G1080] }));
        check("GTX 1080: hidden, names the card", s.ok === false && s.show === "hidden" && s.reason === cardRefusal("NVIDIA GeForce GTX 1080") && s.generation === 0, short(s));
    }
    {
        const s = sup(ok({ gpus: ["cpu"] }));
        check("only 'cpu' (no cuda device listed): left to the pack, ready when the nodes are there (not refused)", s.ok === true && s.show === "ready" && s.reason === ""
            && s.gpu === "" && s.generation === 0 && s.experimental === false && s.note === "", short(s));
        const s2 = sup(ok({ gpus: ["cpu"], objectInfo: without("DLSS5Settings") }));
        check("only 'cpu' with a DLSS node missing: disabled by the nodes, not hidden by the card", s2.ok === false && s2.show === "disabled" && /lacks its nodes \(DLSS5Settings\)/.test(s2.reason) && notRefusedByCard(s2), short(s2));
        const s3 = sup(ok({ gpus: ["cpu"], objectInfo: null }));
        check("only 'cpu' with object_info not read: disabled (the node list), not hidden by the card", s3.ok === false && s3.show === "disabled" && /could not read your ComfyUI's node list/.test(s3.reason), short(s3));
    }
    for (const g of ["privateuseone:0", "privateuseone"]) {
        const s = sup(ok({ gpus: [g] }));
        check(`only ${JSON.stringify(g)} (DirectML, no cuda device): left to the pack, ready`, s.ok === true && s.show === "ready" && s.gpu === "" && s.generation === 0, short(s));
    }
    {
        const s = sup(ok({ gpus: ["NVIDIA GeForce RTX 2080"] }));
        check("a bare 'NVIDIA GeForce RTX 2080' without the cuda:N prefix is not a ComfyUI cuda device: left to the pack, ready", s.ok === true && s.show === "ready", short(s));
        const s2 = sup(ok({ gpus: ["CUDA:1 NVIDIA GeForce RTX 2080 : cudaMallocAsync"] }));
        check("'CUDA:1 ...' (upper case) counts as a cuda device: refused, the name cleaned", s2.ok === false && s2.show === "hidden" && s2.reason === cardRefusal("NVIDIA GeForce RTX 2080"), short(s2));
        const s3 = sup(ok({ gpus: ["cuda:0 : cudaMallocAsync"] }));
        check("a cuda device with an empty name: refused, 'it shows no NVIDIA card.'", s3.ok === false && s3.show === "hidden" && s3.reason === cardRefusal("no NVIDIA card"), short(s3));
    }
    {
        const s = sup(ok({ gpus: ["cuda:0 AMD Radeon RX 7900 XTX : native"] }));
        check("an AMD card as a cuda device (ROCm): hidden, names it", s.ok === false && s.show === "hidden" && s.reason === cardRefusal("AMD Radeon RX 7900 XTX")
            && s.gpu === "AMD Radeon RX 7900 XTX" && s.generation === 0, short(s));
    }
    {
        const s = sup(ok({ gpus: ["cuda:0 NVIDIA RTX A6000 : cudaMallocAsync"] }));
        check("RTX A6000: hidden, as the pack refuses it", s.ok === false && s.show === "hidden" && s.reason === cardRefusal("NVIDIA RTX A6000"), short(s));
    }
    {
        const s = sup(ok({ gpus: ["cuda:0 Quadro RTX 8000 : cudaMallocAsync"] }));
        check("Quadro RTX 8000: generation 80, accepted as the pack does", s.ok === true && s.generation === 80, short(s));
    }
    {
        const s = sup(ok({ gpus: [G2080] }));
        check("[cuda RTX 2080] alone: refused, names it", s.ok === false && s.show === "hidden" && s.reason === cardRefusal("NVIDIA GeForce RTX 2080"), short(s));
        const s1 = sup(ok({ gpus: [G2080, G4090] }));
        check("[cuda RTX 2080, cuda RTX 4090]: ready with the 4090 (the first cuda device of RTX 30 or later)", s1.ok === true && s1.show === "ready"
            && s1.gpu === "NVIDIA GeForce RTX 4090" && s1.generation === 40 && s1.experimental === false && s1.note === "", short(s1));
        const s2 = sup(ok({ gpus: [G4090, G2080] }));
        check("[cuda RTX 4090, cuda RTX 2080]: ready on the 4090", s2.ok === true && s2.gpu === "NVIDIA GeForce RTX 4090" && s2.generation === 40, short(s2));
        const s3 = sup(ok({ gpus: [G1080, G2080] }));
        check("[cuda GTX 1080, cuda RTX 2080]: refused, naming both in order; gpu and generation from the first", s3.ok === false && s3.show === "hidden"
            && s3.reason === cardRefusal("NVIDIA GeForce GTX 1080, NVIDIA GeForce RTX 2080") && s3.gpu === "NVIDIA GeForce GTX 1080" && s3.generation === 0, short(s3));
        const s4 = sup(ok({ gpus: [G1080, G4090] }));
        check("[cuda GTX 1080, cuda RTX 4090]: ready on the 4090", s4.ok === true && s4.gpu === "NVIDIA GeForce RTX 4090" && s4.generation === 40, short(s4));
        const s5 = sup(ok({ gpus: ["cpu", G5090] }));
        check("['cpu', cuda RTX 5090]: ready on the 5090", s5.ok === true && s5.generation === 50 && s5.gpu === "NVIDIA GeForce RTX 5090", short(s5));
        const s6 = sup(ok({ gpus: ["cpu", G2080] }));
        check("['cpu', cuda RTX 2080]: refused, naming the cuda device alone", s6.ok === false && s6.show === "hidden" && s6.reason === cardRefusal("NVIDIA GeForce RTX 2080"), short(s6));
        const s7 = sup(ok({ gpus: [G2080, G1080, "cuda:2 AMD Radeon RX 7900 XTX : native"] }));
        check("three cuda devices, none RTX 30 or later: refused, naming all three", s7.ok === false && s7.reason === cardRefusal("NVIDIA GeForce RTX 2080, NVIDIA GeForce GTX 1080, AMD Radeon RX 7900 XTX"), short(s7));
    }
    {
        const ampere = `${L}: RTX 30 cards need the pack's experimental runtime pair for Ampere (see the pack's README); without it the pass fails.`;
        const s = sup(ok({ gpus: [G2080, G3090, G4090] }));
        check("[RTX 2080, RTX 3090 Ti, RTX 4090]: the first good one is an RTX 30, so ready and experimental with the Ampere note", s.ok === true && s.show === "ready"
            && s.gpu === "NVIDIA GeForce RTX 3090 Ti" && s.generation === 30 && s.experimental === true && s.note === ampere, short(s));
        const s2 = sup(ok({ gpus: [G4090, G3090] }));
        check("[RTX 4090, RTX 3090 Ti]: the first good one is a 40, not experimental, no note", s2.ok === true && s2.generation === 40 && s2.experimental === false && s2.note === "", short(s2));
        const s3 = sup(ok({ gpus: ["cpu", G3090] }));
        check("['cpu', RTX 3090 Ti]: experimental", s3.ok === true && s3.experimental === true && s3.generation === 30, short(s3));
    }
    for (const g of [[], undefined, null, "not a list"]) {
        const s = sup(ok({ gpus: g }));
        check(`an unreported device list (${JSON.stringify(g)}) does not refuse: ready`, s.ok === true && s.show === "ready", short(s));
    }
    // the nodes
    {
        const s = sup(ok({ objectInfo: without("DLSS5Settings") }));
        check("DLSS5Settings missing: disabled, names it and the pack", s.ok === false && s.show === "disabled"
            && s.reason === `${L}: your ComfyUI lacks its nodes (DLSS5Settings): install the ComfyUI-DLSS5-Enhancer node pack there (Help › Manual › ${L}).`, short(s));
        const s2 = sup(ok({ objectInfo: without("DLSS5Settings", "DLSS5EnhanceImages") }));
        check("both DLSS nodes missing: disabled, names both in the pack's order", s2.ok === false && s2.show === "disabled"
            && s2.reason.includes("(DLSS5Settings, DLSS5EnhanceImages)") && s2.reason.includes("ComfyUI-DLSS5-Enhancer"), short(s2));
        const s3 = sup(ok({ objectInfo: without("DLSS5EnhanceImages"), gpus: [G3090] }));
        check("an RTX 30 with a DLSS node missing: disabled, the card's facts and the note kept", s3.show === "disabled" && s3.experimental === true && s3.generation === 30 && !!s3.note && s3.gpu === "NVIDIA GeForce RTX 3090 Ti", short(s3));
        const s4 = sup(ok({ objectInfo: without("DLSS5Settings", "InpaintCanvas") }));
        check("DLSS node and InpaintCanvas missing: the DLSS nodes are named first", s4.show === "disabled" && /lacks its nodes \(DLSS5Settings\)/.test(s4.reason), s4.reason);
    }
    {
        const s = sup(ok({ objectInfo: without("InpaintCanvas") }));
        check("InpaintCanvas missing (connected): disabled, 'also needs the Inpaint Canvas node pack'", s.ok === false && s.show === "disabled"
            && s.reason === `${L} also needs the Inpaint Canvas node pack on your ComfyUI.`, short(s));
        const s2 = sup(ok({ state: "missing-node", objectInfo: without("InpaintCanvas") }));
        check("state missing-node with InpaintCanvas absent from object_info: disabled, the Inpaint Canvas reason", s2.ok === false && s2.show === "disabled" && s2.reason === `${L} also needs the Inpaint Canvas node pack on your ComfyUI.`, short(s2));
        const s3 = sup(ok({ state: "missing-node", objectInfo: null }));
        check("state missing-node without an object_info: disabled, the Inpaint Canvas reason", s3.ok === false && s3.show === "disabled" && s3.reason === `${L} also needs the Inpaint Canvas node pack on your ComfyUI.`, short(s3));
        const s4 = sup(ok({ state: "missing-node", os: "linux" }));
        check("state missing-node on linux: hidden (the os first)", s4.show === "hidden" && /runs only on a ComfyUI on Windows/.test(s4.reason), short(s4));
        const s5 = sup(ok({ state: "missing-node", objectInfo: without("InpaintCanvas", "DLSS5EnhanceImages") }));
        check("state missing-node and a DLSS node missing too: the DLSS nodes are named", s5.show === "disabled" && /lacks its nodes \(DLSS5EnhanceImages\)/.test(s5.reason), s5.reason);
    }
    {
        const s = sup(ok({ objectInfo: null }));
        check("connected, object_info not read (null): disabled, not ready, 'could not read your ComfyUI's node list'", s.ok === false && s.show === "disabled"
            && s.reason === `${L}: Scumble could not read your ComfyUI's node list (/object_info); reconnect under Settings › ComfyUI.`, short(s));
        const s2 = sup(ok({ objectInfo: undefined }));
        check("object_info undefined: the same", s2.ok === false && s2.show === "disabled" && /could not read your ComfyUI's node list/.test(s2.reason), short(s2));
    }
    {
        const s = sup(ok());
        check("all there: ok, ready, no reason", s.ok === true && s.show === "ready" && s.reason === "" && shape(s), short(s));
    }

    // ---- 3. even and outputSize ----------------------------------------------------------------------------------------
    console.log("\n--- 3. even (the pack's _even) and outputSize ---");
    const evens = [[641 * 1, 642], [481, 482], [640, 640], [1, 2], [0, 2], [2, 2], [3, 4], [4, 4], [5, 6], [1.5, 2], [2.9, 2], [3.0, 4], [7681, 7682], [7679, 7680], [4321, 4322], [4319, 4320], [7681.5, 7682], [7678.5, 7678]];
    for (const [v, want] of evens) check(`even(${v}) is ${want}`, R.even(v) === want, String(R.even(v)));
    {
        let bad = null;
        for (let v = 0; v <= 9000 && !bad; v += 0.25) if (R.even(v) !== packEven(v)) bad = [v, R.even(v), packEven(v)];
        for (const f of [1, 1.5, 1.724, 2, 3]) for (let w = 60; w <= 2700 && !bad; w += 7) if (R.even(w * f) !== packEven(w * f)) bad = [w, f, R.even(w * f), packEven(w * f)];
        check("even equals the pack's _even over 0 to 9000 in quarter steps and every factor of the pack", !bad, short(bad));
    }
    check("outputSize(641, 481) is 642 x 482 (the pack's example)", eq(R.outputSize(641, 481), { w: 642, h: 482 }), short(R.outputSize(641, 481)));
    check("outputSize(641, 481, 1) is 642 x 482", eq(R.outputSize(641, 481, 1), { w: 642, h: 482 }), short(R.outputSize(641, 481, 1)));
    check("outputSize(1000, 750, 1.724) is 1724 x 1294", eq(R.outputSize(1000, 750, 1.724), { w: 1724, h: 1294 }), short(R.outputSize(1000, 750, 1.724)));
    check("outputSize(3840, 2160, 2) is 7680 x 4320", eq(R.outputSize(3840, 2160, 2), { w: 7680, h: 4320 }), short(R.outputSize(3840, 2160, 2)));

    // ---- 4. fits (plan 3.5) ------------------------------------------------------------------------------------------
    console.log("\n--- 4. fits (plan 3.5) ---");
    const fit = (w, h, f) => keep(f === undefined ? R.fits(w, h) : R.fits(w, h, f));
    const small = (w, h) => `${L} needs at least 64 px a side; this is ${w} × ${h}.`;
    const large = (w, h) => `${L} takes at most 7680 × 4320 (long × short side); this is ${w} × ${h}.`;
    const fitCases = [
        [63, 100, undefined, small(63, 100)],
        [100, 63, undefined, small(100, 63)],
        [64, 64, undefined, ""],
        [7680, 4320, undefined, ""],
        [4320, 7680, undefined, ""],
        [4320, 4320, undefined, ""],
        [7681, 100, undefined, large(7681, 100)],
        [100, 7681, undefined, large(100, 7681)],
        [4321, 4321, undefined, large(4321, 4321)],
        [7680, 4321, undefined, large(7680, 4321)],
        [7679, 4319, undefined, ""],                       // the pack rounds them up to 7680 x 4320: still in
        [64, 64, 1, ""],
        [7681, 100, 1, large(7681, 100)],
        [3840, 2160, 2, ""],
        [3840, 2160, 3, large(11520, 6480)],               // an upscale names the output it would make
        [2560, 1440, 3, ""],
        [2561, 1440, 3, large(7684, 4320)],
        [5120, 2880, 1.5, ""],
        [5121, 2880, 1.5, large(7682, 4320)],              // 7681.5 rounds to 7682 the pack's way
        [5119, 2880, 1.5, ""],                             // 7678.5 rounds to 7678
        [3841, 2160, 2, large(7682, 4320)],
        [32, 32, 2, small(32, 32)],                        // the smallest side is the picture's, not the output's
        [63, 1000, 3, small(63, 1000)],
    ];
    for (const [w, h, f, want] of fitCases) {
        const got = fit(w, h, f);
        check(`fits(${w}, ${h}${f === undefined ? "" : ", " + f}) is ${want ? "refused" : "ok"}`, got === want, JSON.stringify(got));
    }
    {
        let bad = null;
        for (const f of [1, 1.5, 1.724, 2, 3]) {
            for (const w of [62, 63, 64, 65, 100, 1000, 2559, 2560, 2561, 3839, 3840, 3841, 4319, 4320, 4321, 4455, 4456, 5119, 5120, 5121, 7679, 7680, 7681, 8000]) {
                for (const h of [63, 64, 65, 1439, 1440, 1441, 2159, 2160, 2161, 2505, 2506, 2879, 2880, 2881, 4319, 4320, 4321, 7680, 7681]) {
                    const got = R.fits(w, h, f) === "";
                    if (got !== packAccepts(w, h, f)) { bad = [w, h, f, R.fits(w, h, f)]; break; }
                }
                if (bad) break;
            }
            if (bad) break;
        }
        check("fits agrees with the pack's own rule (even rounding, 7680 x 4320, 64 px) over a grid of sizes at 1, 1.5, 1.724, 2 and 3", !bad, short(bad));
    }
    {
        const got = keep(R.fits(undefined, 100));
        check("fits(undefined, 100) refuses as too small, no throw", got === small(0, 100), JSON.stringify(got));
        const s = R.fits("100", "100");
        check("fits('100', '100') takes numbers as strings: ok", s === "", JSON.stringify(s));
    }

    // ---- 4b. fitSpan (the canvas node's _fit_span_to_multiple) and the size pre-check of a pass --------------------
    console.log("\n--- 4b. fitSpan (nodes.py _fit_span_to_multiple) and fits(fitSpan(..)) ---");
    {
        let bad = null, n = 0;
        for (const m of [1, 2, 7, 8, 64]) {
            for (let limit = 1; limit <= 300 && !bad; limit++) {
                for (let size = 1; size <= 300 && !bad; size++) {
                    // the span at the start, in the middle and at the far end of the side (one place when it is longer)
                    const starts = size <= limit ? [0, Math.floor((limit - size) / 2), limit - size] : [0];
                    for (const a0 of starts) {
                        const [b0, b1] = nodeFitSpan(a0, a0 + size, limit, m);
                        const got = R.fitSpan(size, limit, m);
                        n++;
                        if (got !== b1 - b0) { bad = { size, limit, m, a0, fitSpan: got, node: b1 - b0 }; break; }
                    }
                }
            }
            if (bad) break;
        }
        check("fitSpan equals the node's span length over sizes 1-300, limits 1-300, m in {1, 2, 7, 8, 64}, the span at three places", !bad && n === 901500, bad ? short(bad) : `${n} spans`);
    }
    const spans = [
        // [size, limit, m, want, why]
        [6000, 6000, 64, 5952, "the old multiple of 64 shrinks a whole 6000 side to 5952 (a border without the pass)"],
        [6000, 6000, 2, 6000, "the pass's multiple of 2 keeps the whole side"],
        [6000, 6000, undefined, 6000, "the default m is PASS_MULTIPLE"],
        [7700, 7700, 2, 7700, "an even whole side stays"],
        [4001, 4001, 2, 4000, "an odd whole side: the next even (4002) passes the side, so the largest even that fits"],
        [4001, 4001, undefined, 4000, "the same with the default m"],
        [4001, 6000, 2, 4002, "an odd crop inside a larger side grows to the next even"],
        [63, 6000, 2, 64, "a 63 px crop grows to 64"],
        [5000, 4000, 2, 4000, "size > limit: the largest multiple that fits the side"],
        [5001, 4001, 2, 4000, "size > an odd limit: the largest even below it"],
        [300, 1, 2, 300, "size > limit and not one multiple fits: the node leaves the span"],
        [100, 50, 64, 100, "the same at 64"],
    ];
    for (const [size, limit, m, want, why] of spans) {
        const got = m === undefined ? R.fitSpan(size, limit) : R.fitSpan(size, limit, m);
        const node = (() => { const [b0, b1] = nodeFitSpan(0, size, limit, m === undefined ? 2 : m); return b1 - b0; })();
        check(`fitSpan(${size}, ${limit}${m === undefined ? "" : ", " + m}) is ${want} (${why})`, got === want && node === want, `${got}, the node ${node}`);
    }
    {
        // The review's size cases: queueGenerate checks fits(fitSpan(cw, editor.width), fitSpan(ch, editor.height)) on the
        // crop with its context, at the pass's multiple of 2, before anything is queued.
        const pass = (cw, ch, W, H) => keep(R.fits(R.fitSpan(cw, W), R.fitSpan(ch, H)));
        const got1 = pass(4364, 4364, 6000, 4500);
        check("an auto-context-like crop 4364 x 4364 on a 6000 x 4500 picture: refused before queueing (the short side 4364 > 4320)", got1 === large(4364, 4364), JSON.stringify(got1));
        // A whole 7700 x 4000 picture: at the pass's m = 2 the node keeps 7700 x 4000, which the pack refuses at 1x (the
        // long side), so the pre-check refuses. At the old m = 64 the node would have made 7680 x 3968, which fits: the
        // run would have gone through on a silently shrunk crop and left 20 px of the width and 32 px of the height
        // without the pass. The pass prefers the whole picture and says so over a crop the user did not choose.
        const got2 = pass(7700, 4000, 7700, 4000);
        check("a whole 7700 x 4000 picture at m 2: 7700 x 4000, refused at 1x (the long side 7700 > 7680)", R.fitSpan(7700, 7700, 2) === 7700 && R.fitSpan(4000, 4000, 2) === 4000 && got2 === large(7700, 4000), JSON.stringify(got2));
        const w64 = R.fitSpan(7700, 7700, 64), h64 = R.fitSpan(4000, 4000, 64);
        check("the same picture at the old m 64 would be 7680 x 3968 and fit: the pass's m 2 refuses where m 64 accepted", w64 === 7680 && h64 === 3968 && R.fits(w64, h64) === "" && got2 !== "", `${w64} x ${h64}, fits '${R.fits(w64, h64)}'`);
        const got3 = pass(6000, 4000, 6000, 4000);
        check("a whole 6000 x 4000 picture at m 2: 6000 x 4000, fits (no border; at m 64 it would be 5952 x 3968)", got3 === "" && R.fitSpan(6000, 6000) === 6000 && R.fitSpan(4000, 4000) === 4000
            && R.fitSpan(6000, 6000, 64) === 5952 && R.fitSpan(4000, 4000, 64) === 3968, JSON.stringify(got3));
        const got4 = pass(4319, 4319, 6000, 4500);
        check("a 4319 x 4319 crop on 6000 x 4500: the node makes 4320 x 4320, which fits", R.fitSpan(4319, 6000) === 4320 && got4 === "", JSON.stringify(got4));
        const got5 = pass(4321, 4321, 6000, 4500);
        check("a 4321 x 4321 crop on 6000 x 4500: 4322 x 4322, refused (the short side)", got5 === large(4322, 4322), JSON.stringify(got5));
    }

    // ---- 5. passSettings -------------------------------------------------------------------------------------------
    console.log("\n--- 5. passSettings ---");
    const recipe = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", "realism_pass.json"), "utf8"));
    const rp = recipe.prompt && recipe.prompt.rp_settings && recipe.prompt.rp_settings.inputs;
    check("the recipe holds rp_settings, a DLSS5Settings node", !!rp && recipe.prompt.rp_settings.class_type === "DLSS5Settings", short(recipe.prompt && recipe.prompt.rp_settings));
    {
        const before = JSON.stringify(rp);
        const a = R.passSettings(rp, {});
        check("passSettings(inputs, {}) leaves every input as it is, in a new object", eq(a, rp) && a !== rp, short(a));
        const b = R.passSettings(rp);
        check("passSettings(inputs) without values: the same", eq(b, rp) && b !== rp, short(b));
        const d = R.passSettings(rp, { style: R.realismDefaults.style, intensity: R.realismDefaults.intensity, preset: R.realismDefaults.preset });
        check("passSettings with the defaults gives the recipe's inputs exactly (the user's template)", eq(d, rp), short(d));
        const n = R.passSettings(rp, { style: "Natural" });
        check("{ style: 'Natural' } writes nr_style and nothing else", n.nr_style === "Natural" && eq({ ...n, nr_style: rp.nr_style }, rp), short(n));
        const c = R.passSettings(rp, { style: "Cinematic", intensity: 0.4 });
        check("{ style: 'Cinematic', intensity: 0.4 } writes both, the model preset stays the recipe's (L)", c.nr_style === "Cinematic" && c.nr_intensity === 0.4 && c.dlss_model_preset === rp.dlss_model_preset && rp.dlss_model_preset === "L", short(c));
        check("intensity 1.5 is clamped to 1", R.passSettings(rp, { intensity: 1.5 }).nr_intensity === 1, String(R.passSettings(rp, { intensity: 1.5 }).nr_intensity));
        check("intensity -1 is clamped to 0", R.passSettings(rp, { intensity: -1 }).nr_intensity === 0, String(R.passSettings(rp, { intensity: -1 }).nr_intensity));
        check("intensity 0 stays 0, 1 stays 1", R.passSettings(rp, { intensity: 0 }).nr_intensity === 0 && R.passSettings(rp, { intensity: 1 }).nr_intensity === 1, "");
        check("intensity '0.5' (a string) is taken as 0.5", R.passSettings(rp, { intensity: "0.5" }).nr_intensity === 0.5, String(R.passSettings(rp, { intensity: "0.5" }).nr_intensity));
        const m = R.passSettings(rp, { preset: "M" });
        check("{ preset: 'M' } writes dlss_model_preset M", m.dlss_model_preset === "M", short(m));
        check("every preset of the pack's table is written as given", R.MODEL_PRESETS.every((p) => R.passSettings(rp, { preset: p }).dlss_model_preset === p), "");
        let e = keep(throws(() => R.passSettings(rp, { preset: "X" })));
        check("preset 'X' throws, naming it and the label", !!e && e.includes('"X"') && e.includes(L), e);
        e = keep(throws(() => R.passSettings(rp, { style: "Warm" })));
        check("style 'Warm' throws, naming it and the label", !!e && e.includes('"Warm"') && e.includes(L), e);
        e = keep(throws(() => R.passSettings(rp, { style: "natural" })));
        check("style 'natural' (wrong case) throws: the pack's combo is exact", !!e, e);
        e = keep(throws(() => R.passSettings(rp, { intensity: "strong" })));
        check("intensity 'strong' throws with the label", !!e && e.includes(L), e);
        const noPreset = { ...rp };
        delete noPreset.dlss_model_preset;
        const np = R.passSettings(noPreset, { style: "Natural", intensity: 0.5 });
        check("the model preset is not written when values do not name one", !("dlss_model_preset" in np), short(np));
        check("the input object is not mutated by any call", JSON.stringify(rp) === before, "");
        const fromNull = R.passSettings(null, { style: "Natural" });
        check("passSettings(null, { style }) gives { nr_style } alone", eq(fromNull, { nr_style: "Natural" }), short(fromNull));
    }

    // ---- 6. hint for every message of the pack (plan 3.4) ----------------------------------------------------------
    console.log("\n--- 6. hint, isPresetRefusal (plan 3.4, tools/refs/dlss5/messages.json) ---");
    const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs", "dlss5", "messages.json"), "utf8")).messages;
    const manual = `(Help › Manual › ${L})`;
    const feature18 = `${L}: DLSS 5 did not run its neural rendering on your ComfyUI. Another program may hold the GPU (a game, a video encoder): close it and try again.`;
    const versionText = `${L}: the installed runtime is not the version the pack expects (v3.0). Install it again with the address in the manual ${manual}.`;
    const presetText = (p) => `${L}: the runtime on your ComfyUI does not support DLSS model preset ${p}. Pick Default under DLSS model preset and Generate again.`;
    const crash = `${L}: the DLSS worker crashed on your ComfyUI's machine. Update the NVIDIA driver and install the DLSS 5 runtime again ${manual}.`;
    const generic = `${L} failed on your ComfyUI: `;
    /** The fixtures no branch of hint() knows: the first line in the generic sentence. */
    const GENERIC = new Set(["other", "worker_exit", "worker_timeout"]);
    const expected = {
        runtime_missing: `${L}: the DLSS 5 runtime is not installed on your ComfyUI. Install it there with the pack's install_runtime.py ${manual}.`,
        runtime_incomplete: `${L}: the DLSS 5 runtime on your ComfyUI is incomplete (missing: dxgi.dll, renodx-dlss5.addon64, nvngx_dlssnr.dll). Install it again ${manual}.`,
        no_driver: `${L}: your ComfyUI's machine shows no NVIDIA driver. It needs Windows, an RTX 30, 40 or 50 card and a current driver.`,
        gpu_outside: `${L}: NVIDIA GeForce RTX 2080 is not supported; it needs an RTX 30, 40 or 50 card.`,
        gpu_none: `${L}: your ComfyUI's machine shows no supported card; it needs an RTX 30, 40 or 50 card.`,
        ampere_pair: `${L}: on an RTX 30 card the pack needs its experimental Ampere runtime pair, and the installed runtime is not that pair (the pack's README).`,
        worker_blocked: `${L}: Windows Defender (or another antivirus) blocked the DLSS worker on your ComfyUI's machine. The pack's README says to add its runtime folder to the exclusions there ${manual}.`,
        protocol_setup: versionText,
        protocol_response: versionText,
        ngx_size: `${L}: DLSS refused this size (4096 × 2160). Try a smaller area, or update the NVIDIA driver.`,
        preset_refused: presetText("M"),
        preset_refused_l: presetText("L"),
        feature18_unverified: feature18,
        feature18_failed: feature18,
        feature18_crash: crash,
        feature18_crash_rtx30: `${crash} On an RTX 30 card the experimental runtime pair must match exactly and may still be unstable.`,
        too_large: `${L}: the picture is larger than 7680 × 4320.`,
        too_small: `${L} needs at least 64 px a side; this is 40 × 60.`,
        opencv: `${L}: the pack's Python packages are missing on your ComfyUI: install its requirements there ${manual}.`,
        other: `${generic}The native DLSS worker stopped on frame 0 (exit 3).`,
        worker_exit: `${generic}The native DLSS worker exited with code 3.`,
        worker_timeout: `${generic}The native DLSS worker did not exit within 60 seconds and was killed.`,
    };
    check("the fixtures hold 22 messages with distinct keys, one per expected sentence", fixtures.length === 22 && new Set(fixtures.map((f) => f.key)).size === fixtures.length
        && eq(fixtures.map((f) => f.key).sort(), Object.keys(expected).sort()), String(fixtures.length));
    for (const f of fixtures) {
        const got = keep(R.hint(f.text));
        const want = expected[f.key];
        check(`hint(${f.key}) is its sentence`, want !== undefined && got === want, JSON.stringify(got));
        // ComfyUI's execution_error carries "{}\n{}".format(ex, tips): str(exc) and a newline
        const sent = keep(R.hint(`${f.text}\n`));
        check(`hint(${f.key}) is the same for ComfyUI's exception_message (the text and a newline)`, sent === got, JSON.stringify(sent));
        if (f.files) check(`hint(${f.key}) names every missing file (${f.files.join(", ")}) in the pack's order`, f.files.every((n) => got.includes(n)) && got.includes(`missing: ${f.files.join(", ")})`) && !got.includes("C:\\"), got);
        if (f.gpu) check(`hint(${f.key}) names the card ${f.gpu}`, got.includes(f.gpu), got);
        if (f.size) check(`hint(${f.key}) names the size ${f.size}`, got.includes(f.size), got);
        if (f.preset) check(`hint(${f.key}) names the refused preset ${f.preset}`, got.includes(`model preset ${f.preset}.`), got);
        if (!GENERIC.has(f.key)) check(`hint(${f.key}) is not the generic 'failed on your ComfyUI'`, !got.startsWith(generic), got);
        else check(`hint(${f.key}) is the generic sentence on the first line, no colon before its one period`, got.startsWith(generic) && !/:\.$/.test(got) && !got.includes("\n"), got);
        check(`hint(${f.key}) ends with exactly one period`, /[^.]\.$/.test(got), got);
        const refusal = /^preset_refused/.test(f.key);
        check(`isPresetRefusal(${f.key}) is ${refusal}`, R.isPresetRefusal(f.text) === refusal, "");
    }
    {
        const pick = (k) => fixtures.find((f) => f.key === k);
        check("the fixtures are the pack's own spellings: the worker nvngx.dll, preset 'Default (0)', the FEATURE_18_MARKERS names",
            pick("worker_blocked").text.includes("\\runtime\\nvngx.dll could not be started")
            && pick("preset_refused").text.includes("model preset Default (0) instead of the requested M.")
            && ["signed DLSSNR runtime initialized", "feature 18 created", "feature 18 evaluated"].every((n) => pick("feature18_unverified").text.includes(`\n  ${n}`)), "");
        const crash30 = pick("feature18_crash_rtx30").text;
        check("feature18_crash_rtx30 holds the pack's RTX 30 hint line, feature18_crash the driver line instead",
            crash30.includes("\nRTX 30 is the experimental path;") && !pick("feature18_crash").text.includes("RTX 30 is the experimental path")
            && pick("feature18_crash").text.includes("\nUpdate the NVIDIA driver and make sure the runtime files"), "");
    }
    {
        const inc = fixtures.find((f) => f.key === "runtime_incomplete");
        const crlf = inc.text.replace(/\n/g, "\r\n");
        const got = keep(R.hint(crlf));
        check("runtime_incomplete with Windows line ends (CR LF): the same sentence", got === expected.runtime_incomplete, JSON.stringify(got));
        const kText = "The worker applied DLSS model preset Default (0) instead of the requested K. This runtime does not support that model. Set dlss_model_preset to Default.";
        const preset = keep(R.hint(kText));
        check("a refusal of preset K (the pack's text) names K", preset === presetText("K") && R.isPresetRefusal(kText), preset);
        const jText = "The worker applied DLSS model preset K (11) instead of the requested J. This runtime does not support that model. Set dlss_model_preset to Default.";
        const presetJ = keep(R.hint(jText));
        check("a runtime that applied K (11) for a requested J: names J, the asked one", presetJ === presetText("J"), presetJ);
        const crashLf = keep(R.hint(fixtures.find((f) => f.key === "feature18_crash_rtx30").text.replace(/\n/g, "\r\n")));
        check("feature18_crash_rtx30 with CR LF: the same sentence", crashLf === expected.feature18_crash_rtx30, crashLf);
        const exitNoLog = keep(R.hint("The native DLSS worker exited with code 3:\n"));
        check("worker_exit without a worker log ('...code 3:' and an empty line): '...exited with code 3.'", exitNoLog === expected.worker_exit, exitNoLog);
        const noFirst = keep(R.hint("\n\n   Something broke in the worker...  \nsecond line"));
        check("an unknown text: the first non-empty line, trailing dots trimmed, one final period", noFirst === `${generic}Something broke in the worker.`, JSON.stringify(noFirst));
        const plain = keep(R.hint("Boom"));
        check("an unknown one-word text: '... failed on your ComfyUI: Boom.'", plain === `${generic}Boom.`, JSON.stringify(plain));
        const empty = keep(R.hint(""));
        check("an empty message: '... failed on your ComfyUI: no message.'", empty === `${generic}no message.`, JSON.stringify(empty));
        const undef = keep(R.hint(undefined));
        check("hint(undefined) does not throw: '... no message.'", undef === `${generic}no message.`, JSON.stringify(undef));
        const tooSmallFits = R.fits(40, 60);
        check("hint(too_small) says what fits(40, 60) says before queueing", tooSmallFits === expected.too_small, JSON.stringify(tooSmallFits));
    }
    check("isPresetRefusal('') and (undefined) are false", R.isPresetRefusal("") === false && R.isPresetRefusal(undefined) === false, "");

    // ---- 7. isPassNode --------------------------------------------------------------------------------------------
    console.log("\n--- 7. isPassNode ---");
    check("DLSS5EnhanceImages and DLSS5Settings are pass nodes", R.isPassNode("DLSS5EnhanceImages") === true && R.isPassNode("DLSS5Settings") === true, "");
    check("DLSS5EnhanceVideoFile, InpaintCanvas, a lower-case name, '' and undefined are not", [
        "DLSS5EnhanceVideoFile", "InpaintCanvas", "dlss5settings", "", undefined, null,
    ].every((n) => R.isPassNode(n) === false), "");

    // ---- 8. fillValues (settings.realism filled per key) -----------------------------------------------------------
    console.log("\n--- 8. fillValues ---");
    const D = { style: "Default", intensity: 1, preset: "L", timeout: 300 };
    const fillCases = [
        ["undefined", undefined, D],
        ["null", null, D],
        ["{}", {}, D],
        ["{ style: 'Natural' } (partial)", { style: "Natural" }, { ...D, style: "Natural" }],
        ["{ preset: 'M', timeout: 600 } (partial)", { preset: "M", timeout: 600 }, { ...D, preset: "M", timeout: 600 }],
        ["every key valid", { style: "Cinematic", intensity: 0.25, preset: "K", timeout: 900 }, { style: "Cinematic", intensity: 0.25, preset: "K", timeout: 900 }],
        ["every key bad (Warm, 7, X, 0)", { style: "Warm", intensity: 7, preset: "X", timeout: 0 }, D],
        ["NaN and strings", { style: 5, intensity: NaN, preset: null, timeout: "300" }, D],
        ["intensity '0.5' as a string", { intensity: "0.5" }, D],
        ["Infinity", { intensity: Infinity, timeout: Infinity }, D],
        ["the bounds: intensity 0, timeout 30", { intensity: 0, timeout: 30 }, { ...D, intensity: 0, timeout: 30 }],
        ["the bounds: intensity 1, timeout 3600", { intensity: 1, timeout: 3600 }, { ...D, intensity: 1, timeout: 3600 }],
        ["just outside: intensity -0.01, timeout 29", { intensity: -0.01, timeout: 29 }, D],
        ["just outside: intensity 1.01, timeout 3601", { intensity: 1.01, timeout: 3601 }, D],
        ["an array", ["Natural", 0.5], D],
        ["an array with a style property", Object.assign(["x"], { style: "Natural" }), D],
        ["a string", "Natural", D],
        ["a number", 7, D],
        ["preset Default (a valid choice)", { preset: "Default" }, { ...D, preset: "Default" }],
    ];
    for (const [what, stored, want] of fillCases) {
        const got = R.fillValues(stored);
        check(`fillValues(${what})`, eq(got, want), short(got));
    }
    {
        const stored = { style: "Natural", intensity: 9, extra: true };
        const snap = JSON.stringify(stored);
        const got = R.fillValues(stored);
        check("fillValues does not mutate what it was given", JSON.stringify(stored) === snap, "");
        check("fillValues answers exactly the four keys of the defaults", eq(Object.keys(got).sort(), Object.keys(D).sort()), short(Object.keys(got)));
        const twice = R.fillValues(R.fillValues({ style: "Cinematic", timeout: 5 }));
        check("fillValues of a filled object is itself", eq(twice, R.fillValues({ style: "Cinematic", timeout: 5 })), short(twice));
        check("fillValues(realismDefaults) is the defaults", eq(R.fillValues(R.realismDefaults), D), "");
    }

    // ---- 9. the defaults against the recipe and settings.js ---------------------------------------------------------
    console.log("\n--- 9. the defaults: recipes/realism_pass.json and settings.js DEFAULTS.realism ---");
    check("the recipe's id is RECIPE_ID, its name LABEL exactly, its task 'pass'", recipe.id === R.RECIPE_ID && recipe.name === EXACT_LABEL && recipe.task === "pass", short([recipe.id, recipe.name, recipe.task]));
    check("the recipe's description holds LABEL verbatim", typeof recipe.description === "string" && recipe.description.includes(L), "");
    check("realismDefaults.style equals the recipe's nr_style", R.realismDefaults.style === rp.nr_style, short([R.realismDefaults.style, rp.nr_style]));
    check("realismDefaults.intensity equals the recipe's nr_intensity", R.realismDefaults.intensity === rp.nr_intensity, short([R.realismDefaults.intensity, rp.nr_intensity]));
    check("realismDefaults.preset equals the recipe's dlss_model_preset (L)", R.realismDefaults.preset === rp.dlss_model_preset, short([R.realismDefaults.preset, rp.dlss_model_preset]));
    check("the recipe's DLSS5Settings values are valid in the pack's tables", R.STYLES.includes(rp.nr_style) && R.MODEL_PRESETS.includes(rp.dlss_model_preset) && rp.nr_intensity >= 0 && rp.nr_intensity <= 1, short(rp));
    {
        const row = (recipe.settings || []).find((s) => s.node === "rp_settings" && s.input === "dlss_model_preset");
        check("the recipe's Settings row is the model preset with the pack's table as its spec", !!row && Array.isArray(row.spec) && eq(row.spec[0], R.MODEL_PRESETS), short(row));
        const names = (recipe.presets || []).map((p) => p.name);
        check("the recipe ships the presets L and M", eq(names, ["L", "M"]), short(names));
        check("each shipped preset sets the model preset to its own name", (recipe.presets || []).every((p) => p.values && p.values["rp_settings:dlss_model_preset"] === p.name && Object.keys(p.values).length === 1), short(recipe.presets));
        check("the default preset (L) is one of the shipped presets", names.includes(R.realismDefaults.preset), "");
        const classes = Object.values(recipe.prompt).map((n) => n.class_type);
        check("the recipe's graph holds both NODES, and its needs list them", R.NODES.every((n) => classes.includes(n) && (recipe.needs || []).includes(n)), short([classes, recipe.needs]));
        const passNodes = Object.values(recipe.prompt).filter((n) => R.isPassNode(n.class_type)).length;
        check("isPassNode finds the recipe's two DLSS nodes", passNodes === 2, String(passNodes));
    }
    {
        // electron/main/settings.js without Electron: only app.getPath("userData") is asked (settings_migration_test.js)
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-realism-"));
        const load = Module._load;
        Module._load = function (request, parent, isMain) {
            if (request === "electron") return { app: { getPath: () => dir } };
            return load.call(this, request, parent, isMain);
        };
        let S = null, err = null;
        try { S = require(path.join(ROOT, "electron", "main", "settings.js")); } catch (e) { err = e; }
        finally { Module._load = load; }
        check("electron/main/settings.js loads with electron stood in for", !!S && !!S.DEFAULTS, err ? String(err && err.message) : "");
        const sr = S && S.DEFAULTS && S.DEFAULTS.realism;
        check("settings.js DEFAULTS.realism equals realismDefaults", eq(sr, R.realismDefaults), short(sr));
        check("settings.js DEFAULTS.realism passes fillValues unchanged", eq(R.fillValues(sr), sr), short(R.fillValues(sr)));
        let fresh = null;
        try { fresh = S && S.get && S.get().realism; } catch (e) { fresh = String(e && e.message); }
        check("a fresh profile reads the defaults (settings.get().realism)", eq(fresh, R.realismDefaults), short(fresh));
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* a temp folder */ }
    }

    // ---- 10. the label in every text ------------------------------------------------------------------------------
    console.log("\n--- 10. the label in every text ---");
    const missing = texts.filter((t) => !t.includes(EXACT_LABEL));
    check(`every non-empty text of serverSupport, fits, hint and passSettings (${texts.length}) holds the label verbatim`, texts.length > 60 && missing.length === 0, short(missing.slice(0, 3)));

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
