<!-- K1's design (docs/PLAN_WASM_BUILD.md K1), written 2026-10-23 by a read-only workflow of two designers, a critic
and a writer while K0c's chain ran; the K1 build session implements it and records what changed in the plan's §7. -->

# K1 design: per-job split, route map, flood size route, instance lifecycle, trap recovery

This is the merged design for K1, checked against `249d882` on `wasm-kernels`. It takes A's mechanism and B's measurement integrity, and fixes the critic's findings plus four defects that neither design caught (§0.3). Every line number is from `249d882`; grep the name before editing. Every effort figure is inferred.

**What K1 does not change:**
- No `.rs` edit, no new Rust export, no ABI bump (`PX_ABI` stays 20, `px.js:14`), and no `build_px.py` run.
- No host member, so `build_node.py --check` stays green.
- `partsUsable()` (`inpaint_encode.js:58-60`) stays as it is.
- Every route chooses between implementations that give the same bytes.

## 0. Facts the design rests on

### 0.1 What the code and the K0b logs show

- **The wand A/B compares two read routes, not two kernels.**
  - `floodStack` needs `partsUsable()` (`inpaint_canvas.js:8800`), and `partsUsable()` needs `kernelsMode() === "rust"` (`inpaint_encode.js:59`).
  - So `E.kernels = "js"` reads through `sampleRegion`, a bitmap and the worker's `flood()` (`inpaint_worker.js:739-790`).
  - `"rust"` reads through `stack_into` jobs, a `SharedArrayBuffer` and `floodOverTiles` (`inpaint_canvas.js:8971-8995`, `inpaint_worker.js:799-841`).
  - K0b's wand_object row: job 72.1 / 74.8 ms, wall 153.5 / 173.3, flood part 3.1 / 5.1 (`docs/measurements/k0b_2026-10-23/pxjobs_15k.log`). Only about 2 ms of the 20 ms gap is the flood.
- **K0b's mips rows are contaminated.** The JS `mips_direct` row counted `clamp_extend 35, mip_chain 1059` Rust calls (`pxjobs_15k.log:6`), which `mipsJs` cannot make in JS mode.
  - `mipsDirect` neither settles nor tags its jobs (`tools/px_jobs.py:213-237`).
  - The pool evaluates `defaults()` when it **sends** a job, not when it queues it (`inpaint_pool.js:149`). So a job queued before a flip also runs under the new mode.
- **A `mips` route on the worker job alone routes nothing.** `mipsJs` calls the `kernels.js` wrappers `mipChain` / `clampExtend` (`inpaint_worker.js:100`, `:106-107`), and those take plain `rustPx()` (`kernels.js:68-76`).
- **The JS flood users run is `floodMask`'s loop** (`inpaint_raster.js:190-228`). Its comment says it is faster than the `kernels_js.js` twin (`:181-183`). The bitmap route's JS branch and the window's fallback (`inpaint_canvas.js:~8251`) both run it.
- **Instance state between rows.** wand_band's 15k flood grows a pool worker's instance to about 0.8 GB, and `releaseIfLarge` (`inpaint_worker.js:835`, `kernels.js:51-53`) replaces it. The next flood on that worker starts on a fresh instance and grows memory again.
- **The window's synchronous `new WebAssembly.Instance` has already run in Electron 44.**
  - K0b's `grow_fallback_15k` ran `growMask` (dist_transform) and `growMaskBounds` (grow_mask) on the window at about 74 MP. Both are above 256 MB, and both wrappers call `releaseIfLarge` in a `finally` (`kernels.js:81`, `inpaint_raster.js:145`).
  - A throw there would have replaced the result. The log has results and Rust px calls on every step (`docs/measurements/k0b_2026-10-23/bench/grow_fallback_15k.log`).
  - That is strong but indirect evidence. K1 makes it direct (§5.4) and keeps an async branch anyway, for the node's Chrome.
- **Copies.** `mipsRust` copies with `p.u8().set` (`:126`) and `slice` (`:128`, `:134`), not through `_in`. `Px.floodShape` copies the box in through `_in` (`px.js:336`), from a `SharedArrayBuffer` on the stack route.
- **Retention.** `PxArena.reset` keeps one chunk at the job's peak (`px.js:546-557`). `releaseIfLarge` acts only above 256 MB (`kernels.js:22`).

### 0.2 Beliefs that a measurement decides (not facts)

- V8 compiles wasm with Liftoff and tiers up to TurboFan. There is no on-stack replacement for wasm, so a long first call stays on the baseline tier. K0b measured this in Node: the first call takes 1.8-2.2x the warm one.
- Tiered code lives in the module's compiled code, so a new Instance of the same Module keeps it.
- Whether separate `WebAssembly.compile` calls of identical bytes in different worker isolates share compiled code and its tier-up is **unknown**. V8 has a process-wide native module cache; `px_test.js` `freshWasm` (`:651`) defeats it inside one isolate. M5 decides this.

### 0.3 Defects in both designs, fixed here

1. **Contamination through queued jobs.** The pool's `defaults()` is evaluated at send time (`inpaint_pool.js:149`), so even a `gen` tag misfires on jobs queued before a row. K1 captures the job fields at queue time (§4.2).
2. **A successful result can be lost.** Every `Px` method ends in `finally { a.reset(); }`, and `PxArena.reset` can call `px_alloc` / `px_free` (`px.js:549-553`).
   - After a trap or under out-of-memory, that `finally` throws and replaces a result that was already written into the caller's arrays.
   - A twin fallback would then apply in-place kernels twice: `smudgeDab`'s dab, `clampExtend`, `matchPixels`, `growMask`.
   - Fix: `Px._reset(a)` swallows errors from an instance already marked trapped (§1.2).
3. **A wasm stack overflow is not a `RuntimeError`.** It throws `RangeError` and leaves Rust's shadow stack pointer wrong. Any `RuntimeError` or `RangeError` thrown by a raw export call marks the instance trapped. The instance has no imports (`{}`), so such an error can only come from wasm.
4. **`floodShape`'s `use` callback must run at most once.** A fallback after `use` ran (or a `RuntimeError` thrown by `use` itself) must rethrow, not run the twin.

## 1. Contract of names (builders code against this)

### 1.1 `renderer/editor/px/px.js`

```js
export class PxOutOfMemory extends Error          // thrown by Px.alloc instead of a plain Error; same message as px.js:110
export function pxTimed(on?)                      // thread switch for the clocks; returns the current value; default false
export function pxCalls(reset = false)            // shape unchanged ({ name: n }); a reset also clears ms and LAPS
export function pxLaps()                          // since the last pxCalls(true):
    // { ms: { export: ms },              only while timed
    //   first: { export: firstMs|null },  exports whose first call on this thread fell since the reset
    //   copyIn, copyInMB, copyInSharedMB, copyOut, copyOutMB, alloc, grewMB }
export function pxLapAdd(key, ms, bytes = 0, shared = false)   // "copyIn" | "copyOut", for direct users (mipsRust)
// on Px:
//   trapped   null, or the error that poisoned this instance
//   _reset(a) a.reset(), swallowing when this.trapped (§0.3.2)
```

### 1.2 `renderer/editor/px/kernels_js.js`

```js
export function floodScan(data, W, H, sx, sy, tolerance = 32, contiguous = true)
    // inpaint_raster.js:190-228 moved verbatim: the JS flood users run today
export function floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use)
    // Px.floodShape's contract (px.js:327-346, jobs.rs:102-168), on floodScan
```

### 1.3 `renderer/editor/px/kernels.js`

Routes:

```js
export const ROUTE_KINDS = { flood: "kernelSize", mips: "kernel", releaseMB: "mb", keepMB: "mb" };
// "kernel": "js" | "rust"
// "kernelSize": "js" | "rust" | a number >= 0 (pixels: Rust from that size on)
// "mb": a number >= 0 or Infinity
export function setRoute(name, value)   // value null removes the override; an unknown name or a bad value throws
export function route(name)             // the effective value; undefined for an absent kernel route (means Rust)
export function kernelRoutes()          // { ...DEFAULT_ROUTES, ...overrides }
export function routeOverrides()        // a copy of the overrides, which is what a message carries
export function adoptRoutes(o)          // worker side: replaces the overrides wholesale with the valid entries of o; never throws
export function rustPx(name = null, size = 0)   // today's gate, plus the route of `name` at `size`
```

Lifecycle:

```js
export function releaseIfLarge()        // drop above releaseMB, then arm the idle trim
export function pxJobStart()            // a worker job starts: holds the instance and cancels a pending trim
export function pxJobEnd()              // a worker job ends: arm the trim once nothing holds
export function dropPx(why = "idle")    // replace this thread's instance now (probe, tests)
export function pxSettled()             // resolves once no asynchronous instantiation is pending
export function pxInstances()           // { serial, bytes, pending, holds, release, idle, trap, oom, sync, async }
export function recovered(p, err)       // true when err is p's trap or out-of-memory: p is replaced and the caller runs the twin
export function pxSplit(since = null)   // { ...pxLaps(), bytes, inst }; with since: + bytes0, renewed { cause: n }
export function floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use)   // routed "flood" at w*h
```

Re-exports: `pxTimed`, `pxLaps`, `pxLapAdd`, `PxOutOfMemory` (px.js) and `floodScan` (kernels_js.js).

### 1.4 `renderer/editor/inpaint_jobs.js`

```js
export function measureGen(next = false)   // GEN++ when next; returns GEN
export function pendingJobs()              // workerJobs.size + mipsJobs.size + (POOL ? POOL.pending : 0)
export function resetPool()                // POOL.terminate(); POOL = null (harness only)
```

### 1.5 `InpaintEditor` statics (`inpaint_canvas.js`, beside `:17597-17598`)

`routes` (getter), `setRoute(name, v)`, `pxTimed(on)`, `pxSplit(since)`, `pxInstances()`, `measureGen(next)`, `pendingJobs()`, `resetPool()`.

Import the kernel functions as `kernelRoutes` and `setRoute as setKernelRoute`. A plain `routes` would be shadowed by relight's `const routes` at `:20310`.

### 1.6 Messages and timing

- **Every job message** carries `kernels`, `routes` (overrides only), `gen`, and `split: 1` when the window is timed.
- **Every reply with a `timing`** carries:
  - `timing.pxCalls` (as today);
  - `timing.gen`;
  - when split: `timing.pxSplit = { job, ...pxSplit(s0) }`;
  - from the pool: `timing.pool = { worker, queueMs, tripMs }`.
  - `pxSplit` and `pool` are nested so `px_jobs.py` `parts()` never sums them.
- **Worker ops added:** `px_probe` (diagnostic, like `inflate_bench`) and `px_stats` (answered before the job counters, like `arena`).

## 2. Steps

S1 and S2 run in parallel. S3-S5 and S7-S8 code against §1 and can run in parallel with them. S6 follows S1-S3. S9 is the main loop.

### S1: `renderer/editor/px/px.js`

**Counters.**
- `CALLS` entries (`:33`) become `{ n, ever, ms, firstMs }`. `ever` and `firstMs` are never reset.
- Add a module-level `LAPS = { copyIn, copyInMB, copyInSharedMB, copyOut, copyOutMB, alloc, grewMB }` and `let TIMED = false`. Both survive instance replacement, as the counters do (`:28-29`).

**`countedExports(raw, owner)`** (`:46-55`; the constructor at `:79` passes `this`) wraps **every** function export:
- An uncounted one (`px_*`, `*_bytes`, `*_cap`) becomes `(...a) => { try { return value(...a); } catch (e) { throw trapMark(owner, e); } }`.
- A kernel becomes:
  ```js
  (...a) => {
      c.n++; c.ever++;
      if (!TIMED) { try { return value(...a); } catch (e) { throw trapMark(owner, e); } }
      const t = clock();
      try { return value(...a); }
      catch (e) { throw trapMark(owner, e); }
      finally { const d = clock() - t; c.ms += d; if (c.ever === 1) c.firstMs = d; }
  }
  ```
- `trapMark(owner, e)` sets `owner.trapped = e` when `e` is a `WebAssembly.RuntimeError` or `RangeError` and nothing is set yet, then returns `e` (§0.3.3).

**Laps.**
- `alloc(bytes)` (`:107-112`), when timed, takes the ms around `px_alloc` and the `byteLength` delta (memory.grow happens inside it) into `LAPS.alloc` / `grewMB`. It throws `new PxOutOfMemory(bytes)` with the old message.
- `_in` / `put` time their `set` into copyIn: add MB, and shared MB when `typeof SharedArrayBuffer !== "undefined" && data.buffer instanceof SharedArrayBuffer`.
- `_out` / `get` time theirs into copyOut.
- `pxCalls(reset)` keeps its return shape. Its reset also zeroes every `c.ms` and `LAPS`, so there is one reset point.

**`_reset(a)`:**
```js
_reset(a) {
    try { a.reset(); }
    catch (err) {
        if (!this.trapped && !(err instanceof PxOutOfMemory)) throw err;
        if (!this.trapped) this.trapped = err;
    }
}
```
Every `finally { a.reset(); }` in the class becomes `finally { this._reset(a); }` (about 22 sites, `:165` … `:509`).

**Checklist for the builder:** in each `Px` method, no write to a caller's array happens before the method's last export call. This is read true for `:159-509`. `pngUnfilterRows` (`:198-202`), `growMask` (`:320`) and `smudgeDab` copy out after their call. A trap therefore never leaves a caller's input half written.

**Tests** (in S6): counters, laps and trap marking.

### S2: `renderer/editor/px/kernels_js.js`

- **`floodScan`:** `inpaint_raster.js:190-228` moved verbatim (the closure `similar`, unclamped `tol`), next to `flood` (`:265`).
- **`floodShape`:** `const mask = floodScan(rgba, w, h, sx | 0, sy | 0, Math.max(0, tolerance | 0), contiguous)`, then a fresh `Uint8ClampedArray(w * h * 4)`.
  - Never write into the caller's buffer: `ImageData` refuses a view over the job's `SharedArrayBuffer`.
  - Per row, a pixel counts when `mask[p] && !(sel && sel[p * 4 + 3] < 128)`. It becomes `[r, g, b, 255]` from `rgb` (0xRRGGBB); everything else stays 0.
  - Count, then bounds `[x0, y0, x1, y1]` with right and bottom exclusive, or `null` when the count is 0 (`jobs.rs:135-166`).
  - `return use(out, count, bounds)`.

**Tests** (in S6): a `twinCheck` against `Px.floodShape`; `floodScan` equals `J.flood` on the same cases.

### S3: `renderer/editor/px/kernels.js`

**Routes.**
- `DEFAULT_ROUTES = { releaseMB: 256, keepMB: 256 }`. These are today's behaviour: `keepMB` equal to `releaseMB` makes the idle trim almost a no-op until S9 sets the measured value.
- `flood` and `mips` are absent, which means Rust as today. S9 may add `flood: N` or `mips: "js"` with a comment citing the row (§1.1 rule 4 of the plan).
- `setRoute` validates the name against `ROUTE_KINDS` and the value against its kind, and throws `Error("px: unknown route " + name)` or `Error(\`px: route ${name} takes …\`)`.
- `rustPx`:
  ```js
  export function rustPx(name = null, size = 0) {
      if (MODE !== "rust") return null;                                   // the global mode stays the override
      if (PX && PX.trapped) renew(PX.trapped instanceof PxOutOfMemory ? "oom" : "trap", PX);
      if (!PX) return null;
      if (name !== null) { const r = route(name); if (r === "js" || (typeof r === "number" && !(size >= r))) return null; }
      return PX;
  }
  ```

**Renewal** (replaces `:51-53`):
- `renew(why, from)` returns at once unless `from === PX`, then counts `RENEWS[why]++`.
- It tries `new Px(new WebAssembly.Instance(module, {}), module)` (counted `sync`). On any throw it sets `PX = null`, counts `async`, and sets `PENDING = WebAssembly.instantiate(module, {}).then(i => { if (!PX) PX = new Px(i, module); }, warn).finally(() => PENDING = null)`.
- `SERIAL++` on every new `Px`, including the first load in `kernelsReady` (`:31`).

**Release and trim:**
```js
export function releaseIfLarge() { drop(mb("releaseMB"), "release"); if (!HOLDS) armTrim(); }
function armTrim() {                       // only when there is something above keepMB to drop
    if (!PX || PX.byteLength <= mb("keepMB")) return;
    if (TRIM !== null) clearTimeout(TRIM);
    TRIM = setTimeout(() => { TRIM = null; if (!HOLDS) drop(mb("keepMB"), "idle"); }, IDLE_MS);   // IDLE_MS = 2000
    if (TRIM && TRIM.unref) TRIM.unref();  // Node (px_test) must not wait for it
}
export function pxJobStart() { HOLDS++; if (TRIM !== null) { clearTimeout(TRIM); TRIM = null; } }
export function pxJobEnd() { HOLDS = Math.max(0, HOLDS - 1); if (!HOLDS) armTrim(); }
```
- An operation of many jobs (an export's parts, later TIFF bands) keeps resetting the countdown.
- A trim can never fire inside a worker job, async ones included (`tiffPartJob` `:455-464`, `png_read`, the editor worker's `png` / export jobs). This answers critic A4 and B8.
- The window holds nothing: its trim fires `IDLE_MS` after the last releasing wrapper call.

**`recovered(p, err)`:** `if (!p || !(p.trapped || err instanceof PxOutOfMemory)) return false;` then `renew(p.trapped && !(p.trapped instanceof PxOutOfMemory) ? "trap" : "oom", p)`, warn once per thread and export, and return true.

**The 17 wrappers** (`:56-160`; A said 15) take one inline pattern with no closures, so the per-tile wrappers stay cheap:
```js
const p = rustPx();                         // rustPx("mips") in mipHalf, mipChain, clampExtend
if (p) {
    try { return p.dilateMask(data, w, h, r); }
    catch (err) { if (!recovered(p, err)) throw err; }
    finally { releaseIfLarge(); }           // only where :81 … :159 call it today
}
return J.dilateMask(data, w, h, r);         // the current twin call verbatim
```
`shadowMarch` keeps its kind route (`:154-156`) in front.

**`floodShape` wrapper:**
```js
export function floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use) {
    const p = rustPx("flood", w * h);
    if (p) {
        let used = false;
        const once = (v, n, b) => { used = true; return use(v, n, b); };
        try { return p.floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, once); }
        catch (err) { if (used || !recovered(p, err)) throw err; }
        finally { releaseIfLarge(); }
    }
    return J.floodShape(rgba, w, h, sx, sy, tolerance, contiguous, sel, rgb, use);
}
```

**`pxSplit(since)`:** `{ ...pxLaps(), bytes: PX ? PX.byteLength : 0, inst: SERIAL }`. With `since` it adds `bytes0: since.bytes` and `renewed`, the per-cause difference of `RENEWS` against `since.renews` (keep a `renews` copy in the snapshot).

### S4: worker side

Files: `inpaint_worker.js`, `stitch_worker.js`, `inpaint_raster.js`.

**`inpaint_worker.js`, imports** (`:56`): add `floodShape, recovered, pxSplit, pxJobStart, pxJobEnd, adoptRoutes, pxTimed, pxInstances, dropPx, pxLapAdd, PxOutOfMemory`, and `Px` from `./px/px.js`.

**`run()`** (`:1306-1308`): after `setKernels`, call `adoptRoutes(msg.routes); pxTimed(!!msg.split);`, and dispatch `px_probe` → `pxProbe(msg)`.

**`onmessage`** (`:1371-1389`):
- Answer `px_stats` like `arena`, before the counters: `self.postMessage({ id: msg.id, ok: true, op: "px_stats", ...pxInstances() })`.
- At the idle start: `pxCalls(true)` (already there).
- Per job: `pxJobStart()`, and when `msg.split`, `s0 = pxSplit(), tj = now()`.
- On a reply with `timing`: set `timing.gen = msg.gen`, and when split `timing.pxSplit = { job: now() - tj, ...pxSplit(s0) }`.
- Error replies add `trap: err.name` when `err` is a `WebAssembly.RuntimeError` or `PxOutOfMemory`.
- `finally`: `pxJobEnd()`.
- With overlapping jobs in the single editor worker, the laps count both jobs, as `pxCalls` already does (`:1366-1369`).

**`mips()`** (`:87-93`):
- `let p = rustPx("mips")`; `try { out = mipsRust(p, msg) } catch (err) { if (!recovered(p, err)) throw err; p = null; }`; then `mipsJs` when there is no output. The label follows `p`.
- With the route, the wrappers inside `mipsJs` also take the twins (critic B1).
- `mipsRust` times its own `set` (`:126`, `shared` from `tileBytes(t).shared`) and its `slice`s (`:128`, `:134`) through `pxLapAdd` only when `pxTimed()` (critic B5).

**`flood()`, the bitmap route** (`:748-766`):
- `const p = rustPx("flood", W * H)` chooses the branch.
- Inside it, `floodShape(...)` (the wrapper) replaces `p.floodShape`. Drop `:761`'s `releaseIfLarge()`; the wrapper does it.
- The label is `p ? "rust" : "js"` instead of `kernelsInUse()` (`:745`).
- The JS branch (`:767-789`) stays verbatim (critic B4).

**`floodOverTiles`** (`:799-841`):
- Keep `if (!rustPx()) throw new Error(NO_PARTS)` (`:801`). This is the global gate, so a thread without wasm behaves as today.
- `floodShape(...)` the wrapper replaces `p.floodShape` (`:812`); drop `:835`.
- `kernels: rustPx("flood", W * H) ? "rust" : "js"` replaces the hard-coded `"rust"` (`:805`).

**`pxProbe(msg)`**, a diagnostic op:
- Arguments: `{ kernel: "flood_shape"|"mip_chain", size, calls, source: "thread"|"posted"|"bytes", module?, bytes?, pregrow?, renew? }`.
- `source`:
  - `"thread"`: `dropPx("idle")` first when `renew` is set, then `rustPx()`;
  - `"posted"`: `new Px(await WebAssembly.instantiate(msg.module, {}), msg.module)`, timing `instantiate`;
  - `"bytes"`: compile and instantiate `msg.bytes`, timing both.
- Inputs are built outside the timing: a flat `size²` picture (the region is all of it) for `flood_shape`, or a random 256² tile for `mip_chain`.
- `pregrow`: `alloc`, fill and `free` the bytes the call needs, so call 0 differs from call 1 only by code tier.
- Returns `{ ms: [per call], compile, instantiate, bytes, timing: { op: "px_probe", kernel, size, source } }`.

**`stitch_worker.js`** (`:19-34`): `adoptRoutes(msg.routes)` after `setKernels` (`:23`), `pxJobStart()` at entry and `pxJobEnd()` in `finally`. The stitch split stays K32's.

**`inpaint_raster.js`:**
- Import `floodScan, recovered` (`:6`).
- `floodMask` (`:185-229`):
  ```js
  const p = rustPx("flood", W * H);
  if (p) {
      try { return p.flood(...); }
      catch (err) { if (!recovered(p, err)) throw err; }
      finally { releaseIfLarge(); }
  }
  return floodScan(data, W, H, sx, sy, tolerance, contiguous);
  ```
- `growMaskBounds` (`:141-146`) takes the same `recovered` pattern, falling through to the JS `growMask` path below it. `Px.growMask` writes `d` only after its call (`px.js:319-320`).

**Tests:** S6, then the gates in S9.

### S5: window side

Files: `inpaint_jobs.js`, `inpaint_pool.js`, `stitch.js`, `inpaint_canvas.js`.

**`inpaint_jobs.js`:**
- Import `routeOverrides, pxTimed` (`:8`). Add `GEN`, `measureGen`, `pendingJobs`, `resetPool`, and
  `jobFields = () => ({ kernels: kernelsMode(), routes: routeOverrides(), gen: GEN, ...(pxTimed() ? { split: 1 } : null) })`.
- Use it at `:95` (`{ id, op, ...jobFields(), ...args }`), `:145` (`defaults: jobFields`) and `:167`.
- Add the three new functions to the export list (`:235`).

**`inpaint_pool.js`:**
- `run()` (`:55-63`) stores `job.fields = this.defaults ? this.defaults() : null` and `job.queuedAt = performance.now()`. This is the fix for §0.3.1: a job carries the mode and routes in force when it was queued.
- `_start` sets `s.n = this.stats_.started` after `:136`.
- `_send` sets `job.sentAt` and posts `{ id: job.id, op: job.op, ...job.fields, ...job.args }` (`:149`).
- `_reply` (`:158-177`), before `onTiming`: `if (msg.timing && typeof msg.timing === "object") msg.timing.pool = { worker: s.n, queueMs: job.sentAt - job.queuedAt, tripMs: performance.now() - job.sentAt }`. The name is `queueMs` because `wait` already exists in readTiff's `spent` and png_read's split (critic B6).

**`stitch.js`:** import `routeOverrides` (`:18`), and `:846` posts `routes: routeOverrides()` beside `kernels`.

**`inpaint_canvas.js`:** the eight statics of §1.5 next to `:17597-17598` and `:17659`, plus the imports at `:20` / `:52` / `:33`.

**Tests:** S9's gates.

### S6: `tools/px_test.js`

New `routeCases`, `trapCases` and `lifecycleCases` after `counterCases` (`:742-780`) and before `jobCases`. Each ends with `K.setKernels("js")` and every override removed, as `:779` leaves the module.

**Counters:**
- `ever` and `firstMs` survive `pxCalls(true)` and a new instance.
- `ms` is filled only with `pxTimed(true)`.
- `first` lists an export on its first call and not after the next reset.
- A 64² `dilateMask` books `copyInMB` and `copyOutMB` of 16 KB each.
- `pxCalls(true)` zeroes `LAPS`.
- The wrapper-cost line under `PX_BENCH`, timed off and on, is printed beside K0b's 6-16 ns.

**Routes:**
- Unknown name throws; bad value throws; `null` removes.
- `rustPx("flood", n)` is null below a numeric route, Rust at it and above it, null for `"js"`, and Rust when absent.
- `setKernels("js")` beats a `"rust"` route.
- `adoptRoutes` replaces the overrides wholesale and ignores unknown names.
- `kernelRoutes()` merges the defaults.

**Twins:**
- `twinCheck({ name: "flood_shape", builds: [simd, scalar], twin: J.floodShape, call })`. `call` returns `{ bytes: new Uint8Array(view), n, bounds }`.
- Cases: jobCases' sizes and seeds (`:801-805`); `sel` null, partial alpha, and all transparent (the empty region); tol 0, 32 and 255; contiguous on and off; seeds at (0, 0) and (w-1, h-1); odd byteOffset on `rgba` and `sel`.
- `J.floodScan` equals `J.flood` on the same cases.
- `K.floodShape` gives the same bytes under `flood` = js and = rust, and calls `use` once.

**Traps:**
1. With `K.setKernels("rust")`, `K.rustPx().exports.mip_half(-16, 256, 256, 0)` throws a `RuntimeError` and sets `trapped`. The next `K.rustPx()` is a new instance, and `pxInstances()` shows `trap` +1 and `sync` +1.
2. A real wrapper: patch the instance's own `dilateMask` (the way `relightBench` patches `shadowMarch`, `:694-695`) to set `this.trapped` and throw a `RuntimeError`. `K.dilateMask` then equals `J.dilateMask` byte for byte, the instance is replaced, and the next call runs Rust (`pxCalls().dilate_mask` +1).
3. A plain `Error` from the method is rethrown and the instance is kept.
4. A patched method throwing `PxOutOfMemory` runs the twin, counted `oom`.
5. `_reset`: with `p.trapped` set by hand and `p.job.reset` patched to throw, `p.dilateMask` returns its result.
6. Async: `WebAssembly.Instance` replaced by a throwing stub, restored in `finally`. `alloc(300 MB)` plus `K.dilateMask` gives the twin's bytes and `rustPx()` null. After `await K.pxSettled()` there is a new instance, `async === 1`, and the next call is Rust.
7. `K.floodShape` whose `use` throws a `RuntimeError` rethrows and calls `use` once.

**Trim** (about 4.5 s of waits, `IDLE_MS` 2000):
- `setRoute("keepMB", 1)`, then `alloc(8 MB)` and a releasing wrapper call (critic nit: the trim must be armed). After 2.1 s, `idle` +1 and the instance is small.
- Arm, then `pxJobStart()`, wait 2.1 s: no renewal. Then `pxJobEnd()`, wait 2.1 s: renewal.

### S7: `tools/px_jobs.py` and `tools/run_gates.sh`

**Arguments:**
- `--ab NAME=A:B` (one per run): `A` goes in the "js" column and `B` in the "rust" column, so `report()` keeps its keys.
  - `NAME` is `kernels` (the legacy flip, and the default with no `--ab`), `stacks` (`off`/`on` → `E.stacks = false` / `undefined`, the existing window switch read at `inpaint_canvas.js:8800`), or a route name.
  - Values are `js`, `rust`, a number, or `inf`.
- `--set NAME=V`: repeatable, both arms, for the whole run.
- `--split`: `E.pxTimed(true)`; implied by `--check`.
- `--fresh-pool`: `E.resetPool()` after the settle, before each row.

**`useArm(k)`** replaces the six `E.kernels = kernels` lines (`:214`, `:241`, `:269`, `:298`, `:335`, `:361`):
- legacy: `E.kernels = k`;
- otherwise: `E.kernels = "rust"`, then `E.setRoute(NAME, val)` or `E.stacks`.

**`settle()`** before every row's clock, in `op()` (`:297`), `mipsDirect` (`:213`), `mipsWhole`, `bandJob`, `fillLimitRow` and the ladder:
1. `await ed.mipsSettled()`;
2. poll every 20 ms until `E.pendingJobs() === 0 && T.chainStats().pending === 0` (cap 10 s, then `settleTimeout: true` on the row);
3. `sleep(50)`;
4. `gen = E.measureGen(true)`.

Every timing list is filtered by `t.gen === gen` (critic A1). `parts()` (`:158`) skips the key `gen`.

**Split per row:**
- Window: `w0 = E.pxSplit()` right after the resetting `pxCalls()`, and `E.pxSplit(w0)` **before** the closing `pxCalls()` (`:307`).
- Jobs: sum each timing's `pxSplit` (`ms` by export, the laps, `job`, `grewMB`, `renewed` by cause, the union of `first` with the largest `firstMs`, `bytes0` min/max) and `pool` (`queueMs`, `tripMs`, distinct workers).
- `report()` prints one more line per row:
  `split js/rust: job a/b  copyIn a/b (MB, shared MB)  copyOut a/b  alloc a/b  grew MB a/b  bytes0 MB a/b  renewed …  kernel {export: ms}  first {export: ms}  queue a/b  trip a/b  workers a/b  outside jobs (wall − Σjob, mips_direct only) a/b`.
- Round 0's `first` is printed apart.

**Route-ran assertions** (critic A5): each violation prints `ROUTE NOT TAKEN` and counts as bad.
- `flood=js`: no `flood_shape` or `flood` in the jobs or on the window.
- `flood=rust`: jobs' `flood_shape` equals the row's flood jobs.
- `mips=js`: no `mip_chain`, `clamp_extend` or `mip_half` anywhere.
- `mips=rust`: jobs' `mip_chain` is at least the row's tiles.

**Other checks and rows:**
- **Traps:** in every mode, the sum of `renewed.trap + renewed.oom` over the rows must be 0.
- **Focus:** a timing run (not `--check`) with `focused` false or `visibility !== "visible"` prints `NOT COUNTED` and exits 2.
- **`window_release`** runs in check mode on the first size, before the rows:
  1. `K.rustPx().alloc(300 MB)`;
  2. `K.dilateMask` on 64²;
  3. `sync` when `rustPx()` is already a new instance; otherwise `await K.pxSettled()` and `async`;
  4. assert bytes equal `J.dilateMask` and the new instance is below 256 MB;
  5. print `window release: sync|async|none` (`none` fails).
- **`flood_ladder_<s>`**, s ∈ {256, 512, 1024, 2048, 4096, 8192}, as many as fit:
  - A top paint layer with one black square per size, each in a 2 px white frame so the region stops at the square whatever lies below, the squares apart. It is added before each ladder step and removed after, both outside the clock; then `settle()`.
  - `wandSelect` at each square's centre.
  - The row's key is the largest flood job's `pixels`, the box's pixel count.
  - 15k's whole-picture step is the existing `wand_band`.
- **End of the JS body**, in a `finally`: `E.kernels = "rust"`, `E.stacks = undefined`, `setRoute(n, null)` for the `--ab` and `--set` names, `E.pxTimed(false)`. This replaces `:435`.

**`run_gates.sh`:**
- `:113` becomes:
  ```
  pxjobs) { timeout 1200 python tools/px_jobs.py --check \
    && timeout 600 python tools/px_jobs.py --check --ab flood=js:rust --only wand_band,wand_object,wand_add,flood_ladder 2048x1152 \
    && timeout 600 python tools/px_jobs.py --check --ab mips=js:rust --only mips_direct,mips_whole 2048x1152; } > "$OUT/pxjobs.log" 2>&1; rc=$? ;;
  ```
  Each run has its own `timeout`, which fixes the critic's nit.
- New forms:
  - `pxjobs:*) timeout 3000 python tools/px_jobs.py $(echo "${g#pxjobs:}" | tr ',' ' ')`;
  - `pxprobe:*) timeout 1800 python tools/px_probe.py $(…)`.
- A `--js-flags FLAGS` option at `:45-55`, appended to both launch lines (`:82`, `:85`) as `--js-flags=$FLAGS`. It is used only in M6.

### S8: new harnesses `tools/px_probe.py` and `tools/ab_median.py`

**`px_probe.py --cold`** (M5): a fresh instance with no document.
1. On the window, `K.rustPx().floodShape` at 2048² five times. `W0` is the window's cold call; the median of calls 2-4 is warm.
2. Three new workers in a rotated order (instance 1 ABC, 2 BCA, 3 CAB), each `new Worker(new URL("./editor/inpaint_worker.js", location.href), { type: "module" })`:
   - A: `source: "thread"`, its own compile of the same URL;
   - B: `source: "posted"`, the window's `rustPx().module`;
   - C: `source: "bytes"`, px.wasm with a fresh custom section, as `freshWasm` builds it (`px_test.js:651-655`), as the cold reference.
3. Each worker runs `flood_shape` 2048² × 3 with `pregrow`, then `mip_chain` × 200, and is terminated.
4. Output: call 0 against the median of the rest, for each worker and for the window.

**`px_probe.py --regrow`** (M7a): in a new worker, `flood_shape` at sizes needing about 16, 32, 64 and 128 MB. Five times, alternating: `renew: true` (a fresh instance, warm code) against `renew: false` (a grown instance), one call each. The penalty per size is the difference.

**`px_probe.py --retention WxH [--keep-mb N]`** (M7b):
1. Build px_jobs' 15k document.
2. Run the PNG export the way `native_test.py`'s `export_png` row does (its stubbed `saveExport`).
3. Wait 3 s.
4. Post `px_stats` directly to every pool worker (`E.parts.pool().workers`) and to `editorWorker()`, listening with `addEventListener`. The pool's `_reply` ignores a foreign id (`inpaint_pool.js:160`).
5. Add the window's `E.pxInstances()` and print the bytes per thread and their sum.

**`ab_median.py RUN.jsonl…`** reads `PX_JOBS_JSON` lines (`px_jobs.py:590-592`). Per row and arm it prints the per-run medians, the median of the runs, and the spread (max − min of the per-run medians, the larger arm's). The verdict follows plan §1.1:
- Rust when its median is lower by more than the spread;
- the twin when the twin's is;
- otherwise Rust only if its kernel row (the route's exports' `ms` plus `copyIn`) is strictly faster than the twin's kernel parts.

All rounds decide. Round 0 is printed apart as the cold figure.

### S9: main loop

1. Review the diff.
2. Run the gates on tiles: `pxjobs`, `pixels`, `selection`, `export`, `node tools/px_test.js`, `lint`, `types`, `python tools/build_node.py --check`.
3. Commit the build (stop point K1a, §6 question 1).
4. Run the measurements of §3.
5. Set the defaults from them: `DEFAULT_ROUTES.flood`, possibly `mips`, `keepMB`, each with a comment citing its row.
6. Run `pxjobs` and `selection` on tiles again, then the verification runs (§3 M9).
7. Write the docs: plan §7 "K1", PERFORMANCE §16, the CLAUDE.md hand-over, TESTING.md (the pxjobs gate's three runs, `pxprobe:`). Add a CHANGELOG `## Unreleased` line only if `keepMB` drops below 256 or a route default lands.
8. Commit, push the branch.

## 3. Measurement protocol

**Conditions:**
- After K0c's chain has finished. No other instance runs.
- Every run on a fresh instance, `--offline --tiles on`, window in front, no DevTools frontend and no profiler.
- `native_test.py` rows with `--no-profile` (the profiler is on by default, `native_test.py:85`; critic A8).
- A chain script `docs/measurements/k1_<date>/k1_chain.sh` runs each set three times as `run_gates.sh k1-<m>-r{1,2,3} --offline --tiles on pxjobs:15000x10000,…`, with `PX_JOBS_JSON` per run.

| Run | What | Answers |
|---|---|---|
| M0 | `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe -p "JSON.stringify(process.versions)"` → `versions.txt`; `… --v8-options` → `v8_options.txt`, grepped for `wasm.*(tier|liftoff|lazy|cache)`; each candidate flag `<flag> -e 0` against a control `--no-such-flag-k1` → `v8_flag_accept.txt` | which flags exist in this V8 (facts for Stop 1, no code) |
| M1 | no `--ab`, `--only mips_direct,mips_whole,band,wand_band,wand_object`: 3 runs without `--split`, 3 with | K0b-comparable numbers, now clean of contamination; the split's cost (it must stay inside the spread, or decision runs go without `--split`); the split itself |
| M2 | `--ab,mips=js:rust,--only,mips_direct,mips_whole,--split` | whether the Rust mips lose as a whole operation, and where (copyIn shared ms/MB, queue, trip, outside-jobs time; the window's px calls per arm, since the route also flips the window's chains at `inpaint_tiles.js:133`, `:151`, `:671`, `:2099`) |
| M3 | `--ab,flood=js:rust,--only,wand_object,wand_band,wand_add,--split` | the wand kernel on one read route; with M1, how much of the loss is the read route |
| M4 | `--ab,flood=js:rust,--only,flood_ladder,--split` | the flood threshold |
| M5 | `pxprobe:--cold` (three rotations) | per-isolate cold code: the decision table below |
| M6 | only if M5 shows no sharing **and** M1/M3's `first` shows a cold call above the spread on a felt operation: `--fresh-pool,--only,mips_direct,wand_object,--split`, without flags and with each flag M0 accepted (`run_gates.sh --js-flags`) | Stop 1 material only |
| M7 | `pxprobe:--regrow`; `pxprobe:--retention,15000x10000` with `--set keepMB=256` against each candidate | `keepMB` |
| M8 | `window_release` from the gate's `pxjobs.log` | sync or async in Electron 44 (unblocks K27, K39) |
| M9 | after the defaults: M3 and M4 without `--ab` (the default), 3 runs; `native_test.py 15000x10000 --no-profile` wand rows before and after (only if a flood default landed); `mem:15000x10000` once | the default reaches the better arm at every step; no regression |

**M5 decision table:**

| Result | Meaning | For Stop 1 |
|---|---|---|
| A0 ≈ B0 ≈ warm | V8 shares code across isolates | posting a module saves only compile; no warm-up needed |
| A0 ≈ C0 (cold), B0 ≈ warm | sharing only when the Module is posted | candidate: post the window's Module to every worker |
| B0 ≈ C0 | not shared even when posted | candidates: a warm-up per worker, or flags (M6) |

**Thresholds:**
- **`flood`:** the smallest ladder step from which Rust's median is at or below the twin's at every larger step, by §1.1's tie rule. Take the conservative (larger) end, because synthetic squares only stand in for real pictures. Rust winning everywhere means no entry.
- **`mips`:** `"js"` only if M2's verdict is the twin, with M2's split as the comment's cause.
- **`keepMB`:** the smallest of 16 / 32 / 64 / 128 whose re-grow penalty (M7a) for a job above it is beyond the wand_object row's spread, capped by question 2's budget. Otherwise the smallest value inside the budget.

**`summary.txt`** carries the medians, spreads, verdicts, chosen defaults, sync or async, and the M5 verdict.

## 4. What K1 does not build

| Not built | Why |
|---|---|
| Splitting `partsUsable` into read and write | B's split moves twin-only users from canvas composites to `stack_into`'s kernel composite, which is not shown to give the same bytes; its classification of `:17805` / `:22515` is also wrong, since both reach `png_part` and would latch `PARTS_OFF` (`inpaint_encode.js:69-72`; critic B2, B3). The flood route gives an honest A/B with the global mode kept on "rust". |
| Posting the Module, a warm-up op, pre-sized instances, shipped js-flags | Stop 1 candidates gated by M5 / M6. If flags ever ship, the line goes at top level next to `main.js:157`, so the `--mcp` path that awaits `whenReady` at `:1422` gets them too (critic nit). Never `--expose-gc`. |
| A `composite` route; migrating the window-only switches (`pngParts`, `stacks`, `bands`, `mipsOnPool`) | Nothing in K1 measures them; each later session adds its own `ROUTE_KINDS` entry with `rustPx("<name>", size)`. |
| Cross-thread epoch stamps, `gcMs`, `px_warm`, `px_module` | Explanation only; `tripMs − job` covers transport and scheduling (critic B9). |
| Re-running a failed worker job on the twins; fuzz cases | Streaming jobs would deliver bands twice; fuzzing belongs to the decoders from K2 on. |
| The stitch worker's split | K32's. |

## 5. Risks

- **Twin memory at 15k.** `J.floodShape` under a forced `"js"` arm allocates about 750 MB of JS heap in a worker (mask plus shape), as the old canvas route did. A numeric default runs it only below the threshold.
- **The window's async gap.** While `PX` is null on the window, the twins run (slower, same bytes). A gate step asserting Rust right after a window call above 256 MB could flake; add it to TESTING.md's flakes if it is seen.
- **The window has no holds.** A window async operation holding `p` across awaits keeps the old instance alive after a trim. Bytes are unaffected (no pointer crosses instances); memory is doubled briefly.
- **Liquify and the window trim.** With a liquify window of about 69 MB and `keepMB` below that, a pause of 2 s re-grows the window's instance at the next dab. M7 should include this size.
- **Routes ride every message.** The harness must clear them; px_jobs does so in a `finally`.
- **Queue-time job fields** change behaviour only when the mode or routes flip between queueing and sending, which only harnesses do.
- **The node ships the new ops** `px_probe` and `px_stats`, as it ships `inflate_bench`. K40's token scan covers them; no new token like `.listen(`.
- **Coarse clocks.** `performance.now()` is coarsened (5 µs here, 100 µs in an uncrossisolated page). Per-export `ms` are trustworthy above about 1 ms per row.
- **The global "js" mode** still flips read routes. It stays only as the legacy comparison (M1 against K0b).

## 6. Open questions (each with a suggested answer)

1. **One session or two?** Suggested: one session. If the 5-hour window passes about 70 % after S9 step 3, stop at the committed build (K1a). Measurements and defaults then become K1b, and the hand-over says so.
2. **The wasm memory budget for `keepMB`** (8 pool workers and the window, kept after idle). Suggested: at most 64 MB per thread, about 0.6 GB in all, with the measured value chosen inside it.
3. **Flood inside the spread but with a slower kernel row.** Suggested: follow the tie rule (the twin), keyed on box pixels, at the conservative end.
4. **The Rust mips losing as a whole operation.** If M2 says so, route `mips` to `"js"` now. Suggested: yes, by the rule, with the split's cause in the comment; Stop 1 may undo it if the cause is fixable (for example the shared-memory copy).
5. **Cold calls per worker.** Posted module, warm-up or flags. Suggested: decide at Stop 1 from M5 / M6. Flags only on a win beyond the spread, verified against M0's listing, at top level near `main.js:157`.
6. **A trap in a direct-user job** (mips through tiles, PNG / TIFF parts) fails that job, and the window's fallback runs. Suggested: accept; the instance is replaced for the next job.
7. **The idle delay.** Suggested: 2 s.
8. **Two diagnostic worker ops shipping in the node.** Suggested: yes, like `inflate_bench`.

## 7. Findings and how they are resolved

| Finding | Resolution |
|---|---|
| A1 contaminated timings | `gen` tag, plus queue-time job fields (§0.3.1), plus `settle()`; M5 probes new workers for the cold call |
| A2 / B4 the twin is not the users' JS | `J.floodShape` is built on `floodScan`, the moved `floodMask` loop; the bitmap JS branch stays verbatim; the window fallback is routed through `floodMask` |
| A3 a 16 MB trim brings back re-growth | `keepMB` defaults to 256 and is set from M7's penalty and budget |
| A4 / B8 trim inside jobs, or after every pool job | `pxJobStart` / `pxJobEnd` holds and an idle timer per operation; the stitch worker too |
| A5 a no-op A/B passes | names validated against `ROUTE_KINDS`; route-ran assertions per row |
| A6 fallback only for `RuntimeError` | `trapped` set at the export for `RuntimeError` / `RangeError`; `PxOutOfMemory`; `_reset` keeps a written result (§0.3.2) |
| A7 the async guess | K0b's grow_fallback log cited (§0.1); `window_release` makes it direct; the async branch kept |
| A8 profiled rows | `--no-profile` in M9 |
| B1 the mips route compares Rust with Rust | the wrappers take `rustPx("mips")` |
| B2 / B3 the `partsUsable` split | not built (§4) |
| B5 `mipsRust` does not go through `_in` | `pxLapAdd` where it copies |
| B6 `wait` clashes with existing keys | `timing.pool.queueMs`, nested |
| B7 "posted" called today's behaviour | not built; `kernels.js:40` loads in every thread today |
| B9 scope | probe first; E3 only on M5's branch; two ops, no test hooks |
| Nits | 17 wrappers; no closures per call; window px calls reported per mips arm; js-flags placement; the trim test arms the trim; a `timeout` on each gate run; "small call" claim dropped; `kernelRoutes` naming |

**Effort (inferred):** build about 0.5 day as S1-S8 in parallel; measurement chain about 3 hours of machine time; defaults, verification and docs about 0.25 day. About 1-1.25 days in all.
