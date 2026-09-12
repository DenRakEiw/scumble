// The graphics card's memory as a whole (docs/PLAN_TILES.md phase A, item 5).
//
// Electron's app.getAppMetrics() sees only our own GPU process. The stutter on a large
// document comes when the *card* is over-committed - ComfyUI holds 20 to 29 GB after a local
// render, Photoshop 9.5 GB with a document open - and Windows pages textures out to system
// memory, so the memory watch has to know what everybody is using. Two sources:
//
//   nvidia-smi   `--query-gpu=memory.used,memory.total` (MiB, NVIDIA only, on PATH or in the
//                driver's folder); tens of milliseconds, used and total both known.
//   PowerShell   the WDDM counters `\GPU Adapter Memory(*)\Dedicated Usage` summed over the
//                adapters (any card on Windows); about a second, and only the used bytes -
//                the counters have no total, and Win32_VideoController.AdapterRAM caps at
//                4 GB on many drivers, so the total stays null.
//
// Answers are cached for a few seconds; a source that fails is not asked again for a minute.
// Nothing here ever throws: the watch gets null and works with the GPU process alone.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CACHE_MS = 5000;
const RETRY_MS = 60000;
let cache = { at: 0, value: null };
let smiPath = undefined;      // resolved once: a path, or null when there is no nvidia-smi
let smiFailedAt = 0;
let psFailedAt = 0;

function run(cmd, args, timeout) {
    return new Promise((resolve) => {
        try {
            execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout || "")));
        } catch (_) {
            resolve(null);
        }
    });
}

function findSmi() {
    if (smiPath !== undefined) return smiPath;
    const candidates = process.platform === "win32"
        ? [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "nvidia-smi.exe"),
           path.join(process.env.ProgramFiles || "C:\\Program Files", "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe")]
        : ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"];
    smiPath = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || (process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi");
    return smiPath;
}

async function fromSmi() {
    if (Date.now() - smiFailedAt < RETRY_MS) return null;
    const out = await run(findSmi(), ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"], 4000);
    if (!out) { smiFailedAt = Date.now(); return null; }
    let used = 0, total = 0, n = 0;
    for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);
        if (!m) continue;
        used += +m[1]; total += +m[2]; n++;
    }
    if (!n) { smiFailedAt = Date.now(); return null; }
    return { usedMB: used, totalMB: total, adapters: n, source: "nvidia-smi" };
}

async function fromCounters() {
    if (process.platform !== "win32" || Date.now() - psFailedAt < RETRY_MS) return null;
    const script = "$s = (Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage' -ErrorAction Stop).CounterSamples; [math]::Round(($s | Measure-Object -Property CookedValue -Sum).Sum / 1MB)";
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 8000);
    const mb = out && parseInt(out.trim(), 10);
    if (!(mb >= 0)) { psFailedAt = Date.now(); return null; }
    return { usedMB: mb, totalMB: null, adapters: null, source: "wddm-counters" };
}

/** { usedMB, totalMB | null, adapters, source } for the card(s), or null when nothing can say. */
async function gpuMemory() {
    if (Date.now() - cache.at < CACHE_MS) return cache.value;
    let v = null;
    try { v = (await fromSmi()) || (await fromCounters()); } catch (_) { v = null; }
    cache = { at: Date.now(), value: v };
    return v;
}

module.exports = { gpuMemory };
