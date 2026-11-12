// @ts-check
// relightWhole: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import * as realism from "./realism.js";
import { bytesToImage, canvasBytes } from "./stitch.js";
import { glToCanvas } from "./inpaint_filters_gl.js";
import { applyFilter } from "./inpaint_filters.js";
import { detailRatio, lightsToWords, loraPercent } from "./inpaint_relight.js";
import { failKind, refusal } from "./inpaint_status.js";
import { INTERACTIVE } from "./inpaint_pool.js";
import { editorPool } from "./inpaint_jobs.js";
import { RUN_GOING, objectId, providerEdit, runIdOf } from "./host_util.js";

export const HostRelightPart = {
    /** A provider route's relight request, sent (`providerEdit`); a member so the relight gate can stand in for it. */
    relightSend(request, token) {
        return providerEdit(request, token);
    },

    /**
     * Whole-picture relight pass: sends the composite picture and the light map to a generative route (Magnific),
     * applies the detail ratio from the original picture, lands as a pixel layer named "Relight (<route>)" under
     * the top run of filter layers, and hides the relight filter layer in one undo step.
     */
    async relightWhole(editor, layer, { route = "magnific", deadline = 0, prompt = "" } = {}) {
        if (!editor.base) throw refusal("Load an image first.");
        if (!layer || layer.kind !== "filter" || layer.filter !== "relight") throw new Error("A relight layer is required.");
        const hasDepth = !!(editor.maps && editor.maps.depth && (editor.maps.depth.data || editor.maps.depth.u16));
        if (!hasDepth && editor.ensureDepthMap) {
            await editor.ensureDepthMap();
        }
        if (editor.providerPending) throw refusal(RUN_GOING);

        const L = `Relight (${route})`;
        const say = (text, kind) => { editor.setStatus(text, kind); return refusal(text, editor.statusKind || "info"); };
        const token = { provider: route, label: L, started: Date.now(), editor, runId: runIdOf() };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this.notifyProviderRuns();

        let closed = false;
        const offRemoved = this.on("removed", (e) => { if (e && e.editor === editor) { closed = true; token.cancelled = true; } });
        const gone = () => closed || !this._editors.includes(editor);
        const isFill = (l) => editor.isFillLayer(l);
        const skip = (l) => editor.isReference(l) || editor.isControl(l) || (l.kind !== "filter" && !l.visible) || (l.relightOf && l.relightOf === layer.id);
        const pv = (p) => (p ? `${objectId(p)}.${p.version || 0}` : "-");
        const readSig = (upTo) => {
            const parts = [editor.width, editor.height, editor.pixelVersion || 0, pv(editor.basePx), editor.compareShow || ""];
            for (const l of editor.layers.slice(0, upTo)) {
                // by id: an undo or redo of a layers step during the run rebuilds every layer object
                if (editor.isReference(l) || editor.isControl(l) || l.id === layer.id || (l.relightOf && l.relightOf === layer.id)) continue;
                parts.push(l.id, editor.shown(l) ? 1 : 0, l.opacity, l.blend || "", l.clip ? 1 : 0, l.group || "", l.x, l.y, l.w, l.h, l.kind,
                    l.kind === "filter" ? `${l.filter}${JSON.stringify(l.params || {})}${objectId(l._lutData)}${objectId(l._plateImg)}` : "",
                    pv(l.px), pv(l.maskPx), l.maskOff ? 1 : 0, l.match ? `${l.match.strength}:${l.match.source}` : "");
            }
            return parts.join("|");
        };
        const cancelled = () => Object.assign(new Error(`${L} cancelled.`), { hint: `${L} cancelled.`, kind: "cancelled" });

        try {
            if (editor.relightSettled) await editor.relightSettled(layer);   // its own maps too when it is hidden: the light map reads them
            const W = editor.width, H = editor.height;
            if ((layer.params || {}).detail !== false && W * H > realism.MAX_AREA) {
                throw new Error(`${L}: detail restoration supports pictures up to 27.9 megapixels (${W} x ${H} is ${((W * H) / 1e6).toFixed(1)} MP). Turn off detail restoration or scale the picture down first.`);
            }
            const upTo = realism.topFilterRun(editor.layers, isFill, skip);
            editor.setStatus(`${L}: reading the picture (${W} x ${H}) ...`);
            const sig0 = readSig(upTo);

            const wasVis = layer.visible;
            layer.visible = false;
            const hiddenRelight = [];
            for (const l of editor.layers) {
                if (l.relightOf && l.relightOf === layer.id && l.visible) {
                    l.visible = false;
                    hiddenRelight.push(l);
                }
            }
            let picBytes = null;
            let cFull = null;
            try {
                const enc = await editor.encodeComposite({ forRun: true, upTo });
                if (enc) {
                    picBytes = new Uint8Array(await enc.blob.arrayBuffer());
                    const bmp = await createImageBitmap(enc.blob);
                    cFull = document.createElement("canvas");
                    cFull.width = W; cFull.height = H;
                    cFull.getContext("2d").drawImage(bmp, 0, 0);
                    bmp.close();
                } else {
                    cFull = editor.flattenToCanvas({ forRun: true, upTo });
                    picBytes = await canvasBytes(cFull);
                }
            } finally {
                // the live layers by id: an undo or redo of a layers step during the read put copies in their place
                const live = (l) => editor.layers.find((x) => x.id === l.id) || null;
                const lr = live(layer);
                if (lr) lr.visible = wasVis;
                for (const l of hiddenRelight) { const h = live(l); if (h) h.visible = true; }
            }

            const longSide = Math.max(W, H);
            const scaleFactor = Math.min(1.0, 2048 / longSide);
            const wSend = Math.max(256, Math.round(W * scaleFactor));
            const hSend = Math.max(256, Math.round(H * scaleFactor));

            let cSend = cFull;
            if (wSend !== W || hSend !== H) {
                cSend = document.createElement("canvas");
                cSend.width = wSend; cSend.height = hSend;
                const sx = cSend.getContext("2d");
                sx.imageSmoothingEnabled = true;
                sx.imageSmoothingQuality = "high";
                sx.drawImage(cFull, 0, 0, wSend, hSend);
                picBytes = await canvasBytes(cSend);
            }

            const mapCanvas = document.createElement("canvas");
            mapCanvas.width = wSend; mapCanvas.height = hSend;
            mapCanvas.getContext("2d").drawImage(cSend, 0, 0);
            const relightInfo = {
                scale: wSend / W,
                maps: editor.maps,
                relight: layer._relight,
                layer,
                forRun: true,   // the full shadow map relightSettled waited for, never the quick one (F2.5)
            };
            const lmRes = applyFilter("relight", mapCanvas, { ...layer.params, mode: 1 }, relightInfo);
            const lmCanvas = glToCanvas(lmRes) || lmRes;
            const lightmapBytes = await canvasBytes(lmCanvas);

            const words = lightsToWords(layer.params.lights || [], { width: W, height: H });
            const sentPrompt = [words.prompt, prompt].filter(Boolean).join(" ");

            const p = layer.params || {};
            let out;
            if (route === "comfyui") {
                if (!this.connected) {
                    throw refusal("ComfyUI is not connected: connect under Settings > ComfyUI.");
                }
                const list = this.shell && this.shell.recipes ? this.shell.recipes() : [];
                const localRecipe = list.find((r) => r.id === "relight_qwen_local");
                let info = this.objectInfo;
                if (!info && typeof this.loadObjectInfo === "function") {
                    info = await this.loadObjectInfo();
                }
                this.checkComfyRelightModels(localRecipe, info);
                editor.setStatus(`${L}: sending picture (${wSend} x ${hSend}) to your local ComfyUI ...`);
                const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
                const upload = this.uploadInput(new Blob([picBytes], { type: "image/png" }), `n${editor.node.id}_relight_${stamp}.png`);
                const ref = await new Promise((resolve, reject) => {
                    const t0 = Date.now(), end = Math.min(t0 + 300000, deadline || Infinity);
                    let iv = null;
                    const done = (fn, v) => { clearInterval(iv); fn(v); };
                    iv = setInterval(() => {
                        if (token && token.cancelled) done(reject, cancelled());
                        else if (Date.now() > end) done(reject, new Error(`${L}: your ComfyUI did not take the picture within ${Math.round((Date.now() - t0) / 1000)} s.`));
                    }, 250);
                    upload.then((v) => done(resolve, v), (err) => done(reject, err));
                });
                const promptGraph = JSON.parse(JSON.stringify((localRecipe && localRecipe.prompt) || {}));
                promptGraph["canvas"] = {
                    class_type: "InpaintCanvasLoadRef",
                    inputs: { ref: JSON.stringify({ filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input" }) },
                };
                if (promptGraph.concat_prompt && promptGraph.concat_prompt.inputs) {
                    promptGraph.concat_prompt.inputs.string_b = sentPrompt;
                }
                if (promptGraph.encode_neg && promptGraph.encode_neg.inputs) {
                    promptGraph.encode_neg.inputs.prompt = "";
                }
                if (promptGraph.run && promptGraph.run.inputs) {
                    promptGraph.run.inputs.seed = Math.floor(Math.random() * 1000000000);
                    if (p.steps != null) promptGraph.run.inputs.steps = p.steps;
                    if (p.cfg != null) promptGraph.run.inputs.cfg = p.cfg;
                }
                if (promptGraph.lora_relight && promptGraph.lora_relight.inputs) {
                    promptGraph.lora_relight.inputs.strength_model = loraPercent(p.lora_strength ?? p.strength_model) / 100;
                }
                promptGraph["relight_out"] = { class_type: "PreviewImage", inputs: { images: ["decode", 0] } };
                out = await this.comfyPictureRun(editor, promptGraph, "relight_out", { label: L, token, deadline, timeoutMs: 300000, front: false });
            } else {
                let req;
                if (route === "fal-iclight") {
                    req = {
                        provider: "fal",
                        model: "fal-ai/iclight-v2",
                        kind: "relight",
                        image: picBytes,
                        prompt: sentPrompt,
                        initial_latent: words.latent || "None",
                        enable_hr_fix: p.enable_hr_fix !== false,
                        width: wSend,
                        height: hSend,
                        params: {
                            initial_latent: words.latent || "None",
                            enable_hr_fix: p.enable_hr_fix !== false,
                        },
                    };
                } else if (route === "fal-bria") {
                    req = {
                        provider: "fal",
                        model: "bria/fibo-edit/relight",
                        kind: "relight",
                        image: picBytes,
                        prompt: sentPrompt,
                        light_direction: words.bria?.direction || "front",
                        light_type: p.light_type || words.bria?.type || "soft overcast daylight lighting",
                        params: {
                            light_direction: words.bria?.direction || "front",
                            light_type: p.light_type || words.bria?.type || "soft overcast daylight lighting",
                        },
                    };
                } else if (route === "comfycloud") {
                    const list = this.shell && this.shell.recipes ? this.shell.recipes() : [];
                    const relightRecipe = list.find((r) => r.id === "relight");
                    const cloudOpts = (relightRecipe && relightRecipe.providers && relightRecipe.providers.comfycloud && relightRecipe.providers.comfycloud.options) || null;
                    req = {
                        provider: "comfycloud",
                        model: "image_qwen_image_edit_2509_relight",
                        kind: "relight",
                        image: picBytes,
                        prompt: sentPrompt,
                        options: cloudOpts ? JSON.parse(JSON.stringify(cloudOpts)) : {},
                        params: {
                            "10:118|strength_model": loraPercent(p.lora_strength ?? p.strength_model) / 100,
                            "10:3|steps": p.steps ?? 4,
                            "10:3|cfg": p.cfg ?? 1.0,
                        },
                    };
                } else {
                    req = {
                        provider: route === "magnific" ? "magnific" : route,
                        model: "image-relight",
                        kind: "relight",
                        image: picBytes,
                        lightmap: lightmapBytes,
                        prompt: sentPrompt,
                        params: {
                            light_transfer_strength: p.strength != null ? p.strength : (p.light_transfer_strength != null ? p.light_transfer_strength : 100),
                            style: p.style || "standard",
                            preserve_details: p.preserve_details !== false,
                            interpolate_from_original: !!(p.interpolate != null ? p.interpolate : p.interpolate_from_original),
                            ...(p.advanced_settings ? { advanced_settings: p.advanced_settings } : {}),
                        },
                    };
                }

                editor.setStatus(`${L}: sending picture and guidance (${wSend} x ${hSend}) to ${route} ...`);
                out = await this.relightSend(req, token);
            }
            if (gone()) return { layer: null, seconds: 0, note: "", changed: false, route, seed: null };
            if (token.cancelled) throw cancelled();

            const img = await bytesToImage(out.bytes, out.mime);
            const wAns = img.naturalWidth || img.width, hAns = img.naturalHeight || img.height;

            const useDetail = p.detail !== false;
            let finCanvas = null;
            if (useDetail) {
                editor.setStatus(`${L}: transferring lighting and restoring original details ...`);
                const cAns = document.createElement("canvas");
                cAns.width = wAns; cAns.height = hAns;
                cAns.getContext("2d").drawImage(img, 0, 0);
                const ansPx = cAns.getContext("2d").getImageData(0, 0, wAns, hAns).data;
                const fullPx = cFull.getContext("2d").getImageData(0, 0, W, H).data;

                let lowPx = null;
                if (cSend && typeof cSend.getContext === "function") {
                    if (wSend === wAns && hSend === hAns) {
                        lowPx = cSend.getContext("2d").getImageData(0, 0, wSend, hSend).data;
                    } else {
                        const cLowAns = document.createElement("canvas");
                        cLowAns.width = wAns;
                        cLowAns.height = hAns;
                        const ctxLow = cLowAns.getContext("2d");
                        ctxLow.imageSmoothingEnabled = true;
                        ctxLow.imageSmoothingQuality = "high";
                        ctxLow.drawImage(cSend, 0, 0, wAns, hAns);
                        lowPx = ctxLow.getImageData(0, 0, wAns, hAns).data;
                    }
                }

                let resBytes = null;
                const pool = editorPool();
                if (pool && !pool.off) {
                    try {
                        const fullBuf = fullPx.slice().buffer;
                        const ansBuf = ansPx.slice().buffer;
                        const lowBuf = lowPx ? lowPx.slice().buffer : null;
                        const transfer = lowBuf ? [fullBuf, lowBuf, ansBuf] : [fullBuf, ansBuf];
                        const poolRes = await pool.run("relight_ratio", {
                            fullPx: fullBuf,
                            lowPx: lowBuf,
                            ansPx: ansBuf,
                            W, H, wAns, hAns,
                        }, transfer, { priority: INTERACTIVE, timeout: 180000 });
                        if (poolRes && poolRes.out) resBytes = new Uint8Array(poolRes.out);
                    } catch (err) {
                        console.warn("relight_ratio pool job failed, falling back to main thread:", err);
                    }
                }
                if (!resBytes) {
                    resBytes = detailRatio(fullPx, lowPx, ansPx, W, H, wAns, hAns);
                }
                finCanvas = document.createElement("canvas");
                finCanvas.width = W; finCanvas.height = H;
                const finImgData = new ImageData(new Uint8ClampedArray(resBytes.buffer, resBytes.byteOffset, resBytes.byteLength), W, H);
                finCanvas.getContext("2d").putImageData(finImgData, 0, 0);
            } else {
                finCanvas = document.createElement("canvas");
                finCanvas.width = W; finCanvas.height = H;
                const fx = finCanvas.getContext("2d");
                fx.imageSmoothingEnabled = true;
                fx.imageSmoothingQuality = "high";
                fx.drawImage(img, 0, 0, W, H);
            }

            let ref = null;
            const lbytes = await canvasBytes(finCanvas);
            const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
            try {
                ref = await this.uploadResult(new Blob([lbytes], { type: "image/png" }), `n${editor.node.id}_relight_${stamp}.png`);
            } catch (err) {
                console.warn("the relight layer stays unsaved until the next save", err);
            }

            if (gone()) return { layer: null, seconds: 0, note: "", changed: false, route, seed: null };
            if (token.cancelled) throw cancelled();
            if (editor.width !== W || editor.height !== H) {
                throw new Error(`${L}: picture size changed during the run (was ${W} x ${H}, now ${editor.width} x ${editor.height}).`);
            }

            const at0 = realism.topFilterRun(editor.layers, isFill, skip);
            const changed = readSig(at0) !== sig0;

            editor.pushUndo({ kind: "layers", label: L });
            const at = realism.topFilterRun(editor.layers, isFill, skip);
            const px = editor.pixels.Layer.fromCanvas(finCanvas);
            const pixelLayer = editor.addLayer({
                name: L,
                kind: "image",
                ref,
                dirty: !ref,
                px,
                x: 0,
                y: 0,
                w: W,
                h: H,
                match: { strength: 0, source: "underneath" },
                relightOf: layer.id,
            });
            const top = editor.layers.length - 1;
            if (at < top) editor.moveLayer(pixelLayer.id, at - top, { undo: false });

            // the relight filter layer as it is now (by id: an undo or redo of a layers step during the run rebuilt every
            // layer object, and hiding the one handed in would leave the live one relighting the relit pixels); gone: nothing to hide
            const liveFilter = editor.layers.find((x) => x.id === layer.id) || null;
            const ms = Date.now() - token.started;
            if (liveFilter) {
                liveFilter.visible = false;
                liveFilter.params = {
                    ...liveFilter.params,
                    last: { route, seed: out.seed, ms },
                };
                editor.markFilterChanged(liveFilter);
            }
            editor.renderLayers();
            editor.draw();

            const secs = Math.max(1, Math.round(ms / 1000));
            const changedMsg = changed ? " The picture changed while the relight was running: the layer shows it as it was when the run started." : "";
            editor.setStatus(`${L} finished in ${secs} s: added a new layer above the picture under the filter layers (Ctrl+Z takes it back).${changedMsg}`);
            return { layer: pixelLayer, seconds: ms / 1000, note: changed ? "the picture changed while the relight was running" : "", changed, route, seed: out.seed };
        } catch (err) {
            if (gone()) return { layer: null, seconds: 0, note: "", changed: false, route, seed: null };
            const msg = String((err && err.message) || err);
            throw say(err && err.hint ? String(err.hint) : msg.startsWith(L) ? msg : `${L}: ${msg}`, failKind(err));
        } finally {
            offRemoved();
            this.endRun(editor, token);
        }
    },
};
