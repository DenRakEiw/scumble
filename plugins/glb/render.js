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
    return n;
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

    /** The colour pass with alpha, as a fresh canvas of w x h. */
    render(model, p, w, h) {
        const { scene, camera, group } = this.scene(model, p, w / h);
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
    depth(model, p, w, h) {
        const { scene, camera, group, box } = this.scene(model, { ...p, shadow: false }, w / h);
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
