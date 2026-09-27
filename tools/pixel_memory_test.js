// The renderer's limit on typed arrays (about 15.5 GB, docs/PERFORMANCE.md §14) as the tile store meets it
// (renderer/editor/inpaint_arena.js `allocTileBytes`, inpaint_tiles.js `writable`), in plain Node, no Electron:
//   node tools/pixel_memory_test.js
// Nothing here allocates 15.5 GB: the browser's refusal is stood in for by a Uint8ClampedArray that throws the
// RangeError Chromium throws ("Array buffer allocation failed"), for one call at a time. Covered: the refusal comes out
// as a PixelMemoryError with a message a user can act on (docs/BUGS.md: it was the bare RangeError), the tile's owner
// is left untouched and the arena counts it; any other error passes through as it was; and a write into a tile another
// pixels object shares (an undo step's copy) that runs out leaves the tile shared, so the next write copies it instead
// of writing into the other holder's pixels (the count used to be taken down before the copy was made).
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const EDITOR = path.join(__dirname, "..", "renderer", "editor");
const editorModule = (rel) => import(pathToFileURL(path.join(EDITOR, rel)).href);

let failures = 0;
function check(what, ok, detail) {
    if (!ok) failures++;
    console.log(`[${ok ? "ok" : "FAIL"}] ${what}${detail ? ": " + detail : ""}`);
}

/** Run `fn` while every new Uint8ClampedArray of `bytes` or more throws `make()`; smaller ones and views still work. */
function starved(fn, make = () => new RangeError("Array buffer allocation failed"), bytes = 256 * 256 * 4) {
    const Real = globalThis.Uint8ClampedArray;
    globalThis.Uint8ClampedArray = new Proxy(Real, {
        construct(target, args) {
            if (typeof args[0] === "number" && args[0] >= bytes) throw make();
            return Reflect.construct(target, args);
        },
    });
    try { return fn(); } finally { globalThis.Uint8ClampedArray = Real; }
}
function thrown(fn) { try { fn(); return null; } catch (err) { return err; } }

async function main() {
    const A = await editorModule("inpaint_arena.js");
    const T = await editorModule("inpaint_tiles.js");
    check("the arena is off in plain Node (every tile gets its own buffer, the path the limit ends on)", !A.arenaEnabled());

    // ---- allocTileBytes
    const owner = { arenaChunk: -1, arenaSlot: -1 };
    const before = A.arenaStats().failed;
    const err = thrown(() => starved(() => A.allocTileBytes(owner)));
    check("at the limit a tile's allocation throws a PixelMemoryError", err instanceof A.PixelMemoryError && err.name === "PixelMemoryError", err && `${err.name}: ${err.message}`);
    check("its message says what ran out and what frees it", err && /out of memory for pixels/.test(err.message) && /15\.5 GB/.test(err.message) && /Close a document/.test(err.message), err && err.message);
    check("the owner is untouched and the arena counts it", owner.arenaChunk === -1 && owner.arenaSlot === -1 && A.arenaStats().failed === before + 1, JSON.stringify(A.arenaStats()));
    const other = thrown(() => starved(() => A.allocTileBytes({}), () => new TypeError("something else")));
    check("any other error passes through as it was", other instanceof TypeError && other.message === "something else", other && `${other.name}: ${other.message}`);
    const ok = A.allocTileBytes({});
    check("with room again a tile gets its bytes", ok instanceof Uint8ClampedArray && ok.length === A.SLOT_BYTES);

    // ---- writable() on a shared tile
    const a = T.TileLayerPixels.empty(512, 512);
    a.writable(0, 0).data[0] = 7;
    const b = a.clone();                       // an undo step's copy: the tile is shared (frozen)
    const shared = a.tileAt(0, 0);
    const e2 = thrown(() => starved(() => a.writable(0, 0)));
    check("a write into a shared tile at the limit throws the PixelMemoryError", e2 && e2.name === "PixelMemoryError", e2 && `${e2.name}: ${e2.message}`);
    check("the tile stays shared: the same tile in both, still counted", a.tileAt(0, 0) === shared && b.tileAt(0, 0) === shared && shared.frozen === 1, `frozen ${shared.frozen}`);
    const t = a.writable(0, 0);
    t.data[0] = 9;
    check("the next write copies it and leaves the other holder's pixels alone", t !== shared && b.tileAt(0, 0).data[0] === 7 && a.tileAt(0, 0).data[0] === 9, `b ${b.tileAt(0, 0).data[0]}, a ${a.tileAt(0, 0).data[0]}`);
    const e3 = thrown(() => starved(() => a.writable(1, 1)));
    check("a new tile at the limit is not put into the store", e3 && e3.name === "PixelMemoryError" && a.tileAt(1, 1) === null);

    console.log(failures ? `\n${failures} FAILED` : "\nall ok");
    process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
