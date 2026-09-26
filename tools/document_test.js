// The .scumble container (electron/main/docfile.js, docs/PLAN_DOCUMENTS.md step D1) in plain Node, on scratch
// mirrors; every file it writes is also read by Python's zipfile (testzip), an independent reader.
//
//  1. a document with every kind of ref (base, layer, mask, a font, a result of the history, a plugin's 3D model)
//     written and opened into an empty mirror: every file byte-exact, the document and the plugin data equal;
//  2. Python's zipfile reads it: testzip() clean, `mimetype` first and stored, the same names and bytes;
//  3. opened into the mirror it came from, nothing is copied;
//  4. a file of the same size but other bytes already in the mirror: imported under a free name, the refs renamed;
//  5. zip64 (the thresholds lowered): written, read back and read by Python;
//  6. a damaged entry, a truncated file, a file with no zip directory: refused, nothing written to the mirror;
//  7. a crafted file whose header names `files/input/../../x` or an absolute entry: refused before anything is
//     written, nothing outside the mirror;
//  8. versions: a newer minReader is refused, a newer version with minReader 1 opens with a note;
//  9. a full disk mid-write (the fault hook), a cancel, a target held by another program (EBUSY on the rename,
//     briefly and for good): the target stays as it was and no temporary file is left;
// 10. the sweep deletes the listed temporary files of a killed save and nothing else;
// 11. isScumble recognises the file by its first bytes and nothing else.
//
//     node tools/document_test.js [--big]     --big adds a real zip64 case above 4 GiB (a sparse file)
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const doc = require(path.join(ROOT, "electron", "main", "docfile.js"));

const BIG = process.argv.includes("--big");
let failed = 0;
const results = [];
async function check(name, fn) {
    try {
        const detail = await fn();
        results.push(`[ok] ${name}${detail ? ": " + detail : ""}`);
    } catch (err) {
        failed++;
        results.push(`[FAIL] ${name}: ${err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err}`);
    } finally {
        doc.resetLimits();
    }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-doc-"));
const mirror = (name) => path.join(scratch, name);
function put(root, ref, bytes) {
    const p = doc.mirrorPath(root, ref.type || "input", ref.subfolder, ref.filename);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
    return p;
}
const rnd = (n, seed) => { const b = crypto.randomBytes(n); b[0] = seed; return b; };

/** A document with every kind of ref, its files in mirror `root`; returns { document, plugins, files } for a save. */
function fixture(root) {
    const R = (filename, subfolder = "inpaint_canvas", type = "input") => ({ filename, subfolder, type });
    const refs = {
        base: R("photo.png"), layer: R("n3_layer_1a2b3c.png"), mask: R("n3_lmask_9f8e7d.png"), font: R("My Font.ttf", "inpaint_canvas/fonts"),
        result: R("result_00001_.png", "inpaint_canvas", "output"), glb: R("cube.glb"),
    };
    const sizes = { base: 300000, layer: 200000, mask: 50000, font: 70000, result: 120000, glb: 90000 };
    const paths = {};
    Object.entries(refs).forEach(([k, ref], i) => { paths[k] = put(root, ref, rnd(sizes[k], i + 1)); });
    const document = {
        width: 1200, height: 800, base: { ref: { ...refs.base } }, prompt: "a red car",
        layers: [
            { id: "L1", kind: "paint", ref: { ...refs.layer }, mask: { ...refs.mask }, x: 0, y: 0, w: 1200, h: 800 },
            { id: "L2", kind: "text", ref: { ...refs.layer }, text: { content: "Hi", fontRef: { ...refs.font } } },
        ],
        history: [{ prompt: "a red car", seed: 7, ref: { ...refs.result } }],
        selection: "data:image/png;base64,iVBORw0KGgo=",
    };
    const plugins = { glb: { objects: { L1: { ref: { ...refs.glb }, params: { yaw: 30 } } } } };
    return { document, plugins, refs, paths };
}

/** The file list of a save: every ref once, its size, required unless it is only in the result history. */
function filesOf(root, document, plugins) {
    const history = doc.collectRefs(document.history || []);
    const all = doc.collectRefs({ document, plugins });
    const out = [];
    for (const [k, list] of all) {
        const ref = list[0];
        const p = doc.mirrorPath(root, ref.type, ref.subfolder, ref.filename);
        const inState = doc.collectRefs({ ...document, history: [] }).has(k) || doc.collectRefs(plugins).has(k);
        out.push({ ref, path: p, size: fs.statSync(p).size, required: inState || !history.has(k) });
    }
    return out;
}

async function save(root, target, extra = {}) {
    const f = extra.fix || fixture(root);
    const files = filesOf(root, f.document, f.plugins);
    const header = doc.buildHeader({ document: f.document, plugins: f.plugins, app: "0.1.30", summary: { name: "t", width: 1200, height: 800 }, files });
    const r = await doc.writeDocument({ target, header, thumbnail: Buffer.from("thumbnail-png"), files, registry: extra.registry || null, ...extra.opts });
    return { r, f, header, files };
}

function python(code, ...args) {
    const r = spawnSync("python", ["-c", code, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("python: " + (r.stderr || r.stdout).slice(-600));
    return r.stdout.trim();
}
const PY_READ = [
    "import sys, zipfile, json, hashlib",
    "z = zipfile.ZipFile(sys.argv[1])",
    "bad = z.testzip()",
    "infos = z.infolist()",
    "out = {'bad': bad, 'names': [i.filename for i in infos], 'first_stored': infos[0].compress_type == zipfile.ZIP_STORED and infos[0].filename == 'mimetype' and infos[0].extra == b'',",
    "       'mime': z.read('mimetype').decode(), 'sha': {i.filename: hashlib.sha256(z.read(i.filename)).hexdigest() for i in infos}}",
    "print(json.dumps(out))",
].join("\n");

function listTree(dir) {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p).split(path.sep).join("/")); } };
    if (fs.existsSync(dir)) walk(dir);
    return out.sort();
}

(async () => {
    try {
        const A = mirror("A"), file = path.join(scratch, "portrait.scumble");
        let saved;
        await check("a_document_goes_into_an_empty_mirror_byte_exact", async () => {
            saved = await save(A, file);
            const B = mirror("B");
            const o = await doc.openDocument({ file, mirrorRoot: B });
            assert(o.imported.length === 6 && !o.reused.length && !Object.keys(o.renamed).length, "imported " + JSON.stringify(o));
            for (const [k, ref] of Object.entries(saved.f.refs)) {
                const p = doc.mirrorPath(B, ref.type, ref.subfolder, ref.filename);
                assert(fs.existsSync(p) && sha(p) === sha(saved.f.paths[k]), k + " is not byte-exact");
            }
            assert(same(o.header.document, saved.f.document) && same(o.header.plugins, saved.f.plugins), "the document or the plugin data changed");
            assert(o.thumbnail && o.thumbnail.toString() === "thumbnail-png", "the thumbnail");
            assert(!listTree(B).some((n) => /importing/.test(n)), "an .importing file was left: " + listTree(B));
            return `${saved.r.entries} entries, ${saved.r.bytes} bytes in ${saved.r.ms} ms`;
        });
        await check("python_reads_it", () => {
            const py = JSON.parse(python(PY_READ, file));
            assert(py.bad === null, "testzip: " + py.bad);
            assert(py.first_stored && py.mime === doc.MIME, "mimetype is not the first stored entry without extra: " + JSON.stringify(py.names.slice(0, 2)));
            assert(py.names[1] === doc.HEADER_ENTRY && py.names[2] === doc.THUMB_ENTRY, "the order: " + py.names.slice(0, 3));
            for (const f of saved.files) assert(py.sha[doc.entryOf(f.ref)] === sha(f.path), "python reads other bytes for " + doc.entryOf(f.ref));
            return `${py.names.length} names`;
        });
        await check("opened_into_its_own_mirror_nothing_is_copied", async () => {
            const before = listTree(A).map((n) => n + ":" + fs.statSync(path.join(A, n)).mtimeMs).join();
            const o = await doc.openDocument({ file, mirrorRoot: A });
            assert(o.reused.length === 6 && !o.imported.length, JSON.stringify(o.imported));
            const after = listTree(A).map((n) => n + ":" + fs.statSync(path.join(A, n)).mtimeMs).join();
            assert(before === after, "the mirror changed");
            return "6 reused";
        });
        await check("other_bytes_under_the_same_name_go_under_a_free_name", async () => {
            const C = mirror("C");
            put(C, saved.f.refs.base, rnd(300000, 99));                   // the same size, other bytes
            const o = await doc.openDocument({ file, mirrorRoot: C });
            assert(o.renamed["input/inpaint_canvas/photo.png"] === "photo (1).png", "renamed " + JSON.stringify(o.renamed));
            assert(o.header.document.base.ref.filename === "photo (1).png", "the ref was not renamed");
            const p = doc.mirrorPath(C, "input", "inpaint_canvas", "photo (1).png");
            assert(sha(p) === sha(saved.f.paths.base), "the imported file is not the document's");
            assert(sha(doc.mirrorPath(C, "input", "inpaint_canvas", "photo.png")) !== sha(saved.f.paths.base), "the mirror's own file was overwritten");
            return "photo.png -> photo (1).png";
        });
        await check("zip64_is_written_and_read", async () => {
            doc.setLimits({ u32: 60000, u16: 3 });
            const f64 = path.join(scratch, "zip64.scumble");
            const s = await save(mirror("A64"), f64);
            const o = await doc.openDocument({ file: f64, mirrorRoot: mirror("B64") });
            assert(o.imported.length === 6 && same(o.header.document, s.f.document), "zip64 round trip");
            const py = JSON.parse(python(PY_READ, f64));
            assert(py.bad === null && py.names.length === s.r.entries, "python on zip64: " + JSON.stringify(py.names));
            for (const f of s.files) assert(py.sha[doc.entryOf(f.ref)] === sha(f.path), "python reads other bytes for " + doc.entryOf(f.ref));
            return `${s.r.entries} entries with zip64 records and extra fields`;
        });
        await check("a_damaged_or_truncated_file_is_refused_and_writes_nothing", async () => {
            const buf = fs.readFileSync(file);
            const dir = await (async () => { const fh = await fs.promises.open(file, "r"); try { return await doc.readDirectory(fh); } finally { await fh.close(); } })();
            const layer = dir.entries.find((e) => /n3_layer/.test(e.name));
            const bad = Buffer.from(buf); bad[layer.dataStart + 1000] ^= 0xFF;
            const cases = { damaged: bad, truncated: buf.subarray(0, buf.length - 5000), "no directory": buf.subarray(0, 200000) };
            const out = [];
            for (const [what, bytes] of Object.entries(cases)) {
                const p = path.join(scratch, what.replace(/ /g, "_") + ".scumble");
                fs.writeFileSync(p, bytes);
                const M = mirror("bad_" + what.replace(/ /g, "_"));
                let err = null;
                try { await doc.openDocument({ file: p, mirrorRoot: M }); } catch (e) { err = e; }
                assert(err, what + " was opened");
                if (what === "damaged") assert(/damaged/.test(err.message), "damaged: " + err.message);
                assert(!listTree(M).some((n) => /n3_layer|importing/.test(n)), what + " left files: " + listTree(M));
                out.push(`${what}: ${err.message.slice(0, 50)}`);
            }
            return out.join("; ");
        });
        await check("a_crafted_name_is_refused_before_anything_is_written", async () => {
            const out = [];
            for (const entry of ["files/input/../../escaped.png", "files/input//../escaped.png", "/abs/escaped.png", "files/other/x.png", "files/input/a:b.png"]) {
                const p = path.join(scratch, "crafted.scumble");
                const hdr = JSON.stringify({ format: "scumble", version: 1, minReader: 1, document: { base: null }, plugins: {}, files: [{ entry, size: 3, required: true }] });
                python(["import sys, zipfile", "z = zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_STORED)",
                    "z.writestr('mimetype', 'application/x-scumble')", "z.writestr('scumble/document.json', sys.argv[2])",
                    "z.writestr(sys.argv[3], 'abc')", "z.close()"].join("\n"), p, hdr, entry);
                const M = mirror("crafted");
                let err = null;
                try { await doc.openDocument({ file: p, mirrorRoot: M }); } catch (e) { err = e; }
                assert(err && /may not carry/.test(err.message), entry + ": " + (err && err.message));
                assert(!fs.existsSync(path.join(scratch, "escaped.png")) && !fs.existsSync(path.join(M, "..", "escaped.png")) && !listTree(M).length, entry + " wrote a file");
                out.push(entry);
            }
            return `${out.length} names refused`;
        });
        await check("a_newer_reader_is_refused_a_newer_version_opens_with_a_note", async () => {
            const f = fixture(mirror("V"));
            const files = filesOf(mirror("V"), f.document, f.plugins);
            const make = async (patch, name) => {
                const header = { ...doc.buildHeader({ document: f.document, plugins: f.plugins, files }), ...patch };
                const p = path.join(scratch, name);
                await doc.writeDocument({ target: p, header, files });
                return p;
            };
            let err = null;
            try { await doc.openDocument({ file: await make({ version: 3, minReader: 2, app: "0.2.0" }, "newer_reader.scumble"), mirrorRoot: mirror("V2") }); } catch (e) { err = e; }
            assert(err && /newer Scumble/.test(err.message) && !listTree(mirror("V2")).length, "a newer minReader: " + (err && err.message));
            const o = await doc.openDocument({ file: await make({ version: 2, minReader: 1, app: "0.1.40" }, "newer.scumble"), mirrorRoot: mirror("V3") });
            assert(o.notes.some((n) => /newer Scumble/.test(n)), "no note for a newer version: " + JSON.stringify(o.notes));
            return "minReader 2 refused; version 2 opened with a note";
        });
        await check("a_full_disk_a_cancel_or_a_held_file_leave_the_target_as_it_was", async () => {
            const target = path.join(scratch, "keep.scumble");
            fs.writeFileSync(target, "the old file");
            const temps = () => fs.readdirSync(scratch).filter((n) => /\.saving-/.test(n));
            const registry = path.join(scratch, "document-temps.json");
            const out = [];
            const tryCase = async (what, opts) => {
                let err = null;
                try { await save(mirror("F"), target, { registry, opts }); } catch (e) { err = e; }
                assert(err, what + " did not fail");
                assert(fs.readFileSync(target, "utf8") === "the old file", what + " changed the target");
                assert(!temps().length, what + " left " + temps());
                assert(JSON.parse(fs.readFileSync(registry, "utf8")).length === 0, what + " left the temp listed");
                out.push(`${what}: ${err.message.slice(0, 40)}`);
            };
            await tryCase("full disk", { fault: { enospcAt: 250000 } });
            const ac = new AbortController();
            await tryCase("cancel", { signal: ac.signal, onProgress: ({ done }) => { if (done > 100000) ac.abort(); } });
            let busy = 0;
            const held = async () => { busy++; const e = new Error("busy"); e.code = "EBUSY"; throw e; };
            await tryCase("held for good", { ops: { rename: held } });
            assert(busy >= 20, "the rename was not retried: " + busy);
            let n = 0;
            const briefly = async (a, b) => { if (n++ < 2) { const e = new Error("busy"); e.code = "EBUSY"; throw e; } return fs.promises.rename(a, b); };
            await save(mirror("F"), target, { registry, opts: { ops: { rename: briefly } } });
            assert(n === 3 && fs.statSync(target).size > 800000 && !temps().length, "a briefly held target was not written: " + n);
            out.push("held briefly: written after 2 retries");
            return out.join("; ");
        });
        await check("the_sweep_deletes_only_listed_temporary_files", () => {
            const registry = path.join(scratch, "sweep.json");
            const left = path.join(scratch, "x.scumble.saving-123-4"), mine = path.join(scratch, "x.scumble"), odd = path.join(scratch, "notes.txt");
            for (const p of [left, mine, odd]) fs.writeFileSync(p, "x");
            fs.writeFileSync(registry, JSON.stringify([left, mine, odd, path.join(scratch, "gone.saving-1-1")]));
            const removed = doc.sweepTemps(registry);
            assert(removed.length === 1 && removed[0] === left, "removed " + JSON.stringify(removed));
            assert(fs.existsSync(mine) && fs.existsSync(odd) && !fs.existsSync(left), "the sweep deleted a file that is no temporary");
            assert(JSON.parse(fs.readFileSync(registry, "utf8")).length === 0, "the list was not emptied");
            return "1 of 4 listed paths";
        });
        await check("isScumble_knows_the_file_by_its_first_bytes", () => {
            const head = fs.readFileSync(file).subarray(0, 64);
            const ora = Buffer.from(head); ora.write("image/openraster\u0000\u0000\u0000\u0000\u0000", 38, "ascii");
            assert(doc.isScumble(head) && !doc.isScumble(ora) && !doc.isScumble(Buffer.from("PNG....")), "isScumble");
            return "yes for .scumble, no for ORA and PNG";
        });
        if (BIG) {
            await check("a_real_zip64_file_above_4_GiB", async () => {
                const M = mirror("BIG");
                const ref = { type: "input", subfolder: "inpaint_canvas", filename: "huge.png" };
                const p = doc.mirrorPath(M, ref.type, ref.subfolder, ref.filename);
                fs.mkdirSync(path.dirname(p), { recursive: true });
                const fd = fs.openSync(p, "w"); fs.writeSync(fd, Buffer.from("start"), 0, 5, 0); fs.writeSync(fd, Buffer.from("end"), 0, 3, 4.3e9); fs.closeSync(fd);
                const document = { base: { ref } };
                const files = [{ ref, path: p, size: fs.statSync(p).size }];
                const target = path.join(scratch, "big.scumble");
                const r = await doc.writeDocument({ target, header: doc.buildHeader({ document, files }), files });
                const o = await doc.openDocument({ file: target, mirrorRoot: M });
                assert(o.reused.length === 1, "the big file did not come back the same");
                const py = python("import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\ni = z.getinfo('files/input/inpaint_canvas/huge.png')\nprint(i.file_size)", target);
                assert(Number(py) === files[0].size, "python size " + py);
                fs.unlinkSync(target); fs.unlinkSync(p);
                return `${(r.bytes / 1073741824).toFixed(2)} GiB in ${r.ms} ms`;
            });
        }
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    for (const r of results) console.log(r);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})();
