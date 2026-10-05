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

// ---- a portable copy (electron/main/portable.js, docs/PLAN_0_1_42.md P1) ----------------------------------------
//
// The full tier: this resolver decides where every byte of a start lands. A wrong answer at a packaged start would
// rotate the autosave of the user's %APPDATA%\Scumble and take its instance lock, so every rule is pinned here, and
// main.js's use of it is read from the source (set before log.install, the one setPath, the refusal).

const portable = require("../electron/main/portable");
const ZIP = "D:\\Tools\\Scumble\\Scumble.exe";
const has = (...files) => (p) => files.includes(p);
const BASE = { packaged: true, platform: "win32", execPath: ZIP, store: false, userDataSwitch: false, appData: "C:\\Users\\u\\AppData\\Roaming", exists: has("D:\\Tools\\Scumble\\portable.txt") };

check("a_marker_beside_the_exe_puts_the_data_beside_it", () => {
    eq(portable.dataDir(BASE), "D:\\Tools\\Scumble\\data", "dataDir");
    eq(portable.userData(BASE), { from: "portable", dir: "D:\\Tools\\Scumble\\data" }, "userData");
    eq([portable.MARKER, portable.DATA, portable.UNINSTALLER], ["portable.txt", "data", "Uninstall Scumble.exe"], "names");
});

check("no_marker_dev_or_linux_keep_electrons_folder", () => {
    eq(portable.dataDir({ ...BASE, exists: () => false }), null, "no marker");
    eq(portable.userData({ ...BASE, exists: () => false }), { from: "default", dir: null }, "no marker: the default");
    // the dev electron (node_modules\electron\dist\electron.exe) with a portable.txt beside it is still dev
    eq(portable.dataDir({ ...BASE, packaged: false, exists: () => true }), null, "dev");
    eq(portable.dataDir({ ...BASE, platform: "linux", execPath: "/opt/Scumble/scumble", exists: () => true }), null, "linux");
    eq(portable.dataDir({ ...BASE, execPath: "" }), null, "no exe path");
    // a marker that cannot be looked at is no marker
    eq(portable.dataDir({ ...BASE, exists: () => { throw new Error("EACCES"); } }), null, "exists throws");
    // only the marker beside the exe counts, not one in the data folder or above
    eq(portable.dataDir({ ...BASE, exists: has("D:\\Tools\\portable.txt", "D:\\Tools\\Scumble\\data\\portable.txt") }), null, "elsewhere");
});

check("a_user_data_dir_wins_over_the_store_and_the_marker", () => {
    eq(portable.dataDir({ ...BASE, userDataSwitch: true }), null, "dataDir");
    eq(portable.userData({ ...BASE, userDataSwitch: true }), { from: "switch", dir: null }, "the switch");
    eq(portable.userData({ ...BASE, userDataSwitch: true, store: true }), { from: "switch", dir: null }, "the switch over the Store");
});

check("the_store_wins_over_the_marker", () => {
    eq(portable.dataDir({ ...BASE, store: true }), null, "dataDir");
    eq(portable.userData({ ...BASE, store: true }), { from: "store", dir: "C:\\Users\\u\\AppData\\Roaming\\Scumble Store" }, "the Store's folder");
    eq(portable.userData({ ...BASE, store: true, exists: () => false }), { from: "store", dir: msix.storeUserData(BASE.appData) }, "the Store without a marker");
});

check("one_spelling_of_the_folder_a_subst_drive_or_a_junction", () => {
    // S: is a subst of D:\Tools: the marker is looked for, and the data put, where the folder really is (one pipe
    // name, one instance lock); a realpath that fails keeps the spelling the exe was started by
    const real = (p) => (p.toLowerCase() === "s:\\scumble" ? "D:\\Tools\\Scumble" : p);
    eq(portable.dataDir({ ...BASE, execPath: "S:\\Scumble\\Scumble.exe", realpath: real }), "D:\\Tools\\Scumble\\data", "subst");
    eq(portable.dataDir({ ...BASE, realpath: () => { throw new Error("EPERM"); } }), "D:\\Tools\\Scumble\\data", "realpath throws");
    eq(portable.dataDir({ ...BASE, execPath: "S:\\Scumble\\Scumble.exe", exists: has("S:\\Scumble\\portable.txt"), realpath: () => { throw new Error("x"); } }), "S:\\Scumble\\data", "fallback spelling");
});

check("only_an_nsis_install_installs_updates_itself", () => {
    const m = (o) => portable.updateMode({ packaged: true, store: false, portable: false, platform: "win32", installed: false, ...o });
    eq(m({ installed: true }), "install", "the uninstaller beside the exe");
    eq(m({}), "notify", "dist/win-unpacked, a zip with its marker deleted");
    eq(m({ portable: true }), "notify", "a portable copy");
    eq(m({ portable: true, installed: true }), "notify", "a marker put into an install folder");
    eq(m({ store: true, installed: true }), "store", "the Store");
    eq(m({ packaged: false, installed: true }), "dev", "dev");
    eq(m({ platform: "linux" }), "install", "linux as before");
    eq(portable.isInstalled("C:\\Users\\u\\AppData\\Local\\Programs\\Scumble\\Scumble.exe", has("C:\\Users\\u\\AppData\\Local\\Programs\\Scumble\\Uninstall Scumble.exe")), true, "installed");
    eq(portable.isInstalled(ZIP, has("D:\\Tools\\Scumble\\portable.txt")), false, "a zip");
    eq(portable.isInstalled(ZIP, () => { throw new Error("x"); }), false, "exists throws");
});

check("the_data_folder_is_made_and_proven_writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-portable-"));
    try {
        const data = path.join(dir, "Scumble", "data");
        eq(portable.prepare(data, fs), null, "a folder that can be written");
        if (!fs.statSync(data).isDirectory()) throw new Error("no data folder");
        eq(fs.readdirSync(data), [], "the probe is left behind");
        eq(portable.prepare(data, fs), null, "the second start");
        // a data folder under a file cannot be made: the error comes back, nothing is thrown
        fs.writeFileSync(path.join(dir, "file"), "x");
        const err = portable.prepare(path.join(dir, "file", "data"), fs);
        if (!err || !err.code) throw new Error("a folder under a file: " + JSON.stringify(err));
        // a folder that exists but refuses the probe (an ACL that denies writing; accessSync(W_OK) would not see it)
        const deny = { mkdirSync: () => {}, writeFileSync: () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); }, unlinkSync: () => {} };
        const e2 = portable.prepare("C:\\Program Files\\Scumble\\data", deny);
        eq(e2 && e2.code, "EPERM", "the denied probe");
        const box = portable.refusal("C:\\Program Files\\Scumble\\data", e2);
        eq(box.title, "Scumble cannot use its folder", "title");
        if (!box.text.includes("C:\\Program Files\\Scumble\\data") || !box.text.includes("(EPERM)") || !/Move the Scumble folder/.test(box.text)) throw new Error("the message: " + box.text);
        // a probe that was written but cannot be removed still counts as writable
        const sticky = { mkdirSync: () => {}, writeFileSync: () => {}, unlinkSync: () => { throw new Error("EBUSY"); } };
        eq(portable.prepare("X:\\data", sticky), null, "the probe stays");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

check("the_marker_text_says_what_the_file_does", () => {
    const t = portable.MARKER_TEXT;
    for (const s of ["\"data\" folder", "%APPDATA%\\Scumble", "type them again", "does not update itself", "where you unpacked this one", "Delete this file"]) if (!t.includes(s)) throw new Error("the marker lacks " + JSON.stringify(s));
    if (/[^\x00-\x7F]/.test(t)) throw new Error("the marker is not plain ASCII");
});

check("main_sets_the_folder_from_the_resolver_before_anything_reads_it", () => {
    const main = fs.readFileSync(path.join(ROOT, "electron", "main", "main.js"), "utf8");
    const set = main.indexOf('app.setPath("userData", DATA_HOME.dir)');
    const logAt = main.indexOf("log.install(");
    const call = main.indexOf("portable.userData({");
    if (set < 0 || call < 0) throw new Error("main.js does not set the folder from portable.userData");
    if (!(call < set && set < logAt)) throw new Error(`the order: resolver ${call}, setPath ${set}, log.install ${logAt}`);
    // one rule for the folder: no other setPath of userData, nothing reads it before
    eq((main.match(/app\.setPath\("userData"/g) || []).length, 1, "setPath(userData) calls");
    if (main.slice(0, set).includes('getPath("userData")')) throw new Error("the folder is read before it is set");
    if (main.indexOf('require("./settings")') < set) throw new Error("settings is loaded before the folder is set");
    const args = main.slice(call, main.indexOf("});", call));
    for (const want of ["packaged: app.isPackaged", "platform: process.platform", "execPath: process.execPath", "store: msix.isStore()", 'userDataSwitch: app.commandLine.hasSwitch("user-data-dir")', 'appData: app.getPath("appData")', "exists: fs.existsSync", "realpath: fs.realpathSync.native"]) {
        if (!args.includes(want)) throw new Error("the resolver is not given " + want);
    }
    // a folder that cannot be written stops the start, with the box, before setPath; no fall back
    const guard = main.slice(call, set);
    if (!/portable\.prepare\(DATA_HOME\.dir, fs\)/.test(guard) || !/dialog\.showErrorBox\(box\.title, box\.text\)/.test(guard) || !/process\.exit\(1\)/.test(guard)) throw new Error("no refusal before setPath");
    // the updater's mode, the jump list and app:info
    if (!/new Updater\(\{ mode: portable\.updateMode\(\{ packaged: app\.isPackaged, store: msix\.isStore\(\), portable: PORTABLE, platform: process\.platform, installed: portable\.isInstalled\(process\.execPath, fs\.existsSync\) \}\) \}\)/.test(main)) throw new Error("the updater is not given its mode");
    if (!/if \(!PORTABLE\) \{ try \{ app\.addRecentDocument\(file\);/.test(main)) throw new Error("a portable copy adds jump list entries");
    if (!/portable: PORTABLE, dataDir: PORTABLE \? DATA_HOME\.dir : null/.test(main)) throw new Error("app:info does not say portable");
});

// ---- a key stored on another PC or Windows account (electron/main/keys.js) ---------------------------------------

check("a_key_this_account_cannot_decrypt_reads_as_stale_and_is_never_rewritten", () => {
    const Module = require("node:module");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-keys-"));
    const keysPath = require.resolve("../electron/main/keys");
    const orig = Module._load;
    // DPAPI played by a stub: this account reads "mine:" ciphertexts; another account's ("theirs:") throw as
    // safeStorage.decryptString does ("Error while decrypting the ciphertext ...")
    const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (v) => Buffer.from("mine:" + v),
        decryptString: (b) => { const s = b.toString(); if (!s.startsWith("mine:")) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString."); return s.slice(5); },
    };
    Module._load = function (request, ...rest) {
        if (request === "electron") return { app: { getPath: () => dir }, safeStorage };
        return orig.call(this, request, ...rest);
    };
    delete require.cache[keysPath];
    const warn = console.warn;
    console.warn = () => {};
    try {
        const keys = require("../electron/main/keys");
        const file = path.join(dir, "secrets.json");
        const b64 = (s) => Buffer.from(s).toString("base64");
        fs.writeFileSync(file, JSON.stringify({ fal: { data: b64("mine:fal-key-123456"), hint: "3456", time: 1 }, bfl: { data: b64("theirs:bfl-key-999999"), hint: "9999", time: 2 } }, null, 2) + "\n");
        const before = fs.readFileSync(file);
        eq(keys.describe("fal"), { name: "fal", set: true, hint: "3456", time: 1, stale: false }, "a key of this account");
        eq(keys.describe("bfl"), { name: "bfl", set: true, hint: "9999", time: 2, stale: true }, "a key of another account");
        eq(keys.describe("gemini"), { name: "gemini", set: false, hint: "", time: 0, stale: false }, "no key");
        const l = keys.list();
        eq([l.keys.fal.stale, l.keys.bfl.stale, l.backend], [false, true, process.platform === "win32" ? "dpapi" : process.platform === "linux" ? "unknown" : "keychain"], "list");
        eq(keys.get("bfl"), "", "get of a stale key");
        if (!fs.readFileSync(file).equals(before)) throw new Error("describe / list / get rewrote secrets.json");
        // the run's text names it (providers/util.js noKeyText, what providers/index.js and llm.js throw)
        const { noKeyText } = require("../electron/main/providers/util");
        if (!/stored on another PC or Windows account, so it cannot be read here: type it again under Settings › API providers\./.test(noKeyText("Black Forest Labs", true))) throw new Error("the stale text: " + noKeyText("x", true));
        eq(noKeyText("fal.ai", false), "No API key for fal.ai. Add it under Settings › API providers.", "the missing text");
        // the user's new key replaces it, through set()
        eq(keys.set("bfl", "bfl-new-key-123").stale, false, "a new key is read");
        eq(keys.get("bfl"), "bfl-new-key-123", "the new key");
        // with no credential store nothing can be told: not stale
        safeStorage.isEncryptionAvailable = () => false;
        fs.writeFileSync(file, before);
        eq(keys.describe("bfl").stale, false, "no store");
    } finally {
        console.warn = warn;
        Module._load = orig;
        delete require.cache[keysPath];
        fs.rmSync(dir, { recursive: true, force: true });
    }
    // every run that needs a key says so (no "No API key" text of their own left)
    for (const f of [path.join("providers", "index.js"), "llm.js"]) {
        const src = fs.readFileSync(path.join(ROOT, "electron", "main", f), "utf8");
        if (/No API key for/.test(src)) throw new Error(f + " still writes its own no-key text");
        if (!/noKeyText\([^)]*keys\.describe\([^)]*\)\)?\.stale\)/.test(src)) throw new Error(f + " does not ask for the stale flag");
    }
});

// ---- the portable zip (tools/portable_zip.js, docs/PLAN_0_1_42.md P2) ---------------------------------------------
// A fake win-unpacked (an asar with its package.json, the update feed, a locale) in a temp folder; the zip is read back
// by its own central directory, not by the tar that wrote it.

const zlib = require("node:zlib");
const pzip = require("./portable_zip");
const FEED = "owner: DenRakEiw\nrepo: scumble\nprovider: github\nreleaseType: draft\nupdaterCacheDirName: scumble-updater\n";

/** An asar as the app's: the 8-byte size pickle, the header pickle with its JSON, the files after it. */
function writeAsar(file, files) {
    const header = { files: {} };
    const bodies = [];
    let offset = 0;
    for (const [name, data] of Object.entries(files)) {
        header.files[name] = { size: data.length, offset: String(offset) };
        offset += data.length;
        bodies.push(data);
    }
    const json = Buffer.from(JSON.stringify(header));
    const padded = Math.ceil(json.length / 4) * 4;
    const pickle = Buffer.alloc(8 + padded);
    pickle.writeUInt32LE(4 + padded, 0);
    pickle.writeInt32LE(json.length, 4);
    json.copy(pickle, 8);
    const size = Buffer.alloc(8);
    size.writeUInt32LE(4, 0);
    size.writeUInt32LE(pickle.length, 4);
    fs.writeFileSync(file, Buffer.concat([size, pickle, ...bodies]));
}

function fakeUnpacked(dir, { version = "9.9.9", feed = FEED, exe = true, asar = true, data = false } = {}) {
    fs.mkdirSync(path.join(dir, "resources"), { recursive: true });
    fs.mkdirSync(path.join(dir, "locales"), { recursive: true });
    if (exe) fs.writeFileSync(path.join(dir, "Scumble.exe"), "MZ not an exe");
    fs.writeFileSync(path.join(dir, "locales", "en-US.pak"), "pak");
    if (feed != null) fs.writeFileSync(path.join(dir, "resources", "app-update.yml"), feed);
    if (asar) writeAsar(path.join(dir, "resources", "app.asar"), { "package.json": Buffer.from(JSON.stringify({ name: "scumble", version })) });
    if (data) {
        fs.mkdirSync(path.join(dir, "data"));
        fs.writeFileSync(path.join(dir, "data", "settings.json"), "{}");
    }
}

/** The entries of a zip by its central directory; `read` inflates one. */
function readZip(file) {
    const b = fs.readFileSync(file);
    let end = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (b.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error("not a zip: " + file);
    const entries = new Map();
    let p = b.readUInt32LE(end + 16);
    for (let k = b.readUInt16LE(end + 10); k > 0; k--) {
        if (b.readUInt32LE(p) !== 0x02014b50) throw new Error("a broken central directory");
        const nlen = b.readUInt16LE(p + 28);
        entries.set(b.toString("utf8", p + 46, p + 46 + nlen), { method: b.readUInt16LE(p + 10), csize: b.readUInt32LE(p + 20), local: b.readUInt32LE(p + 42) });
        p += 46 + nlen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
    }
    const read = (name) => {
        const e = entries.get(name);
        if (!e) throw new Error("no entry " + name);
        const at = e.local + 30 + b.readUInt16LE(e.local + 26) + b.readUInt16LE(e.local + 28);
        const raw = b.subarray(at, at + e.csize);
        return e.method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    };
    return { names: [...entries.keys()], read };
}

function tree(dir, base = dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...tree(p, base));
        else out.push(path.relative(base, p) + ":" + fs.statSync(p).size);
    }
    return out.sort();
}

check("the_portable_zip_is_one_scumble_folder_with_the_marker_and_no_data", () => {
    if (process.platform !== "win32") return; // Windows' tar.exe writes the zip
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-pzip-"));
    try {
        const src = path.join(base, "win-unpacked"), out = path.join(base, "dist");
        fakeUnpacked(src);
        // a stage from an earlier run that was started by hand (its data folder), and an old file of the zip's name
        fs.mkdirSync(path.join(out, "portable", "Scumble", "data"), { recursive: true });
        fs.writeFileSync(path.join(out, "portable", "Scumble", "data", "secrets.json"), "{\"fal\":1}");
        fs.writeFileSync(path.join(out, pzip.zipName("9.9.9")), "not a zip");
        const before = tree(src);
        const r = pzip.build({ src, out, version: "9.9.9" });
        eq(r.zip, path.join(out, "Scumble-9.9.9-portable-win-x64.zip"), "where it lands");
        const z = readZip(r.zip);
        const outside = z.names.filter((n) => !n.startsWith("Scumble/"));
        if (outside.length) throw new Error("entries outside the top folder: " + outside.join(", "));
        if (z.names.some((n) => n.startsWith("Scumble/data"))) throw new Error("the zip carries a data folder");
        eq(z.names.filter((n) => !n.endsWith("/")).sort(), ["Scumble/Scumble.exe", "Scumble/locales/en-US.pak", "Scumble/portable.txt", "Scumble/resources/app-update.yml", "Scumble/resources/app.asar"], "the files");
        if (!z.read("Scumble/portable.txt").equals(Buffer.from(portable.MARKER_TEXT, "utf8"))) throw new Error("the marker is not MARKER_TEXT");
        eq(z.read("Scumble/Scumble.exe").toString(), "MZ not an exe", "the exe");
        eq(z.read("Scumble/resources/app-update.yml").toString(), FEED, "the feed");
        eq([r.files, fs.existsSync(path.join(out, "portable"))], [5, false], "files counted, the stage removed");
        eq(tree(src), before, "win-unpacked untouched (no marker added there)");
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

check("the_portable_zip_refuses_a_layout_it_cannot_ship", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-pzip-"));
    try {
        const cases = [
            ["no-exe", { exe: false }, /no Scumble\.exe in .*run npm run dist first/],
            ["no-feed", { feed: null }, /no resources\\app-update\.yml in .*dist:store/],
            ["another-feed", { feed: "provider: generic\nurl: https://example.com/\n" }, /does not name the GitHub releases of DenRakEiw\/scumble/],
            ["another-version", { version: "9.9.8" }, /holds version 9\.9\.8, package\.json says 9\.9\.9/],
            ["no-asar", { asar: false }, /cannot read the version of resources\\app\.asar/],
            ["a-data-folder", { data: true }, /has a "data" folder .*settings and keys/],
        ];
        for (const [what, o, re] of cases) {
            const src = path.join(base, what), out = path.join(base, "out-" + what);
            fakeUnpacked(src, o);
            let err = null;
            // a tar that does not exist: a refusal must come before anything is staged or zipped
            try { pzip.build({ src, out, version: "9.9.9", tar: path.join(base, "no-tar.exe") }); } catch (e) { err = e; }
            if (!err || !err.refused || !re.test(err.message)) throw new Error(`${what}: ${err ? err.message : "built a zip"}`);
            if (fs.existsSync(out)) throw new Error(`${what}: wrote ${out}`);
        }
        const ok = path.join(base, "ok");
        fakeUnpacked(ok);
        eq(pzip.problems(ok, "9.9.9"), [], "a sound layout");
        eq(pzip.builtVersion(ok), "9.9.9", "the asar's version");
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

check("the_portable_zip_runs_from_npm_and_goes_into_the_tag_build_after_the_installer", () => {
    eq(pkg.scripts["dist:portable"], "node tools/portable_zip.js", "npm run dist:portable");
    // electron-builder's own zip and one-file portable targets stay out (a marker through extraFiles would land in
    // the NSIS install too)
    eq((pkg.build.win.target || []).map((t) => t.target || t), ["nsis"], "the Windows targets");
    const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8").replace(/\r\n/g, "\n");
    const win = yml.slice(yml.indexOf("\n  windows:"), yml.indexOf("\n  linux:"));
    const at = (s) => { const i = win.indexOf(s); if (i < 0) throw new Error("the windows job lacks " + s); return i; };
    const order = [
        at("name: Build installer"),
        at("name: Scumble-windows\n"),
        at("run: node tools/portable_zip.js"),
        at("path: dist/*-portable-win-x64.zip"),
        at(`gh release upload "$GITHUB_REF_NAME" "dist/${pzip.zipName("${GITHUB_REF_NAME#v}")}" --clobber`),
    ];
    for (let i = 1; i < order.length; i++) if (order[i] <= order[i - 1]) throw new Error("the windows job's order: " + order.join(", "));
    const step = win.slice(win.lastIndexOf("- name:", order[4]), order[4]);
    if (!/if: startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(step)) throw new Error("the upload to the draft runs without a tag");
});

console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
