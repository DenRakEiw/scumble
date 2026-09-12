// Plain-Node check of the model folder scan (electron/main/onnx/models.js), no Electron
// and no real models: a synthetic ComfyUI models folder with the right byte sizes.
//
//     node tools/scan_test.js                 # the synthetic folder, PASS / FAIL
//     node tools/scan_test.js --dir <folder>  # scan a real folder and print the report
//
// The synthetic folder holds SAM2 tiny under the exporter's own names, BiRefNet lite as a
// Hugging Face snapshot (`.../onnx/model.onnx`, found by size and layout), a decoder file
// of the size all four SAM2 decoders share (must not be linked by size alone), and the
// PyTorch weights the ComfyUI nodes keep (safetensors, pth), which have to be reported
// and never linked. The big files are created by truncate, so nothing is written.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const models = require("../electron/main/onnx/models");

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

function fmt(n) { return n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : n + " B"; }

async function report(dir) {
    const t0 = Date.now();
    const walk = await models.scanFolder(dir);
    const m = models.matchScan(walk);
    console.log(`scanned ${walk.files.length} weight files in ${walk.dirs} folders, ${Date.now() - t0} ms${walk.truncated ? " (truncated)" : ""}`);
    for (const model of models.MODELS) {
        const loc = models.locate(model, dir, m.links);
        const other = m.elsewhere[model.id] || [];
        const state = loc.present ? (loc.linked ? "linked   " : "present  ") : other.length ? "elsewhere" : "missing  ";
        const where = loc.present ? loc.files.map((f) => f.rel).join(", ") : other.join(", ");
        console.log(`  ${state} ${model.label.padEnd(14)} ${where}`);
    }
    return { walk, m };
}

function mk(dir, rel, size) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fd = fs.openSync(p, "w");
    if (size <= 64) fs.writeSync(fd, Buffer.alloc(size || 1, 1)); else fs.ftruncateSync(fd, size);
    fs.closeSync(fd);
    return p;
}

async function synthetic() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-scan-"));
    try {
        const tiny = models.byId("sam2_tiny"), lite = models.byId("birefnet_lite");
        const enc = tiny.files.find((f) => f.role === "encoder"), dec = tiny.files.find((f) => f.role === "decoder");
        fs.mkdirSync(path.join(dir, "checkpoints"));                                           // makes it a ComfyUI models folder
        mk(dir, "sam2/sam2_hiera_tiny.safetensors", 16);                                       // the ComfyUI node's weights
        mk(dir, "RMBG/RMBG-2.0/model.safetensors", 16);
        mk(dir, "RMBG/RMBG-2.0/birefnet.py", 16);                                              // not a weight file
        mk(dir, "rembg/RMBG-1.4.pth", 16);
        mk(dir, "sam2/export/" + enc.name, enc.size);                                          // ONNX under the exporter's names
        mk(dir, "sam2/export/" + dec.name, dec.size);
        mk(dir, "sam2/export/sam2_hiera_large.decoder.onnx", dec.size);                        // same size as every SAM2 decoder
        mk(dir, "BiRefNet/BiRefNet_lite-ONNX/onnx/model.onnx", lite.files[0].size);            // a Hugging Face snapshot
        mk(dir, "insightface/det_10g.onnx", 5000);                                             // someone else's ONNX
        mk(dir, ".cache/huggingface/blobs/abc.onnx", lite.files[0].size);                      // hidden folders are skipped
        const { walk, m } = await report(dir);
        const checks = {
            walkedNoHidden: walk.files.every((f) => !f.rel.startsWith(".cache")),
            tinyLinked: !!(m.links.sam2_tiny && m.links.sam2_tiny.encoder.endsWith(enc.name) && m.links.sam2_tiny.decoder.endsWith(dec.name)),
            liteLinkedBySnapshot: !!(m.links.birefnet_lite && /BiRefNet_lite-ONNX/.test(m.links.birefnet_lite.model)),
            largeNotLinkedBySize: !m.links.sam2_large,          // its encoder is missing, and a decoder never links by size alone
            smallNotLinked: !m.links.sam2_small,
            othersReported: (m.elsewhere.sam2_tiny || [])[0] === "sam2/sam2_hiera_tiny.safetensors"
                && (m.elsewhere.rmbg2 || [])[0] === "RMBG/RMBG-2.0/model.safetensors"
                && (m.elsewhere.rmbg14 || [])[0] === "rembg/RMBG-1.4.pth",
            liteNotReportedAsOther: !m.elsewhere.birefnet_lite,
            locateSeesLinks: (() => { const l = models.locate(lite, dir, m.links); return l.present && l.linked && l.files[0].rel === "BiRefNet/BiRefNet_lite-ONNX/onnx/model.onnx"; })(),
            pathsUseLinks: !!(models.paths(tiny, dir, m.links) && models.paths(tiny, dir, m.links).encoder.endsWith(enc.name)),
            withoutLinksAbsent: !models.locate(lite, dir).present,
            staleLinkIgnored: (() => { const l = { birefnet_lite: { model: path.join(dir, "gone.onnx") } }; return !models.locate(lite, dir, l).present; })(),
            describeCarriesElsewhere: models.describeAll(dir, m.links, m.elsewhere).find((x) => x.id === "rmbg2").elsewhere.length === 1,
        };
        const ok = Object.values(checks).every(Boolean);
        console.log(ok ? "PASS" : "FAIL", JSON.stringify(checks));
        return ok;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

(async () => {
    const dir = flag("--dir");
    if (dir) { await report(dir); return; }
    process.exit((await synthetic()) ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
