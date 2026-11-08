import argparse
import asyncio
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import cdp  # noqa: E402
from cdp import session  # noqa: E402

JS = r"""
(async () => {
    const shell = await import("./shell.js");
    const W = 256, H = 256;
    const before = window.editor;
    const ed = shell.newDocument();
    shell.activate(ed);
    await new Promise((r) => setTimeout(r, 200));
    ed.resizeCanvas();
    const { Layer: LayerPixels, Mask: MaskPixels } = ed.pixels;
    const mk = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const sha256 = async (u8) => {
        const buf = await crypto.subtle.digest("SHA-256", u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const clearCaches = () => {
        for (const l of ed.layers) { l._fcache = null; l._fcacheView = null; l._fcacheSample = null; }
        ed.flatCache = null;
        ed.sceneSig = null;
    };
    const flatCanvas = (forRun = true, chainOff = false) => {
        ed.filterChainOff = chainOff;
        clearCaches();
        const c = ed.flattenToCanvas({ forRun });
        ed.filterChainOff = false;
        return c;
    };
    const flatBytes = (forRun = true, chainOff = false) => {
        return flatCanvas(forRun, chainOff).getContext("2d").getImageData(0, 0, W, H).data;
    };
    const screenBytes = (chainOff = false) => {
        ed.filterChainOff = chainOff;
        clearCaches();
        const c = mk(W, H), ctx = c.getContext("2d");
        const prev = ed.viewPass;
        ed.viewPass = { x: 0, y: 0, w: W, h: H, sx: 1, sy: 1, screen: true };
        try { ed.drawComposite(ctx, {}); } finally { ed.viewPass = prev; ed.filterChainOff = false; }
        return ctx.getImageData(0, 0, W, H).data;
    };
    const pxAt = (d, x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };

    // 1. Opaque 256x256 document
    const opaqueBase = mk(W, H);
    {
        const ctx = opaqueBase.getContext("2d");
        const img = ctx.createImageData(W, H);
        const d = img.data;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                d[i] = (x * 3 + y * 5) & 255;
                d[i + 1] = (x * 7 + 40) & 255;
                d[i + 2] = (y * 11 + 90) & 255;
                d[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
    }
    Object.defineProperty(opaqueBase, "naturalWidth", { value: W });
    Object.defineProperty(opaqueBase, "naturalHeight", { value: H });
    await ed.setBase({ filename: "opaque_base.png", subfolder: "inpaint_canvas", type: "input" }, opaqueBase, { keepLayers: false });
    await ed.mipsSettled();

    const opaqueBaseHash = await sha256(flatBytes(true, false));

    const fxO1 = ed.addFilterLayer("curves");
    ed.markFilterChanged(fxO1);
    const opaqueCurvesHash = await sha256(flatBytes(true, false));
    ed.removeLayer(fxO1.id);

    const fxO2 = ed.addFilterLayer("bw");
    ed.markFilterChanged(fxO2);
    const opaqueBwHash = await sha256(flatBytes(true, false));
    const fxO3 = ed.addFilterLayer("invert");
    ed.markFilterChanged(fxO3);
    const opaqueChainedHash = await sha256(flatBytes(true, false));
    const opaqueUnchainedFlagHash = await sha256(flatBytes(true, true));
    ed.removeLayer(fxO3.id);

    const fxOSharp = ed.addFilterLayer("sharpen");
    fxOSharp.params = { ...fxOSharp.params, amount: 80, radius: 1.5, threshold: 0 };
    ed.markFilterChanged(fxOSharp);
    const fxOInv = ed.addFilterLayer("invert");
    ed.markFilterChanged(fxOInv);
    const opaqueUnchainedMidHash = await sha256(flatBytes(true, false));
    ed.removeLayer(fxOInv.id);
    ed.removeLayer(fxOSharp.id);
    ed.removeLayer(fxO2.id);

    // Opaque soft-limit case (last filter in stack, soft ramp 0 < w < 1 and outside w = 0 / w = 1)
    const fxOSoft = ed.addFilterLayer("bw");
    fxOSoft.params = { ...fxOSoft.params, limit: { source: "luma", lo: 0.35, hi: 0.65, fLo: 0.2, fHi: 0.2 } };
    ed.markFilterChanged(fxOSoft);
    const softC = flatCanvas(true, false);
    const dOSoftFlat = softC.getContext("2d").getImageData(0, 0, W, H).data;
    const dOSoftScreen = screenBytes(false);
    const opaqueSoftLimitFlatHash = await sha256(dOSoftFlat);
    const opaqueSoftLimitScreenHash = await sha256(dOSoftScreen);
    const opaqueSoftLimitProbes = {
        w0: [[0, 0, pxAt(dOSoftFlat, 0, 0)], [67, 0, pxAt(dOSoftFlat, 67, 0)], [104, 0, pxAt(dOSoftFlat, 104, 0)], [105, 0, pxAt(dOSoftFlat, 105, 0)]],
        w1: [[12, 0, pxAt(dOSoftFlat, 12, 0)], [13, 0, pxAt(dOSoftFlat, 13, 0)], [14, 0, pxAt(dOSoftFlat, 14, 0)], [15, 0, pxAt(dOSoftFlat, 15, 0)]],
        ramp: [[4, 0, pxAt(dOSoftFlat, 4, 0)], [5, 0, pxAt(dOSoftFlat, 5, 0)], [6, 0, pxAt(dOSoftFlat, 6, 0)], [7, 0, pxAt(dOSoftFlat, 7, 0)]],
    };
    ed.removeLayer(fxOSoft.id);

    // 2. Half-transparent 256x256 document (edges at alpha 128, center at alpha 255)
    const halfBase = mk(W, H);
    {
        const ctx = halfBase.getContext("2d");
        const img = ctx.createImageData(W, H);
        const d = img.data;
        for (let y = 0; y < H; y++) {
            const inY = y >= 64 && y < 192;
            for (let x = 0; x < W; x++) {
                const inX = x >= 64 && x < 192;
                const i = (y * W + x) * 4;
                if (inX && inY) {
                    if (x < 128) { d[i] = 60; d[i + 1] = 120; d[i + 2] = 200; d[i + 3] = 255; }
                    else { d[i] = 200; d[i + 1] = 140; d[i + 2] = 60; d[i + 3] = 255; }
                } else {
                    if (x < 128) { d[i] = 201; d[i + 1] = 60; d[i + 2] = 40; d[i + 3] = 128; }
                    else { d[i] = 80; d[i + 1] = 199; d[i + 2] = 120; d[i + 3] = 128; }
                }
            }
        }
        ctx.putImageData(img, 0, 0);
    }
    Object.defineProperty(halfBase, "naturalWidth", { value: W });
    Object.defineProperty(halfBase, "naturalHeight", { value: H });
    await ed.setBase({ filename: "half_base.png", subfolder: "inpaint_canvas", type: "input" }, halfBase, { keepLayers: false });
    await ed.mipsSettled();

    // Non-plain 1: mask (left half 0, right half 255)
    const fxM = ed.addFilterLayer("bw");
    {
        const mc = mk(W, H), mx = mc.getContext("2d");
        const mimg = mx.createImageData(W, H), md = mimg.data;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4;
                md[i] = 255; md[i + 1] = 255; md[i + 2] = 255; md[i + 3] = x < 128 ? 0 : 255;
            }
        }
        mx.putImageData(mimg, 0, 0);
        fxM.maskPx = MaskPixels.fromCanvas(mc);
        ed.markMaskChanged(fxM);
    }
    await ed.mipsSettled();
    const dMask = flatBytes(true, false);
    const maskHash = await sha256(dMask);
    const maskProbes = [pxAt(dMask, 16, 16), pxAt(dMask, 240, 16), pxAt(dMask, 96, 96), pxAt(dMask, 160, 96)];
    ed.removeLayer(fxM.id);

    // Non-plain 2: opacity 0.5
    const fxOp = ed.addFilterLayer("bw");
    fxOp.opacity = 0.5;
    ed.markFilterChanged(fxOp);
    const dOp = flatBytes(true, false);
    const opHash = await sha256(dOp);
    const opProbes = [pxAt(dOp, 16, 16), pxAt(dOp, 240, 16), pxAt(dOp, 96, 96), pxAt(dOp, 160, 96)];
    ed.removeLayer(fxOp.id);

    // Non-plain 3: blend mode multiply
    const fxBl = ed.addFilterLayer("bw");
    fxBl.blend = "multiply";
    ed.markFilterChanged(fxBl);
    const dBl = flatBytes(true, false);
    const blHash = await sha256(dBl);
    const blProbes = [pxAt(dBl, 16, 16), pxAt(dBl, 240, 16), pxAt(dBl, 96, 96), pxAt(dBl, 160, 96)];
    ed.removeLayer(fxBl.id);

    // Non-plain 4: limitView (effectViewOf on a screen pass)
    const fxLv = ed.addFilterLayer("bw");
    fxLv.params = { ...fxLv.params, limit: { source: "luma", lo: 0.5, hi: 1.0, fLo: 0, fHi: 0 } };
    ed.maskView = { id: fxLv.id, mode: "effect" };
    ed.markFilterChanged(fxLv);
    const dLv = screenBytes(false);
    const lvHash = await sha256(dLv);
    const lvProbes = [pxAt(dLv, 16, 16), pxAt(dLv, 240, 16), pxAt(dLv, 96, 96), pxAt(dLv, 160, 96)];
    ed.maskView = null;
    ed.removeLayer(fxLv.id);

    // Non-plain 5: clip (clipped to a pixel layer below)
    const clipBaseC = mk(192, 192);
    {
        const cx = clipBaseC.getContext("2d");
        const cimg = cx.createImageData(192, 192), cd = cimg.data;
        for (let i = 0; i < cd.length; i += 4) {
            cd[i] = 120; cd[i + 1] = 80; cd[i + 2] = 199; cd[i + 3] = 128;
        }
        cx.putImageData(cimg, 0, 0);
    }
    const clipBaseLayer = ed.addLayer({ name: "clip-base", kind: "paint", px: LayerPixels.fromCanvas(clipBaseC), x: 32, y: 32, w: 192, h: 192, dirty: true });
    const fxCl = ed.addFilterLayer("bw");
    fxCl.clip = true;
    ed.markFilterChanged(fxCl);
    await ed.mipsSettled();
    const dCl = flatBytes(true, false);
    const clHash = await sha256(dCl);
    const clProbes = [pxAt(dCl, 16, 16), pxAt(dCl, 48, 48), pxAt(dCl, 96, 96)];
    ed.removeLayer(fxCl.id);
    ed.removeLayer(clipBaseLayer.id);

    shell.closeDocument(ed, { force: true });
    if (before) shell.activate(before);
    return {
        tiles: !!ed.tileMode,
        opaque: {
            opaqueBaseHash,
            opaqueCurvesHash,
            opaqueBwHash,
            opaqueChainedHash,
            opaqueUnchainedFlagHash,
            opaqueUnchainedMidHash,
            opaqueSoftLimit: {
                flatHash: opaqueSoftLimitFlatHash,
                screenHash: opaqueSoftLimitScreenHash,
                probes: opaqueSoftLimitProbes,
            },
        },
        nonPlain: {
            mask: { hash: maskHash, probes: maskProbes },
            opacity: { hash: opHash, probes: opProbes },
            blend: { hash: blHash, probes: blProbes },
            limitView: { hash: lvHash, probes: lvProbes },
            clip: { hash: clHash, probes: clProbes },
        },
    };
})()
"""


def wait_port(port, timeout=60):
    url = f"http://127.0.0.1:{port}/json/version"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def close_port(port):
    env = dict(os.environ, SCUMBLE_CDP_PORT=str(port))
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "close_app.py")], env=env, capture_output=True)
    time.sleep(3)


def freeze_from_commit(commit, port):
    tree = os.path.join(tempfile.gettempdir(), f"scumble_freeze_{commit[:8]}")
    if os.path.exists(tree):
        nm = os.path.join(tree, "node_modules")
        if os.path.lexists(nm):
            subprocess.run(["cmd", "/c", "rmdir", nm], capture_output=True)
        shutil.rmtree(tree)
    os.makedirs(tree)
    try:
        arch = subprocess.run(["git", "-C", ROOT, "archive", "--format=tar", commit], capture_output=True, check=True).stdout
        with tarfile.open(fileobj=io.BytesIO(arch)) as t:
            t.extractall(tree, filter="tar")
        nm_target = os.path.realpath(os.path.join(ROOT, "node_modules"))
        subprocess.run(["cmd", "/c", "mklink", "/J", os.path.join(tree, "node_modules"), nm_target], check=True, capture_output=True)
        electron = os.path.join(tree, "node_modules", "electron", "dist", "electron.exe")
        os.environ["SCUMBLE_CDP_PORT"] = str(port)
        cdp.PORT = int(port)
        for tiles, out_name in ((False, "frozen_off.json"), (True, "frozen_on.json")):
            close_port(port)
            profile = os.path.join(tree, f"profile_{'on' if tiles else 'off'}")
            os.makedirs(os.path.join(profile, "files", "input", "inpaint_canvas"), exist_ok=True)
            test_base = r"F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\input\inpaint_canvas\test_base.png"
            if os.path.exists(test_base):
                shutil.copyfile(test_base, os.path.join(profile, "files", "input", "inpaint_canvas", "test_base.png"))
            env = dict(os.environ, SCUMBLE_TILES="1" if tiles else "0", SCUMBLE_STRICT="0")
            tile_arg = "--tiles" if tiles else "--no-tiles"
            proc = subprocess.Popen(
                [electron, ".", f"--remote-debugging-port={port}", f"--user-data-dir={profile}", "--use-fake-device-for-media-stream", tile_arg, "--no-comfy"],
                cwd=tree,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                if not wait_port(port, 60):
                    raise RuntimeError(f"Electron did not listen on {port}")
                time.sleep(8)
                res = asyncio.run(session(lambda c: c.eval(JS, timeout=120)))
                out_path = os.path.join(HERE, out_name)
                with open(out_path, "w", encoding="utf-8", newline="\n") as f:
                    json.dump(res, f, indent=2)
                    f.write("\n")
                print(f"wrote {out_path} (tiles={res.get('tiles')}, limitView={res['nonPlain']['limitView']['hash'][:12]})")
            finally:
                close_port(port)
                try:
                    proc.terminate()
                except Exception:
                    pass
    finally:
        nm = os.path.join(tree, "node_modules")
        if os.path.lexists(nm):
            subprocess.run(["cmd", "/c", "rmdir", nm], capture_output=True)
        shutil.rmtree(tree, ignore_errors=True)


async def main():
    res = await session(lambda c: c.eval(JS, timeout=120))
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--freeze-commit", default="", help="extract commit into temp dir and write frozen_off.json and frozen_on.json")
    ap.add_argument("--port", type=int, default=int(os.environ.get("SCUMBLE_CDP_PORT", "9627")))
    args = ap.parse_args()
    if args.freeze_commit:
        freeze_from_commit(args.freeze_commit, args.port)
    else:
        asyncio.run(main())
