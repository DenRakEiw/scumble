// @ts-check
// keying a green or blue screen: moved out of host.js (item 56 S13, docs/PLAN_SPLIT.md), text unchanged.

import * as keying from "./keying.js";
import * as realism from "./realism.js";
import { canvasBytes } from "./stitch.js";
import { failKind, refusal } from "./inpaint_status.js";
import { bandPlan as refineBandPlan } from "./keymatte.js";
import { bytesSource } from "./inpaint_raster.js";
import { readPng } from "./inpaint_png.js";
import { KEY_BAND_ROWS, KEY_MASK_RGB, keyGreyRgba, keyHelper } from "./host_util.js";

export const HostKeyPart = {
    // ---- Key green / blue screen (item 49, docs/PLAN_CORRIDORKEY.md §4.4-4.8; app-only, no editor file calls these) ----

    /** settings.key as stored (the renderer's copy); keyValues() fills it per key (keying.fillValues). */
    keyStored: null,
    _keyLoaded: false,
    /** The Key dialog's live session (renderer/keydialog.js): its `pointer` and `overlay` run before the plugins'. */
    keySession: null,
    /** The editor a key holds while it runs (one key at a time in the app: the engine runs one picture). */
    _keyBusy: null,
    _keyRows: null,
    _keyMatteSeq: 0,

    /**
     * The engine behind the Key screen, one object so a gate can replace it whole (tools/key_test.py). The key process
     * (I3: electron/main/onnx/keyer.js and key_process.js behind helpers:keyPrepare / keyRun / keyFree) fills these in;
     * until then every call answers that the engine is not part of this build.
     *   status()        -> { installed, offered, present, provider, gpu, cpuSeconds, error, workingSizes, buckets, gb,
     *                       host } (sync, cached; buckets: the set's own at every size it holds, gb / host: the set's
     *                       size and download host for the first-run block)
     *   prepare(req)    req { key, image: Uint8Array RGBA at the bucket (padded, keying.padRect), bucket: { w, h },
     *                       content: [0, 0, cw, ch] } -> { provider, ms, cached }
     *   run(req)        req { key, hint: Uint8Array at the bucket | null, quality (-1 with no hint), despill (0..1),
     *                       screen: "green" | "blue", ticket } -> { alpha: Float32Array | Uint16Array at the bucket,
     *                       fg: Uint8Array RGB (sRGB, despilled) at the bucket, ms, provider, ticket }; rejects with a
     *                       message holding keying.FEATURES_GONE when it no longer holds `key`'s features (the idle
     *                       timer, freeHelpers before a local ComfyUI run, a restarted process): the caller prepares
     *                       again from the picture it kept and runs once more
     *   holds(key)      -> whether the features of `key` are still held (Re-key from its record reads nothing then)
     *   cancel()        a Cancel of the run going (the title row, key_screen's timeout): stop it; the window has let
     *                   the document go already and ignores the late answer
     *   free()          the process and its features gone (freeHelpers kills it before a local ComfyUI run)
     *   closed()        the dialog closed: the idle timer starts (60 s, §4.9); only the dialog's own close calls it,
     *                   never its restart (Refit, another source)
     *   download()      optional (I2): the first-run block's Download (the pre-download terms dialog, then the set)
     */
    keyEngine: {
        status() {
            const h = window.scumble && window.scumble.helpers;
            if (!h || typeof h.keyPrepare !== "function") return { installed: false };
            return typeof h.keyStatusCached === "function" ? h.keyStatusCached() : { installed: true, offered: true, present: true, provider: null };
        },
        prepare(req) { return keyHelper("keyPrepare", req); },
        run(req) { return keyHelper("keyRun", req); },
        holds(key) { return keyHelper("keyHolds", { key }).then((r) => !!r, () => false); },
        cancel() { return keyHelper("keyCancel", {}).catch(() => { /* nothing running */ }); },
        free() { const h = window.scumble && window.scumble.helpers; return h && typeof h.keyFree === "function" ? h.keyFree() : Promise.resolve(); },
        closed() { /* I3: the idle timer */ },
    },

    /** The engine's readiness as the dialog, status.key and the refusals say it (keying.engineSupport, §4.8). */
    keySupport() {
        let s;
        try { s = this.keyEngine.status(); } catch (err) { s = { installed: true, offered: true, present: true, error: String((err && err.message) || err) }; }
        return { ...keying.engineSupport(s), workingSizes: (s && s.workingSizes) || null, buckets: (s && s.buckets) || null, gb: (s && s.gb) || null, host: (s && s.host) || "" };
    },

    /** settings.key, read once from the stored settings (the dialog and key_screen call it first). */
    async loadKeyValues() {
        if (this._keyLoaded) return this.keyValues();
        try { const all = await window.scumble.settings.get(); this.keyStored = (all && all.key) || null; } catch (err) { console.warn("settings.key", err); }
        this._keyLoaded = true;
        return this.keyValues();
    },

    keyValues() {
        return keying.fillValues(this.keyStored);
    },

    /** Write settings.key whole (settings.set() stores a top-level key as given): the filled values with `patch`. */
    async setKeyValues(patch) {
        const next = keying.fillValues({ ...this.keyValues(), ...(patch || {}) });
        this.keyStored = next;
        this._keyLoaded = true;
        try { await window.scumble.settings.set({ key: next }); } catch (err) { console.warn("settings.key not saved", err); }
        return next;
    },

    /** The working size a key runs at: the setting, else the nearest the engine offers. */
    keyWorkingSize() {
        const want = this.keyValues().workingSize;
        const sup = this.keySupport();
        const offered = Array.isArray(sup.workingSizes) && sup.workingSizes.length ? sup.workingSizes.map(Number) : null;
        if (!offered || offered.includes(want)) return want;
        return offered.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
    },

    /** A key layer: one this session keyed (its `key` record), or after a restart an image layer named Key with a mask. */
    isKeyLayer(l) {
        return !!l && l.kind !== "filter" && !!l.px && (!!l.key || (/^Key\b/.test(String(l.name || "")) && !!l.maskPx));
    },

    /**
     * Why a key would not start on this document now, before anything is read (§4.7 point 5, realismWholeCheck's
     * shape): the engine (not in the build, the set missing, no provider), a key running, a run going on the document,
     * the document loading, no picture, a source layer that has no pixels of its own, Re-key without a key layer.
     * -> { text, kind } or null
     */
    keyCheck(editor, o = {}) {
        const sup = this.keySupport();
        if (!sup.ok) return { text: sup.text, kind: sup.kind };
        return this.keyDocCheck(editor, o);
    },

    /**
     * The document's half of keyCheck and keyComfyCheck (every route): a key running, a run going on the document, the
     * document loading, no picture, a source layer without pixels of its own, Re-key without a key layer, a hint "mask"
     * without a mask, a transform pending. -> { text, kind } or null
     */
    keyDocCheck(editor, { source = "picture", layer = null, rekey = false, hint = "selection" } = {}) {
        const T = keying.TEXTS, L = keying.LABEL;
        const say = (text, kind) => ({ text, kind });
        if (this._keyBusy) return say(T.keyGoing, "info");
        if (editor.providerPending || (editor._localRuns && editor._localRuns.size)) return say(T.runGoing, "info");
        if (editor._loading) return say(T.loading, "info");
        if (!editor.base || !editor.width || !editor.height) return say(T.noPicture, "info");
        if (rekey) {
            if (!layer || !this.isKeyLayer(layer)) return say(`${L}: Re-key needs a key layer with its mask; make it the active layer.`, "info");
            if (!layer.maskPx) return say(`${L}: ${layer.name} has no mask to re-key from.`, "info");
        } else if (source !== "picture") {
            const why = this.keySourceRefusal(editor, layer);
            if (why) return say(why, "info");
        }
        // a first key with the source layer's own mask as the hint (key_screen hint "mask")
        if (!rekey && hint === "mask" && (source === "picture" || !layer || !layer.maskPx)) return say(T.maskHint, "info");
        if (editor.pending) return say(`${L}: apply or cancel the transform first (Enter / Escape).`, "info");
        return null;
    },

    /** Why `layer` cannot be the Key's source (a filter, text, reference or control layer, or no pixels), or "". */
    keySourceRefusal(editor, layer) {
        const L = keying.LABEL;
        if (!layer) return `${L}: no such layer.`;
        if (layer.kind === "filter") return `${L}: ${layer.name} is a filter layer; key the visible picture or a layer with pixels.`;
        if (layer.kind === "text") return `${L}: ${layer.name} is a text layer; key the visible picture or a layer with pixels.`;
        if (editor.isReference && editor.isReference(layer)) return `${L}: ${layer.name} is a reference layer.`;
        if (editor.isControl && editor.isControl(layer)) return `${L}: ${layer.name} is a control layer.`;
        if (!layer.px || !layer.w || !layer.h) return `${L}: ${layer.name} has no pixels.`;
        return "";
    },

    /**
     * The box and the bucket (keying.boxPlan, §4.7 points 1-2): the selection's bounds grown (hint "selection" with a
     * selection), a source layer's own rect, the whole picture; Re-key: the key's record (`key.box`) while this
     * session holds it, else the key layer's bounds grown as a selection's are (`fromBounds`). A Re-key's `from` names
     * the picture it reads (keyRekeyRead), for the box line.
     */
    keyPlan(editor, { source = "picture", layer = null, hint = "selection", rekey = false } = {}) {
        const W = editor.width, H = editor.height;
        const sup = this.keySupport();
        const opts = { workingSize: this.keyWorkingSize(), buckets: sup.buckets || null };
        if (rekey && layer) {
            const r = this.keyRekeyRead(editor, layer);
            const from = r.layer ? `${r.layer.name}${r.layer.visible ? "" : " (hidden)"}` : "the picture under the key";
            const box = this.keyRecordBox(editor, layer);
            if (box) {
                const p = keying.boxPlan(W, H, null, { ...opts, within: box });
                return { ...p, rekey: true, fromBounds: false, whole: false, layerBox: false, from };
            }
            const p = keying.boxPlan(W, H, [layer.x, layer.y, layer.x + layer.w, layer.y + layer.h], opts);
            return { ...p, rekey: true, fromBounds: true, whole: false, layerBox: false, from };
        }
        const sel = hint === "selection" && editor.getBounds ? editor.getBounds() : null;
        const within = source !== "picture" && layer && !sel ? [layer.x, layer.y, layer.x + layer.w, layer.y + layer.h] : null;
        const p = keying.boxPlan(W, H, sel, { ...opts, within });
        return { ...p, rekey: false, fromBounds: false, whole: !sel && !within, layerBox: !sel && !!within };
    },

    /**
     * The box of a key layer's session record, while it still describes this picture: none after a restart (the record
     * is not stored), after a turn, crop, extend, resize or straighten (keyWatchGeometry drops it) or at another size.
     */
    keyRecordBox(editor, layer) {
        const rec = layer && layer.key;
        if (!rec || !Array.isArray(rec.box)) return null;
        if (Array.isArray(rec.size) && (rec.size[0] !== editor.width || rec.size[1] !== editor.height)) return null;
        return rec.box;
    },

    /**
     * What a Re-key reads (§4.5 "The source pixels"): the key's source layer while the record names one (a key of a layer
     * hid it in the same step, so the visible picture holds no subject), the picture under the key for a key of the
     * picture (or a source layer that went); after a restart (no record) the hidden pixel layer directly below the key
     * when there is one, else the picture under the key. -> { source: "picture" | layer id, layer | null }
     */
    keyRekeyRead(editor, layer) {
        const rec = layer && layer.key;
        const pixels = (l) => !!l && l !== layer && l.kind !== "filter" && l.kind !== "text" && !!l.px && !!l.w && !!l.h
            && !(editor.isReference && editor.isReference(l)) && !(editor.isControl && editor.isControl(l));
        if (rec) {
            const l = rec.source && rec.source !== "picture" ? editor.layers.find((x) => x.id === rec.source) : null;
            return pixels(l) ? { source: l.id, layer: l } : { source: "picture", layer: null };
        }
        const i = editor.layers.indexOf(layer);
        const below = i > 0 ? editor.layers[i - 1] : null;
        return pixels(below) && !below.visible ? { source: below.id, layer: below } : { source: "picture", layer: null };
    },

    /** Records stop describing the picture once its geometry changes (the "geometry" event): Re-key reads it again. */
    keyWatchGeometry() {
        if (this._keyGeoOff) return;
        this._keyGeoOff = this.on("geometry", (e) => {
            const ed = e && e.editor;
            if (!ed || !Array.isArray(ed.layers)) return;
            for (const l of ed.layers) if (l.key) l.key = { ...l.key, box: null, hash: null };
        });
    },

    /** The index the picture under a key layer is read up to (Re-key): the key's grey layer or the key, the lower. */
    keyUpTo(editor, layer) {
        const i = editor.layers.indexOf(layer);
        const g = layer.key && layer.key.greyId ? editor.layers.findIndex((l) => l.id === layer.key.greyId) : -1;
        return g >= 0 && g < i ? g : i;
    },

    /**
     * A layer's own pixels (with its live mask) inside `box`, at the box's scale into cw x ch RGBA, on `bg` where it is
     * transparent (as objectInput reads a layer: the levels on tiles, the layer's canvas otherwise). `mask`: the mask
     * alone, its levels in the alpha (a Re-key hint).
     */
    async keyLayerInput(editor, layer, box, cw, ch, { mask = false, bg = null } = {}) {
        const [bx0, by0, bx1, by1] = box;
        const s = cw / (bx1 - bx0), t = ch / (by1 - by0);
        const what = mask ? layer.maskPx : layer.px;
        const c = document.createElement("canvas");
        c.width = cw; c.height = ch;
        const x = c.getContext("2d");
        x.imageSmoothingEnabled = true;
        const vp = { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0, sx: s, sy: t, sample: true };
        let jobs = [];
        if (editor.tileMode && what && typeof what.primeRegion === "function") {
            const fx = layer.w / what.width, fy = layer.h / what.height;
            const rect = [(bx0 - layer.x) / fx, (by0 - layer.y) / fy, (bx1 - layer.x) / fx, (by1 - layer.y) / fy];
            const level = editor.tileLevel(fx * Math.max(s, t));
            const parts = [what];
            if (!mask && layer.maskPx && !layer.maskOff) parts.push(layer.maskPx);
            jobs = await Promise.all(parts.map((q) => q.primeRegion(rect, level)));
        }
        try {
            x.setTransform(s, 0, 0, t, -bx0 * s, -by0 * t);
            editor.drawPixelsInto(x, layer, what, vp);
            if (!mask && layer.maskPx && !layer.maskOff) {
                x.globalCompositeOperation = "destination-in";
                editor.drawPixelsInto(x, layer, layer.maskPx, vp);
            }
        } finally {
            for (const j of jobs) j.release();
        }
        let out = c;
        if (bg) {
            out = document.createElement("canvas");
            out.width = cw; out.height = ch;
            const o = out.getContext("2d");
            o.fillStyle = bg;
            o.fillRect(0, 0, cw, ch);
            o.drawImage(c, 0, 0);
            c.width = c.height = 0;
        }
        const img = out.getContext("2d").getImageData(0, 0, cw, ch);
        out.width = out.height = 0;
        return new Uint8Array(img.data.buffer);
    },

    /**
     * The picture the engine keys, at the bucket (§4.5 "The source pixels"), read but not sent: the visible picture inside
     * the box (filters skipped, as a run reads it), or a layer's own pixels (hidden or not) on the screen's colour where
     * it is transparent; Re-key reads what keyRekeyRead names (the source layer, or only the layers under the key,
     * `upTo`). A layer's screen on Auto is told from its own opaque pixels (the ring weighted by its alpha), before the
     * fill is chosen; `weight` (its alpha at the bucket) keeps the fill out of the later guess too. Padded reflect-101
     * where the picture's edge leaves it short. `read` says how the same picture is read at full resolution for the
     * refine (keyBandReader): the layer and its fill, or the picture up to `upTo`.
     * -> { image, hash, source: "picture" | layer id, weight | null, keyedScreen | null, read: { layer, fill, upTo } }
     */
    async keyRead(editor, plan, { source = "picture", layer = null, rekey = false, screen = "auto" } = {}) {
        const { bucket } = plan;
        const [, , cw, ch] = plan.content;
        let src = source === "picture" ? "picture" : layer ? layer.id : "picture";
        let from = source === "picture" ? null : layer;
        let keyedScreen = null;
        if (rekey && layer) {
            const r = this.keyRekeyRead(editor, layer);
            src = r.source; from = r.layer;
            const rs = layer.key && layer.key.screen;
            if (rs === "green" || rs === "blue") keyedScreen = rs;
            if (screen !== "green" && screen !== "blue" && keyedScreen) screen = keyedScreen;
        }
        let image, weight = null, read;
        if (!from) {
            const opts = rekey && layer ? { skipFilters: true, upTo: this.keyUpTo(editor, layer) } : { skipFilters: true };
            const rgba = (await this.pictureInputBox(editor, plan.box, cw, ch, opts)).image;
            image = keying.padRect(rgba, cw, ch, bucket.w, bucket.h, 4);
            read = { layer: null, fill: null, upTo: opts.upTo == null ? null : opts.upTo };
        } else {
            const raw = await this.keyLayerInput(editor, from, plan.box, cw, ch);
            const n = cw * ch, a = keying.alphaPlane(raw, n);
            let fill = screen === "green" || screen === "blue" ? screen : keying.screenFromRing(raw, cw, ch, [0, 0, cw, ch], null, a).screen;
            if (!fill) fill = "green";
            image = keying.padRect(keying.overColour(raw, n, keying.SCREEN_FILL[fill]), cw, ch, bucket.w, bucket.h, 4);
            weight = keying.padRect(a, cw, ch, bucket.w, bucket.h, 1);
            read = { layer: from, fill, upTo: null };
        }
        const hash = await this.inputHash(image);
        return { image, hash, source: src, weight, keyedScreen, read };
    },

    /**
     * The picture prepared in the engine under the features' key `<doc>:<hash of the bytes>:<w>x<h>` (the hash, not
     * compositeVersion: a mask stroke on the key layer keeps it). A Re-key from its record asks the engine first whether it
     * still holds the features under the record's hash and reads nothing then (§4.5); `read: true` reads in any case.
     * -> { key, image | null, hash, provider, ms, cached, held, source, weight, keyedScreen, read | null }
     */
    async keyPrepare(editor, plan, o = {}) {
        const { bucket } = plan;
        const rec = o.rekey && o.layer ? o.layer.key : null;
        if (rec && rec.hash && !o.read && !plan.fromBounds && rec.bucket && rec.bucket.w === bucket.w && rec.bucket.h === bucket.h && typeof this.keyEngine.holds === "function") {
            const key = `${editor.node.id}:${rec.hash}:${bucket.w}x${bucket.h}`;
            let held = false;
            try { held = !!(await this.keyEngine.holds(key)); } catch (_) { held = false; }
            if (held) {
                editor.helperUsed = true;
                const rs = rec.screen === "green" || rec.screen === "blue" ? rec.screen : null;
                return { key, image: null, hash: rec.hash, provider: rec.provider || null, ms: 0, cached: true, held: true, source: rec.source || "picture", weight: null, keyedScreen: rs, read: null };
            }
        }
        return this.keyPrepareRead(editor, plan, await this.keyRead(editor, plan, o));
    },

    /** A read picture (keyRead) prepared in the engine. */
    async keyPrepareRead(editor, plan, r) {
        const { bucket } = plan;
        const key = `${editor.node.id}:${r.hash}:${bucket.w}x${bucket.h}`;
        editor.helperUsed = true;
        const res = (await this.keyEngine.prepare({ key, image: r.image, bucket: { w: bucket.w, h: bucket.h }, content: plan.content.slice() })) || {};
        return { key, image: r.image, hash: r.hash, provider: res.provider || null, ms: res.ms || 0, cached: !!res.cached, held: false, source: r.source, weight: r.weight, keyedScreen: r.keyedScreen || null, read: r.read || null };
    },

    /**
     * After the engine said it no longer holds `prep`'s features (keying.isFeaturesGone): the kept picture sent again under
     * the same key, or (a Re-key that read nothing) read and prepared now. -> the prep to run with
     */
    async keyReprepare(editor, plan, prep, o = {}) {
        if (prep && prep.image) {
            editor.helperUsed = true;
            await this.keyEngine.prepare({ key: prep.key, image: prep.image, bucket: { w: plan.bucket.w, h: plan.bucket.h }, content: plan.content.slice() });
            return prep;
        }
        return this.keyPrepare(editor, plan, { ...o, read: true });
    },

    /**
     * The hint at the bucket (§4.6): the selection's coverage (its levels on tiles, `sel.drawTo` into a crop-sized canvas
     * on canvases), a key layer's mask (Re-key), or none (quality -1, the model decides). A selection that leaves the box
     * empty sends none. -> { hint: Uint8Array | null, quality, sig } (`sig`: what the loop compares)
     */
    async keyHint(editor, plan, { hint = "selection", trust = 0.5, layer = null } = {}) {
        const { bucket } = plan;
        const [, , cw, ch] = plan.content;
        if (hint === "none") return { hint: null, quality: -1, sig: "none" };
        let plane = null, sig;
        if (hint === "mask") {
            if (!layer || !layer.maskPx) return { hint: null, quality: -1, sig: "nomask" };
            const rgba = await this.keyLayerInput(editor, layer, plan.box, cw, ch, { mask: true });
            plane = keying.alphaPlane(rgba, cw * ch);
            sig = `mask:${layer.id}:${layer.maskPx.version || 0}`;
        } else {
            // mid-stroke the bounds are stale (selectionDab writes the levels, the bounds follow at pointer-up): the
            // shortcut only outside a selection-brush stroke, planeAny decides emptiness either way
            const stroking = !!(editor.pointer && editor.pointer.kind === "selpaint");
            if (!stroking && !editor.getBounds()) return { hint: null, quality: -1, sig: `sel:${editor.selectionSeq}:empty` };
            const box = plan.box;
            const s = cw / (box[2] - box[0]);
            let m = await editor.selectionCanvasSettled(box, s, cw, ch);
            let own = false;
            if (!m) {
                m = document.createElement("canvas");
                m.width = cw; m.height = ch;
                own = true;
                const mc = m.getContext("2d");
                mc.imageSmoothingEnabled = true;
                editor.sel.drawTo(mc, box[0], box[1], box[2] - box[0], box[3] - box[1], 0, 0, cw, ch);
            }
            const img = m.getContext("2d").getImageData(0, 0, cw, ch);
            if (own || m.width) { m.width = m.height = 0; }
            plane = keying.alphaPlane(img.data, cw * ch);
            sig = `sel:${editor.selectionSeq}`;
        }
        if (!keying.planeAny(plane)) return { hint: null, quality: -1, sig: sig + ":empty" };
        // the trust a mask hint goes with: 0.95 for a Re-key (its callers pass it), as given for a first key's layer mask
        return { hint: keying.padRect(plane, cw, ch, bucket.w, bucket.h, 1), quality: keying.trustOf(trust).value, sig };
    },

    /**
     * The screen to send: the one asked, or Auto's guess from the box's border ring (a layer source's ring weighted by
     * its own alpha; a Re-key that read nothing: the screen it was keyed on). Null: the dialog asks.
     */
    keyScreenColour(plan, prep, hint, screen) {
        if (screen === "green" || screen === "blue") return screen;
        if (prep.keyedScreen) return prep.keyedScreen;
        if (!prep.image) return null;
        const guess = keying.screenFromRing(prep.image, plan.bucket.w, plan.bucket.h, plan.content, hint, prep.weight || null).screen;
        // a layer's transparent parts were filled with the colour keyRead told from the ring without the hint: a guess
        // that now says the other screen would key a blue fill as green (or the reverse), and the fill would land as
        // opaque colour in the key layer. The screen is decided once: the dialog asks instead. (An opaque layer shows
        // no fill, so its hinted guess stands.)
        if (guess && prep.read && prep.read.layer && prep.read.fill && guess !== prep.read.fill && prep.weight && prep.weight.some((v) => v < 255)) return null;
        return guess;
    },

    /**
     * One engine run (no coalescing: the dialog's KeyQueue sits in front of it for the live loop). When the engine no
     * longer holds the features (FEATURES_GONE) `again()` prepares once more and the run is sent once more.
     * -> { res, prep } (prep: the one the answer is from)
     */
    async keyRunOnce(prep, h, { despill = 0.5, screen = "green", ticket = 0, again = null } = {}) {
        const send = (p) => this.keyEngine.run({ key: p.key, hint: h.hint, quality: h.quality, despill, screen, ticket });
        let res;
        try { res = await send(prep); } catch (err) {
            if (!again || !keying.isFeaturesGone(err)) throw err;
            prep = await again();
            res = await send(prep);
        }
        if (!res || !res.alpha || !res.fg) throw new Error("the keyer answered no matte");
        return { res, prep };
    },

    /**
     * Key green / blue screen (§4.5): the matte CorridorKey 2.0 pulls in Scumble lands as a new layer **Key** directly
     * above the source (a source layer is hidden in the same step; with the visible picture as the source, and `grey`, a
     * mid-grey Fill layer "Grey" under it), trimmed to the matte's box, its pixels the engine's unmixed colour, its layer
     * mask the matte (white where it lets through); one undo step. `rekey`: the key layer's own pixels and mask replaced
     * from the picture under it (one `layerfull` step). `preview`: the matte into the selection instead (one selection
     * step), nothing landed. `session` (the Key dialog's): its prepared picture and, when it is the newest for the
     * current hint, its matte, so Key lands what the overlay shows. Refused before anything is read (keyCheck); holds the
     * document like a run (the title row's timer and Cancel); a closed tab or a Cancel adds nothing.
     * -> { layer, grey, hidden, box, matteBox, workingSize, provider, seconds, kept, status } (layer null after a close)
     */
    async keyScreen(editor, opts = {}) {
        // Route B (§4.11): the key on your ComfyUI, asked for or the default while the in-app engine is not ready
        if (this.keyRoute(opts.route) === "comfyui") return this.keyComfy(editor, opts);
        const L = keying.LABEL, T = keying.TEXTS;
        const say = (text, kind) => { editor.setStatus(text, kind); return refusal(text, kind || "info"); };
        const v = await this.loadKeyValues();
        const o = {
            source: "picture", layer: null, hint: "selection", rekey: false, preview: false, session: null,
            screen: v.screen, trust: v.trust, despill: v.despill, grey: v.greyUnderBase, ...opts,
        };
        if (o.rekey) { o.hint = "mask"; o.trust = 0.95; }
        else if (o.hint === "mask" && opts.trust == null) o.trust = 0.95;
        const refused = this.keyCheck(editor, o);
        if (refused) throw say(refused.text, refused.kind);
        const token = { provider: "key", label: L, started: Date.now(), editor };
        // A Cancel (the title row's, key_screen's timeout, a closed tab: cancelRuns sets `cancelled`) lets the document
        // go at once: the title row, providerPending and the app's one key; the engine is told (keyEngine.cancel) and its
        // late answer is ignored (every engine await below races the cancel)
        let cancelFlag = false, cancelReject = null, released = false;
        const cancelP = new Promise((_, rej) => { cancelReject = rej; });
        cancelP.catch(() => { /* raced below */ });
        const cancelErr = () => Object.assign(new Error(T.cancelled), { hint: T.cancelled, kind: "cancelled", statusKind: "info" });
        let offRemoved = () => {};
        const release = () => {
            if (released) return;
            released = true;
            offRemoved();
            if (this._keyBusy === editor) this._keyBusy = null;
            this.endRun(editor, token);
        };
        Object.defineProperty(token, "cancelled", {
            configurable: true, enumerable: true,
            get: () => cancelFlag,
            set: (v) => {
                if (!v || cancelFlag) return;
                cancelFlag = true;
                release();
                try { if (typeof this.keyEngine.cancel === "function") Promise.resolve(this.keyEngine.cancel()).catch(() => {}); } catch (_) { /* nothing to stop */ }
                cancelReject(cancelErr());
            },
        });
        const race = (p) => Promise.race([p, cancelP]);
        editor.providerPending = token;
        this._providerRuns.add(token);
        this._keyBusy = editor;
        this.notifyProviderRuns();
        let closed = false;
        offRemoved = this.on("removed", (e) => { if (e && e.editor === editor) { closed = true; token.cancelled = true; } });
        const gone = () => closed || !this._editors.includes(editor);
        const stop = () => { if (token.cancelled) throw cancelErr(); };
        const t0 = performance.now();
        const none = { layer: null, grey: null, hidden: null, box: null, matteBox: null, workingSize: 0, provider: null, seconds: 0, kept: 0, status: "" };
        try {
            const ses = o.session && o.session.editor === editor && o.session.prep && o.session.plan ? o.session : null;
            const plan = ses ? ses.plan : this.keyPlan(editor, o);
            editor.setStatus(`${L}: ${keying.boxLine(plan)} ...`);
            let prep;
            if (ses) {
                prep = ses.prep;
                // the panel is not modal: an edit, an undo or a paint under it since the picture was prepared means the
                // features are another picture's; read it again (a few ms beside a run) and prepare it when it differs
                if (prep.image) {
                    const r = await race(this.keyRead(editor, plan, o));
                    if (gone()) return none;
                    if (r.hash !== prep.hash) {
                        prep = await race(this.keyPrepareRead(editor, plan, r));
                        if (ses.adopt) ses.adopt(prep);
                    }
                }
            } else prep = await race(this.keyPrepare(editor, plan, o));
            if (gone()) return none;
            stop();
            const h = await race(this.keyHint(editor, plan, o));
            if (gone()) return none;
            stop();
            const screen = this.keyScreenColour(plan, prep, h.hint, o.screen);
            if (!screen) throw refusal(T.askScreen, "info");
            let res = ses && ses.currentMatte ? ses.currentMatte(h.sig, screen, o.despill, h.quality) : null;
            if (!res && ses && ses.final) {
                res = await race(ses.final({ hint: h, screen, despill: o.despill }));
                prep = ses.prep || prep;
            } else if (!res) {
                const out = await race(this.keyRunOnce(prep, h, { despill: o.despill, screen, again: () => this.keyReprepare(editor, plan, prep, o) }));
                res = out.res; prep = out.prep;
            }
            if (gone()) return none;
            stop();
            const matte = { alpha: keying.alphaFloats(res.alpha), fg: res.fg, bw: plan.bucket.w, bh: plan.bucket.h };
            const kept = keying.keptShare(matte.alpha, matte.bw, plan.content);
            const provider = res.provider || prep.provider || null;
            if (o.preview) {
                const mb = await this.keyIntoSelection(editor, plan, matte, () => gone() || cancelFlag);
                if (gone()) return none;
                stop();
                const secs = (performance.now() - t0) / 1000;
                const text = `${L}: the matte is the selection now (${Math.round(kept)} % of the box, ${Math.round(secs * 10) / 10} s, ${keying.ENGINE} on ${keying.providerName(provider)}); nothing was added.`;
                editor.setStatus(text, "info");
                return { ...none, box: plan.box.slice(), matteBox: mb, workingSize: Math.max(plan.bucket.w, plan.bucket.h), provider, seconds: secs, kept, status: text };
            }
            const record = { box: plan.box.slice(), size: [editor.width, editor.height], bucket: { ...plan.bucket }, screen, despill: o.despill, trust: h.quality, hint: o.hint, source: prep.source, provider, hash: prep.hash, greyId: null };
            // a matte keyed smaller than its box is refined against the full-resolution picture (I6, keymatte.js)
            const refine = keying.isScaled(plan) ? await race(this.keyRefineInput(editor, plan, o, prep)) : null;
            if (gone()) { if (refine) refine.done(); return none; }
            const landed = await this.landKey(editor, { matte, plan, refine, source: o.rekey ? null : o.source === "picture" ? null : o.layer, rekeyLayer: o.rekey ? o.layer : null, grey: !o.rekey && o.source === "picture" && !!o.grey, record, token, gone });
            if (!landed) return none;
            const secs = (performance.now() - t0) / 1000;
            let text = keying.statusLine({ kept, seconds: secs, provider, screen, hint: h.hint ? o.hint : "none", trust: h.quality, keyedAt: Math.max(plan.bucket.w, plan.bucket.h), grey: !!landed.grey, hidden: landed.hidden ? landed.hidden.name : "", rekey: o.rekey });
            const rn = landed.refine;
            if (rn && (rn.fallback || rn.error)) {
                // plain: not the user's error (docs/ck2/refine_notes.md step 8); the console keeps the record
                text += ` The matte was not refined against the picture: ${rn.fallback || rn.error}.`;
                console.warn(`${L}: the matte was not refined`, rn);
            }
            editor.setStatus(text, "info");
            return { layer: landed.layer, grey: landed.grey, hidden: landed.hidden, box: plan.box.slice(), matteBox: landed.matteBox, workingSize: Math.max(plan.bucket.w, plan.bucket.h), provider, seconds: secs, kept, refine: rn || null, status: text };
        } catch (err) {
            if (gone()) return none;
            const msg = String((err && err.message) || err);
            const text = err && err.hint ? String(err.hint) : msg.startsWith(L) || msg.startsWith("Key") ? msg : `${L}: the keyer stopped: ${msg}`;
            throw say(text, failKind(err));
        } finally {
            release();
        }
    },

    /** The window's side of keyworker.js (keying.RowsClient), made on the first key. */
    keyRowsClient() {
        if (!this._keyRows) this._keyRows = new keying.RowsClient();
        return this._keyRows;
    },

    /**
     * What the refine of a scaled matte needs (I6; docs/ck2/refine_notes.md steps 1 and 4): the bucket picture the
     * engine keyed (`small`, the padded RGBA sent to prepare) and a reader of the same picture at full resolution
     * (keyBandReader). A Re-key that read nothing (the engine held the features) reads the picture now and refines only
     * when it is the picture the features were made from. -> { small, read, done } or null (the bilinear matte)
     */
    async keyRefineInput(editor, plan, o, prep) {
        let image = prep ? prep.image : null, spec = prep ? prep.read : null;
        if (!image || !spec) {
            const r = await this.keyRead(editor, plan, o);
            if (!prep || r.hash !== prep.hash) return null;
            image = r.image; spec = r.read;
        }
        return { small: image, ...this.keyBandReader(editor, spec) };
    },

    /**
     * Full-resolution rows of the picture a key's bucket was read from (keymatte.js needs the same picture, only the
     * scale differs: the same source, filters skipped alike, the same fill under a layer's transparent parts): the
     * visible picture through pictureInputBox at a scale of 1 on tiles (its levels), one flatten cropped per band on the
     * canvas backend, a layer source's own pixels with its mask on the screen's colour. `read([x0, y0, x1, y1])` in
     * image pixels -> straight RGBA bytes; `done()` lets the flatten go.
     */
    keyBandReader(editor, spec) {
        let flat = null;
        const upTo = spec && spec.upTo != null ? spec.upTo : null;
        const read = async (b) => {
            const w = b[2] - b[0], h = b[3] - b[1];
            if (spec && spec.layer) {
                const raw = await this.keyLayerInput(editor, spec.layer, b, w, h);
                return keying.overColour(raw, w * h, keying.SCREEN_FILL[spec.fill === "blue" ? "blue" : "green"]);
            }
            if (editor.tileMode) return (await this.pictureInputBox(editor, b, w, h, { skipFilters: true, upTo })).image;
            if (!flat) {
                if (editor.relightSettled) await editor.relightSettled();
                flat = editor.flattenToCanvas(upTo == null ? { forRun: true, skipFilters: true } : { forRun: true, skipFilters: true, upTo });
            }
            return new Uint8Array(flat.getContext("2d").getImageData(b[0], b[1], w, h).data.buffer);
        };
        const done = () => { if (flat) { flat.width = flat.height = 0; flat = null; } };
        return { read, done };
    },

    /**
     * The refined alpha of a scaled matte into the mask `m` (I6, docs/ck2/refine_notes.md step 4): the refine prepared in
     * the key worker on the matte kept under `mid` (the bucket picture `refine.small`, the content's place in the bucket,
     * the box at full resolution, the matte's box inside it), the noise sample's rows read and checked (a read that is not
     * the bucket's picture falls back to the bilinear matte, said in `fallback`), then per band of keymatte.bandPlan its
     * rows with the halo read at full resolution and the answer combined "add" in white.
     * -> { fallback, guideDiff, noise, bands, halo, soft, ms } or null (the tab went away)
     */
    async keyRefineAlpha(editor, rc, mid, m, { plan, mbox, matte, refine, gone }) {
        const t0 = performance.now();
        const [cx0, cy0, cx1, cy1] = plan.content;
        const lw = mbox[2] - mbox[0], lh = mbox[3] - mbox[1];
        const info = await rc.refine(mid, {
            small: { data: refine.small, width: matte.bw, height: matte.bh },
            src: { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 },
            full: { w: plan.box[2] - plan.box[0], h: plan.box[3] - plan.box[1] },
            out: { x: mbox[0] - plan.box[0], y: mbox[1] - plan.box[1], w: lw, h: lh },
        });
        const rows = (y0, y1) => refine.read([mbox[0], mbox[1] + y0, mbox[2], mbox[1] + y1]);
        let note = { noise: null, guideDiff: null, fallback: null };
        if (info.method === "fast" && info.sample) {
            const sample = await rows(info.sample[0], info.sample[1]);
            if (gone()) return null;
            note = await rc.refineSample(mid, sample);
        }
        const bands = refineBandPlan(lw, lh, { halo: info.halo });
        for (const band of bands) {
            const rgba = note.fallback || info.method === "bilinear" ? null : await rows(band.ry0, band.ry1);
            if (gone()) return null;
            const { a } = await rc.refineBand(mid, band, rgba);
            if (gone()) return null;
            m.combine(bytesSource(a, 0, band.y0, lw, band.y1 - band.y0), "add", KEY_MASK_RGB);
        }
        return { fallback: note.fallback || null, guideDiff: note.guideDiff, noise: note.noise, bands: bands.length, halo: info.halo, soft: info.soft, ms: Math.round(performance.now() - t0), error: null };
    },

    /**
     * The matte back to the box in bands (§4.5 steps 2-5), shared by every route (Route B lands its native answer
     * through it with a bucket the box's own size, and a scaled one with `refine`): the matte's box first
     * (keying.matteBox: the layer is that big, not the box's), then per 256-row band the foreground (and the alpha)
     * sampled bilinearly from the bucket in the app-only worker, the pixels written opaque (`writeRect`, the copy path)
     * and the mask combined with "add" in white (a replace per band would clear the bands before it). A matte keyed
     * smaller than its box, with `refine` ({ small: the RGBA picture the matte was keyed from, at the bucket; read: the
     * same picture's full-resolution rows; done }, keyRefineInput / keyBandReader), has its alpha refined against the
     * picture instead (keyRefineAlpha, keymatte.js); a refine that fails lands the bilinear alpha and says why in
     * `refine.error`. Then one undo step: the grey
     * Fill layer (`grey`) and the Key layer (`ref: null`, both dirty flags, so syncLayers uploads the pixels and the
     * mask), above the source layer (hidden in the same step) or, for the visible picture, at the top of the stack
     * under its top run of filter layers; `rekeyLayer`: its pixels, mask and rect replaced (a `layerfull` step). The
     * `key` record stays on the layer for this session only (§4.5 step 5: not in the document).
     * -> { layer, grey, hidden, matteBox, refine } or null (the tab went away); `refine`: keyRefineAlpha's record, null
     * when the matte was not scaled or nothing to refine with was given
     */
    async landKey(editor, { matte, plan, refine = null, source = null, rekeyLayer = null, grey = false, record = null, token = null, gone = () => false }) {
        const T = keying.TEXTS, L = keying.LABEL;
        const mbox = keying.matteBox(matte.alpha, matte.bw, matte.bh, plan.content, plan.box);
        if (!mbox) { if (refine) refine.done(); throw refusal(T.nothingKept, "warn"); }
        if (record) this.keyWatchGeometry();
        const lw = mbox[2] - mbox[0], lh = mbox[3] - mbox[1];
        const map = keying.sampleMap(mbox, plan.box, plan.content);
        const rc = this.keyRowsClient();
        const mid = `m${++this._keyMatteSeq}`;
        const px = editor.pixels.Layer.empty(lw, lh);
        let m = editor.pixels.Mask.empty(lw, lh);
        let refined = null;
        try {
            await rc.matte(mid, matte.alpha, matte.fg, matte.bw, matte.bh);
            if (refine && refine.small && typeof refine.read === "function" && keying.isScaled(plan)) {
                try {
                    refined = await this.keyRefineAlpha(editor, rc, mid, m, { plan, mbox, matte, refine, gone });
                    if (!refined) return null;
                } catch (err) {
                    if (gone()) return null;
                    // the bilinear alpha instead, on a fresh mask (the bands written so far are dropped)
                    refined = { fallback: null, guideDiff: null, noise: null, bands: 0, halo: 0, soft: 0, ms: 0, error: String((err && err.message) || err) };
                    m = editor.pixels.Mask.empty(lw, lh);
                }
            }
            const alphaToo = !refined || !!refined.error;
            for (let y0 = 0; y0 < lh; y0 += KEY_BAND_ROWS) {
                const rows = Math.min(KEY_BAND_ROWS, lh - y0);
                const { a, rgba } = await rc.rows(mid, map, lw, y0, rows, { alpha: alphaToo });
                if (gone()) return null;
                px.writeRect(new ImageData(rgba, lw, rows), 0, y0);
                if (alphaToo) m.combine(bytesSource(a, 0, y0, lw, rows), "add", KEY_MASK_RGB);
            }
        } finally {
            rc.drop(mid);
            if (refine) refine.done();
        }
        if (gone()) return null;
        if (token && token.cancelled) throw Object.assign(new Error(T.cancelled), { hint: T.cancelled, kind: "cancelled", statusKind: "info" });
        // the layers again by id: a key on your ComfyUI waits seconds while the dialog is non-modal, and an undo or redo
        // of a layers step meanwhile rebuilds every layer object (inpaint_canvas.js undoStep), a delete takes one away
        const live = (l) => (l && editor.layers.find((x) => x.id === l.id)) || null;
        if (rekeyLayer) {
            const l = live(rekeyLayer);
            if (!l) throw refusal(T.rekeyGone, "info");
            editor.pushUndo({ kind: "layerfull", id: l.id, label: "Re-key" });
            l.px = editor.ownPixels ? editor.ownPixels(px) : px;
            l.maskPx = editor.ownPixels ? editor.ownPixels(m) : m;
            l.x = mbox[0]; l.y = mbox[1]; l.w = lw; l.h = lh;
            l.ref = null; l.maskRef = null; l.maskOff = false;
            if (record) l.key = { ...record, greyId: l.key && l.key.greyId ? l.key.greyId : null };
            editor.markLayerChanged(l);
            editor.markMaskChanged(l);
            editor.renderLayers();
            editor.draw();
            return { layer: l, grey: null, hidden: null, matteBox: mbox, refine: refined };
        }
        // a source layer deleted meanwhile: the key lands as a key of the visible picture does, nothing hidden
        source = live(source);
        const isFill = (x) => editor.isFillLayer(x);
        const skip = (x) => editor.isReference(x) || editor.isControl(x) || (x.kind !== "filter" && !x.visible);
        const at = source ? editor.layers.indexOf(source) + 1 : realism.topFilterRun(editor.layers, isFill, skip);
        editor.pushUndo({ kind: "layers", label: L });
        let fill = null;
        if (grey) {
            fill = editor.addFilterLayer("fill");
            if (fill) {
                fill.params.color = keying.GREY;
                fill.name = keying.GREY_NAME;
                editor.markFilterChanged(fill);
            }
        }
        const layer = editor.addLayer({
            name: keying.LAYER_NAME, kind: "image", ref: null, dirty: true, px, maskPx: m, maskDirty: true,
            x: mbox[0], y: mbox[1], w: lw, h: lh, match: { strength: 0, source: "underneath" },
        });
        // into place by hand (one splice, the same group as the source): moveLayer's steps count groups as steps
        const take = (l) => { const i = editor.layers.indexOf(l); if (i >= 0) editor.layers.splice(i, 1); };
        if (fill) take(fill);
        take(layer);
        const group = source ? source.group || null : null;
        const put = fill ? [fill, layer] : [layer];
        for (const l of put) l.group = group;
        editor.layers.splice(Math.min(at, editor.layers.length), 0, ...put);
        let hidden = null;
        if (source && source.visible) { source.visible = false; hidden = source; }
        if (record) layer.key = { ...record, greyId: fill ? fill.id : null };
        editor.activeLayerId = layer.id;
        if (editor.selectLayers) editor.selectLayers([layer.id]);
        editor.layersRestacked();
        return { layer, grey: fill, hidden, matteBox: mbox, refine: refined };
    },

    /**
     * key_screen `preview` (§4.8): the matte into the selection in bands (combine "add" over a cleared selection, one
     * selection undo step as selectLogits does), nothing landed. -> the matte's box
     */
    async keyIntoSelection(editor, plan, matte, gone = () => false) {
        const mbox = keying.matteBox(matte.alpha, matte.bw, matte.bh, plan.content, plan.box);
        if (!mbox) throw refusal(keying.TEXTS.nothingKept, "warn");
        const lw = mbox[2] - mbox[0], lh = mbox[3] - mbox[1];
        const map = keying.sampleMap(mbox, plan.box, plan.content);
        const rc = this.keyRowsClient();
        const mid = `m${++this._keyMatteSeq}`;
        await rc.matte(mid, matte.alpha, null, matte.bw, matte.bh);
        const old = editor.getBounds();
        const bands = [];
        try {
            for (let y0 = 0; y0 < lh; y0 += KEY_BAND_ROWS) {
                const rows = Math.min(KEY_BAND_ROWS, lh - y0);
                const { a } = await rc.rows(mid, map, lw, y0, rows, { fg: false });
                if (gone()) return mbox;
                bands.push({ a, y0, rows });
            }
        } finally {
            rc.drop(mid);
        }
        editor.pushUndo({ kind: "selection", label: `${keying.LABEL} (preview)` });
        editor.selectionLabel = "";
        editor.sel.clear();
        for (const b of bands) editor.sel.combine(bytesSource(b.a, mbox[0], mbox[1] + b.y0, lw, b.rows), "add");
        const touched = old ? [Math.min(old[0], mbox[0]), Math.min(old[1], mbox[1]), Math.max(old[2], mbox[2]), Math.max(old[3], mbox[3])] : mbox;
        editor.markSelectionChanged({ within: mbox }, touched);
        editor.draw();
        return mbox;
    },

    /**
     * The overlay of a matte over its box (the Key dialog's preview, §4.6): the matte tinted, the rest dimmed, as a
     * canvas of the content's size (cached on the matte), drawn in image pixels by the caller.
     */
    keyOverlayCanvas(matte, plan) {
        if (matte._overlay) return matte._overlay;
        const [cx0, cy0, cx1, cy1] = plan.content;
        const cw = cx1 - cx0, ch = cy1 - cy0;
        const a = keying.alphaFloats(matte.alpha);
        const c = document.createElement("canvas");
        c.width = cw; c.height = ch;
        const x = c.getContext("2d");
        const img = x.createImageData(cw, ch);
        const d = img.data, bw = plan.bucket.w;
        for (let y = 0; y < ch; y++) {
            for (let X = 0; X < cw; X++) {
                const v = Math.min(1, Math.max(0, a[(y + cy0) * bw + X + cx0]));
                const o = (y * cw + X) * 4;
                // the matte in a tint at about 50 %, the background dimmed
                d[o] = Math.round(64 * v); d[o + 1] = Math.round(200 * v); d[o + 2] = Math.round(255 * v);
                d[o + 3] = Math.round(255 * (0.5 * v + 0.45 * (1 - v)));
            }
        }
        x.putImageData(img, 0, 0);
        matte._overlay = c;
        return c;
    },

    // ---- Key screen, Route B: your ComfyUI with a CorridorKey 2.0 node pack (docs/PLAN_CORRIDORKEY.md §4.11, B2) ----

    /**
     * The route a key takes: the one asked ("app": in Scumble, "comfyui": your ComfyUI), else in Scumble when its engine
     * is ready, else your ComfyUI when it can key, else in Scumble when its set is offered (its reason is the download),
     * else your ComfyUI (its reason says what it needs). This build has no in-app engine (Stop A), so it is your ComfyUI.
     */
    keyRoute(route = "") {
        if (route === "app" || route === "comfyui") return route;
        const app = this.keySupport();
        if (app.ok) return "app";
        if (this.keyComfySupport().ok) return "comfyui";
        return app.offered ? "app" : "comfyui";
    },

    /** Whether your ComfyUI can key now (keying.serverSupport: connected, an NVIDIA card of the Ampere generation or newer, pack A, Inpaint Canvas). */
    keyComfySupport() {
        const s = this.server || { state: "disconnected", gpus: [] };
        return keying.serverSupport({ state: s.state, gpus: s.gpus, objectInfo: this.objectInfo });
    },

    /** The size a w × h box goes to your ComfyUI at (keying.comfyFit with settings.key.cap); the key gate stands in for it. */
    keyComfyFit(w, h) {
        return keying.comfyFit(w, h, this.keyValues().cap);
    },

    /**
     * Why a key on your ComfyUI would not start on this document now, before anything is read or sent: what the server
     * lacks (serverSupport's reason: plain while not connected, "warn" for what a connected server cannot do), then the
     * document's refusals (keyDocCheck). -> { text, kind } or null
     */
    keyComfyCheck(editor, o = {}) {
        const sup = this.keyComfySupport();
        if (!sup.ok) {
            const st = (this.server && this.server.state) || "disconnected";
            return { text: sup.reason, kind: st === "connected" || st === "missing-node" ? "warn" : "info" };
        }
        return this.keyDocCheck(editor, o);
    },

    /**
     * The box of a key on your ComfyUI and the size it goes at (keying.comfyPlan: the selection's bounds grown by
     * context, a source layer's rect, the whole picture; at its own size up to settings.key.cap, else scaled by one
     * factor). Re-key: the key's record while this session holds it, else the key layer's bounds grown as a selection's
     * (`fromBounds`); `from` names the picture a Re-key reads.
     */
    keyComfyPlan(editor, { source = "picture", layer = null, hint = "selection", rekey = false } = {}) {
        const W = editor.width, H = editor.height;
        const fit = (w, h) => this.keyComfyFit(w, h);
        if (rekey && layer) {
            const r = this.keyRekeyRead(editor, layer);
            const from = r.layer ? `${r.layer.name}${r.layer.visible ? "" : " (hidden)"}` : "the picture under the key";
            const box = this.keyRecordBox(editor, layer);
            if (box) return { ...keying.comfyPlan(W, H, null, { within: box, fit }), rekey: true, fromBounds: false, whole: false, layerBox: false, from };
            return { ...keying.comfyPlan(W, H, [layer.x, layer.y, layer.x + layer.w, layer.y + layer.h], { fit }), rekey: true, fromBounds: true, whole: false, layerBox: false, from };
        }
        const sel = hint === "selection" && editor.getBounds ? editor.getBounds() : null;
        const within = source !== "picture" && layer && !sel ? [layer.x, layer.y, layer.x + layer.w, layer.y + layer.h] : null;
        return { ...keying.comfyPlan(W, H, sel, { within, fit }), rekey: false, fromBounds: false };
    },

    /**
     * An RGBA picture (w × h, opaque) as a PNG in your ComfyUI's input folder (uploadInput), the wait ended by a Cancel and
     * at `endAt` (passPicture's shape: the request runs on and is ignored). -> the uploaded { filename, subfolder, type }
     */
    async keyComfyUpload(rgba, w, h, name, token, endAt) {
        const L = keying.LABEL;
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        let png;
        try {
            c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
            png = await canvasBytes(c);
        } finally {
            c.width = c.height = 0;
        }
        const upload = this.uploadInput(new Blob([png], { type: "image/png" }), name);
        return new Promise((resolve, reject) => {
            const t0 = Date.now();
            let iv = null;
            const done = (fn, v) => { clearInterval(iv); fn(v); };
            iv = setInterval(() => {
                if (token && token.cancelled) done(reject, Object.assign(new Error(keying.TEXTS.cancelled), { kind: "cancelled" }));
                else if (Date.now() > endAt) done(reject, Object.assign(new Error(`${L}: your ComfyUI did not take the picture within ${Math.round((Date.now() - t0) / 1000)} s.`), { kind: "timeout" }));
            }, 250);
            upload.then((v) => done(resolve, v), (err) => done(reject, err));
        });
    },

    /**
     * Your ComfyUI's answer (the pack's `rgba`: 8-bit straight RGBA, I0a and B0) decoded in bands without a canvas
     * (readPng): the alpha as floats and the unmixed colour as RGB at the size that went. An answer of another size, or
     * one without an alpha channel, is refused. -> { alpha: Float32Array, fg: Uint8Array, bw, bh }
     */
    async keyComfyDecode(bytes, w, h) {
        const L = keying.LABEL;
        const alpha = new Float32Array(w * h), fg = new Uint8Array(w * h * 3);
        // (readPng's options are typed from its destructuring defaults, which leave out onRows)
        await readPng(new Blob([bytes], { type: "image/png" }), /** @type {any} */ ({
            onHeader: (hd) => {
                if (hd.width !== w || hd.height !== h) throw refusal(`${L}: your ComfyUI answered ${hd.width} × ${hd.height} for a picture of ${w} × ${h}.`, "error");
                if (hd.colorType === 0 || hd.colorType === 2) throw refusal(`${L}: your ComfyUI answered a picture without a matte (no alpha channel); the node pack's output is not the one Scumble reads.`, "error");
            },
            onRows: (rgba, y0, rows) => {
                const k = 1 / 255;
                for (let i = 0, p = y0 * w, n = rows * w; i < n; i++, p++) {
                    const o = i * 4, q = p * 3;
                    alpha[p] = rgba[o + 3] * k;
                    fg[q] = rgba[o]; fg[q + 1] = rgba[o + 1]; fg[q + 2] = rgba[o + 2];
                }
            },
        }));
        return { alpha, fg, bw: w, bh: h };
    },

    /**
     * Key green / blue screen on your ComfyUI (Route B, §4.11; B2): the box (keyComfyPlan) read as a run reads it (the
     * visible picture with filters skipped, a layer's own pixels on the screen's colour, a Re-key's source or the picture
     * under the key: keyRead), and the hint (keyHint: the selection's coverage, a layer's mask, none) uploaded at the
     * size that goes (its own up to settings.key.cap, else scaled by one factor), keyed by the node pack whose nodes the
     * server lists (keying.keyPrompt; auto_download false always), the answer fetched (comfyPictureRun on ck_out, at the
     * queue's front), decoded in bands (keyComfyDecode) and landed by landKey as the in-app key lands (a scaled matte's
     * alpha refined against the full-resolution picture, I6). Busy like the Realism Pass: the title row's timer and
     * Cancel (its job taken off the server), a closed tab ends it and adds nothing; refused before anything is read or
     * sent (keyComfyCheck). `preview`: the matte into the selection instead. `timeout` (s, settings.key.comfyTimeout) the
     * wait for the server not counting its queue, `deadline` (ms) a hard end (key_screen's own timeout).
     * -> keyScreen's answer plus { route: "comfyui", pack, sent: [w, h], scaled }
     */
    async keyComfy(editor, opts = {}) {
        const L = keying.LABEL, T = keying.TEXTS;
        const say = (text, kind) => { editor.setStatus(text, kind); return refusal(text, kind || "info"); };
        const v = await this.loadKeyValues();
        const o = {
            source: "picture", layer: null, hint: "selection", rekey: false, preview: false,
            screen: v.screen, trust: v.trust, despill: v.despill, grey: v.greyUnderBase,
            keepOnGpu: v.keepOnGpu, evicts: v.evicts, timeout: v.comfyTimeout, deadline: 0, ...opts,
        };
        if (o.rekey) { o.hint = "mask"; o.trust = 0.95; }
        else if (o.hint === "mask" && opts.trust == null) o.trust = 0.95;
        const refused = this.keyComfyCheck(editor, o);
        if (refused) throw say(refused.text, refused.kind);
        const sup = this.keyComfySupport();
        const pack = keying.packById(sup.pack);
        const info = this.objectInfo;
        const token = { provider: "comfyui", label: L, started: Date.now(), editor };
        editor.providerPending = token;
        this._providerRuns.add(token);
        this._keyBusy = editor;
        this.notifyProviderRuns();
        let closed = false;
        const offRemoved = this.on("removed", (e) => { if (e && e.editor === editor) { closed = true; token.cancelled = true; } });
        const gone = () => closed || !this._editors.includes(editor);
        const cancelled = () => Object.assign(new Error(T.cancelled), { hint: T.cancelled, kind: "cancelled", statusKind: "info" });
        const stop = () => { if (token.cancelled) throw cancelled(); };
        const t0 = performance.now();
        const timeoutMs = Math.max(30, Number.isFinite(+o.timeout) ? +o.timeout : 300) * 1000;
        const none = { layer: null, grey: null, hidden: null, box: null, matteBox: null, workingSize: 0, provider: "comfyui", route: "comfyui", pack: pack ? pack.id : null, sent: null, scaled: false, seconds: 0, kept: 0, status: "" };
        let refine = null;
        try {
            const plan = this.keyComfyPlan(editor, o);
            const { w, h } = plan.bucket;
            editor.setStatus(`${L}: reading ${keying.comfyBoxLine(plan)} ...`);
            const r = await this.keyRead(editor, plan, o);
            if (gone()) return none;
            stop();
            const hnt = await this.keyHint(editor, plan, o);
            if (gone()) return none;
            stop();
            const screen = this.keyScreenColour(plan, r, hnt.hint, o.screen);
            if (!screen) throw refusal(T.askScreen, "info");
            // what goes is opaque (the pack keys the colour): a picture with transparent parts goes as its colour, the
            // refine below keeps the picture as it was read (its reads at full resolution are the same picture)
            let sent = r.image;
            for (let i = 3; i < sent.length; i += 4) if (sent[i] !== 255) { sent = sent.slice(); for (let j = 3; j < sent.length; j += 4) sent[j] = 255; break; }
            const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
            const endAt = Math.min(Date.now() + timeoutMs, o.deadline || Infinity);
            const id = editor.node ? editor.node.id : 0;
            editor.setStatus(`${L}: sending ${w} × ${h} to your ComfyUI ...`);
            const refs = { picture: await this.keyComfyUpload(sent, w, h, `n${id}_key_${stamp}.png`, token, endAt) };
            if (hnt.hint) refs.hint = await this.keyComfyUpload(keyGreyRgba(hnt.hint), w, h, `n${id}_keyhint_${stamp}.png`, token, endAt);
            sent = null;
            if (gone()) return none;
            stop();
            const trust = hnt.hint ? hnt.quality : keying.trustOf(o.trust).value;
            const prompt = keying.keyPrompt(pack, refs, { screen, trust, despill: o.despill, keepOnGpu: o.keepOnGpu === true, evicts: o.evicts === true }, info);
            const res = await this.comfyPictureRun(editor, prompt, keying.COMFY_OUTPUT, { label: L, token, timeoutMs, deadline: o.deadline || 0, front: true });
            if (gone()) return none;
            stop();
            editor.setStatus(`${L}: reading the matte (${w} × ${h}) ...`);
            const matte = await this.keyComfyDecode(res.bytes, w, h);
            if (gone()) return none;
            stop();
            const kept = keying.keptShare(matte.alpha, w, plan.content);
            const at = { sent: [w, h], box: [plan.box[2] - plan.box[0], plan.box[3] - plan.box[1]] };
            if (o.preview) {
                const mb = await this.keyIntoSelection(editor, plan, matte, () => gone() || !!token.cancelled);
                if (gone()) return none;
                stop();
                const secs = (performance.now() - t0) / 1000;
                const text = `${L}: the matte is the selection now (${Math.round(kept)} % of the box, ${Math.round(secs * 10) / 10} s on your ComfyUI, ${keying.ENGINE} through ${pack.label}); nothing was added.`;
                editor.setStatus(text, "info");
                return { ...none, box: plan.box.slice(), matteBox: mb, workingSize: Math.max(w, h), sent: at.sent, scaled: plan.scaled, seconds: secs, kept, status: text };
            }
            const record = { box: plan.box.slice(), size: [editor.width, editor.height], bucket: { ...plan.bucket }, screen, despill: o.despill, trust: hnt.quality, hint: o.hint, source: r.source, provider: "comfyui", route: "comfyui", pack: pack.id, hash: r.hash, greyId: null };
            // a box that went smaller than its own size comes back scaled: its alpha refined against the picture (I6)
            refine = plan.scaled && r.read ? { small: r.image, ...this.keyBandReader(editor, r.read) } : null;
            const ref = refine;
            refine = null;   // landKey lets it go
            const landed = await this.landKey(editor, { matte, plan, refine: ref, source: o.rekey ? null : o.source === "picture" ? null : o.layer, rekeyLayer: o.rekey ? o.layer : null, grey: !o.rekey && o.source === "picture" && !!o.grey, record, token, gone });
            if (!landed) return none;
            const secs = (performance.now() - t0) / 1000;
            let text = keying.comfyStatusLine({ kept, seconds: secs, pack, gpu: sup.gpu, screen, hint: hnt.hint ? o.hint : "none", trust: hnt.quality, sent: at.sent, box: at.box, grey: !!landed.grey, hidden: landed.hidden ? landed.hidden.name : "", rekey: o.rekey });
            const rn = landed.refine;
            if (rn && (rn.fallback || rn.error)) {
                text += ` The matte was not refined against the picture: ${rn.fallback || rn.error}.`;
                console.warn(`${L}: the matte was not refined`, rn);
            }
            editor.setStatus(text, "info");
            return { layer: landed.layer, grey: landed.grey, hidden: landed.hidden, box: plan.box.slice(), matteBox: landed.matteBox, workingSize: Math.max(w, h), provider: "comfyui", route: "comfyui", pack: pack.id, sent: at.sent, scaled: plan.scaled, seconds: secs, kept, refine: rn || null, status: text };
        } catch (err) {
            if (refine) refine.done();
            if (gone()) return none;
            const text = err && err.hint ? String(err.hint) : keying.runFailure(err, pack);
            throw say(text, failKind(err));
        } finally {
            offRemoved();
            if (this._keyBusy === editor) this._keyBusy = null;
            this.endRun(editor, token);
        }
    },
};
