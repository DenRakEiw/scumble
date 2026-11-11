// the progress line, the GPU memory watch, file stats and the console dialog: moved out of shell.js (item 56 S14b, docs/PLAN_SPLIT.md), text unchanged.

import { host } from "./editor/host.js";
import { busy, ui } from "./shell.js";

// ---- memory watch ------------------------------------------------------------------------
//
// A document that is not in front still holds its filtered and matched copies, its display
// pyramids and the compositor's textures - a few hundred MB at 96 MP. When the GPU process
// grows past the limit those caches are given back; the next time the tab comes forward it
// rebuilds them. The active document is never touched, and neither is anything that is
// working (docs/PERFORMANCE.md phase 6).
//
// The card as a whole counts too (docs/PLAN_TILES.md phase A, item 5): the stutter on a large
// document comes when the card is over-committed by everything on it - ComfyUI's models after
// a local render above all - and Windows pages textures out. When less than
// `settings.memory.cardMinFreeMB` of the card is free, the background tabs' caches go as
// above, and then the front tab's compositor textures and the GL pool as well (never its
// display levels: they are the next frame). The card's numbers come from the main process
// (electron/main/gpumem.js): nvidia-smi, or the WDDM counters on Windows, or nothing.
let memoryBusy = false;

/** The GPU process's private bytes in MB, or 0 when the platform does not report them. */
async function gpuMemoryMB() {
    const m = await window.scumble.metrics();
    let kb = 0;
    for (const p of m.processes || []) if (p.type === "GPU") kb += p.privateKB || p.workingSetKB || 0;
    return Math.round(kb / 1024);
}

/** The card: { usedMB, totalMB, source } or null. Never throws. */
async function cardMemory() {
    try { return (await window.scumble.gpuMemory()) || null; } catch (_) { return null; }
}

/** How short the card is of `minFree` MB, in MB (0 when it is not, or nothing is known). */
function cardShortfall(card, minFree) {
    if (!card || !minFree || !(card.totalMB > 0)) return 0;
    return Math.max(0, minFree - (card.totalMB - card.usedMB));
}

async function watchMemory() {
    if (memoryBusy) return;
    // read the limit rather than trusting the copy in `settings`: the value can be
    // changed from the settings dialog of another window, and it makes the watch testable
    const conf = await window.scumble.settings.get();
    const limit = (conf.memory && conf.memory.gpuLimitMB) || 0;
    const minFree = (conf.memory && conf.memory.cardMinFreeMB) || 0;
    if (!limit && !minFree) return;
    memoryBusy = true;
    try {
        const before = await gpuMemoryMB();
        const card = minFree ? await cardMemory() : null;
        const short = cardShortfall(card, minFree);
        const over = limit && before > limit;
        if (!over && !short) return;
        const others = host.editors().filter((ed) => ed !== host.editor && !busy(ed) && !ed.pointer);
        let freed = 0;
        for (const ed of others) { try { freed += ed.releaseCaches({ deep: false, mirrors: true }) || 0; } catch (err) { console.warn(err); } }   // mirrors: a tab on tiles gives its display canvases back too
        let front = 0;
        if (short) {
            // the card is the problem: the front tab's textures too, and the GL pool; the
            // next frame uploads what it shows again (a window of each source, not the whole)
            const ed = host.editor;
            if (ed && !busy(ed) && !ed.pointer) {
                try {
                    if (ed._compositor && ed._compositor.stats) {
                        const cst = ed._compositor.stats();
                        front += (cst.bytes || 0) + ((cst.atlas && cst.atlas.bytes) || 0);   // the tile atlas too (C3)
                    }
                    if (ed._compositor) ed._compositor.clear();
                    if (typeof ed.releaseGpu === "function") front += ed.releaseGpu() || 0;
                    ed.sceneSig = null;
                    ed.drawSoon();
                } catch (err) { console.warn(err); }
            }
        }
        const after = await gpuMemoryMB();
        const why = [over ? `GPU process ${before} MB over the ${limit} MB limit` : "", short ? `card ${card.usedMB} of ${card.totalMB} MB used, ${short} MB short of the ${minFree} MB to keep free (${card.source})` : ""].filter(Boolean).join("; ");
        console.log(`memory watch: ${why}; released ${Math.round(freed / 1048576)} MB of caches in ${others.length} background tab${others.length === 1 ? "" : "s"}${short ? ` and ${Math.round(front / 1048576)} MB of the front tab's textures` : ""}, GPU process now ${after} MB`);
    } catch (err) {
        console.warn("memory watch", err);
    } finally {
        memoryBusy = false;
    }
}

// ---- the console dialog: the log's ring buffer, filtered, growing live ----------------------

const logState = { entries: [], lastId: 0, open: false };
const fmtTime = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

function logMatches(e) {
    const lvl = ui.logLevel.value;
    if (lvl === "error" && e.level !== "error") return false;
    if (lvl === "warn" && e.level === "info") return false;
    const q = ui.logFilter.value.trim().toLowerCase();
    if (q && !(`${e.source} ${e.message} ${e.detail || ""}`.toLowerCase().includes(q))) return false;
    return true;
}

function logRow(e) {
    const row = document.createElement("div");
    row.className = `log-entry log-${e.level}`;
    row.dataset.id = e.id;
    const cell = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; row.appendChild(s); return s; };
    cell("log-time", fmtTime(e.time)); cell("log-level", e.level); cell("log-source", e.source); cell("log-message", e.message);
    if (e.detail) {
        row.title = "Click for the detail";
        row.addEventListener("click", () => {
            const open = row.querySelector(".log-detail");
            if (open) { open.remove(); return; }
            const d = document.createElement("div");
            d.className = "log-detail";
            let text = e.detail;
            try { text = JSON.stringify(JSON.parse(e.detail), null, 2); } catch (_) { /* not JSON */ }
            d.textContent = text;
            row.appendChild(d);
        });
    }
    return row;
}

function renderLog() {
    const list = ui.logList;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = "";
    const shown = logState.entries.filter(logMatches);
    if (!shown.length) { const em = document.createElement("div"); em.className = "log-empty"; em.textContent = logState.entries.length ? "Nothing matches the filter." : "Nothing logged yet."; list.appendChild(em); }
    for (const e of shown) list.appendChild(logRow(e));
    if (atBottom) list.scrollTop = list.scrollHeight;
}

async function openConsole() {
    try { logState.entries = await window.scumble.log.list({}); } catch (err) { logState.entries = [{ id: 0, time: Date.now(), level: "error", source: "renderer", message: "log unreachable: " + (err.message || err) }]; }
    logState.lastId = logState.entries.length ? logState.entries[logState.entries.length - 1].id : 0;
    try { ui.logPath.textContent = (await window.scumble.log.file()) || ""; } catch (_) { ui.logPath.textContent = ""; }
    renderLog();
    if (!ui.log.open) ui.log.showModal();
    ui.logList.scrollTop = ui.logList.scrollHeight;
    ui.logFilter.focus();
}

export { cardMemory, cardShortfall, gpuMemoryMB, logMatches, logRow, logState, openConsole, renderLog, watchMemory };
