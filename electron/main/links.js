// What a window may hand to the system and where Scumble's own window may go (H1, docs/PLAN_WASM_BUILD.md §7 "The user's
// answers after K4"; docs/research/review_external_2026-11-07/verified.json S1, S4). Plain functions, no Electron at
// load, so tools/links_test.js checks them in Node.
//
// - `openHttp(url)`: the one way a link leaves for the system browser. Only http and https: a file:, smb: or ms-*
//   URL (or the app's own scumble://app/index.html#, which a middle click on an `href="#"` link hands over) never
//   reaches shell.openExternal. Used by the main window's window.open handler and `app:openExternal`, and by the ComfyUI
//   window's bar, page and sign-in windows (comfyview.js).
// - `appPage(url, origin)`: the main window's navigation rule. Only the app's page itself (`/index.html` or `/`, with
//   a query or hash), never another file of the scheme: scumble://app/comfy/* is the ComfyUI proxy, which passes the
//   server's content types through, and a page from there would run in the app's origin with the preload's API.
"use strict";

/** Whether `url` is an http(s) URL (the scheme's case does not matter; no credentials are refused here). */
function isHttpUrl(url) {
    let u;
    try { u = new URL(String(url)); } catch (_) { return false; }
    return u.protocol === "http:" || u.protocol === "https:";
}

/**
 * Open `url` in the system browser when it is http(s); anything else is dropped. `open` is the opener (Electron's
 * shell.openExternal by default; a test passes its own). Whether it was handed over.
 */
function openHttp(url, open = null) {
    if (!isHttpUrl(url)) return false;
    const opener = open || require("electron").shell.openExternal;
    Promise.resolve(opener(new URL(String(url)).href)).catch((err) => console.warn("open in the browser:", (err && err.message) || err));
    return true;
}

/** Whether a navigation of Scumble's main window to `url` stays on the app's page (`origin` e.g. "scumble://app"). */
function appPage(url, origin) {
    let u, o;
    try { u = new URL(String(url)); o = new URL(String(origin)); } catch (_) { return false; }
    // Chromium lowercases a standard scheme's host, Node's URL does not for a scheme it does not know
    if (u.protocol !== o.protocol || u.host.toLowerCase() !== o.host.toLowerCase() || u.username || u.password) return false;
    return u.pathname === "/index.html" || u.pathname === "/";
}

module.exports = { isHttpUrl, openHttp, appPage };
