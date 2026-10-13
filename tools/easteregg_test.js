// @ts-check
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

let failed = 0;
function check(name, ok, info) {
    if (ok) {
        console.log("[ok] " + name);
    } else {
        failed++;
        console.log("[FAIL] " + name + (info !== undefined ? ": " + JSON.stringify(info) : ""));
    }
}

async function main() {
    const ee = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "easteregg.js")).href);

    // 1. Secret greeting
    const greeting = ee.getSecretGreeting();
    check("bf: getSecretGreeting returns 'Welcome to Scumble!'", greeting === "Welcome to Scumble!", greeting);

    // 2. Secret word
    const word = ee.getScumbleWord();
    check("bf: getScumbleWord returns 'Scumble'", word === "Scumble", word);

    // 2b. The logo program (tools/bf_logo.py): the mascot and the block-letter wordmark, ASCII only
    const fs = require("node:fs");
    const code = fs.readFileSync(path.join(__dirname, "..", "renderer", "easteregg", "logo.bf"), "utf8");
    const logo = ee.runBrainfuck(code);
    const rows = logo.split("\n");
    check("bf: the logo prints the wordmark", logo.includes("|____/  \\____| \\___/ |_|  |_||____/ |_____||_____|"), rows.slice(-3));
    check("bf: the logo prints the mascot", rows.filter((r) => r.includes("@@@@@@@@@@")).length >= 20, rows.length);
    check("bf: the logo is plain ASCII within 96 columns", /^[\x0a\x20-\x7e]*$/.test(logo) && rows.every((r) => r.length <= 96));
    check("bf: the logo URL points at renderer/easteregg/logo.bf", ee.LOGO_URL.href.endsWith("/renderer/easteregg/logo.bf"), ee.LOGO_URL.href);

    // 3. Simple echo
    const echo = ee.runBrainfuck(",.,.", "AB");
    check("bf: input echo", echo === "AB", echo);

    // 4. Memory wraparound
    const wrap = ee.runBrainfuck("+[>-<-]>.", "");
    check("bf: memory loop", wrap.length === 1);

    // 5. Unmatched bracket error handling
    let threw = false;
    try {
        ee.runBrainfuck("[++");
    } catch (_) {
        threw = true;
    }
    check("bf: unmatched open bracket throws", threw);

    let threwClose = false;
    try {
        ee.runBrainfuck("++]");
    } catch (_) {
        threwClose = true;
    }
    check("bf: unmatched close bracket throws", threwClose);

    if (failed === 0) {
        console.log("PASS");
        process.exit(0);
    } else {
        console.log("FAIL (" + failed + " failures)");
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
