// The 3D side of the GLB layer plugin: one three.js renderer for the plugin, a model
// normalised to a unit box, and the two passes (colour with alpha, depth with near = white)
// at whatever size the caller asks for. Nothing here touches the document.
//
// The camera sits at the origin looking down -Z; an object is placed by the point of the
// picture its centre projects to (x, y as fractions of the frame), its distance (depth), its
// rotation and scale. That is what makes "placed in the picture" honest: a photo has no known
// camera, the user matches the perspective by eye with the focal length slider.

import * as THREE from "./vendor/three.module.js";
import { GLTFLoader } from "./vendor/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "./vendor/jsm/environments/RoomEnvironment.js";

export const DEFAULTS = {
    x: 0.5, y: 0.55, depth: 3, rotX: 0, rotY: 30, rotZ: 0, scale: 1, fov: 40,
    lightAz: -35, lightEl: 45, lightInt: 1.5, ambient: 0.6, shadow: true, depthLayer: false,
};

/** Clamp every parameter into its range; unknown keys are dropped. */
export function normalise(p) {
    const n = { ...DEFAULTS };
    const num = (k, lo, hi) => { const v = +p[k]; if (Number.isFinite(v)) n[k] = Math.min(hi, Math.max(lo, v)); };
    if (p.position && typeof p.position === "object") { p = { ...p, x: p.position.x, y: p.position.y }; }
    if (p.rotation && typeof p.rotation === "object") { p = { ...p, rotX: p.rotation.x, rotY: p.rotation.y, rotZ: p.rotation.z }; }
    if (p.light && typeof p.light === "object") { p = { ...p, lightAz: p.light.azimuth, lightEl: p.light.elevation, lightInt: p.light.intensity, ambient: p.light.ambient }; }
    num("x", -0.5, 1.5); num("y", -0.5, 1.5); num("depth", 0.3, 50);
    num("rotX", -360, 360); num("rotY", -360, 360); num("rotZ", -360, 360);
    num("scale", 0.02, 20); num("fov", 5, 140);
    num("lightAz", -180, 180); num("lightEl", -10, 90); num("lightInt", 0, 10); num("ambient", 0, 4);
    if (p.shadow != null) n.shadow = !!p.shadow;
    if (p.depthLayer != null) n.depthLayer = !!p.depthLayer;
    if (p.depth_layer != null) n.depthLayer = !!p.depth_layer;
    // the frame the object is rendered in and where it lies in the picture now (PLAN_0_1_31 §7, `frameOf`). An object
    // of 0.1.31 has an `orient` instead (the whole picture turned or mirrored since it was placed: `turn` quarter turns
    // clockwise after an optional horizontal mirror), turned into a frame at the next placement or geometry event
    const frame = cleanFrame(p.frame);
    if (frame) n.frame = frame;
    else if (p.orient && typeof p.orient === "object" && (((p.orient.turn | 0) & 3) || p.orient.flip)) n.orient = { turn: (p.orient.turn | 0) & 3, flip: !!p.orient.flip };
    return n;
}

/** The size of the upright frame of a w x h picture in orientation `o`. */
export function uprightSize(o, w, h) { return o && (o.turn & 1) ? [h, w] : [w, h]; }

/** The canvas transform that draws a w x h upright picture in orientation `o` (the mirror, then the quarter turns). */
export function orientMatrix(o, w, h) {
    let m = [1, 0, 0, 1, 0, 0], W = w, H = h;
    const ops = [];
    if (o && o.flip) ops.push("h");
    for (let i = 0; i < (((o && o.turn) | 0) & 3); i++) ops.push(1);
    for (const op of ops) {
        m = mulMatrix(op === "h" ? [-1, 0, 0, 1, W, 0] : [0, 1, -1, 0, H, 0], m);
        if (op === 1) [W, H] = [H, W];
    }
    return m;
}

// ---- the object's frame (PLAN_0_1_31 §7, 23b) -------------------------------------------------------------------------
// An object is rendered in its upright frame: `frame.w` x `frame.h` units, the camera's picture, `x` / `y` fractions of
// it. `frame.m` is the canvas matrix [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f) from the frame's units
// to the document's pixels as they are now. A new object's frame is the picture (the identity); every whole-picture
// change (the plugin "geometry" event: a turn, crop, extend, resize or straighten) puts its matrix in front of it, so
// Edit 3D object renders the object where it is, as big and as turned as it is.

/** a * b of two canvas matrices: b first, then a. */
export function mulMatrix(a, b) {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

/** The old-to-new matrix of a quarter turn or mirror `op` of a W x H picture (1 clockwise, -1, 2, "h", "v"), or null. */
export function turnMatrix(op, W, H) {
    if (op === 1) return [0, 1, -1, 0, H, 0];
    if (op === -1) return [0, -1, 1, 0, 0, W];
    if (op === 2) return [-1, 0, 0, -1, W, H];
    if (op === "h") return [-1, 0, 0, 1, W, 0];
    if (op === "v") return [1, 0, 0, -1, 0, H];
    return null;
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** An invertible matrix of six finite numbers (a copy), or null. */
export function cleanMatrix(m) {
    if (!Array.isArray(m) || m.length !== 6 || !m.every(finite)) return null;
    return Math.abs(m[0] * m[3] - m[1] * m[2]) > 1e-12 ? m.slice() : null;
}

/** The matrix of a "geometry" event: its `m`, or for an editor that only sends 23a's `op`, the turn's; null otherwise. */
export function eventMatrix(ev) {
    const m = cleanMatrix(ev && ev.m);
    if (m) return m;
    if (!ev || !ev.from || (ev.kind != null && ev.kind !== "turn")) return null;
    return finite(ev.from.width) && finite(ev.from.height) ? turnMatrix(ev.op, ev.from.width, ev.from.height) : null;
}

/** A valid frame (a copy): two positive finite sizes and an invertible matrix; null otherwise. */
export function cleanFrame(f) {
    if (!f || typeof f !== "object") return null;
    const m = cleanMatrix(f.m);
    return m && finite(f.w) && f.w > 0 && finite(f.h) && f.h > 0 ? { w: f.w, h: f.h, m } : null;
}

/**
 * The frame of an object's parameters in a W x H picture: its own, or for one placed before frames existed the upright
 * frame of the picture in the object's 0.1.31 orientation (nothing: the picture itself).
 */
export function frameOf(p, W, H) {
    const own = cleanFrame(p && p.frame);
    if (own) return own;
    const o = p && p.orient;
    const [uw, uh] = uprightSize(o, W, H);
    return { w: uw, h: uh, m: orientMatrix(o, uw, uh) };
}

/**
 * How a render of `frame` lands in the document. The render runs at the document's density along each of the frame's
 * axes (after a resize to half it has half the pixels, it is not rendered at the old size and scaled), capped by `fitFn` (a
 * renderer's `fit`, or the dialog's preview scale): `fit` { w, h, k }, a render pixel is 1 / k document pixels, the
 * camera's aspect is the frame's (`aspect`: a non-uniform resize stretches the render like it stretched the picture).
 *   exact   the frame's axes lie on the document's (turns, mirrors, crops, extends, resizes): the render's pixels are
 *           moved by a signed permutation, not resampled, and placed from the frame's box in the document (23a's
 *           numbers for a quarter turn); otherwise (a straighten) it is drawn through the matrix with smoothing
 *   out     the size of the render drawn at density k, `origin` the document point at its corner
 *   toDoc   the matrix from render pixels to document pixels
 */
export function framePlan(frame, fitFn) {
    const [a, b, c, d, e, f] = frame.m;
    const ax = Math.hypot(a, b), ay = Math.hypot(c, d);
    const fit = fitFn(frame.w * ax, frame.h * ay);
    const k = fit.k;
    const R = [a / ax, b / ax, c / ay, d / ay];
    const exact = R.every((v) => Math.abs(v) < 1e-6 || Math.abs(Math.abs(v) - 1) < 1e-6);
    let lin, T, origin;
    if (exact) {
        lin = R.map((v) => Math.round(v) || 0);
        // the render's corners through the permutation, and the frame's corners in the document
        const xs = [0, lin[0] * fit.w, lin[2] * fit.h, lin[0] * fit.w + lin[2] * fit.h], ys = [0, lin[1] * fit.w, lin[3] * fit.h, lin[1] * fit.w + lin[3] * fit.h];
        T = [...lin, -Math.min(...xs), -Math.min(...ys)];
        const fx = [e, a * frame.w + e, c * frame.h + e, a * frame.w + c * frame.h + e], fy = [f, b * frame.w + f, d * frame.h + f, b * frame.w + d * frame.h + f];
        origin = [Math.min(...fx), Math.min(...fy)];
    } else {
        // the render's own scale (frame units per render pixel) on each axis, times k: render pixels to output pixels
        const sx = frame.w / fit.w * k, sy = frame.h / fit.h * k;
        lin = [a * sx, b * sx, c * sy, d * sy];
        const xs = [0, lin[0] * fit.w, lin[2] * fit.h, lin[0] * fit.w + lin[2] * fit.h].map((v) => v + e * k);
        const ys = [0, lin[1] * fit.w, lin[3] * fit.h, lin[1] * fit.w + lin[3] * fit.h].map((v) => v + f * k);
        const ox = Math.floor(Math.min(...xs) + 1e-6), oy = Math.floor(Math.min(...ys) + 1e-6);
        T = [...lin, e * k - ox, f * k - oy];
        origin = [ox / k, oy / k];
    }
    const out = [
        Math.max(1, Math.ceil(Math.max(T[4], T[4] + T[0] * fit.w, T[4] + T[2] * fit.h, T[4] + T[0] * fit.w + T[2] * fit.h) - 1e-6)),
        Math.max(1, Math.ceil(Math.max(T[5], T[5] + T[1] * fit.w, T[5] + T[3] * fit.h, T[5] + T[1] * fit.w + T[3] * fit.h) - 1e-6)),
    ];
    const toDoc = [T[0] / k, T[1] / k, T[2] / k, T[3] / k, origin[0] + T[4] / k, origin[1] + T[5] / k];
    return { fit, k, aspect: frame.w / frame.h, exact, T, out, origin, toDoc };
}

/**
 * Draw a render through `plan` into `ctx`: the document point (x0, y0) at the canvas's corner, `s` canvas pixels per
 * document pixel. At the plan's own density an exact plan moves whole pixels (smoothing off, whole-pixel offsets).
 */
export function drawRender(ctx, src, plan, s = plan.k, x0 = 0, y0 = 0) {
    const whole = plan.exact && s === plan.k;
    const D = plan.toDoc;
    const M = whole
        ? [plan.T[0], plan.T[1], plan.T[2], plan.T[3], Math.round(s * (plan.origin[0] - x0)) + plan.T[4], Math.round(s * (plan.origin[1] - y0)) + plan.T[5]]
        : [D[0] * s, D[1] * s, D[2] * s, D[3] * s, (D[4] - x0) * s, (D[5] - y0) * s];
    ctx.save();
    ctx.imageSmoothingEnabled = !whole;
    if (!whole) ctx.imageSmoothingQuality = "high";
    ctx.setTransform(...M);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
}

/** A render drawn at the plan's density into a canvas of `plan.out` (the render itself when nothing moves). */
export function planCanvas(src, plan, make) {
    const T = plan.T;
    if (plan.exact && T[0] === 1 && T[1] === 0 && T[2] === 0 && T[3] === 1 && T[4] === 0 && T[5] === 0) return src;
    const out = make(plan.out[0], plan.out[1]);
    drawRender(out.getContext("2d"), src, plan, plan.k, plan.origin[0], plan.origin[1]);
    return out;
}

export class GlbRenderer {
    constructor() {
        this.canvas = document.createElement("canvas");
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
        this.renderer.setPixelRatio(1);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1;
        this.env = null;
        this.loader = new GLTFLoader();
        const gl = this.renderer.getContext();
        this.maxSide = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 8192);
    }

    environment() {
        if (!this.env) {
            const pmrem = new THREE.PMREMGenerator(this.renderer);
            this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
            pmrem.dispose();
        }
        return this.env;
    }

    /** Parse a .glb / .gltf (an ArrayBuffer or a JSON string) into a model normalised to a unit box centred at the origin. */
    load(data) {
        return new Promise((resolve, reject) => {
            const onLoad = (gltf) => {
                try {
                    const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
                    if (!root) throw new Error("the file holds no scene");
                    root.updateMatrixWorld(true);
                    const box = new THREE.Box3().setFromObject(root);
                    if (box.isEmpty()) throw new Error("the scene has no geometry");
                    const size = new THREE.Vector3(), centre = new THREE.Vector3();
                    box.getSize(size); box.getCenter(centre);
                    const k = 1 / Math.max(size.x, size.y, size.z, 1e-6);
                    const inner = new THREE.Group();
                    inner.add(root);
                    root.position.sub(centre);
                    inner.scale.setScalar(k);
                    let meshes = 0;
                    root.traverse((o) => { if (o.isMesh) { meshes++; o.castShadow = true; o.receiveShadow = false; } });
                    resolve({ inner, meshes, size: { x: size.x, y: size.y, z: size.z }, unit: { x: size.x * k, y: size.y * k, z: size.z * k } });
                } catch (err) { reject(err); }
            };
            const onError = (err) => reject(new Error(String((err && err.message) || err || "could not read the model") + (/draco|ktx2|basis/i.test(String(err && err.message)) ? " (Draco / KTX2 compressed files are not supported in this version)" : "")));
            try { this.loader.parse(data, "", onLoad, onError); } catch (err) { onError(err); }
        });
    }

    /** The scene for one render: camera at the origin, the object placed by the parameters, light, optional ground shadow. */
    scene(model, p, aspect) {
        const scene = new THREE.Scene();
        scene.environment = this.environment();
        scene.environmentIntensity = p.ambient;
        const camera = new THREE.PerspectiveCamera(p.fov, aspect, 0.05, 200);
        camera.position.set(0, 0, 0);
        camera.lookAt(0, 0, -1);
        const half = Math.tan(THREE.MathUtils.degToRad(p.fov) / 2);
        const wx = (2 * p.x - 1) * half * aspect * p.depth, wy = (1 - 2 * p.y) * half * p.depth, wz = -p.depth;
        const group = new THREE.Group();
        group.add(model.inner);
        group.position.set(wx, wy, wz);
        group.rotation.set(THREE.MathUtils.degToRad(p.rotX), THREE.MathUtils.degToRad(p.rotY), THREE.MathUtils.degToRad(p.rotZ), "YXZ");
        group.scale.setScalar(p.scale);
        scene.add(group);
        group.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(group);
        const radius = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) / 2 || 0.5;
        const az = THREE.MathUtils.degToRad(p.lightAz), el = THREE.MathUtils.degToRad(p.lightEl);
        const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
        const light = new THREE.DirectionalLight(0xffffff, p.lightInt);
        light.position.copy(group.position).addScaledVector(dir, radius * 6);
        light.target.position.copy(group.position);
        light.castShadow = !!p.shadow;
        light.shadow.mapSize.set(2048, 2048);
        const sc = light.shadow.camera;
        sc.left = -radius * 2; sc.right = radius * 2; sc.top = radius * 2; sc.bottom = -radius * 2;
        sc.near = radius; sc.far = radius * 12;
        light.shadow.bias = -0.0005;
        light.shadow.radius = 4;
        scene.add(light); scene.add(light.target);
        if (p.shadow) {
            const ground = new THREE.Mesh(new THREE.PlaneGeometry(radius * 12, radius * 12), new THREE.ShadowMaterial({ opacity: 0.4 }));
            ground.rotation.x = -Math.PI / 2;
            ground.position.set(group.position.x, box.min.y - 0.001, group.position.z);
            ground.receiveShadow = true;
            scene.add(ground);
        }
        return { scene, camera, group, box, light };
    }

    /** The size the passes run at: the wanted size, capped by the GPU's texture limit and a 12 MP budget. */
    fit(w, h) {
        let k = Math.min(1, this.maxSide / Math.max(w, h), Math.sqrt(12e6 / (w * h)));
        return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), k };
    }

    /** The colour pass with alpha, as a fresh canvas of w x h; `aspect` the camera's (the frame's) when it differs from w / h. */
    render(model, p, w, h, aspect = w / h) {
        const { scene, camera, group } = this.scene(model, p, aspect);
        this.renderer.setSize(w, h, false);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.render(scene, camera);
        const out = document.createElement("canvas");
        out.width = w; out.height = h;
        out.getContext("2d").drawImage(this.canvas, 0, 0);
        group.remove(model.inner);
        return out;
    }

    /** The depth pass: the object's pixels white near, black far (the near / far planes hug the object), transparent elsewhere. */
    depth(model, p, w, h, aspect = w / h) {
        const { scene, camera, group, box } = this.scene(model, { ...p, shadow: false }, aspect);
        const near = Math.max(0.05, -box.max.z), far = Math.max(near + 0.01, -box.min.z);
        camera.near = near; camera.far = far;
        camera.updateProjectionMatrix();
        scene.overrideMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });
        scene.environment = null;
        this.renderer.setSize(w, h, false);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.render(scene, camera);
        const out = document.createElement("canvas");
        out.width = w; out.height = h;
        out.getContext("2d").drawImage(this.canvas, 0, 0);
        scene.overrideMaterial.dispose();
        group.remove(model.inner);
        return out;
    }

    dispose() {
        if (this.env) { this.env.dispose(); this.env = null; }
        this.renderer.dispose();
        try { this.renderer.forceContextLoss(); } catch (_) { /* ignore */ }
    }
}

/** The box of the non-transparent pixels, or null when the canvas is empty. */
export function alphaBounds(canvas) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext("2d").getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w * 4;
        for (let x = 0; x < w; x++) {
            if (d[row + x * 4 + 3] > 2) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The canvas cut to a box. */
export function crop(canvas, b) {
    const out = document.createElement("canvas");
    out.width = b.w; out.height = b.h;
    out.getContext("2d").drawImage(canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    return out;
}
