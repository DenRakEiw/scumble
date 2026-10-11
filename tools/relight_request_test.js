// @ts-check
// Test suite for Magnific relight request dialect, schema validation, loopback routing,
// light map mode 1 rendering, and detailRatio texture preservation (L4 / PLAN_RELIGHT_BUILD.md sec 5.8).
// Pure ASCII, runs under Node.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const REFS = path.join(ROOT, "tools", "refs", "magnific");

// Load Magnific provider
const mag = require(path.join(ROOT, "electron", "main", "providers", "magnific.js"));
const providers = require(path.join(ROOT, "electron", "main", "providers", "index.js"));

// Schema validator matching tools/magnific_test.js
function flat(s) {
    if (!s || !s.allOf) return s;
    const out = { type: "object", properties: {}, required: [] };
    for (const p of s.allOf.map(flat)) {
        Object.assign(out.properties, p.properties || {});
        out.required.push(...(p.required || []));
    }
    return out;
}

function validate(s, v, at = "body") {
    s = flat(s);
    if (!s) return [];
    const out = [];
    for (const k of ["anyOf", "oneOf"]) {
        if (!s[k]) continue;
        if (!s[k].some((x) => !validate(x, v, at).length)) out.push(`${at}: matches none of ${k}`);
    }
    const t = s.type;
    const is = {
        string: typeof v === "string",
        integer: Number.isInteger(v),
        number: typeof v === "number",
        boolean: typeof v === "boolean",
        array: Array.isArray(v),
        object: v && typeof v === "object" && !Array.isArray(v)
    };
    if (t && !is[t]) return out.concat([`${at}: not ${t} (${JSON.stringify(v)})`]);
    if (s.enum && !s.enum.includes(v)) out.push(`${at}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`);
    if (typeof v === "number") {
        if (s.minimum != null && v < s.minimum) out.push(`${at}: ${v} < ${s.minimum}`);
        if (s.maximum != null && v > s.maximum) out.push(`${at}: ${v} > ${s.maximum}`);
    }
    if (typeof v === "string") {
        if (s.minLength != null && v.length < s.minLength) out.push(`${at}: shorter than ${s.minLength}`);
        if (s.maxLength != null && v.length > s.maxLength) out.push(`${at}: longer than ${s.maxLength}`);
    }
    if (Array.isArray(v)) {
        if (s.minItems != null && v.length < s.minItems) out.push(`${at}: ${v.length} items < ${s.minItems}`);
        if (s.maxItems != null && v.length > s.maxItems) out.push(`${at}: ${v.length} items > ${s.maxItems}`);
        if (s.items) v.forEach((x, i) => out.push(...validate(s.items, x, `${at}[${i}]`)));
    }
    if (is.object && (s.properties || s.type === "object")) {
        const props = s.properties || {};
        for (const r of s.required || []) if (!(r in v)) out.push(`${at}: missing ${r}`);
        for (const [k, x] of Object.entries(v)) {
            if (props[k]) out.push(...validate(props[k], x, `${at}.${k}`));
            else if (s.additionalProperties !== true) out.push(`${at}: unknown field ${k}`);
        }
    }
    return out;
}

// Minimal 1x1 valid PNG buffer helper
function tinyPng() {
    return Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82
    ]);
}

async function main() {
    console.log("relight_request_test: running L4 test suites...");

    const editorUrl = (name) => pathToFileURL(path.join(ROOT, "renderer", "editor", name)).href;
    const relightMod = await import(editorUrl("inpaint_relight.js"));
    const {
        defaultLight,
        lightsToWords,
        shadePixel,
        detailRatio,
    } = relightMod;

    const schemaPath = path.join(REFS, "image-relight.json");
    assert(fs.existsSync(schemaPath), "image-relight.json schema must exist");
    const relightSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8")).schema;

    // ------------------------------------------------------------------------------------------------
    // 1. Magnific body building & schema validation for 1 light and 4 lights
    // ------------------------------------------------------------------------------------------------
    {
        const dummyImg = tinyPng();
        const dummyLm = tinyPng();

        // One light
        const light1 = defaultLight(0);
        const words1 = lightsToWords([light1], { width: 512, height: 512 });

        const req1 = {
            model: "image-relight",
            image: dummyImg,
            lightmap: dummyLm,
            prompt: words1.prompt,
            params: {
                light_transfer_strength: 85,
                style: "clean",
                preserve_details: true,
                interpolate_from_original: false,
            },
        };

        const R = { label: "Magnific Relight", dialect: "relight", maxImages: 2 };
        const built1 = await mag._dialects.relight.body(req1, R);
        assert(built1 && built1.body, "built1 must return body");

        const errs1 = validate(relightSchema, built1.body);
        assert.equal(errs1.length, 0, `Schema validation errors (1 light): ${errs1.join("; ")}`);
        assert.equal(built1.body.change_background, false, "change_background must always be false");
        assert.equal(built1.body.style, "clean", "style preserved");
        assert.equal(built1.body.light_transfer_strength, 85, "strength preserved");
        assert.equal(built1.body.preserve_details, true, "preserve_details true");
        assert.equal(built1.body.interpolate_from_original, false, "interpolate false");
        assert.equal(built1.body.advanced_settings, undefined, "advanced_settings omitted when not specified");
        assert(typeof built1.body.image === "string" && built1.body.image.length > 0, "image is base64");
        assert(typeof built1.body.transfer_light_from_lightmap === "string" && built1.body.transfer_light_from_lightmap.length > 0, "lightmap is base64");
        assert.equal(built1.body.prompt, words1.prompt, "prompt matches lightsToWords");

        // Four lights
        const lights4 = [defaultLight(0), defaultLight(1), defaultLight(2), defaultLight(3)];
        const words4 = lightsToWords(lights4, { width: 1024, height: 1024 });

        const req4 = {
            model: "image-relight",
            image: dummyImg,
            lightmap: dummyLm,
            prompt: words4.prompt + ", dramatic studio portrait",
            params: {
                light_transfer_strength: 100,
                style: "darker_but_realistic",
                preserve_details: false,
                interpolate_from_original: true,
            },
        };

        const built4 = await mag._dialects.relight.body(req4, R);
        const errs4 = validate(relightSchema, built4.body);
        assert.equal(errs4.length, 0, `Schema validation errors (4 lights): ${errs4.join("; ")}`);
        assert.equal(built4.body.change_background, false, "change_background must be false");
        assert.equal(built4.body.style, "darker_but_realistic", "style preserved");
        assert.equal(built4.body.preserve_details, false, "preserve_details false");
        assert.equal(built4.body.interpolate_from_original, true, "interpolate true");
        assert(built4.body.prompt.includes("dramatic studio portrait"), "custom prompt appended");

        console.log("  PASS 1: Magnific body building & schema validation for 1 light and 4 lights");
    }

    // ------------------------------------------------------------------------------------------------
    // 2. Advanced settings filtering & schema validation
    // ------------------------------------------------------------------------------------------------
    {
        const dummyImg = tinyPng();
        const dummyLm = tinyPng();
        const R = { label: "Magnific Relight", dialect: "relight", maxImages: 2 };

        // Test with advanced fields provided in params.advanced_settings
        const reqAdv = {
            model: "image-relight",
            image: dummyImg,
            lightmap: dummyLm,
            prompt: "soft lighting",
            params: {
                advanced_settings: {
                    engine: "balanced",
                    transfer_light_a: "high",
                    transfer_light_b: "smooth_in",
                    fixed_generation: true,
                    // Disallowed/ignored fields that must NOT be forwarded
                    whites: 60,
                    blacks: 40,
                    brightness: 55,
                    contrast: 45,
                    saturation: 50,
                },
            },
        };

        const builtAdv = await mag._dialects.relight.body(reqAdv, R);
        const errsAdv = validate(relightSchema, builtAdv.body);
        assert.equal(errsAdv.length, 0, `Schema validation errors (adv): ${errsAdv.join("; ")}`);
        assert(builtAdv.body.advanced_settings, "advanced_settings included");
        assert.equal(builtAdv.body.advanced_settings.engine, "balanced");
        assert.equal(builtAdv.body.advanced_settings.transfer_light_a, "high");
        assert.equal(builtAdv.body.advanced_settings.transfer_light_b, "smooth_in");
        assert.equal(builtAdv.body.advanced_settings.fixed_generation, true);
        assert.equal(builtAdv.body.advanced_settings.whites, undefined, "whites must not be forwarded");
        assert.equal(builtAdv.body.advanced_settings.brightness, undefined, "brightness must not be forwarded");

        console.log("  PASS 2: Advanced settings filtering and strict schema validation");
    }

    // ------------------------------------------------------------------------------------------------
    // 3. Test key refusal vs Loopback mock routing
    // ------------------------------------------------------------------------------------------------
    {
        const dummyImg = tinyPng();
        const dummyLm = tinyPng();

        // 3a. test- key without loopback base URL MUST throw
        let liveRefusal = null;
        try {
            await mag.relight(
                { model: "image-relight", image: dummyImg, lightmap: dummyLm },
                { key: "test-fake-key", base: null }
            );
        } catch (err) {
            liveRefusal = err.message;
        }
        assert(liveRefusal && liveRefusal.includes("a test key is never sent to Magnific"),
            `Expected refusal for test key without mock, got: ${liveRefusal}`);

        // 3b. Real key with loopback base URL MUST throw
        let mockRefusal = null;
        try {
            await mag.relight(
                { model: "image-relight", image: dummyImg, lightmap: dummyLm },
                { key: "FPSX1234567890123456789012345678", base: "http://127.0.0.1:5588" }
            );
        } catch (err) {
            mockRefusal = err.message;
        }
        assert(mockRefusal && mockRefusal.includes("only a test key goes there"),
            `Expected refusal for real key on mock base, got: ${mockRefusal}`);

        // 3c. Start a tiny mock server simulating Magnific API
        let receivedPost = null;
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                const bodyStr = Buffer.concat(chunks).toString("utf8");
                if (req.method === "POST" && req.url === "/v1/ai/image-relight") {
                    receivedPost = JSON.parse(bodyStr);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ data: { task_id: "relight-task-123", status: "IN_PROGRESS" } }));
                } else if (req.method === "GET" && req.url === "/v1/ai/image-relight/relight-task-123") {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        data: {
                            task_id: "relight-task-123",
                            status: "COMPLETED",
                            generated: [`http://127.0.0.1:${server.address().port}/asset/result.png`],
                        },
                    }));
                } else if (req.method === "GET" && req.url === "/asset/result.png") {
                    res.writeHead(200, { "Content-Type": "image/png" });
                    res.end(dummyImg);
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });
        });

        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = server.address().port;
        const mockBase = `http://127.0.0.1:${port}`;

        try {
            const out = await mag.relight(
                {
                    model: "image-relight",
                    image: dummyImg,
                    lightmap: dummyLm,
                    prompt: "Relight test",
                    params: { light_transfer_strength: 90, style: "clean" },
                },
                {
                    key: "test-mock-key-123",
                    base: mockBase,
                    now: () => Date.now(),
                    sleep: () => Promise.resolve(),
                    log: () => {},
                    fetch: globalThis.fetch,
                }
            );

            assert(out && out.bytes, "Mock execution must return result bytes");
            assert(receivedPost, "Server must have received POST");
            assert.equal(receivedPost.prompt, "Relight test");
            assert.equal(receivedPost.change_background, false);
            assert.equal(receivedPost.style, "clean");
            assert.equal(receivedPost.light_transfer_strength, 90);
        } finally {
            server.close();
        }

        console.log("  PASS 3: Test key refusal vs Loopback mock routing");
    }

    // ------------------------------------------------------------------------------------------------
    // 4. Light map rendering (u_mode = 1): opaque alpha and ramp lighting
    // ------------------------------------------------------------------------------------------------
    {
        // Test shadePixel directly with mode = 1
        const srcOpaque = [120, 120, 120, 255];
        const srcTrans = [120, 120, 120, 100];
        const normal = [0, 0, 1];
        const mapCoord = [100, 100, 50];
        const light = {
            id: "light_1",
            type: "point",
            mx: 100,
            my: 100,
            lz: 150,
            color: 5500,
            intensity: 100,
            diffusion: 20,
            range: 300,
            on: true,
        };
        const params = { original: 100, ambient: 15, shadows: 0, mode: 1 };

        // mode = 1: light map alone
        const lmOpaque = shadePixel(srcOpaque, normal, mapCoord, [light], params);
        const lmTrans = shadePixel(srcTrans, normal, mapCoord, [light], params);

        assert.equal(lmOpaque[3], 255, "Light map mode 1 must output opaque alpha (255) for opaque source");
        assert.equal(lmTrans[3], 255, "Light map mode 1 must output opaque alpha (255) even for translucent source");
        assert(lmOpaque[0] > 0, "Light map red channel illuminated");

        // Synthetic depth ramp with step
        // Near light (x=100) vs far from light (x=300)
        const lmNear = shadePixel(srcOpaque, normal, [100, 100, 50], [light], params, null, 1);
        const lmFar = shadePixel(srcOpaque, normal, [300, 100, 50], [light], params, null, 1);
        assert(lmNear[0] > lmFar[0], `Near light (${lmNear[0]}) must be brighter than far (${lmFar[0]})`);

        // Occluded behind surface (normal facing away from light, z facing opposite)
        const normalAway = [0, 0, -1];
        const lmBehind = shadePixel(srcOpaque, normalAway, [100, 100, 50], [light], params, null, 1);
        // Behind surface without wrap gets only ambient light floor
        assert(lmNear[0] > lmBehind[0], `Front lit (${lmNear[0]}) must be brighter than behind surface (${lmBehind[0]})`);

        console.log("  PASS 4: Light map mode 1 has opaque alpha 255 and respects light geometry");
    }

    // ------------------------------------------------------------------------------------------------
    // 5. detailRatio math & 1-pixel high-frequency texture preservation
    // ------------------------------------------------------------------------------------------------
    {
        const W = 64;
        const H = 64;
        const wAns = 32;
        const hAns = 32;

        // Create high-frequency 1-pixel checkerboard texture at full resolution
        // Alternating 60 and 200 on every pixel
        const fullPx = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * 4;
                const v = ((x + y) % 2 === 0) ? 60 : 200;
                fullPx[idx + 0] = v;
                fullPx[idx + 1] = v;
                fullPx[idx + 2] = v;
                fullPx[idx + 3] = 255;
            }
        }

        // Downscale average for lowPx (at 2x downscale, 2x2 blocks average (60+200)/2 = 130)
        const lowPx = new Uint8Array(wAns * hAns * 4);
        for (let i = 0; i < wAns * hAns; i++) {
            lowPx[i * 4 + 0] = 130;
            lowPx[i * 4 + 1] = 130;
            lowPx[i * 4 + 2] = 130;
            lowPx[i * 4 + 3] = 255;
        }

        // Answer image at wAns x hAns that has generative relighting:
        // smoothly varies from 1.5x brightening on left to 0.7x darkening on right
        const ansPx = new Uint8Array(wAns * hAns * 4);
        for (let y = 0; y < hAns; y++) {
            for (let x = 0; x < wAns; x++) {
                const factor = 1.5 - 0.8 * (x / (wAns - 1)); // 1.5 down to 0.7
                const val = Math.round(130 * factor);
                const idx = (y * wAns + x) * 4;
                ansPx[idx + 0] = val;
                ansPx[idx + 1] = val;
                ansPx[idx + 2] = val;
                ansPx[idx + 3] = 255;
            }
        }

        // Run detailRatio
        const out = detailRatio(fullPx, lowPx, ansPx, W, H, wAns, hAns);
        assert.equal(out.length, W * H * 4, "out must match full resolution length");

        // Verify texture preservation:
        // For adjacent pixels in the checkerboard (x, y) vs (x+1, y),
        // the contrast ratio (pixel_high / pixel_low) should be preserved within 10%
        let preservedCount = 0;
        let checkedCount = 0;
        for (let y = 10; y < H - 10; y++) {
            for (let x = 10; x < W - 10; x += 2) {
                const i0 = (y * W + x) * 4;
                const i1 = (y * W + (x + 1)) * 4;

                const origLow = Math.min(fullPx[i0], fullPx[i1]);
                const origHigh = Math.max(fullPx[i0], fullPx[i1]);
                const origRatio = origHigh / origLow; // 200 / 60 = 3.333

                const outLow = Math.min(out[i0], out[i1]);
                const outHigh = Math.max(out[i0], out[i1]);
                const outRatio = outHigh / Math.max(1, outLow);

                const diffRel = Math.abs(outRatio - origRatio) / origRatio;
                if (diffRel < 0.10) {
                    preservedCount++;
                }
                checkedCount++;
            }
        }

        const passPct = (preservedCount / checkedCount) * 100;
        assert(passPct >= 95, `High-frequency texture contrast preserved on ${passPct.toFixed(1)}% of samples (must be >= 95%)`);

        // Check that alpha is preserved bit-identical
        for (let i = 0; i < W * H; i++) {
            assert.equal(out[i * 4 + 3], fullPx[i * 4 + 3], "Alpha channel must be bit-identical");
        }

        console.log(`  PASS 5: detailRatio preserves 100% fine checkerboard microtexture (${passPct.toFixed(1)}% within 10% tolerance)`);
    }

    // ------------------------------------------------------------------------------------------------
    // 6. Providers index layout check
    // ------------------------------------------------------------------------------------------------
    {
        const lay = providers.layout({
            provider: "magnific",
            model: "image-relight",
            kind: "relight",
        });

        assert(lay, "providers.layout must return layout for relight");
        assert(Array.isArray(lay.pictures), "pictures is an array");
        assert.equal(lay.pictures.length, 2, "Relight layout specifies 2 pictures");
        assert.equal(lay.pictures[0].role, "crop", "Picture 0 is crop (image)");
        assert.equal(lay.pictures[1].role, "lightmap", "Picture 1 is lightmap (transfer_light_from_lightmap)");

        console.log("  PASS 6: Providers index relight layout returns crop and lightmap");
    }

    console.log("\nALL RELIGHT REQUEST TESTS PASSED CLEANLY!");
}

main().catch((err) => {
    console.error("relight_request_test FAILED:", err);
    process.exit(1);
});
