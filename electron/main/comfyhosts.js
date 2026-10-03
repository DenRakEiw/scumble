// Where the ComfyUI window's page may go (item 35, docs/PLAN_COMFY_VIEW.md §2.1, §2.4). Plain functions, no Electron,
// so tools/comfyhosts_test.js checks them in Node.
//
// My ComfyUI: the page stays on its own origin; links elsewhere go to the system browser and no popup opens.
// Comfy Cloud (V4): the page signs in with Firebase's signInWithPopup (read from cloud.comfy.org's bundle on
// 2026-10-03: a *.firebaseapp.com auth domain, then Google or GitHub), so a popup to those hosts opens as a child
// window in the same partition, and the page may navigate to them (Firebase's redirect fallback). Google may refuse a
// sign-in from an embedded browser; nothing here hides what the window is.
"use strict";

const CLOUD_URL = "https://cloud.comfy.org";

// the sign-in hosts of Comfy Cloud: exact names, or a suffix that starts with a dot
const CLOUD_AUTH_HOSTS = ["cloud.comfy.org", ".comfy.org", ".firebaseapp.com", "accounts.google.com", "github.com"];

function hostMatches(host, rule) {
    return rule.startsWith(".") ? host.endsWith(rule) && host.length > rule.length : host === rule;
}

/** Whether `url` is an https URL on one of Comfy Cloud's sign-in hosts. */
function cloudAuthUrl(url) {
    let u;
    try { u = new URL(String(url)); } catch (_) { return false; }
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return CLOUD_AUTH_HOSTS.some((r) => hostMatches(host, r));
}

/**
 * What the page's window.open gets: "child" (a sign-in window in the same partition), "external" (the system
 * browser) or "deny". `target` is "comfy" or "cloud".
 */
function popupAction(url, target) {
    if (target === "cloud" && cloudAuthUrl(url)) return "child";
    return /^https?:\/\//i.test(String(url)) ? "external" : "deny";
}

/** Whether the page may navigate to `url`: its own origin, and on Comfy Cloud the sign-in hosts too. */
function navigationAllowed(url, origin, target) {
    try {
        const u = new URL(String(url));
        if (u.origin === origin) return true;
    } catch (_) { return false; }
    return target === "cloud" && cloudAuthUrl(url);
}

module.exports = { CLOUD_URL, CLOUD_AUTH_HOSTS, cloudAuthUrl, popupAction, navigationAllowed };
