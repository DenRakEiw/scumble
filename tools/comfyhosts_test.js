// Where the ComfyUI window's page may go (electron/main/comfyhosts.js), in plain Node:
//   node tools/comfyhosts_test.js
// The gate comfyview runs it first.
"use strict";

const { cloudAuthUrl, popupAction, navigationAllowed, CLOUD_URL } = require("../electron/main/comfyhosts.js");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

const yes = ["https://cloud.comfy.org/cloud/login", "https://dreamboothy.firebaseapp.com/__/auth/handler?x=1", "https://accounts.google.com/o/oauth2/auth", "https://github.com/login/oauth/authorize", "https://auth.comfy.org/x"];
const no = ["http://accounts.google.com/", "https://evil.com/", "https://firebaseapp.com.evil.com/", "https://comfy.org.evil.com/", "https://notgithub.com/", "https://user:pw@github.com/", "javascript:alert(1)", "file:///C:/x", "scumble://app/index.html", "https://firebaseapp.com/"];
check("the sign-in hosts of Comfy Cloud pass", yes.every(cloudAuthUrl), yes.filter((u) => !cloudAuthUrl(u)).join(" "));
check("look-alikes, http, credentials in the URL and other schemes do not", no.every((u) => !cloudAuthUrl(u)), no.filter(cloudAuthUrl).join(" "));
check("a popup to a sign-in host is a child window on Comfy Cloud only", popupAction(yes[1], "cloud") === "child" && popupAction(yes[1], "comfy") === "external");
check("other http(s) popups go to the system browser, anything else is denied", popupAction("https://example.com/", "cloud") === "external" && popupAction("scumble://app/index.html", "cloud") === "deny" && popupAction("file:///C:/x", "comfy") === "deny");
const origin = "http://127.0.0.1:8188";
check("My ComfyUI: the page stays on its origin", navigationAllowed(origin + "/x", origin, "comfy") && !navigationAllowed("https://accounts.google.com/", origin, "comfy") && !navigationAllowed("scumble://app/index.html", origin, "comfy"));
check("Comfy Cloud: its origin and the sign-in hosts", navigationAllowed(CLOUD_URL + "/cloud/login", CLOUD_URL, "cloud") && navigationAllowed("https://github.com/login", CLOUD_URL, "cloud") && !navigationAllowed("https://evil.com/", CLOUD_URL, "cloud"));

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
