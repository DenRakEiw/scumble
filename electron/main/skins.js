// Skins (docs/SKINS.md): a plugin folder without code. Its plugin.json says `"registers": ["skin"]`, its skin.css is
// loaded unlayered after the app's own CSS, and it changes the app's colours, fonts and shapes through the tokens
// (--sc-*) and free CSS. This module is plain Node (it requires no electron), so tools/skins_test.js runs it as it is:
// the manifest check plugins.js calls, which skin is in use, the virtual stylesheet main.js serves at
// scumble://app/skin.css, and the window's background. renderer/skins.js applies and checks the skin in the window.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** The token contract a skin is written against (renderer/editor/inpaint_theme.js has the same number). */
const SKIN_TOKENS_VERSION = 1;
/** The window's background in the default look (renderer/shell.css `html, body`). */
const DEFAULT_BACKGROUND = "#181818";
/** What a skin folder may serve: its stylesheet, pictures and fonts, never a script or a manifest. */
const SKIN_FILE_RE = /\.(css|png|jpe?g|webp|gif|svg|woff2?|ttf|otf)$/i;
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The skin part of a manifest whose `registers` holds "skin". `m` is the parsed plugin.json, `dir` the folder.
 * Returns { kind: "skin", entry: null, enabledByDefault: false, skin: { css, background, swatch, tokens }, warnings }
 * or { kind: "skin", error }: plugins.js spreads it over the common manifest fields.
 */
function readSkinManifest(m, dir) {
    const fail = (error) => ({ kind: "skin", error });
    if (Object.prototype.hasOwnProperty.call(m, "entry")) return fail('a skin carries no JavaScript: remove "entry"');
    const registers = Array.isArray(m.registers) ? m.registers.map(String) : [];
    const other = registers.filter((r) => r !== "skin");
    if (other.length) return fail(`a skin registers nothing else: remove ${other.map((r) => `"${r}"`).join(", ")} from "registers"`);
    const s = m.skin && typeof m.skin === "object" && !Array.isArray(m.skin) ? m.skin : {};
    if (s.css !== undefined && (typeof s.css !== "string" || !s.css)) return fail('"skin.css" must be the name of the stylesheet in the folder');
    const css = (s.css === undefined ? "skin.css" : s.css).replace(/\\/g, "/");
    if (css.startsWith("/") || /^[a-z]:/i.test(css) || path.isAbsolute(css) || css.includes("..")) return fail(`the stylesheet "${css}" must be a relative path inside the skin's folder`);
    if (!/\.css$/i.test(css)) return fail(`the stylesheet "${css}" must end in .css`);
    let isFile = false;
    try { isFile = fs.statSync(path.join(dir, css)).isFile(); } catch (_) { isFile = false; }
    if (!isFile) return fail(`the stylesheet "${css}" was not found in the skin's folder`);
    let background = DEFAULT_BACKGROUND;
    if (s.background !== undefined) {
        if (typeof s.background !== "string" || !HEX.test(s.background)) return fail(`"skin.background" must be a colour like #181818, not ${JSON.stringify(s.background)}`);
        background = s.background;
    }
    const swatch = Array.isArray(s.swatch) ? s.swatch.filter((c) => typeof c === "string" && HEX.test(c)).slice(0, 6) : [];
    const tokens = Number.isInteger(s.tokens) && s.tokens >= 1 ? s.tokens : 1;
    const warnings = [];
    if (tokens > SKIN_TOKENS_VERSION) warnings.push(`made for a newer Scumble (tokens ${tokens})`);
    return { kind: "skin", entry: null, enabledByDefault: false, skin: { css, background, swatch, tokens }, warnings };
}

/**
 * The skin in use: the entry of `list` (plugins.list()) the settings name, or null for the default look. Null when
 * the app was started with --no-skin, nothing is chosen, the chosen skin was switched off (appearance.refused), or no
 * usable skin has that id (gone, or its manifest has an error). The choice itself is kept in every case.
 */
function activeSkin({ argv, appearance, list } = {}) {
    if (Array.isArray(argv) && argv.includes("--no-skin")) return null;
    const a = appearance && typeof appearance === "object" ? appearance : {};
    const id = typeof a.skin === "string" ? a.skin : "";
    if (!id) return null;
    if (a.refused && typeof a.refused === "object" && a.refused.id === id) return null;
    return (Array.isArray(list) ? list : []).find((p) => p && p.id === id && p.kind === "skin" && !p.error) || null;
}

/**
 * The text of scumble://app/skin.css: an @import of the skin's stylesheet, whose relative url()s then resolve inside
 * its folder, or a comment for the default look. `v` makes every answer a new URL, so a switch or a reload never
 * gets a cached sheet.
 */
function sheetFor(skin, v) {
    if (!skin || !skin.skin || !skin.skin.css) return "/* the default look: no skin */\n";
    const css = String(skin.skin.css).split("/").map(encodeURIComponent).join("/");
    return `@import url("plugins/${encodeURIComponent(skin.id)}/${css}?v=${encodeURIComponent(String(v))}");\n`;
}

/** The window's background while the page loads (BrowserWindow backgroundColor). */
function backgroundFor(skin) {
    const b = skin && skin.skin && skin.skin.background;
    return typeof b === "string" && HEX.test(b) ? b : DEFAULT_BACKGROUND;
}

module.exports = { SKIN_TOKENS_VERSION, DEFAULT_BACKGROUND, SKIN_FILE_RE, readSkinManifest, activeSkin, sheetFor, backgroundFor };
