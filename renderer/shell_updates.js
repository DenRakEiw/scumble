// updates: the text, the question when one is ready, skip and install; the star line and About bits: moved out of shell.js (item 56 S14b, docs/PLAN_SPLIT.md), text unchanged.

import * as dialogs from "./dialogs.js";
import { host } from "./editor/host.js";
import { userBusy } from "./assistant_wait.js";
import { assistantActivity } from "./assistant.js";
import { shellState } from "./shell_state.js";
import { UPDATE_LABELS, busy, ui } from "./shell.js";

// ---- updates (electron/main/updater.js) ---------------------------------------------------

/** A copy that does not update itself (a portable or other unpacked copy, electron/main/portable.js updateMode). */
const notifyMode = (s) => !!(s && s.mode === "notify");

function updateText(s) {
    if (!s) return "";
    if (s.state === "dev") return "Not packaged: updates are checked in the installed app only.";
    if (s.state === "store") return `Scumble ${s.current} from the Microsoft Store: the Store installs its updates.`;
    if (s.state === "available") {
        return s.skip && s.skip === s.version
            ? `Scumble ${s.version} is out. You skipped it; Download still opens its release page.`
            : `Scumble ${s.version} is out. This copy does not update itself: Download opens its release page.`;
    }
    if (s.state === "checking") return "Checking for updates ...";
    if (s.state === "latest") return s.manual ? `Scumble ${s.current} is up to date.` : "";
    if (s.state === "downloading") return `Downloading Scumble ${s.version} ... ${s.percent == null ? "" : s.percent + "%"}`;
    if (s.state === "downloaded") {
        return s.skip && s.skip === s.version
            ? `Scumble ${s.version} is downloaded. You skipped it, so it is not installed when Scumble closes; Install installs it now.`
            : `Scumble ${s.version} is downloaded: Install restarts into it now, otherwise it is installed when Scumble closes.`;
    }
    if (s.state === "error") return `Update check failed: ${s.error}`;
    return "";
}

let shownUpdate = null;            // the status the Updates section and the title row show (what their buttons act on)

export function renderUpdate(s) {
    shownUpdate = s || null;
    ui.updateNote.textContent = updateText(s);
    // a copy that does not update itself offers the release page instead of an install (state "available")
    const notify = notifyMode(s);
    const offered = !!(s && (notify ? s.state === "available" : s.state === "downloaded"));
    // the release notes of the offered version, as text: they come from GitHub, so they
    // never touch innerHTML
    const notes = s && s.notes && (s.state === "downloaded" || s.state === "downloading" || s.state === "available") ? s.notes : "";
    ui.updateNotes.textContent = notes;
    ui.updateNotes.hidden = !notes;
    ui.updateInstall.hidden = !offered;
    ui.updateInstall.textContent = notify ? "Download" : UPDATE_LABELS.install;
    ui.updateCheck.disabled = !!(s && (s.state === "checking" || s.state === "downloading"));
    // the Store copy is updated by the Store: no feed to check, nothing to switch off
    const store = !!(s && s.state === "store");
    ui.updateCheck.hidden = store;
    ui.updateAuto.parentElement.hidden = store;
    ui.updateHelp.hidden = store || notify;
    ui.updateHelpNotify.hidden = !notify;
    ui.updateBar.hidden = !offered;
    ui.updateBar.title = notify ? "A new version is out; this copy does not update itself: open its release page" : UPDATE_LABELS.barTitle;
    ui.updateBar.textContent = !offered ? "" : notify ? `Download ${s.version}` : `Update to ${s.version}`;
}

/** The release page Download opens: the one main names (electron/main/updater.js releaseUrl), else the tag's. */
export function releasePage(s) {
    if (s && typeof s.url === "string" && /^https:\/\/github\.com\/DenRakEiw\/scumble\/releases\//.test(s.url)) return s.url;
    const v = String((s && s.version) || "").replace(/^v/, "");
    return /^[0-9A-Za-z.+-]+$/.test(v) ? `https://github.com/DenRakEiw/scumble/releases/tag/v${v}` : "https://github.com/DenRakEiw/scumble/releases/latest";
}

/** How Download opens the page (main allows http(s) only); a test replaces `open`. */
export const updateLinks = { open: (url) => window.scumble.openExternal(url) };

/** Download in a copy that does not update itself: the release page in the browser, nothing installed. */
function downloadUpdate(s) {
    try { updateLinks.open(releasePage(s)); } catch (_) { return false; }
    return true;
}

/** The title row's button and Settings › Updates' Install / Download. */
function updateAction() {
    return notifyMode(shownUpdate) ? downloadUpdate(shownUpdate) : installUpdate();
}

// ---- the question when an update is ready (CLAUDE.md item 32, docs/PLAN_0_1_38.md A1) ----------------------------

let lastUpdate = null;            // the newest status (from main, or a test's)
const updateAsked = new Set();    // the versions this window asked about (main keeps the same for the start: `announced`)
let updateAsking = false;

/** What the question waits for now, or null: another question (the assistant's too), a modal panel, the restore, an edit. */
function updateQuestionWaits() {
    if (dialogs.openCount() > 0) return "a question";
    if (Array.from(document.querySelectorAll("dialog[open]")).some((d) => d.matches(":modal"))) return "a dialog";
    if (assistantActivity().asking) return "the assistant's question";
    if (host._restoring) return "the restore";
    if (host.editors().some((ed) => userBusy(ed))) return "an edit";
    if (Date.now() - shellState.lastUserInput < 3000) return "typing";
    return null;
}

/**
 * The question's detail: each change's bold lead from the release notes (`s.headlines`, electron/main/updater.js),
 * at most `lines` of them; notes without such leads as text, cut at a line break near `chars`; then what Later and
 * Skip do. The whole notes stay in Settings › Updates.
 */
export function updateQuestionDetail(s, { lines = 8, chars = 1500 } = {}) {
    const parts = [];
    const heads = s && Array.isArray(s.headlines) ? s.headlines.filter(Boolean).map(String) : [];
    if (heads.length) {
        const shown = heads.slice(0, lines).map((h) => "• " + h);
        if (heads.length > lines) shown.push(`… and ${heads.length - lines} more in Settings › Updates.`);
        parts.push("What changed:\n" + shown.join("\n"));
    } else if (s && s.notes) {
        const text = String(s.notes).trim();
        let cut = text.length;
        if (text.length > chars) {
            cut = text.lastIndexOf("\n", chars);
            if (cut < chars / 2) cut = text.lastIndexOf(" ", chars);
            if (cut < chars / 2) cut = chars;
        }
        parts.push("What changed:\n" + text.slice(0, cut).trimEnd() + (cut < text.length ? "\n…, the rest in Settings › Updates." : ""));
    }
    parts.push(notifyMode(s)
        ? "Later asks again at the next start. Skip this version leaves it out until a newer one comes; the Download button in the title row still opens its page."
        : "Later installs it when you close Scumble. Skip this version leaves it out until a newer one comes; the Update button in the title row still installs it.");
    return parts.join("\n\n");
}

/**
 * Ask once when an update is downloaded: Restart and update, Later, Skip this version. In a copy that does not update
 * itself (`mode` "notify", a portable copy) ask once when a new version is out instead: Download (its release page in
 * the browser), Later, Skip this version. Not after a check the user
 * started (Settings › Updates shows that answer), not for a version this start asked about or the user skipped, and
 * never over another question, a modal panel, the restore at start or an edit in progress: it waits for those, and
 * gives up when a newer status replaces this one meanwhile. The Store copy and dev never reach "downloaded". Resolves
 * with the index of the button pressed, or false when it did not ask.
 */
export async function announceUpdate(s) {
    if (s) lastUpdate = s;
    const notify = notifyMode(s);
    const offered = (u) => !!(u && u.state === (notifyMode(u) ? "available" : "downloaded"));
    const v = offered(s) && !s.manual && s.version ? String(s.version) : null;
    if (!v || updateAsking || updateAsked.has(v) || s.announced === v || s.skip === v || (shellState.settings.updates || {}).skip === v) return false;
    const current = (u) => !!(offered(u) && notifyMode(u) === notify && !u.manual && String(u.version) === v);
    updateAsking = true;
    try {
        while (updateQuestionWaits()) {
            await new Promise((r) => setTimeout(r, 500));
            if (!current(lastUpdate)) return false;
        }
        const now = lastUpdate;
        updateAsked.add(v);
        window.scumble.updates.announced(v).catch(() => { /* this window still remembers it */ });
        if (notify) {
            const n = await dialogs.ask({
                title: `Scumble ${v} is out`,
                message: "This copy does not update itself. Download the new zip and unpack it where you unpacked this one, so its Scumble folder lands on this one: the data folder stays.",
                detail: updateQuestionDetail(now),
                buttons: ["Download", "Later", "Skip this version"],
                defaultId: 0,
                cancelId: 1,
                // it opens unasked: a key the user was typing answers Later
                focusId: 1,
            });
            if (n === 0) downloadUpdate(now);
            else if (n === 2) await skipUpdate(v);
            return n;
        }
        const i = await dialogs.ask({
            title: `Scumble ${v} is ready`,
            message: `You have ${now.current}. Restart and update saves your documents, installs ${v} and starts it; the documents come back as they were.`,
            detail: updateQuestionDetail(now),
            buttons: ["Restart and update", "Later", "Skip this version"],
            defaultId: 0,
            cancelId: 1,
            // it opens unasked: a key the user was typing answers Later, never the restart
            focusId: 1,
        });
        if (i === 0) await installUpdate();
        else if (i === 2) await skipUpdate(v);
        return i;
    } finally {
        updateAsking = false;
        // a newer version arrived while this one waited or was asked
        if (lastUpdate && lastUpdate !== s && offered(lastUpdate) && String(lastUpdate.version) !== v) announceUpdate(lastUpdate);
    }
}

/**
 * Skip a version (null: none): no question for it, and it is not installed when Scumble closes (main reads
 * settings.updates.skip, electron/main/updater.js setSkip). Install and the title row's button still install it.
 */
export async function skipUpdate(version) {
    const updates = { ...(shellState.settings.updates || {}) };
    if (version) updates.skip = String(version); else delete updates.skip;
    shellState.settings = await window.scumble.settings.set({ updates });
    return shellState.settings.updates;
}

/**
 * Restart into the downloaded update: the title row's button, Install in Settings › Updates and the question. A run in
 * flight, a working assistant or a connected agent ends with the app, so that is asked first; main saves every
 * document before the installer starts (update:install).
 */
async function installUpdate() {
    // busy() leaves out a render on the user's ComfyUI (it holds no flag while it runs): its result would be lost too
    const working = host.editors().filter((ed) => busy(ed) || (ed._localRuns && ed._localRuns.size > 0)).length;
    const as = assistantActivity();
    const what = [];
    if (working) what.push(working === 1 ? "a document is still working" : `${working} documents are still working`);
    if (as.busy) what.push("the assistant is working");
    if (as.agents) what.push(as.agents === 1 ? "an agent is connected" : `${as.agents} agents are connected`);
    if (what.length) {
        const text = what.join(", ").replace(/, ([^,]*)$/, " and $1");
        const yes = await dialogs.confirm(`${text[0].toUpperCase()}${text.slice(1)}. Restart and update anyway?`, {
            detail: "What runs now ends with the app: a run's result does not come back, and an agent's session ends.",
            ok: "Restart and update",
            danger: true,
        });
        if (!yes) return false;
    }
    let ok = false;
    try { ok = await window.scumble.updates.install(); } catch (_) { /* said below */ }
    if (!ok && host.editor) host.editor.setStatus("The update did not start; Settings › Updates offers it again.", "error");
    return ok;
}

// ---- item 40: the star line after an update ------------------------------------------------------------
const REPO_URL = "https://github.com/DenRakEiw/scumble";

/** The quiet line on the first start of a new version (main decides, once per version): never a modal, closed for good. */
function showStarNote(text) {
    if (!text || document.getElementById("shell-star")) return;
    const bar = document.createElement("div");
    bar.id = "shell-star";
    const say = document.createElement("span");
    say.textContent = text;
    const star = document.createElement("a");
    star.href = "#";
    star.textContent = "Star on GitHub";
    star.addEventListener("click", (e) => { e.preventDefault(); window.scumble.openExternal(REPO_URL); bar.remove(); });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "shell-star-close";
    close.textContent = "×";
    close.title = "Close";
    close.addEventListener("click", () => bar.remove());
    bar.append(say, star, close);
    const main = document.getElementById("shell-main");
    main.parentNode.insertBefore(bar, main);
}
/** Settings › Network's note: which way requests go now and which curl (electron/main/curlfetch.js status). */
async function renderNetwork() {
    try {
        const s = await window.scumble.network.status();
        ui.netNote.textContent = s.via === "curl" ? `curl ${s.curl.version} (${s.curl.path})` : s.enabled ? `on, but ${s.error}: requests go through Scumble's own fetch` : "off: Scumble's own requests";
        ui.netNote.style.color = s.enabled && !s.curl ? "var(--sc-warn, #e0a05a)" : "";
    } catch (_) { ui.netNote.textContent = ""; }
}
/** A memory row's value as the row shows and stores it: a whole number of MB, at least `min`. */
function wholeMB(v, min, fallback) {
    return v == null || v === "" || !Number.isFinite(Number(v)) ? fallback : Math.max(min, Math.round(Number(v)));
}

export { REPO_URL, renderNetwork, showStarNote, updateAction, wholeMB };
