// Where the ComfyUI window's page may go (item 35, docs/PLAN_COMFY_VIEW.md §2.1, §2.4). Plain functions, no Electron,
// so tools/comfyhosts_test.js checks them in Node.
//
// Both targets sign in with Firebase's signInWithPopup: Comfy Cloud's own login (read from cloud.comfy.org's bundle on
// 2026-10-03: a *.firebaseapp.com auth domain, then Google or GitHub), and the Comfy account login a ComfyUI's API
// nodes ask for (the same Firebase, dreamboothy.firebaseapp.com; the user's Google login on their own ComfyUI went to
// the system browser and never came back, 2026-10-03). So a popup to those hosts opens as a child window in the same
// partition on either target: it keeps its opener, which the answer needs. Other popups go to the system browser.
// My ComfyUI: the page stays on its own origin. Comfy Cloud: the page may also navigate to the sign-in hosts
// (Firebase's redirect fallback). Google may refuse a sign-in from an embedded browser; nothing here hides what the
// window is.
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
 * What the page's window.open gets: "child" (a sign-in window in the same partition, on either target), "external"
 * (the system browser) or "deny".
 */
function popupAction(url) {
    if (cloudAuthUrl(url)) return "child";
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
