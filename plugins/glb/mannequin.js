// The posable mannequin of the GLB layer plugin (CLAUDE.md item 67): a human figure about 1.75 m tall, built here from
// primitives (capsules, ellipsoids and boxes; no model file, nothing downloaded), on a small skeleton whose joints turn.
// It is placed, lit and rendered like a .glb object (render.js takes it as a model: `inner` normalised to one unit high,
// centred on the standing figure), and its pose is part of the object's parameters:
//
//   params.pose     the base pose it started from (a name of POSES)
//   params.joints   every joint's angles, { elbow_l: { bend: 90 }, ... } in degrees (the pelvis's `lower` in metres);
//                   a joint or an axis left out is 0
//
// The figure faces +Z (the camera at rotation 0), its left is +X, y is up. Each joint turns in its own frame, its Euler
// order ZXY (twist about the bone first, then forward / back, then out to the side). "_l" is the figure's left.
// The 18 keypoints of the OpenPose body layout come from the same skeleton (`keypoints`), for the bones layer.

import * as THREE from "./vendor/three.module.js";

export const HEIGHT = 1.75;
const MID = HEIGHT / 2;   // the standing figure's centre is the model's origin, so a pose change does not move it

// one axis of a joint: its key (what params.joints and MCP name it), its label, the three.js axis it turns about ("h":
// the pelvis's height, a move down in metres), the sign on the figure's left side or a centre joint (a right joint
// mirrors y and z), its range
const A = (key, label, axis, sign, min, max) => ({ key, label, axis, sign, min, max });

// a joint: id, label, parent, rest offset in metres in the parent's frame (a left joint's; the right one's x is negated)
const CENTRE = [
    { id: "pelvis", label: "Pelvis", parent: null, at: [0, 0.95 - MID, 0], axes: [A("lower", "Lower", "h", 1, 0, 0.9), A("bend", "Bend", "x", 1, -45, 90), A("turn", "Turn", "y", 1, -90, 90), A("lean", "Lean", "z", -1, -45, 45)] },
    { id: "spine", label: "Spine", parent: "pelvis", at: [0, 0.10, 0], axes: [A("bend", "Bend", "x", 1, -30, 70), A("twist", "Twist", "y", 1, -45, 45), A("side", "Side", "z", -1, -35, 35)] },
    { id: "chest", label: "Chest", parent: "spine", at: [0, 0.20, 0], axes: [A("bend", "Bend", "x", 1, -25, 45), A("twist", "Twist", "y", 1, -35, 35), A("side", "Side", "z", -1, -25, 25)] },
    { id: "neck", label: "Neck", parent: "chest", at: [0, 0.24, 0], axes: [A("nod", "Nod", "x", 1, -45, 50), A("turn", "Turn", "y", 1, -75, 75), A("tilt", "Tilt", "z", -1, -40, 40)] },
    { id: "head", label: "Head", parent: "neck", at: [0, 0.08, 0], axes: [A("nod", "Nod", "x", 1, -30, 30), A("turn", "Turn", "y", 1, -30, 30), A("tilt", "Tilt", "z", -1, -25, 25)] },
];
const SIDE = [
    { id: "shoulder", label: "Shoulder", parent: "chest", at: [0.19, 0.19, 0], axes: [A("forward", "Forward", "x", -1, -60, 180), A("out", "Out", "z", 1, -30, 180), A("twist", "Twist in", "y", -1, -90, 90)] },
    { id: "elbow", label: "Elbow", parent: "shoulder", at: [0, -0.30, 0], axes: [A("bend", "Bend", "x", -1, 0, 150)] },
    { id: "wrist", label: "Wrist", parent: "elbow", at: [0, -0.26, 0], axes: [A("bend", "Bend", "x", -1, -70, 70), A("side", "Side", "z", 1, -30, 30), A("twist", "Twist", "y", -1, -90, 90)] },
    { id: "hip", label: "Hip", parent: "pelvis", at: [0.09, -0.05, 0], axes: [A("forward", "Forward", "x", -1, -30, 125), A("out", "Out", "z", 1, -30, 70), A("twist", "Twist in", "y", -1, -45, 45)] },
    { id: "knee", label: "Knee", parent: "hip", at: [0, -0.42, 0], axes: [A("bend", "Bend", "x", 1, 0, 150)] },
    { id: "ankle", label: "Ankle", parent: "knee", at: [0, -0.40, 0], axes: [A("flex", "Toes up", "x", -1, -45, 45), A("roll", "Roll", "z", 1, -25, 25)] },
];

/** Every joint in parent-first order: { id, label, parent, at, axes, side: "l" | "r" | null }. */
export const JOINTS = [...CENTRE.map((j) => ({ ...j, side: null }))];
for (const j of SIDE) {
    for (const s of ["l", "r"]) {
        const parent = CENTRE.some((c) => c.id === j.parent) ? j.parent : `${j.parent}_${s}`;
        JOINTS.push({
            ...j, id: `${j.id}_${s}`, label: `${j.label} ${s === "l" ? "left" : "right"}`, parent, side: s,
            at: [s === "r" ? -j.at[0] : j.at[0], j.at[1], j.at[2]],
            axes: j.axes.map((a) => ({ ...a, sign: s === "r" && (a.axis === "y" || a.axis === "z") ? -a.sign : a.sign })),
        });
    }
}
const BY_ID = new Map(JOINTS.map((j) => [j.id, j]));

// the base poses: only what differs from 0 (both sides written out by `both`)
const both = (o) => { const out = {}; for (const [k, v] of Object.entries(o)) { out[`${k}_l`] = { ...v }; out[`${k}_r`] = { ...v }; } return out; };
export const POSES = {
    standing: { label: "Standing", joints: { ...both({ shoulder: { out: 8 }, elbow: { bend: 12 } }) } },
    walking: {
        label: "Walking",
        joints: {
            pelvis: { lower: 0.02 },
            hip_l: { forward: 24 }, knee_l: { bend: 8 }, ankle_l: { flex: 10 },
            hip_r: { forward: -16 }, knee_r: { bend: 28 }, ankle_r: { flex: -12 },
            shoulder_l: { forward: -18, out: 6 }, elbow_l: { bend: 18 },
            shoulder_r: { forward: 20, out: 6 }, elbow_r: { bend: 28 },
        },
    },
    running: {
        label: "Running",
        joints: {
            pelvis: { lower: 0.06 }, spine: { bend: 10 }, neck: { nod: -8 },
            hip_l: { forward: 62 }, knee_l: { bend: 75 }, ankle_l: { flex: 10 },
            hip_r: { forward: -24 }, knee_r: { bend: 95 }, ankle_r: { flex: -25 },
            shoulder_l: { forward: -40, out: 8 }, elbow_l: { bend: 95 },
            shoulder_r: { forward: 50, out: 8 }, elbow_r: { bend: 95 },
        },
    },
    sitting: {
        label: "Sitting",
        joints: {
            pelvis: { lower: 0.42 }, spine: { bend: 4 },
            ...both({ hip: { forward: 90, out: 6 }, knee: { bend: 90 }, shoulder: { forward: 28, out: 8 }, elbow: { bend: 55 } }),
        },
    },
    arms_crossed: {
        label: "Arms crossed",
        joints: {
            ...both({ hip: { out: 3 } }),
            shoulder_l: { forward: 28, out: 12, twist: 78 }, elbow_l: { bend: 112 },
            shoulder_r: { forward: 34, out: 12, twist: 72 }, elbow_r: { bend: 100 },
        },
    },
    hands_on_hips: {
        label: "Hands on hips",
        joints: { ...both({ hip: { out: 4 }, shoulder: { out: 42, forward: -8, twist: 88 }, elbow: { bend: 88 }, wrist: { side: 15 } }) },
    },
    t_pose: { label: "T-pose", joints: { ...both({ shoulder: { out: 90 } }) } },
};
export const POSE_NAMES = Object.keys(POSES);
/** A base pose's name (an own key of POSES: "constructor" or "__proto__" is none). */
export const isPose = (name) => typeof name === "string" && Object.hasOwn(POSES, name);

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** Joint angles cleaned: known joints and axes only, numbers clamped into their ranges, zeros left out. */
export function cleanJoints(j) {
    const out = {};
    if (!j || typeof j !== "object") return out;
    for (const def of JOINTS) {
        const src = j[def.id];
        if (!src || typeof src !== "object") continue;
        const o = {};
        for (const a of def.axes) {
            const v = +src[a.key];
            if (src[a.key] != null && finite(v)) { const c = Math.min(a.max, Math.max(a.min, v)); if (c !== 0) o[a.key] = Math.round(c * 1e4) / 1e4; }
        }
        if (Object.keys(o).length) out[def.id] = o;
    }
    return out;
}

/**
 * What params.joints may not hold, for a command to refuse by name: a joint or an axis that does not exist, a joint
 * that is not an object of axes, a value that is neither a number nor null (null puts the axis back to 0).
 */
export function unknownJoints(j) {
    const bad = [];
    if (!j || typeof j !== "object") return bad;
    for (const [id, axes] of Object.entries(j)) {
        const def = BY_ID.get(id);
        if (!def) { bad.push(id); continue; }
        if (!axes || typeof axes !== "object" || Array.isArray(axes)) { bad.push(`${id} (an object of axes, e.g. { ${def.axes[0].key}: 10 })`); continue; }
        for (const [k, v] of Object.entries(axes)) {
            if (!def.axes.some((a) => a.key === k)) bad.push(`${id}.${k}`);
            else if (v !== null && !finite(v)) bad.push(`${id}.${k} (a number)`);
        }
    }
    return bad;
}

/** A pose's joints, a fresh copy. */
export function poseJoints(name) {
    const p = isPose(name) ? POSES[name] : POSES.standing;
    return cleanJoints(JSON.parse(JSON.stringify(p.joints)));
}

/** `over` merged onto `base` joint by joint and axis by axis (an axis given as null goes back to 0). */
export function mergeJoints(base, over) {
    const out = JSON.parse(JSON.stringify(base || {}));
    if (over && typeof over === "object") {
        for (const [id, axes] of Object.entries(over)) {
            if (!BY_ID.has(id) || !axes || typeof axes !== "object") continue;
            out[id] = { ...(out[id] || {}) };
            for (const [k, v] of Object.entries(axes)) { if (v == null) delete out[id][k]; else out[id][k] = v; }
        }
    }
    return cleanJoints(out);
}

/** The joints and their axes as a plain list, for the dialog and for glb.info. */
export function jointInfo() {
    return JOINTS.map((j) => ({ id: j.id, label: j.label, axes: j.axes.map((a) => ({ key: a.key, label: a.label, min: a.min, max: a.max, unit: a.axis === "h" ? "m" : "deg" })) }));
}

// ---- the figure -------------------------------------------------------------------------------------------------------

/**
 * A new mannequin model: { inner, meshes, size, unit, mannequin: true, applyPose(params), keypoints() }. `inner` holds
 * the figure scaled to one unit high (1.75 m), its origin the standing figure's centre. applyPose sets the joints from
 * params.joints (params.pose's angles when there are none); keypoints gives the 18 OpenPose body points in world space
 * as the figure is now (the caller updates the world matrices first).
 */
export function buildMannequin() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xd8ccbb, roughness: 0.62, metalness: 0 });
    const joint = new THREE.MeshStandardMaterial({ color: 0xa99a87, roughness: 0.55, metalness: 0 });
    const inner = new THREE.Group();
    inner.name = "mannequin";
    inner.scale.setScalar(1 / HEIGHT);
    const groups = {};
    let meshes = 0;
    const add = (parent, geo, mat, pos, scale) => {
        const m = new THREE.Mesh(geo, mat);
        if (pos) m.position.set(...pos);
        if (scale) m.scale.set(...scale);
        m.castShadow = true; m.receiveShadow = false;
        parent.add(m);
        meshes++;
        return m;
    };
    const sphere = new THREE.SphereGeometry(1, 28, 20);
    const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 8, 20);
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const ball = (g, r) => add(g, sphere, joint, [0, 0, 0], [r, r, r]);
    for (const def of JOINTS) {
        const g = new THREE.Group();
        g.name = def.id;
        g.position.set(...def.at);
        g.rotation.order = "ZXY";
        (def.parent ? groups[def.parent] : inner).add(g);
        groups[def.id] = g;
    }
    const markers = {};
    const mark = (g, name, pos) => { const o = new THREE.Object3D(); o.position.set(...pos); g.add(o); markers[name] = o; };
    // the torso and the head
    add(groups.pelvis, sphere, skin, [0, -0.02, 0], [0.165, 0.10, 0.115]);
    add(groups.spine, capsule(0.115, 0.14), skin, [0, 0.10, 0], [1, 1, 0.78]);
    add(groups.chest, sphere, skin, [0, 0.11, 0], [0.175, 0.17, 0.115]);
    add(groups.neck, capsule(0.05, 0.06), skin, [0, 0.04, 0]);
    add(groups.head, sphere, skin, [0, 0.075, 0.012], [0.08, 0.105, 0.095]);
    add(groups.head, sphere, joint, [0, 0.055, 0.104], [0.016, 0.02, 0.016]);   // a nose, so the facing reads in the render
    mark(groups.head, "nose", [0, 0.06, 0.11]);
    for (const s of ["l", "r"]) {
        const x = s === "l" ? 1 : -1;
        mark(groups.head, `eye_${s}`, [0.032 * x, 0.088, 0.088]);
        mark(groups.head, `ear_${s}`, [0.08 * x, 0.075, 0.0]);
        const G = (id) => groups[`${id}_${s}`];
        ball(G("shoulder"), 0.05);
        add(G("shoulder"), capsule(0.043, 0.22), skin, [0, -0.15, 0]);
        ball(G("elbow"), 0.038);
        add(G("elbow"), capsule(0.036, 0.19), skin, [0, -0.13, 0]);
        ball(G("wrist"), 0.03);
        add(G("wrist"), box(0.03, 0.17, 0.085), skin, [0, -0.09, 0.004]);
        ball(G("hip"), 0.07);
        add(G("hip"), capsule(0.068, 0.28), skin, [0, -0.21, 0]);
        ball(G("knee"), 0.05);
        add(G("knee"), capsule(0.048, 0.29), skin, [0, -0.20, 0]);
        ball(G("ankle"), 0.04);
        add(G("ankle"), box(0.085, 0.065, 0.25), skin, [0, -0.045, 0.065]);
    }
    const rad = THREE.MathUtils.degToRad;
    function applyPose(p) {
        const j = p && p.joints && typeof p.joints === "object" ? cleanJoints(p.joints) : poseJoints(p && p.pose);
        for (const def of JOINTS) {
            const g = groups[def.id], v = j[def.id] || {};
            const r = { x: 0, y: 0, z: 0 };
            let drop = 0;
            for (const a of def.axes) {
                const val = v[a.key] || 0;
                if (a.axis === "h") drop = val; else r[a.axis] += val * a.sign;
            }
            g.position.set(def.at[0], def.at[1] - drop, def.at[2]);
            g.rotation.set(rad(r.x), rad(r.y), rad(r.z), "ZXY");
        }
        inner.updateMatrixWorld(true);
    }
    const world = (o) => o.getWorldPosition(new THREE.Vector3());
    /** The 18 OpenPose body points (nose, neck, right arm, left arm, right leg, left leg, eyes, ears) in world space. */
    function keypoints() {
        const sl = world(groups.shoulder_l), sr = world(groups.shoulder_r);
        return [
            world(markers.nose), sl.clone().add(sr).multiplyScalar(0.5),
            sr, world(groups.elbow_r), world(groups.wrist_r),
            sl, world(groups.elbow_l), world(groups.wrist_l),
            world(groups.hip_r), world(groups.knee_r), world(groups.ankle_r),
            world(groups.hip_l), world(groups.knee_l), world(groups.ankle_l),
            world(markers.eye_r), world(markers.eye_l), world(markers.ear_r), world(markers.ear_l),
        ];
    }
    applyPose({ pose: "standing" });
    const w = 0.5 / HEIGHT;
    return { inner, meshes, mannequin: true, size: { x: 0.5, y: HEIGHT, z: 0.3 }, unit: { x: w, y: 1, z: 0.3 / HEIGHT }, applyPose, keypoints, groups };
}

// ---- the OpenPose bones ---------------------------------------------------------------------------------------------
// The body layout's 17 limbs (pairs of the 18 points) and its 18 colours, as the ControlNet preprocessors draw them:
// limbs as ellipses in their colour at 60 %, then the points in full colour, on black.
export const LIMBS = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]];
export const COLOURS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]];

/** Draw the bones of 18 points ([x, y] in canvas pixels, or null for one not seen) into a 2D context. */
export function drawBones(ctx, pts, w, h) {
    const sw = Math.max(2, Math.round(4 * Math.min(w, h) / 512));
    LIMBS.forEach(([a, b], i) => {
        const p = pts[a], q = pts[b];
        if (!p || !q) return;
        const [r, g, bl] = COLOURS[i].map((c) => Math.floor(c * 0.6));
        const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        ctx.fillStyle = `rgb(${r},${g},${bl})`;
        ctx.beginPath();
        ctx.ellipse(mx, my, Math.max(len / 2, 0.5), sw, Math.atan2(q[1] - p[1], q[0] - p[0]), 0, Math.PI * 2);
        ctx.fill();
    });
    pts.forEach((p, i) => {
        if (!p) return;
        const [r, g, b] = COLOURS[i];
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.arc(p[0], p[1], sw, 0, Math.PI * 2);
        ctx.fill();
    });
}
