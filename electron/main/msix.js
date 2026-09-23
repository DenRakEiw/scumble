// What changes when Scumble runs as the Microsoft Store package (MSIX, docs/STORE.md).
// Plain Node, no Electron: main.js passes in what it knows, tools/platform_test.js checks it.
//
// A packaged (MSIX) desktop app runs from C:\Program Files\WindowsApps\<Name>_<Version>_<Arch>__<PublisherId>,
// a folder whose name changes with every update, and Windows redirects what the app writes under
// AppData: a file the package creates there lands in
// %LOCALAPPDATA%\Packages\<Name>_<PublisherId>\LocalCache\Roaming (or \Local), and only the app sees
// it at the path it asked for. Three things follow:
//
// - The Store copy keeps its data in a folder of its own ("Scumble Store" under %APPDATA%), so it is
//   created by the package and redirected as a whole. Sharing "Scumble" with an installed GitHub copy
//   would split it: Windows lets a package change a file that already exists outside, but puts every
//   new file in the private copy, so settings would be shared and the file mirror half private.
// - Every folder Scumble opens in Explorer (plugins, recipes, logs, local files) is opened at the
//   place the files really are, because Explorer runs outside the package and sees none of it.
// - An MCP client is given the execution alias (%LOCALAPPDATA%\Microsoft\WindowsApps\scumble.exe),
//   which stays when the version folder changes, with the launcher found at run time next to the exe
//   the alias starts (mcp/registration.js).
// And the Store updates its copy itself: electron-updater stays off (updater.js).
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const STORE_DATA = "Scumble Store";
const ALIAS = "scumble.exe";
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** True in the Store package (Electron sets process.windowsStore there). */
function isStore(proc = process) {
    return proc.platform === "win32" && proc.windowsStore === true;
}

/**
 * Windows' publisher id: the first 64 bits of SHA-256 over the publisher's name in UTF-16LE, as 13
 * characters of its base32 alphabet (checked against Get-AppxPackage's PublisherId, docs/STORE.md).
 */
function publisherId(publisher) {
    const hash = crypto.createHash("sha256").update(Buffer.from(String(publisher), "utf16le")).digest();
    let bits = "";
    for (const b of hash.subarray(0, 8)) bits += b.toString(2).padStart(8, "0");
    bits += "0";
    let out = "";
    for (let i = 0; i < 65; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5), 2)];
    return out;
}

/** Name and Publisher of a manifest's Identity element, or null. */
function identityOf(xml) {
    const el = /<Identity\b[^>]*>/.exec(String(xml || ""));
    if (!el) return null;
    const attr = (k) => {
        const m = new RegExp(`\\s${k}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(el[0]);
        return m ? unescapeXml(m[1] !== undefined ? m[1] : m[2]) : null;
    };
    const name = attr("Name");
    const publisher = attr("Publisher");
    return name && publisher ? { name, publisher } : null;
}

function unescapeXml(s) {
    return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * The package this exe belongs to, from the AppxManifest.xml at the package's root (the exe is
 * app\Scumble.exe below it), or null. Read from the manifest rather than the folder's name because a
 * registered development layout (docs/STORE.md, the local test) runs from any folder.
 */
function packageOf(execPath, readFile = (f) => fs.readFileSync(f, "utf8")) {
    let xml;
    try { xml = readFile(path.win32.join(path.win32.dirname(path.win32.dirname(String(execPath))), "AppxManifest.xml")); } catch (_) { return null; }
    const id = identityOf(xml);
    if (!id) return null;
    const pid = publisherId(id.publisher);
    return { name: id.name, publisher: id.publisher, publisherId: pid, family: `${id.name}_${pid}` };
}

/** The user data folder the Store copy uses (under the AppData the app sees). */
function storeUserData(appData) {
    return path.win32.join(appData, STORE_DATA);
}

/**
 * Where a path the app uses really is on disk, for a process outside the package (Explorer).
 * Only paths under AppData are redirected, and only when the redirected copy exists: a folder the
 * user linked from elsewhere (a ComfyUI models folder) or one an unpackaged Scumble created is real.
 * @param {string} p
 * @param {{ family: string, appData: string, localAppData: string, exists?: (p: string) => boolean }} where
 */
function outside(p, where) {
    if (!p || !where || !where.family) return p;
    const exists = where.exists || fs.existsSync;
    const w = path.win32;                              // Windows paths wherever the test runs; relative() ignores case there
    const under = (base) => {
        const rel = w.relative(base, p);
        return rel === "" || (!rel.startsWith("..") && !w.isAbsolute(rel)) ? rel : null;
    };
    if (under(w.join(where.localAppData, "Packages")) !== null) return p;   // already the real place
    const cache = w.join(where.localAppData, "Packages", where.family, "LocalCache");
    for (const [base, sub] of [[where.appData, "Roaming"], [where.localAppData, "Local"]]) {
        const rel = under(base);
        if (rel === null) continue;
        const real = w.join(cache, sub, rel);
        return exists(real) ? real : p;
    }
    return p;
}

/** outside()'s `where` for this process, or null when it is not the Store package. */
function here(proc = process) {
    if (!isStore(proc)) return null;
    const pkg = packageOf(proc.execPath);
    if (!pkg) return null;
    return { family: pkg.family, appData: proc.env.APPDATA || "", localAppData: proc.env.LOCALAPPDATA || "" };
}

/** A folder as Explorer has to be given it: unchanged outside the Store package. */
function forExplorer(p) {
    const where = here();
    return where ? outside(p, where) : p;
}

/** The execution alias an MCP client starts (the manifest's desktop:ExecutionAlias). */
function aliasPath(localAppData) {
    return path.win32.join(localAppData, "Microsoft", "WindowsApps", ALIAS);
}

module.exports = { isStore, publisherId, identityOf, packageOf, storeUserData, outside, here, forExplorer, aliasPath, STORE_DATA, ALIAS };
