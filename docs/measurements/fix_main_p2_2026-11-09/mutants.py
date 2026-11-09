TITLE = "fix-main-p2"
WORKING = [
    "electron/main/mcp/launch.js",
    "mcpb/server/index.js",
    "electron/main/docfile.js",
    "electron/main/documents.js",
    "electron/main/main.js",
    "tools/document_test.js",
    "tools/mcp_test.py",
    "tools/mcpb_test.js",
]
GATES = ["document", "mcpb"]
TILES = "on"

MUTANTS = [
    # ---- electron/main/mcp/launch.js (MAIN-1) ---------------------------------------------------------------
    (
        "launch_not_detached",
        "electron/main/mcp/launch.js",
        [(
            '    child = spawn(exe, args, { env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true, detached: SERVES });',
            '    child = spawn(exe, args, { env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true, detached: false });',
        )],
        "killed: mcpb_test checks launch.js spawns --mcp child with detached:true",
        {"gates": ["mcpb"]},
    ),
    (
        "launch_detached_always",
        "electron/main/mcp/launch.js",
        [(
            'const SERVES = CHILD_ARGS.includes("--mcp");',
            "const SERVES = true;",
        )],
        "killed: mcpb_test checks launch.js does not detach --run child and kills --run child on signal",
        {"gates": ["mcpb"]},
    ),
    (
        "launch_five_sec_kill",
        "electron/main/mcp/launch.js",
        [(
            "function clientGone() {\n    if (ending) return;\n    ending = true;\n    try { child.stdin.end(); } catch { /* gone */ }\n}",
            "function clientGone() {\n    if (ending) return;\n    ending = true;\n    try { child.stdin.end(); } catch { /* gone */ }\n    if (SERVES) setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 5000).unref();\n}",
        )],
        "killed: mcpb_test checks launch.js lets --mcp child flush past 5 s without killing it",
        {"gates": ["mcpb"]},
    ),
    (
        "launch_sig_kills_mcp",
        "electron/main/mcp/launch.js",
        [(
            'for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { if (SERVES) clientGone(); else { try { child.kill(); } catch { /* gone */ } } });',
            'for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { try { child.kill(); } catch { /* gone */ } });',
        )],
        "killed: mcpb_test checks SIGTERM on launch.js (--mcp) calls clientGone instead of killing child",
        {"gates": ["mcpb"]},
    ),
    (
        "launch_sig_never_kills_run",
        "electron/main/mcp/launch.js",
        [(
            'for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { if (SERVES) clientGone(); else { try { child.kill(); } catch { /* gone */ } } });',
            'for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { clientGone(); });',
        )],
        "killed: mcpb_test checks SIGTERM on launch.js (--run) still kills the child",
        {"gates": ["mcpb"]},
    ),
    (
        "launch_sig_noop_mcp",
        "electron/main/mcp/launch.js",
        [(
            'for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { if (SERVES) clientGone(); else { try { child.kill(); } catch { /* gone */ } } });',
            'for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { if (!SERVES) { try { child.kill(); } catch { /* gone */ } } });',
        )],
        "killed: mcpb_test checks SIGTERM on launch.js (--mcp) calls clientGone rather than ignoring the signal",
        {"gates": ["mcpb"]},
    ),
    # ---- mcpb/server/index.js (MAIN-1) ----------------------------------------------------------------------
    (
        "relay_not_detached",
        "mcpb/server/index.js",
        [(
            '        child = spawn(p.command, p.args, { env: { ...process.env, ...p.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: true });',
            '        child = spawn(p.command, p.args, { env: { ...process.env, ...p.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });',
        )],
        "killed: mcpb_test checks relay spawns child with detached:true",
        {"gates": ["mcpb"]},
    ),
    (
        "relay_five_sec_kill",
        "mcpb/server/index.js",
        [(
            "    const clientGone = () => {\n        if (ending) return;\n        ending = true;\n        try { child.stdin.end(); } catch (_) { /* gone */ }\n    };",
            "    const clientGone = () => {\n        if (ending) return;\n        ending = true;\n        try { child.stdin.end(); } catch (_) { /* gone */ }\n        setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } }, 5000).unref();\n    };",
        )],
        "killed: mcpb_test checks relay lets child flush past 5 s without killing it",
        {"gates": ["mcpb"]},
    ),
    (
        "relay_sig_kills_child",
        "mcpb/server/index.js",
        [(
            '    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, clientGone);',
            '    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { try { child.kill(); } catch (_) { /* gone */ } });',
        )],
        "killed: mcpb_test checks SIGTERM on relay calls clientGone instead of killing child",
        {"gates": ["mcpb"]},
    ),
    (
        "relay_sig_noop",
        "mcpb/server/index.js",
        [(
            '    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, clientGone);',
            '    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => {});',
        )],
        "killed: mcpb_test checks SIGTERM on relay calls clientGone rather than ignoring the signal",
        {"gates": ["mcpb"]},
    ),
    # ---- electron/main/docfile.js (D9, D10, D6) -------------------------------------------------------------
    (
        "write_no_readonly_check",
        "electron/main/docfile.js",
        [(
            '    if (st && !(st.mode & 0o200)) throw failure(`${path.basename(target)} is read-only`, "EPERM");',
            "    /* no readonly check */",
        )],
        "killed: document_test checks writeDocument refuses a read-only target before writing temp",
        {"gates": ["document"]},
    ),
    (
        "write_readonly_wrong_code",
        "electron/main/docfile.js",
        [(
            '    if (st && !(st.mode & 0o200)) throw failure(`${path.basename(target)} is read-only`, "EPERM");',
            '    if (st && !(st.mode & 0o200)) throw failure(`${path.basename(target)} is read-only`, "EACCES");',
        )],
        "killed: document_test checks read-only target failure carries code EPERM",
        {"gates": ["document"]},
    ),
    (
        "sweep_clears_kept_list",
        "electron/main/docfile.js",
        [(
            "    try { writeList(registry, kept); } catch (_) { /* a read-only profile: nothing to keep either */ }",
            "    try { writeList(registry, []); } catch (_) { /* a read-only profile: nothing to keep either */ }",
        )],
        "killed: document_test checks sweepTemps preserves locked and missing-folder temp paths in registry",
        {"gates": ["document"]},
    ),
    (
        "sweep_drops_missing_dir_enoent",
        "electron/main/docfile.js",
        [(
            '            if (!err || err.code !== "ENOENT" || !fs.existsSync(path.dirname(p))) kept.push(p);',
            '            if (!err || err.code !== "ENOENT") kept.push(p);',
        )],
        "killed: document_test checks sweepTemps keeps ENOENT temp path when parent folder does not exist",
        {"gates": ["document"]},
    ),
    (
        "sweep_keeps_gone_temp_in_existing_dir",
        "electron/main/docfile.js",
        [(
            '            if (!err || err.code !== "ENOENT" || !fs.existsSync(path.dirname(p))) kept.push(p);',
            "            kept.push(p);",
        )],
        "killed: document_test checks sweepTemps drops ENOENT temp path when parent folder exists",
        {"gates": ["document"]},
    ),
    (
        "copy_entry_pid_only_tmp",
        "electron/main/docfile.js",
        [(
            "    const tmp = `${dest}.importing-${process.pid}-${++tempSeq}`;",
            "    const tmp = `${dest}.importing-${process.pid}`;",
        )],
        "killed: document_test checks copyEntry uses unique .importing-<pid>-<seq> temp names",
        {"gates": ["document"]},
    ),
    (
        "open_no_import_lock",
        "electron/main/docfile.js",
        [(
            "async function withImportLock(locks, key, fn) {\n    if (!locks) return fn();",
            "async function withImportLock(locks, key, fn) {\n    return fn();",
        )],
        "killed: document_test checks concurrent opens serialise shared imports and import photo.png once",
        {"gates": ["document"]},
    ),
    (
        "open_no_freename_lock",
        "electron/main/docfile.js",
        [(
            "                        const placed = kFree === k ? await place() : await withImportLock(importLocks, kFree, place);",
            "                        const placed = kFree === k ? await place() : await withImportLock(null, kFree, place);",
        )],
        "killed: document_test checks freeName import acquires import lock on kFree against concurrent literal import",
        {"gates": ["document"]},
    ),
    (
        "open_self_deadlock_kfree_eq_k",
        "electron/main/docfile.js",
        [(
            "                        const placed = kFree === k ? await place() : await withImportLock(importLocks, kFree, place);",
            "                        const placed = await withImportLock(importLocks, kFree, place);",
        )],
        "killed: document_test checks openDocument does not self-deadlock when dest vanishes before freeName (kFree === k)",
        {"gates": ["document"]},
    ),
    (
        "open_identity_rename_when_dest_gone",
        "electron/main/docfile.js",
        [(
            "                            if (name !== ref.filename) renamed.set(k, name);",
            "                            renamed.set(k, name);",
        )],
        "killed: document_test checks openDocument does not record an identity rename when freeName returns ref.filename",
        {"gates": ["document"]},
    ),
    (
        "open_no_destfree_exists_recheck",
        "electron/main/docfile.js",
        [(
            "                            if (fs.existsSync(destFree)) return false;",
            "                            /* no destFree recheck */",
        )],
        "killed: document_test checks freeName import rechecks destFree existence inside kFree lock",
        {"gates": ["document"]},
    ),
    (
        "open_no_onkey_initial",
        "electron/main/docfile.js",
        [(
            "            if (onKey) onKey(k);",
            "            /* no onKey(k) */",
        )],
        "killed: document_test checks keepKeys holds original ref keys during open",
        {"gates": ["document"]},
    ),
    (
        "open_no_onkey_freename",
        "electron/main/docfile.js",
        [(
            "                            if (onKey) onKey(kFree);",
            "                            /* no onKey(kFree) */",
        )],
        "killed: document_test checks keepKeys holds renamed freeName ref keys during open",
        {"gates": ["document"]},
    ),
    # ---- electron/main/documents.js (D6) --------------------------------------------------------------------
    (
        "documents_open_no_import_locks",
        "electron/main/documents.js",
        [(
            "            const r = await docfile.openDocument({ file, mirrorRoot: this.mirrorRoot, signal: job.ctrl.signal, onProgress: progress, importLocks: this.imports, onKey: (k) => job.keys.add(k) });",
            "            const r = await docfile.openDocument({ file, mirrorRoot: this.mirrorRoot, signal: job.ctrl.signal, onProgress: progress, importLocks: null, onKey: (k) => job.keys.add(k) });",
        )],
        "killed: document_test checks Documents.open passes this.imports to openDocument",
        {"gates": ["document"]},
    ),
    (
        "documents_open_no_onkey",
        "electron/main/documents.js",
        [(
            "            const r = await docfile.openDocument({ file, mirrorRoot: this.mirrorRoot, signal: job.ctrl.signal, onProgress: progress, importLocks: this.imports, onKey: (k) => job.keys.add(k) });",
            "            const r = await docfile.openDocument({ file, mirrorRoot: this.mirrorRoot, signal: job.ctrl.signal, onProgress: progress, importLocks: this.imports, onKey: null });",
        )],
        "killed: document_test checks Documents.open records imported keys in job.keys",
        {"gates": ["document"]},
    ),
    # ---- electron/main/main.js (D6) -------------------------------------------------------------------------
    (
        "main_open_enoent_drops_existing_recent",
        "electron/main/main.js",
        [(
            '            if (err && err.code === "ENOENT" && req && req.path && !fs.existsSync(req.path)) { dropRecent(req.path); throw new Error(`${path.basename(req.path)} is not there any more (moved or deleted); it left Open Recent`); }',
            '            if (err && err.code === "ENOENT" && req && req.path) { dropRecent(req.path); throw new Error(`${path.basename(req.path)} is not there any more (moved or deleted); it left Open Recent`); }',
        )],
        "killed: document_test checks documents:open IPC handler only drops recent and rewrites ENOENT when req.path is gone",
        {"gates": ["document"]},
    ),
]
