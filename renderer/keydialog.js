// The Key dialog (item 49, docs/PLAN_CORRIDORKEY.md §4.6, §4.8, session I5): *Image › Key Green / Blue Screen...*.
// A panel of the app's own beside the canvas, not modal: while it is open the person paints the hint with the
// selection brush or the quick mask and the matte follows on the canvas (screen only), then *Key* lands it
// (host.keyScreen). App-only; no editor file changes for any of it:
//
//   a dab        host.pluginPointer calls the session's `pointer` on every move before any brush branch; on a
//                selection-brush stroke (`editor.pointer.kind === "selpaint"`) it reads the hint and queues a run,
//                throttled, and never takes the event
//   a stroke's   host.on("changed") with `editor.selectionSeq` (a selection change) or the key layer's mask version
//   end          (a mask stroke for Re-key, at pointer-up: it lives in a StrokeBuffer until then)
//   the runs     keying.KeyQueue: one in flight, one pending, the newest hint replacing the pending one, tickets; an
//                answer older than the matte shown is dropped
//   the overlay  host.pluginOverlay calls the session's `overlay`: the matte tinted over its box (host.keyOverlayCanvas);
//                drawSoon after each answer (rAF: a hidden window draws nothing, so the gate reads the state)
//
// The box and the features are fixed when the dialog opens (the selection's bounds then, grown, or the whole picture);
// *Refit the box* reads them again, and so does a turn, crop, extend, resize or straighten of the picture (the host's
// "geometry" event); another tab coming to the front closes the panel. Key reads the picture once more and prepares it
// again when it changed under the panel (host.keyScreen). A run the engine answers with FEATURES_GONE (its idle timer,
// freeHelpers before a local ComfyUI run) prepares the kept picture again and runs once more. On the CPU (no live
// preview, §4.8) nothing runs before Key. Escape or Close drops the overlay and the tickets; only the dialog's own close
// starts the engine's idle timer (host.keyEngine.closed), never a restart.
//
// Route B (B3, §4.11), the row *Full resolution on your ComfyUI* (the only route of this build, which has no in-app
// engine): no live loop there. No KeySession is made, so nothing is prepared, no dab or stroke's end runs anything and
// no overlay is drawn; the Preview row is hidden. The box line follows the selection (host "changed"), the readiness
// line the server (host "realism"), and Key / Re-key runs host.keyScreen once with route "comfyui" and the rows as they
// are. Its own rows: keep the model on the GPU (pack A) or unload other models (pack B), the wait for the server, and
// the first-run block (the models fetched once onto that machine, never by Scumble).

import { host } from "./editor/host.js";
import * as keying from "./editor/keying.js";

/** The least time between two dab-driven runs (ms); the queue coalesces whatever comes faster anyway. */
const DAB_MS = 40;

let current = null;
/** A key on your ComfyUI landed from the dialog this session: its first-run block stays folded from then on. */
let comfyKeyed = false;
/** Where the panel was dragged to this session ({ left, top } in CSS px), or null: its spot top right (KeyDialog.movable). */
let keyDialogPos = null;
/** The least gap a dragged panel keeps to the window's edges (px). */
const EDGE = 8;

/** The open Key dialog, or null (tests, the menu's second click). */
export function currentKeyDialog() {
    return current;
}

/**
 * The live loop of one open dialog on one document: the plan and the prepared picture, the queue, the matte shown.
 * `opts`: { source: "picture" | layer id, layerId, hint: "selection" | "mask" | "none", trust, despill, screen,
 * preview, rekey }.
 */
export class KeySession {
    constructor(editor, opts) {
        this.editor = editor;
        this.opts = { ...opts };
        this.plan = null;
        this.prep = null;
        this.matte = null;          // the newest answer shown: { alpha, fg, ticket, sig, screen, despill, quality, key, ms, roundMs, provider }
        this.shown = 0;             // its ticket
        this.staleDropped = 0;      // answers older than the one shown (tests)
        this.reprepared = 0;        // features the engine no longer held, prepared again (tests)
        this.finalPending = false;  // Key's final run is queued or running: no preview is asked meanwhile
        this.queue = new keying.KeyQueue(async (req) => {
            const t = performance.now();
            let res, key = req.key;
            try { res = await host.keyEngine.run(req); } catch (err) {
                if (this.closed || !keying.isFeaturesGone(err)) throw err;
                const prep = await this.reprepare();
                key = prep.key;
                res = await host.keyEngine.run({ ...req, key });
            }
            return { ...(res || {}), key, roundMs: performance.now() - t };
        });
        this.selSeq = editor.selectionSeq;
        this.maskVer = null;
        this.wanted = false;
        this.reading = null;
        this.lastDab = 0;
        this.closed = false;
        this.error = "";
        this.requests = 0;          // hint reads started (tests)
        this.onUpdate = null;       // the dialog's redraw
        this._off = [
            host.on("changed", (e) => { if (e && e.editor === this.editor) this.onChanged(); }),
        ];
    }

    /** The options keyPlan / keyPrepare take, from the session's. */
    prepOpts() {
        return { source: this.opts.source, layer: this.layer(), hint: this.opts.hint, rekey: !!this.opts.rekey, screen: this.opts.screen };
    }

    /** The key layer of a Re-key, or the source layer, or null. */
    layer() {
        const id = this.opts.layerId;
        return id ? this.editor.layers.find((l) => l.id === id) || null : null;
    }

    hintOpts() {
        return { hint: this.opts.hint, trust: this.opts.trust, layer: this.layer() };
    }

    /** Plan the box and prepare the picture in the engine (once per box), then the first preview. */
    async prepare() {
        const ed = this.editor;
        const o = this.prepOpts();
        const lay = o.layer;
        this.plan = host.keyPlan(ed, o);
        this.prep = null;
        this.matte = null;
        this.shown = 0;
        this.error = "";
        this.update();
        const plan = this.plan;
        try {
            const prep = await host.keyPrepare(ed, plan, o);
            if (this.closed || this.plan !== plan) return;
            this.prep = prep;
        } catch (err) {
            if (this.plan === plan) this.error = String((err && err.message) || err);
            this.update();
            return;
        }
        this.selSeq = ed.selectionSeq;
        this.maskVer = lay && lay.maskPx ? lay.maskPx.version : null;
        this.update();
        if (this.opts.preview) this.request("open");
    }

    /** A stroke's end or any other change of the document: a run when the hint changed. */
    onChanged() {
        if (this.closed || !this.prep) return;
        const ed = this.editor;
        if (this.opts.hint === "selection" && ed.selectionSeq !== this.selSeq) {
            this.selSeq = ed.selectionSeq;
            this.request("selection");
        } else if (this.opts.hint === "mask") {
            const l = this.layer();
            const v = l && l.maskPx ? l.maskPx.version : null;
            if (v !== this.maskVer) { this.maskVer = v; this.request("mask"); }
        }
    }

    /** host.pluginPointer: a dab of the selection brush or the quick mask queues a run (throttled); never takes it. */
    pointer(phase) {
        if (this.closed || !this.prep || !this.opts.preview || this.opts.hint !== "selection") return false;
        const p = this.editor.pointer;
        if (phase !== "move" || !p || p.kind !== "selpaint") return false;
        const now = performance.now();
        if (now - this.lastDab < DAB_MS) return false;
        this.lastDab = now;
        this.request("dab");
        return false;
    }

    /** Ask for a run with the hint as it is now; reads run one at a time, the queue keeps the newest. */
    request(why = "") {
        if (this.closed || !this.prep || !this.opts.preview || this.finalPending) return;
        this.wanted = why || true;
        if (this.reading) return;
        this.reading = this._loop().finally(() => { this.reading = null; });
    }

    async _loop() {
        while (this.wanted && !this.closed && this.prep && !this.finalPending) {
            this.wanted = false;
            const plan = this.plan, prep = this.prep;
            this.requests++;
            let h;
            try { h = await host.keyHint(this.editor, plan, this.hintOpts()); } catch (err) { this.error = String((err && err.message) || err); this.update(); continue; }
            // Key's final run took the slot while the hint was read: this preview goes nowhere
            if (this.closed || this.plan !== plan || this.finalPending) return;
            const screen = host.keyScreenColour(plan, prep, h.hint, this.opts.screen);
            if (!screen) { this.error = keying.TEXTS.askScreen; this.update(); continue; }
            const despill = this.opts.despill;
            this.queue.submit({ key: this.prep.key, hint: h.hint, quality: h.quality, despill, screen })
                .then((res) => { if (this.plan === plan) this.accept({ ...res, sig: h.sig, screen, despill, quality: h.quality }); })
                .catch((err) => { if (!this.closed) { this.error = String((err && err.message) || err); this.update(); } });
        }
    }

    /** An answer: shown when it is newer than the matte shown; an older one (or a dropped request) is not. */
    accept(res) {
        if (this.closed || !res || res.dropped) return false;
        if (!(res.ticket > this.shown)) { this.staleDropped++; return false; }
        this.shown = res.ticket;
        this.error = "";
        this.matte = {
            alpha: res.alpha, fg: res.fg, ticket: res.ticket, sig: res.sig, screen: res.screen, despill: res.despill, quality: res.quality,
            key: res.key || (this.prep && this.prep.key) || null, ms: res.ms || 0, roundMs: res.roundMs || 0, provider: res.provider || null,
        };
        this.editor.drawSoon();
        this.update();
        return true;
    }

    /** The matte shown no longer stands for the rows (a value changed with Preview off): Key runs once more. */
    dropMatte() {
        if (!this.matte) return;
        this.matte = null;
        try { this.editor.drawSoon(); } catch (_) { /* the tab went */ }
        this.update();
    }

    /**
     * host.keyScreen's question: the matte shown, when it is the newest asked for, nothing is being read or waits, and
     * it is still the picture, the hint (its sig and trust), the screen and the despill the Key would send (Key then
     * lands what the overlay shows), else null.
     */
    currentMatte(sig, screen, despill, quality) {
        const m = this.matte;
        const st = this.queue.state;
        if (!m || this.reading || this.wanted || this.finalPending || st.flying || st.pending || m.ticket !== this.queue.ticket) return null;
        if (m.sig !== sig || m.screen !== screen || m.despill !== despill || m.quality !== quality) return null;
        if (this.prep && m.key && m.key !== this.prep.key) return null;
        return m;
    }

    /** host.keyScreen's final run through the same queue, pinned: the waiting preview is dropped, none replaces it. */
    async final({ hint, screen, despill }) {
        this.finalPending = true;
        try {
            this.queue.cancelPending();
            const res = await this.queue.submit({ key: this.prep.key, hint: hint.hint, quality: hint.quality, despill, screen }, { pinned: true });
            if (!res || res.dropped) throw new Error("the final key was replaced");
            this.accept({ ...res, sig: hint.sig, screen, despill, quality: hint.quality });
            return res;
        } finally {
            this.finalPending = false;
        }
    }

    /** A picture prepared anew by host.keyScreen (it changed under the panel): the features and the matte are its. */
    adopt(prep) {
        this.prep = prep;
        this.matte = null;
        this.update();
    }

    /** The engine no longer holds the features: the kept picture sent again, or (nothing kept) read and prepared. */
    async reprepare() {
        const prep = await host.keyReprepare(this.editor, this.plan, this.prep, this.prepOpts());
        this.prep = prep;
        this.reprepared++;
        return prep;
    }

    /** host.pluginOverlay: the matte over its box in image pixels (the view transform is applied). */
    overlay(ctx) {
        if (this.closed || !this.opts.preview || !this.matte || !this.plan) return;
        const c = host.keyOverlayCanvas(this.matte, this.plan);
        const [x0, y0, x1, y1] = this.plan.box;
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(c, x0, y0, x1 - x0, y1 - y0);
    }

    /** What the gate reads (never a frame: drawSoon is rAF-based and a gate's window is hidden). */
    state() {
        return {
            box: this.plan ? this.plan.box.slice() : null, bucket: this.plan ? { ...this.plan.bucket } : null, prepared: !!this.prep,
            ticket: this.matte ? this.matte.ticket : 0, queue: this.queue.state, runs: this.queue.runs, dropped: this.queue.dropped,
            staleDropped: this.staleDropped, requests: this.requests, roundMs: this.matte ? Math.round(this.matte.roundMs) : null,
            modelMs: this.matte ? Math.round(this.matte.ms) : null, error: this.error, reprepared: this.reprepared, preview: !!this.opts.preview,
        };
    }

    update() {
        if (this.onUpdate) { try { this.onUpdate(); } catch (err) { console.warn("key dialog", err); } }
    }

    /** The session's end (the dialog's close, or a restart: a new box, another source); the engine stays warm. */
    close() {
        if (this.closed) return;
        this.closed = true;
        this.queue.cancelPending({ force: true });
        for (const off of this._off) off();
        this._off = [];
        this.matte = null;
        if (host.keySession === this) host.keySession = null;
        try { this.editor.drawSoon(); } catch (_) { /* the tab went */ }
    }
}

/** Settings opened at its Helpers section (as the menu's Settings entries scroll to theirs). */
function openHelpersSettings() {
    const sh = host.shell;
    if (!sh || typeof sh.openSettings !== "function") return;
    Promise.resolve(sh.openSettings()).then(() => {
        const h = Array.from(document.querySelectorAll("#shell-settings h3")).find((x) => /^Helpers\b/.test(x.textContent || ""));
        if (h) h.scrollIntoView();
    }).catch((err) => console.warn("settings", err));
}

// ---- the panel --------------------------------------------------------------------------------------------------------

const CSS = `
:host { all: initial; }
.box {
    position: fixed; right: 24px; top: 96px; z-index: 2147483000; box-sizing: border-box; width: 360px;
    max-height: calc(100vh - 120px); overflow: hidden; display: flex; flex-direction: column; gap: 8px; padding: 14px;
    background: var(--sc-surface, #242424); color: var(--sc-fg, #ddd); border: 1px solid var(--sc-border, #4a4a4a);
    border-radius: var(--sc-radius-lg, 10px); box-shadow: var(--sc-shadow, 0 12px 40px rgba(0,0,0,.6));
    font: 13px/1.45 var(--sc-font, system-ui, sans-serif); color-scheme: var(--sc-scheme, normal);
}
.title { font-weight: 600; font-size: 14px; color: var(--sc-fg-strong, #eee); }
.head { flex: none; display: flex; align-items: center; gap: 8px; margin: -6px -6px 0 0; cursor: move; user-select: none; touch-action: none; }
.body { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; margin: -3px -4px; padding: 3px 4px; }
.head .title { flex: 1; min-width: 0; }
button.x { flex: none; width: 26px; height: 26px; padding: 0; border: 0; background: transparent; color: var(--sc-fg-2, #aaa); font-size: 18px; line-height: 1; cursor: pointer; }
button.x:hover { background: var(--sc-btn-hover, #3a3a3a); color: var(--sc-fg-strong, #eee); }
.line { color: var(--sc-fg-2, #aaa); overflow-wrap: anywhere; }
.line.warn, .line.error { color: var(--sc-error, #e0533d); }
.row { display: flex; align-items: center; gap: 8px; }
.row > label:first-child { width: 72px; flex: none; color: var(--sc-fg-2, #aaa); }
.row select, .row input[type=range] { flex: 1; min-width: 0; }
select, input[type=number] { font: inherit; color: var(--sc-fg, #ddd); background: var(--sc-btn, #2d2d2d); border: 1px solid var(--sc-border, #555); border-radius: var(--sc-radius, 3px); padding: 2px 4px; }
input[type=number] { width: 72px; flex: none; }
.buttons { flex: none; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 4px; }
button { font: inherit; color: var(--sc-fg, #ddd); background: var(--sc-btn, #2d2d2d); border: 1px solid var(--sc-border, #555); border-radius: var(--sc-radius, 3px); padding: 5px 12px; cursor: pointer; }
button:hover { background: var(--sc-btn-hover, #3a3a3a); }
button.primary { background: var(--sc-go, #2f6b3f); color: var(--sc-on-active, #fff); border-color: transparent; }
button:disabled { opacity: .5; cursor: default; }
.terms { color: var(--sc-fg-2, #aaa); font-size: 12px; border-top: 1px solid var(--sc-border, #4a4a4a); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.terms a { color: var(--sc-link, #8ab4f8); cursor: pointer; margin-right: 12px; }
[hidden] { display: none !important; }
`;

/**
 * Open the Key dialog on `editor` (the menu's *Key Green / Blue Screen...*). A second open while one is up brings
 * it to the active document. -> the dialog
 */
export async function openKeyDialog(editor) {
    if (!editor) return null;
    if (current && current.editor === editor && !current.closed) { current.focus(); return current; }
    if (current) current.close();
    const d = new KeyDialog(editor);
    current = d;
    await d.open();
    return d;
}

class KeyDialog {
    constructor(editor) {
        this.editor = editor;
        this.closed = false;
        this.session = null;
        this.busy = false;
        this.els = {};
        this.root = null;
        this.hostEl = null;
        this._off = [];
        this.geometryRestarts = 0;  // tests
    }

    /** The CPU runs the set: no live preview (§4.4, §4.8); Key runs once. */
    cpu() {
        return !!host.keySupport().cpu;
    }

    async open() {
        const ed = this.editor;
        const v = await host.loadKeyValues();
        const active = ed.layers.find((l) => l.id === ed.activeLayerId) || null;
        const rekeyable = host.isKeyLayer(active);
        this.values = {
            screen: v.screen, despill: v.despill, preview: v.preview, grey: v.greyUnderBase,
            trust: ed.selectionLabel ? 0.75 : v.trust,
            hint: rekeyable ? "mask" : "selection",
            source: "picture",
            layerId: rekeyable ? active.id : null,
            activeId: active ? active.id : null,
            route: host.keyRoute(),
            keepOnGpu: v.keepOnGpu, evicts: v.evicts, comfyTimeout: v.comfyTimeout,
        };
        this.comfyPlan = null;
        this.comfyError = "";
        this.comfyMissing = false;
        this.build(active, rekeyable);
        this._off.push(
            host.on("removed", (e) => { if (e && e.editor === ed) this.close(); }),
            // the picture turned, cropped, extended, resized or straightened: the box and the features are another
            // picture's; the box is planned and the picture prepared again
            host.on("geometry", (e) => { if (e && e.editor === ed && !this.closed) { this.geometryRestarts++; this.restart(); } }),
            // another tab in front: the panel belongs to this document, it closes (its strokes would go to the other one)
            host.on("activate", (e) => { if (e && e.editor && e.editor !== ed) this.close(); }),
            // your ComfyUI's route: the box line follows the selection, the readiness line the server
            host.on("changed", (e) => { if (e && e.editor === ed && !this.closed && this.values.route === "comfyui") { this.replan(); this.sync(); } }),
            host.on("realism", () => { if (!this.closed && this.values.route === "comfyui") this.sync(); }),
        );
        this.sync();
        this.placeSaved();
        this.restart();
    }

    build(active, rekeyable) {
        const el = document.createElement("div");
        el.className = "sc-keydialog";
        // a key from inside the panel reaches the window's capture handlers with this host as its target (the shadow root
        // retargets it), never a field: the marker tells the editor's and the shell's handlers to leave it to the panel
        // (Escape closes it, Tab moves the focus, digits go into the Wait field), as they do for an open <dialog>
        el.setAttribute("data-own-keys", "");
        const root = el.attachShadow({ mode: "open" });
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
        const panel = document.createElement("div");
        panel.className = "box";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "Key green / blue screen");
        const E = this.els;
        const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
        const row = (label, ...kids) => { const r = node("div", "row"); r.appendChild(node("label", "", label)); for (const k of kids) r.appendChild(k); box.appendChild(r); return r; };
        const select = (opts, value) => {
            const s = document.createElement("select");
            for (const [val, text, disabled] of opts) { const o = document.createElement("option"); o.value = String(val); o.textContent = text; if (disabled) o.disabled = true; s.appendChild(o); }
            s.value = String(value);
            return s;
        };
        // the title row: the handle the panel is dragged by, and its × (Close, as the button below and Escape)
        E.head = panel.appendChild(node("div", "head"));
        E.head.title = "Drag to move; double-click to put it back top right";
        E.head.appendChild(node("div", "title", "Key green / blue screen"));
        E.x = E.head.appendChild(node("button", "x", "\u00d7"));
        E.x.type = "button";
        E.x.title = "Close (Esc)";
        E.x.setAttribute("aria-label", "Close");
        // the rows: they scroll when the panel is short, the title row above and the buttons below stay in view
        const box = panel.appendChild(node("div", "body"));
        // the route: in Scumble only once its engine is offered (not in this build), your ComfyUI always
        const app = host.keySupport();
        const routes = [];
        if (app.ok || app.offered) routes.push(["app", keying.APP_ROUTE_LABEL]);
        routes.push(["comfyui", keying.ROUTE_LABEL]);
        if (!routes.some(([r]) => r === this.values.route)) this.values.route = "comfyui";
        E.route = select(routes, this.values.route);
        E.route.disabled = routes.length < 2;
        E.routeRow = row("Route", E.route);
        E.ready = box.appendChild(node("div", "line"));
        E.boxLine = box.appendChild(node("div", "line"));
        E.screen = select([["auto", "Auto"], ["green", "Green"], ["blue", "Blue"]], this.values.screen);
        E.screenRow = row("Screen", E.screen);
        const hints = [["selection", "From the selection"], ["none", "None (the model decides)"]];
        if (rekeyable) hints.unshift(["mask", "This layer's mask (Re-key)"]);
        E.hint = select(hints, this.values.hint);
        E.hintRow = row("Hint", E.hint);
        E.trust = select(keying.TRUSTS.map((t) => [t.value, `${t.label} (${t.value})`]), keying.trustOf(this.values.trust).value);
        E.trustRow = row("Trust", E.trust);
        E.despill = document.createElement("input");
        E.despill.type = "range"; E.despill.min = "0"; E.despill.max = "1"; E.despill.step = "0.05"; E.despill.value = String(this.values.despill);
        E.despillVal = node("span", "", String(this.values.despill));
        E.despillRow = row("Despill", E.despill, E.despillVal);
        const srcRefusal = active && !rekeyable ? host.keySourceRefusal(this.editor, active) : "x";
        const sources = [["picture", "The visible picture"]];
        if (active && !rekeyable) sources.push([active.id, `Active layer: ${active.name}`, !!srcRefusal]);
        E.source = select(sources, "picture");
        E.sourceRow = row("Source", E.source);
        E.sourceNote = box.appendChild(node("div", "line", active && !rekeyable && srcRefusal ? srcRefusal : ""));
        E.leave = document.createElement("input");
        E.leave.type = "checkbox";
        E.leave.checked = !this.values.grey;
        const leaveLabel = node("label", "", "Leave the base as it is (no grey layer under the key)");
        E.leaveRow = row("", E.leave, leaveLabel);
        E.preview = document.createElement("input");
        E.preview.type = "checkbox";
        E.preview.checked = !!this.values.preview;
        E.previewRow = row("Preview", E.preview, node("span", "line", "the matte over the canvas, screen only"));
        E.loop = box.appendChild(node("div", "line"));
        // your ComfyUI's own rows (§4.11): pack A's keep_on_gpu, pack B's unload_other_models, the wait for the server
        E.keep = document.createElement("input");
        E.keep.type = "checkbox";
        E.keep.checked = !!this.values.keepOnGpu;
        const keepLabel = node("label", "", "Keep the model on the GPU between keys");
        keepLabel.title = keying.KEEP_GPU_NOTE;
        E.keepRow = row("", E.keep, keepLabel);
        E.keepNote = box.appendChild(node("div", "line", keying.KEEP_GPU_NOTE));
        E.evicts = document.createElement("input");
        E.evicts.type = "checkbox";
        E.evicts.checked = !!this.values.evicts;
        E.evictsRow = row("", E.evicts, node("label", "", "Let the pack unload the other models first"));
        E.timeout = document.createElement("input");
        E.timeout.type = "number"; E.timeout.min = "30"; E.timeout.max = "3600"; E.timeout.step = "10";
        E.timeout.value = String(this.values.comfyTimeout);
        E.timeoutRow = row("Wait", E.timeout, node("span", "line", "s for your ComfyUI (its queue not counted)"));
        // the first-run block on your ComfyUI: the models are fetched once onto that machine, never by Scumble
        E.comfyFirst = box.appendChild(node("div", "terms"));
        E.comfyFirstText = E.comfyFirst.appendChild(node("div", ""));
        // §3.3's licence paragraph in Route B's words (the pack downloads the parts from their publishers there)
        E.comfyTerms = E.comfyFirst.appendChild(node("div", "", keying.termsParagraph({ comfy: true })));
        const packLinks = E.comfyFirst.appendChild(node("div", ""));
        const packLink = (text, url) => {
            const a = packLinks.appendChild(node("a", "", text));
            a.href = "#";
            a.addEventListener("click", (e) => { e.preventDefault(); try { window.scumble.openExternal(url()); } catch (err) { console.warn(err); } });
            return a;
        };
        E.packLink = packLink("The node pack's page", () => (keying.packById(host.keyComfySupport().pack) || keying.PACKS[0]).url);
        E.comfyLicence = packLink("The licence", () => keying.LICENCE_URL);
        E.comfyCorridor = packLink("corridorkey.com", () => keying.CORRIDOR_URL);
        // the first-run block (§1 "The first time", §3.3): what the set is, its parts and licences, the seat clause, and
        // the download (I2's terms dialog through keyEngine.download once it exists; Settings › Helpers meanwhile)
        E.terms = box.appendChild(node("div", "terms"));
        E.termsText = E.terms.appendChild(node("div", ""));
        const links = E.terms.appendChild(node("div", ""));
        const link = (text, url) => {
            const a = links.appendChild(node("a", "", text));
            a.href = "#";
            a.addEventListener("click", (e) => { e.preventDefault(); try { window.scumble.openExternal(url); } catch (err) { console.warn(err); } });
            return a;
        };
        link("The licence", keying.LICENCE_URL);
        link("corridorkey.com", keying.CORRIDOR_URL);
        const buttons = node("div", "buttons");
        E.refit = buttons.appendChild(node("button", "", "Refit the box"));
        E.download = buttons.appendChild(node("button", "", "Download..."));
        E.settings = buttons.appendChild(node("button", "", "Settings › Helpers"));
        E.key = buttons.appendChild(node("button", "primary", rekeyable ? "Re-key" : "Key"));
        E.close = buttons.appendChild(node("button", "", "Close"));
        for (const b of [E.refit, E.download, E.settings, E.key, E.close]) b.type = "button";
        panel.appendChild(buttons);
        root.appendChild(panel);
        this.root = root;
        this.hostEl = el;
        document.body.appendChild(el);

        const save = (patch) => { host.setKeyValues(patch).catch(() => { /* logged there */ }); };
        E.screen.addEventListener("change", () => {
            this.values.screen = E.screen.value;
            save({ screen: this.values.screen });
            // a layer is read on the screen's colour where it is transparent: another screen is another picture
            const s = this.session;
            if (s && s.prep && s.prep.weight) this.restart(); else { this.sessionOpts(); this.rerun(); }
        });
        E.hint.addEventListener("change", () => {
            const was = this.values.hint;
            this.values.hint = E.hint.value;
            // Re-key reads another picture (under the key layer) at another box: a new plan
            if ((was === "mask") !== (this.values.hint === "mask")) this.restart(); else { this.sessionOpts(); this.rerun(); }
            this.sync();
        });
        E.trust.addEventListener("change", () => { this.values.trust = +E.trust.value; save({ trust: this.values.trust }); this.sessionOpts(); this.rerun(); });
        E.despill.addEventListener("input", () => { this.values.despill = +E.despill.value; E.despillVal.textContent = E.despill.value; });
        E.despill.addEventListener("change", () => { save({ despill: this.values.despill }); this.sessionOpts(); this.rerun(); });
        E.source.addEventListener("change", () => { this.values.source = E.source.value; this.restart(); this.sync(); });
        E.leave.addEventListener("change", () => { this.values.grey = !E.leave.checked; save({ greyUnderBase: this.values.grey }); });
        E.preview.addEventListener("change", () => {
            this.values.preview = E.preview.checked;
            save({ preview: this.values.preview });
            this.sessionOpts();
            if (this.values.preview) this.rerun(); else this.editor.drawSoon();
        });
        E.route.addEventListener("change", () => { this.values.route = E.route.value; this.comfyError = ""; this.restart(); this.sync(); });
        E.keep.addEventListener("change", () => { this.values.keepOnGpu = E.keep.checked; save({ keepOnGpu: this.values.keepOnGpu }); this.sync(); });
        E.evicts.addEventListener("change", () => { this.values.evicts = E.evicts.checked; save({ evicts: this.values.evicts }); });
        E.timeout.addEventListener("change", () => {
            const n = Math.round(+E.timeout.value);
            this.values.comfyTimeout = Number.isFinite(n) ? Math.min(3600, Math.max(30, n)) : this.values.comfyTimeout;
            E.timeout.value = String(this.values.comfyTimeout);
            save({ comfyTimeout: this.values.comfyTimeout });
        });
        E.refit.addEventListener("click", () => this.restart());
        E.download.addEventListener("click", () => {
            const dl = host.keyEngine && host.keyEngine.download;
            if (typeof dl === "function") Promise.resolve(dl.call(host.keyEngine)).then(() => this.sync(), (err) => console.warn("the key set's download", err));
            else openHelpersSettings();
        });
        E.settings.addEventListener("click", () => openHelpersSettings());
        E.key.addEventListener("click", () => { this.apply().catch(() => { /* the status line says it */ }); });
        E.close.addEventListener("click", () => this.close());
        E.x.addEventListener("click", () => this.close());
        panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(); } });
        this.box = panel;
        this.movable(panel, E.head, box);
    }

    /**
     * The panel moves by its title row: a drag keeps it inside the window (EDGE px from each side), a double click puts
     * it back top right. Where it was left holds for the session (keyDialogPos: the next open comes up there, placed by
     * open() once sync() has set the rows, so the clamp sees the panel's real height), and a window made smaller pulls
     * it back in without forgetting the place. Its height is capped from its top, so it never reaches past the window.
     */
    movable(box, head, body) {
        const place = (left, top) => {
            const r = box.getBoundingClientRect();
            // the panel's own height (its rows in full), not what the cap left of it: clamped by the capped height, a
            // tall panel could never move down again. A panel that fits stays whole; a taller one keeps at least the
            // height it has at its spot top right, and its rows scroll under the cap set below.
            const natural = r.height - body.clientHeight + body.scrollHeight;
            const need = Math.min(natural, Math.max(160, window.innerHeight - 120));
            const l = Math.round(Math.max(EDGE, Math.min(left, window.innerWidth - r.width - EDGE)));
            const t = Math.round(Math.max(EDGE, Math.min(top, window.innerHeight - need - EDGE)));
            box.style.right = "auto";
            box.style.left = `${l}px`;
            box.style.top = `${t}px`;
            box.style.maxHeight = `calc(100vh - ${t + EDGE}px)`;
            return { left: l, top: t };
        };
        const onButton = (e) => !!(e.target && e.target.closest && e.target.closest("button"));
        let drag = null;
        head.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || onButton(e)) return;
            e.preventDefault();
            e.stopPropagation();
            const r = box.getBoundingClientRect();
            drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
            try { head.setPointerCapture(e.pointerId); } catch (_) { /* a pointer the browser does not know (a scripted event) */ }
        });
        head.addEventListener("pointermove", (e) => {
            if (!drag || e.pointerId !== drag.id || this.closed) return;
            keyDialogPos = place(e.clientX - drag.dx, e.clientY - drag.dy);
        });
        const end = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
        for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) head.addEventListener(type, end);
        head.addEventListener("dblclick", (e) => {
            if (onButton(e)) return;
            keyDialogPos = null;
            for (const k of ["left", "top", "right", "maxHeight"]) box.style[k] = "";
        });
        this.placeSaved = () => { if (!this.closed && keyDialogPos) place(keyDialogPos.left, keyDialogPos.top); };
        window.addEventListener("resize", this.placeSaved);
        this._off.push(() => window.removeEventListener("resize", this.placeSaved));
    }

    /** The options a run and a landing take, from the rows. */
    keyOpts() {
        const v = this.values;
        const rekey = v.hint === "mask";
        const layer = rekey ? this.editor.layers.find((l) => l.id === v.layerId) || null
            : v.source !== "picture" ? this.editor.layers.find((l) => l.id === v.source) || null : null;
        const comfy = v.route === "comfyui";
        return {
            route: comfy ? "comfyui" : "app", source: rekey || v.source === "picture" ? "picture" : v.source, layer, layerId: layer ? layer.id : null,
            hint: v.hint, trust: rekey ? 0.95 : v.trust, despill: v.despill, screen: v.screen, preview: !comfy && !!v.preview && !this.cpu(), rekey, grey: v.grey,
            keepOnGpu: !!v.keepOnGpu, evicts: !!v.evicts, timeout: v.comfyTimeout,
        };
    }

    sessionOpts() {
        if (this.session) Object.assign(this.session.opts, this.keyOpts());
    }

    /** A new box and picture (open, Refit the box, another source, Re-key on or off). */
    restart() {
        if (this.closed) return;
        if (this.session) this.session.close();
        this.session = null;
        this.comfyPlan = null;
        // your ComfyUI: no live loop (no session, nothing prepared), only the box the Key would send
        if (this.values.route === "comfyui") { this.replan(); this.sync(); return; }
        if (!host.keySupport().ok) { this.sync(); return; }
        const s = new KeySession(this.editor, this.keyOpts());
        s.onUpdate = () => this.sync();
        this.session = s;
        host.keySession = s;
        s.prepare().catch((err) => console.warn("key prepare", err));
    }

    /** Your ComfyUI's route: the box the Key would send now (host.keyComfyPlan), for the box line. */
    replan() {
        try { this.comfyPlan = this.editor.base && this.editor.width ? host.keyComfyPlan(this.editor, this.keyOpts()) : null; } catch (err) { this.comfyPlan = null; console.warn("key plan", err); }
    }

    /** Another value of a row: the same box and features, a new run (with Preview off: the matte shown is dropped). */
    rerun() {
        if (this.values.route === "comfyui") { this.replan(); this.sync(); return; }
        const s = this.session;
        if (!s) return;
        if (!s.opts.preview) { s.dropMatte(); return; }
        if (s.prep) s.request("values");
    }

    /** Key (or Re-key): host.keyScreen with the session, then the dialog closes. */
    async apply() {
        if (this.busy || this.closed) return null;
        this.busy = true;
        this.sync();
        const comfy = this.values.route === "comfyui";
        this.comfyError = "";
        try {
            const o = this.keyOpts();
            const out = await host.keyScreen(this.editor, { ...o, preview: false, session: !comfy && this.session && this.session.prep ? this.session : null });
            if (out && out.layer) {
                if (comfy) { comfyKeyed = true; this.comfyMissing = false; }
                this.close();
            }
            return out;
        } catch (err) {
            const msg = String((err && err.message) || err);
            if (comfy) {
                this.comfyError = msg;
                if (msg.includes(keying.MISSING_TEXT)) this.comfyMissing = true;
            } else if (this.els.loop) { this.els.loop.textContent = msg; this.els.loop.className = "line warn"; }
            throw err;
        } finally {
            this.busy = false;
            if (!this.closed) this.sync();
        }
    }

    /** The rows and lines from the state. */
    sync() {
        if (this.closed) return;
        const E = this.els, v = this.values;
        if (v.route === "comfyui") { this.syncComfy(); return; }
        for (const r of [E.keepRow, E.keepNote, E.evictsRow, E.timeoutRow, E.comfyFirst]) r.hidden = true;
        const sup = host.keySupport();
        // the dormant case (§4.3): no in-app rows while the set is not offered (or this build has no engine)
        const dormant = !sup.ok && !sup.offered;
        const missing = !sup.ok && sup.offered;
        const rekey = v.hint === "mask";
        const cpu = !!sup.cpu;
        for (const r of [E.screenRow, E.hintRow, E.despillRow]) r.hidden = dormant;
        // on the CPU there is no live preview (the readiness line says so): no row to turn it on
        E.previewRow.hidden = dormant || cpu;
        E.preview.disabled = cpu;
        E.terms.hidden = !missing;
        if (missing) E.termsText.textContent = keying.termsParagraph({ gb: sup.gb, host: sup.host });
        E.download.hidden = !missing;
        E.trustRow.hidden = dormant || v.hint !== "selection";
        E.sourceRow.hidden = dormant || rekey;
        E.sourceNote.hidden = dormant || rekey || !E.sourceNote.textContent;
        E.leaveRow.hidden = dormant || rekey || v.source !== "picture";
        E.refit.hidden = dormant;
        E.settings.hidden = !missing;
        E.ready.textContent = sup.ok ? (sup.text || keying.readyLine(sup.provider, host.keyWorkingSize())) : sup.text;
        E.ready.className = "line" + (sup.kind === "warn" || sup.kind === "error" ? " " + sup.kind : "");
        const s = this.session;
        E.boxLine.textContent = s && s.plan ? `Keys ${keying.boxLine(s.plan)}${s.plan.fromBounds ? " (from this layer's bounds: the key's record is gone after a restart)" : ""}.` : "";
        E.boxLine.hidden = dormant || !E.boxLine.textContent;
        let loop = "", kind = "";
        if (s && s.error) { loop = s.error; kind = " warn"; }
        else if (s && !s.prep) loop = "Preparing the picture ...";
        else if (s && cpu) loop = "No live preview on the CPU: Key keys once with the rows as they are.";
        else if (s && s.matte && v.preview) loop = `Matte in ${(s.matte.roundMs / 1000).toFixed(2)} s (the model ${(s.matte.ms / 1000).toFixed(2)} s). Paint the selection to steer it.`;
        else if (s && v.preview) loop = "Keying the first preview ...";
        E.loop.textContent = loop;
        E.loop.className = "line" + kind;
        E.loop.hidden = dormant || !loop;
        E.key.disabled = !sup.ok || this.busy;
        E.key.title = sup.ok ? "" : sup.text;
        // the Hint row decides: "This layer's mask (Re-key)" re-keys the key layer, the others key anew
        E.key.textContent = rekey ? "Re-key" : "Key";
    }

    /**
     * The rows on your ComfyUI's route: the shared ones (Screen, Hint, Trust, Despill, Source, the grey layer) always, no
     * Preview, Refit or in-app download; the readiness line from keyComfySupport (with what a key there costs, B0), the
     * box the Key sends, the pack's own tick, the wait, and the first-run block until a key from the dialog landed (or
     * again once a key found the models missing). Key is greyed only for what the server lacks; the document's own
     * refusals (a run going, no picture) come from the Key itself, in the status line and here.
     */
    syncComfy() {
        const E = this.els, v = this.values;
        const cs = host.keyComfySupport();
        const rekey = v.hint === "mask";
        const packA = cs.pack === keying.PACKS[0].id, packB = cs.pack === keying.PACKS[1].id;
        for (const r of [E.screenRow, E.hintRow, E.despillRow]) r.hidden = false;
        E.previewRow.hidden = true;
        E.terms.hidden = true;
        E.download.hidden = true;
        E.settings.hidden = true;
        E.refit.hidden = true;
        E.trustRow.hidden = v.hint !== "selection";
        E.sourceRow.hidden = rekey;
        E.sourceNote.hidden = rekey || !E.sourceNote.textContent;
        E.leaveRow.hidden = rekey || v.source !== "picture";
        E.keepRow.hidden = !cs.ok || !packA;
        E.keepNote.hidden = E.keepRow.hidden || !E.keep.checked;
        E.evictsRow.hidden = !cs.ok || !packB;
        E.timeoutRow.hidden = false;
        E.comfyFirst.hidden = !cs.ok || (comfyKeyed && !this.comfyMissing);
        if (!E.comfyFirst.hidden) E.comfyFirstText.textContent = keying.comfyFirstRun(cs.pack);
        E.ready.textContent = cs.ok ? [cs.line, cs.note, keying.COMFY_COST].filter(Boolean).join(" ") : cs.reason;
        E.ready.className = "line" + (!cs.ok && (cs.kind === "warn" || cs.kind === "error") ? " warn" : "");
        const p = this.comfyPlan;
        E.boxLine.textContent = p ? `Keys ${keying.comfyBoxLine(p)}${p.fromBounds ? " (from this layer's bounds: the key's record is gone after a restart)" : ""}.` : "";
        E.boxLine.hidden = !E.boxLine.textContent;
        let loop = "", kind = "";
        if (this.comfyError) { loop = this.comfyError; kind = " warn"; }
        else if (this.busy) loop = "Keying on your ComfyUI ... (the title row's Cancel stops it)";
        else if (cs.ok) loop = "No live preview on your ComfyUI: Key keys once with the rows as they are.";
        E.loop.textContent = loop;
        E.loop.className = "line" + kind;
        E.loop.hidden = !loop;
        E.key.disabled = !cs.ok || this.busy;
        E.key.title = cs.ok ? "" : cs.reason;
        E.key.textContent = rekey ? "Re-key" : "Key";
    }

    focus() {
        if (this.els.key) this.els.key.focus();
    }

    /** What the gate reads. */
    state() {
        const E = this.els;
        return {
            values: { ...this.values }, session: this.session ? this.session.state() : null, keyDisabled: !!E.key.disabled,
            rows: Object.fromEntries(Object.entries(E).filter(([k]) => k.endsWith("Row")).map(([k, n]) => [k, !n.hidden])), ready: E.ready.textContent,
            boxLine: E.boxLine.hidden ? "" : E.boxLine.textContent, loop: E.loop.hidden ? "" : E.loop.textContent,
            firstRun: E.comfyFirst.hidden ? "" : E.comfyFirstText.textContent, comfyTerms: E.comfyFirst.hidden ? "" : E.comfyTerms.textContent,
            comfyLinks: E.comfyFirst.hidden ? [] : [E.packLink, E.comfyLicence, E.comfyCorridor].map((a) => a.textContent), routeFixed: !!E.route.disabled, comfyBox: this.comfyPlan ? this.comfyPlan.box.slice() : null,
        };
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        if (this.session) this.session.close();
        this.session = null;
        for (const off of this._off) off();
        this._off = [];
        if (this.hostEl) this.hostEl.remove();
        if (current === this) current = null;
        // the dialog's own close (never a restart's): the engine's idle timer starts
        try { host.keyEngine.closed(); } catch (err) { console.warn(err); }
    }
}
