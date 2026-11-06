const P = __PARAMS__;
const before = await run("read_log", { limit: 1 });
const lastId = before.entries && before.entries.length ? before.entries[before.entries.length - 1].id : 0;
await run("select_recipe", { id: P.recipe });
const setv = await run("set_settings", { values: { "2": "qwen3vl_4b_bf16.safetensors", "6": P.megapixels } });
const t0 = Date.now() / 1000;
let out = null, err = null;
try { out = await run("generate_new", { prompt: P.prompt, aspect: P.aspect, resolution: P.resolution, seed: P.seed, timeout: 900 }); } catch (e) { err = String(e.message || e); }
const t1 = Date.now() / 1000;
let ex = null;
if (!err) ex = await run("export", { format: "png", path: P.path, metadata: false });
const log = await run("read_log", { after: lastId, limit: 60 });
const ed = ednow();
return { setv, name: P.name, wall: +(t1 - t0).toFixed(1), out, err, ex, w: ed.width, h: ed.height, log: (log.entries || []).map((e) => [e.level, JSON.stringify(e).slice(0, 4000)]) };
