// CorridorKey 2.0 spike (docs/PLAN_CORRIDORKEY.md §4.2, session I0b): the pure parts of the harness, plain Node, no
// Electron: an 8-bit PNG reader, .npy read / write, the resamples and colour codes, and THE PROCESSING TABLE of
// Nucito/corridorkey-web@1ae72ca's five graphs. A measurement tool like tools/w0_bench.py; nothing in the app imports it.
//
// The processing table. Nucito publishes no loader (its README names the files and the inputs only; no JS loader on HF,
// GitHub or the web, searched 2026-11-06), so the table is read from the graphs themselves (onnx_inspect.py: the
// inputs, dtypes, shapes and the nodes reading the inputs and writing the outputs; docs/measurements/ck_i0b_2026-11-06/
// processing.md and inspect/) and from upstream's code (CorridorKey2.0
// @485f5e9, the copy pack A vendors at c7662de): runtime.py `_build_foundation_inputs` :283-292, `precompute_rvm_to_memmap`
// :303-344, `hann_stage1_stream`; video_io.py `_read_frame_dir_views` :247-255, `preprocess_frame_dir_path` :323-338,
// `read_hint_image` :144-156, `load_initial_hint_frame` :479-499; color_utils.py :1-138; foundations.py `forward`
// :218-290; rvm.py :363-386. I0a's reference (docs/measurements/ck_i0a_2026-11-06/scripts/ck_ref.py) runs exactly that.
//
//   graph   input (name dtype shape)            what goes in, made outside the graph                 inside the graph
//   cradio  x f32 [1,3,H/4,W/4]                  display RGB = png8 / 255, area resize (adaptive avg   RADIO's input
//                                                pool, = 4x4 box mean) to H/4 x W/4, NCHW               conditioner; out
//                                                                                                       (feat - mean)/std
//   moge    x f32 [1,3,7H/32,7W/32]              display RGB, area resize to 7H/32 x 7W/32 (adaptive    the ImageNet Sub /
//                                                avg pool, non-integer factor), NCHW                    Div; out normalised
//   rvm     frame f32 [1,3,H/4,W/4]              display RGB, bilinear (align_corners false, no         out (feat - mean)
//           state f32 [1,1+(H/64)(W/64),384]     antialias) to H/4, clamped to [0,1]; state all zeros   / std; new_state
//                                                (upstream's state None: new_zeros, rvm.py:376)         (unused on a still)
//   stage1  rgb f32 [1,1,3,H,W]                  the model code: linear = sRGB->linear(display) (IEC    -> baton [1,1,512,
//           hint f32 [1,1,1,H,W]                 piecewise), code = asinh(linear / 0.008) / asinh(16 /  H/16,W/16] f32,
//           hint_quality f32 [1,1]               0.008); hint = grey png8 / 255 (white = subject) or    aux [1,1,4,H/2,W/2]
//           moge, cradio, rvm f32 [1,1,C,H/64,W/64]  zeros; quality 0.95 clean / 0.75 rough / <= 0.5
//                                                loose, -1 with the zero hint ("decide the subject");
//                                                the three features as the graphs above give them
//   stage2  rgb f32 [1,1,3,H,W], baton           the same model code; stage 1's baton                   -> logits [1,1,4,H,W]
//                                                                                                       f32: ch0 alpha (raw,
//                                                                                                       clamp to [0,1]),
//                                                                                                       ch1-3 fg in the
//                                                                                                       asinh code
//   (The exact shapes are checked against each session's inputMetadata at load; a mismatch is an error, not a guess.)
//   Decode (not in the parity rows, which stay logits to logits): alpha = clamp(ch0, 0, 1); fg_linear = sinh(code *
//   asinh(2000)) * 0.008, straight (unpremultiplied) scene-linear, unclamped.
//   Where the reference differs on purpose: upstream rounds display and model code to bf16 before the graphs and runs
//   them under bf16 autocast; the spike feeds float32 and the graphs compute in fp16 (`--bf16-inputs` rounds the inputs
//   to bf16 first, to tell input rounding from graph noise).
"use strict";

const fs = require("node:fs");
const zlib = require("node:zlib");

// ---------------------------------------------------------------------------------------------------------------- PNG
/** An 8-bit, non-interlaced PNG (colour types 0, 2, 4, 6) -> { width, height, channels, data: Uint8Array }. */
function readPng(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
    let p = 8, width = 0, height = 0, depth = 0, ctype = 0, inter = 0;
    const idat = [];
    while (p < buf.length) {
        const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8);
        const body = buf.subarray(p + 8, p + 8 + len);
        if (type === "IHDR") {
            width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; ctype = body[9]; inter = body[12];
        } else if (type === "IDAT") idat.push(body);
        else if (type === "IEND") break;
        p += 12 + len;
    }
    if (depth !== 8 || inter !== 0) throw new Error(`PNG depth ${depth} interlace ${inter} not handled`);
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
    if (!channels) throw new Error(`PNG colour type ${ctype} not handled`);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels, out = new Uint8Array(height * stride);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const cur = out.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? cur[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0;
            let v = src[x];
            if (f === 1) v += a;
            else if (f === 2) v += b;
            else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
            else if (f !== 0) throw new Error("PNG filter " + f);
            cur[x] = v & 255;
        }
        prev = cur;
    }
    return { width, height, channels, data: out };
}

/** The RGB planes of a PNG as display values in [0,1], CHW float32 (an alpha channel is dropped, as cv2 IMREAD_COLOR). */
function displayCHW(png) {
    const { width: W, height: H, channels: ch, data } = png;
    if (ch < 3) throw new Error("expected an RGB(A) PNG");
    const n = W * H, out = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[c * n + i] = data[i * ch + c] / 255;
    return out;
}

/** A grey hint PNG -> float32 HW in [0,1] (upstream read_hint_image: uint8 / 255; 3 channels: channel 0 of BGR, = B). */
function hintHW(png) {
    const { width: W, height: H, channels: ch, data } = png;
    const n = W * H, out = new Float32Array(n);
    const pick = ch === 1 ? 0 : ch === 2 ? 1 : ch === 4 ? 3 : 2;   // grey; grey+alpha: alpha; RGBA: alpha; RGB: B
    for (let i = 0; i < n; i++) out[i] = data[i * ch + pick] / 255;
    return out;
}

// ---------------------------------------------------------------------------------------------------------------- npy
function f16ToF32(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    if (e === 0) return s * m * 2 ** -24;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * 2 ** (e - 15);
}

function npyRead(file) {
    const b = fs.readFileSync(file);
    const major = b[6], hl = major === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8), off = major === 1 ? 10 : 12;
    const header = b.toString("latin1", off, off + hl);
    const descr = /'descr':\s*'([^']+)'/.exec(header)[1];
    const shape = /'shape':\s*\(([^)]*)\)/.exec(header)[1].split(",").map((x) => x.trim()).filter(Boolean).map(Number);
    if (/'fortran_order':\s*True/.test(header)) throw new Error("fortran order");
    const n = shape.reduce((a, x) => a * x, 1), data = new Float32Array(n), base = off + hl;
    if (descr === "<f2") for (let i = 0; i < n; i++) data[i] = f16ToF32(b.readUInt16LE(base + 2 * i));
    else if (descr === "<f4") for (let i = 0; i < n; i++) data[i] = b.readFloatLE(base + 4 * i);
    else throw new Error("npy dtype " + descr);
    return { shape, data };
}

function npyWrite(file, data, shape) {
    let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(", ")}${shape.length === 1 ? "," : ""}), }`;
    const pad = 64 - ((10 + header.length + 1) % 64);
    header += " ".repeat(pad % 64) + "\n";
    const h = Buffer.alloc(10);
    h.write("\x93NUMPY", 0, "latin1"); h[6] = 1; h[7] = 0; h.writeUInt16LE(header.length, 8);
    const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    fs.writeFileSync(file, Buffer.concat([h, Buffer.from(header, "latin1"), body]));
}

// ---------------------------------------------------------------------------------------------------------- resamples
/** torch F.interpolate(mode="area") = adaptive_avg_pool2d: bins [floor(i*in/out), ceil((i+1)*in/out)). CHW float32. */
function areaCHW(src, C, H, W, Ho, Wo) {
    const out = new Float32Array(C * Ho * Wo);
    const ys = [], xs = [];
    for (let i = 0; i < Ho; i++) ys.push([Math.floor(i * H / Ho), Math.ceil((i + 1) * H / Ho)]);
    for (let j = 0; j < Wo; j++) xs.push([Math.floor(j * W / Wo), Math.ceil((j + 1) * W / Wo)]);
    for (let c = 0; c < C; c++) {
        const s = c * H * W, o = c * Ho * Wo;
        for (let i = 0; i < Ho; i++) {
            const [y0, y1] = ys[i];
            for (let j = 0; j < Wo; j++) {
                const [x0, x1] = xs[j];
                let sum = 0;
                for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += src[s + y * W + x];
                out[o + i * Wo + j] = sum / ((y1 - y0) * (x1 - x0));
            }
        }
    }
    return out;
}

/** torch F.interpolate(mode="bilinear", align_corners=False, antialias=False), sizes given (scale = in / out). */
function bilinearCHW(src, C, H, W, Ho, Wo) {
    const out = new Float32Array(C * Ho * Wo);
    const idx = (n, no, i) => {
        let s = (n / no) * (i + 0.5) - 0.5;
        if (s < 0) s = 0;
        const i0 = Math.floor(s), i1 = i0 < n - 1 ? i0 + 1 : i0;
        return [i0, i1, s - i0];
    };
    const yi = [], xi = [];
    for (let i = 0; i < Ho; i++) yi.push(idx(H, Ho, i));
    for (let j = 0; j < Wo; j++) xi.push(idx(W, Wo, j));
    for (let c = 0; c < C; c++) {
        const s = c * H * W, o = c * Ho * Wo;
        for (let i = 0; i < Ho; i++) {
            const [y0, y1, ly] = yi[i];
            for (let j = 0; j < Wo; j++) {
                const [x0, x1, lx] = xi[j];
                const a = src[s + y0 * W + x0], b = src[s + y0 * W + x1], cc = src[s + y1 * W + x0], d = src[s + y1 * W + x1];
                out[o + i * Wo + j] = (1 - ly) * ((1 - lx) * a + lx * b) + ly * ((1 - lx) * cc + lx * d);
            }
        }
    }
    return out;
}

// ------------------------------------------------------------------------------------------------------------- colour
const KNEE = 0.008, REF = 16.0, DENOM = Math.asinh(REF / KNEE);
const srgbToLinear = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);   // x in [0,1] here
const linearToCode = (x) => Math.asinh(x / KNEE) / DENOM;
const codeToLinear = (y) => Math.sinh(y * DENOM) * KNEE;

/** Round float32 values to bfloat16 (round to nearest even), in place: upstream's bf16 inputs. */
function roundBf16(a) {
    const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
    for (let i = 0; i < u.length; i++) { const x = u[i]; u[i] = ((x + 0x7fff + ((x >>> 16) & 1)) >>> 16) << 16; }
    return a;
}

/** Everything the graphs need for one picture: { display, code, cradioIn, mogeIn, rvmIn } (float32, CHW). */
function prepare(png, { bf16 = false } = {}) {
    const H = png.height, W = png.width;
    if (H % 128 || W % 128) throw new Error(`a bucket is a multiple of 128, got ${W} x ${H}`);
    const display = displayCHW(png);
    const code = new Float32Array(display.length);   // upstream: the code from the float32 display, then bf16
    for (let i = 0; i < display.length; i++) code[i] = linearToCode(srgbToLinear(display[i]));
    if (bf16) { roundBf16(display); roundBf16(code); }
    const cradioIn = areaCHW(display, 3, H, W, H / 4, W / 4);
    const hm = Math.floor(H * 7 / 32), wm = Math.floor(W * 7 / 32);
    const mogeIn = areaCHW(display, 3, H, W, hm, wm);
    const rvmIn = bilinearCHW(display, 3, H, W, H / 4, W / 4);
    for (let i = 0; i < rvmIn.length; i++) rvmIn[i] = Math.min(1, Math.max(0, rvmIn[i]));
    if (bf16) { roundBf16(cradioIn); roundBf16(mogeIn); }
    return { H, W, display, code, cradioIn, mogeIn, rvmIn, mogeHW: [hm, wm] };
}

module.exports = { readPng, displayCHW, hintHW, npyRead, npyWrite, f16ToF32, areaCHW, bilinearCHW, srgbToLinear,
    linearToCode, codeToLinear, roundBf16, prepare, KNEE, REF, DENOM };
