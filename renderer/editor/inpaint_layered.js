/**
 * Reading layered files: Photoshop PSD and OpenRaster ORA, the two formats the editor writes (inpaint_bands.js).
 * Plain data in, plain data out, no DOM: `node tools/layered_test.js` runs it as it is.
 *
 * `readPsd(bytes, { inflate })` answers `{ width, height, layers, composite, notes }`: the layers bottom first, each
 * `{ name, x, y, w, h, opacity, visible, blend, rgba }` with straight (not premultiplied) RGBA bytes of w x h;
 * `composite` the file's merged picture as RGBA (null when it has none); `notes` what could not be kept, in words.
 * What a PSD holds and the editor has no place for is turned into what it looks like, where that is cheap and
 * exact enough: a layer mask is multiplied into the layer's alpha, a group's visibility and opacity into its layers'
 * (exact for a group in pass-through or normal mode), 16-bit samples are rounded to 8. What has no pixels of its own
 * is left out and named: adjustment and fill layers, empty layers. Clipping masks and blend modes the editor lacks
 * are named too (the layer stays, clipped to nothing and in normal mode). RGB and grayscale, 8 and 16 bit; PSB,
 * CMYK, Lab, indexed and 32-bit files are refused with their name. `inflate(bytes)` (async, zlib) is only needed
 * for ZIP-compressed channels (Photoshop writes RLE unless told otherwise).
 *
 * `readOra(bytes, { inflateRaw })` answers `{ width, height, layers, notes }`, each layer with its PNG as `png`
 * (bytes) instead of `rgba`, for the caller to decode; nested stacks are flattened the same way as PSD groups.
 */

export const LAYERED_EXT = /\.(psd|ora)$/i;

const PSD_BLENDS = {
    norm: "normal", "mul ": "multiply", scrn: "screen", over: "overlay", dark: "darken", lite: "lighten",
    sLit: "soft-light", hLit: "hard-light", diff: "difference",
};
const ORA_BLENDS = {
    "svg:src-over": "normal", "svg:multiply": "multiply", "svg:screen": "screen", "svg:overlay": "overlay",
    "svg:darken": "darken", "svg:lighten": "lighten", "svg:soft-light": "soft-light", "svg:hard-light": "hard-light",
    "svg:difference": "difference",
};
// additional layer info keys that make a layer an adjustment or a fill (no pixels of its own)
const ADJUSTMENTS = new Set(["SoCo", "GdFl", "PtFl", "brit", "levl", "curv", "expA", "vibA", "hue ", "hue2", "blnc", "blwh",
    "phfl", "mixr", "clrL", "nvrt", "post", "thrs", "grdm", "selc", "CgEd"]);
const PSD_MODES = { 0: "bitmap", 1: "grayscale", 2: "indexed", 3: "RGB", 4: "CMYK", 7: "multichannel", 8: "duotone", 9: "Lab" };

/** Is this the start of a PSD (or PSB) file? */
export function isPsd(head) {
    return head && head.length >= 4 && head[0] === 0x38 && head[1] === 0x42 && head[2] === 0x50 && head[3] === 0x53;
}

/** Is this the start of an OpenRaster file (a zip whose first entry is the stored `mimetype` "image/openraster")? */
export function isOra(head) {
    if (!head || head.length < 54 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 3 || head[3] !== 4) return false;
    const nameLen = head[26] | (head[27] << 8), extra = head[28] | (head[29] << 8);
    const name = String.fromCharCode(...head.subarray(30, 30 + nameLen));
    if (name !== "mimetype") return false;
    const at = 30 + nameLen + extra;
    return String.fromCharCode(...head.subarray(at, at + 16)) === "image/openraster";
}

class Reader {
    constructor(bytes) {
        this.b = bytes;
        this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.p = 0;
    }
    need(n) { if (this.p + n > this.b.length) throw new Error("the file ends early (truncated or not a PSD)"); }
    u8() { this.need(1); return this.b[this.p++]; }
    u16() { this.need(2); const x = this.v.getUint16(this.p); this.p += 2; return x; }
    i16() { this.need(2); const x = this.v.getInt16(this.p); this.p += 2; return x; }
    u32() { this.need(4); const x = this.v.getUint32(this.p); this.p += 4; return x; }
    i32() { this.need(4); const x = this.v.getInt32(this.p); this.p += 4; return x; }
    ascii(n) { this.need(n); const s = String.fromCharCode(...this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
    bytes(n) { this.need(n); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
    skip(n) { this.need(n); this.p += n; }
}

/** PackBits rows into `out` (length rows * rowBytes); `lens` the packed length of each row. */
function unpackRows(src, at, lens, rowBytes, out) {
    let p = at;
    for (let y = 0; y < lens.length; y++) {
        const end = p + lens[y];
        let o = y * rowBytes;
        const stop = o + rowBytes;
        while (p < end && o < stop) {
            const n = src[p++];
            if (n < 128) {
                const c = Math.min(n + 1, stop - o, end - p);
                out.set(src.subarray(p, p + c), o);
                p += n + 1; o += c;
            } else if (n > 128) {
                const c = Math.min(257 - n, stop - o);
                out.fill(src[p++], o, o + c);
                o += c;
            }   // 128 is a no-op
        }
        p = end;
    }
    return p;
}

/** Undo the ZIP-with-prediction delta per row (8 bit: byte deltas, 16 bit: big-endian word deltas). */
function unpredict(buf, w, h, depth) {
    if (depth === 16) {
        const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) {
            const i = (y * w + x) * 2;
            v.setUint16(i, (v.getUint16(i) + v.getUint16(i - 2)) & 0xffff);
        }
    } else {
        for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) { const i = y * w + x; buf[i] = (buf[i] + buf[i - 1]) & 255; }
    }
}

/** One channel's samples as 8-bit bytes (w * h), from `compression` at r.p; the reader ends after `len` bytes. */
async function readChannel(r, compression, w, h, depth, dataLen, inflate) {
    const bpc = depth / 8, rowBytes = w * bpc;
    const out = new Uint8Array(w * h * bpc);
    const start = r.p;
    if (compression === 0) {
        out.set(r.bytes(Math.min(out.length, dataLen)));
    } else if (compression === 1) {
        const lens = new Array(h);
        for (let y = 0; y < h; y++) lens[y] = r.u16();
        const total = lens.reduce((a, b) => a + b, 0);
        r.need(total);
        unpackRows(r.b, r.p, lens, rowBytes, out);
        r.p += total;
    } else if (compression === 2 || compression === 3) {
        if (!inflate) throw new Error("a ZIP-compressed PSD channel needs an inflater");
        const raw = await inflate(r.bytes(dataLen));
        out.set(raw.subarray(0, Math.min(raw.length, out.length)));
        if (compression === 3) unpredict(out, w, h, depth);
    } else {
        throw new Error(`unknown PSD compression ${compression}`);
    }
    if (dataLen != null) r.p = start + dataLen;
    if (bpc === 1) return out;
    // 16 bit: round to 8 (x * 255 / 65535, i.e. the high byte with rounding)
    const o8 = new Uint8Array(w * h);
    for (let i = 0; i < o8.length; i++) o8[i] = Math.round(((out[2 * i] << 8) | out[2 * i + 1]) / 257);
    return o8;
}

function pascalName(r, pad) {
    const n = r.u8();
    const s = r.ascii(n);
    const used = 1 + n;
    const rest = (pad - (used % pad)) % pad;
    r.skip(rest);
    return s;
}

/** The additional layer info blocks of a layer record (between its name and its end): { key: bytes }. */
function additionalInfo(r, end) {
    const info = {};
    while (r.p + 12 <= end) {
        const sig = r.ascii(4);
        if (sig !== "8BIM" && sig !== "8B64") break;
        const key = r.ascii(4);
        const len = r.u32();
        if (r.p + len > end) break;
        info[key] = r.bytes(len);
    }
    return info;
}

function unicodeName(bytes) {
    if (!bytes || bytes.length < 4) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = v.getUint32(0);
    if (4 + 2 * n > bytes.length) return null;
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint16(4 + 2 * i));
    return s.replace(/\0+$/, "");
}

function sectionType(bytes) {
    if (!bytes || bytes.length < 4) return 0;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
}

/** Straight RGBA from the planar channels: gray replicated, a missing alpha opaque. */
function interleave(ch, w, h, gray) {
    const n = w * h, out = new Uint8ClampedArray(n * 4);
    const R = ch[0], G = gray ? ch[0] : ch[1], B = gray ? ch[0] : ch[2], A = ch[-1];
    for (let i = 0, o = 0; i < n; i++, o += 4) {
        out[o] = R ? R[i] : 0; out[o + 1] = G ? G[i] : 0; out[o + 2] = B ? B[i] : 0; out[o + 3] = A ? A[i] : 255;
    }
    return out;
}

/** Multiply a layer mask (its own rectangle, `def` outside it) into the layer's alpha. */
function applyMask(rgba, lx, ly, w, h, m) {
    for (let y = 0; y < h; y++) {
        const my = ly + y - m.top;
        for (let x = 0; x < w; x++) {
            const mx = lx + x - m.left;
            const v = mx >= 0 && my >= 0 && mx < m.w && my < m.h ? m.data[my * m.w + mx] : m.def;
            const o = (y * w + x) * 4 + 3;
            rgba[o] = Math.round(rgba[o] * v / 255);
        }
    }
}

function listNames(names, max = 6) {
    const shown = names.slice(0, max).map((n) => `"${n}"`).join(", ");
    return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

export async function readPsd(input, { inflate = null } = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const r = new Reader(bytes);
    if (r.ascii(4) !== "8BPS") throw new Error("not a PSD file");
    const version = r.u16();
    if (version === 2) throw new Error("this is a PSB (Photoshop's large document format), which is not read; save it as PSD (at most 30,000 px a side)");
    if (version !== 1) throw new Error(`unknown PSD version ${version}`);
    r.skip(6);
    const channels = r.u16(), height = r.u32(), width = r.u32(), depth = r.u16(), mode = r.u16();
    if (mode !== 3 && mode !== 1) throw new Error(`this PSD is in ${PSD_MODES[mode] || "mode " + mode} colour; only RGB and grayscale are read (convert it in Photoshop: Image > Mode > RGB)`);
    if (depth !== 8 && depth !== 16) throw new Error(`this PSD has ${depth} bits per channel; only 8 and 16 are read`);
    const gray = mode === 1;
    r.skip(r.u32());   // colour mode data
    r.skip(r.u32());   // image resources
    const notes = [];
    const lmLen = r.u32();
    const lmEnd = r.p + lmLen;
    const records = [];
    if (lmLen > 0) {
        const liLen = r.u32();
        const liEnd = r.p + liLen;
        if (liLen > 0) {
            const count = Math.abs(r.i16());
            for (let i = 0; i < count; i++) {
                const L = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), channels: [] };
                const nch = r.u16();
                for (let c = 0; c < nch; c++) L.channels.push({ id: r.i16(), len: r.u32() });
                if (r.ascii(4) !== "8BIM") throw new Error("a PSD layer record is damaged");
                L.blendKey = r.ascii(4);
                L.opacity = r.u8() / 255;
                L.clipping = r.u8();
                L.flags = r.u8();
                r.skip(1);
                const extraLen = r.u32();
                const extraEnd = r.p + extraLen;
                const maskLen = r.u32();
                const maskEnd = r.p + maskLen;
                if (maskLen >= 20) {
                    const m = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), def: r.u8(), flags: r.u8() };
                    L.mask = m;
                }
                r.p = maskEnd;
                r.skip(r.u32());   // blending ranges
                L.name = pascalName(r, 4);
                L.info = additionalInfo(r, extraEnd);
                r.p = extraEnd;
                L.name = unicodeName(L.info.luni) || L.name;
                L.section = sectionType(L.info.lsct || L.info.lsdk);
                records.push(L);
            }
            // channel image data, in record order
            for (const L of records) {
                const w = L.right - L.left, h = L.bottom - L.top;
                L.ch = {};
                for (const c of L.channels) {
                    const end = r.p + c.len;
                    if (c.len < 2) { r.p = end; continue; }
                    const comp = r.u16();
                    let cw = w, chh = h;
                    if (c.id === -2 || c.id === -3) {
                        if (!L.mask) { r.p = end; continue; }
                        cw = L.mask.right - L.mask.left; chh = L.mask.bottom - L.mask.top;
                    }
                    if (cw > 0 && chh > 0) L.ch[c.id] = await readChannel(r, comp, cw, chh, depth, c.len - 2, inflate);
                    r.p = end;
                }
            }
        }
        r.p = liEnd;
    }
    r.p = lmEnd;
    // the merged picture
    let composite = null;
    if (r.p + 2 <= bytes.length) {
        try {
            const comp = r.u16();
            const planes = {};
            const n = Math.min(channels, gray ? 2 : 4);
            if (comp === 1) {
                const lens = [];
                for (let i = 0; i < height * channels; i++) lens.push(r.u16());
                for (let c = 0; c < n; c++) {
                    const rowLens = lens.slice(c * height, (c + 1) * height);
                    const out = new Uint8Array(width * height * depth / 8);
                    r.p = unpackRows(bytes, r.p, rowLens, width * depth / 8, out);
                    planes[c] = out;
                }
            } else if (comp === 0) {
                for (let c = 0; c < n; c++) planes[c] = r.bytes(width * height * depth / 8).slice();
            }
            if (planes[0]) {
                const to8 = (p) => { if (!p || depth === 8) return p; const o = new Uint8Array(width * height); for (let i = 0; i < o.length; i++) o[i] = Math.round(((p[2 * i] << 8) | p[2 * i + 1]) / 257); return o; };
                const ch = gray ? { 0: to8(planes[0]), "-1": to8(planes[1]) } : { 0: to8(planes[0]), 1: to8(planes[1]), 2: to8(planes[2]), "-1": to8(planes[3]) };
                composite = interleave(ch, width, height, gray);
            }
        } catch (_) { composite = null; }
    }
    // records are bottom first; groups are a bounding divider (3) below their layers and a folder record (1 / 2) above
    const layers = [];
    let open = 0;   // open groups
    const adjust = [], empty = [], clipped = [], blends = [];
    let masked = 0, grouped = 0;
    for (const L of records) {
        if (L.section === 3) { open++; continue; }   // a group's bounding divider, below its layers
        if (L.section === 1 || L.section === 2) {
            // the folder record above them: its visibility and opacity go into every layer since the divider
            open = Math.max(0, open - 1);
            for (let i = layers.length - 1; i >= 0 && layers[i]._depth > open; i--) {
                layers[i].opacity *= L.opacity;
                if (L.flags & 2) layers[i].visible = false;
                layers[i]._depth = open;
            }
            grouped++;
            continue;
        }
        const w = L.right - L.left, h = L.bottom - L.top;
        if (Object.keys(L.info).some((k) => ADJUSTMENTS.has(k))) { adjust.push(L.name); continue; }
        if (!(w > 0 && h > 0) || !L.ch[0]) { if (L.name) empty.push(L.name); continue; }
        const rgba = interleave(L.ch, w, h, gray);
        const md = L.ch[-2] || L.ch[-3];
        if (L.mask && md && !(L.mask.flags & 2)) {
            applyMask(rgba, L.left, L.top, w, h, { top: L.mask.top, left: L.mask.left, w: L.mask.right - L.mask.left, h: L.mask.bottom - L.mask.top, def: L.mask.def, data: md });
            masked++;
        }
        let blend = PSD_BLENDS[L.blendKey];
        if (!blend) { blends.push(`${L.name} (${L.blendKey.trim()})`); blend = "normal"; }
        if (L.clipping) clipped.push(L.name);
        layers.push({ name: L.name || "Layer", x: L.left, y: L.top, w, h, opacity: L.opacity, visible: !(L.flags & 2), blend, rgba, _depth: open });
    }
    for (const l of layers) delete l._depth;
    if (adjust.length) notes.push(`${adjust.length} adjustment or fill layer${adjust.length > 1 ? "s" : ""} left out (${listNames(adjust)}): the picture can look different`);
    if (clipped.length) notes.push(`clipping masks are not kept (${listNames(clipped)} now cover${clipped.length > 1 ? "" : "s"} more)`);
    if (blends.length) notes.push(`blend modes the editor lacks became normal: ${listNames(blends)}`);
    if (masked) notes.push(`${masked} layer mask${masked > 1 ? "s" : ""} applied to ${masked > 1 ? "their layers'" : "its layer's"} transparency`);
    if (grouped) notes.push(`${grouped} group${grouped > 1 ? "s" : ""} flattened into their layers`);
    if (depth === 16) notes.push("16 bits per channel rounded to 8");
    if (empty.length && !layers.length && !composite) notes.push("no layer has pixels");
    return { width, height, layers, composite, notes };
}

// ---- OpenRaster -------------------------------------------------------------------------

/** The entries of a zip: { name: { method, data } } from the central directory. */
function unzip(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("the ORA file is not a complete zip");
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const out = {};
    for (let i = 0; i < count; i++) {
        if (v.getUint32(p, true) !== 0x02014b50) throw new Error("the ORA file's zip directory is damaged");
        const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
        const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
        const local = v.getUint32(p + 42, true);
        const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
        const lNameLen = v.getUint16(local + 26, true), lExtra = v.getUint16(local + 28, true);
        const at = local + 30 + lNameLen + lExtra;
        out[name] = { method, data: bytes.subarray(at, at + csize) };
        p += 46 + nameLen + extra + comment;
    }
    return out;
}

const attr = (tag, name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
    if (!m) return null;
    return (m[2] != null ? m[2] : m[3]).replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
};

export async function readOra(input, { inflateRaw = null } = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const zip = unzip(bytes);
    const get = async (name) => {
        const e = zip[name];
        if (!e) return null;
        if (e.method === 0) return e.data;
        if (e.method === 8) {
            if (!inflateRaw) throw new Error("a deflated ORA entry needs an inflater");
            return inflateRaw(e.data);
        }
        throw new Error(`unknown zip method ${e.method} for ${name}`);
    };
    const xmlBytes = await get("stack.xml");
    if (!xmlBytes) throw new Error("the ORA file has no stack.xml");
    const xml = new TextDecoder().decode(xmlBytes);
    const img = /<image\b[^>]*>/.exec(xml);
    if (!img) throw new Error("the ORA stack.xml has no <image>");
    const width = Math.round(+attr(img[0], "w")), height = Math.round(+attr(img[0], "h"));
    if (!(width > 0 && height > 0)) throw new Error("the ORA image has no size");
    const notes = [];
    const found = [];   // top first
    const blends = [], missing = [];
    let grouped = 0;
    const groups = [];   // open stacks (the outermost <stack> is the image itself)
    const re = /<(\/?)(stack|layer)\b([^>]*?)(\/?)>/g;
    let m, level = 0;
    while ((m = re.exec(xml))) {
        const [, close, kind, body, selfClose] = m;
        const tag = " " + body;
        if (kind === "stack") {
            if (close) { groups.pop(); level--; continue; }
            level++;
            const g = { visible: attr(tag, "visibility") !== "hidden", opacity: attr(tag, "opacity") != null ? +attr(tag, "opacity") : 1, x: +(attr(tag, "x") || 0), y: +(attr(tag, "y") || 0) };
            if (level > 1) grouped++;
            if (selfClose) { level--; continue; }
            groups.push(g);
            continue;
        }
        if (close) continue;
        const src = attr(tag, "src");
        const name = attr(tag, "name") || "Layer";
        let visible = attr(tag, "visibility") !== "hidden", opacity = attr(tag, "opacity") != null ? +attr(tag, "opacity") : 1;
        let x = +(attr(tag, "x") || 0), y = +(attr(tag, "y") || 0);
        for (const g of groups) { if (!g.visible) visible = false; opacity *= g.opacity; x += g.x; y += g.y; }
        const op = attr(tag, "composite-op") || "svg:src-over";
        let blend = ORA_BLENDS[op];
        if (!blend) { blends.push(`${name} (${op})`); blend = "normal"; }
        const png = src ? await get(src) : null;
        if (!png) { missing.push(name); continue; }
        found.push({ name, x: Math.round(x), y: Math.round(y), opacity: Math.max(0, Math.min(1, opacity)), visible, blend, png });
    }
    if (blends.length) notes.push(`blend modes the editor lacks became normal: ${listNames(blends)}`);
    if (missing.length) notes.push(`${missing.length} layer${missing.length > 1 ? "s" : ""} without a picture left out (${listNames(missing)})`);
    if (grouped) notes.push(`${grouped} group${grouped > 1 ? "s" : ""} flattened into their layers`);
    return { width, height, layers: found.reverse(), notes };
}
