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
