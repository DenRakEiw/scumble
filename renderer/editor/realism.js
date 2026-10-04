// The Realism Pass (item 37, docs/PLAN_0_1_42.md §3): DLSS 5 Neural Rendering on a picture through the community node
// pack ComfyUI-DLSS5-Enhancer on the user's own ComfyUI. App-only (not in tools/build_node.py FILES, like boxes.js).
// Pure functions, no DOM, no editor: tools/realism_test.js imports this file.
//
// The pass runs on the ComfyUI machine, so the server check reads the connected server's /system_stats (os, devices)
// and /object_info, never this machine. The pack's own refusal stays the final word: a card the check lets through can
// still fail with the pack's message, which hint() turns into a sentence. Every text here holds LABEL verbatim (the
// user: "du musst aber im rezept schreiben: Realism Pass (Windows only, RTX only)").

export const LABEL = "Realism Pass (Windows only, RTX only)";
export const RECIPE_ID = "realism_pass";
/** The pack's two nodes a pass needs (the third, DLSS5EnhanceVideoFile, is not used). */
export const NODES = ["DLSS5Settings", "DLSS5EnhanceImages"];

/** The pack's tables (dlss5/settings.py, nodes/settings_node.py at 796ed59). */
export const STYLES = ["Default", "Natural", "Cinematic"];
export const MODEL_PRESETS = ["Default", "J", "K", "L", "M"];
/** The output cap (long × short side) and the smallest render size a side may have. */
export const MAX_LONG = 7680;
export const MAX_SHORT = 4320;
export const MIN_SIDE = 64;
/**
 * The canvas node's multiple_of for a pass: DLSS needs even sides only, and a larger multiple shrinks a whole-picture
 * crop to the multiple below the picture's side, which leaves a border without the pass (6000 × 4000 at 64: 5952 × 3968).
 */
export const PASS_MULTIPLE = 2;

/** settings.realism: Style and Strength (R3's row), the model preset of the switch routes, the wait. */
export const realismDefaults = Object.freeze({ style: "Default", intensity: 1, preset: "L", timeout: 300 });

const TIMEOUT_MIN = 30;
const TIMEOUT_MAX = 3600;

/**
 * settings.realism filled per key from the defaults: settings.get() merges only the top level, so a stored object from
 * an older build (or one a later build adds a key to) replaces the whole default. A missing or bad key falls back.
 */
export function fillValues(stored) {
    const s = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    const d = realismDefaults;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
    const intensity = num(s.intensity);
    const timeout = num(s.timeout);
    return {
        style: STYLES.includes(s.style) ? s.style : d.style,
        intensity: intensity >= 0 && intensity <= 1 ? intensity : d.intensity,
        preset: MODEL_PRESETS.includes(s.preset) ? s.preset : d.preset,
        timeout: timeout >= TIMEOUT_MIN && timeout <= TIMEOUT_MAX ? timeout : d.timeout,
    };
}

/** The GPU generation the pack reads from a name (diagnostics.py: "RTX" in it, then /RTX\s+(\d{2})/), or 0. */
export function gpuGeneration(name) {
    const up = String(name || "").toUpperCase();
    if (!up.includes("RTX")) return 0;
    const m = /RTX\s+(\d{2})/.exec(up);
    return m ? +m[1] : 0;
}

const isWindows = (os) => os === "win32" || os === "nt";

/**
 * Whether the connected server can run the pass (§3.3; Q7 and Q8 as recommended).
 * `state` is the ComfyUI status's state ("connected", "missing-node", "connecting", "disconnected", "error"); `os` is
 * /system_stats system.os; `gpus` its device names; `objectInfo` the server's /object_info (null when not read).
 * Only positive evidence refuses: an os or a device list the server does not report is left to the pack.
 * -> { ok, show: "hidden" | "disabled" | "ready", reason, gpu, generation, experimental, note }
 */
export function serverSupport({ state, os, gpus, objectInfo } = {}) {
    const out = (ok, show, reason, extra = {}) => ({ ok, show, reason, gpu: "", generation: 0, experimental: false, note: "", ...extra });
    if (state !== "connected" && state !== "missing-node") {
        return out(false, "hidden", `${LABEL} needs your own ComfyUI: connect it under Settings › ComfyUI (Windows, an RTX 30, 40 or 50 card, the ComfyUI-DLSS5-Enhancer node pack).`);
    }
    if (os && !isWindows(os)) {
        return out(false, "hidden", `${LABEL} runs only on a ComfyUI on Windows; this one runs on ${os}.`);
    }
    // ComfyUI reports its torch devices ("cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync"), not nvidia-smi's lines,
    // which the pack reads: a card refuses only when ComfyUI runs on CUDA devices and none of them is an RTX 30 or later
    // by the pack's name rule; no CUDA device listed (CPU, DirectML) is left to the pack
    const cuda = (Array.isArray(gpus) ? gpus.map(String) : []).filter((g) => /^\s*cuda:\d+/i.test(g));
    const good = cuda.find((g) => gpuGeneration(g) >= 30);
    const generation = good ? gpuGeneration(good) : 0;
    const gpu = good ? cleanGpu(good) : "";
    if (cuda.length && !good) {
        const shown = cuda.map(cleanGpu).filter(Boolean).join(", ") || "no NVIDIA card";
        return out(false, "hidden", `${LABEL} needs an RTX 30, 40 or 50 card on your ComfyUI's machine; it shows ${shown}.`, { gpu: cleanGpu(cuda[0]), generation: gpuGeneration(cuda[0]) });
    }
    const experimental = generation === 30;
    const note = experimental ? `${LABEL}: RTX 30 cards need the pack's experimental runtime pair for Ampere (see the pack's README); without it the pass fails.` : "";
    if (objectInfo) {
        const missing = NODES.filter((n) => !objectInfo[n]);
        if (missing.length) {
            return out(false, "disabled", `${LABEL}: your ComfyUI lacks its nodes (${missing.join(", ")}): install the ComfyUI-DLSS5-Enhancer node pack there (Help › Manual › ${LABEL}).`, { gpu, generation, experimental, note });
        }
    }
    if ((objectInfo && !objectInfo.InpaintCanvas) || (!objectInfo && state === "missing-node")) {
        return out(false, "disabled", `${LABEL} also needs the Inpaint Canvas node pack on your ComfyUI.`, { gpu, generation, experimental, note });
    }
    if (!objectInfo) {
        return out(false, "disabled", `${LABEL}: Scumble could not read your ComfyUI's node list (/object_info); reconnect under Settings › ComfyUI.`, { gpu, generation, experimental, note });
    }
    return out(true, "ready", "", { gpu, generation, experimental, note });
}

/** A ComfyUI device name without its "cuda:0 " prefix and " : cudaMallocAsync" suffix. */
function cleanGpu(name) {
    return String(name || "").replace(/^\s*[a-z]+:\d+\s+/i, "").replace(/\s*:\s*[A-Za-z]+\s*$/, "").trim();
}

/** A side the pack's way (dlss5/settings.py _even: max(2, floor(v / 2 + 0.5) * 2)). */
export function even(v) {
    return Math.max(2, Math.floor(v / 2 + 0.5) * 2);
}

/**
 * The length the canvas node gives a crop span of `size` inside a picture side of `limit` at multiple `m`
 * (nodes.py _fit_span_to_multiple): up to the next multiple, or down to the largest that fits the side.
 */
export function fitSpan(size, limit, m = PASS_MULTIPLE) {
    size = Math.round(+size || 0); limit = Math.round(+limit || 0); m = Math.max(1, Math.round(+m || 1));
    let t = Math.ceil(size / m) * m;
    if (t > limit) {
        t = Math.floor(limit / m) * m;
        if (t <= 0) return size;
    }
    return t;
}

/** The output the pack makes from a w × h picture at `factor` (each side rounded to an even number). */
export function outputSize(w, h, factor = 1) {
    return { w: even(w * factor), h: even(h * factor) };
}

/**
 * "" when the pack takes a w × h picture at `factor`, else the refusal (§3.5): both sides at least 64 px, the output at
 * most 7680 on the long and 4320 on the short side.
 */
export function fits(w, h, factor = 1) {
    w = Math.round(+w || 0); h = Math.round(+h || 0);
    if (Math.min(w, h) < MIN_SIDE) return `${LABEL} needs at least ${MIN_SIDE} px a side; this is ${w} × ${h}.`;
    const o = outputSize(w, h, factor);
    if (Math.max(o.w, o.h) > MAX_LONG || Math.min(o.w, o.h) > MAX_SHORT) {
        // at 1x the user's own size; an upscale names the output it would make
        const shown = factor === 1 ? `${w} × ${h}` : `${o.w} × ${o.h}`;
        return `${LABEL} takes at most ${MAX_LONG} × ${MAX_SHORT} (long × short side); this is ${shown}.`;
    }
    return "";
}

/**
 * The DLSS5Settings inputs of a run: the recipe node's inputs with Style and Strength from `values` and, when `values`
 * names one, the model preset (the switch routes; the recipe route keeps its Settings row's). A bad value throws.
 */
export function passSettings(inputs, values = {}) {
    const next = { ...(inputs || {}) };
    if (values.style !== undefined) {
        if (!STYLES.includes(values.style)) throw new Error(`${LABEL}: unknown style "${values.style}" (${STYLES.join(", ")}).`);
        next.nr_style = values.style;
    }
    if (values.intensity !== undefined) {
        const v = +values.intensity;
        if (!Number.isFinite(v)) throw new Error(`${LABEL}: the strength must be a number from 0 to 1.`);
        next.nr_intensity = Math.min(1, Math.max(0, v));
    }
    if (values.preset !== undefined) {
        if (!MODEL_PRESETS.includes(values.preset)) throw new Error(`${LABEL}: unknown DLSS model preset "${values.preset}" (${MODEL_PRESETS.join(", ")}).`);
        next.dlss_model_preset = values.preset;
    }
    return next;
}

/** The pack refused the asked model preset (session.py: "The worker applied DLSS model preset ..."). */
export function isPresetRefusal(message) {
    return /applied DLSS model preset/.test(String(message || ""));
}

const firstLine = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";

/** The sentence a user reads for a failure inside the pack (§3.4); `message` is the execution_error's text. */
export function hint(message) {
    const m = String(message || "");
    const manual = `(Help › Manual › ${LABEL})`;
    if (/No DLSS 5 runtime was found/.test(m)) {
        return `${LABEL}: the DLSS 5 runtime is not installed on your ComfyUI. Install it there with the pack's install_runtime.py ${manual}.`;
    }
    if (/is incomplete\. Missing/.test(m)) {
        // the missing paths, one a line, up to the blank line before the pack's install hint
        const block = (m.split(/Missing:/)[1] || "").split(/\r?\n\s*\r?\n/)[0];
        const names = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^.*[\\/]/, ""));
        return `${LABEL}: the DLSS 5 runtime on your ComfyUI is incomplete (missing: ${names.join(", ") || "some files"}). Install it again ${manual}.`;
    }
    if (/nvidia-smi is unavailable/.test(m)) {
        return `${LABEL}: your ComfyUI's machine shows no NVIDIA driver. It needs Windows, an RTX 30, 40 or 50 card and a current driver.`;
    }
    if (/needs the tested experimental Ampere pair/.test(m)) {
        return `${LABEL}: on an RTX 30 card the pack needs its experimental Ampere runtime pair, and the installed runtime is not that pair (the pack's README).`;
    }
    let g = /^(.*?) is outside the supported RTX 30\/40\/50 scope/m.exec(m);
    if (g || /No supported NVIDIA RTX GPU/.test(m)) {
        return `${LABEL}: ${g ? `${g[1].trim()} is not supported` : "your ComfyUI's machine shows no supported card"}; it needs an RTX 30, 40 or 50 card.`;
    }
    if (/could not be started/.test(m) && /DLSS worker|antivirus/i.test(m)) {
        return `${LABEL}: Windows Defender (or another antivirus) blocked the DLSS worker on your ComfyUI's machine. The pack's README says to add its runtime folder to the exclusions there ${manual}.`;
    }
    if (/version-4 (protocol|setup response)/.test(m)) {
        return `${LABEL}: the installed runtime is not the version the pack expects (v3.0). Install it again with the address in the manual ${manual}.`;
    }
    g = /is unavailable for (\d+)x(\d+)/.exec(m);
    if (g) {
        return `${LABEL}: DLSS refused this size (${g[1]} × ${g[2]}). Try a smaller area, or update the NVIDIA driver.`;
    }
    // "The worker applied DLSS model preset Default (0) instead of the requested M."
    g = /applied DLSS model preset (.+?) instead of the requested (\S+?)\./.exec(m);
    if (g) {
        return `${LABEL}: the runtime on your ComfyUI does not support DLSS model preset ${g[2]}. Pick Default under DLSS model preset and Generate again.`;
    }
    if (/crashed inside feature-18/.test(m)) {
        // the pack's own advice for an access violation: a driver or a runtime pair that does not match
        const ampere = /RTX 30 is the experimental path/.test(m) ? " On an RTX 30 card the experimental runtime pair must match exactly and may still be unstable." : "";
        return `${LABEL}: the DLSS worker crashed on your ComfyUI's machine. Update the NVIDIA driver and install the DLSS 5 runtime again ${manual}.${ampere}`;
    }
    if (/feature-18 execution was not|Feature-18 evaluation failed/.test(m)) {
        return `${LABEL}: DLSS 5 did not run its neural rendering on your ComfyUI. Another program may hold the GPU (a game, a video encoder): close it and try again.`;
    }
    if (/exceeds the supported/.test(m)) {
        return `${LABEL}: the picture is larger than ${MAX_LONG} × ${MAX_SHORT}.`;
    }
    g = /unusable render size (\d+)x(\d+)/.exec(m);
    if (g) {
        return `${LABEL} needs at least ${MIN_SIDE} px a side; this is ${g[1]} × ${g[2]}.`;
    }
    if (/OpenCV is required/.test(m)) {
        return `${LABEL}: the pack's Python packages are missing on your ComfyUI: install its requirements there ${manual}.`;
    }
    return `${LABEL} failed on your ComfyUI: ${firstLine(m).replace(/[.:;\s]+$/, "") || "no message"}.`;
}

/** Whether an execution_error comes from the pack's nodes. */
export function isPassNode(nodeType) {
    return NODES.includes(String(nodeType || ""));
}

// ---- the pass on a picture (R2a: host.passPicture, which R2b and R4 call) ----------------------------------------

/** The pass on a picture always runs at 1x: the answer is cropped back to the picture's own size. */
export const PASS_MODE = "1x (DLAA / native)";
/** recipes/realism_pass.json's DLSS5Settings inputs: a prompt of the pass when no recipe holds that node. */
export const SETTINGS_DEFAULTS = Object.freeze({
    upscaling_mode: PASS_MODE, nr_preset: "Default", nr_style: "Default", nr_intensity: 1.0,
    local_tone_strength: 1.0, local_structure_strength: 1.5, skin_structure_strength: 2.0,
    automatic_mask: true, dlss_model_preset: "L", motion: "auto", scene_change_threshold: 0.24,
    warmup_frames: 0, runtime_dir: "",
});
/** The node of passPrompt whose picture is the answer. */
export const PASS_OUTPUT = "rp_out";

/** The even size a w × h picture is padded to before the pass (the pack would add a black column or resample). */
export function evenPlan(w, h) {
    w = Math.max(1, Math.round(+w || 0)); h = Math.max(1, Math.round(+h || 0));
    return { w2: w + (w & 1), h2: h + (h & 1) };
}

/**
 * The prompt of a pass on one uploaded picture (`ref`: { filename, subfolder, type }): four nodes, every input
 * explicit. The DLSS5Settings inputs are the recipe's (a user copy's) with Style, Strength and the model preset from
 * `values` (settings.realism), always at 1x; an input a user's copy wired to another node goes back to the default.
 * PreviewImage writes a temp file, so nothing is left in the user's output folder.
 */
export function passPrompt(recipe, values, ref) {
    const node = recipe && recipe.prompt ? Object.values(recipe.prompt).find((n) => n && n.class_type === "DLSS5Settings") : null;
    const inputs = { ...SETTINGS_DEFAULTS };
    for (const [k, v] of Object.entries((node && node.inputs) || {})) if (!Array.isArray(v)) inputs[k] = v;
    inputs.upscaling_mode = PASS_MODE;
    const v = values || {};
    return {
        rp_in: { class_type: "InpaintCanvasLoadRef", inputs: { ref: JSON.stringify({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" }) } },
        rp_settings: { class_type: "DLSS5Settings", inputs: passSettings(inputs, { style: v.style, intensity: v.intensity, preset: v.preset }) },
        rp_enhance: { class_type: "DLSS5EnhanceImages", inputs: { images: ["rp_in", 0], settings: ["rp_settings", 0], verify_neural_rendering: true } },
        [PASS_OUTPUT]: { class_type: "PreviewImage", inputs: { images: ["rp_enhance", 0] } },
    };
}

/** Whether any pixel of RGBA bytes is less than opaque. */
export function hasAlpha(data) {
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
    return false;
}

/** The grey a transparent picture is flattened onto, so colours hidden under transparent pixels do not bleed. */
export const FLATTEN_GREY = 128;

/**
 * The bytes that go to the pass: the w × h RGBA picture padded to evenPlan's size by repeating its last column and row,
 * opaque; with `flatten` its colours composited over mid-grey first (the alpha is put back afterwards, putAlphaBack).
 * -> { data: Uint8ClampedArray, w2, h2 }
 */
export function prepPixels(data, w, h, flatten) {
    const { w2, h2 } = evenPlan(w, h);
    const out = new Uint8ClampedArray(w2 * h2 * 4);
    for (let y = 0; y < h2; y++) {
        const sy = Math.min(y, h - 1);
        for (let x = 0; x < w2; x++) {
            const s = (sy * w + Math.min(x, w - 1)) * 4, d = (y * w2 + x) * 4;
            if (flatten) {
                const a = data[s + 3] / 255, g = FLATTEN_GREY * (1 - a);
                out[d] = data[s] * a + g; out[d + 1] = data[s + 1] * a + g; out[d + 2] = data[s + 2] * a + g;
            } else {
                out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2];
            }
            out[d + 3] = 255;
        }
    }
    return { data: out, w2, h2 };
}

/**
 * The answer (`answer`, aw × ah RGBA, at least w × h) cropped back to w × h at 0, 0, with the source's alpha
 * (`source`, w × h RGBA) written back and prepPixels' flatten undone: a pixel of alpha a went as c·a + grey·(1 − a), so
 * its colour comes back as (p − grey·(1 − a)) / a. A pixel the pass left alone gets its own colour back, and over the
 * grey the layer shows exactly what the pass made; without the undo the alpha would weigh the colour twice (a grey
 * fringe on every soft edge). Fully transparent and opaque pixels keep the answer's colour.
 * -> Uint8ClampedArray of w × h × 4
 */
export function putAlphaBack(answer, aw, ah, source, w, h) {
    if (aw < w || ah < h) throw new Error(`${LABEL}: your ComfyUI answered ${aw} × ${ah} for a picture of ${w} × ${h}.`);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const a = (y * aw + x) * 4, d = (y * w + x) * 4, alpha = source[d + 3];
            if (alpha === 0 || alpha === 255) {
                out[d] = answer[a]; out[d + 1] = answer[a + 1]; out[d + 2] = answer[a + 2];
            } else {
                const k = alpha / 255, g = FLATTEN_GREY * (1 - k);
                out[d] = (answer[a] - g) / k; out[d + 1] = (answer[a + 1] - g) / k; out[d + 2] = (answer[a + 2] - g) / k;
            }
            out[d + 3] = alpha;
        }
    }
    return out;
}

/**
 * The sentence a failed picture run ends with (host.comfyPictureRun's error: `kind` "error" carries the server's
 * message, the other kinds a text of their own that already names the pass).
 */
export function runFailure(err) {
    const msg = String((err && err.message) || err || "");
    // the runner's own texts (a cancel, the timeout, an answer it could not fetch) already name the pass; the pack's
    // and the server's messages never start with Scumble's label
    if (msg.startsWith(LABEL)) return msg;
    return hint(msg);
}

/** What the user reads when the runtime refused the asked model preset and settings.realism took Default. */
export function presetFallbackNote(asked) {
    return `${LABEL}: the runtime on your ComfyUI refused DLSS model preset ${asked}, so the pass uses Default from now on (the Realism Pass recipe keeps its own DLSS model preset row).`;
}

/** Whether a ComfyUI version ("0.38.0", "v0.3.57") is at least `min`; an unknown one is not. */
export function versionAtLeast(version, min) {
    const parts = (v) => (/^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || "").trim()) || []).slice(1).map((n) => +(n || 0));
    const a = parts(version), b = parts(min);
    if (a.length < 3 || b.length < 3) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
}
