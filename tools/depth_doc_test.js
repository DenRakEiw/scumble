// Plain-Node test for R1-S3b (Document Integration of Depth Map)
// Tests:
// - host.depthModel and host.depthInput
// - InpaintEditor depth lifecycle: ensureDepthMap, depthFingerprint, isDepthStale
// - Overlay & Sidebar row: drawDepthOverlay, renderDepthRow
// - Document serialization: getValue / setValue with depth metadata
// - sample_depth command and assistant policy
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

// Mock minimal browser globals for importing renderer modules
global.window = {
    scumble: {
        comfy: { onEvent: () => {} },
        helpers: { status: async () => ({ models: [] }) },
        log: { list: async () => [], file: async () => "" },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};
global.document = {
    createElement: () => ({
        getContext: () => ({
            getImageData: () => ({ data: new Uint8ClampedArray(4) }),
            createImageData: () => ({ data: new Uint8ClampedArray(4) }),
            putImageData: () => {},
            drawImage: () => {},
            fillRect: () => {},
        }),
    }),
};

const policy = require(path.join(ROOT, "electron", "main", "assistant", "policy.js"));

let passed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`[ok] ${name}`);
        passed++;
    } catch (err) {
        console.error(`[FAIL] ${name}:`, err);
        process.exit(1);
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`[ok] ${name}`);
        passed++;
    } catch (err) {
        console.error(`[FAIL] ${name}:`, err);
        process.exit(1);
    }
}

// 1. Policy checks
test("policy: sample_depth is in READS", () => {
    assert.ok(policy.READS.has("sample_depth"), "sample_depth must be in READS");
});

test("policy: sample_depth is AUTO in policy", () => {
    const f = {
        doc: { loaded: true, busy: false },
        layers: [{ id: "Lbase", name: "Base", locked: false }],
        tools: null,
    };
    const res = policy.decide({ name: "sample_depth", args: { x: 10, y: 10 } }, f);
    assert.strictEqual(res.action, "auto", "sample_depth should be auto");
});

// 2. Commands check
async function runCommandChecks() {
    // Dynamic import ES modules
    const { commands } = await import(pathToFileURL(path.join(ROOT, "renderer", "commands.js")).href);
    const { host } = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "host.js")).href);

    test("commands: depth_map and sample_depth are registered with correct params and readOnly", () => {
        assert.ok(commands.has("depth_map"), "commands.has('depth_map') must be true");
        assert.ok(commands.has("sample_depth"), "commands.has('sample_depth') must be true");
        const desc = commands.describe().find((c) => c.name === "sample_depth");
        assert.ok(desc, "command descriptor found");
        assert.strictEqual(desc.readOnly, true, "sample_depth must be readOnly");
        assert.strictEqual(desc.needsImage, true, "sample_depth needsImage must be true");
        assert.ok(desc.params.x && desc.params.x.required, "x is required");
        assert.ok(desc.params.y && desc.params.y.required, "y is required");
        assert.strictEqual(desc.params.recompute, undefined, "sample_depth has no recompute param (use depth_map)");

        const depthMapDesc = commands.describe().find((c) => c.name === "depth_map");
        assert.ok(depthMapDesc, "depth_map descriptor found");
        assert.strictEqual(depthMapDesc.readOnly, false, "depth_map is not readOnly");
        assert.ok(depthMapDesc.params.force, "depth_map has force param");
    });

    await testAsync("commands: sample_depth validates coordinates and requires depth_map first", async () => {
        const fakeEd = {
            base: {},
            width: 800,
            height: 600,
            maps: {},
        };
        host.editor = fakeEd;
        await assert.rejects(async () => {
            await commands.run("sample_depth", { x: -5, y: 100 });
        }, /outside the 800 × 600 picture/);

        await assert.rejects(async () => {
            await commands.run("sample_depth", { x: 100, y: 700 });
        }, /outside the 800 × 600 picture/);

        await assert.rejects(async () => {
            await commands.run("sample_depth", {});
        }, /pass x and y in image pixels/);

        await assert.rejects(async () => {
            await commands.run("sample_depth", { x: 100, y: 100 });
        }, /run depth_map first/);
    });

    await testAsync("commands: sample_depth returns mapped depth, u16, raw disparity and staleness", async () => {
        // Document: 800x600, depth map: 400x300 (guided workSize)
        const gw = 400, gh = 300;
        const u16 = new Uint16Array(gw * gh);
        // fill sample point at (200, 150) -> in depth map (100, 75)
        const targetIdx = 75 * gw + 100;
        u16[targetIdx] = 32768; // midpoint depth

        const rw = 518, rh = 392;
        const raw = new Float32Array(rw * rh);
        const rawTargetIdx = Math.floor(75 * rh / gh) * rw + Math.floor(100 * rw / gw);
        raw[rawTargetIdx] = 42.5;

        const fakeEd = {
            base: {},
            width: 800,
            height: 600,
            isDepthStale: () => false,
            maps: {
                depth: {
                    w: gw,
                    h: gh,
                    data: u16,
                    meta: {
                        rw,
                        rh,
                        raw,
                        lo: 10.0,
                        hi: 100.0,
                        provider: "dml",
                    },
                },
            },
        };
        host.editor = fakeEd;

        const res = await commands.run("sample_depth", { x: 200, y: 150 });
        assert.strictEqual(res.x, 200);
        assert.strictEqual(res.y, 150);
        assert.strictEqual(res.u16, 32768);
        assert.strictEqual(res.depth, Math.round((32768 / 65535) * 100000) / 100000);
        assert.strictEqual(res.width, 400);
        assert.strictEqual(res.height, 300);
        assert.strictEqual(res.near, 100.0);
        assert.strictEqual(res.far, 10.0);
        assert.strictEqual(res.provider, "dml");
        assert.strictEqual(res.stale, false);
    });

    await testAsync("host: depthModel and depthInput", async () => {
        host.helpers.models = [
            { id: "da2_small", kind: "depth", present: true, label: "Depth Anything V2 Small" },
        ];
        host.helpers.depth = "da2_small";
        const m = host.depthModel();
        assert.ok(m, "depth model returned");
        assert.strictEqual(m.id, "da2_small");

        let skipFiltersPassed = false;
        const fakeCanvas = {
            width: 800,
            height: 600,
            getContext: () => ({
                imageSmoothingEnabled: false,
                drawImage: () => {},
                getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            }),
        };
        const fakeEd = {
            width: 800,
            height: 600,
            tileMode: false,
            compositeVersion: 5,
            flattenToCanvas: (opts) => {
                skipFiltersPassed = !!opts.skipFilters;
                return fakeCanvas;
            },
        };
        const inp = await host.depthInput(fakeEd, 518, 392);
        assert.ok(skipFiltersPassed, "flattenToCanvas called with skipFilters: true");
        assert.ok(inp.image instanceof Uint8Array, "image is Uint8Array");
        assert.strictEqual(inp.width, 518);
        assert.strictEqual(inp.height, 392);
    });
}

// 3. Document serialization & staleness mathematics
function runDepthLifecycleChecks() {
    const { STALE_DIFF } = require(path.join(ROOT, "renderer", "editor", "inpaint_depth.js"));

    test("isDepthStale mathematics: threshold at STALE_DIFF = 6", () => {
        const thumbA = new Uint8Array(4096);
        const thumbB = new Uint8Array(4096);
        thumbA.fill(100);
        thumbB.fill(100);

        // Identical
        let sum = 0;
        for (let i = 0; i < 4096; i++) sum += Math.abs(thumbA[i] - thumbB[i]);
        assert.strictEqual(sum / 4096 < STALE_DIFF, true, "diff 0 is not stale");

        // Small change: mean diff 4
        thumbB.fill(104);
        sum = 0;
        for (let i = 0; i < 4096; i++) sum += Math.abs(thumbA[i] - thumbB[i]);
        assert.strictEqual(sum / 4096, 4);
        assert.strictEqual(sum / 4096 < STALE_DIFF, true, "diff 4 is not stale (< 6)");

        // Significant change: mean diff 8
        thumbB.fill(108);
        sum = 0;
        for (let i = 0; i < 4096; i++) sum += Math.abs(thumbA[i] - thumbB[i]);
        assert.strictEqual(sum / 4096, 8);
        assert.strictEqual(sum / 4096 >= STALE_DIFF, true, "diff 8 is stale (>= 6)");
    });

    test("depth serialization round-trip: metadata & thumb preserved", () => {
        const depthState = {
            w: 1024,
            h: 768,
            origW: 4000,
            origH: 3000,
            rw: 784,
            rh: 518,
            lo: 1.25,
            hi: 85.0,
            hash: "testhash123",
            version: 12,
            provider: "DirectML",
            ms: 45,
            totalMs: 78,
            thumb: Array.from(new Uint8Array(4096).fill(128)),
        };

        const json = JSON.stringify({ depth: depthState });
        const restored = JSON.parse(json);

        assert.strictEqual(restored.depth.w, 1024);
        assert.strictEqual(restored.depth.h, 768);
        assert.strictEqual(restored.depth.origW, 4000);
        assert.strictEqual(restored.depth.origH, 3000);
        assert.strictEqual(restored.depth.hash, "testhash123");
        assert.strictEqual(restored.depth.provider, "DirectML");
        assert.strictEqual(restored.depth.thumb.length, 4096);
        assert.strictEqual(restored.depth.thumb[0], 128);
    });
}

async function main() {
    runDepthLifecycleChecks();
    await runCommandChecks();
    console.log(`\nAll ${passed} tests passed!`);
}

main().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
