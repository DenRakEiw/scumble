// @ts-check
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
    console.log("Testing blend table integrity...");

    const blendMod = await import(pathToFileURL(path.join(__dirname, "../renderer/editor/blend_modes.js")).href);
    const {
        BLENDS,
        BLEND_MODES,
        EMULATED_BLENDS: _EMULATED_BLENDS,
        BLEND_OPS: _BLEND_OPS,
        LAST_BLEND,
        BLEND_GROUPS: _BLEND_GROUPS,
        PSD_BLEND,
        PSD_BLENDS,
        ORA_BLEND,
        ORA_BLENDS,
        READER_OF_BLEND: _READER_OF_BLEND,
        canvasOp,
        normalBlend,
        blendLabel,
    } = blendMod;

    // 1. Unique ids
    const ids = BLENDS.map((r) => r.id);
    assert.strictEqual(new Set(ids).size, BLENDS.length, "ids must be unique");

    // 2. PSD keys: 4 characters and unique
    const psdKeys = BLENDS.map((r) => r.psd);
    for (const k of psdKeys) {
        assert.strictEqual(typeof k, "string", "psd key must be string");
        assert.strictEqual(k.length, 4, `psd key "${k}" must be exactly 4 characters`);
    }
    assert.strictEqual(new Set(psdKeys).size, BLENDS.length, "PSD keys must be unique");

    // 3. Every row round-trips id -> psd -> id and id -> ora -> id
    for (const r of BLENDS) {
        assert.strictEqual(PSD_BLEND[r.id], r.psd, `PSD_BLEND[${r.id}] === ${r.psd}`);
        assert.strictEqual(PSD_BLENDS[r.psd], r.id, `PSD_BLENDS[${r.psd}] === ${r.id}`);
        assert.strictEqual(PSD_BLENDS[PSD_BLEND[r.id]], r.id, `round-trip id->psd->id for ${r.id}`);

        assert.strictEqual(ORA_BLEND[r.id], r.ora, `ORA_BLEND[${r.id}] === ${r.ora}`);
        assert.strictEqual(ORA_BLENDS[r.ora], r.id, `ORA_BLENDS[${r.ora}] === ${r.id}`);
        assert.strictEqual(ORA_BLENDS[ORA_BLEND[r.id]], r.id, `round-trip id->ora->id for ${r.id}`);

        for (const alt of r.oraRead) {
            assert.strictEqual(ORA_BLENDS[alt], r.id, `ORA_BLENDS[${alt}] === ${r.id}`);
        }
    }

    // 4. BLEND_MODES equals today's list in order
    const EXPECTED_MODES = [
        "normal", "multiply", "screen", "overlay", "darken", "lighten",
        "soft-light", "hard-light", "linear-light", "difference",
    ];
    assert.deepStrictEqual(BLEND_MODES, EXPECTED_MODES, "BLEND_MODES must match today's list in order");

    // 5. Parse composite.rs for pub const X: u8 = N;
    const compositeRsPath = path.resolve(__dirname, "../crates/px/src/composite.rs");
    const compositeRs = fs.readFileSync(compositeRsPath, "utf8");
    const rustConstRe = /pub\s+const\s+([A-Z_]+)\s*:\s*u8\s*=\s*(\d+)\s*;/g;
    /** @type {Map<number, string>} */
    const rustOps = new Map();
    let m;
    while ((m = rustConstRe.exec(compositeRs)) !== null) {
        rustOps.set(Number(m[2]), m[1]);
    }
    const maxRustOp = Math.max(...rustOps.keys());
    assert(maxRustOp >= LAST_BLEND, `Rust last op (${maxRustOp}) >= largest row op (${LAST_BLEND})`);

    // 6. Parse compositor's blend1 branches (u_mode == N or mode == N)
    const compositorPath = path.resolve(__dirname, "../renderer/editor/inpaint_compositor.js");
    const compositorJs = fs.readFileSync(compositorPath, "utf8");
    const glslModeRe = /(?:u_mode|mode)\s*==\s*(\d+)/g;
    /** @type {Set<number>} */
    const glslOps = new Set();
    while ((m = glslModeRe.exec(compositorJs)) !== null) {
        glslOps.add(Number(m[1]));
    }

    // Every row with op >= 5 must be in both rustOps and glslOps
    for (const r of BLENDS) {
        if (r.op >= 5) {
            assert(rustOps.has(r.op), `op ${r.op} (${r.id}) must exist in composite.rs`);
            assert(glslOps.has(r.op), `op ${r.op} (${r.id}) must have a branch in inpaint_compositor.js`);
        }
    }

    // 7. canvasOp and normalBlend behavior
    assert.strictEqual(canvasOp("nonsense"), "source-over", 'canvasOp("nonsense") === "source-over"');
    assert.strictEqual(canvasOp(null), "source-over", 'canvasOp(null) === "source-over"');
    assert.strictEqual(canvasOp(undefined), "source-over", 'canvasOp(undefined) === "source-over"');
    assert.strictEqual(canvasOp("normal"), "source-over", 'canvasOp("normal") === "source-over"');
    assert.strictEqual(canvasOp("linear-light"), "source-over", 'canvasOp("linear-light") === "source-over"');
    assert.strictEqual(canvasOp("multiply"), "multiply", 'canvasOp("multiply") === "multiply"');

    // Intercept console.warn for normalBlend test
    let warnCount = 0;
    const origWarn = console.warn;
    console.warn = (..._args) => { warnCount++; };
    try {
        assert.strictEqual(normalBlend("x"), "normal", 'normalBlend("x") === "normal"');
        assert.strictEqual(warnCount, 1, "normalBlend('x') emitted a console.warn");
        assert.strictEqual(normalBlend("multiply"), "multiply", 'normalBlend("multiply") === "multiply"');
        assert.strictEqual(normalBlend("normal"), "normal", 'normalBlend("normal") === "normal"');
        assert.strictEqual(normalBlend(null), "normal", 'normalBlend(null) === "normal"');
    } finally {
        console.warn = origWarn;
    }

    // 8. blendLabel behavior
    assert.strictEqual(blendLabel("multiply"), "Multiply");
    assert.strictEqual(blendLabel("linear-light"), "Linear light");
    assert.strictEqual(blendLabel("custom-unknown"), "custom-unknown");

    console.log("All blend table checks PASSED.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
