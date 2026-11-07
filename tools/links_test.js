// What a window may hand to the system browser and where Scumble's own window may go (electron/main/links.js, H1), in
// plain Node:
//   node tools/links_test.js
// The gate comfyview runs it first.
"use strict";

const { isHttpUrl, openHttp, appPage } = require("../electron/main/links.js");

const results = [];
function check(what, ok, detail) {
    results.push(!!ok);
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

const http = ["https://github.com/DenRakEiw/scumble", "http://127.0.0.1:8188/", "HTTPS://Example.com/x?y=1#z", " https://example.com/ "];
const other = ["file:///C:/Windows/System32/calc.exe", "smb://host/share", "\\\\host\\share", "ms-settings:privacy", "ms-msdt:/id x", "search-ms:query=x",
    "javascript:alert(1)", "scumble://app/index.html#", "scumble://app/comfy/view", "mailto:a@b.c", "data:text/html,x", "", null, undefined, 42, "https:"];
check("http and https URLs pass (any case of the scheme)", http.every(isHttpUrl), http.filter((u) => !isHttpUrl(u)).join(" | "));
check("file:, smb:, ms-*, search-ms:, javascript:, the app's own scheme, mailto:, data: and junk do not", other.every((u) => !isHttpUrl(u)), other.filter(isHttpUrl).join(" | "));

const opened = [];
const open = (u) => { opened.push(u); return Promise.resolve(); };
const handed = [...http, ...other].map((u) => openHttp(u, open));
check("openHttp hands http(s) alone to the opener, as the parsed URL", handed.filter(Boolean).length === http.length && opened.length === http.length
    && opened[2] === "https://example.com/x?y=1#z" && opened[3] === "https://example.com/", JSON.stringify(opened));
let late = null;
const said = console.warn;
console.warn = (...a) => { late = a.join(" "); };
openHttp("https://example.com/", () => Promise.reject(new Error("no browser")));
setTimeout(() => {
    console.warn = said;
    check("an opener that fails is a warning, not an unhandled rejection", /no browser/.test(String(late)), String(late));

    const O = "scumble://app";
    const page = ["scumble://app/index.html", "scumble://app/index.html?safe=1", "scumble://app/index.html#x", "scumble://app/", "SCUMBLE://APP/index.html", "scumble://app/x/../index.html"];
    const away = ["scumble://app/comfy/view?filename=x.svg", "scumble://app/comfy/x.html", "scumble://app/plugins/film/panel.html", "scumble://app/comfybar.html",
        "scumble://app/editor/inpaint_canvas.js", "scumble://app/index.htm", "scumble://other/index.html", "scumble://user@app/index.html", "file:///C:/x.png",
        "https://127.0.0.1:9/", "http://app/index.html", "scumble://app/comfy/..%2Findex.html", "", null];
    check("the main window may navigate to the app's page (a reload, a query, a hash)", page.every((u) => appPage(u, O)), page.filter((u) => !appPage(u, O)).join(" | "));
    check("never to the ComfyUI proxy, another file of the scheme, another host, a file or a web page", away.every((u) => !appPage(u, O)), away.filter((u) => appPage(u, O)).join(" | "));

    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed} of ${results.length} checks passed`);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
}, 50);
