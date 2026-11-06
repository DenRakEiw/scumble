"""Which step of host.saveExport ends the renderer: blob.arrayBuffer() or the IPC (K0a finding)."""
import asyncio
import sys

sys.path.insert(0, r"F:\canvas\tools")
from cdp import session  # noqa: E402

STEP = sys.argv[1]
MB = int(sys.argv[2])
PATH = r"F:/canvas/dist/gates/k0a_2026-10-23/save_probe/probe2.bin"

BODIES = {
    # the blob's bytes alone, dropped
    "bytes": "const b = new Blob([new Uint8Array(n)]); const a = await b.arrayBuffer(); return JSON.stringify({ ok: a.byteLength });",
    # the IPC alone, with bytes made in place (no blob)
    "ipc": "const d = new Uint8Array(n); const r = await window.scumble.file.save({ name: 'probe2.bin', data: d, path: %r }); return JSON.stringify(r);" % PATH,
}

JS = "(async () => { const n = %d * 1048576; const t = performance.now(); try { %s } finally { console.log('probe ms', performance.now() - t); } })()"


async def go(c):
    await asyncio.sleep(1)
    try:
        print("ok", STEP, MB, await c.eval(JS % (MB, BODIES[STEP]), timeout=600), flush=True)
    except Exception as e:  # noqa: BLE001
        print("FAIL", STEP, MB, str(e)[:200], flush=True)


asyncio.run(session(go))
