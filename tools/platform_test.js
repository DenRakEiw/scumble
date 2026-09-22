// The per-platform parts of the build and of the app that need no app to check (plain Node):
// the MCP registration of every platform (electron/main/mcp/registration.js) and the files
// each installer leaves out (package.json build.win.files / build.linux.files).
//
//   node tools/platform_test.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { server, registration } = require("../electron/main/mcp/registration");

const ROOT = path.resolve(__dirname, "..");
let failed = 0;
function check(name, fn) {
    try { fn(); console.log("[ok] " + name); } catch (err) { failed++; console.log("[FAIL] " + name + ": " + err.message); }
}
function eq(a, b, what) {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    if (x !== y) throw new Error(`${what || "value"}: ${x} instead of ${y}`);
}

const WIN = { platform: "win32", exe: "C:\\Program Files\\Scumble\\Scumble.exe", launcher: "C:\\Program Files\\Scumble\\resources\\app.asar\\electron\\main\\mcp\\launch.js" };
const DEB = { platform: "linux", exe: "/opt/Scumble/scumble", launcher: "/opt/Scumble/resources/app.asar/electron/main/mcp/launch.js" };
const APPIMAGE = { ...DEB, exe: "/tmp/.mount_scumbAbC123/scumble", launcher: "/tmp/.mount_scumbAbC123/resources/app.asar/electron/main/mcp/launch.js", appImage: "/home/u/Apps/scumble-0.1.26.AppImage" };

check("windows_is_the_line_it_was_before_the_module", () => {
    // the text main.js built itself up to 0.1.25, byte for byte
    eq(registration("code", WIN), `claude mcp add scumble -e ELECTRON_RUN_AS_NODE=1 -- "${WIN.exe}" "${WIN.launcher}" --mcp`, "code");
    eq(registration("desktop", WIN), JSON.stringify({ mcpServers: { scumble: { command: WIN.exe, args: [WIN.launcher, "--mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } } } }, null, 2), "desktop");
});

check("a_deb_install_takes_the_launcher_like_windows", () => {
    eq(server(DEB), { command: DEB.exe, args: [DEB.launcher, "--mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } });
    eq(registration("code", DEB), `claude mcp add scumble -e ELECTRON_RUN_AS_NODE=1 -- "${DEB.exe}" "${DEB.launcher}" --mcp`, "code");
});

check("an_appimage_names_the_appimage_file_and_nothing_inside_its_mount", () => {
    eq(server(APPIMAGE), { command: APPIMAGE.appImage, args: ["--mcp"], env: {} });
    const code = registration("code", APPIMAGE), desk = registration("desktop", APPIMAGE);
    eq(code, `claude mcp add scumble -- "${APPIMAGE.appImage}" --mcp`, "code");
    eq(JSON.parse(desk), { mcpServers: { scumble: { command: APPIMAGE.appImage, args: ["--mcp"] } } }, "desktop");
    for (const t of [code, desk]) if (t.includes(".mount_") || t.includes("ELECTRON_RUN_AS_NODE")) throw new Error("the mount or node mode leaked: " + t);
});

check("appimage_is_read_on_linux_only", () => {
    // a stray APPIMAGE variable on Windows (or an empty one on Linux) changes nothing
    eq(server({ ...WIN, appImage: "C:\\x.AppImage" }), server(WIN), "windows");
    eq(server({ ...DEB, appImage: "" }), server(DEB), "empty");
});

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ORT = "node_modules/onnxruntime-node/bin/napi-v6";
const dirs = [];
for (const os of fs.readdirSync(path.join(ROOT, ORT))) for (const arch of fs.readdirSync(path.join(ROOT, ORT, os))) dirs.push(`${os}/${arch}`);

/** The onnxruntime binary folders a platform's `files` leaves in (every "!…/<os>[/<arch>]/**" pattern takes its folders out). */
function kept(files) {
    const out = [];
    for (const d of dirs) {
        const gone = (files || []).some((f) => {
            const m = /^!node_modules\/onnxruntime-node\/bin\/napi-v6\/(.+)\/\*\*$/.exec(f);
            return m && (d === m[1] || d.startsWith(m[1] + "/"));
        });
        if (!gone) out.push(d);
    }
    return out.sort();
}

check("the_onnxruntime_package_still_has_the_layout_the_patterns_name", () => {
    for (const d of ["win32/x64", "linux/x64", "darwin/arm64"]) if (!dirs.includes(d)) throw new Error("no " + d + " in " + ORT + ": " + dirs.join(", "));
    for (const f of [...(pkg.build.win.files || []), ...(pkg.build.linux.files || [])]) {
        const m = /^!node_modules\/onnxruntime-node\/bin\/napi-v6\/(.+)\/\*\*$/.exec(f);
        if (!m) throw new Error("a pattern this test does not read: " + f);
        if (!fs.existsSync(path.join(ROOT, ORT, m[1]))) throw new Error("a pattern for a folder that does not exist: " + f);
    }
});

check("the_windows_installer_carries_the_x64_binary_and_no_other", () => {
    eq(kept(pkg.build.win.files), ["win32/x64"], "kept");
    eq(pkg.build.win.target.map((t) => t.arch), [["x64"]], "arch");
});

check("the_linux_build_carries_the_linux_binaries_and_no_other", () => {
    eq(kept(pkg.build.linux.files), dirs.filter((d) => d.startsWith("linux/")).sort(), "kept");
});

check("the_unpacked_binaries_are_still_unpacked", () => {
    if (!pkg.build.asarUnpack.includes(ORT.replace(/\/napi-v6$/, "") + "/**")) throw new Error("asarUnpack: " + pkg.build.asarUnpack.join(", "));
});

check("chromium_keeps_english_and_german", () => {
    eq(pkg.build.electronLanguages, ["en-US", "de"], "electronLanguages");
});

console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
