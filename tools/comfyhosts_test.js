// Where the ComfyUI window's page may go (electron/main/comfyhosts.js), in plain Node:
//   node tools/comfyhosts_test.js
// The gate comfyview runs it first.
"use strict";

const { cloudAuthUrl, popupAction, navigationAllowed, permissionAllowed, DENIED_PERMISSIONS, CLOUD_URL, mediaKinds, mediaKey, mediaDecision, mediaCheckAllowed, mediaQuestion } = require("../electron/main/comfyhosts.js");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

const yes = ["https://cloud.comfy.org/cloud/login", "https://dreamboothy.firebaseapp.com/__/auth/handler?x=1", "https://accounts.google.com/o/oauth2/auth", "https://github.com/login/oauth/authorize", "https://auth.comfy.org/x"];
const no = ["http://accounts.google.com/", "https://evil.com/", "https://firebaseapp.com.evil.com/", "https://comfy.org.evil.com/", "https://notgithub.com/", "https://user:pw@github.com/", "javascript:alert(1)", "file:///C:/x", "scumble://app/index.html", "https://firebaseapp.com/"];
check("the sign-in hosts of Comfy Cloud pass", yes.every(cloudAuthUrl), yes.filter((u) => !cloudAuthUrl(u)).join(" "));
check("look-alikes, http, credentials in the URL and other schemes do not", no.every((u) => !cloudAuthUrl(u)), no.filter(cloudAuthUrl).join(" "));
check("a popup to a sign-in host is a child window on both targets (a ComfyUI's Comfy account login uses the same Firebase)", popupAction(yes[1], "cloud") === "child" && popupAction(yes[1], "comfy") === "child" && popupAction(yes[2], "comfy") === "child");
check("other http(s) popups go to the system browser, anything else is denied", popupAction("https://example.com/", "cloud") === "external" && popupAction("scumble://app/index.html", "cloud") === "deny" && popupAction("file:///C:/x", "comfy") === "deny");
const origin = "http://127.0.0.1:8188";
check("My ComfyUI: the page stays on its origin", navigationAllowed(origin + "/x", origin, "comfy") && !navigationAllowed("https://accounts.google.com/", origin, "comfy") && !navigationAllowed("scumble://app/index.html", origin, "comfy"));
check("Comfy Cloud: its origin and the sign-in hosts", navigationAllowed(CLOUD_URL + "/cloud/login", CLOUD_URL, "cloud") && navigationAllowed("https://github.com/login", CLOUD_URL, "cloud") && !navigationAllowed("https://evil.com/", CLOUD_URL, "cloud"));

// H1: the session's permissions (comfyview.js guardPermissions), in Electron's names
const denied = ["media", "geolocation", "midi", "midiSysex", "hid", "serial", "usb", "openExternal"];
const granted = ["clipboard-read", "clipboard-sanitized-write", "fullscreen", "notifications", "pointerLock", "keyboardLock", "fileSystem", "storage-access", "window-management", "idle-detection", "speaker-selection", "unknown"];
check("camera and microphone (media), location, MIDI, HID, serial, USB and a non-web scheme handed to the OS (openExternal) are denied", denied.every((p) => !permissionAllowed(p)) && DENIED_PERMISSIONS.size === denied.length, denied.filter(permissionAllowed).join(" "));
check("the rest stays granted (the clipboard, fullscreen, notifications ...)", granted.every(permissionAllowed), granted.filter((p) => !permissionAllowed(p)).join(" "));

// camera and microphone ask instead (the user, 2026-11-08): mediaDecision / mediaCheckAllowed / mediaQuestion
check("mediaKinds: video is the camera, audio the microphone, in that order; an unknown type or none refuses",
    JSON.stringify(mediaKinds(["audio", "video"])) === '["camera","microphone"]' && JSON.stringify(mediaKinds("audio")) === '["microphone"]'
    && mediaKinds(["video", "unknown"]).length === 0 && mediaKinds("unknown").length === 0 && mediaKinds([]).length === 0 && mediaKinds(undefined).length === 0);
const shown = "http://127.0.0.1:8188";
const page = (more) => ({ fromPage: true, isMainFrame: true, origin: shown + "/", shownOrigin: shown, kinds: ["microphone"], answers: new Map(), ...more });
const asks = (d, kinds) => d.action === "ask" && JSON.stringify(d.ask) === JSON.stringify(kinds) && d.origin === shown;
check("the page's main frame on the shown origin is asked (Electron's securityOrigin ends in a slash)", asks(mediaDecision(page()), ["microphone"]));
check("a subframe, a sign-in window and another origin are denied without a question",
    mediaDecision(page({ isMainFrame: false })).action === "deny" && mediaDecision(page({ fromPage: false })).action === "deny"
    && mediaDecision(page({ origin: "http://localhost:8188/" })).action === "deny" && mediaDecision(page({ origin: "https://evil.example/" })).action === "deny"
    && mediaDecision(page({ isMainFrame: undefined })).action === "deny");
check("no shown origin, a non-web origin, no kind: denied",
    mediaDecision(page({ shownOrigin: "" })).action === "deny" && mediaDecision(page({ origin: "scumble://app/", shownOrigin: "scumble://app" })).action === "deny"
    && mediaDecision(page({ kinds: [] })).action === "deny" && mediaDecision(page({ origin: "file:///C:/x" })).action === "deny");
const answers = new Map([[mediaKey(shown, "camera"), true], [mediaKey(shown, "microphone"), false]]);
check("mediaKey ignores the trailing slash", mediaKey(shown + "/", "camera") === mediaKey(shown, "camera"));
check("a kind allowed is granted without a question, a denied one denied without one",
    mediaDecision(page({ kinds: ["camera"], answers })).action === "grant" && mediaDecision(page({ kinds: ["microphone"], answers })).action === "deny");
check("a request that names a denied kind is denied, one that names an allowed and an unanswered kind asks for the unanswered one",
    mediaDecision(page({ kinds: ["camera", "microphone"], answers })).action === "deny"
    && asks(mediaDecision(page({ kinds: ["camera", "microphone"], answers: new Map([[mediaKey(shown, "camera"), true]]) })), ["microphone"]));
check("the answers are per origin: another ComfyUI is asked again",
    mediaDecision({ ...page({ kinds: ["camera"], answers }), origin: "http://10.0.0.5:8188", shownOrigin: "http://10.0.0.5:8188" }).action === "ask");
check("the check handler: yes only for an allowed kind of the page's main frame on the shown origin",
    mediaCheckAllowed(page({ kinds: ["camera"], answers })) && !mediaCheckAllowed(page({ kinds: ["microphone"], answers })) && !mediaCheckAllowed(page())
    && !mediaCheckAllowed(page({ kinds: ["camera"], answers, isMainFrame: false })) && !mediaCheckAllowed(page({ kinds: ["camera"], answers, fromPage: false }))
    && !mediaCheckAllowed(page({ kinds: [], answers })));
const dc = mediaDecision(page({ origin: CLOUD_URL + "/", shownOrigin: CLOUD_URL }));
check("Comfy Cloud's own page is asked when it is the target", dc.action === "ask" && dc.origin === CLOUD_URL && JSON.stringify(dc.ask) === '["microphone"]', JSON.stringify(dc));
const qm = mediaQuestion({ origin: shown, cloud: false, kinds: ["microphone"] });
const qb = mediaQuestion({ origin: CLOUD_URL, cloud: true, kinds: ["camera", "microphone"] });
check("the question: who, what, for this session; Allow / Deny with the focus on Deny, Escape denies",
    qm.message === "ComfyUI at 127.0.0.1:8188 wants to use your microphone. Allow it for this session?" && qb.message === "Comfy Cloud wants to use your camera and microphone. Allow it for this session?"
    && JSON.stringify(qm.buttons) === '["Allow","Deny"]' && qm.focusId === 1 && qm.cancelId === 1 && /restart/.test(qm.detail), qm.message + " / " + qb.message);
check("media stays in the denied table: anything mediaDecision does not decide is refused", !permissionAllowed("media"));

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
