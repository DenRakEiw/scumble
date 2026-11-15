// A frame from a video (CLAUDE.md item 68): a video opened with File › Open or dropped on the window shows this
// picker, Chromium's own <video> with a scrubber, play / pause and one-frame steps, and the frame shown becomes a new
// picture, a layer or a reference layer (renderer/shell.js does that through the paths an image takes). No FFmpeg and
// nothing new to download: what Chromium cannot decode (ProRes, many HEVC .mov files) is refused before the picker
// opens, in one plain sentence. The picture is the frame at the video's own size (videoWidth x videoHeight).
//
// The video comes as a URL: a dropped File as a blob: URL (no copy of its bytes), File › Open's choice as
// scumble://app/video/<token>, which main serves with ranges for that one file (electron/main/videofiles.js).

import { panel } from "./dialogs.js";

export const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;

/** Is this File a video the picker takes (by its name, or by its type when the name has no extension)? */
export function isVideoFile(f) {
    if (!f) return false;
    const name = String(f.name || "");
    return VIDEO_EXT.test(name) || (!/\.[a-z0-9]+$/i.test(name) && /^video\//i.test(String(f.type || "")));
}

/** The step when the frame rate is not known yet (a <video> does not say it; playing a few frames measures it). */
export const DEFAULT_STEP = 1 / 30;
const LOAD_MS = 20000;

/** 75.25 -> "1:15.250". */
export function timeText(t) {
    if (!Number.isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s < 10 ? "0" : ""}${s.toFixed(3)}`;
}

const MEDIA_ERRORS = { 1: "the load was stopped", 2: "a read failed", 3: "its picture could not be decoded", 4: "its format or codec is not supported" };

/**
 * A <video> for `url` once its first frame can be drawn. Rejects with one plain sentence when Chromium cannot decode
 * it: an error of the element, no picture track (a video with sound only, or a codec it reads the box of but cannot
 * decode), or nothing within 20 s.
 */
export function loadVideo(url, name = "the video") {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.disablePictureInPicture = true;
    v.setAttribute("disableremoteplayback", "");
    return new Promise((resolve, reject) => {
        let done = false;
        const end = (err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (!err) { findDuration(v).then(() => resolve(v)); return; }
            try { v.removeAttribute("src"); v.load(); } catch (_) { /* gone */ }
            reject(new Error(`${name} cannot be opened: ${err}. Convert it to MP4 (H.264) or WebM first (ProRes and some HEVC files do not play here).`));
        };
        const timer = setTimeout(() => end("it did not load within 20 seconds"), LOAD_MS);
        v.addEventListener("loadeddata", () => {
            if (v.videoWidth > 0 && v.videoHeight > 0) end(null);
            else end("it has no picture this player can show");
        }, { once: true });
        v.addEventListener("error", () => end((v.error && MEDIA_ERRORS[v.error.code]) || "the player refused it"), { once: true });
        v.src = url;
    });
}

/** An event of the element, or the timeout: resolves true for the event, false for the timeout. */
function once(v, type, ms) {
    return new Promise((resolve) => {
        const t = setTimeout(() => { v.removeEventListener(type, on); resolve(false); }, ms);
        function on() { clearTimeout(t); resolve(true); }
        v.addEventListener(type, on, { once: true });
    });
}

/**
 * A video whose file names no length (a recording written as it went, such as a WebM from a browser's recorder) says
 * its duration is Infinity until the player has been to its end: one seek far past it makes the player find the end,
 * then back to the start. Marks the element (data-duration-found) when it had to; a length it still cannot find is
 * left to endOf().
 */
async function findDuration(v) {
    if (Number.isFinite(v.duration)) return;
    v.dataset.durationFound = "searched";
    const changed = once(v, "durationchange", 5000);
    v.currentTime = 1e101;
    await Promise.race([changed, once(v, "seeked", 5000)]);
    if (!Number.isFinite(v.duration)) await once(v, "durationchange", 1000);
    if (Number.isFinite(v.duration)) v.dataset.durationFound = "found";
    const back = once(v, "seeked", 5000);
    v.currentTime = 0;
    await back;
}

/** The video's end in seconds: its duration, else the end of what it can seek to, else null (not known). */
export function endOf(v) {
    if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
    const s = v.seekable;
    if (s && s.length) {
        const e = s.end(s.length - 1);
        if (Number.isFinite(e) && e > 0) return e;
    }
    return null;
}

/** A time clamped to the video: never below 0, and above only where the end is known. */
function clampTime(v, t) {
    const end = endOf(v);
    return Math.max(0, end != null ? Math.min(end, t) : t);
}

/** Resolves once the element shows the frame at its currentTime (no seek pending, a frame decoded), or after 10 s. */
function settled(v) {
    return new Promise((resolve) => {
        if (!v.seeking && v.readyState >= 2) { resolve(); return; }
        const t = setTimeout(done, 10000);
        function done() { clearTimeout(t); v.removeEventListener("seeked", check); v.removeEventListener("loadeddata", check); v.removeEventListener("canplay", check); resolve(); }
        function check() { if (!v.seeking && v.readyState >= 2) done(); }
        v.addEventListener("seeked", check);
        v.addEventListener("loadeddata", check);
        v.addEventListener("canplay", check);
    });
}

/** The frame on screen as a PNG File at the video's own size. */
export async function frameFile(v, name) {
    await settled(v);
    const w = v.videoWidth, h = v.videoHeight;
    if (!(w > 0 && h > 0)) throw new Error("the video shows no frame");
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(v, 0, 0, w, h);
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/png"));
    c.width = c.height = 0;
    if (!blob) throw new Error("the frame could not be encoded");
    const stem = String(name || "video").replace(/\.[a-z0-9]+$/i, "") || "video";
    return new File([blob], `${stem} ${v.currentTime.toFixed(3)}s.png`, { type: "image/png" });
}

const CSS = `
.box.video { max-width: min(820px, calc(100vw - 32px)); width: min(820px, calc(100vw - 32px)); }
.stage { display: flex; align-items: center; justify-content: center; background: #000; border-radius: var(--sc-radius, 3px); min-height: 120px; }
video { display: block; width: 100%; max-height: min(56vh, 520px); object-fit: contain; }
.controls { display: flex; gap: 8px; align-items: center; }
.controls button { min-width: 0; padding: 4px 10px; }
input[type=range] { flex: 1; min-width: 120px; accent-color: var(--sc-active, #4a90d9); }
.time { font-variant-numeric: tabular-nums; color: var(--sc-fg-2, #aaa); white-space: nowrap; }
button:disabled { opacity: .45; cursor: default; }
`;

let current = null;    // the picker on screen (one at a time: a second video closes the first)

/**
 * Show the picker for a loaded <video> (loadVideo). Resolves with { action: "new" | "layer" | "reference", file, time,
 * width, height }, or null when cancelled. `canLayer`: the active document has a picture (Add as layer needs one).
 * `focus`: the action that has the focus and answers Enter. `onClose` runs once the picker is gone (revoke the URL).
 */
export function showPicker(v, { name = "video", canLayer = true, focus = "new", onClose = null } = {}) {
    if (current) current.cancel();
    return new Promise((resolve) => {
        let closed = false;
        let busy = false;
        let shown = null;           // the media time of the frame on screen, from requestVideoFrameCallback
        let last = null;
        let frames = 0;             // requestVideoFrameCallback calls so far (0: none here, a hidden window)
        let learned = 0;            // one frame's length, found by a step that crossed exactly one frame
        let stepping = null;        // the step under way (a promise): presses meanwhile are dropped
        const deltas = [];          // frame-to-frame media times while playing: the frame rate
        const p = panel({ label: `Pick a frame from ${name}`, extraCss: CSS, onCancel: () => finish(null) });
        const { dialog, box } = p;
        box.classList.add("video");
        dialog.dataset.videoFrame = "1";
        const div = (cls, text) => { const n = document.createElement("div"); n.className = cls; if (text) n.textContent = text; return n; };
        const button = (label, title, fn) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = label;
            if (title) b.title = title;
            b.addEventListener("click", fn);
            return b;
        };
        box.appendChild(div("title", "Pick a frame"));
        box.appendChild(div("detail", name));
        const stage = div("stage");
        stage.appendChild(v);
        box.appendChild(stage);
        const back = button("‹ Frame", "One frame back (Left arrow; Shift: one second)", () => step(-1));
        const play = button("Play", "Play or pause (Space)", () => toggle());
        const fwd = button("Frame ›", "One frame forward (Right arrow; Shift: one second)", () => step(1));
        const range = document.createElement("input");
        range.type = "range";
        range.min = "0";
        range.max = String(endOf(v) || 0);
        range.step = "any";
        range.value = "0";
        range.setAttribute("aria-label", "Position in the video");
        range.addEventListener("input", () => { v.pause(); v.currentTime = +range.value; update(); });
        const time = div("time");
        const controls = div("controls");
        controls.append(back, play, fwd, range, time);
        box.appendChild(controls);
        const info = div("detail");
        box.appendChild(info);
        const actions = [
            ["new", "Open as new picture", "The frame as a picture of its own, in a new tab"],
            ["layer", "Add as layer", "The frame as a new layer of the active document"],
            ["reference", "Add as reference", "The frame as a reference layer of the active document"],
        ];
        const row = div("row");
        const btn = {};
        for (const [id, label, title] of actions) {
            const b = button(label, title, () => take(id));
            if (id === "layer" && !canLayer) { b.disabled = true; b.title = "The active document has no picture yet: open the frame as a new picture"; }
            btn[id] = b;
            row.appendChild(b);
        }
        const cancel = button("Cancel", "", () => finish(null));
        row.appendChild(cancel);
        box.appendChild(row);
        const def = btn[focus] && !btn[focus].disabled ? focus : "new";
        btn[def].className = "primary";

        // the frame length: measured while it played, else found by a step, else not known (0)
        const frameLength = () => {
            if (deltas.length >= 3) {
                const s = [...deltas].sort((a, b) => a - b);
                return s[s.length >> 1];
            }
            return learned;
        };
        const frameStep = () => frameLength() || DEFAULT_STEP;
        // the media time of the frame on screen: the frame callback's while it belongs to the element's time now
        const frameTime = () => (shown && Math.abs(shown.at - v.currentTime) < 1e-6 ? shown.media : v.currentTime);
        function update() {
            const end = endOf(v);
            // an end not known yet (a recording without a length): the slider reaches as far as the video has been
            const d = end != null ? end : Math.max(+range.max || 0, v.currentTime);
            if (+range.max !== d) range.max = String(d);
            if (p.root.activeElement !== range || !v.paused) range.value = String(v.currentTime);
            time.textContent = `${timeText(v.currentTime)} / ${end != null ? timeText(end) : "?"}`;
            play.textContent = v.paused ? "Play" : "Pause";
            const len = frameLength();
            const fs = len ? `${Math.round(1 / len)} fps` : frames ? "frame rate not known yet: a step looks for the next frame" : "frame step 1/30 s";
            info.textContent = `${v.videoWidth} × ${v.videoHeight} px · ${fs}`;
        }
        // the frame on screen: where its steps start, and the frame rate while it plays (not in a hidden window: there
        // the steps take 1/30 s and the time shown is the element's)
        const onFrame = (_now, md) => {
            if (closed) return;
            shown = { media: md.mediaTime, at: v.currentTime };
            frames++;
            if (!v.paused && last && md.presentedFrames - last.presentedFrames === 1) {
                const d = md.mediaTime - last.mediaTime;
                if (d > 0.001 && d < 1) { deltas.push(d); if (deltas.length > 15) deltas.shift(); }
            }
            last = md;
            update();
            v.requestVideoFrameCallback(onFrame);
        };
        if (typeof v.requestVideoFrameCallback === "function") v.requestVideoFrameCallback(onFrame);
        const onTime = () => update();
        v.addEventListener("timeupdate", onTime);
        v.addEventListener("seeked", onTime);
        v.addEventListener("pause", onTime);
        v.addEventListener("play", onTime);

        /** Resolves true once a frame callback comes after the count `f0`, false after `ms`. */
        async function frameAfter(f0, ms) {
            for (const until = Date.now() + ms; Date.now() < until;) {
                if (frames > f0) return true;
                await new Promise((r) => setTimeout(r, 10));
            }
            return frames > f0;
        }
        /**
         * n frames on (back with n < 0) from the frame on screen; resolves when the frame is shown. Each seek lands a
         * little past where the frame should start (a float sum just under it must not land on the frame before). With
         * frame callbacks (a shown window) a step checks that the frame changed and seeks on until it did, at most 12
         * times: with the length not known it creeps in 1/60 s, so the first change is the next frame, and that change
         * is the frame length from then on; with a known length a step that stays (a rate that varies) goes on by half a
         * frame. A seek that brings no frame callback counts as the same frame (a frame shown again may bring none);
         * with no frame callback at all (a hidden window) it seeks once, by the known length or 1/30 s.
         */
        function step(n) {
            if (busy || stepping || !n) return stepping || Promise.resolve();
            stepping = (async () => {
                v.pause();
                await settled(v);
                const start = frameTime();
                const len = frameLength();
                const dir = Math.sign(n);
                const eps = 0.002;
                // the time alone: one seek by the known length or 1/30 s (no frame callbacks in this window)
                const blind = async () => {
                    v.currentTime = clampTime(v, start + n * (len || DEFAULT_STEP) + eps);
                    update();
                    await settled(v);
                };
                if (typeof v.requestVideoFrameCallback !== "function") { await blind(); return; }
                const inc = len || 1 / 60;
                let t = start + (len ? n * len : dir * inc);
                for (let i = 0; i < 12; i++) {
                    const target = clampTime(v, t + eps);
                    const f0 = frames;
                    v.currentTime = target;
                    update();
                    await settled(v);
                    const got = await frameAfter(f0, 300);
                    // no callback ever, not even for this seek: a hidden window, where frames are not presented
                    if (!got && !frames) { await blind(); return; }
                    const now = got ? frameTime() : start;
                    if (dir > 0 ? now > start + 1e-4 : now < start - 1e-4) {
                        if (!len && Math.abs(n) === 1) {
                            const d = Math.abs(now - start);
                            if (d > 0.001 && d < 1) learned = d;
                        }
                        break;
                    }
                    const end = endOf(v);
                    if (dir < 0 ? target <= 0 : end != null && target >= end) break;   // the first or the last frame
                    t += dir * (len ? len / 2 : inc);
                }
            })().finally(() => { stepping = null; if (!closed) update(); });
            return stepping;
        }
        function seconds(n) {
            v.pause();
            v.currentTime = clampTime(v, v.currentTime + n);
            update();
        }
        /** The start (Home) or the end (End); an end not known is found by a seek far past it. */
        function jump(toEnd) {
            v.pause();
            const end = endOf(v);
            v.currentTime = !toEnd ? 0 : end != null ? end : 1e101;
            update();
        }
        function toggle() {
            if (busy) return;
            if (v.paused) { if (v.ended) v.currentTime = 0; v.play().catch(() => { /* a play refused: stays paused */ }); } else v.pause();
        }
        async function take(action) {
            if (busy || closed) return;
            if (action === "layer" && !canLayer) return;
            busy = true;
            v.pause();
            for (const b of [...Object.values(btn), cancel, back, play, fwd]) b.disabled = true;
            info.textContent = "Taking the frame ...";
            try {
                const file = await frameFile(v, name);
                finish({ action, file, time: v.currentTime, width: v.videoWidth, height: v.videoHeight });
            } catch (err) {
                busy = false;
                for (const b of [...Object.values(btn), cancel, back, play, fwd]) b.disabled = false;
                if (!canLayer) btn.layer.disabled = true;
                info.textContent = "The frame could not be taken: " + ((err && err.message) || err);
            }
        }
        function finish(result) {
            if (closed) return;
            closed = true;
            if (current === handle) current = null;
            v.removeEventListener("timeupdate", onTime);
            v.removeEventListener("seeked", onTime);
            v.removeEventListener("pause", onTime);
            v.removeEventListener("play", onTime);
            try { v.pause(); v.removeAttribute("src"); v.load(); } catch (_) { /* gone */ }
            p.close();
            try { if (onClose) onClose(); } catch (_) { /* the caller's */ }
            resolve(result);
        }
        // the picker's keys: Space plays, the arrows step, Home / End jump, Enter takes the focused action (or the default
        // one), Escape cancels (the dialog's cancel event); none goes on to the editor
        dialog.addEventListener("keydown", (e) => {
            const k = e.key;
            const onButton = p.root.activeElement && p.root.activeElement.tagName === "BUTTON";
            if (k === "Escape") return;
            e.stopPropagation();
            if (k === " " || k === "Spacebar") { e.preventDefault(); toggle(); return; }
            if (k === "ArrowLeft" || k === "ArrowRight") {
                e.preventDefault();
                const dir = k === "ArrowLeft" ? -1 : 1;
                if (e.shiftKey) seconds(dir); else step(dir);
                return;
            }
            if (k === "Home" || k === "End") { e.preventDefault(); jump(k === "End"); return; }
            if (k === "Enter" && !onButton) { e.preventDefault(); take(def); }
        }, true);
        const handle = { cancel: () => finish(null) };
        current = handle;
        // what the gate drives (tools/videoframe_test.py)
        dialog.__videoFrame = { video: v, step, seconds, jump, seek: (t) => { v.pause(); v.currentTime = t; update(); }, take, cancel: () => finish(null), frameStep, frameLength, frameTime, frames: () => frames, range, info, buttons: btn, settled: () => settled(v) };
        update();
        btn[def].focus();
    });
}
