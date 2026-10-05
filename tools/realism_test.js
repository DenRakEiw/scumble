// The Realism Pass (item 37, docs/PLAN_0_1_42.md R1 "Tests"), in plain Node, no Electron, no ComfyUI and no network:
//   node tools/realism_test.js
// renderer/editor/realism.js (an ES module, imported as tools/boxes_test.js imports renderer/editor/boxes.js) is the
// API under test: the GPU generation by the pack's rule, the server check of plan table 3.3 on ComfyUI's torch devices
// (only cuda devices count; none listed is left to the pack), the size check of 3.5 against the pack's even rounding
// and its 7680 x 4320 cap, plus the measured 27.9 MP area cap (MAX_AREA, R-U's live look), the crop span the canvas node makes at the pass's multiple of 2 (fitSpan against the node's
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
 * What the pass takes: the pack's rule and the output's area at most 27,878,400 px (7040 x 3960; measured on
 * 2026-10-04, from 31.8 MP up the runtime answered broken colours without an error, at 30.4 MP about 1 run in 7; 27.9 MP
 * was clean, a margin below that border).
 */
function passAccepts(w, h, factor) {
    return packAccepts(w, h, factor) && packEven(w * factor) * packEven(h * factor) <= 27878400;
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
    check("the area cap: 27,878,400 px (7040 x 3960, a margin below the 30.4 MP that failed sometimes), named '7680 × 4320 and 27.9 megapixels'", R.MAX_AREA === 27878400 && R.MAX_AREA === 7040 * 3960 && R.CAP_TEXT === "7680 × 4320 and 27.9 megapixels", short([R.MAX_AREA, R.CAP_TEXT]));
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
            && s.reason === `${L}: your ComfyUI lacks its nodes (DLSS5Settings): install the ComfyUI-DLSS5-Enhancer node pack there (Help › Scumble help › ${L}).`, short(s));
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
    const large = (w, h) => `${L} takes at most 7680 × 4320 (long × short side) and 27.9 megapixels; this is ${w} × ${h}.`;
    const fitCases = [
        [63, 100, undefined, small(63, 100)],
        [100, 63, undefined, small(100, 63)],
        [64, 64, undefined, ""],
        [7680, 4320, undefined, large(7680, 4320)],        // within the pack's cap, past the area (33.2 MP)
        [4320, 7680, undefined, large(4320, 7680)],
        [7040, 3960, undefined, ""],                       // the area cap itself (27.9 MP)
        [3960, 7040, undefined, ""],
        [7040, 4320, undefined, large(7040, 4320)],        // 30.4 MP: failed about 1 run in 7 live
        [7680, 3960, undefined, large(7680, 3960)],        // 7680 wide at 30.4 MP
        [7680, 3630, undefined, ""],                       // 7680 wide at 27.9 MP
        [7041, 3960, undefined, large(7041, 3960)],        // padded to 7042: past the area
        [4320, 4320, undefined, ""],
        [7681, 100, undefined, large(7681, 100)],
        [100, 7681, undefined, large(100, 7681)],
        [4321, 4321, undefined, large(4321, 4321)],
        [7680, 4321, undefined, large(7680, 4321)],
        [7679, 4319, undefined, large(7679, 4319)],        // the pack rounds them up to 7680 x 4320: past the area
        [64, 64, 1, ""],
        [7681, 100, 1, large(7681, 100)],
        [3840, 2160, 2, large(7680, 4320)],                // an upscale names the output it would make
        [3520, 2160, 2, large(7040, 4320)],                // 7040 x 4320, 30.4 MP
        [3520, 1980, 2, ""],                               // 7040 x 3960
        [3840, 2160, 3, large(11520, 6480)],
        [2560, 1440, 3, large(7680, 4320)],
        [2346, 1440, 3, large(7038, 4320)],
        [2346, 1320, 3, ""],                               // 7038 x 3960
        [2561, 1440, 3, large(7684, 4320)],
        [5120, 2880, 1.5, large(7680, 4320)],
        [5121, 2880, 1.5, large(7682, 4320)],              // 7681.5 rounds to 7682 the pack's way
        [5119, 2880, 1.5, large(7678, 4320)],              // 7678.5 rounds to 7678: the pack's cap holds, the area not
        [4693, 2880, 1.5, large(7040, 4320)],
        [4693, 2640, 1.5, ""],                             // 7040 x 3960 (7039.5 rounds up)
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
                    if (got !== passAccepts(w, h, f)) { bad = [w, h, f, R.fits(w, h, f)]; break; }
                }
                if (bad) break;
            }
            if (bad) break;
        }
        check("fits agrees with the pack's own rule (even rounding, 7680 x 4320, 64 px) plus the 27.9 MP area over a grid of sizes at 1, 1.5, 1.724, 2 and 3", !bad, short(bad));
    }
    {
        // the live look of 2026-10-04 (RTX 5090, ComfyUI 0.38.0, pack 1.1.0, runtime v3.0): [output w, h, the picture
        // that made it, the factor, the answer was right]; fits takes exactly the outputs that came back right
        const live = [
            [5456, 3072, 5456, 3072, 1, true], [6400, 3600, 3200, 1800, 2, true], [7040, 3960, 3520, 1980, 2, true],
            [7680, 3960, 3840, 1980, 2, false], [7040, 4320, 3520, 2160, 2, false], [7352, 4136, 3676, 2068, 2, false],
            [7360, 4320, 3680, 2160, 2, false],
            [7520, 4320, 3760, 2160, 2, false], [7672, 4320, 5114, 2880, 1.5, false], [7680, 4320, 3840, 2160, 2, false],
            [7680, 4320, 7680, 4320, 1, false],
        ];
        // 7680 x 3960, 7040 x 4320 and 7352 x 4136 (30.4 MP) came back right in most runs but broken in about 1 of 7
        // near that area: refused with a margin, as the broken ones are
        const off = live.filter(([ow, oh, w, h, f, right]) => !eq(R.outputSize(w, h, f), { w: ow, h: oh }) || (R.fits(w, h, f) === "") !== right);
        check("fits takes the live look's answers up to 27.9 MP and refuses the 30.4 MP ones (broken about 1 in 7) and the broken ones from 31.8 MP up", off.length === 0, short(off));
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
        check("the same picture at the old m 64 would be 7680 x 3968, which the pack's caps take (the 27.9 MP area does not since R-U's live look): the pass's m 2 refuses", w64 === 7680 && h64 === 3968 && packAccepts(w64, h64, 1) && R.fits(w64, h64) === large(7680, 3968) && got2 !== "", `${w64} x ${h64}, fits '${R.fits(w64, h64)}'`);
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
    const manual = `(Help › Scumble help › ${L})`;
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
        opencv: `${L}: your ComfyUI's Python has no OpenCV, which the pack needs: install opencv-python there (or opencv-contrib-python if you already use it) ${manual}.`,
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

    // ---- 9b. the pass on a picture (R2a: passPrompt, evenPlan, the pixel helpers, runFailure) ----------------------
    console.log("\n--- 9b. the pass on a picture (R2a) ---");
    /** Key order is not part of a prompt: compare objects by their sorted entries. */
    const sortedEntries = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort().map((k) => [k, o[k]]) : o);
    const same = (a, b) => eq(sortedEntries(a), sortedEntries(b));
    {
        check("PASS_MODE is '1x (DLAA / native)', PASS_OUTPUT 'rp_out', FLATTEN_GREY 128", R.PASS_MODE === "1x (DLAA / native)" && R.PASS_OUTPUT === "rp_out" && R.FLATTEN_GREY === 128,
            short([R.PASS_MODE, R.PASS_OUTPUT, R.FLATTEN_GREY]));
        check("SETTINGS_DEFAULTS equals the recipe's rp_settings inputs (same keys, same values)", same(R.SETTINGS_DEFAULTS, rp), short(R.SETTINGS_DEFAULTS));
        check("SETTINGS_DEFAULTS is frozen", Object.isFrozen(R.SETTINGS_DEFAULTS), "");
        check("PASS_MODE equals the recipe's upscaling_mode", R.PASS_MODE === rp.upscaling_mode, short([R.PASS_MODE, rp.upscaling_mode]));
    }
    // evenPlan
    for (const [w, h, w2, h2] of [[641, 481, 642, 482], [640, 480, 640, 480], [1, 1, 2, 2], [63, 41, 64, 42]]) {
        const got = R.evenPlan(w, h);
        check(`evenPlan(${w}, ${h}) is ${w2} x ${h2}`, eq(got, { w2, h2 }), short(got));
    }
    // passPrompt
    {
        const before = JSON.stringify(recipe);
        const ref = { filename: "a.png", subfolder: "inpaint_canvas", type: "input" };
        const p = R.passPrompt(recipe, { style: "Natural", intensity: 0.5, preset: "M" }, ref);
        check("passPrompt makes exactly the four nodes rp_enhance, rp_in, rp_out, rp_settings", eq(Object.keys(p).sort(), ["rp_enhance", "rp_in", "rp_out", "rp_settings"]), short(Object.keys(p)));
        check("the answer node is PASS_OUTPUT", R.PASS_OUTPUT in p, "");
        check("each node's class_type: InpaintCanvasLoadRef, DLSS5Settings, DLSS5EnhanceImages, PreviewImage",
            p.rp_in.class_type === "InpaintCanvasLoadRef" && p.rp_settings.class_type === "DLSS5Settings"
            && p.rp_enhance.class_type === "DLSS5EnhanceImages" && p.rp_out.class_type === "PreviewImage",
            short(Object.values(p).map((n) => n.class_type)));
        check("rp_in's inputs are exactly the ref as JSON", eq(p.rp_in.inputs, { ref: '{"filename":"a.png","subfolder":"inpaint_canvas","type":"input"}' }), short(p.rp_in.inputs));
        check("rp_enhance's inputs are exactly images, settings and verify_neural_rendering", eq(p.rp_enhance.inputs, { images: ["rp_in", 0], settings: ["rp_settings", 0], verify_neural_rendering: true }), short(p.rp_enhance.inputs));
        check("rp_out's inputs are exactly the enhanced images", eq(p.rp_out.inputs, { images: ["rp_enhance", 0] }), short(p.rp_out.inputs));
        check("rp_settings is SETTINGS_DEFAULTS with nr_style Natural, nr_intensity 0.5, dlss_model_preset M",
            same(p.rp_settings.inputs, { ...R.SETTINGS_DEFAULTS, nr_style: "Natural", nr_intensity: 0.5, dlss_model_preset: "M" }), short(p.rp_settings.inputs));
        check("passPrompt does not mutate the recipe", JSON.stringify(recipe) === before, "");

        const e0 = R.passPrompt(recipe, {}, ref);
        check("values {}: rp_settings equals the recipe's inputs", same(e0.rp_settings.inputs, rp), short(e0.rp_settings.inputs));
        const e1 = R.passPrompt(recipe, undefined, ref);
        check("values undefined: rp_settings equals the recipe's inputs", same(e1.rp_settings.inputs, rp), short(e1.rp_settings.inputs));
        const n0 = R.passPrompt(null, {}, ref);
        check("recipe null: rp_settings equals SETTINGS_DEFAULTS", same(n0.rp_settings.inputs, R.SETTINGS_DEFAULTS), short(n0.rp_settings.inputs));
        const n1 = R.passPrompt(null, undefined, ref);
        check("recipe null and values undefined: rp_settings equals SETTINGS_DEFAULTS", same(n1.rp_settings.inputs, R.SETTINGS_DEFAULTS), short(n1.rp_settings.inputs));

        // a user's copy: the DLSS5Settings node under another id, set to 2x, its strength wired to a node, its own runtime
        const user = JSON.parse(JSON.stringify(recipe));
        const node = user.prompt.rp_settings;
        delete user.prompt.rp_settings;
        user.prompt["12"] = { ...node, inputs: { ...node.inputs, upscaling_mode: "2x (Performance)", nr_intensity: ["x", 0], runtime_dir: "D:/rt" } };
        const userBefore = JSON.stringify(user);
        const u = R.passPrompt(user, {}, ref).rp_settings.inputs;
        check("a user copy at 2x: upscaling_mode back to PASS_MODE", u.upscaling_mode === R.PASS_MODE, short(u.upscaling_mode));
        check("a user copy with nr_intensity wired to a node (an array): back to the default 1", u.nr_intensity === 1, short(u.nr_intensity));
        check("a user copy's runtime_dir 'D:/rt' is kept", u.runtime_dir === "D:/rt", short(u.runtime_dir));
        check("a user copy: every other input is the recipe's", same(u, { ...rp, runtime_dir: "D:/rt" }), short(u));
        check("a user copy is not mutated", JSON.stringify(user) === userBefore, "");
        const u2 = R.passPrompt(user, { intensity: 0.3 }, ref).rp_settings.inputs;
        check("a user copy with the strength wired: values' intensity 0.3 is written", u2.nr_intensity === 0.3, short(u2.nr_intensity));

        const b = R.passPrompt(recipe, {}, { filename: "b.png" });
        check("a ref without subfolder and type: subfolder '' and type 'input'", eq(b.rp_in.inputs, { ref: '{"filename":"b.png","subfolder":"","type":"input"}' }), short(b.rp_in.inputs));
        const ex = keep(throws(() => R.passPrompt(recipe, { preset: "X" }, ref)));
        check("values { preset: 'X' } throws, naming the label", !!ex && ex.includes(L), ex);
        const c = R.passPrompt(recipe, { intensity: 1.5 }, ref).rp_settings.inputs;
        check("values { intensity: 1.5 } is clamped to 1", c.nr_intensity === 1, short(c.nr_intensity));
    }
    // hasAlpha
    {
        const opaque = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]);
        check("hasAlpha on an all-opaque picture is false", R.hasAlpha(opaque) === false, "");
        const one = Uint8ClampedArray.from(opaque);
        one[7] = 254;
        check("hasAlpha with one alpha of 254 is true", R.hasAlpha(one) === true, "");
        const rgbLow = Uint8ClampedArray.from(opaque);
        rgbLow[0] = 0; rgbLow[5] = 0;
        check("hasAlpha reads only the alpha bytes (low colour bytes are not alpha)", R.hasAlpha(rgbLow) === false, "");
        check("hasAlpha on an empty array is false", R.hasAlpha(new Uint8ClampedArray(0)) === false, "");
    }
    // prepPixels
    {
        // a 3 x 3 picture, a distinct colour per pixel, opaque
        const src = new Uint8ClampedArray(3 * 3 * 4);
        for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
            const i = (y * 3 + x) * 4;
            src[i] = 10 + x * 30 + y * 7; src[i + 1] = 200 - x * 11 - y * 40; src[i + 2] = 50 + x * 3 + y * 60; src[i + 3] = 255;
        }
        const srcBefore = Array.from(src);
        const r = R.prepPixels(src, 3, 3, false);
        check("prepPixels(3 x 3): padded to 4 x 4, a Uint8ClampedArray of 4 x 4 x 4", r.w2 === 4 && r.h2 === 4 && r.data instanceof Uint8ClampedArray && r.data.length === 64, short([r.w2, r.h2, r.data && r.data.length]));
        let bad = null;
        for (let y = 0; y < 4 && !bad; y++) for (let x = 0; x < 4 && !bad; x++) {
            const s = (Math.min(y, 2) * 3 + Math.min(x, 2)) * 4, d = (y * 4 + x) * 4;
            const got = Array.from(r.data.slice(d, d + 4)), want = [src[s], src[s + 1], src[s + 2], 255];
            if (!eq(got, want)) bad = { x, y, got, want };
        }
        check("prepPixels(3 x 3): every pixel is the source's at (min(x, 2), min(y, 2)), opaque (the last column and row repeated)", !bad, short(bad));
        check("prepPixels does not mutate the source", eq(Array.from(src), srcBefore), "");

        // flatten onto the grey: a 3 x 1 picture, opaque, transparent, half
        const fl = new Uint8ClampedArray([200, 100, 50, 255, 200, 100, 50, 0, 200, 100, 50, 128]);
        const f = R.prepPixels(fl, 3, 1, true);
        const px = (i) => Array.from(f.data.slice(i * 4, i * 4 + 4));
        const a = 128 / 255;
        const half = new Uint8ClampedArray(4);
        half[0] = 200 * a + R.FLATTEN_GREY * (1 - a); half[1] = 100 * a + R.FLATTEN_GREY * (1 - a); half[2] = 50 * a + R.FLATTEN_GREY * (1 - a); half[3] = 255;
        check("prepPixels(3 x 1, flatten): padded to 4 x 2", f.w2 === 4 && f.h2 === 2 && f.data.length === 32, short([f.w2, f.h2, f.data.length]));
        check("flatten: an opaque pixel keeps its colour (200, 100, 50, 255)", eq(px(0), [200, 100, 50, 255]), short(px(0)));
        check("flatten: a transparent pixel becomes the grey (128, 128, 128, 255)", eq(px(1), [128, 128, 128, 255]), short(px(1)));
        check(`flatten: a half-transparent pixel is c * a + 128 * (1 - a), opaque (${Array.from(half)})`, eq(px(2), Array.from(half)), short(px(2)));
        check("flatten: the pad column (pixel 3) equals pixel 2", eq(px(3), px(2)), short(px(3)));
        check("flatten: the pad row (row 1) equals row 0", eq(Array.from(f.data.slice(16, 32)), Array.from(f.data.slice(0, 16))), short(Array.from(f.data.slice(16, 32))));

        // an even 2 x 2 picture: same size, the colours copied, every alpha opaque (no flatten)
        const ev = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 0, 7, 8, 9, 128, 250, 251, 252, 255]);
        const e = R.prepPixels(ev, 2, 2, false);
        let rgbSame = e.data.length === 16;
        for (let i = 0; i < 4 && rgbSame; i++) rgbSame = e.data[i * 4] === ev[i * 4] && e.data[i * 4 + 1] === ev[i * 4 + 1] && e.data[i * 4 + 2] === ev[i * 4 + 2];
        check("prepPixels(2 x 2): unchanged in size, the same RGB", e.w2 === 2 && e.h2 === 2 && rgbSame, short([e.w2, e.h2, Array.from(e.data)]));
        check("prepPixels(2 x 2) without flatten: every alpha 255, the colours under transparent pixels copied as they are", [3, 7, 11, 15].every((i) => e.data[i] === 255), short(Array.from(e.data)));
    }
    // putAlphaBack
    {
        // the answer 4 x 2, a distinct RGB per pixel, opaque
        const ans = new Uint8ClampedArray(4 * 2 * 4);
        for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) {
            const i = (y * 4 + x) * 4;
            ans[i] = 11 + x * 20 + y * 100; ans[i + 1] = 22 + x * 20 + y * 100; ans[i + 2] = 33 + x * 20 + y * 100; ans[i + 3] = 255;
        }
        const source = new Uint8ClampedArray([1, 1, 1, 0, 2, 2, 2, 128, 3, 3, 3, 255]);
        const out = R.putAlphaBack(ans, 4, 2, source, 3, 1);
        check("putAlphaBack(4 x 2 answer, 3 x 1 source): a Uint8ClampedArray of 3 x 1 x 4", out instanceof Uint8ClampedArray && out.length === 12, short(out && out.length));
        const rgb = [0, 1, 2].map((x) => Array.from(out.slice(x * 4, x * 4 + 3)));
        // alpha 0 and 255 keep the answer's colour; alpha 128 gets prepPixels' grey taken out: (p - 128 (1 - k)) / k
        const k = 128 / 255, unmix = (p) => { const c = new Uint8ClampedArray(1); c[0] = (p - 128 * (1 - k)) / k; return c[0]; };
        const wantRgb = [0, 1, 2].map((x) => Array.from(ans.slice(x * 4, x * 4 + 3)).map((p) => (x === 1 ? unmix(p) : p)));
        check("putAlphaBack: the RGB is the answer's row 0, columns 0 to 2, the half-transparent one with the grey taken out", eq(rgb, wantRgb), short([rgb, wantRgb]));
        // the round trip: what prepPixels flattened comes back as the source's own colour when the pass changes nothing
        const src2 = new Uint8ClampedArray([200, 30, 30, 0, 30, 200, 90, 128, 250, 10, 60, 1, 17, 34, 51, 255, 90, 180, 240, 200, 5, 5, 5, 64]);
        const flat = R.prepPixels(src2, 3, 2, true);
        const back = R.putAlphaBack(flat.data, flat.w2, flat.h2, src2, 3, 2);
        let worst = 0;
        for (let i = 0; i < 6; i++) {
            const a = src2[i * 4 + 3];
            // alpha 0 carries no colour, alpha 1 almost none (8-bit rounding of c / 255)
            if (a < 8) continue;
            for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(back[i * 4 + c] - src2[i * 4 + c]));
        }
        check("putAlphaBack after prepPixels with an unchanged answer: the colours of pixels with alpha 64 to 255 come back within 1 level", worst <= 1, String(worst));
        const ab = [0, 1, 2, 3, 4, 5].map((i) => back[i * 4 + 3]);
        check("putAlphaBack after prepPixels: the alpha is the source's", eq(ab, [0, 128, 1, 255, 200, 64]), short(ab));
        const alpha = [0, 1, 2].map((x) => out[x * 4 + 3]);
        check("putAlphaBack: the alpha is the source's [0, 128, 255]", eq(alpha, [0, 128, 255]), short(alpha));
        const e = keep(throws(() => R.putAlphaBack(ans, 2, 2, source, 3, 1)));
        check("putAlphaBack with an answer narrower than the source (2 < 3) throws, naming the label", !!e && e.includes(L), e);
        const e2 = keep(throws(() => R.putAlphaBack(ans, 4, 1, new Uint8ClampedArray(3 * 2 * 4), 3, 2)));
        check("putAlphaBack with an answer lower than the source (1 < 2) throws, naming the label", !!e2 && e2.includes(L), e2);
    }
    // runFailure
    {
        const tm = `${L}: no answer from your ComfyUI within 300 seconds.`;
        const t = keep(R.runFailure({ kind: "timeout", message: tm }));
        check("runFailure of a timeout whose message holds the label: the message unchanged", t === tm, JSON.stringify(t));
        const rtMsg = "No DLSS 5 runtime was found. Searched:\n x";
        const r1 = keep(R.runFailure({ kind: "error", message: rtMsg }));
        check("runFailure of kind 'error': hint(message)", r1 === R.hint(rtMsg) && r1.includes("runtime is not installed"), JSON.stringify(r1));
        const r2 = keep(R.runFailure({ kind: "cancelled", message: "ComfyUI cancelled." }));
        check("runFailure of a kind other than 'error' without the label: falls back to hint", r2 === R.hint("ComfyUI cancelled."), JSON.stringify(r2));
        const r3 = keep(R.runFailure(new Error("boom")));
        check("runFailure of a plain Error('boom'): hint('boom')", r3 === R.hint("boom"), JSON.stringify(r3));
        // the runner's own kind 'error' texts start with the label: not wrapped a second time
        const own = `${L}: the answer could not be fetched from your ComfyUI (404).`;
        const r4 = keep(R.runFailure({ kind: "error", message: own }));
        check("runFailure of kind 'error' whose message starts with the label: the message unchanged (no doubled label)", r4 === own && r4.split(L).length === 2, JSON.stringify(r4));
        const r5 = keep(R.runFailure({ kind: "error", message: `The worker said: ${L}` }));
        check("runFailure of a message that holds the label later on: hint", r5 === R.hint(`The worker said: ${L}`), JSON.stringify(r5));
    }
    // presetFallbackNote, versionAtLeast
    {
        const n = keep(R.presetFallbackNote("M"));
        check("presetFallbackNote: names the refused preset, Default and the recipe's own row", n.startsWith(`${L}: the runtime on your ComfyUI refused DLSS model preset M`) && n.includes("Default from now on") && n.includes("recipe keeps its own DLSS model preset row"), JSON.stringify(n));
        const cases = [["0.38.0", true], ["0.3.57", true], ["v0.3.57", true], ["0.3.56", false], ["0.3.9", false], ["0.4.0", true], ["1.0", true], ["", false], [undefined, false], ["dev", false]];
        const bad = cases.filter(([v, want]) => R.versionAtLeast(v, "0.3.57") !== want);
        check("versionAtLeast(v, 0.3.57) for 10 versions (an unknown one is not)", bad.length === 0, short(bad));
    }

    // ---- 9c. topFilterRun (R3a: where the whole-picture pass reads up to and lands) -----------------------------------
    console.log("\n--- 9c. topFilterRun (R3a) ---");
    {
        // the editor's rules stood in for: a fill layer is a filter whose type gives pixels; references and control
        // layers are what a run leaves out
        const FILLS = new Set(["solid", "gradient"]);
        const isFill = (l) => l.kind === "filter" && FILLS.has(l.filter);
        const skip = (l) => l.role === "reference" || (!!l.role && l.role !== "none");
        const img = (extra) => ({ kind: "image", role: "none", ...(extra || {}) });
        const fx = (extra) => ({ kind: "filter", filter: "film", role: "none", ...(extra || {}) });
        const ref = () => ({ kind: "image", role: "reference" });
        const ctl = (extra) => ({ kind: "image", role: "depth", ...(extra || {}) });
        const at = (layers) => R.topFilterRun(layers, isFill, skip);
        const cases = [
            ["no layers", [], 0],
            ["no list at all", null, 0],
            ["a top image layer", [img(), fx(), img()], 3],
            ["one top filter", [img(), fx()], 1],
            ["two top filters", [img(), img(), fx(), fx({ filter: "grain" })], 2],
            ["only filters", [fx(), fx()], 0],
            ["a fill layer at the top is no filter", [img(), fx(), fx({ filter: "solid" })], 3],
            ["a fill layer inside the run ends it", [img(), fx(), fx({ filter: "gradient" }), fx()], 3],
            ["a filter under an image layer does not count", [fx(), img()], 2],
            ["hidden top filters count", [img(), fx({ visible: false }), fx()], 1],
            ["a group at the top ends the run", [img(), fx(), img({ group: "G1" }), fx({ group: "G1" })], 4],
            ["a filter in a group above an ungrouped one: the run is only the ungrouped top", [img(), fx({ group: "G1" }), fx()], 2],
            ["a clipped filter at the top is no part of the run", [img(), fx({ clip: true })], 2],
            ["a reference above the top filter run is passed over", [img(), fx(), ref()], 1],
            ["a reference between two filters is passed over", [img(), fx(), ref(), fx()], 1],
            ["references alone at the top: the length", [img(), ref(), ref()], 3],
            ["a control layer at the top is passed over", [img(), fx(), ctl()], 1],
            ["a control layer in a group ends the run", [img(), fx(), ctl({ group: "G2" })], 3],
        ];
        for (const [what, layers, want] of cases) {
            const got = at(layers);
            check(`topFilterRun: ${what} -> ${want}`, got === want, `got ${got}`);
        }
        // the host's skip also passes over hidden layers that are no filter (a rejected result on top draws nothing)
        const skipH = (l) => skip(l) || (l.kind !== "filter" && l.visible === false);
        const hidden = [
            ["a hidden image layer above the top filter is passed over", [img(), fx(), img({ visible: false })], 1],
            ["a hidden image layer between two filters is passed over", [img(), fx(), img({ visible: false }), fx()], 1],
            ["a hidden image layer in a group ends the run", [img(), fx(), img({ visible: false, group: "G3" })], 3],
            ["a hidden image layer alone at the top: the length", [img(), img({ visible: false })], 2],
        ];
        for (const [what, layers, want] of hidden) {
            const got = R.topFilterRun(layers, isFill, skipH);
            check(`topFilterRun (host's skip): ${what} -> ${want}`, got === want, `got ${got}`);
        }
        // the defaults (no isFill, no skip): every top-level unclipped filter counts, nothing is passed over
        check("topFilterRun without isFill and skip: a fill counts, a reference ends the run", R.topFilterRun([img(), fx({ filter: "solid" })]) === 1 && R.topFilterRun([img(), fx(), ref()]) === 3);
        // the index is exclusive, as the editor's upTo: the layers below it are what the pass reads
        const stack = [img({ name: "base-ish" }), img({ name: "paint" }), fx({ name: "look" }), ref()];
        const i = at(stack);
        check("topFilterRun's index splits the stack: paint read, the look and the reference above", i === 2 && stack.slice(0, i).map((l) => l.name).join() === "base-ish,paint", `got ${i}`);
    }

    // ---- 9d. wholeRefusal (R3b: the size host.realismWhole refuses and the Upscale dialog greys with) ---------------
    console.log("\n--- 9d. wholeRefusal (R3b) ---");
    {
        const cases = [
            ["7680 x 4320 is past the area (33.2 MP: its answer came back broken)", 7680, 4320, `${EXACT_LABEL} takes at most 7680 × 4320 (long × short side) and 27.9 megapixels; this is 7680 × 4320.`],
            ["7040 x 4320 is past the area (30.4 MP: broken about 1 run in 7)", 7040, 4320, `${EXACT_LABEL} takes at most 7680 × 4320 (long × short side) and 27.9 megapixels; this is 7040 × 4320.`],
            ["7680 x 3960 is past the area (30.4 MP)", 7680, 3960, `${EXACT_LABEL} takes at most 7680 × 4320 (long × short side) and 27.9 megapixels; this is 7680 × 3960.`],
            ["7360 x 4320 is past the area (31.8 MP)", 7360, 4320, `${EXACT_LABEL} takes at most 7680 × 4320 (long × short side) and 27.9 megapixels; this is 7360 × 4320.`],
            ["4320 x 7680 (portrait) is past the area", 4320, 7680, `${EXACT_LABEL} takes at most 7680 × 4320 (long × short side) and 27.9 megapixels; this is 4320 × 7680.`],
            ["an odd 7679 x 4319 (padded to 7680 x 4320) is past the area", 7679, 4319, `${EXACT_LABEL} takes at most 7680 × 4320 (long × short side) and 27.9 megapixels; this is 7679 × 4319.`],
            ["7040 x 3960 fits (the area cap itself, 27.9 MP)", 7040, 3960, ""],
            ["3960 x 7040 (portrait) fits", 3960, 7040, ""],
            ["an odd 7039 x 3959 fits (padded to 7040 x 3960)", 7039, 3959, ""],
            ["64 x 64 fits", 64, 64, ""],
            ["an odd 63 x 100 fits (padded to 64 x 100)", 63, 100, ""],
            ["7681 x 100 is past the long side", 7681, 100, `${EXACT_LABEL} takes at most 7680 × 4320 (long × short side) and 27.9 megapixels; this is 7681 × 100.`],
            ["5000 x 4321 is past the short side", 5000, 4321, `${EXACT_LABEL} takes at most 7680 × 4320 (long × short side) and 27.9 megapixels; this is 5000 × 4321.`],
            ["15000 x 10000 is past both", 15000, 10000, `${EXACT_LABEL} takes at most 7680 × 4320 (long × short side) and 27.9 megapixels; this is 15000 × 10000.`],
            ["62 x 500 is too small", 62, 500, `${EXACT_LABEL} needs at least 64 px a side; this is 62 × 500.`],
        ];
        for (const [what, w, h, want] of cases) {
            const got = R.wholeRefusal(w, h);
            check(`wholeRefusal: ${what}`, got === want, `got ${JSON.stringify(got)}`);
            if (got) texts.push(got);
        }
        // the same answer as R3a's inline rule (evenPlan, then fits, the padded size written back as the document's)
        let same = 0, n = 0;
        for (const w of [1, 63, 64, 65, 4319, 4320, 4321, 7679, 7680, 7681, 9000]) {
            for (const h of [1, 63, 64, 65, 4319, 4320, 4321, 7679, 7680, 7681]) {
                n++;
                const { w2, h2 } = R.evenPlan(w, h);
                const r = R.fits(w2, h2);
                if (R.wholeRefusal(w, h) === (r ? r.replace(`this is ${w2} × ${h2}.`, `this is ${w} × ${h}.`) : "")) same++;
            }
        }
        check(`wholeRefusal equals evenPlan + fits on ${n} sizes`, same === n, `${n - same} differ`);
    }

    // ---- 9e. the Realism Pass Upscale (R-U: the modes, fitSize, fitPlan, passPrompt's mode, scaleAlpha) ----------
    console.log("\n--- 9e. the Realism Pass Upscale (R-U) ---");
    {
        // the pack's UPSCALING_MODES (dlss5/settings.py at 796ed59), written out here: factor -> label
        const PACK = [[1.0, "1x (DLAA / native)"], [1.5, "1.5x (Quality)"], [1.724, "1.724x (Balanced)"], [2.0, "2x (Performance)"], [3.0, "3x (Ultra Performance)"]];
        check("MODES are the pack's five modes in its order, labels and factors verbatim", eq(R.MODES.map((m) => [m.F, m.label]), PACK), short(R.MODES));
        check("MODES' dialog factors are 1, 1.5, 1.7, 2, 3 and their texts", eq(R.MODES.map((m) => [m.factor, m.text]), [[1, "1× (refine)"], [1.5, "1.5×"], [1.7, "1.7×"], [2, "2×"], [3, "3×"]]), short(R.MODES));
        check("the 1x mode is PASS_MODE", R.MODES[0].label === R.PASS_MODE);
        const modeCases = [[1, 1], [undefined, 1], [null, 1], ["", 1], [1.5, 1.5], [1.7, 1.724], [1.724, 1.724], ["2", 2], [2, 2], [3, 3]];
        for (const [f, F] of modeCases) {
            const m = R.modeFor(f);
            check(`modeFor(${JSON.stringify(f)}) is the mode of F ${F}`, !!m && m.F === F, short(m));
        }
        for (const f of [2.5, 4, 0, -1, 1.72, "x", NaN, Infinity]) check(`modeFor(${String(f)}) is null`, R.modeFor(f) === null);
        const fr = R.factorRefusal(2.5);
        texts.push(fr);
        check("factorRefusal names the factors", fr === `${EXACT_LABEL} takes the factors 1, 1.5, 1.7, 2 and 3, not 2.5.`, fr);

        // fitSize: the user's DLSS5 Fit Input Size node (fit_size), its answers on 2500 cases (tools/refs/dlss5/fit_cases.json,
        // run on a verbatim copy of the node's functions), and a port of it on 100,000 more sizes
        const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "refs", "dlss5", "fit_cases.json"), "utf8"));
        let bad = null, n = 0;
        for (const [w, h, F, nw, nh] of fx.cases) {
            n++;
            const g = R.fitSize(w, h, F);
            if (g.w !== nw || g.h !== nh) { bad = [w, h, F, nw, nh, g]; break; }
        }
        check(`fitSize equals the node's fit_size on its ${n} fixture cases`, n === 2500 && !bad, short(bad));
        const nodeFit = (w, h, F) => {
            const ev = packEven;
            const ok = (a, b) => { const ow = ev(a * F), oh = ev(b * F); return Math.max(ow, oh) <= 7680 && Math.min(ow, oh) <= 4320; };
            if (ok(w, h)) return [w, h];
            const s = Math.min(7680 / (F * Math.max(w, h)), 4320 / (F * Math.min(w, h)));
            let nw = Math.max(2, Math.floor(w * s / 2.0 + 1e-9) * 2), nh = Math.max(2, Math.floor(h * s / 2.0 + 1e-9) * 2);
            while (!ok(nw, nh) && nw > 2 && nh > 2) {
                if (nw >= nh) { nw -= 2; nh = Math.max(2, Math.floor(h * nw / w / 2.0) * 2); } else { nh -= 2; nw = Math.max(2, Math.floor(w * nh / h / 2.0) * 2); }
            }
            return [nw, nh];
        };
        let seed = 7;
        const rnd = (a, b) => { seed = (seed * 1103515245 + 12345) % 2147483648; return a + (seed % (b - a + 1)); };
        let diff = null, notFit = null, notEven = null, k = 0;
        for (let i = 0; i < 25000 && !diff; i++) {
            const w = rnd(1, 24000), h = rnd(1, 24000);
            for (const m of R.MODES.slice(1)) {
                k++;
                const g = R.fitSize(w, h, m.F), want = nodeFit(w, h, m.F);
                if (g.w !== want[0] || g.h !== want[1]) { diff = [w, h, m.F, want, g]; break; }
                if ((g.w !== w || g.h !== h) && (g.w % 2 || g.h % 2)) notEven = notEven || [w, h, m.F, g];
                if (g.w > 2 && g.h > 2 && !packAccepts(Math.max(64, g.w), Math.max(64, g.h), m.F) && Math.min(g.w, g.h) >= 64) notFit = notFit || [w, h, m.F, g];
            }
        }
        check(`fitSize equals the node's rule on ${k} random sizes`, k === 100000 && !diff, short(diff));
        check("a scaled fitSize has even sides", !notEven, short(notEven));
        check("every fitSize of 64 px a side or more is taken by the pack at F", !notFit, short(notFit));
        // the user's picture, and the plan's case: F is the pack's 1.724, never the dialog's 1.7
        check("fitSize(5456, 3072) at 1.5 is 5114 x 2880 (the user's picture)", eq(R.fitSize(5456, 3072, 1.5), { w: 5114, h: 2880 }), short(R.fitSize(5456, 3072, 1.5)));
        check("fitSize(4600, 2000) at 1.724 is 4454 x 1936", eq(R.fitSize(4600, 2000, 1.724), { w: 4454, h: 1936 }));
        const at17 = R.fitSize(4600, 2000, 1.7);
        check("at 1.7 the fit would be 4516 x 1964, whose output the pack refuses at 1.724 (fits with F)", eq(at17, { w: 4516, h: 1964 }) && R.fits(4516, 1964, 1.724) !== "" && R.fits(4516, 1964, 1.7) === "" && R.fits(4454, 1936, 1.724) === "", short([at17, R.fits(4516, 1964, 1.724)]));
        check("fitSize keeps a picture that fits (1920 x 1080 at 3)", eq(R.fitSize(1920, 1080, 3), { w: 1920, h: 1080 }));

        // fitAreaSize: fitSize, then the 27.9 MP area (R-U's live look); fitSize itself stays the node's rule
        check("fitAreaSize(5456, 3072) at 1.5 is 4690 x 2640 (fitSize's 5114 x 2880 answered 7672 x 4320, broken live)", eq(R.fitAreaSize(5456, 3072, 1.5), { w: 4690, h: 2640 }), short(R.fitAreaSize(5456, 3072, 1.5)));
        check("fitAreaSize(3840, 2160) at 2 is 3520 x 1980 (fitSize keeps 3840 x 2160, whose 7680 x 4320 is past the area)", eq(R.fitSize(3840, 2160, 2), { w: 3840, h: 2160 }) && eq(R.fitAreaSize(3840, 2160, 2), { w: 3520, h: 1980 }), short(R.fitAreaSize(3840, 2160, 2)));
        check("fitAreaSize keeps what fitSize gives when its output is within the area (3000 x 200 at 3, 1920 x 1080 at 3)", eq(R.fitAreaSize(3000, 200, 3), R.fitSize(3000, 200, 3)) && eq(R.fitAreaSize(1920, 1080, 3), { w: 1920, h: 1080 }));
        {
            let aBad = null, aN = 0;
            seed = 5;
            for (let i = 0; i < 20000 && !aBad; i++) {
                const w = rnd(2, 24000), h = rnd(2, 24000);
                for (const m of R.MODES) {
                    aN++;
                    const f = R.fitSize(w, h, m.F), a = R.fitAreaSize(w, h, m.F), o = R.outputSize(a.w, a.h, m.F), of = R.outputSize(f.w, f.h, m.F);
                    const within = of.w * of.h <= R.MAX_AREA;
                    if (within ? !eq(a, f) : (a.w > f.w || a.h > f.h || a.w % 2 || a.h % 2)) { aBad = [w, h, m.F, "against fitSize", f, a]; break; }
                    if (a.w > 2 && a.h > 2 && (o.w * o.h > R.MAX_AREA || !packAccepts(Math.max(64, a.w), Math.max(64, a.h), m.F) && Math.min(a.w, a.h) >= 64)) { aBad = [w, h, m.F, "not taken", a, o]; break; }
                    // the aspect: each side floored to even twice at most (fitSize, then the area), so within 4 px a side
                    if (!within && Math.min(a.w, a.h) >= 64 && Math.abs(a.h - a.w * h / w) > 4 + 4 * h / w + 1e-9) { aBad = [w, h, m.F, "aspect", a]; break; }
                    // as large as the area allows: the next even size up of the same aspect would pass a cap
                    if (!within && Math.min(a.w, a.h) >= 64 && o.w * o.h < R.MAX_AREA * 0.97) { aBad = [w, h, m.F, "too small", a, o.w * o.h]; break; }
                }
            }
            check(`fitAreaSize on ${aN} random sizes and every mode: fitSize's answer when its output is within 27.9 MP, else smaller, even, taken at F with an output of at most 27.9 MP, the aspect kept, within 3 % of the area`, aN === 100000 && !aBad, short(aBad));
        }

        // fitPlan: the even size, the scale-down, the answer kept, the document after, the refusals
        const plan = (w, h, f) => { const p = R.fitPlan(w, h, f); if (p.refusal) texts.push(p.refusal); return p; };
        const p2 = plan(320, 240, 2);
        check("fitPlan(320, 240, 2): not scaled, 640 x 480 back and the document 640 x 480", !p2.refusal && !p2.scaled && eq(p2.sent, [320, 240]) && eq(p2.out, [640, 480]) && eq(p2.keep, [640, 480]) && eq(p2.doc, [640, 480]) && p2.mode.label === "2x (Performance)", short(p2));
        const pOdd = plan(1001, 601, 1.5);
        check("fitPlan(1001, 601, 1.5): padded to 1002 x 602, the padding's share off the answer (1502 x 902 of 1504 x 904)", !pOdd.refusal && eq(pOdd.sent, [1002, 602]) && eq(pOdd.out, [1504, 904]) && eq(pOdd.keep, [1502, 902]) && eq(pOdd.doc, [1502, 902]), short(pOdd));
        const p3 = plan(3000, 200, 3);
        check("fitPlan(3000, 200, 3): scaled down to 2560 x 170, 7680 x 510 back, the document 7680 x 512", !p3.refusal && p3.scaled && eq(p3.fit, [2560, 170]) && eq(p3.sent, [2560, 170]) && eq(p3.out, [7680, 510]) && eq(p3.keep, [7680, 510]) && eq(p3.doc, [7680, 512]), short(p3));
        const p17 = plan(4600, 100, 1.7);
        check("fitPlan(4600, 100, 1.7): scaled down with the pack's 1.724 to 4454 x 96 (1.7 would give 4516 x 98)", !p17.refusal && p17.scaled && eq(p17.sent, [4454, 96]) && eq(p17.out, [7678, 166]) && eq(p17.doc, [7678, 167]) && p17.mode.label === "1.724x (Balanced)" && eq(R.fitSize(4600, 100, 1.7), { w: 4516, h: 98 }), short(p17));
        // an odd side that fits unpadded but not padded (4455 x 2506 at 1.724: 4456 would answer 7682): the padded size is fitted
        const pEdge = plan(4455, 2506, 1.7);
        check("fitPlan(4455, 2506, 1.7): the padded 4456 x 2506 is past the pack's cap and its fit 4454 x 2504 past the area, so it goes at 4084 x 2296", !pEdge.refusal && pEdge.scaled && eq(pEdge.sent, [4084, 2296]) && eq(R.fitSize(4456, 2506, 1.724), { w: 4454, h: 2504 }) && packAccepts(4454, 2504, 1.724) && !passAccepts(4454, 2504, 1.724) && !packAccepts(4456, 2506, 1.724) && passAccepts(4084, 2296, 1.724), short(pEdge));
        const pUser = plan(5456, 3072, 1.5);
        check("fitPlan(5456, 3072, 1.5): the user's picture goes at 4690 x 2640 and comes back 7036 x 3960 (27.9 MP; the pack's own fit 5114 x 2880 answered 7672 x 4320, broken live)", !pUser.refusal && pUser.scaled && eq(pUser.sent, [4690, 2640]) && eq(pUser.out, [7036, 3960]) && eq(pUser.doc, [7036, 3962]) && pUser.out[0] * pUser.out[1] <= R.MAX_AREA, short(pUser));
        const p4k = plan(3840, 2160, 2);
        check("fitPlan(3840, 2160, 2): within the pack's cap but past the area, so it goes at 3520 x 1980 and comes back 7040 x 3960 (its 3676 x 2068 of the 30.4 MP cap answered broken once live)", !p4k.refusal && p4k.scaled && eq(p4k.sent, [3520, 1980]) && eq(p4k.out, [7040, 3960]) && eq(p4k.doc, [7040, 3960]), short(p4k));
        const p1080 = plan(1920, 1080, 2);
        check("fitPlan(1920, 1080, 2): not scaled, 3840 x 2160 back (the live look's 2x)", !p1080.refusal && !p1080.scaled && eq(p1080.out, [3840, 2160]) && eq(p1080.doc, [3840, 2160]), short(p1080));
        const small = plan(4600, 100, 3);
        check("fitPlan(4600, 100, 3): the fit 2560 x 54 is under 64 px, refused", small.refusal === `${EXACT_LABEL} needs at least 64 px a side: at 3× the 4600 × 100 picture would go at 2560 × 54 (its output is capped at 7680 × 4320 and 27.9 megapixels).`, small.refusal);
        const tiny = plan(50, 63, 2);
        check("fitPlan(50, 63, 2): the picture itself is under 64 px, refused with its own size", tiny.refusal === `${EXACT_LABEL} needs at least 64 px a side; this is 50 × 63.`, tiny.refusal);
        const same = plan(7680, 4320, 2);
        check("fitPlan(7680, 4320, 2): the output cannot be larger than the picture, refused", same.refusal === `${EXACT_LABEL} cannot make the 7680 × 4320 picture larger at 2×: its output is capped at 7680 × 4320 and 27.9 megapixels.` && same.scaled, same.refusal);
        const big = plan(15000, 10000, 2);
        check("fitPlan(15000, 10000, 2): a picture past the cap at 2× that would shrink is refused", /cannot make the 15000 × 10000 picture larger at 2×/.test(big.refusal), big.refusal);
        const one = plan(7681, 100, 1);
        check("fitPlan at 1×: the refiner's refusal past the cap (no downscale)", one.refusal === R.wholeRefusal(7681, 100) && !one.scaled && one.refusal !== "", one.refusal);
        const sizes1 = [[7680, 4320], [7360, 4320], [7040, 4320], [7680, 3960]];
        const big1 = sizes1.map(([w, h]) => plan(w, h, 1));
        check("fitPlan at 1×: 7680 x 4320, 7360 x 4320, 7040 x 4320 and 7680 x 3960 refused (broken always, or about 1 run in 7 at 30.4 MP), never scaled", big1.every((p, i) => !p.scaled && p.refusal === `${EXACT_LABEL} takes at most 7680 × 4320 (long × short side) and 27.9 megapixels; this is ${sizes1[i][0]} × ${sizes1[i][1]}.`), short(big1.map((p) => p.refusal)));
        const ok1 = plan(7040, 3960, 1);
        check("fitPlan(7040, 3960, 1): the cap's own size, measured clean, goes at its own size", !ok1.refusal && !ok1.scaled && eq(ok1.sent, [7040, 3960]) && eq(ok1.doc, [7040, 3960]), short(ok1));
        const oneOk = plan(641, 481, 1);
        check("fitPlan(641, 481, 1): 642 x 482 goes, the picture's size kept", !oneOk.refusal && eq(oneOk.sent, [642, 482]) && eq(oneOk.doc, [641, 481]), short(oneOk));
        const badF = plan(320, 240, 2.5);
        check("fitPlan with a factor no mode has: refused", badF.refusal === R.factorRefusal(2.5), badF.refusal);
        // the plan against the pack on many sizes: what goes is taken at F, the document gets larger, the aspect kept
        let planBad = null, plans = 0;
        seed = 11;
        for (let i = 0; i < 4000 && !planBad; i++) {
            const w = rnd(64, 16000), h = rnd(64, 16000);
            for (const m of R.MODES.slice(1)) {
                const p = R.fitPlan(w, h, m.factor);
                if (p.refusal) continue;
                plans++;
                // the aspect within a rounding, or, where landingSize held the height to the caps, the answer's own size
                // (no stretch of the pass layer; the layers below scaled by its sides); the document made is one a 1x pass
                // takes (release review 2026-10-05)
                const held = p.doc[1] !== Math.max(1, Math.round(h * p.keep[0] / w));
                const aspectOk = held ? p.doc[0] === p.keep[0] && p.doc[1] === p.keep[1] : Math.abs(p.doc[1] / p.doc[0] - h / w) <= 1 / p.doc[0] + 1e-9;
                if (!passAccepts(p.sent[0], p.sent[1], m.F) || p.out[0] * p.out[1] > R.MAX_AREA || p.sent[0] % 2 || p.sent[1] % 2 || !(p.doc[0] > w) || !aspectOk || R.wholeRefusal(p.doc[0], p.doc[1])) { planBad = [w, h, m.factor, p]; break; }
                if (!p.scaled && (p.sent[0] - w > 1 || p.sent[1] - h > 1)) { planBad = [w, h, m.factor, "padded more than 1 px", p]; break; }
            }
        }
        check(`fitPlan on ${plans} sizes: what goes is even and taken at F, its output never past 27.9 MP, the document larger at the picture's aspect and within the 1x caps`, plans > 2000 && !planBad, short(planBad));
        // landingSize (release review 2026-10-05): the rounded height that would put the document past the 1x caps is held
        // to the answer's own, so a 1x pass on the document the pass made is not refused; elsewhere the aspect's rounding
        const p32 = plan(3840, 2560, 1.7), pTall = plan(1761, 5374, 1.5);
        check("fitPlan(3840, 2560, 1.7): the answer 6468 x 4310 makes a 6468 x 4310 document (not 6468 x 4312, past 27.9 MP), which a 1x pass takes",
            !p32.refusal && eq(p32.keep, [6468, 4310]) && eq(p32.doc, [6468, 4310]) && !R.wholeRefusal(6468, 4310) && !!R.wholeRefusal(6468, 4312), short(p32));
        check("fitPlan(1761, 5374, 1.5): the answer 2518 x 7680 makes a 2518 x 7680 document (not 2518 x 7684, past the long side)",
            !pTall.refusal && eq(pTall.doc, [2518, 7680]) && !R.wholeRefusal(2518, 7680), short(pTall));
        check("landingSize keeps the aspect's rounding where it is within the caps", eq(R.landingSize(3000, 200, 7680, 510), { w: 7680, h: 512 }) && eq(R.landingSize(320, 240, 640, 480), { w: 640, h: 480 }) && eq(R.landingSize(3840, 2560, 6468, 4310), { w: 6468, h: 4310 }),
            short([R.landingSize(3000, 200, 7680, 510), R.landingSize(3840, 2560, 6468, 4310)]));
        {
            // every picture size the dialog meets at every factor, refused or not: no plan sends an output past the area
            let over = null, nAll = 0;
            seed = 13;
            const sizes = [[5456, 3072], [3840, 2160], [1920, 1080], [7680, 4320], [7040, 3960], [5114, 2880], [4096, 4096], [8000, 2000], [100, 7000]];
            for (let i = 0; i < 3000; i++) sizes.push([rnd(1, 20000), rnd(1, 20000)]);
            for (const [w, h] of sizes) {
                for (const m of R.MODES) {
                    nAll++;
                    const p = R.fitPlan(w, h, m.factor);
                    if (!p.refusal && p.out[0] * p.out[1] > R.MAX_AREA) { over = [w, h, m.factor, p]; break; }
                }
                if (over) break;
            }
            check(`fitPlan never sends an output past MAX_AREA (${nAll} plans, every factor, 1x included)`, !over && nAll === 3009 * 5, short(over));
        }
        check("scaledDownNote is the user's sentence, with both caps", R.scaledDownNote(2560, 170) === `${EXACT_LABEL} scaled the picture down to 2560 × 170 first: its output is capped at 7680 × 4320 and 27.9 megapixels.`, R.scaledDownNote(2560, 170));
        texts.push(R.scaledDownNote(2560, 170));

        // passPrompt takes the mode; 1x by default; an unknown label throws with the label
        const ref = { filename: "x.png", subfolder: "inpaint_canvas", type: "input" };
        const rp = JSON.parse(fs.readFileSync(path.join(ROOT, "recipes", "realism_pass.json"), "utf8"));
        for (const m of R.MODES) {
            const s = R.passPrompt(rp, {}, ref, m.label).rp_settings.inputs;
            check(`passPrompt at ${m.label}: upscaling_mode written, the rest as at 1x`, s.upscaling_mode === m.label && eq({ ...s, upscaling_mode: 0 }, { ...R.passPrompt(rp, {}, ref).rp_settings.inputs, upscaling_mode: 0 }), short(s));
        }
        check("passPrompt without a mode is 1x", R.passPrompt(rp, {}, ref).rp_settings.inputs.upscaling_mode === R.PASS_MODE);
        const pm = throws(() => R.passPrompt(rp, {}, ref, "1.7x (Balanced)"));
        check("passPrompt with a label the pack does not have throws with the label", !!pm && pm.includes(EXACT_LABEL) && pm.includes("1.7x (Balanced)"), pm);
        if (pm) texts.push(pm);

        // scaleAlpha: the alpha of the sent picture at the answer's size (bilinear), colours 0
        const rgba = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[(y * w + x) * 4 + 3] = f(x, y); return d; };
        const alphaAt = (d, w, x, y) => d[(y * w + x) * 4 + 3];
        const flat = R.scaleAlpha(rgba(10, 6, () => 77), 10, 6, 20, 12);
        let flatOk = flat.length === 20 * 12 * 4;
        for (let i = 0; i < flat.length; i += 4) if (flat[i + 3] !== 77 || flat[i] || flat[i + 1] || flat[i + 2]) flatOk = false;
        check("scaleAlpha keeps a constant alpha at 2x, colour bytes 0", flatOk);
        const sameSize = R.scaleAlpha(rgba(5, 4, (x, y) => x * 40 + y), 5, 4, 5, 4);
        check("scaleAlpha at the same size gives the alpha back byte for byte", [...Array(20).keys()].every((i) => sameSize[i * 4 + 3] === (i % 5) * 40 + Math.floor(i / 5)));
        // a step: opaque left half, transparent right half of 8 px; at 2x the edges hold, the middle ramps
        const step = R.scaleAlpha(rgba(8, 2, (x) => (x < 4 ? 255 : 0)), 8, 2, 16, 4);
        const row = [...Array(16).keys()].map((x) => alphaAt(step, 16, x, 1));
        check("scaleAlpha of a step at 2x: 255 far left, 0 far right, one ramp between, never rising", row[0] === 255 && row[5] === 255 && row[10] === 0 && row[15] === 0 && row.every((v, i) => i === 0 || v <= row[i - 1]) && row.some((v) => v > 0 && v < 255), short(row));
        // at 1.5x on an odd size (a 3 x 1 picture to 5 x 1: the centre sample is the middle pixel's)
        const odd = R.scaleAlpha(rgba(3, 1, (x) => [0, 100, 200][x]), 3, 1, 5, 1);
        check("scaleAlpha of 0 / 100 / 200 at 5/3x: 0 at the left edge, 100 in the middle, 200 at the right edge", alphaAt(odd, 5, 0, 0) === 0 && alphaAt(odd, 5, 2, 0) === 100 && alphaAt(odd, 5, 4, 0) === 200, short([...Array(5).keys()].map((x) => alphaAt(odd, 5, x, 0))));
        // putAlphaBack with the scaled alpha undoes the flatten at the larger size: a picture of colour c, alpha a, sent
        // as c·a + 128·(1 − a), comes back as c where the pass changed nothing (here: an answer made by upscaling the sent
        // picture by pixel repetition)
        const sw = 6, sh = 4, ow = 12, oh = 8;
        const src = new Uint8ClampedArray(sw * sh * 4);
        for (let i = 0; i < sw * sh; i++) { src[i * 4] = 200; src[i * 4 + 1] = 40; src[i * 4 + 2] = 90; src[i * 4 + 3] = 128; }
        const sent = R.prepPixels(src, sw, sh, true).data;
        const ans = new Uint8ClampedArray(ow * oh * 4);
        for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) ans.set(sent.slice(((y >> 1) * sw + (x >> 1)) * 4, ((y >> 1) * sw + (x >> 1)) * 4 + 4), (y * ow + x) * 4);
        const back = R.putAlphaBack(ans, ow, oh, R.scaleAlpha(src, sw, sh, ow, oh), ow, oh);
        let worst = 0;
        for (let i = 0; i < ow * oh; i++) worst = Math.max(worst, Math.abs(back[i * 4] - 200), Math.abs(back[i * 4 + 1] - 40), Math.abs(back[i * 4 + 2] - 90), Math.abs(back[i * 4 + 3] - 128));
        check("putAlphaBack with scaleAlpha at 2x: the colour and the alpha come back within 2 levels", worst <= 2, `worst ${worst}`);
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
