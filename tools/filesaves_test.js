// An export saved in pieces (electron/main/filesaves.js, docs/BUGS.md: one IPC message of about 512 MiB or more ends
// the window's renderer) in plain Node, on a scratch folder:
//
//  1. a file in uneven pieces comes out byte for byte; no temporary file and no registry entry is left;
//  2. an existing target keeps its old bytes until the finish, then holds the new ones;
//  3. a cancel mid-way, a piece out of order, a piece past the size, a finish that came short, bytes that are not
//     bytes: the save is dropped, the target stays as it was, the temporary file and its registry entry go;
//  4. only the page that opened a save writes to it; a reload or an end drops that page's saves (abortAll) and no other's;
//  5. refused before anything is written: a folder as the target, a missing folder, a read-only target, a size the
//     drive cannot take, no size at all; the dialog's cancel makes nothing;
//  6. a target held by another program (EBUSY on the rename, briefly and for good);
//  7. two pieces sent without waiting land in order; an empty file;
//  8. a killed save leaves its temporary file in the registry and the next start's sweep deletes it.
//
//     node tools/filesaves_test.js
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { FileSaves } = require(path.join(ROOT, "electron", "main", "filesaves.js"));
const doc = require(path.join(ROOT, "electron", "main", "docfile.js"));

let failed = 0;
const results = [];
async function check(name, fn) {
    try {
        const detail = await fn();
        results.push(`[ok] ${name}${detail ? ": " + detail : ""}`);
    } catch (err) {
        failed++;
        results.push(`[FAIL] ${name}: ${err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err}`);
    }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
// on Windows the name of an open file goes at its unlink, so only the handle shows a drop that forgot to close it
async function closedHandle(fh, what) {
    assert(fh, what + ": no handle to look at");
    try { await fh.stat(); } catch (err) { assert(err.code === "EBADF", what + ": the handle answered " + err.code); return; }
    throw new Error(what + ": the temporary file's handle is still open");
}
async function rejects(p, re, what) {
    try { await p; } catch (err) { assert(re.test(err.message), `${what}: the error was "${err.message}"`); return err; }
    throw new Error(what + ": no error");
}

// bytes that differ at every offset a misplaced piece could land on
function pattern(n, seed = 0) {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 8) * 7 + seed) & 255;
    return b;
}

(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scumble-filesaves-"));
    const registry = path.join(scratch, "document-temps.json");
    const listed = () => { try { return JSON.parse(fs.readFileSync(registry, "utf8")); } catch (_) { return []; } };
    const temps = (dir = scratch) => fs.readdirSync(dir).filter((f) => doc.TEMP_RE.test(f));
    const clean = (what) => { assert(!temps().length, what + ": a temporary file is left: " + temps()); assert(!listed().length, what + ": the registry still lists " + listed()); };
    const saves = (opts = {}) => new FileSaves({ registry, ...opts });
    const A = 1, B = 2;   // two pages (webContents ids)
    // write `data` in pieces of `piece` bytes, awaiting each
    async function inPieces(fsv, owner, id, data, piece) {
        for (let at = 0; at < data.length; at += piece) await fsv.write(owner, { id, offset: at, data: new Uint8Array(data.subarray(at, Math.min(data.length, at + piece))) });
    }
    try {
        await check("1. a file in uneven pieces comes out byte for byte, and leaves nothing behind", async () => {
            const fsv = saves();
            const target = path.join(scratch, "one.psd");
            const data = pattern(5 * 1048576 + 12345);
            const open = await fsv.start(A, { name: "one.psd", path: target, size: data.length });
            assert(open && open.path === target && open.name === "one.psd", "start answered " + JSON.stringify(open));
            assert(listed().length === 1 && doc.TEMP_RE.test(listed()[0]) && path.dirname(listed()[0]) === scratch, "the temporary file is not listed beside the target: " + listed());
            assert(!fs.existsSync(target), "the target exists before the finish");
            await inPieces(fsv, A, open.id, data, 1048576 + 7);
            const r = await fsv.finish(A, { id: open.id });
            assert(r.path === target && r.bytes === data.length, "finish answered " + JSON.stringify(r));
            assert(fs.readFileSync(target).equals(data), "the bytes differ");
            assert(!fsv.busy, "the save is still open");
            clean("after the finish");
            return `${data.length} bytes in ${Math.ceil(data.length / (1048576 + 7))} pieces`;
        });

        await check("2. an existing target keeps its old bytes until the finish", async () => {
            const fsv = saves();
            const target = path.join(scratch, "two.png");
            const old = pattern(300000, 1), data = pattern(900000, 2);
            fs.writeFileSync(target, old);
            const open = await fsv.start(A, { name: "two.png", path: target, size: data.length });
            await inPieces(fsv, A, open.id, data.subarray(0, 600000), 200000);
            assert(fs.readFileSync(target).equals(old), "the target changed before the finish");
            await fsv.write(A, { id: open.id, offset: 600000, data: new Uint8Array(data.subarray(600000)) });
            await fsv.finish(A, { id: open.id });
            assert(fs.readFileSync(target).equals(data), "the target does not hold the new bytes");
            clean("after the replace");
        });

        await check("3a. a cancel mid-way leaves the target as it was", async () => {
            const fsv = saves();
            const target = path.join(scratch, "three.tif");
            const old = pattern(1000, 3);
            fs.writeFileSync(target, old);
            const open = await fsv.start(A, { path: target, size: 5000 });
            await fsv.write(A, { id: open.id, offset: 0, data: new Uint8Array(pattern(2000)) });
            const fh = fsv.saves.get(open.id).fh;
            assert(await fsv.abort(A, { id: open.id }) === true, "the abort answered false");
            await closedHandle(fh, "after the cancel");
            assert(fs.readFileSync(target).equals(old), "the target changed");
            clean("after the cancel");
            assert(await fsv.abort(A, { id: open.id }) === false, "a second abort answered true");
            await rejects(fsv.write(A, { id: open.id, offset: 2000, data: new Uint8Array(10) }), /no such save/, "a piece after the cancel");
        });

        const dropCase = async (what, bad) => {
            const fsv = saves();
            const target = path.join(scratch, "drop.ora");
            const old = pattern(777, 4);
            fs.writeFileSync(target, old);
            const open = await fsv.start(A, { path: target, size: 3000 });
            await fsv.write(A, { id: open.id, offset: 0, data: new Uint8Array(1000) });
            const fh = fsv.saves.get(open.id).fh;
            const err = await bad(fsv, open.id);
            await closedHandle(fh, what);
            assert(fs.readFileSync(target).equals(old), what + ": the target changed");
            clean(what);
            assert(!fsv.busy, what + ": the save is still open");
            await rejects(fsv.write(A, { id: open.id, offset: 1000, data: new Uint8Array(10) }), /no such save/, what + ": a piece after it");
            return err.message;
        };
        await check("3b. a piece out of order drops the save", () => dropCase("out of order", (fsv, id) => rejects(fsv.write(A, { id, offset: 1500, data: new Uint8Array(10) }), /came at byte 1500, not at 1000/, "a skipped piece")));
        await check("3c. a piece written twice drops the save", () => dropCase("twice", (fsv, id) => rejects(fsv.write(A, { id, offset: 0, data: new Uint8Array(1000) }), /came at byte 0, not at 1000/, "a repeated piece")));
        await check("3d. a piece past the size drops the save", () => dropCase("past the size", (fsv, id) => rejects(fsv.write(A, { id, offset: 1000, data: new Uint8Array(2001) }), /grew past its size of 3000/, "a piece too long")));
        await check("3e. a finish that came short drops the save", () => dropCase("short", (fsv, id) => rejects(fsv.finish(A, { id }), /came short: 1000 of 3000/, "a short finish")));
        await check("3f. a piece that is not bytes drops the save", () => dropCase("not bytes", (fsv, id) => rejects(fsv.write(A, { id, offset: 1000, data: "text" }), /not bytes/, "a string")));

        await check("4. only the page that opened a save writes to it; abortAll drops one page's saves", async () => {
            const fsv = saves();
            const ta = path.join(scratch, "a.png"), tb = path.join(scratch, "b.png");
            const a = await fsv.start(A, { path: ta, size: 20 });
            const b = await fsv.start(B, { path: tb, size: 20 });
            await rejects(fsv.write(B, { id: a.id, offset: 0, data: new Uint8Array(20) }), /no such save/, "another page's piece");
            assert(await fsv.abort(B, { id: a.id }) === false, "another page aborted the save");
            await rejects(fsv.finish(B, { id: a.id }), /no such save/, "another page's finish");
            await fsv.write(A, { id: a.id, offset: 0, data: new Uint8Array(10) });   // still the owner's
            const fa = fsv.saves.get(a.id).fh;
            assert(await fsv.abortAll(A) === 1, "abortAll(A) dropped other than one");
            await closedHandle(fa, "after abortAll(A)");
            await rejects(fsv.write(A, { id: a.id, offset: 10, data: new Uint8Array(10) }), /no such save/, "A's save after its abortAll");
            await fsv.write(B, { id: b.id, offset: 0, data: new Uint8Array(20) });
            await fsv.finish(B, { id: b.id });
            assert(fs.readFileSync(tb).length === 20 && !fs.existsSync(ta), "the wrong save went");
            const c = await fsv.start(A, { path: ta, size: 5 }), d = await fsv.start(B, { path: tb, size: 5 });
            assert(c && d && await fsv.abortAll() === 2 && !fsv.busy, "abortAll() did not drop every save");
            assert(fs.readFileSync(tb).length === 20, "abortAll touched the saved target");
            clean("after abortAll");
            fs.unlinkSync(tb);
        });

        await check("5. refused before anything is written", async () => {
            const fsv = saves();
            const folder = path.join(scratch, "folder");
            fs.mkdirSync(folder);
            await rejects(fsv.start(A, { path: folder, size: 10 }), /is a folder/, "a folder");
            await rejects(fsv.start(A, { path: path.join(scratch, "no", "such", "x.png"), size: 10 }), /folder .* does not exist/, "a missing folder");
            const ro = path.join(scratch, "ro.png");
            fs.writeFileSync(ro, "old");
            fs.chmodSync(ro, 0o444);
            try {
                await rejects(fsv.start(A, { path: ro, size: 10 }), /is read-only/, "a read-only target");
                assert(fs.readFileSync(ro, "utf8") === "old", "the read-only target changed");
            } finally { fs.chmodSync(ro, 0o666); fs.unlinkSync(ro); }
            await rejects(fsv.start(A, { path: path.join(scratch, "huge.png"), size: 2 ** 52 }), /needs .* and its drive has .* free/, "a size the drive cannot take");
            await rejects(fsv.start(A, { path: path.join(scratch, "x.png") }), /needs the file's size/, "no size");
            await rejects(fsv.start(A, { path: path.join(scratch, "x.png"), size: -1 }), /needs the file's size/, "a negative size");
            let asked = null;
            const dialog = saves({ choose: async (name, filters) => { asked = { name, filters }; return null; } });
            assert(await dialog.start(A, { name: "pick.webp", filters: [{ name: "WebP" }], size: 10 }) === null, "a cancelled dialog did not answer null");
            assert(asked && asked.name === "pick.webp" && asked.filters[0].name === "WebP", "the dialog was not asked with the name and filters: " + JSON.stringify(asked));
            assert(!fsv.busy && !dialog.busy, "a refused save stayed open");
            clean("after the refusals");
            const picked = saves({ choose: async () => path.join(scratch, "picked.png") });
            const p = await picked.start(A, { name: "picked.png", size: 3 });
            await picked.write(A, { id: p.id, offset: 0, data: new Uint8Array([1, 2, 3]) });
            const r = await picked.finish(A, { id: p.id });
            assert(r.path === path.join(scratch, "picked.png") && fs.readFileSync(r.path).length === 3, "the dialog's pick was not saved");
            fs.unlinkSync(r.path);
        });

        await check("6. a target held by another program (EBUSY on the rename): written in place, or refused when that fails too", async () => {
            const target = path.join(scratch, "held.png");
            const old = pattern(500, 5);
            fs.writeFileSync(target, old);
            const ebusy = () => { const e = new Error("busy"); e.code = "EBUSY"; return e; };
            let busy = 0, copies = 0;
            // the rename refused for good (a viewer holds the file open), the write in place goes through
            const viewer = saves({ ops: { rename: async () => { busy++; throw ebusy(); }, copyFile: async (a, b) => { copies++; return fs.promises.copyFile(a, b); } } });
            const ov = await viewer.start(A, { path: target, size: 100 });
            await viewer.write(A, { id: ov.id, offset: 0, data: new Uint8Array(pattern(100, 8)) });
            const rv = await viewer.finish(A, { id: ov.id });
            assert(busy >= 2 && copies === 1 && rv.bytes === 100 && fs.readFileSync(target).equals(pattern(100, 8)), `held, written in place: ${busy} renames, ${copies} copies`);
            clean("held, written in place");
            fs.writeFileSync(target, old);
            // the write in place refused too (the holder shares no write): refused, the target as it was
            const held = saves({ ops: { rename: async () => { throw ebusy(); }, copyFile: async () => { throw ebusy(); } } });
            const open = await held.start(A, { path: target, size: 100 });
            await held.write(A, { id: open.id, offset: 0, data: new Uint8Array(100) });
            await rejects(held.finish(A, { id: open.id }), /held\.png is in use by another program, or its folder does not allow replacing it/, "held for good");
            assert(fs.readFileSync(target).equals(old), "the target changed");
            clean("held for good");
            let n = 0;
            const briefly = saves({ ops: { rename: async (a, b) => { if (n++ < 2) { const e = new Error("busy"); e.code = "EBUSY"; throw e; } return fs.promises.rename(a, b); } } });
            const o2 = await briefly.start(A, { path: target, size: 100 });
            await briefly.write(A, { id: o2.id, offset: 0, data: new Uint8Array(pattern(100, 6)) });
            await briefly.finish(A, { id: o2.id });
            assert(fs.readFileSync(target).equals(pattern(100, 6)), "held briefly: not saved");
            clean("held briefly");
            fs.unlinkSync(target);
            return `the rename refused ${busy} times, then written in place`;
        });

        await check("7. two pieces sent without waiting land in order; an empty file", async () => {
            const fsv = saves();
            const target = path.join(scratch, "seven.tif");
            const data = pattern(3 * 65536 + 3, 7);
            const open = await fsv.start(A, { path: target, size: data.length });
            const parts = [0, 65536, 131072, 196608].map((at) => fsv.write(A, { id: open.id, offset: at, data: new Uint8Array(data.subarray(at, Math.min(data.length, at + 65536))) }));
            const fin = fsv.finish(A, { id: open.id });
            fin.catch(() => {});   // its failure is reported by the await below, not as an unhandled rejection
            const answers = await Promise.all(parts);
            await fin;
            assert(answers.map((a) => a.bytes).join() === "65536,131072,196608,196611", "the pieces answered " + JSON.stringify(answers));
            assert(fs.readFileSync(target).equals(data), "the bytes differ");
            const empty = path.join(scratch, "empty.png");
            const e = await fsv.start(A, { path: empty, size: 0 });
            const r = await fsv.finish(A, { id: e.id });
            assert(r.bytes === 0 && fs.statSync(empty).size === 0, "the empty file");
            clean("after both");
            fs.unlinkSync(target); fs.unlinkSync(empty);
        });

        await check("8. a killed save leaves its temporary file listed, and the next start's sweep deletes it", async () => {
            const target = path.join(scratch, "killed.psd");
            fs.writeFileSync(target, "old");
            const fsv = saves();
            const open = await fsv.start(A, { path: target, size: 100 });
            await fsv.write(A, { id: open.id, offset: 0, data: new Uint8Array(40) });
            // the app is killed here: the handle is never closed, nothing is unlinked
            const left = listed();
            assert(left.length === 1 && fs.existsSync(left[0]), "the temporary file is not listed: " + left);
            await fsv.saves.get(open.id).fh.close();   // what the end of the process does
            const gone = doc.sweepTemps(registry);
            assert(gone.length === 1 && gone[0] === left[0] && !fs.existsSync(left[0]), "the sweep did not delete it: " + gone);
            assert(fs.readFileSync(target, "utf8") === "old", "the target changed");
            clean("after the sweep");
            fs.unlinkSync(target);
        });

        await check("9. a page dropped while its save waits for the dialog gets no save", async () => {
            let pick;
            const fsv = saves({ choose: () => new Promise((r) => { pick = r; }) });
            const opening = fsv.start(A, { name: "late.png", size: 10 });
            await new Promise((r) => setTimeout(r, 20));
            assert(await fsv.abortAll(A) === 0, "abortAll found a save that was not open yet");
            pick(path.join(scratch, "late.png"));
            await rejects(opening, /the window reloaded during the save/, "the late open");
            assert(!fsv.busy, "the late save stayed open");
            const fresh = await fsv.start(A, { path: path.join(scratch, "late.png"), size: 0 });   // the page's next save opens
            await fsv.finish(A, { id: fresh.id });
            fs.unlinkSync(path.join(scratch, "late.png"));
            clean("after the late open");
        });

        await check("9b. a page dropped while its temporary file opens gets no save either", async () => {
            const fsv = saves();
            const fsp = require("node:fs/promises");
            const was = fsp.open;
            fsp.open = async (...a) => { const fh = await was(...a); await fsv.abortAll(A); return fh; };
            let opening;
            try { opening = fsv.start(A, { path: path.join(scratch, "late2.png"), size: 10 }); await opening.catch(() => {}); } finally { fsp.open = was; }
            await rejects(opening, /the window reloaded during the save/, "the open the reload overtook");
            assert(!fsv.busy && !fs.existsSync(path.join(scratch, "late2.png")), "the save stayed open or the target was made");
            clean("after the overtaken open");
        });

        await check("10. a hard link is written in place (every name gets the bytes); a symbolic link is saved through", async () => {
            const fsv = saves();
            const a = path.join(scratch, "hard_a.png"), b = path.join(scratch, "hard_b.png");
            fs.writeFileSync(a, "old");
            fs.linkSync(a, b);
            const o = await fsv.start(A, { path: b, size: 3 });
            await fsv.write(A, { id: o.id, offset: 0, data: new Uint8Array([7, 8, 9]) });
            await fsv.finish(A, { id: o.id });
            assert(fs.readFileSync(a).equals(Buffer.from([7, 8, 9])) && fs.statSync(b).nlink === 2, "the hard link's other name keeps the old bytes");
            clean("the hard link");
            let sym = "symbolic link: not made (no Developer Mode)";
            const real = path.join(scratch, "real.png"), link = path.join(scratch, "link.png");
            fs.writeFileSync(real, "old");
            try { fs.symlinkSync(real, link, "file"); } catch (_) { sym = null; }
            if (sym !== null || fs.existsSync(link)) {
                const s = await fsv.start(A, { path: link, size: 3 });
                assert(s.path === link, "the answer does not name the link: " + s.path);
                await fsv.write(A, { id: s.id, offset: 0, data: new Uint8Array([1, 2, 3]) });
                const r = await fsv.finish(A, { id: s.id });
                assert(r.path === link && fs.lstatSync(link).isSymbolicLink() && fs.readFileSync(real).equals(Buffer.from([1, 2, 3])), "the link was replaced or the file it points to kept the old bytes");
                clean("the symbolic link");
                sym = "symbolic link saved through";
                fs.unlinkSync(link);
            } else sym = "symbolic link: not made here (no Developer Mode), skipped";
            fs.unlinkSync(a); fs.unlinkSync(b); fs.unlinkSync(real);
            return sym;
        });

        await check("11. a target whose own name is 250 characters long saves (the temporary name is cut to 255)", async () => {
            const fsv = saves();
            const target = path.join(scratch, "n".repeat(246) + ".png");
            const o = await fsv.start(A, { path: target, size: 4 });
            assert(path.basename(listed()[0]).length <= 255 && doc.TEMP_RE.test(listed()[0]), "the temporary name: " + path.basename(listed()[0]).length);
            await fsv.write(A, { id: o.id, offset: 0, data: new Uint8Array(4) });
            await fsv.finish(A, { id: o.id });
            assert(fs.statSync(target).size === 4, "not saved");
            clean("the long name");
            fs.unlinkSync(target);
            await rejects(fsv.start(A, { path: path.join(scratch, "missing", "x.png"), size: 1 }), /folder .*missing does not exist/, "a missing folder still says so");
        });

        await check("12. a temporary file something still holds at the cancel stays listed for the next start's sweep", async () => {
            const fsv = saves();
            const target = path.join(scratch, "kept.tif");
            const o = await fsv.start(A, { path: target, size: 10 });
            const temp = listed()[0];
            const fsp = require("node:fs/promises");
            const was = fsp.unlink;
            fsp.unlink = async () => { const e = new Error("busy"); e.code = "EBUSY"; throw e; };
            try { await fsv.abort(A, { id: o.id }); } finally { fsp.unlink = was; }
            assert(listed().length === 1 && listed()[0] === temp && fs.existsSync(temp), "the held temporary file is not listed any more");
            assert(doc.sweepTemps(registry).length === 1 && !fs.existsSync(temp), "the sweep did not delete it");
            clean("after the sweep");
        });
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    for (const r of results) console.log(r);
    console.log(failed ? "FAIL" : "PASS");
    process.exit(failed ? 1 : 0);
})();
