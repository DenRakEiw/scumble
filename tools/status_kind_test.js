// The status line's kinds (item 45, docs/PLAN_0_1_48.md S1 / S2): renderer/editor/inpaint_status.js in plain Node.
//   node tools/status_kind_test.js
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
    const { statusKindOf, statusKindFor, isCancel, failKind, refusal } = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "inpaint_status.js")).href);

    let failed = 0;
    function check(name, ok, got) {
        if (ok) console.log(`[ok] ${name}`);
        else { failed++; console.log(`[FAIL] ${name}: ${JSON.stringify(got)}`); }
    }

    // the text alone
    for (const [text, want] of [
        ["Error invoking remote method 'provider:edit': Error: 401", "error"],
        ["Failed to read layer pixels", "error"],
        ["Could not load the LUT: bad header", "error"],
        ["Cannot read that file", "error"],
        ["No API key for fal.ai. Add one in Settings.", "error"],
        ["Save failed: disk full", "error"],
        ["Depth estimation failed.", "error"],
        ["The upload failed because the server went away", "error"],
        ["Depth estimation needs Depth Anything V2 Small: download it in Settings › Helpers.", "warn"],
        ["Object selection needs a SAM2 model: download one in Settings › Helpers, or install ...", "warn"],
        ["No SAM2 model is downloaded (Settings › Helpers).", "warn"],
        ["Saved C:/shots/shot_failed.png (1200 × 800, 412 kB).", ""],
        ["Saved C:/x/failed.v2/out.png.", ""],
        ["Select a layer first.", ""],
        ["Removed (1,204 px in 0.3 s).", ""],
        ["", ""],
    ]) check(`text ${JSON.stringify(text.slice(0, 40))} -> ${want || "plain"}`, statusKindOf(text) === want, statusKindOf(text));
    check("null and undefined are plain", statusKindOf(null) === "" && statusKindOf(undefined) === "", [statusKindOf(null), statusKindOf(undefined)]);

    // an explicit kind beats the text
    check("kind error on a plain text", statusKindFor("The lights are off.", "error") === "error");
    check("{ kind: warn }", statusKindFor("Done.", { kind: "warn" }) === "warn");
    check("kind info keeps an error text plain", statusKindFor("Error: a hint", "info") === "");
    check("an unknown kind lets the text decide", statusKindFor("Error: x", "loud") === "error" && statusKindFor("Done.", "loud") === "");
    check("no kind lets the text decide", statusKindFor("Failed: x") === "error" && statusKindFor("Done.", undefined) === "");

    // a caught error
    check("a plain error is an error", failKind(new Error("fal.ai flux: 401 Unauthorized")) === "error");
    check("a string is an error", failKind("boom") === "error");
    for (const msg of ["Cancelled after 12 s", "Cancelled before anything was sent", "Canceled.", "cancelled", "Aborted by the user"]) {
        check(`cancel ${JSON.stringify(msg)} is plain`, isCancel(new Error(msg)) && failKind(new Error(msg)) === "info", failKind(new Error(msg)));
    }
    check("err.kind cancelled is plain", failKind(Object.assign(new Error("Upscale stopped"), { kind: "cancelled" })) === "info");
    check("an AbortError is plain", failKind(Object.assign(new Error("x"), { name: "AbortError" })) === "info");
    check("err.kind timeout is an error", failKind(Object.assign(new Error("timed out"), { kind: "timeout" })) === "error");
    check("a message that only mentions a cancel is an error", failKind(new Error("The run could not be cancelled")) === "error");
    const r = refusal("Select an area first.");
    check("a refusal is an Error with its text", r instanceof Error && r.message === "Select an area first.");
    check("a refusal is plain", failKind(r) === "info");
    check("a limit refusal is a warning", failKind(refusal("The picture would be 70,000 px wide.", "warn")) === "warn");
    check("statusKind error on any error", failKind(Object.assign(new Error("Cancelled"), { statusKind: "error" })) === "error");

    console.log(failed ? `${failed} failed` : "PASS");
    process.exit(failed ? 1 : 0);
})();
