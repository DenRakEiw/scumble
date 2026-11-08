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

// The permissions the page (and its sign-in windows) never gets, in Electron's names (H1, docs/PLAN_WASM_BUILD.md §7
// "The user's answers after K4"): the page runs every node pack's JavaScript, and Electron grants whatever a page asks
// for unless the session says otherwise. Camera and microphone ("media", unless the user allows it: mediaDecision; a
// screen capture needs a handler of its own, which is not set, so it fails anyway), location, MIDI, the device APIs
// (HID, serial, USB), and "openExternal": a
// frame or a sign-in window navigating to a scheme the system handles (mailto:, ms-*, search-ms: ...) would hand it
// to the OS, past links.js, which lets only http(s) out. Everything else stays as before (granted): ComfyUI's page
// keeps its clipboard, fullscreen and notifications. "media" stays in the set as the answer to anything mediaDecision
// (below) does not decide: since 2026-11-08 the page's own camera and microphone requests ask the user instead.
const DENIED_PERMISSIONS = new Set(["media", "geolocation", "midi", "midiSysex", "hid", "serial", "usb", "openExternal"]);

/** Whether the ComfyUI window's session grants `permission` (an Electron permission name). */
function permissionAllowed(permission) {
    return !DENIED_PERMISSIONS.has(String(permission));
}

// Camera and microphone ask instead (the user, 2026-11-08: "ja, machen wir so"): ComfyUI's own core nodes Webcam
// Capture and Record Audio need getUserMedia, and granting it silently would be worse than a browser, since every node
// pack's JavaScript runs in that page. So only the main frame of the page view itself (not a subframe, not a sign-in
// window), on the origin the window shows (the ComfyUI of Settings › ComfyUI, or Comfy Cloud's page when that is the
// target), is asked, once per origin and kind for the session; the answer lives in memory (comfyview.js), never in a
// setting. A kind answered no stays no until Scumble quits; one answered yes is granted without a second question.
const MEDIA_KINDS = { video: "camera", audio: "microphone" };
const MEDIA_GUARD_MS = 500;   // the question takes no click, Enter or Space this long after it opened (mediaQuestion)

/** The origin of an http(s) URL or origin string (Electron's securityOrigin ends in "/"), or "". */
function webOrigin(url) {
    try { const u = new URL(String(url)); return /^https?:$/.test(u.protocol) ? u.origin : ""; } catch (_) { return ""; }
}

/**
 * The kinds ("camera", "microphone") a media request's `mediaTypes` or a check's `mediaType` names, in that order; []
 * for none and for any type that is neither video nor audio (Electron's "unknown"), which is refused.
 */
function mediaKinds(types) {
    const list = Array.isArray(types) ? types : types == null ? [] : [types];
    const out = new Set();
    for (const t of list) {
        const k = MEDIA_KINDS[String(t)];
        if (!k) return [];
        out.add(k);
    }
    return ["camera", "microphone"].filter((k) => out.has(k));
}

/** The memory's key of one origin's one kind. */
function mediaKey(origin, kind) {
    return `${webOrigin(origin)} ${kind}`;
}

/**
 * What the ComfyUI window's session answers a camera / microphone request: { action: "deny" | "grant" | "ask", ask:
 * the kinds still unanswered, origin }. `fromPage` says the request comes from the window's page view (not a sign-in
 * window); `isMainFrame` from its main frame; `origin` the requesting frame's origin; `shownOrigin` the origin the window
 * shows; `kinds` mediaKinds' answer; `answers` a Map of mediaKey -> true / false.
 */
function mediaDecision({ fromPage, isMainFrame, origin, shownOrigin, kinds, answers }) {
    const o = webOrigin(origin);
    const deny = { action: "deny", ask: [], origin: o };
    if (!fromPage || isMainFrame !== true || !o || o !== webOrigin(shownOrigin) || !Array.isArray(kinds) || !kinds.length) return deny;
    const said = (k) => (answers && typeof answers.get === "function" ? answers.get(mediaKey(o, k)) : undefined);
    if (kinds.some((k) => said(k) === false)) return deny;
    const ask = kinds.filter((k) => said(k) !== true);
    return ask.length ? { action: "ask", ask, origin: o } : { action: "grant", ask: [], origin: o };
}

/** The check handler's answer (navigator.permissions.query, the device list's labels): yes only for a kind allowed. */
function mediaCheckAllowed(args) {
    return mediaDecision(args).action === "grant";
}

/**
 * The question, as renderer/dialogs.js's ask() takes it: Allow / Deny with Deny the default, the focus, Enter's and
 * Escape's answer (it opens unasked, while the user may be typing in ComfyUI), and no answer by a click, Enter or
 * Space for its first 500 ms (`guardMs`): the page's getUserMedia needs no click, so node-pack JavaScript could put a
 * lure under where Allow appears and ask on the first click of a double click.
 */
function mediaQuestion({ origin, cloud, kinds }) {
    let host = "";
    try { host = new URL(String(origin)).host; } catch (_) { /* none */ }
    const what = kinds.length > 1 ? "your camera and microphone" : `your ${kinds[0] || "camera"}`;
    const who = cloud ? "Comfy Cloud" : `ComfyUI at ${host}`;
    return {
        title: kinds.length > 1 ? "Camera and microphone" : kinds[0] === "microphone" ? "Microphone" : "Camera",
        message: `${who} wants to use ${what}. Allow it for this session?`,
        detail: "ComfyUI's Webcam Capture and Record Audio nodes ask for it. The page runs the JavaScript of every node pack on that server, so allow it only when you use such a node. Scumble keeps your answer until it quits and asks again after a restart.",
        buttons: ["Allow", "Deny"], defaultId: 1, cancelId: 1, focusId: 1, guardMs: MEDIA_GUARD_MS,
    };
}

module.exports = {
    CLOUD_URL, CLOUD_AUTH_HOSTS, cloudAuthUrl, popupAction, navigationAllowed, DENIED_PERMISSIONS, permissionAllowed,
    webOrigin, mediaKinds, mediaKey, mediaDecision, mediaCheckAllowed, mediaQuestion, MEDIA_GUARD_MS,
};
