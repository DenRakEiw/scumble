"""Skins (docs/SKINS.md): the light gate.

No ComfyUI and no key. First `node tools/skins_test.js` (the tokens in the app's sources, protect.css and the layers,
the shipped skins' manifests and tokens, electron/main/skins.js), then the app:

1. default_look_declares_nothing - no skin at start: no token has a value on :root, protect.css is the first sheet,
   the editor's style sits in `@layer app`, skin.css brings no rule, the canvas colours are the old literals;
3. skins_are_listed_not_loaded - 90s and Duck are under Settings > Appearance (a radio each, beside Default) and in
   list_plugins as `kind: "skin"`, never loaded as code, not under Settings > Plugins; their folder serves the
   stylesheet and not plugin.json;
4. a_switch_is_live - 90s applies without a reload (the same window, the same editors), the tokens, the body and the
   rulers' THEME colour follow; under Duck the Settings dialog's backdrop is Duck's;
7. the_choice_survives_a_reload - Duck is still there after a window reload, and its sheet was in before the first
   paint (or, where the window reports no resource timing, before DOMContentLoaded);
8. broken_skins_are_reported - a skin with an entry, one without its stylesheet and one in a folder that is no valid
   id are error rows with their radios disabled, a plugin.json that does not parse is an error under Plugins, and
   main refuses every one of them; the entry never ran;
11. the_hostile_skin_cannot_touch_the_protected - a skin that attacks the assistant's question, the masked keys, the
   picture's surround and the closed dialogs applies, and none of those change: a replica of the question, drawn by
   renderer/skins.js protectAsk (a shadow root, the top layer while open), computes the same look as in the default
   look, guardAsk() lets the skin stay, a real screenshot under its Allow button shows the button and not the red a
   shadow of the skin paints over everything else, and Settings > Appearance lists what the lint found;
12. a_skin_that_escapes_is_switched_off - a skin that squeezes the chat to nothing is switched off by guardAsk(),
   remembered as refused, the default look is back and the app log has the line;
13. a_skin_that_hides_the_question_later_is_switched_off - a skin whose animation squeezes the chat three seconds
   after it applies passes the question's first check and is switched off by the check that repeats while it is open.

The step numbers are the design's (§6c); its steps 2, 5, 6, 9, 10 and 14 are not part of this light gate, and 13 is
the review's (2026-09-26), not the design's.

The fixtures in tools/skins_fixtures/ are copied into the profile's plugin folder before step 8 (`bad_id` under the
name `bad id!`, which is not a valid plugin id) and removed at the end, whatever happens; the appearance setting is
put back to the default look (`{ skin: "", refused: null }`). It refuses the user's own profile
(%APPDATA%\\Scumble, %APPDATA%\\Scumble Store).

    python tools/skins_test.py

Start the app first, offline, on its own profile:
    ./node_modules/.bin/electron . --remote-debugging-port=9555 --user-data-dir=<scratch> --no-comfy
(SCUMBLE_CDP_PORT picks another port; tools/run_gates.sh runs it as the gate `skins`.)
"""
import asyncio
import base64
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import HOOK, session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
FIXTURES = os.path.join(HERE, "skins_fixtures")
# fixture folder -> the folder name it gets in the plugin folder
INSTALL = {"bad_json": "bad_json", "with_entry": "with_entry", "missing_css": "missing_css", "bad_id": "bad id!", "hostile": "hostile", "escaper": "escaper", "latecomer": "latecomer"}


def skin_tokens(folder):
    """The token values a shipped skin declares (plugins/<folder>/skin.css), so the gate follows a palette change."""
    text = open(os.path.join(ROOT, "plugins", folder, "skin.css"), encoding="utf-8").read()
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return {m.group(1): re.sub(r"\s*!\s*important$", "", m.group(2).strip(), flags=re.I) for m in re.finditer(r"(--sc-[a-z0-9-]+)\s*:\s*([^;}]+)", text)}


PRE = """(async () => {
    if (!window.__sk) window.__sk = {
        shell: await import('./shell.js'), host: (await import('./editor/host.js')).host, cmds: await import('./commands.js'),
        skins: await import('./skins.js'), theme: await import('./editor/inpaint_theme.js'), assistant: await import('./assistant.js'),
    };
    const { shell, host, cmds, skins, theme, assistant } = window.__sk;
    const run = (n, a) => cmds.commands.run(n, a || {});
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (f, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await f(); if (v) return v; await wait(100); } return null; };
    const strip = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
    const root = document.documentElement;
    const tok = (n) => getComputedStyle(root).getPropertyValue(n).trim();
    const TOKENS = theme.SKIN_TOKENS.map((t) => t.name);
    /** A colour as the browser computes it, whatever notation it was written in. */
    const norm = (v) => { const p = document.createElement("span"); p.style.color = v; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; };
    const settingsDialog = () => document.getElementById("shell-settings");
    const closeSettings = () => { const d = settingsDialog(); if (d && d.open) d.close(); };
    /** Settings rows (Appearance: #set-skins, Plugins: #set-plugins): the name without its small print, radio, errors, state. */
    const rowsOf = (sel) => Array.from(document.querySelectorAll(sel + " .shell-plugin")).map((r) => {
        const n = r.querySelector(".shell-plugin-name");
        return { name: n && n.firstChild ? n.firstChild.textContent : "", radio: r.querySelector("input[type=radio]"),
            errors: Array.from(r.querySelectorAll(".shell-plugin-error")).map((e) => e.textContent),
            state: (r.querySelector(".shell-plugin-state") || {}).textContent || "" };
    });
    const skinRules = () => { const s = document.getElementById("skin-css"); try { return s && s.sheet ? s.sheet.cssRules.length : -1; } catch (_) { return -2; } };
    const openPanel = async () => {
        if (!assistant.assistantOpen()) assistant.toggleAssistant(true);
        await wait(300);
        if (!document.getElementById("assistant").open) throw new Error("the assistant's column did not open");
    };
    const dropReplica = () => { for (const c of document.querySelectorAll('[data-ask="skins-gate"]')) { skins.releaseAsk(c); c.remove(); } };
    /** A replica of an ask card (renderer/assistant.js askCard), in the real chat, with enabled buttons, drawn as askCard
        has it drawn (protectAsk: its parts in a shadow root, the card in the top layer while it is open). */
    const replica = () => {
        const list = document.querySelector("#assistant .as-list");
        if (!list) throw new Error("the assistant's chat is not there");
        dropReplica();
        const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
        const card = mk("div", "as-card as-ask");
        card.dataset.ask = "skins-gate";
        const head = mk("div", "as-card-head");
        head.appendChild(mk("span", "as-card-name", "generate"));
        head.appendChild(mk("span", "as-card-state", "waiting for you"));
        card.appendChild(head);
        card.appendChild(mk("div", "as-card-args", '{"prompt":"a red car"}'));
        card.appendChild(mk("div", "as-reason", "It costs money: a run on fal."));
        card.appendChild(mk("div", "as-note", "recipe: Flux.2"));
        const row = mk("div", "as-card-buttons");
        for (const t of ["Allow", "Don't"]) { const b = mk("button", null, t); b.type = "button"; row.appendChild(b); }
        card.appendChild(row);
        list.appendChild(card);
        skins.protectAsk(card);
        return card;
    };
    /** What the question computes, for the card and every part in its shadow root: its look, not its place. */
    const LOOK = ["display", "visibility", "opacity", "color", "background-color", "font-family", "font-size", "font-weight", "line-height",
        "border-top-color", "border-left-color", "border-left-width", "border-top-left-radius", "padding-top", "padding-left",
        "flex-direction", "order", "justify-content", "text-transform", "letter-spacing", "-webkit-text-fill-color",
        "-webkit-text-security", "font-size-adjust", "transform", "filter", "box-shadow", "text-shadow", "direction", "content"];
    const ownLook = (card) => {
        const out = {};
        const els = [card, ...card.shadowRoot.querySelectorAll("*")];
        els.forEach((e, i) => {
            const key = i + ":" + (e === card ? "card" : e.className || e.tagName.toLowerCase());
            for (const pseudo of [null, "::before", "::after"]) {
                const cs = getComputedStyle(e, pseudo);
                for (const p of LOOK) out[key + (pseudo || "") + " " + p] = cs.getPropertyValue(p);
            }
        });
        return out;
    };
    /** guardAsk() waits (null) while the page reports itself hidden, and Chromium on Windows says so of a window that
        others cover (a gate runs behind the terminal): what the steps check is the skin, so the call is told it is visible. */
    const asVisible = (f) => {
        if (document.visibilityState === "visible") return f();
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        try { return f(); } finally { delete document.visibilityState; }
    };
    /** The same for a whole step, for the check that repeats on its own while a question is open. */
    const visibleOn = () => { if (document.visibilityState !== "visible") Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); };
    const visibleOff = () => { delete document.visibilityState; };
    /** Back to the default look (the gate's own switch). */
    const toDefault = async () => { closeSettings(); dropReplica(); const st = skins.skinState(); if (!st || st.active || root.dataset.skin) await skins.applySkin(""); };
    const SKIN = __SKIN__;
    __BODY__
})()"""


STEPS = {}

STEPS["default_look_declares_nothing"] = """
const st = skins.skinState();
const set = TOKENS.filter((n) => tok(n) !== "");
const first = document.styleSheets[0];
const style = document.getElementById("ipc-style");
const out = { active: st && st.active, dataSkin: root.dataset.skin || null, set, first: first && first.href, style: style ? style.textContent.slice(0, 12) : null, skinRules: skinRules() };
if (out.active || "skin" in root.dataset) throw new Error("a skin is in use at start: " + JSON.stringify(out));
if (set.length) throw new Error("the app declares tokens: " + set.map((n) => n + "=" + tok(n)).join(", "));
if (!first || !/\\/protect\\.css$/.test(first.href)) throw new Error("the first sheet is not protect.css: " + (first && first.href));
if (!style || !style.textContent.startsWith("@layer app {")) throw new Error("#ipc-style is not in @layer app: " + JSON.stringify(out.style));
if (out.skinRules !== 0) throw new Error("skin.css brings " + out.skinRules + " rules in the default look");
const { version, ...colours } = theme.THEME;
if (JSON.stringify(colours) !== JSON.stringify({ ...theme.THEME_DEFAULTS })) throw new Error("THEME is not its defaults: " + JSON.stringify(colours));
if (getComputedStyle(document.body).backgroundColor !== "rgb(24, 24, 24)") throw new Error("the body is " + getComputedStyle(document.body).backgroundColor);
return { sheets: document.styleSheets.length, tokens: TOKENS.length, theme: version };
"""

STEPS["skins_are_listed_not_loaded"] = """
closeSettings();
const st = await window.scumble.appearance.get();
for (const id of ["skin_90s", "skin_duck"]) {
    const s = st.skins.find((x) => x.id === id);
    if (!s) throw new Error(id + " is not under Appearance: " + JSON.stringify(st.skins.map((x) => x.id)));
    if (s.error) throw new Error(id + ": " + s.error);
    if (s.source !== "builtin") throw new Error(id + " comes from " + s.source);
}
const lp = (await run("list_plugins")).plugins;
for (const id of ["skin_90s", "skin_duck"]) {
    const p = lp.find((x) => x.id === id);
    if (!p) throw new Error(id + " is not in list_plugins");
    if (p.kind !== "skin" || p.loaded !== false || p.enabled !== false || p.error !== null) throw new Error(id + " in list_plugins: " + JSON.stringify({ kind: p.kind, loaded: p.loaded, enabled: p.enabled, error: p.error }));
}
const plain = lp.filter((p) => p.kind !== "skin");
if (!plain.every((p) => p.kind === "plugin")) throw new Error("a plugin without kind: " + JSON.stringify(plain.map((p) => [p.id, p.kind])));
await shell.openSettings();
await until(() => document.querySelectorAll("#set-skins input[type=radio]").length > 0, 3000);
const inPlugins = rowsOf("#set-plugins").filter((r) => ["90s", "Duck"].includes(r.name.trim()));
const radios = Array.from(document.querySelectorAll("#set-skins input[type=radio][name=skin]"));
const users = st.skins.filter((s) => s.source !== "builtin").length;
closeSettings();
if (inPlugins.length) throw new Error("Settings > Plugins lists " + inPlugins.map((r) => r.name).join(", "));
if (radios.length !== 1 + st.skins.length || (!users && radios.length !== 3)) throw new Error(radios.length + " radios for " + st.skins.length + " skins");
const def = radios.find((r) => r.value === "");
if (!def || !def.checked) throw new Error("the Default radio is not the checked one");
const manifest = await fetch("plugins/skin_90s/plugin.json"), sheet = await fetch("plugins/skin_90s/skin.css");
if (sheet.status !== 200) throw new Error("the skin's own stylesheet answers " + sheet.status);
if (manifest.status !== 404) throw new Error("a skin folder serves plugin.json: " + manifest.status);
return { radios: radios.length, kinds: lp.map((p) => p.id + ":" + p.kind).join(" "), manifest: manifest.status, sheet: sheet.status };
"""

STEPS["a_switch_is_live"] = """
await toDefault();
window.__skinMarker = Math.random();
const marker = window.__skinMarker;
const eds = host.editors().slice();
const v0 = theme.THEME.version;
await skins.applySkin("skin_90s");
const s90 = SKIN.skin_90s;
const got = { skin: root.dataset.skin || null, bg: tok("--sc-bg"), body: getComputedStyle(document.body).backgroundColor, ruler: theme.THEME.rulerBg, version: theme.THEME.version };
if (window.__skinMarker !== marker) throw new Error("the window reloaded");
if (host.editors().length !== eds.length || host.editors().some((e, i) => e !== eds[i])) throw new Error("the editors are not the same objects");
if (got.skin !== "skin_90s") throw new Error("90s is not in use: " + JSON.stringify({ ...got, note: (skins.skinState() || {}).note }));
if (got.bg.toLowerCase() !== s90["--sc-bg"].toLowerCase()) throw new Error("--sc-bg is " + got.bg + ", the skin says " + s90["--sc-bg"]);
if (got.body !== norm(s90["--sc-bg"])) throw new Error("the body is " + got.body + ", not " + norm(s90["--sc-bg"]));
if (String(got.ruler).toLowerCase() !== s90["--sc-chrome"].toLowerCase()) throw new Error("THEME.rulerBg is " + got.ruler + ", the skin's chrome " + s90["--sc-chrome"]);
if (!(got.version > v0)) throw new Error("refreshTheme() did not run: version " + v0 + " -> " + got.version);
await skins.applySkin("skin_duck");
if (root.dataset.skin !== "skin_duck") throw new Error("Duck is not in use: " + JSON.stringify(skins.skinState()));
await shell.openSettings();
await wait(200);
const backdrop = getComputedStyle(settingsDialog(), "::backdrop").backgroundColor;
closeSettings();
const want = norm(SKIN.skin_duck["--sc-backdrop"]);
if (backdrop !== want) throw new Error("the Settings backdrop under Duck is " + backdrop + ", not " + want);
if (window.__skinMarker !== marker) throw new Error("the window reloaded");
return { ...got, duckBackdrop: backdrop };
"""

# after the reload (the Python side reloads the window between the two halves)
BEFORE_RELOAD = """
await toDefault();
await skins.applySkin("skin_duck");
if (root.dataset.skin !== "skin_duck") throw new Error("Duck is not in use: " + JSON.stringify(skins.skinState()));
window.__skinsBeforeReload = 1;
return 1;
"""

AFTER_RELOAD = """
const st = skins.skinState();
const res = performance.getEntriesByType("resource").filter((e) => /skin\\.css/.test(e.name)).map((e) => ({ name: e.name.replace(/^.*?:\\/\\/app\\//, ""), end: Math.round(e.responseEnd * 10) / 10 }));
const fp = performance.getEntriesByType("paint").find((e) => e.name === "first-paint");
const out = { skin: root.dataset.skin || null, active: st && st.active, bg: tok("--sc-bg"), atDcl: window.__skinAtDCL === undefined ? null : window.__skinAtDCL, firstPaint: fp ? Math.round(fp.startTime * 10) / 10 : null, sheets: res };
if (out.skin !== "skin_duck" || out.active !== "skin_duck") throw new Error("Duck did not survive the reload: " + JSON.stringify(out));
const imported = res.filter((r) => /plugins\\/skin_duck\\//.test(r.name));
if (fp && imported.length && imported.every((r) => r.end > 0)) {
    const late = res.filter((r) => r.end > fp.startTime);
    if (late.length) throw new Error("a skin sheet arrived after the first paint: " + JSON.stringify(out));
    out.by = "resource timing";
} else {
    if (!out.atDcl || out.atDcl.toLowerCase() !== SKIN.skin_duck["--sc-bg"].toLowerCase()) throw new Error("--sc-bg at DOMContentLoaded was " + JSON.stringify(out.atDcl) + ": " + JSON.stringify(out));
    out.by = "DOMContentLoaded";
}
await toDefault();
return out;
"""

DCL_PROBE = """document.addEventListener("DOMContentLoaded", () => {
    try { window.__skinAtDCL = getComputedStyle(document.documentElement).getPropertyValue("--sc-bg").trim(); } catch (e) { window.__skinAtDCL = "error: " + e; }
}, { once: true });"""

STEPS["broken_skins_are_reported"] = """
await toDefault();
await shell.plugins.reloadPlugins();
const st = await window.scumble.appearance.get();
const want = { with_entry: [/no JavaScript/i, "Fixture with entry"], missing_css: [/not found/i, "Fixture missing css"], "bad id!": [/not a valid plugin id/i, "bad id!"] };
for (const [id, [re]] of Object.entries(want)) {
    const s = st.skins.find((x) => x.id === id);
    if (!s) throw new Error(id + " is not under Appearance: " + JSON.stringify(st.skins.map((x) => x.id)));
    if (!s.error || !re.test(s.error)) throw new Error(id + ": " + JSON.stringify(s.error));
}
if (st.skins.some((s) => s.id === "bad_json")) throw new Error("bad_json is listed as a skin");
const lp = (await run("list_plugins")).plugins;
const entry = lp.find((p) => p.id === "with_entry");
if (!entry || entry.loaded || entry.enabled || entry.kind !== "skin") throw new Error("with_entry in list_plugins: " + JSON.stringify(entry));
await shell.openSettings();
await until(() => rowsOf("#set-skins").some((r) => r.name === "Fixture with entry"), 3000);
const skinsRows = rowsOf("#set-skins"), pluginRows = rowsOf("#set-plugins");
closeSettings();
const out = {};
for (const [id, [, name]] of Object.entries(want)) {
    const r = skinsRows.find((x) => x.name === name);
    if (!r) throw new Error("no Appearance row " + name + ": " + skinsRows.map((x) => x.name).join(", "));
    if (!r.radio || !r.radio.disabled) throw new Error(name + ": its radio can be chosen");
    if (!r.errors.length || r.state !== "error") throw new Error(name + ": " + JSON.stringify({ errors: r.errors, state: r.state }));
    out[id] = r.errors[0].slice(0, 60);
}
const bad = pluginRows.find((x) => x.name === "bad_json");
if (!bad || bad.state !== "error" || !bad.errors.length) throw new Error("bad_json is not an error under Plugins: " + JSON.stringify(bad));
if (skinsRows.some((x) => x.name === "bad_json" || x.name === "Fixture bad json")) throw new Error("bad_json has an Appearance row");
out.bad_json = bad.errors[0].slice(0, 60);
const before = (await window.scumble.appearance.get()).skin;
for (const id of ["with_entry", "missing_css", "bad id!", "bad_json"]) {
    let refused = null;
    try { await window.scumble.appearance.set(id); } catch (e) { refused = strip(e); }
    if (!refused) throw new Error("main takes " + JSON.stringify(id) + " as a skin");
}
const after = await window.scumble.appearance.get();
if (after.skin !== before || after.active) throw new Error("a refused choice changed the setting: " + JSON.stringify({ skin: after.skin, active: after.active }));
if (globalThis.__skinFixtureRan) throw new Error("the entry of a skin ran: " + globalThis.__skinFixtureRan);
return out;
"""

STEPS["the_hostile_skin_cannot_touch_the_protected"] = """
await toDefault();
await openPanel();
const card = replica();
await wait(150);
if (!card.shadowRoot || !card.shadowRoot.querySelector(".as-card-buttons button")) throw new Error("the question's parts are not in its shadow root");
if (!card.matches(":popover-open")) throw new Error("the open question is not in the top layer");
// the question's own look: the default look
const own = ownLook(card);
await skins.applySkin("hostile");
const st = skins.skinState();
if (root.dataset.skin !== "hostile") {
    const a = await window.scumble.appearance.get();
    throw new Error("the hostile skin did not stay: " + JSON.stringify({ skin: root.dataset.skin || null, note: st && st.note, refused: a.refused }));
}
if (tok("--sc-bg") !== "#fff" || getComputedStyle(document.body).backgroundColor !== "rgb(255, 255, 255)") throw new Error("the hostile skin is not live: --sc-bg " + tok("--sc-bg"));
await wait(600);                                        // the repeated check ran a few times
const now = ownLook(card);
const diff = Object.keys(own).filter((k) => own[k] !== now[k]).map((k) => k + ": " + own[k] + " -> " + now[k]);
if (diff.length) throw new Error(diff.length + " values of the question changed: " + diff.slice(0, 8).join("; "));
if (!card.matches(":popover-open")) throw new Error("the question left the top layer under the hostile skin");
const guard = asVisible(() => skins.guardAsk(card));
if (guard !== true) throw new Error("guardAsk() said " + guard + " (visibility " + document.visibilityState + ", modal " + !!document.querySelector("dialog:modal") + ")");
await wait(300);
const a = await window.scumble.appearance.get();
if (root.dataset.skin !== "hostile" || a.active !== "hostile" || (a.refused && a.refused.id === "hostile")) throw new Error("the hostile skin was switched off: " + JSON.stringify(a.refused));
const pw = document.getElementById("set-auth-secret");
if (!pw || pw.type !== "password") throw new Error("#set-auth-secret is no password field");
const masked = getComputedStyle(pw).webkitTextSecurity;
const view = document.querySelector(".ipc-view");
const surround = view ? getComputedStyle(view).backgroundColor : null;
const log = getComputedStyle(document.getElementById("log-dialog")).display;
if (masked !== "disc") throw new Error("the key field shows " + masked);
if (surround !== "rgb(43, 43, 43)") throw new Error("the picture's surround is " + surround);
if (log !== "none") throw new Error("the closed log dialog is " + log);
await shell.openSettings();
await until(() => rowsOf("#set-skins").some((r) => r.name === "Fixture hostile"), 3000);
const row = rowsOf("#set-skins").find((r) => r.name === "Fixture hostile");
closeSettings();
const lint = row ? row.errors : [];
const need = [[/pinned/, "a protected target"], [/@layer (protect|app)\\b/, "the app's layer names"], [/outside its folder: blocked/, "a load from outside"], [/reaches outside its folder/, "a reach into the app"]];
const missing = need.filter(([re]) => !lint.some((w) => re.test(w))).map(([, what]) => what);
if (missing.length) throw new Error("Appearance does not report " + missing.join(", ") + ": " + JSON.stringify(lint));
await wait(300);
const b = card.shadowRoot.querySelector(".as-card-buttons button").getBoundingClientRect();
const foot = getComputedStyle(document.querySelector("#assistant .as-foot")).boxShadow;
if (!/255, 0, 0/.test(foot)) throw new Error("the hostile skin's shadow over the chat is not there: " + foot);
return { look: Object.keys(own).length, lint: lint.length, masked, surround, allow: [b.left + b.width / 2, b.top + b.height / 2] };
"""

HOSTILE_DONE = """
dropReplica();
await skins.applySkin("");
return 1;
"""

STEPS["a_skin_that_escapes_is_switched_off"] = """
await toDefault();
const t0 = Date.now();
await skins.applySkin("escaper");
if (root.dataset.skin !== "escaper") throw new Error("the escaper did not apply: " + JSON.stringify(skins.skinState()));
await openPanel();
const card = replica();                                 // no await before the check: protectAsk's own first check runs later
const guard = asVisible(() => skins.guardAsk(card));
if (guard !== false) throw new Error("guardAsk() said " + guard + " for a chat of " + Math.round(document.querySelector("#assistant .as-list").getBoundingClientRect().height) + " px");
const back = await until(async () => !root.dataset.skin && tok("--sc-bg") === "" && skinRules() === 0, 8000);
const a = await window.scumble.appearance.get();
if (!back) throw new Error("the default look did not come back: " + JSON.stringify({ skin: root.dataset.skin || null, bg: tok("--sc-bg"), rules: skinRules() }));
if (!a.refused || a.refused.id !== "escaper" || a.active || a.skin) throw new Error("not remembered as refused: " + JSON.stringify({ skin: a.skin, active: a.active, refused: a.refused }));
const st = skins.skinState();
if (!st || !/hid the assistant's question/.test(st.note || "")) throw new Error("the note says " + JSON.stringify(st && st.note));
const entries = await window.scumble.log.list({ after: 0 });
const line = entries.find((e) => e.time >= t0 - 1000 && /escaper/.test(String(e.message) + " " + String(e.detail || "")) && /switched off/.test(String(e.message)));
if (!line) throw new Error("no line in the app log: " + JSON.stringify(entries.slice(-5).map((e) => e.message)));
dropReplica();
return { reason: a.refused.reason, log: line.message.slice(0, 120) };
"""

STEPS["a_skin_that_hides_the_question_later_is_switched_off"] = """
await toDefault();
visibleOn();
try {
    await openPanel();
    await skins.applySkin("latecomer");
    if (root.dataset.skin !== "latecomer") throw new Error("the latecomer did not apply: " + JSON.stringify(skins.skinState()));
    const t0 = Date.now();
    const card = replica();
    const first = skins.guardAsk(card);
    const h0 = Math.round(document.querySelector("#assistant .as-list").getBoundingClientRect().height);
    if (first !== true) throw new Error("the first check said " + first + " while the chat was " + h0 + " px high");
    const refused = await until(async () => { const a = await window.scumble.appearance.get(); return a.refused && a.refused.id === "latecomer" ? a.refused : null; }, 10000);
    if (!refused) throw new Error("the latecomer stayed: the chat is " + Math.round(document.querySelector("#assistant .as-list").getBoundingClientRect().height) + " px high");
    const back = await until(() => !root.dataset.skin && tok("--sc-bg") === "", 5000);
    if (!back) throw new Error("the default look did not come back");
    const st = skins.skinState();
    if (!st || !/hid the assistant's question/.test(st.note || "")) throw new Error("the note says " + JSON.stringify(st && st.note));
    return { chatAtFirstCheck: h0, after: Date.now() - t0, reason: refused.reason };
} finally {
    dropReplica();
    visibleOff();
}
"""

ORDER = [
    "default_look_declares_nothing",
    "skins_are_listed_not_loaded",
    "a_switch_is_live",
    "the_choice_survives_a_reload",
    "broken_skins_are_reported",
    "the_hostile_skin_cannot_touch_the_protected",
    "a_skin_that_escapes_is_switched_off",
    "a_skin_that_hides_the_question_later_is_switched_off",
]


def node_step():
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "skins_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120)
    tail = r.stdout.strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        raise Exception("tools/skins_test.js: " + (tail + r.stderr)[-1500:])
    return {"checks": tail.count("[ok]")}


def same_dir(a, b):
    return os.path.normcase(os.path.normpath(a or "")) == os.path.normcase(os.path.normpath(b or ""))


class Gate:
    def __init__(self, c):
        self.c = c
        self.skin = {"skin_90s": skin_tokens("skin_90s"), "skin_duck": skin_tokens("skin_duck")}
        self.plugin_dir = None
        self.installed = []
        self.panel_was_open = None
        self.results = []

    async def ev(self, body, timeout=120):
        return await self.c.eval(PRE.replace("__SKIN__", json.dumps(self.skin)).replace("__BODY__", body), timeout=timeout)

    def step(self, name, ok, detail=""):
        self.results.append(ok)
        print(f"[{'ok' if ok else 'FAIL'}] {name}{(': ' + str(detail)) if detail else ''}", flush=True)

    async def run_step(self, name, fn):
        try:
            self.step(name, True, json.dumps(await fn(), ensure_ascii=False)[:400])
        except Exception as e:  # noqa: BLE001
            self.step(name, False, str(e)[:900])

    # ---- setup and cleanup -------------------------------------------------------------------

    def remove_fixtures(self):
        for name in INSTALL.values():
            p = os.path.join(self.plugin_dir, name)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)

    def install_fixtures(self):
        os.makedirs(self.plugin_dir, exist_ok=True)
        self.remove_fixtures()
        for src, name in INSTALL.items():
            shutil.copytree(os.path.join(FIXTURES, src), os.path.join(self.plugin_dir, name))
            self.installed.append(name)

    async def setup(self):
        info = await self.ev("""
if (!window.scumble.appearance) throw new Error("this app has no appearance API (window.scumble.appearance)");
const i = await window.scumble.info();
const a = await window.scumble.appearance.get();
return { userData: i.userData, pluginDir: i.pluginDir, skin: a.skin, refused: a.refused, panel: assistant.assistantOpen() };
""")
        appdata = os.environ.get("APPDATA", "")
        for name in ("Scumble", "Scumble Store"):
            if appdata and same_dir(info["userData"], os.path.join(appdata, name)):
                raise RuntimeError(f"this instance runs on the user's own profile ({info['userData']}); start it with --user-data-dir")
        self.plugin_dir = info["pluginDir"]
        self.panel_was_open = info["panel"]
        self.remove_fixtures()                      # a run that died before its cleanup
        if info["skin"] or info["refused"]:
            # not the startup state of a fresh profile: put the default look back first, and say so
            await self.ev("await window.scumble.settings.set({ appearance: { skin: '', refused: null } }); await skins.applySkin(''); return 1;")
            print(f"  note: the profile had appearance {json.dumps({'skin': info['skin'], 'refused': info['refused']})}; set to the default look first", flush=True)
        return info

    async def cleanup(self):
        out = {}
        try:
            self.remove_fixtures()
            out["fixtures"] = "removed"
        except Exception as e:  # noqa: BLE001
            out["fixtures"] = str(e)
        try:
            out["app"] = await self.ev("""
closeSettings();
dropReplica();
await window.scumble.settings.set({ appearance: { skin: "", refused: null } });
await skins.applySkin("");
try { await shell.plugins.reloadPlugins(); } catch (e) { console.warn("skins gate: reload plugins", e); }
if (assistant.assistantOpen() !== __OPEN__) assistant.toggleAssistant(__OPEN__);
const a = await window.scumble.appearance.get();
return { skin: a.skin, refused: a.refused, active: a.active, dataSkin: root.dataset.skin || null };
""".replace("__OPEN__", "true" if self.panel_was_open else "false"))
        except Exception as e:  # noqa: BLE001
            out["app"] = "cleanup failed: " + str(e)[:300]
        return out

    # ---- the reload step ---------------------------------------------------------------------

    async def wait_app(self, timeout=60):
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                v = await self.c.eval("(async () => { if (window.__skinsBeforeReload) return 'old'; await import('./shell.js'); return 'ready'; })()", timeout=30)
                if v == "ready":
                    await self.c.eval(HOOK)
                    return
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(0.5)
        raise RuntimeError("the window did not come back after the reload")

    async def reload_keeps(self):
        await self.ev(BEFORE_RELOAD)
        await self.c.call("Page.enable")
        ident = (await self.c.call("Page.addScriptToEvaluateOnNewDocument", source=DCL_PROBE))["identifier"]
        try:
            await self.c.call("Page.reload")
            await asyncio.sleep(1.0)
            await self.wait_app()
        finally:
            await self.c.call("Page.removeScriptToEvaluateOnNewDocument", identifier=ident)
        return await self.ev(AFTER_RELOAD)

    async def hostile(self):
        """Step 11, and then the pixels under the question's Allow button: the hostile skin's shadow paints the whole
        chat red, and only the top layer is above it. A shadow is not hit by elementFromPoint, so only pixels show it."""
        try:
            out = await self.ev(STEPS["the_hostile_skin_cannot_touch_the_protected"])
            x, y = out.pop("allow")
            shot = await asyncio.wait_for(self.c.call("Page.captureScreenshot", format="png", clip={"x": x - 3, "y": y - 3, "width": 6, "height": 6, "scale": 1}), 30)
            from PIL import Image
            im = Image.open(io.BytesIO(base64.b64decode(shot["data"]))).convert("RGB")
            px = [im.getpixel((i, j)) for i in range(im.width) for j in range(im.height)]
            r, g, b = (sum(p[k] for p in px) // len(px) for k in range(3))
            out["underAllow"] = [r, g, b]
            if r - max(g, b) > 40:
                raise RuntimeError(f"the pixels under the Allow button are red ({r}, {g}, {b}): something paints over the question")
            return out
        finally:
            await self.ev(HOSTILE_DONE)

    async def run(self):
        try:
            print("[ok] node: %s" % json.dumps(node_step()), flush=True)
        except Exception as e:  # noqa: BLE001
            print("[FAIL] node: %s" % e)
            print("FAIL")
            return False
        try:
            info = await self.setup()
            print(f"  profile {info['userData']}", flush=True)
        except Exception as e:  # noqa: BLE001
            print("[FAIL] setup: %s" % e)
            print("FAIL")
            return False
        try:
            for name in ORDER:
                if name == "the_choice_survives_a_reload":
                    await self.run_step(name, self.reload_keeps)
                    continue
                if name == "the_hostile_skin_cannot_touch_the_protected":
                    await self.run_step(name, self.hostile)
                    continue
                if name == "broken_skins_are_reported":
                    self.install_fixtures()
                body = STEPS[name]
                await self.run_step(name, lambda body=body: self.ev(body))
        finally:
            print("  cleanup: %s" % json.dumps(await self.cleanup(), ensure_ascii=False), flush=True)
        try:
            for level, text in (await self.c.logs())[-20:]:
                if level == "error":
                    print("  console error:", text[:220])
        except Exception:  # noqa: BLE001
            pass
        ok = bool(self.results) and all(self.results)
        print("PASS" if ok else "FAIL")
        return ok


async def run_all(c):
    return await Gate(c).run()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
