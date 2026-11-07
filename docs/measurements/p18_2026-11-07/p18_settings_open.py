"""P18 of docs/PLAN_WASM_BUILD.md section 7: how long shell.openSettings() takes until it resolves (the dialog shows at
its end), on a running instance; the card's read (electron/main/gpumem.js) is cached for 5 s, so the opens are 6 s
apart and each one starts it anew. Also when the GPU memory line was written, after the open began.

    SCUMBLE_CDP_PORT=9603 python p18_settings_open.py [opens] [--json out.json]
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "tools"))
from cdp import session  # noqa: E402

OPENS = int(next((a for a in sys.argv[1:] if a.isdigit()), "5"))
JSON_OUT = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None

JS = r"""
(async () => {
    const shell = await import("./shell.js");
    const line = document.getElementById("set-gpu-mem"), dlg = document.getElementById("shell-settings");
    for (const d of document.querySelectorAll("dialog[open]")) d.close();
    line.textContent = "";
    const t0 = performance.now();
    let filled = null;
    const obs = new MutationObserver(() => { if (filled == null && line.textContent.startsWith("The GPU process is using")) filled = performance.now() - t0; });
    obs.observe(line, { childList: true, characterData: true, subtree: true });
    await shell.openSettings();
    const open = performance.now() - t0, shown = dlg.open;
    for (let i = 0; i < 200 && filled == null; i++) await new Promise((r) => setTimeout(r, 50));
    obs.disconnect();
    dlg.close();
    return { openMs: +open.toFixed(1), shown, lineMs: filled == null ? null : +filled.toFixed(1), focused: document.hasFocus() };
})()
"""


async def run(c):
    await c.call("Page.bringToFront")
    out = []
    for k in range(OPENS):
        await asyncio.sleep(6)
        r = await c.eval(JS, timeout=60)
        out.append(r)
        print(json.dumps(r))
    opens = sorted(r["openMs"] for r in out)
    lines = sorted(r["lineMs"] for r in out if r["lineMs"] is not None)
    summary = {"opens": out, "openMs_median": opens[len(opens) // 2], "lineMs_median": lines[len(lines) // 2] if lines else None}
    print("openSettings median %.1f ms, the GPU line after %s ms" % (summary["openMs_median"], summary["lineMs_median"]))
    if JSON_OUT:
        with open(JSON_OUT, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=1)
    return True


if __name__ == "__main__":
    asyncio.run(session(run))
