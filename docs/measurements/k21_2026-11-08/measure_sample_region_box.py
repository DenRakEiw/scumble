"""Measure whether sampleRegionSettled("image", box, 1, { forRun: true, skipFilters: true })
returns identical or different RGBA bytes when box is 256x256 (65,536 px, software canvas)
vs 512x256 (131,072 px, >= 65,792 px accelerated threshold) vs 768x256 vs 1024x256,
under a half-transparent layer (and various opacities / blend modes) on both tiles and canvas backends.
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import cdp  # noqa: E402
from cdp import session  # noqa: E402

JS_PROBE = r"""(async () => {
    const { commands } = await import("./commands.js");
    const { host } = await import("./editor/host.js");
    await import("./shell.js");
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);

    const d = await run("new_document");
    await run("new_canvas", { doc: d.id, width: 1024, height: 512, color: "#13579b" });
    const ed = ednow(d.id);

    // Draw varied colours into basePx
    ed.basePx.drawInto([0, 0, 1024, 512], (ctx) => {
        for (let y = 0; y < 512; y += 4) {
            for (let x = 0; x < 1024; x += 4) {
                const r = (x * 37 + y * 13) & 255;
                const g = (x * 19 + y * 53 + 71) & 255;
                const b = (x * 73 + y * 29 + 149) & 255;
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                ctx.fillRect(x, y, 4, 4);
            }
        }
    });

    // Add a half-transparent layer (opacity 0.5) with both opaque and semi-transparent strokes
    const l1 = await run("add_paint_layer", { doc: d.id, name: "half_trans" });
    const layer1 = ed.layers.find((x) => x.id === l1.id);
    layer1.opacity = 0.5;
    layer1.px.drawInto([0, 0, 1024, 512], (ctx) => {
        for (let y = 0; y < 512; y += 8) {
            for (let x = 0; x < 1024; x += 8) {
                const r = (x * 91 + y * 41 + 17) & 255;
                const g = (x * 67 + y * 83 + 113) & 255;
                const b = (x * 23 + y * 97 + 211) & 255;
                const a = (((x + y) >> 3) % 7 + 1) / 8;
                ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
                ctx.fillRect(x, y, 8, 8);
            }
        }
    });
    ed.markLayerChanged(layer1);
    ed.renderLayers();
    ed.draw();
    if (ed.mipsSettled) await ed.mipsSettled();

    const readBox = async (box) => {
        const reg = await ed.sampleRegionSettled("image", box, 1, { forRun: true, skipFilters: true });
        const bw = box[2] - box[0], bh = box[3] - box[1];
        const sc = document.createElement("canvas");
        sc.width = bw; sc.height = bh;
        const sctx = sc.getContext("2d", { willReadFrequently: true });
        sctx.clearRect(0, 0, bw, bh);
        sctx.drawImage(reg, 0, 0);
        return sctx.getImageData(0, 0, bw, bh).data;
    };

    const compareSub = (small, sw, sh, big, bw, ox, oy) => {
        let diffPixels = 0, diffChannels = 0, maxDelta = 0;
        for (let y = 0; y < sh; y++) {
            for (let x = 0; x < sw; x++) {
                const si = (y * sw + x) * 4;
                const bi = ((y + oy) * bw + (x + ox)) * 4;
                let pixDiff = false;
                for (let c = 0; c < 4; c++) {
                    const d = Math.abs(small[si + c] - big[bi + c]);
                    if (d > 0) {
                        diffChannels++;
                        pixDiff = true;
                        if (d > maxDelta) maxDelta = d;
                    }
                }
                if (pixDiff) diffPixels++;
            }
        }
        return { diffPixels, diffChannels, maxDelta };
    };

    // Reference: 1024 x 256 full-row box [0, 0, 1024, 256]
    const b1024 = await readBox([0, 0, 1024, 256]);
    const b768 = await readBox([256, 0, 1024, 256]);
    const b512 = await readBox([256, 0, 768, 256]);
    const b256 = await readBox([256, 0, 512, 256]);
    // Also check a short bottom row 256x128 vs 512x128 vs 768x128 vs 1024x128
    const s1024 = await readBox([0, 256, 1024, 384]);
    const s768 = await readBox([256, 256, 1024, 384]);
    const s512 = await readBox([256, 256, 768, 384]);
    const s256 = await readBox([256, 256, 512, 384]);

    const res = {
        tileMode: !!ed.tileMode,
        row256: {
            "256x256_vs_512x256": compareSub(b256, 256, 256, b512, 512, 0, 0),
            "256x256_vs_768x256": compareSub(b256, 256, 256, b768, 768, 0, 0),
            "256x256_vs_1024x256": compareSub(b256, 256, 256, b1024, 1024, 256, 0),
            "512x256_vs_1024x256": compareSub(b512, 512, 256, b1024, 1024, 256, 0),
            "768x256_vs_1024x256": compareSub(b768, 768, 256, b1024, 1024, 256, 0),
        },
        row128: {
            "256x128_vs_768x128": compareSub(s256, 256, 128, s768, 768, 0, 0),
            "512x128_vs_768x128": compareSub(s512, 512, 128, s768, 768, 0, 0),
            "256x128_vs_1024x128": compareSub(s256, 256, 128, s1024, 1024, 256, 0),
            "512x128_vs_1024x128": compareSub(s512, 512, 128, s1024, 1024, 256, 0),
            "768x128_vs_1024x128": compareSub(s768, 768, 128, s1024, 1024, 256, 0),
        },
    };
    await run("close_document", { doc: d.id, force: true });
    return res;
})()"""


async def probe(c):
    return await c.eval(JS_PROBE, timeout=60)


def run_backend(port, tiles):
    env = dict(
        os.environ,
        SCUMBLE_CDP_PORT=str(port),
        SCUMBLE_TILES="1" if tiles == "on" else "0",
        SCUMBLE_STRICT="0",
    )
    os.environ["SCUMBLE_CDP_PORT"] = str(port)
    cdp.PORT = port
    subprocess.run([sys.executable, "tools/close_app.py"], cwd=ROOT, env=env, capture_output=True)
    profile = tempfile.mkdtemp(prefix=f"k21_probe_{tiles}_")
    elec = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")
    tile_arg = "--tiles" if tiles == "on" else "--no-tiles"
    proc = subprocess.Popen(
        [
            elec,
            ".",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}",
            "--use-fake-device-for-media-stream",
            tile_arg,
            "--no-comfy",
        ],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(90):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2)
                break
            except Exception:
                time.sleep(1)
        time.sleep(6)
        return asyncio.run(session(probe))
    finally:
        subprocess.run([sys.executable, "tools/close_app.py"], cwd=ROOT, env=env, capture_output=True)
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


def main():
    out = {
        "tiles": run_backend(9613, "on"),
        "canvas": run_backend(9614, "off"),
    }
    txt = json.dumps(out, indent=2)
    print(txt)
    out_path = os.path.join(HERE, "sample_region_box_size.json")
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(txt + "\n")


if __name__ == "__main__":
    main()
