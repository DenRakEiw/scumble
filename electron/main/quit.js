// What closing the window, installing an update and a crashed window do (docs/PLAN_0_1_29.md §3, quit safety). Plain
// Node: no electron, so tools/quit_test.js checks the decisions; main.js wires them to the window.
//
// Layer pixels reach the local file mirror 15 s after the last change (the editor's scheduleAutosave), and the
// autosave names those files. A window that closed at once lost the last strokes, and a layer made in those seconds
// came back without its pixels. So a close waits until the window has saved (renderer/shell.js saveBeforeRestart:
// the edited layers and masks, the selection, the autosave), and an update's installer starts only after that.
"use strict";

/** How long a close waits for the window to save before it closes anyway. */
const FLUSH_TIMEOUT = 120000;

/**
 * One per window. onClose() says what a close of the window should do now: "allow" (saved, or nothing to save in),
 * "flush" (prevent it, save, then close again) or "ask" (a save is running: ask whether to wait or quit now).
 */
class QuitGuard {
    constructor({ timeoutMs = FLUSH_TIMEOUT, now = () => Date.now() } = {}) {
        this.timeoutMs = timeoutMs;
        this.now = now;
        this.done = false;       // saved (or given up): the next close goes through
        this.flushing = null;    // the promise of the save in progress
        this.last = null;        // what the last save returned: { ok, ms, timedOut, skipped, error }
    }

    onClose() {
        if (this.done) return "allow";
        return this.flushing ? "ask" : "flush";
    }

    /** Save through `flush` (a function returning a promise of { ok, error }), at most timeoutMs; then done. */
    run(flush) {
        if (this.flushing) return this.flushing;
        const t0 = this.now();
        let timer = null;
        const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, timedOut: true }), this.timeoutMs); });
        const saved = Promise.resolve().then(flush).then((r) => r || { ok: true }, (err) => ({ ok: false, error: String((err && err.message) || err) }));
        this.flushing = Promise.race([saved, timeout]).then((r) => {
            clearTimeout(timer);
            this.last = { ...r, ms: this.now() - t0 };
            this.done = true;
            this.flushing = null;
            return this.last;
        });
        return this.flushing;
    }

    /** The user chose to quit without waiting, or the window saved on its own before (a restart): let closes through. */
    release() {
        this.done = true;
    }

    /** No quit followed after all (an agent's quit that a new session stopped, an update that did not install): the
     *  next close saves again. */
    reset() {
        if (this.flushing) return;
        this.done = false;
    }
}

/** A window's renderer that ends this many times within CRASH_WINDOW is not reloaded again. */
const CRASH_WINDOW = 120000;

/**
 * What to do when the window's renderer ends while the app is not quitting: "reload" (the page comes back and
 * restores the autosave), "safe" (it ended again soon after a reload: come back without restoring, the state set
 * aside) or "stop" (it keeps ending: leave it and tell the user). `record(reason)` returns the plan.
 */
class CrashGuard {
    constructor({ windowMs = CRASH_WINDOW, now = () => Date.now() } = {}) {
        this.windowMs = windowMs;
        this.now = now;
        this.times = [];
    }

    record() {
        const t = this.now();
        this.times = this.times.filter((x) => t - x < this.windowMs);
        this.times.push(t);
        return this.times.length === 1 ? "reload" : this.times.length === 2 ? "safe" : "stop";
    }
}

/** A reason Electron gives for a renderer that ended which is not a crash. */
function isCrash(details) {
    const r = details && details.reason;
    return !!r && r !== "clean-exit";
}

module.exports = { FLUSH_TIMEOUT, CRASH_WINDOW, QuitGuard, CrashGuard, isCrash };
