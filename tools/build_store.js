// Builds the Microsoft Store package (MSIX) from the same app as the GitHub installer
// (docs/STORE.md, docs/CODE_SIGNING_POLICY.md).
//
//   node tools/build_store.js          the package for Partner Center: its identity has to be in
//                                      package.json (build.appx.identityName / publisher /
//                                      publisherDisplayName, from the app's Product identity page)
//   node tools/build_store.js --test   a package to install here: a test identity whose publisher
//                                      carries Windows' "unsigned" OID, so
//                                      Add-AppxPackage -AllowUnsigned takes it without a certificate
//
// The package is not signed by us either way; the Store signs its copy after certification.
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { build, Platform, Arch } = require("electron-builder");
const { getWindowsKitsBundle } = require("app-builder-lib/out/toolsets/windows");

const ROOT = path.resolve(__dirname, "..");
const pkg = require(path.join(ROOT, "package.json"));
const TEST = process.argv.includes("--test");
// electron-builder's toolset with the Windows Kits 10.0.26100 tools; the default (legacy) one carries a
// makeappx from 2019
const WIN_CODE_SIGN = "1.1.0";

// Windows 11 installs a package unsigned when its publisher holds this OID (Add-AppxPackage -AllowUnsigned).
const UNSIGNED_OID = "OID.2.25.311729368913984317654407730594956997722=1";
const TEST_IDENTITY = {
    identityName: "DenRakEiw.ScumbleTest",
    publisher: `CN=Scumble Test Build, ${UNSIGNED_OID}`,
    publisherDisplayName: "DenRakEiw",
    artifactName: "Scumble-${version}-test.msix",
};

/**
 * makeappx and makepri from electron-builder's Windows Kits bundle, copied next to the output.
 * Started from the tool cache under %LOCALAPPDATA% they refused to start here (2026-09-23: "the
 * side-by-side configuration is invalid", the private assembly next to makeappx.exe not found),
 * and the same files ran from a folder on the project's drive.
 */
async function stageKit() {
    const { kit } = await getWindowsKitsBundle({ winCodeSign: WIN_CODE_SIGN, arch: Arch.x64 });
    const dir = path.join(ROOT, "dist", ".store-kit");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(kit, dir, { recursive: true });
    return dir;
}

async function main() {
    const appx = (pkg.build && pkg.build.appx) || {};
    if (!TEST) {
        const missing = ["identityName", "publisher", "publisherDisplayName"].filter((k) => !appx[k]);
        if (missing.length) {
            console.error(`build_store: package.json build.appx lacks ${missing.join(", ")}.`);
            console.error("They come from Partner Center (the app's Product identity page); see docs/STORE.md.");
            console.error("For a package to install on this machine: node tools/build_store.js --test");
            process.exit(2);
        }
    }
    process.env.ELECTRON_BUILDER_WINDOWS_KITS_PATH = await stageKit();
    const files = await build({
        projectDir: ROOT,
        targets: Platform.WINDOWS.createTarget(["appx"], 1 /* x64 */),
        publish: "never",
        config: { toolsets: { winCodeSign: WIN_CODE_SIGN }, ...(TEST ? { appx: TEST_IDENTITY } : {}) },
    });
    for (const f of files) console.log("built", f);
}

main().catch((e) => { console.error(e); process.exit(1); });
