import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]

MUTANTS = [
    (
        "prv5_jsonError_keep_input",
        "electron/main/providers/util.js",
        'const raw = typeof msg === "string" ? msg : JSON.stringify(msg, (k, v) => (k === "input" ? undefined : v));',
        'const raw = typeof msg === "string" ? msg : JSON.stringify(msg);',
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv5_jsonError_slice_before_scrub",
        "electron/main/providers/util.js",
        "return scrub(raw, key).slice(0, 500);",
        "return scrub(raw.slice(0, 500), key);",
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv5_errorText_old_json_branch",
        "electron/main/providers/util.js",
        'function errorText(r, text, json, key) {\n    const fromJson = jsonError(json, key);\n    if (fromJson) return fromJson;\n    return scrub(text, key).slice(0, 300) || (r && r.statusText) || String((r && r.status) || "error");\n}',
        'function errorText(r, text, json, key) {\n    if (json && typeof json === "object") {\n        const msg = (json.error && (json.error.message || json.error)) || json.detail || json.message || json.status;\n        if (msg) return scrub(typeof msg === "string" ? msg : JSON.stringify(msg), key).slice(0, 300);\n    }\n    return scrub(text, key).slice(0, 300) || (r && r.statusText) || String((r && r.status) || "error");\n}',
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv5_llm_no_key_in_readError",
        "electron/main/llm.js",
        "const f = readFailure ? await readFailure(r) : { message: await readError(r, key && key.length >= 12 ? key : undefined), meta: {} };",
        "const f = readFailure ? await readFailure(r) : { message: await readError(r), meta: {} };",
        ["node", "tools/toapis_test.js"],
    ),
    (
        "prv3_askStop_noop",
        "electron/main/providers/util.js",
        "async function askStop(cancelUrl, { host, method, auth, waitMs = STOP_WAIT_MS } = {}) {",
        "async function askStop(cancelUrl, { host, method, auth, waitMs = STOP_WAIT_MS } = {}) { return false;",
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_askStop_weak_host",
        "electron/main/providers/util.js",
        'if (u.protocol !== "https:" || u.hostname !== host || u.username || u.password) return null;',
        "if (!String(raw).includes(host)) return null;",
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_askStop_ignore_http_status",
        "electron/main/providers/util.js",
        ")).then((r) => !!(r && r.ok)).catch(() => false);",
        ")).then((r) => !!r).catch(() => false);",
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_askStop_no_timeout_race",
        "electron/main/providers/util.js",
        "return await Promise.race([\n            req,\n            new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitMs); }),\n        ]);",
        "return await req;",
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_fal_no_cancelUrl",
        "electron/main/providers/fal.js",
        "const statusUrl = job.status_url, resultUrl = job.response_url, cancelUrl = job.cancel_url;",
        'const statusUrl = job.status_url, resultUrl = job.response_url, cancelUrl = "";',
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_fal_no_timeout_reword",
        "electron/main/providers/fal.js",
        'err.message = err.message.replace("the job may still finish and be charged.", "Scumble asked fal.ai to stop the job.");',
        "// no timeout reword",
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_rep_no_cancelUrl",
        "electron/main/providers/replicate.js",
        "let cancelUrl = pred && pred.urls && pred.urls.cancel;",
        'let cancelUrl = "";',
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_rep_prefer_wait_30",
        "electron/main/providers/replicate.js",
        'const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json" };',
        'const headers = { Authorization: "Bearer " + ctx.key, "Content-Type": "application/json", Prefer: "wait=30" };',
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_rep_no_timeout_reword",
        "electron/main/providers/replicate.js",
        'err.message = err.message.replace("the job may still finish and be charged.", "Scumble asked Replicate to stop the job.");',
        "// no timeout reword",
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_bfl_sleep_poll",
        "electron/main/providers/bfl.js",
        "await (ctx.sleep || sleep)(1000);",
        "await sleep(1000);",
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_bfl_sleep_retry",
        "electron/main/providers/bfl.js",
        "await (ctx.sleep || sleep)(1000 * misses);",
        "await sleep(1000 * misses);",
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_bfl_sleep_download",
        "electron/main/providers/bfl.js",
        "await (ctx.sleep || sleep)(1500);",
        "await sleep(1500);",
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_bfl_no_abort_poll",
        "electron/main/providers/bfl.js",
        "if (isAbort(e, ctx)) throw e;",
        "// no abort rethrow on poll",
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv3_bfl_no_abort_download",
        "electron/main/providers/bfl.js",
        "if (isAbort(e, ctx) || tries >= 2) throw e;",
        "if (tries >= 2) throw e;",
        ["node", "-r", "./tools/nonet.js", "tools/prv1_test.js"],
    ),
    (
        "prv2_toapis_full_revert",
        "electron/main/providers/toapis.js",
        'function setPath(obj, key, value) {\n    const parts = splitPath(key);\n    let o = obj;\n    for (let i = 0; i < parts.length - 1; i++) {\n        const k = parts[i];\n        if (!Object.hasOwn(o, k) || !o[k] || typeof o[k] !== "object" || Array.isArray(o[k])) o[k] = {};\n        o = o[k];\n    }\n    o[parts[parts.length - 1]] = value;\n}\n\nfunction getPath(obj, key) {\n    return splitPath(key).reduce((o, k) => (o && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : undefined), obj);\n}\n\nfunction checkPaths(req, ch) {\n    const p = req.params || {};\n    const drop = new Set(["channel", "random_seed", "model", "n", "prompt", ...(ch.drop || [])]);\n    for (const [k, v] of Object.entries(p)) {\n        if (drop.has(k) || v === "" || v == null || v === "auto") continue;\n        if (k === "background" && ch.transparent_only && String(v).toLowerCase() !== "transparent") continue;\n        splitPath(k);\n    }\n    if (ch.images) splitPath(ch.images);\n    if (ch.tier_key) splitPath(ch.tier_key);\n    if (ch.seed) splitPath(ch.seed);\n    if (ch.negative) splitPath(ch.negative);\n}',
        'function setPath(obj, key, value) {\n    const parts = String(key).split(".");\n    let o = obj;\n    for (let i = 0; i < parts.length - 1; i++) {\n        const k = parts[i];\n        if (!o[k] || typeof o[k] !== "object") o[k] = {};\n        o = o[k];\n    }\n    o[parts[parts.length - 1]] = value;\n}\n\nfunction getPath(obj, key) {\n    return String(key).split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);\n}\n\nfunction checkPaths() {}',
        ["node", "tools/toapis_test.js"],
    ),
    (
        "prv2_toapis_no_checkPaths_before_upload",
        "electron/main/providers/toapis.js",
        "checkPaths(req, ch);\n    const stamp = Date.now().toString(36);",
        "const stamp = Date.now().toString(36);",
        ["node", "tools/toapis_test.js"],
    ),
    (
        "prv2_toapis_checkPaths_nullish_options",
        "electron/main/providers/toapis.js",
        "if (ch.negative) splitPath(ch.negative);",
        "if (ch.negative != null) splitPath(ch.negative);",
        ["node", "tools/toapis_test.js"],
    ),
    (
        "rec_keepOwnId_from_stem",
        "electron/main/recipes.js",
        'const rawId = data && data.kind && typeof recipe.id === "string" ? recipe.id.trim() : "";',
        "const rawId = slug(recipe.id || stem);",
        ["node", "tools/recipes_test.js"],
    ),
    (
        "rec_ignore_userFileStems",
        "electron/main/recipes.js",
        "const fileStems = await userFileStems();",
        "const fileStems = new Set();",
        ["node", "tools/recipes_test.js"],
    ),
    (
        "rec_allow_non_canonical_rawId",
        "electron/main/recipes.js",
        "const prev = rawId && slug(rawId) === rawId ? byId.get(rawId) : undefined;\n    const keepOwnId = !!(rawId && slug(rawId) === rawId && (prev || !fileStems.has(rawId.toLowerCase())));",
        "const prev = rawId ? byId.get(slug(rawId)) : undefined;\n    const keepOwnId = !!(rawId && (prev || !fileStems.has(slug(rawId).toLowerCase())));",
        ["node", "tools/recipes_test.js"],
    ),
    (
        "rec_no_name_bump",
        "electron/main/recipes.js",
        "recipe.name = recipe.name || (id === baseId ? stem : `${stem} ${n - 1}`);",
        "recipe.name = recipe.name || stem;",
        ["node", "tools/recipes_test.js"],
    ),
    (
        "rec_restore_klein_hard_block",
        "electron/main/recipes.js",
        "const keepOwnId = !!(rawId && slug(rawId) === rawId && (prev || !fileStems.has(rawId.toLowerCase())));",
        'const keepOwnId = !!(rawId && slug(rawId) === rawId && rawId !== "flux2_klein_local" && (prev || !fileStems.has(rawId.toLowerCase())));',
        ["node", "tools/recipes_test.js"],
    ),
]


def main():
    for _, rel_path, _, _, _ in MUTANTS:
        p = ROOT / rel_path
        p.write_bytes(p.read_bytes().replace(b"\r\n", b"\n"))

    killed = 0
    lines = []
    for name, rel_path, target, replacement, cmd in MUTANTS:
        p = ROOT / rel_path
        orig_bytes = p.read_bytes()
        orig = orig_bytes.decode("utf-8")
        if target not in orig:
            msg = f"[ERROR] target not found for {name} in {rel_path}"
            print(msg)
            lines.append(msg)
            sys.exit(2)
        try:
            p.write_bytes(orig.replace(target, replacement, 1).encode("utf-8"))
            r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
            passed_lines = [ln for ln in r.stdout.splitlines() if ln.strip() == "PASS"]
            is_killed = (r.returncode != 0) or (len(passed_lines) == 0)
            status = "KILLED" if is_killed else "SURVIVED"
            if is_killed:
                killed += 1
            fail_lines = [ln for ln in r.stdout.splitlines() if "[FAIL]" in ln]
            detail = fail_lines[0] if fail_lines else f"exit={r.returncode}"
            msg = f"[{status}] {name} ({rel_path}) -> {detail}"
            print(msg)
            lines.append(msg)
        finally:
            p.write_bytes(orig_bytes)

    summary = f"\nResult: {killed}/{len(MUTANTS)} mutants killed"
    print(summary)
    lines.append(summary)
    out_file = pathlib.Path(__file__).resolve().parent / "results.txt"
    out_file.write_bytes(("\n".join(lines) + "\n").encode("utf-8"))
    sys.exit(0 if killed == len(MUTANTS) else 1)


if __name__ == "__main__":
    main()
