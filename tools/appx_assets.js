// Renders the MSIX tile and logo assets (build/appx/*.png) from the logo's SVG sources.
// electron-builder's appx target maps every file in build/appx into the package's assets
// folder and runs makepri over them, so the scale and targetsize variants below are what
// Windows picks from: the Start menu's list and the taskbar take Square44x44Logo at their
// target size (16 / 24 px are drawn from icon-small.svg, as in build/icon.ico), tiles take
// Square150x150Logo and Wide310x150Logo, the Store and the installer take StoreLogo.
//
//   ./node_modules/.bin/electron tools/appx_assets.js
//
// Electron is the rasteriser: there is no SVG renderer on this machine otherwise.
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "build", "appx");
const SRC = {
    full: fs.readFileSync(path.join(ROOT, "build", "icon.svg"), "utf8"),
    small: fs.readFileSync(path.join(ROOT, "build", "icon-small.svg"), "utf8"),
    plain: fs.readFileSync(path.join(ROOT, "build", "icon-plain.svg"), "utf8"),   // no background: tiles get the manifest's BackgroundColor
};

// [file, width, height, source, share of the height the mark takes]
const ASSETS = [];
for (const [s, n] of [[100, 50], [200, 100], [400, 200]]) ASSETS.push([`StoreLogo.scale-${s}.png`, n, n, "full", 1]);
for (const [s, n] of [[100, 44], [200, 88], [400, 176]]) ASSETS.push([`Square44x44Logo.scale-${s}.png`, n, n, "full", 1]);
for (const n of [16, 24, 32, 48, 256]) {
    const src = n <= 24 ? "small" : "full";
    ASSETS.push([`Square44x44Logo.targetsize-${n}.png`, n, n, src, 1]);
    ASSETS.push([`Square44x44Logo.targetsize-${n}_altform-unplated.png`, n, n, src, 1]);
}
for (const [s, n] of [[100, 150], [200, 300], [400, 600]]) ASSETS.push([`Square150x150Logo.scale-${s}.png`, n, n, "plain", 0.66]);
for (const [s, k] of [[100, 1], [200, 2], [400, 4]]) ASSETS.push([`Wide310x150Logo.scale-${s}.png`, 310 * k, 150 * k, "plain", 0.66]);

async function main() {
    app.disableHardwareAcceleration();
    await app.whenReady();
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL("data:text/html,<!doctype html><body></body>");
    fs.mkdirSync(OUT, { recursive: true });
    for (const [file, w, h, src, share] of ASSETS) {
        const svg = Buffer.from(SRC[src]).toString("base64");
        const url = await win.webContents.executeJavaScript(`(async () => {
            const img = new Image();
            img.src = "data:image/svg+xml;base64,${svg}";
            await new Promise((ok, no) => { img.onload = ok; img.onerror = no; });
            const c = document.createElement("canvas");
            c.width = ${w}; c.height = ${h};
            const g = c.getContext("2d");
            g.imageSmoothingQuality = "high";
            const s = Math.round(${h} * ${share});
            g.drawImage(img, Math.round((${w} - s) / 2), Math.round((${h} - s) / 2), s, s);
            return c.toDataURL("image/png");
        })()`);
        fs.writeFileSync(path.join(OUT, file), Buffer.from(url.split(",")[1], "base64"));
        console.log(file, `${w}x${h}`);
    }
    app.quit();
}

main().catch((e) => { console.error(e); app.exit(1); });
