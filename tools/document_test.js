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

/** What a zip reader that walks the local headers sees: each entry's local CRC, version and zip64 extra, and whether
 * the zip64 end record is there (readers that use only the central directory would not notice a missing local CRC). */
async function localFacts(file) {
    const fh = await fs.promises.open(file, "r");
    try {
        const d = await doc.readDirectory(fh);
        const entries = [];
        for (const en of d.entries) {
            const lh = Buffer.alloc(30);
            await fh.read(lh, 0, 30, en.offset);
            const nlen = lh.readUInt16LE(26), xlen = lh.readUInt16LE(28);
            const extra = Buffer.alloc(xlen);
            if (xlen) await fh.read(extra, 0, xlen, en.offset + 30 + nlen);
            entries.push({ name: en.name, size: en.size, crc: en.crc, localCrc: lh.readUInt32LE(14) >>> 0, version: lh.readUInt16LE(4), zip64: xlen >= 4 && extra.readUInt16LE(0) === 0x0001 });
        }
        const { size } = await fh.stat();
        const tail = Buffer.alloc(Math.min(size, 200));
        await fh.read(tail, 0, tail.length, size - tail.length);
        return { entries, zip64End: tail.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])) >= 0 };
    } finally {
        await fh.close();
    }
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
        await check("every_local_header_carries_its_crc", async () => {
            const lf = await localFacts(file);
            const bad = lf.entries.filter((e) => e.localCrc !== e.crc);
            assert(!bad.length, "local CRC differs from the directory's: " + bad.map((e) => e.name).join(", "));
            return `${lf.entries.length} entries`;
        });
        await check("other_bytes_under_the_same_name_go_under_a_free_name", async () => {
            const C = mirror("C");
            put(C, saved.f.refs.base, rnd(300000, 99));                   // the same size, other bytes
            put(C, saved.f.refs.glb, rnd(90000, 98));                     // the plugin's file too: its ref is renamed as well
            const o = await doc.openDocument({ file, mirrorRoot: C });
            assert(o.renamed["input/inpaint_canvas/photo.png"] === "photo (1).png", "renamed " + JSON.stringify(o.renamed));
            assert(o.header.document.base.ref.filename === "photo (1).png", "the ref was not renamed");
            assert(o.header.plugins.glb.objects.L1.ref.filename === "cube (1).glb", "the plugin's ref was not renamed: " + JSON.stringify(o.header.plugins));
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
        await check("zip64_starts_at_the_limit_itself", async () => {
            // 0xFFFFFFFF and 0xFFFF are the markers that say "look in the zip64 fields": a size or count equal to the
            // limit must go there already (the limits lowered so a small file reaches them exactly)
            doc.setLimits({ u32: 300000, u16: 9 });
            const f64 = path.join(scratch, "zip64edge.scumble");
            const s = await save(mirror("E64"), f64);
            assert(s.r.entries === 9, "the fixture has " + s.r.entries + " entries, the test needs 9");
            const lf = await localFacts(f64);
            const base = lf.entries.find((e) => e.name === "files/input/inpaint_canvas/photo.png");
            assert(base && base.size === 300000 && base.zip64 && base.version === 45, "an entry of exactly the limit has no zip64 extra: " + JSON.stringify(base));
            assert(lf.zip64End, "an entry count of exactly the limit wrote no zip64 end record");
            const py = JSON.parse(python(PY_READ, f64));
            assert(py.bad === null && py.names.length === 9, "python on the edge file");
            doc.resetLimits();
            doc.setLimits({ u16: 9 });                                   // the count alone at the limit, sizes and offsets far below
            const fc = path.join(scratch, "zip64count.scumble");
            const sc = await save(mirror("C64"), fc);
            const lc = await localFacts(fc);
            assert(sc.r.entries === 9 && lc.zip64End && !lc.entries.some((e) => e.zip64), "an entry count of exactly the limit alone wrote no zip64 end record");
            assert(JSON.parse(python(PY_READ, fc)).bad === null, "python on the count edge file");
            return "size and count at the limit take the zip64 fields";
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
            for (const entry of ["files/input/../../escaped.png", "files/input//../escaped.png", "/abs/escaped.png", "files/other/x.png", "files/input/a:b.png",
                "files/input/inpaint_canvas/CON.png", "files/input/nul", "files/input/LPT1.txt", "files/input/x/a.png.", "files/input/x /a.png"]) {
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
        await check("a_ref_to_a_file_the_document_does_not_carry", async () => {
            // a crafted document whose state names a file it does not carry: refused before anything is written, so it
            // cannot pick up a file this mirror holds under that name; one in the result history only leaves the history
            const M = mirror("U"), f = fixture(M);
            const files = filesOf(M, f.document, f.plugins);
            const craft = async (mutate, name) => {
                const header = doc.buildHeader({ document: JSON.parse(JSON.stringify(f.document)), plugins: f.plugins, files });
                mutate(header);
                const p = path.join(scratch, name);
                await doc.writeDocument({ target: p, header, files });
                return p;
            };
            const secret = { filename: "secret.png", subfolder: "inpaint_canvas", type: "input" };
            const T = mirror("U2");
            put(T, secret, Buffer.from("this profile's own file"));
            const pLayer = await craft((h) => { h.document.layers.push({ id: "L9", kind: "paint", ref: { ...secret } }); }, "unlisted.scumble");
            let err = null;
            try { await doc.openDocument({ file: pLayer, mirrorRoot: T }); } catch (e) { err = e.message; }
            assert(err && /does not carry: secret\.png/.test(err), "an unlisted layer ref: " + err);
            assert(listTree(T).length === 1, "files were written before the refusal: " + listTree(T).join(", "));
            const pPlug = await craft((h) => { h.plugins = { x: { ref: { ...secret } } }; }, "unlisted_plugin.scumble");
            err = null;
            try { await doc.openDocument({ file: pPlug, mirrorRoot: T }); } catch (e) { err = e.message; }
            assert(err && /does not carry/.test(err), "an unlisted plugin ref: " + err);
            const pHist = await craft((h) => { h.document.history.push({ prompt: "x", ref: { filename: "gone.png", subfolder: "inpaint_canvas", type: "output" } }); }, "unlisted_history.scumble");
            const o = await doc.openDocument({ file: pHist, mirrorRoot: mirror("U3") });
            assert(o.header.document.history.length === 1 && o.notes.some((n) => /1 result of the history left out/.test(n)), "an unlisted history ref: " + JSON.stringify(o.notes));
            return "layer and plugin refs refused, the history entry left out";
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
        // ---- electron/main/documents.js: the app's service around the container (step D2) ----
        const { Documents, cleanDocument, documentArgs } = require(path.join(ROOT, "electron", "main", "documents.js"));
        await check("the_service_saves_opens_and_leaves_out_a_gone_history_file", async () => {
            const M = mirror("S1"), M2 = mirror("S2");
            const f = fixture(M);
            const sent = [];
            const svc = new Documents({ mirrorRoot: M, registry: path.join(scratch, "svc-temps.json"), send: (c, p) => sent.push([c, p]), app: "0.1.30" });
            fs.unlinkSync(f.paths.result);                                     // the only history file is gone
            const target = path.join(scratch, "svc.scumble");
            const r = await svc.write({ reqId: "s1", path: target, document: JSON.stringify(f.document), plugins: f.plugins, extra: { future: 1 } });
            assert(r.notes.length === 1 && /1 result/.test(r.notes[0]), "notes " + JSON.stringify(r.notes));
            assert(!svc.busy && svc.keepKeys().length === 0, "a job was left behind");
            assert(sent.some(([c, p]) => c === "documents:progress" && p.reqId === "s1"), "no progress was sent");
            const o = await new Documents({ mirrorRoot: M2 }).open({ reqId: "o1", path: target });
            assert(o.document.history.length === 0, "the history entry of the gone file was kept");
            assert(o.document.future === 1 && o.extra.future === 1, "the extra field did not travel");
            assert(same(o.plugins, f.plugins) && o.document.layers.length === 2, "the document or its plugin data changed");
            assert(sha(doc.mirrorPath(M2, "input", "inpaint_canvas", "cube.glb")) === sha(f.paths.glb), "the plugin's file did not come along");
            return `${r.entries} entries, note: ${r.notes[0]}`;
        });
        await check("the_service_refuses_a_missing_required_file_and_a_second_job_on_one_path", async () => {
            const M = mirror("S3");
            const f = fixture(M);
            const svc = new Documents({ mirrorRoot: M });
            const target = path.join(scratch, "svc2.scumble");
            fs.unlinkSync(f.paths.mask);
            let err = null;
            try { await svc.write({ path: target, document: f.document, plugins: f.plugins }); } catch (e) { err = e.message; }
            assert(err && /n3_lmask_9f8e7d\.png is not in the local store/.test(err) && !fs.existsSync(target), "a missing mask: " + err);
            put(M, f.refs.mask, rnd(50000, 3));
            // a slow fetch keeps the first job open while the second asks for the same path (another spelling of it)
            let release;
            const gate = new Promise((res) => { release = res; });
            const slow = new Documents({ mirrorRoot: M, fetchMissing: async () => { await gate; return false; } });
            fs.unlinkSync(f.paths.result);
            const first = slow.write({ reqId: "a", path: target, document: f.document, plugins: f.plugins });
            await new Promise((res) => setTimeout(res, 50));
            let second = null;
            try { await slow.write({ reqId: "b", path: target.toUpperCase(), document: f.document, plugins: f.plugins }); } catch (e) { second = e.message; }
            const idle = slow.idle();
            release();
            await first; await idle;
            if (process.platform === "win32") assert(second && /already being saved/.test(second), "a second job on the path: " + second);
            assert(!slow.busy, "idle() resolved while a job ran");
            return "missing mask refused; second job: " + (second || "(case-sensitive platform)");
        });
        await check("the_service_cancel_leaves_the_target_and_cleans_the_selection_fields", async () => {
            const M = mirror("S4");
            const f = fixture(M);
            const target = path.join(scratch, "svc3.scumble");
            fs.writeFileSync(target, "old bytes");
            const svc = new Documents({ mirrorRoot: M, send: (c, p) => { if (c === "documents:progress") svc.cancel(p.reqId); } });
            let err = null;
            try { await svc.write({ reqId: "c", path: target, document: f.document, plugins: f.plugins }); } catch (e) { err = e.message; }
            assert(err && /cancelled/.test(err), "cancel: " + err);
            assert(fs.readFileSync(target, "utf8") === "old bytes", "the target changed");
            assert(!fs.readdirSync(scratch).some((n) => n.startsWith("svc3.scumble.saving-")), "a temporary file was left");
            const notes = [];
            const d = cleanDocument({ selection: "javascript:alert(1)", selectionBox: [0, 0, 1, 1], selections: [{ name: "a", url: "data:image/png;base64,AA==" }, { url: "http://x/y.png" }, null] }, notes);
            assert(d.selection === undefined && d.selectionBox === undefined && d.selections.length === 1 && notes.length === 2, "cleanDocument " + JSON.stringify(d));
            const argv = documentArgs(["--flag", "x.png", target, path.join(scratch, "nope.scumble")], scratch);
            assert(argv.length === 1 && argv[0] === target, "documentArgs " + JSON.stringify(argv));
            return "target kept; 2 selection fields dropped; argv found 1 of 4";
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
