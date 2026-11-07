// P13's one-time A/B: keymatte.js at e9ab0d3 (keymatte_old.mjs) against the working tree's, end to end: refineMatte's
// alpha bytes and prepareRefine's coefficient floats on keymatte_test.js's scenes, both boxes, timed at a larger bucket.
// Ran from a scratch folder holding keymatte_old.mjs (`git show e9ab0d3:renderer/editor/keymatte.js`, its imports
// rewritten to absolute file: URLs of the tree's px/kernels.js and inpaint_depth.js); WT is the tree measured.
const fs = require("node:fs"), path = require("node:path");
const { pathToFileURL } = require("node:url");
const WT = "F:/canvas/.claude/worktrees/agent-a24fab290e0ea66b6";
const lib = require(path.join(WT, "tools", "keymatte_test.js"));
(async () => {
    const N = await import(pathToFileURL(path.join(WT, "renderer/editor/keymatte.js")).href);
    const O = await import(pathToFileURL(path.join(__dirname, "keymatte_old.mjs")).href);
    const KJ = await import(pathToFileURL(path.join(WT, "renderer/editor/px/kernels_js.js")).href);
    const { loadPx } = await import(pathToFileURL(path.join(WT, "renderer/editor/px/px.js")).href);
    const px = await loadPx(fs.readFileSync(path.join(WT, "renderer/editor/px/px.wasm")));
    const boxes = { js: (d, w, h, r) => KJ.boxBlurs(d, w, h, r), rust: (d, w, h, r) => px.boxBlurs(d, w, h, r) };
    let bad = 0, n = 0, floats = 0, bytes = 0;
    const kinds = ["skin", "blue", "teal", "fold", "shade", "stripes", "hair", "near"];
    for (const kind of kinds) for (const s of [4, 15]) for (const pn of [0, 6]) for (const guide of ["rgb", "chroma", "luma"]) for (const b of ["js", "rust"]) {
        const sc = lib.scene(kind, s, kind === "hair" ? 24 : 32, pn ? { pnoise: pn } : {});
        const o = { alpha: sc.alpha, aw: sc.aw, ah: sc.ah, small: sc.small, full: { w: sc.W, h: sc.H }, screen: sc.screen, box: boxes[b], guide };
        const read = (bx) => sc.rgba.subarray(bx[1] * sc.W * 4, bx[3] * sc.W * 4);
        const a = await N.refineMatte({ ...o, read }), c = await O.refineMatte({ ...o, read });
        let same = a.alpha.length === c.alpha.length;
        for (let i = 0; same && i < a.alpha.length; i++) if (a.alpha[i] !== c.alpha[i]) same = false;
        bytes += a.alpha.length;
        const sa = N.prepareRefine({ ...o, noise: 2 }), sb = O.prepareRefine({ ...o, noise: 2 });
        same = same && sa.soft === sb.soft && Object.is(sa.residual, sb.residual);
        for (let k = 0; same && k < sb.coef.length; k++) for (let i = 0; i < sb.coef[k].length; i++) { if (!Object.is(sa.coef[k][i], sb.coef[k][i])) { same = false; break; } floats++; }
        n++;
        if (!same) { bad++; console.log(`DIFF ${kind} s ${s} pnoise ${pn} ${guide} ${b}`); }
    }
    console.log(`${n} cases, ${bad} differ; ${bytes} alpha bytes and ${floats} coefficient floats compared`);
    // the fit's time at a larger bucket (2048 x 1366, 2.8 MP), the Rust box, best of 3 each
    const aw = 2048, ah = 1366, small = { data: new Uint8ClampedArray(aw * ah * 4), width: aw, height: ah }, alpha = new Float32Array(aw * ah);
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
        const d = Math.hypot(x - aw / 2, y - ah / 2) - ah * 0.4, al = Math.max(0, Math.min(1, 0.5 - d / 3)), i = y * aw + x;
        alpha[i] = al; small.data[i * 4] = 60 + al * 137; small.data[i * 4 + 1] = 170 - al * 35; small.data[i * 4 + 2] = 70 + al * 38; small.data[i * 4 + 3] = 255;
    }
    for (const [label, M] of [["old", O], ["new", N], ["old", O], ["new", N]]) {
        const ts = [];
        for (let r = 0; r < 3; r++) { const t = performance.now(); M.prepareRefine({ alpha, aw, ah, small, full: { w: aw * 4, h: ah * 4 }, box: boxes.rust, noise: 2 }); ts.push(performance.now() - t); }
        console.log(`${label}: prepareRefine fit at ${aw} x ${ah}, Rust box: ${Math.min(...ts).toFixed(0)} ms (best of 3; ${ts.map((t) => t.toFixed(0)).join(", ")})`);
    }
})();
