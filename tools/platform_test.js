// The per-platform parts of the build and of the app that need no app to check (plain Node):
// the MCP registration of every platform (electron/main/mcp/registration.js), the files
// each installer leaves out (package.json build.win.files / build.linux.files), and the
// Microsoft Store package (electron/main/msix.js, build/AppxManifest.xml, build/appx).
//
//   node tools/platform_test.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { server, registration, STORE_LAUNCH } = require("../electron/main/mcp/registration");
const msix = require("../electron/main/msix");

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

// ---- the Microsoft Store package ------------------------------------------------------

const ALIAS = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\scumble.exe";
const STORE = { platform: "win32", exe: "C:\\Program Files\\WindowsApps\\DenRakEiw.Scumble_0.1.27.0_x64__abcdefghjkmnp\\app\\Scumble.exe", launcher: "C:\\Program Files\\WindowsApps\\DenRakEiw.Scumble_0.1.27.0_x64__abcdefghjkmnp\\app\\resources\\app.asar\\electron\\main\\mcp\\launch.js", storeAlias: ALIAS };

check("the_store_copy_is_registered_by_its_alias_and_nothing_of_its_version_folder", () => {
    eq(server(STORE), { command: ALIAS, args: ["-e", STORE_LAUNCH], env: { ELECTRON_RUN_AS_NODE: "1" } });
    const code = registration("code", STORE), desk = registration("desktop", STORE);
    eq(code, `claude mcp add scumble -e ELECTRON_RUN_AS_NODE=1 -- "${ALIAS}" "-e" "${STORE_LAUNCH}"`, "code");
    eq(JSON.parse(desk), { mcpServers: { scumble: { command: ALIAS, args: ["-e", STORE_LAUNCH], env: { ELECTRON_RUN_AS_NODE: "1" } } } }, "desktop");
    for (const t of [code, desk]) if (/_0\.1\.|Program Files/.test(t)) throw new Error("the version folder leaked: " + t);
    // the code sits inside double quotes on a command line: no double quote, backslash, $ or backtick in it
    if (/["\\$`]/.test(STORE_LAUNCH)) throw new Error("the launch code needs quoting: " + STORE_LAUNCH);
});

check("the_store_alias_is_read_on_windows_only", () => {
    eq(server({ ...DEB, storeAlias: ALIAS }), server(DEB), "linux");
    eq(server({ ...WIN, storeAlias: "" }), server(WIN), "empty");
});

check("the_store_launch_code_loads_the_launcher_from_the_resources", () => {
    // what the alias runs, in Node mode: the code finds <resources>/app.asar/.../launch.js, which is given no
    // arguments and so starts the app with its default, --mcp
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-store-"));
    try {
        const at = path.join(dir, "app.asar", "electron", "main", "mcp");
        fs.mkdirSync(at, { recursive: true });
        fs.writeFileSync(path.join(at, "launch.js"), "process.stdout.write(JSON.stringify({ at: __filename, argv: process.argv.slice(2) }));");
        fs.writeFileSync(path.join(dir, "pre.js"), `process.resourcesPath = ${JSON.stringify(dir)};`);   // Electron sets it; plain node does not
        const run = (extra) => {
            const r = spawnSync(process.execPath, ["-r", path.join(dir, "pre.js"), ...server(STORE).args, ...extra], { encoding: "utf8" });
            if (r.status !== 0) throw new Error("exit " + r.status + ": " + r.stderr);
            return JSON.parse(r.stdout);
        };
        const out = run([]);
        eq(path.relative(dir, out.at), path.join("app.asar", "electron", "main", "mcp", "launch.js"), "launcher");
        eq(out.argv, [], "argv");
        // arguments after a -- reach the launcher where a file start puts them (tools/mcp_test.py --store)
        eq(run(["--", "--user-data-dir=x", "--cmd", "ping"]).argv, ["--user-data-dir=x", "--cmd", "ping"], "forwarded");
        if (!fs.readFileSync(path.join(ROOT, "electron", "main", "mcp", "launch.js"), "utf8").includes("FORWARD.length ? FORWARD : [\"--mcp\"]")) throw new Error("the launcher lost its --mcp default");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

check("the_publisher_id_is_the_one_windows_computes", () => {
    // PublisherId as Get-AppxPackage reported it on this machine (2026-09-23)
    for (const [pub, id] of [
        ["CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US", "8wekyb3d8bbwe"],
        ["CN=D6816951-877F-493B-B4EE-41AB9419C326", "56jybvy8sckqj"],
        ["CN=\"Slack Technologies, LLC\", O=\"Slack Technologies, LLC\", L=San Francisco, S=California, C=US", "8yrtsj140pw4g"],
        ["CN=24803D75-212C-471A-BC57-9EF86AB91435", "cv1g1gvanyjgm"],
    ]) eq(msix.publisherId(pub), id, pub);
});

check("the_store_identity_is_the_one_partner_center_assigned", () => {
    // Partner Center, Scumble > Product identity (2026-09-23): the family name it computed from these values
    const appx = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).build.appx;
    eq([appx.identityName, appx.publisher, appx.publisherDisplayName], ["DenRakEiw.Scumble", "CN=F2BCAA24-8A1E-43F6-9DFA-1E11616630F1", "DenRakEiw"], "identity");
    eq(`${appx.identityName}_${msix.publisherId(appx.publisher)}`, "DenRakEiw.Scumble_eh52rqbjjrbdj", "package family name");
});

check("the_package_is_read_from_the_manifest_next_to_the_app", () => {
    const tpl = fs.readFileSync(path.join(ROOT, "build", "AppxManifest.xml"), "utf8");
    const pub = "CN=\"Slack Technologies, LLC\", O=\"Slack Technologies, LLC\", L=San Francisco, S=California, C=US";
    const xml = tpl.replace("${identityName}", "Some.App").replace("${publisher}", pub);
    const seen = [];
    const p = msix.packageOf("D:\\layout\\app\\Scumble.exe", (f) => { seen.push(f); return xml; });
    eq(seen, ["D:\\layout\\AppxManifest.xml"], "manifest path");
    eq(p, { name: "Some.App", publisher: pub, publisherId: "8yrtsj140pw4g", family: "Some.App_8yrtsj140pw4g" }, "package");
    // an escaped publisher in double quotes reads the same
    eq(msix.identityOf(`<Identity Name="Some.App" Publisher="${pub.replace(/"/g, "&quot;")}" Version="1.0.0.0" />`), { name: "Some.App", publisher: pub }, "escaped");
    eq(msix.packageOf("C:\\Program Files\\Scumble\\Scumble.exe", () => { throw new Error("ENOENT"); }), null, "no manifest");
    eq(msix.packageOf("x", () => "<Package><Properties/></Package>"), null, "no identity");
});

check("explorer_is_given_the_folder_where_the_files_really_are", () => {
    const where = { family: "Some.App_8yrtsj140pw4g", appData: "C:\\Users\\u\\AppData\\Roaming", localAppData: "C:\\Users\\u\\AppData\\Local", exists: () => true };
    const cache = "C:\\Users\\u\\AppData\\Local\\Packages\\Some.App_8yrtsj140pw4g\\LocalCache";
    eq(msix.outside("C:\\Users\\u\\AppData\\Roaming\\Scumble Store\\plugins", where), cache + "\\Roaming\\Scumble Store\\plugins", "roaming");
    eq(msix.outside("c:\\users\\U\\appdata\\roaming\\Scumble Store", where), cache + "\\Roaming\\Scumble Store", "case");
    eq(msix.outside("C:\\Users\\u\\AppData\\Local\\Temp\\x", where), cache + "\\Local\\Temp\\x", "local");
    eq(msix.outside("D:\\ComfyUI\\models", where), "D:\\ComfyUI\\models", "elsewhere");
    eq(msix.outside(cache + "\\Roaming\\a", where), cache + "\\Roaming\\a", "already real");
    eq(msix.outside("C:\\Users\\u\\AppData\\Roaming\\Scumble\\plugins", { ...where, exists: () => false }), "C:\\Users\\u\\AppData\\Roaming\\Scumble\\plugins", "no private copy");
    eq(msix.outside("C:\\Users\\u\\AppData\\Roaming\\x", { ...where, family: "" }), "C:\\Users\\u\\AppData\\Roaming\\x", "not packaged");
    eq(msix.outside("C:\\Users\\u\\AppData\\RoamingX\\x", where), "C:\\Users\\u\\AppData\\RoamingX\\x", "a sibling is not inside");
});

check("only_the_store_package_counts_as_the_store", () => {
    eq(msix.isStore({ platform: "win32", windowsStore: true }), true, "store");
    eq(msix.isStore({ platform: "win32" }), false, "installer");
    eq(msix.isStore({ platform: "linux", windowsStore: true }), false, "linux");
    eq(msix.here({ platform: "win32", env: {}, execPath: "x" }), null, "no store, no redirection");
    eq(msix.storeUserData("C:\\Users\\u\\AppData\\Roaming"), "C:\\Users\\u\\AppData\\Roaming\\Scumble Store", "data folder");
    eq(msix.aliasPath("C:\\Users\\u\\AppData\\Local"), ALIAS, "alias");
});

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

check("the_store_manifest_carries_the_alias_and_only_macros_electron_builder_fills", () => {
    const appx = pkg.build.appx;
    eq(appx.customManifestPath, "AppxManifest.xml", "customManifestPath");
    const xml = fs.readFileSync(path.join(ROOT, "build", appx.customManifestPath), "utf8");
    const known = ["identityName", "arch", "publisher", "version", "displayName", "publisherDisplayName", "description", "logo", "resourceLanguages", "minVersion", "maxVersionTested", "capabilities", "applicationId", "executable", "backgroundColor", "square150x150Logo", "square44x44Logo", "lockScreen", "defaultTile", "splashScreen", "extensions"];
    const macros = [...xml.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
    const unknown = macros.filter((m) => !known.includes(m));
    if (unknown.length) throw new Error("electron-builder throws on " + unknown.join(", "));
    if (!xml.includes(`<desktop:ExecutionAlias Alias="${msix.ALIAS}" />`)) throw new Error("no execution alias " + msix.ALIAS);
    if (!/EntryPoint="Windows\.FullTrustApplication"/.test(xml) || !macros.includes("capabilities")) throw new Error("not a full-trust app");
    if (appx.electronUpdaterAware) throw new Error("the Store copy must not write an update feed");
    if (!/\.msix$/.test(appx.artifactName)) throw new Error("artifact: " + appx.artifactName);
});

check("every_tile_the_manifest_names_has_its_own_artwork", () => {
    const have = fs.readdirSync(path.join(ROOT, "build", "appx"));
    for (const base of ["StoreLogo", "Square44x44Logo", "Square150x150Logo", "Wide310x150Logo"]) {
        if (!have.some((f) => f.startsWith(base + ".scale-100."))) throw new Error("no " + base + " (electron-builder would put its sample artwork in)");
    }
    for (const n of [16, 24, 32, 48, 256]) if (!have.includes(`Square44x44Logo.targetsize-${n}_altform-unplated.png`)) throw new Error("no unplated taskbar icon at " + n);
});
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
    for (const f of [...(pkg.build.win.files || []), ...(pkg.build.linux.files || [])].filter((x) => typeof x === "string" && x.startsWith("!"))) {
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

check("a_platform_file_list_is_never_exclusions_alone", () => {
    // electron-builder takes a platform's `files` as the whole list: one that only excludes starts from
    // "everything" and shipped the repository (.claude/, CLAUDE.md, tools/, crates/, docs/) in 0.1.26
    const top = pkg.build.files;
    for (const plat of ["win", "linux"]) {
        const files = pkg.build[plat].files || [];
        const positive = files.filter((f) => typeof f !== "string" || !f.startsWith("!"));
        eq(positive, top, `${plat}.files carries the top-level list`);
    }
    if (!top.includes("docs/MANUAL.md") || top.some((f) => typeof f === "string" && /^docs\/\*|^docs\/\*\*/.test(f))) throw new Error("docs/: the manual alone");
});

check("the_built_package_holds_the_app_and_nothing_of_the_repository", () => {
    // only when a package was built here (npm run dist); CI's own build is checked by the same list
    const asar = path.join(ROOT, "dist", "win-unpacked", "resources", "app.asar");
    if (!fs.existsSync(asar)) return "no dist/win-unpacked here, skipped";
    let list;
    try { list = require("@electron/asar").listPackage(asar); } catch (err) { return "cannot read the asar (" + err.message + "), skipped"; }
    const top = [...new Set(list.map((f) => f.split(/[\\/]/)[1]))].sort();
    eq(top, ["LICENSE", "build", "docs", "electron", "node_modules", "package.json", "plugins", "prompts", "recipes", "renderer"], "top level");
    eq(list.filter((f) => /^[\\/]docs[\\/]/.test(f)).map((f) => f.replace(/\\/g, "/")), ["/docs/MANUAL.md"], "docs");
    return `${list.length} entries`;
});

check("chromium_keeps_english_and_german", () => {
    eq(pkg.build.electronLanguages, ["en-US", "de"], "electronLanguages");
});

console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
