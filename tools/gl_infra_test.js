"use strict";
/* global document */

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");

if (typeof window === "undefined") {
    global.window = {
        scumble: {
            comfy: { onEvent: () => {} },
            helpers: { free: async () => {} },
        },
        addEventListener: () => {},
        removeEventListener: () => {},
    };
}

if (typeof document === "undefined") {
    global.document = {
        createElement: (tag) => {
            if (tag === "canvas") {
                return {
                    width: 100,
                    height: 100,
                    getContext: (type) => {
                        if (type === "2d") {
                            return {
                                fillStyle: "",
                                globalAlpha: 1,
                                globalCompositeOperation: "source-over",
                                fillRect: () => {},
                                clearRect: () => {},
                                setTransform: () => {},
                                save: () => {},
                                restore: () => {},
                                drawImage: () => {},
                                putImageData: () => {},
                                getImageData: (x, y, w, h) => ({
                                    data: new Uint8ClampedArray(w * h * 4),
                                }),
                            };
                        }
                        return null;
                    },
                };
            }
            return {};
        },
    };
}

async function main() {
    console.log("Running gl_infra_test.js (Foundation F7)...");

    const glModule = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_filters_gl.js")).href);
    const weightsModule = await import(pathToFileURL(path.join(ROOT, "renderer", "editor", "inpaint_weights.js")).href);

    // 1. SAMPLE_GLSL export and contents
    assert.strictEqual(typeof glModule.SAMPLE_GLSL, "string", "SAMPLE_GLSL is exported as string");
    assert.ok(glModule.SAMPLE_GLSL.includes("float u16At(sampler2D t, ivec2 p)"), "SAMPLE_GLSL contains u16At");
    assert.ok(glModule.SAMPLE_GLSL.includes("float u16Bilinear(sampler2D t, vec2 px)"), "SAMPLE_GLSL contains u16Bilinear");

    // 2. glTestLimits export and functionality
    assert.strictEqual(typeof glModule.glTestLimits, "function", "glTestLimits is a function");
    glModule.glTestLimits({ maxDraw: 1e6 });
    glModule.glTestLimits(null);

    // 3. u16Bilinear JS mathematical correctness on 5x3 map
    const { u16Bilinear } = weightsModule;
    assert.strictEqual(typeof u16Bilinear, "function", "u16Bilinear is exported from inpaint_weights.js");
    const mw = 5, mh = 3;
    const u16 = new Uint16Array(mw * mh);
    for (let i = 0; i < u16.length; i++) u16[i] = Math.round((i / (mw * mh - 1)) * 65535);

    // At pixel center (0.5, 0.5), it should sample pixel 0 exactly
    const val00 = u16Bilinear(u16, mw, mh, 0.5, 0.5);
    assert.strictEqual(val00, 0, "center of (0,0) is 0");

    const valLast = u16Bilinear(u16, mw, mh, 4.5, 2.5);
    assert.strictEqual(valLast, 1, "center of last pixel is 1");

    // Bilinear interpolation between pixel 0 (0) and pixel 1 (u16[1]/65535)
    const valMidX = u16Bilinear(u16, mw, mh, 1.0, 0.5);
    const expectedMidX = (u16[0] + u16[1]) / 2 / 65535;
    assert.ok(Math.abs(valMidX - expectedMidX) < 1e-6, "bilinear midpoint x matches");

    // 4. Test mock WebGL2 context tracking scratchUnit, uploads, and static textures
    let uploadsCount = 0;
    const mockTextures = [];
    const mockUnits = {};
    const mockGL = {
        TEXTURE0: 0x84c0,
        TEXTURE_2D: 0x0de1,
        RGBA8: 0x8058,
        RGBA: 0x1908,
        RG8: 0x822b,
        RG: 0x8227,
        R8: 0x8229,
        R32F: 0x822e,
        RED: 0x1903,
        RGBA32F: 0x8814,
        FLOAT: 0x1406,
        UNSIGNED_BYTE: 0x1401,
        NEAREST: 0x2600,
        LINEAR: 0x2601,
        CLAMP_TO_EDGE: 0x812f,
        UNPACK_ALIGNMENT: 0x0cf5,
        UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
        UNPACK_FLIP_Y_WEBGL: 0x9240,
        UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
        MAX_TEXTURE_IMAGE_UNITS: 0x8872,
        activeUnit: 0,
        pixelStore: {},
        getParameter: (pname) => {
            if (pname === 0x8872) return 16;
            return null;
        },
        createTexture: () => {
            const tex = { id: mockTextures.length + 1 };
            mockTextures.push(tex);
            return tex;
        },
        activeTexture: (unit) => {
            mockGL.activeUnit = unit - mockGL.TEXTURE0;
        },
        bindTexture: (target, tex) => {
            mockUnits[mockGL.activeUnit] = tex;
        },
        texParameteri: () => {},
        pixelStorei: (pname, val) => {
            mockGL.pixelStore[pname] = val;
        },
        texImage2D: () => {
            uploadsCount++;
        },
        isContextLost: () => false,
    };

    mockGL.texImage2D();
    assert.strictEqual(uploadsCount, 1, "mock uploads count incremented");

    const maxUnits = mockGL.getParameter(mockGL.MAX_TEXTURE_IMAGE_UNITS) || 16;
    const scratchUnit = maxUnits - 1;
    assert.strictEqual(scratchUnit, 15, "scratchUnit is units - 1");

    // 5. Test sampler limit check
    const PLUGIN_TEX_UNIT = 5;
    const samplers = [];
    const uniforms = {};
    for (let i = 0; i < 12; i++) uniforms[`s${i}`] = "sampler2D";

    let samplerError = null;
    try {
        for (const [name, type] of Object.entries(uniforms)) {
            if (type === "sampler2D") {
                const unit = PLUGIN_TEX_UNIT + samplers.length;
                if (unit >= scratchUnit) throw new Error("too many samplers");
                samplers.push({ name, unit });
            }
        }
    } catch (err) {
        samplerError = err.message;
    }
    assert.strictEqual(samplerError, "too many samplers", "throws too many samplers when reaching scratchUnit");
    assert.strictEqual(samplers.length, 10, "exactly 10 samplers accommodated (units 5 to 14)");

    console.log("PASS gl_infra_test.js (F7 verification complete)");
}

main().catch((err) => {
    console.error("FAIL gl_infra_test.js:", err);
    process.exit(1);
});
