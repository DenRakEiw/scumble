// Renders the Microsoft Store listing's logo and art (docs/STORE_LISTING.md) from the logo's SVGs into
// dist/store-listing/: the 1:1 Store logos (300, 150 and 71 px) and the 16:9 hero (1920 x 1080). PNG, as Partner Center takes it.
//
//   ./node_modules/.bin/electron tools/store_art.js
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "dist", "store-listing");
const FULL = fs.readFileSync(path.join(ROOT, "build", "icon.svg"), "utf8");
const PLAIN = fs.readFileSync(path.join(ROOT, "build", "icon-plain.svg"), "utf8");
const BG = "#1B1714";
const INK = "#EFE7DA";

// [file, width, height, source, mark size as a share of the smaller side, mark centre y as a share of the height, wordmark]
const ART = [
    ["store-logo-300x300.png", 300, 300, "full", 1, 0.5, false],
    ["store-logo-150x150.png", 150, 150, "full", 1, 0.5, false],
    ["store-logo-71x71.png", 71, 71, "full", 1, 0.5, false],
    // the box art and the poster are made from the mascot drafts instead (docs/STORE_LISTING.md), not here
    ["hero-1920x1080.png", 1920, 1080, "plain", 0.5, 0.42, true],
];

async function main() {
    app.disableHardwareAcceleration();
    await app.whenReady();
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL("data:text/html,<!doctype html><body></body>");
    fs.mkdirSync(OUT, { recursive: true });
    for (const [file, w, h, src, share, cy, word] of ART) {
        const svg = Buffer.from(src === "full" ? FULL : PLAIN).toString("base64");
        const url = await win.webContents.executeJavaScript(`(async () => {
            const img = new Image();
            img.src = "data:image/svg+xml;base64,${svg}";
            await new Promise((ok, no) => { img.onload = ok; img.onerror = no; });
            const c = document.createElement("canvas");
            c.width = ${w}; c.height = ${h};
            const g = c.getContext("2d");
            g.imageSmoothingQuality = "high";
            if (${JSON.stringify(src)} === "plain") { g.fillStyle = ${JSON.stringify(BG)}; g.fillRect(0, 0, ${w}, ${h}); }
            const s = Math.round(Math.min(${w}, ${h}) * ${share});
            g.drawImage(img, Math.round((${w} - s) / 2), Math.round(${h} * ${cy} - s / 2), s, s);
            if (${word}) {
                g.fillStyle = ${JSON.stringify(INK)};
                g.textAlign = "center";
                g.textBaseline = "middle";
                g.font = "600 " + Math.round(Math.min(${w}, ${h}) * 0.13) + "px 'Segoe UI', system-ui, sans-serif";
                g.fillText("Scumble", ${w} / 2, ${h} * ${cy} + s / 2 + Math.min(${w}, ${h}) * 0.06);
            }
            return c.toDataURL("image/png");
        })()`);
        fs.writeFileSync(path.join(OUT, file), Buffer.from(url.split(",")[1], "base64"));
        console.log(file, `${w}x${h}`);
    }
    app.quit();
}

main().catch((e) => { console.error(e); app.exit(1); });
