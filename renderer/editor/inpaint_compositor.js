/**
 * The WebGL2 compositor (large-image plan, phase 5).
 *
 * Canvas 2D composites a layer stack by drawing each layer with a blend mode; at high
 * resolution that costs a full-size draw per layer per frame. This module does the same
 * stacking on the GPU: every source canvas becomes a texture (cached by a version the
 * editor bumps when the pixels change), and the visible region is composited in one shader
 * pass per layer into a viewport-sized framebuffer.
 *
 * What it does NOT do, on purpose: it stacks prepared layer pixels. Masks, colour match,
 * the stroke preview and pending transforms stay where they are - the editor hands over the
 * canvas it would have drawn (`layerPixels`), so every one of those features keeps working
 * unchanged. Filter layers interrupt the chain: the caller renders the stack so far, runs
 * the filter as before and starts a new chain on the result.
 *
 * The blend modes follow the W3C compositing spec and were checked against Canvas 2D over
 * every combination of colour and alpha: at most 2.3 levels apart in premultiplied values
 * (what reaches the screen), mean 0.3. Straight-alpha values differ more where alpha is
 * near zero, which is the 8-bit rounding of the stored premultiplied byte, not a different
 * picture.
 *
 * The editor keeps its Canvas 2D path. `GLCompositor.available()` decides, and the caller
 * falls back whenever this module returns null - the node runs in the user's browser and
 * must not depend on WebGL2.
 */

import { TILE_SIZE, MIP_LEVELS, GUTTER, slotSide } from "./inpaint_tiles.js";

export const BLEND_INDEX = {
    normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4,
    lighten: 5, "soft-light": 6, "hard-light": 7, difference: 8,
};

const VS = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect;      // x, y, w, h of the quad in clip space
out vec2 v_uv;
void main() {
    v_uv = a_pos;
    vec2 p = u_rect.xy + a_pos * u_rect.zw;
    gl_Position = vec4(p, 0.0, 1.0);
}`;

// The blend maths and the compositing step, shared by the quad shader (one source canvas) and the
// atlas shader (one instanced quad per tile).
const BLEND_GLSL = `
uniform sampler2D u_backdrop;   // what is under this layer, straight alpha
uniform sampler2D u_source;     // the layer's pixels, premultiplied
uniform int u_mode;
uniform float u_opacity;
uniform vec2 u_size;            // framebuffer size, to sample the backdrop by position

float bScreen(float b, float s) { return b + s - b * s; }
float bHardLight(float b, float s) { return s <= 0.5 ? b * (2.0 * s) : bScreen(b, 2.0 * s - 1.0); }
float bSoftLight(float b, float s) {
    float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
    return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (d - b);
}
float blend1(float b, float s) {
    if (u_mode == 1) return b * s;
    if (u_mode == 2) return bScreen(b, s);
    if (u_mode == 3) return bHardLight(s, b);   // overlay: hard-light with the arguments swapped
    if (u_mode == 4) return min(b, s);
    if (u_mode == 5) return max(b, s);
    if (u_mode == 6) return bSoftLight(b, s);
    if (u_mode == 7) return bHardLight(b, s);
    if (u_mode == 8) return abs(b - s);
    return s;
}

vec4 blendOver(vec4 Sp) {
    // The backdrop is a framebuffer texture: same orientation as gl_FragCoord, no flip.
    vec2 fb = gl_FragCoord.xy / u_size;
    vec4 B = texture(u_backdrop, fb);
    // Source textures are premultiplied so that scaling interpolates the way Canvas 2D does
    // (straight alpha bleeds colour across transparent edges); the blend maths needs straight
    // values again.
    vec4 S = vec4(Sp.a > 0.0 ? Sp.rgb / Sp.a : vec3(0.0), Sp.a);
    float as = S.a * u_opacity;
    float ab = B.a;
    vec3 blended = vec3(blend1(B.r, S.r), blend1(B.g, S.g), blend1(B.b, S.b));
    vec3 cs = mix(S.rgb, blended, ab);
    float ao = as + ab * (1.0 - as);
    vec3 co = cs * as + B.rgb * ab * (1.0 - as);
    return vec4(ao > 0.0 ? co / ao : vec3(0.0), ao);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
` + BLEND_GLSL + `
void main() {
    // A layer's texture comes from a canvas, whose first row is the top, so it is sampled
    // upside down against the quad's own coordinates.
    fragColor = blendOver(texture(u_source, vec2(v_uv.x, 1.0 - v_uv.y)));
}`;

// The same for one tile of an atlas page: the vertex shader has already put v_uv inside the
// tile's own slot, gutter excluded, in the page's orientation.
const ATLAS_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
` + BLEND_GLSL + `
void main() {
    fragColor = blendOver(texture(u_source, v_uv));
}`;

// ---- the tile atlas (docs/PLAN_BCE.md §C3) ------------------------------------------------------

// A page holds the slots of one (pixels object, level). Its side is at most this, and at most
// `ATLAS_MAX_PER` slots a side: at level 0 a slot is 258 px, so 15 fit a side and a full page is
// 59 MB of tiles; at level 5 a slot is 10 px and a page is 160 px. The first page of a pixels
// object at a level is made no larger than the tiles asked for in that frame, so a small document
// does not pay for a page it cannot fill.
const ATLAS_PAGE_MAX = 4096;
const ATLAS_MAX_PER = 16;
// Pages are an LRU by bytes. The default is the `settings.memory.atlasMB` row in Settings ›
// Rendering; the memory watch lowers it under pressure.
const ATLAS_BUDGET_DEFAULT = 512 * 1024 * 1024;
// and an age, like the source textures: a page no composite asked for in this many composites is
// dropped whatever the budget says (the pixels of a layer that a flip or a transform replaced).
const ATLAS_STALE = 300;

const ATLAS_VS = `#version 300 es
in vec2 a_pos;
in vec4 a_rect;          // the tile's rectangle in image coordinates: x, y, w, h
in vec4 a_uv;            // its interior in the page: u0, v0 (the tile's first row), du, dv
uniform vec4 u_region;   // the image rectangle the output shows: x, y, w, h
out vec2 v_uv;
void main() {
    // the page holds the tile's first row at the lowest v (texSubImage2D from a typed array does
    // not flip), so the quad's top edge samples v0, as a canvas source does in FS
    v_uv = vec2(a_uv.x + a_pos.x * a_uv.z, a_uv.y + (1.0 - a_pos.y) * a_uv.w);
    // image coordinates -> the region -> clip space (y up). The region is a uniform, so an instance
    // buffer survives a pan: only another set of visible tiles rebuilds it.
    vec2 q = (a_rect.xy - u_region.xy) / u_region.zw;
    vec2 qs = a_rect.zw / u_region.zw;
    // a_pos.y = 0 is the quad's bottom in clip space (the tile's last row), 1 its top
    vec2 p = vec2(q.x * 2.0 - 1.0, 1.0 - (q.y + qs.y) * 2.0) + a_pos * (qs * 2.0);
    gl_Position = vec4(p, 0.0, 1.0);
}`;

const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
void main() { fragColor = texture(u_tex, v_uv); }`;

function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error("compositor shader: " + log);
    }
    return s;
}

function link(gl, vsSrc, fsSrc) {
    const p = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error("compositor program: " + log);
    }
    return p;
}

// What the source textures may cost. A stack of ten layers needs ten, plus the levels a
// zoom step leaves behind; beyond that they are uploads nobody asked for again. The
// budget is in bytes because the count says nothing: one level-0 texture of a 96 MP
// source is 384 MB and 48 small ones are 12.
const TEXTURE_BUDGET = 1024 * 1024 * 1024;
const TEXTURE_CACHE = 64;   // and a plain count, so a stack of tiny sources cannot grow forever
// and an age: the map keys on the source canvases and keeps them alive, so a source no composite asked
// for in this many composites is dropped whatever the budget says (a layer's replaced pixels after a
// flip or a transform: charged only their window's bytes, they could otherwise stay for a long time)
const TEXTURE_STALE = 300;

// A source above this many pixels is not uploaded whole: the compositor keeps a window of it,
// the part the view shows plus a margin of half the view on each side (phase A item 4 of
// docs/PLAN_TILES.md). At 1:1 on a 15k document the whole source is a 600 MB upload that held
// the first frame after a zoom for 58 to 320 ms and then sat in VRAM per layer; the window is
// a few tens of MB and survives a pan inside its margin.
const WINDOW_PX = 16 * 1024 * 1024;

let SUPPORTED = null;

export class GLCompositor {
    /** Whether this host can run the compositor at all (cached; never throws). */
    static available() {
        if (SUPPORTED !== null) return SUPPORTED;
        try {
            const c = document.createElement("canvas");
            c.width = c.height = 1;
            const gl = c.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: false });
            SUPPORTED = !!gl;
            if (gl && gl.getExtension("WEBGL_lose_context")) gl.getExtension("WEBGL_lose_context").loseContext();
        } catch (_) {
            SUPPORTED = false;
        }
        return SUPPORTED;
    }

    constructor() {
        this.canvas = document.createElement("canvas");
        this.canvas.width = this.canvas.height = 1;
        this.gl = this.canvas.getContext("webgl2", {
            alpha: true,
            premultipliedAlpha: false,   // the editor's canvases carry straight alpha
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: true,
            desynchronized: false,
        });
        if (!this.gl) throw new Error("no WebGL2 context for the compositor");
        const gl = this.gl;
        this.prog = link(gl, VS, FS);
        this.copy = link(gl, VS, COPY_FS);
        this.atlasProg = link(gl, ATLAS_VS, ATLAS_FS);
        this.quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
        for (const p of [this.prog, this.copy]) {
            const loc = gl.getAttribLocation(p, "a_pos");
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        }
        // The atlas path: one quad, one instance of { rect(4), uv(4) } per visible tile. The divisors
        // live in a vertex array of their own, so the two quad programs keep the default one untouched.
        this.inst = gl.createBuffer();
        this.vaoTiles = gl.createVertexArray();
        gl.bindVertexArray(this.vaoTiles);
        const aPos = gl.getAttribLocation(this.atlasProg, "a_pos");
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(aPos, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
        for (const [name, off] of [["a_rect", 0], ["a_uv", 16]]) {
            const loc = gl.getAttribLocation(this.atlasProg, name);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 32, off);
            gl.vertexAttribDivisor(loc, 1);
        }
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        this.atlasU = {
            backdrop: gl.getUniformLocation(this.atlasProg, "u_backdrop"),
            source: gl.getUniformLocation(this.atlasProg, "u_source"),
            mode: gl.getUniformLocation(this.atlasProg, "u_mode"),
            opacity: gl.getUniformLocation(this.atlasProg, "u_opacity"),
            size: gl.getUniformLocation(this.atlasProg, "u_size"),
            region: gl.getUniformLocation(this.atlasProg, "u_region"),
        };
        // pixels object -> level -> { pages }; the pages hold the tiles the screen showed
        this.atlas = new Map();
        this.atlasBytes = 0;
        this.atlasBudget = ATLAS_BUDGET_DEFAULT;
        this.atlasGen = 0;   // bumped whenever a page or a slot changes hands: cached instances are stale
        this.tileBufs = [];
        this.tileUploads = 0;
        this.tileDraws = 0;
        this.pagesMade = 0;
        this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        // source canvas -> { tex, version, w, h, used }. Pyramid levels are new canvases
        // after every change, so without a cap this map would grow for the whole session.
        this.textures = new Map();
        this.frame = 0;
        this.targets = [];           // two framebuffers to ping-pong between
        this.lost = false;
        this.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; });
    }

    /** A framebuffer with its colour texture, sized w x h. */
    _target(i, w, h) {
        const gl = this.gl;
        let t = this.targets[i];
        if (!t) {
            t = { fb: gl.createFramebuffer(), tex: gl.createTexture(), w: 0, h: 0 };
            this.targets[i] = t;
        }
        if (t.w !== w || t.h !== h) {
            gl.bindTexture(gl.TEXTURE_2D, t.tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
            t.w = w; t.h = h;
        }
        return t;
    }

    /**
     * The texture for a source canvas. `version` is the editor's counter for those pixels:
     * the upload only happens when it changed, which is what makes panning cheap.
     */
    _texture(source, version) {
        const gl = this.gl;
        let entry = this.textures.get(source);
        if (!entry) {
            entry = { tex: gl.createTexture(), version: null, w: 0, h: 0 };
            this.textures.set(source, entry);
        }
        const w = source.width, h = source.height;
        if (entry.version !== version || entry.w !== w || entry.h !== h) {
            if (w > this.maxTexture || h > this.maxTexture) return null;   // the caller falls back
            gl.bindTexture(gl.TEXTURE_2D, entry.tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            entry.version = version;
            entry.w = w;
            entry.h = h;
        }
        entry.used = this.frame;
        return entry.tex;
    }

    /**
     * The texture of a source for this frame, with the source rectangle it covers: the whole
     * source below WINDOW_PX, else a window around the part of it the view shows. `need` is
     * that part in source pixels ({ x, y, w, h }); a cached window is reused while it still
     * holds it and the version is unchanged. Null when the source cannot be uploaded.
     */
    _source(source, version, need) {
        const gl = this.gl;
        const sw = source.width, sh = source.height;
        if (sw * sh <= WINDOW_PX) {
            const tex = this._texture(source, version);
            return tex ? { tex, x: 0, y: 0, w: sw, h: sh } : null;
        }
        let entry = this.textures.get(source);
        if (!entry) {
            entry = { tex: gl.createTexture(), version: null, w: 0, h: 0, x: 0, y: 0, window: true };
            this.textures.set(source, entry);
        }
        // the needed rectangle, clamped to the source; nothing to draw when the layer is off screen
        const nx0 = Math.max(0, Math.floor(need.x)), ny0 = Math.max(0, Math.floor(need.y));
        const nx1 = Math.min(sw, Math.ceil(need.x + need.w)), ny1 = Math.min(sh, Math.ceil(need.y + need.h));
        if (nx1 <= nx0 || ny1 <= ny0) return { tex: null, x: 0, y: 0, w: 0, h: 0 };
        const inside = entry.version === version && entry.window && nx0 >= entry.x && ny0 >= entry.y && nx1 <= entry.x + entry.w && ny1 <= entry.y + entry.h;
        if (!inside) {
            const mx = Math.ceil((nx1 - nx0) / 2), my = Math.ceil((ny1 - ny0) / 2);
            let x = Math.max(0, nx0 - mx), y = Math.max(0, ny0 - my);
            let w = Math.min(sw, nx1 + mx) - x, h = Math.min(sh, ny1 + my) - y;
            w = Math.min(w, this.maxTexture); h = Math.min(h, this.maxTexture);
            if (w <= 0 || h <= 0) return null;
            if (!this.scratch) this.scratch = document.createElement("canvas");
            const sc = this.scratch;
            if (sc.width !== w || sc.height !== h) { sc.width = w; sc.height = h; }
            const cx = sc.getContext("2d");
            cx.setTransform(1, 0, 0, 1, 0, 0);
            cx.globalAlpha = 1;
            cx.globalCompositeOperation = "source-over";
            cx.clearRect(0, 0, w, h);
            cx.drawImage(source, x, y, w, h, 0, 0, w, h);
            gl.bindTexture(gl.TEXTURE_2D, entry.tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sc);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            entry.version = version;
            entry.x = x; entry.y = y; entry.w = w; entry.h = h;
            entry.window = true;
            this.windowUploads = (this.windowUploads || 0) + 1;
        }
        entry.used = this.frame;
        return { tex: entry.tex, x: entry.x, y: entry.y, w: entry.w, h: entry.h };
    }

    /** Drop the textures that no recent frame asked for, oldest first, never this frame's. */
    _evict() {
        for (const [src, e] of this.textures) {
            if (this.frame - (e.used || 0) <= TEXTURE_STALE) continue;
            try { this.gl.deleteTexture(e.tex); } catch (_) { /* context gone */ }
            this.textures.delete(src);
        }
        let bytes = 0;
        for (const e of this.textures.values()) bytes += (e.w || 0) * (e.h || 0) * 4;
        if (bytes <= TEXTURE_BUDGET && this.textures.size <= TEXTURE_CACHE) return;
        const entries = [...this.textures.entries()].sort((a, b) => (a[1].used || 0) - (b[1].used || 0));
        for (const [src, e] of entries) {
            if (bytes <= TEXTURE_BUDGET && this.textures.size <= TEXTURE_CACHE) break;
            if (e.used === this.frame) continue;   // the stack being drawn right now
            try { this.gl.deleteTexture(e.tex); } catch (_) { /* context gone */ }
            this.textures.delete(src);
            bytes -= (e.w || 0) * (e.h || 0) * 4;
        }
    }

    /**
     * What the cache holds, for the memory report: entries, the bytes of the source
     * textures (RGBA8, so w * h * 4) and the bytes of the two ping-pong targets.
     */
    stats() {
        let bytes = 0, windows = 0, windowBytes = 0, sourceBytes = 0;
        for (const [src, e] of this.textures) {
            const b = (e.w || 0) * (e.h || 0) * 4;
            bytes += b;
            if (e.window) { windows++; windowBytes += b; }
            sourceBytes += (src.width || 0) * (src.height || 0) * 4;   // the canvases the map keeps alive as keys
        }
        let targetBytes = 0;
        for (const t of this.targets) if (t) targetBytes += (t.w || 0) * (t.h || 0) * 4;
        const scratchBytes = this.scratch ? this.scratch.width * this.scratch.height * 4 : 0;
        let pages = 0, slots = 0, sources = 0;
        for (const byLevel of this.atlas.values()) {
            sources++;
            for (const entry of byLevel.values()) for (const page of entry.pages) { pages++; slots += page.slots.size; }
        }
        const atlas = {
            pages, slots, sources, bytes: this.atlasBytes, budget: this.atlasBudget,
            uploads: this.tileUploads, draws: this.tileDraws, pagesMade: this.pagesMade,
        };
        return { entries: this.textures.size, bytes, sourceBytes, targetBytes, windows, windowBytes, scratchBytes, windowUploads: this.windowUploads || 0, budget: TEXTURE_BUDGET, limit: TEXTURE_CACHE, stale: TEXTURE_STALE, atlas, lost: this.lost };
    }

    /** The atlas's byte budget (settings.memory.atlasMB); pages above it are dropped LRU. */
    setAtlasBudget(bytes) {
        this.atlasBudget = Math.max(16 * 1024 * 1024, bytes | 0);
    }

    /** Drop the texture of a source the editor threw away (its atlas pages too, when it is pixels). */
    forget(source) {
        this.forgetPixels(source);
        const entry = this.textures.get(source);
        if (!entry) return;
        try { this.gl.deleteTexture(entry.tex); } catch (_) { /* context gone */ }
        this.textures.delete(source);
    }

    /**
     * The atlas entry of a pixels object at a level: its pages, newest last. Pages hold slots of
     * `slotSide(level)` px; a slot is keyed by the tile key and carries the tile's version, so a
     * tile that changed is re-uploaded and nothing else is.
     */
    _atlasAt(pixels, level) {
        let byLevel = this.atlas.get(pixels);
        if (!byLevel) { byLevel = new Map(); this.atlas.set(pixels, byLevel); }
        let entry = byLevel.get(level);
        if (!entry) { entry = { level, pages: [] }; byLevel.set(level, entry); }
        return entry;
    }

    /** A new page for `entry`, holding at least `want` slots (at most ATLAS_MAX_PER a side). */
    _newPage(entry, S, want) {
        const gl = this.gl;
        const max = Math.max(1, Math.min(ATLAS_MAX_PER, Math.floor(ATLAS_PAGE_MAX / S)));
        const per = Math.max(1, Math.min(max, Math.ceil(Math.sqrt(Math.max(1, want)))));
        const side = per * S;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, side, side, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const page = { tex, side, per, S, slots: new Map(), free: [], used: this.frame, bytes: side * side * 4, insts: [] };
        for (let i = per * per - 1; i >= 0; i--) page.free.push(i);
        entry.pages.push(page);
        this.atlasBytes += page.bytes;
        this.pagesMade++;
        return page;
    }

    /**
     * The slot of one tile: the page that already holds it, or a free slot in one of the entry's
     * pages, or a new page. When every page is full the least recently drawn slot of the last page
     * is taken (never one this frame). Returns { page, i } or null when nothing could be had.
     */
    _slot(entry, key, S, want) {
        for (const page of entry.pages) {
            const have = page.slots.get(key);
            if (have) { page.used = this.frame; have.used = this.frame; return { page, slot: have }; }
        }
        for (const page of entry.pages) {
            if (!page.free.length) continue;
            const slot = { i: page.free.pop(), version: -1, used: this.frame };
            page.slots.set(key, slot);
            page.used = this.frame;
            return { page, slot };
        }
        if (this.atlasBytes < this.atlasBudget) {
            const page = this._newPage(entry, S, want - this._entrySlots(entry));
            const slot = { i: page.free.pop(), version: -1, used: this.frame };
            page.slots.set(key, slot);
            return { page, slot };
        }
        // over the budget: reuse the slot of the tile that was drawn longest ago
        for (let p = entry.pages.length - 1; p >= 0; p--) {
            const page = entry.pages[p];
            let oldest = null, oldestKey = null;
            for (const [k, s] of page.slots) {
                if (s.used === this.frame) continue;
                if (!oldest || s.used < oldest.used) { oldest = s; oldestKey = k; }
            }
            if (!oldest) continue;
            page.slots.delete(oldestKey);
            const slot = { i: oldest.i, version: -1, used: this.frame };
            this.atlasGen++;
            page.slots.set(key, slot);
            page.used = this.frame;
            return { page, slot };
        }
        return null;
    }

    _entrySlots(entry) {
        let n = 0;
        for (const page of entry.pages) n += page.slots.size;
        return n;
    }

    /**
     * The instanced draws of one tile-backed layer for this frame: the visible tiles of `l.pixels`
     * at `l.level`, uploaded into atlas slots where their version changed, as one instance buffer
     * per page ({ tex, data, count }). Null when a tile could not be given a slot at all.
     */
    _tileInstances(l, region) {
        const px = l.pixels;
        const level = Math.max(0, Math.min(MIP_LEVELS, l.level | 0));
        const f = 1 << level;
        const S = slotSide(level);
        const fx = l.w / px.width, fy = l.h / px.height;
        // the visible part of the layer in its own pixels
        const nx0 = Math.max(0, Math.floor((region.x - l.x) / fx));
        const ny0 = Math.max(0, Math.floor((region.y - l.y) / fy));
        const nx1 = Math.min(px.width, Math.ceil((region.x + region.w - l.x) / fx));
        const ny1 = Math.min(px.height, Math.ceil((region.y + region.h - l.y) / fy));
        if (nx1 <= nx0 || ny1 <= ny0) return [];
        const tx0 = nx0 >> 8, tx1 = (nx1 - 1) >> 8, ty0 = ny0 >> 8, ty1 = (ny1 - 1) >> 8;
        const entry = this._atlasAt(px, level);
        // The instances are in image coordinates, so a pan reuses them; only another set of visible
        // tiles, a write into the pixels, a layer that moved or an eviction rebuilds the buffers. At
        // fit on a 15k document that is 2,400 tiles to walk every frame, 1.9 ms against 0.1 from here.
        const key = tx0 + "," + ty0 + "," + tx1 + "," + ty1 + "," + px.version + "," + l.x + "," + l.y + "," + l.w + "," + l.h + "," + this.atlasGen;
        if (entry.cache && entry.cache.key === key) {
            for (const g of entry.cache.groups) { g.page.used = this.frame; for (const s of g.slots) s.used = this.frame; }
            return entry.cache.groups;
        }
        const want = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
        const groups = new Map();
        const held = new Map();   // the slots each page's instances name, so a cached frame can touch them
        let buf = this.tileBufs[level] || null;
        for (let ty = ty0; ty <= ty1; ty++) {
            for (let tx = tx0; tx <= tx1; tx++) {
                const tile = px.tileAt(tx, ty);
                if (!tile) continue;                       // a missing tile is transparent
                const got = this._slot(entry, (ty << 16) | tx, S, want);
                if (!got) return null;
                const { page, slot } = got;
                if (slot.version !== tile.version) {
                    const bytes = px.tileWithGutter(tx, ty, level, buf);
                    if (!bytes) continue;
                    if (!buf || buf.length < bytes.length) { buf = bytes; this.tileBufs[level] = bytes; }
                    const sx = (slot.i % page.per) * S, sy = Math.floor(slot.i / page.per) * S;
                    this.gl.bindTexture(this.gl.TEXTURE_2D, page.tex);
                    this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT, 4);
                    // The slot's bytes are premultiplied already. Chromium applies the two unpack
                    // switches to an ArrayBufferView upload as well, and a canvas source uploaded
                    // earlier in the same frame leaves PREMULTIPLY on: without this the tiles are
                    // premultiplied twice and every partly transparent pixel loses its colour
                    // (the anti-aliased edge of a text layer disappeared, 65 levels).
                    this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false);
                    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, sx, sy, S, S, this.gl.RGBA, this.gl.UNSIGNED_BYTE, bytes);
                    slot.version = tile.version;
                    this.tileUploads++;
                }
                slot.used = this.frame;
                page.used = this.frame;
                let g = groups.get(page);
                if (!g) { g = []; groups.set(page, g); held.set(page, []); }
                held.get(page).push(slot);
                // the tile's rectangle in image coordinates, clipped to the image at the last row / column
                const ox = tx << 8, oy = ty << 8;
                const vw = Math.min(TILE_SIZE, px.width - ox), vh = Math.min(TILE_SIZE, px.height - oy);
                const px0 = (slot.i % page.per) * S + GUTTER, py0 = Math.floor(slot.i / page.per) * S + GUTTER;
                g.push(
                    l.x + ox * fx, l.y + oy * fy, vw * fx, vh * fy,
                    px0 / page.side, py0 / page.side, (vw / f) / page.side, (vh / f) / page.side,
                );
            }
        }
        const out = [];
        for (const [page, data] of groups) out.push({ page, tex: page.tex, data: new Float32Array(data), count: data.length >> 3, slots: held.get(page) || [] });
        entry.cache = { key, groups: out };
        return out;
    }

    /** Draw one layer's tiles, blended with the backdrop `srcTex`, into the bound framebuffer. */
    _drawTiles(prepared, srcTex, W, H, region) {
        const gl = this.gl;
        gl.useProgram(this.atlasProg);
        gl.bindVertexArray(this.vaoTiles);
        gl.uniform1i(this.atlasU.backdrop, 0);
        gl.uniform1i(this.atlasU.source, 1);
        gl.uniform1i(this.atlasU.mode, BLEND_INDEX[prepared.blend] || 0);
        gl.uniform1f(this.atlasU.opacity, prepared.opacity == null ? 1 : prepared.opacity);
        gl.uniform2f(this.atlasU.size, W, H);
        gl.uniform4f(this.atlasU.region, region.x, region.y, region.w, region.h);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        for (const g of prepared.tiles) {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, g.tex);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
            gl.bufferData(gl.ARRAY_BUFFER, g.data, gl.DYNAMIC_DRAW);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, g.count);
            this.tileDraws += g.count;
        }
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    }

    /**
     * Drop the atlas pages of a pixels object (its pixels were replaced, or the editor threw it
     * away); the bytes they held.
     */
    forgetPixels(pixels) {
        const byLevel = this.atlas.get(pixels);
        if (!byLevel) return 0;
        let bytes = 0;
        for (const entry of byLevel.values()) for (const page of entry.pages) { bytes += page.bytes; this._deletePage(page); }
        this.atlas.delete(pixels);
        return bytes;
    }

    /** The bytes the atlas holds for a pixels object (memoryReport). */
    pixelBytes(pixels) {
        const byLevel = this.atlas.get(pixels);
        if (!byLevel) return 0;
        let bytes = 0;
        for (const entry of byLevel.values()) for (const page of entry.pages) bytes += page.bytes;
        return bytes;
    }

    _deletePage(page) {
        this.atlasGen++;
        this.atlasBytes -= page.bytes;
        try { this.gl.deleteTexture(page.tex); } catch (_) { /* context gone */ }
    }

    /** Pages no recent composite asked for, then the least recently used, until the budget holds. */
    _evictAtlas() {
        const all = [];
        for (const [pixels, byLevel] of this.atlas) {
            for (const [level, entry] of byLevel) {
                entry.pages = entry.pages.filter((page) => {
                    if (this.frame - page.used <= ATLAS_STALE) return true;
                    this._deletePage(page);
                    return false;
                });
                if (!entry.pages.length) byLevel.delete(level);
                else for (const page of entry.pages) all.push({ pixels, byLevel, level, entry, page });
            }
            if (!byLevel.size) this.atlas.delete(pixels);
        }
        if (this.atlasBytes <= this.atlasBudget) return;
        all.sort((a, b) => a.page.used - b.page.used);
        for (const it of all) {
            if (this.atlasBytes <= this.atlasBudget) break;
            if (it.page.used === this.frame) continue;
            it.entry.pages = it.entry.pages.filter((p) => p !== it.page);
            this._deletePage(it.page);
            if (!it.entry.pages.length) it.byLevel.delete(it.level);
            if (!it.byLevel.size) this.atlas.delete(it.pixels);
        }
    }

    /**
     * Composite a stack.
     *
     *   spec.width / spec.height   the output size in pixels (the viewport)
     *   spec.region                { x, y, w, h } of the image the output shows
     *   spec.layers                bottom first: { source, version, x, y, w, h, opacity, blend }
     *                              in image coordinates. `source` is a canvas the caller
     *                              already prepared (mask, colour match, stroke preview).
     *
     * Returns the compositor's canvas, or null when it cannot do this stack (a source
     * larger than MAX_TEXTURE_SIZE, a lost context): the caller then uses Canvas 2D.
     */
    composite(spec) {
        if (this.lost) return null;
        const gl = this.gl;
        this.frame++;
        const W = Math.max(1, Math.round(spec.width));
        const H = Math.max(1, Math.round(spec.height));
        const region = spec.region;
        const layers = spec.layers || [];
        // every source has to fit a texture before anything is drawn: a fallback halfway
        // through would leave the caller with a half-composited picture. A large source is
        // uploaded as a window around what the view shows; the layer's rectangle is then the
        // window's, mapped back into image coordinates.
        const prepared = [];
        for (const l of layers) {
            if (!l) continue;
            if (l.pixels) {
                // a tile store: its visible tiles are uploaded into atlas slots and drawn instanced
                const tiles = this._tileInstances(l, region);
                if (!tiles) return null;
                if (tiles.length) prepared.push({ ...l, tiles });
                continue;
            }
            if (!l.source) continue;
            const sw = l.source.width, sh = l.source.height;
            const fx = l.w / sw, fy = l.h / sh;   // image pixels per source pixel
            const need = { x: (region.x - l.x) / fx, y: (region.y - l.y) / fy, w: region.w / fx, h: region.h / fy };
            const s = this._source(l.source, l.version, need);
            if (!s) return null;
            if (!s.tex) continue;   // off screen
            prepared.push({ ...l, tex: s.tex, x: l.x + s.x * fx, y: l.y + s.y * fy, w: s.w * fx, h: s.h * fy });
        }
        if (this.canvas.width !== W || this.canvas.height !== H) {
            this.canvas.width = W;
            this.canvas.height = H;
        }
        const a = this._target(0, W, H);
        const b = this._target(1, W, H);
        gl.viewport(0, 0, W, H);
        gl.disable(gl.BLEND);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);

        // start from an empty backdrop
        gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        let src = a, dst = b;
        gl.useProgram(this.prog);
        const uRect = gl.getUniformLocation(this.prog, "u_rect");
        const uMode = gl.getUniformLocation(this.prog, "u_mode");
        const uOpacity = gl.getUniformLocation(this.prog, "u_opacity");
        const uSize = gl.getUniformLocation(this.prog, "u_size");
        gl.uniform1i(gl.getUniformLocation(this.prog, "u_backdrop"), 0);
        gl.uniform1i(gl.getUniformLocation(this.prog, "u_source"), 1);
        const loc = gl.getAttribLocation(this.prog, "a_pos");
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

        for (const l of prepared) {
            if (l.tiles) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.useProgram(this.copy);
                gl.uniform4f(gl.getUniformLocation(this.copy, "u_rect"), -1, -1, 2, 2);
                gl.uniform1i(gl.getUniformLocation(this.copy, "u_tex"), 0);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, src.tex);
                const tloc = gl.getAttribLocation(this.copy, "a_pos");
                gl.enableVertexAttribArray(tloc);
                gl.vertexAttribPointer(tloc, 2, gl.FLOAT, false, 0, 0);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
                this._drawTiles(l, src.tex, W, H, region);
                const t2 = src; src = dst; dst = t2;
                gl.useProgram(this.prog);
                gl.enableVertexAttribArray(loc);
                gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
                continue;
            }
            // the layer's rectangle in the output, then in clip space (-1..1, y up)
            const sx = (l.x - region.x) / region.w;
            const sy = (l.y - region.y) / region.h;
            const sw = l.w / region.w;
            const sh = l.h / region.h;
            const x0 = sx * 2 - 1;
            const y1 = 1 - sy * 2;            // the output's y grows downwards, clip space upwards
            gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            // the backdrop has to survive where the layer does not cover: copy it first
            gl.useProgram(this.copy);
            gl.uniform4f(gl.getUniformLocation(this.copy, "u_rect"), -1, -1, 2, 2);
            gl.uniform1i(gl.getUniformLocation(this.copy, "u_tex"), 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, src.tex);
            const cloc = gl.getAttribLocation(this.copy, "a_pos");
            gl.enableVertexAttribArray(cloc);
            gl.vertexAttribPointer(cloc, 2, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            // then the layer's own rectangle, blended with the backdrop under it
            gl.useProgram(this.prog);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
            gl.uniform4f(uRect, x0, y1 - sh * 2, sw * 2, sh * 2);
            gl.uniform1i(uMode, BLEND_INDEX[l.blend] || 0);
            gl.uniform1f(uOpacity, l.opacity == null ? 1 : l.opacity);
            gl.uniform2f(uSize, W, H);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, src.tex);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, l.tex);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            const t = src; src = dst; dst = t;
        }

        // the result to the visible canvas
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, W, H);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.copy);
        gl.uniform4f(gl.getUniformLocation(this.copy, "u_rect"), -1, -1, 2, 2);
        gl.uniform1i(gl.getUniformLocation(this.copy, "u_tex"), 0);
        const cloc2 = gl.getAttribLocation(this.copy, "a_pos");
        gl.enableVertexAttribArray(cloc2);
        gl.vertexAttribPointer(cloc2, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        this._evict();
        this._evictAtlas();
        return this.canvas;
    }

    /** Drop every cached source texture, keep the context (the next frame uploads again). */
    clear() {
        try {
            for (const e of this.textures.values()) this.gl.deleteTexture(e.tex);
        } catch (_) { /* context gone */ }
        this.textures.clear();
        for (const byLevel of this.atlas.values()) for (const entry of byLevel.values()) for (const page of entry.pages) this._deletePage(page);
        this.atlas.clear();
        this.atlasBytes = 0;
        this.tileBufs = [];
        if (this.scratch) { this.scratch.width = this.scratch.height = 1; }
    }

    dispose() {
        const gl = this.gl;
        try {
            for (const e of this.textures.values()) gl.deleteTexture(e.tex);
            this.textures.clear();
            for (const byLevel of this.atlas.values()) for (const entry of byLevel.values()) for (const page of entry.pages) this._deletePage(page);
            this.atlas.clear();
            this.atlasBytes = 0;
            this.tileBufs = [];
            gl.deleteBuffer(this.inst);
            gl.deleteVertexArray(this.vaoTiles);
            gl.deleteProgram(this.atlasProg);
            for (const t of this.targets) { if (t) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); } }
            this.targets = [];
            if (this.scratch) { this.scratch.width = this.scratch.height = 0; this.scratch = null; }
            gl.deleteProgram(this.prog);
            gl.deleteProgram(this.copy);
            gl.deleteBuffer(this.quad);
            // A context is only dropped when its canvas is collected, and Chromium keeps
            // at most 16 per page: a closed editor would hold one until a major GC.
            this.canvas.width = this.canvas.height = 0;
            const ext = gl.getExtension("WEBGL_lose_context");
            if (ext) ext.loseContext();
        } catch (_) { /* context already gone */ }
        this.lost = true;
    }
}
