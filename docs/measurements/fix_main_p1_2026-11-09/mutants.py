TITLE = "fix-main-p1"
WORKING = [
    "electron/main/autosave.js",
    "electron/main/settings.js",
    "electron/main/keys.js",
    "electron/main/main.js",
    "electron/main/docfile.js",
    "electron/main/files.js",
    "tools/document_test.js",
    "tools/quit_test.js",
]
GATES = ["document", "quit"]
TILES = "on"

MUTANTS = [
    # ---- autosave.js ----------------------------------------------------------------------------------------
    (
        "autosave_no_fsync",
        "electron/main/autosave.js",
        [(
            "        fs.fsyncSync(fd);\n        ok = true;",
            "        ok = true;",
        )],
        "killed: quit_test checks write,write,fsync,rename order in autosave",
        {"gates": ["quit"]},
    ),
    (
        "autosave_fsync_before_write",
        "electron/main/autosave.js",
        [(
            "        for (let off = 0; off < buf.length; ) {\n            const n = fs.writeSync(fd, buf, off, buf.length - off);\n            if (!(n > 0)) throw Object.assign(new Error(\"short write\"), { code: \"EIO\" });\n            off += n;\n        }\n        fs.fsyncSync(fd);",
            "        fs.fsyncSync(fd);\n        for (let off = 0; off < buf.length; ) {\n            const n = fs.writeSync(fd, buf, off, buf.length - off);\n            if (!(n > 0)) throw Object.assign(new Error(\"short write\"), { code: \"EIO\" });\n            off += n;\n        }",
        )],
        "killed: quit_test checks write precedes fsync in autosave",
        {"gates": ["quit"]},
    ),
    (
        "autosave_no_short_write_loop",
        "electron/main/autosave.js",
        [(
            "        for (let off = 0; off < buf.length; ) {\n            const n = fs.writeSync(fd, buf, off, buf.length - off);\n            if (!(n > 0)) throw Object.assign(new Error(\"short write\"), { code: \"EIO\" });\n            off += n;\n        }",
            "        fs.writeSync(fd, buf, 0, buf.length);",
        )],
        "killed: quit_test checks short-write loop and zero-write abort in autosave",
        {"gates": ["quit"]},
    ),
    (
        "autosave_no_write_retry",
        "electron/main/autosave.js",
        [(
            "    retrying(() => fs.renameSync(tmp, file));",
            "    fs.renameSync(tmp, file);",
        )],
        "killed: quit_test checks EBUSY/EPERM retry on autosave rename",
        {"gates": ["quit"]},
    ),
    (
        "autosave_no_read_retry",
        "electron/main/autosave.js",
        [(
            '        raw = retrying(() => fs.readFileSync(file, "utf8"), cooling ? 0 : 4);',
            '        raw = fs.readFileSync(file, "utf8");',
        )],
        "killed: quit_test checks transient EBUSY retry on autosave.load",
        {"gates": ["quit"]},
    ),
    (
        "autosave_no_rotate_retry",
        "electron/main/autosave.js",
        [(
            "    if (fs.existsSync(one)) retrying(() => fs.renameSync(one, two));",
            "    if (fs.existsSync(one)) fs.renameSync(one, two);",
        )],
        "killed: quit_test checks EBUSY retry on autosave.rotate generation rename",
        {"gates": ["quit"]},
    ),
    (
        "autosave_no_setaside_retry",
        "electron/main/autosave.js",
        [(
            "    if (prev) retrying(() => fs.renameSync(crash, older));",
            "    if (prev) fs.renameSync(crash, older);",
        )],
        "killed: quit_test checks EPERM retry on autosave.setAside rename",
        {"gates": ["quit"]},
    ),
    (
        "autosave_damaged_not_kept",
        "electron/main/autosave.js",
        [(
            "        const aside = setAsideDamaged(file);",
            "        const aside = null;",
        )],
        "killed: quit_test checks damaged autosave.json is renamed to .damaged",
        {"gates": ["quit"]},
    ),
    (
        "autosave_damaged_no_numbering",
        "electron/main/autosave.js",
        [(
            "    let dest = file + \".damaged\";\n    for (let i = 1; fs.existsSync(dest); i++) dest = `${file}.damaged.${i}`;",
            "    let dest = file + \".damaged\";",
        )],
        "killed: quit_test checks second damaged autosave.json uses .damaged.1",
        {"gates": ["quit"]},
    ),
    (
        "autosave_read_error_treated_as_missing",
        "electron/main/autosave.js",
        [(
            "        return { status: \"error\", data: null, error: err };",
            "        return { status: \"missing\", data: null };",
        )],
        "killed: quit_test checks rotate/load/referencedKeys distinguish unreadable from missing",
        {"gates": ["quit"]},
    ),
    (
        "autosave_save_overwrites_unreadable",
        "electron/main/autosave.js",
        [(
            "    if (unreadableCurrent.has(key) && fs.existsSync(cur)) {\n        rotate(dir);",
            "    if (false && unreadableCurrent.has(key) && fs.existsSync(cur)) {\n        rotate(dir);",
        )],
        "killed: quit_test checks save after startup read error rotates unread session into generation 1",
        {"gates": ["quit"]},
    ),

    # ---- settings.js ----------------------------------------------------------------------------------------
    (
        "settings_no_fsync",
        "electron/main/settings.js",
        [(
            "        fs.fsyncSync(fd);\n        ok = true;",
            "        ok = true;",
        )],
        "killed: quit_test checks write,write,fsync,rename order in settings",
        {"gates": ["quit"]},
    ),
    (
        "settings_no_short_write_loop",
        "electron/main/settings.js",
        [(
            "        for (let off = 0; off < buf.length; ) {\n            const n = fs.writeSync(fd, buf, off, buf.length - off);\n            if (!(n > 0)) throw Object.assign(new Error(\"short write\"), { code: \"EIO\" });\n            off += n;\n        }",
            "        fs.writeSync(fd, buf, 0, buf.length);",
        )],
        "killed: quit_test checks short-write loop and zero-write abort in settings",
        {"gates": ["quit"]},
    ),
    (
        "settings_no_write_retry",
        "electron/main/settings.js",
        [(
            "    retrying(() => fs.renameSync(tmp, file(name)));",
            "    fs.renameSync(tmp, file(name));",
        )],
        "killed: quit_test checks EACCES/EBUSY retry on settings rename",
        {"gates": ["quit"]},
    ),
    (
        "settings_no_read_retry",
        "electron/main/settings.js",
        [(
            '        raw = retrying(() => fs.readFileSync(p, "utf8"), cooling ? 0 : 4);',
            '        raw = fs.readFileSync(p, "utf8");',
        )],
        "killed: quit_test checks transient EBUSY retry on settings.get",
        {"gates": ["quit"]},
    ),
    (
        "settings_no_read_cooldown",
        "electron/main/settings.js",
        [(
            "    const cooling = readFailUntil > Date.now();",
            "    const cooling = false;",
        )],
        "killed: quit_test checks settings cooldown skips 4-retry loop on repeated unreadable reads",
        {"gates": ["quit"]},
    ),
    (
        "settings_damaged_not_kept",
        "electron/main/settings.js",
        [(
            "        const aside = setAsideDamaged(p);",
            "        const aside = null;",
        )],
        "killed: quit_test checks damaged settings.json is renamed to .damaged and allows fresh writes",
        {"gates": ["quit"]},
    ),
    (
        "settings_damaged_no_numbering",
        "electron/main/settings.js",
        [(
            "    let dest = p + \".damaged\";\n    for (let i = 1; fs.existsSync(dest); i++) dest = `${p}.damaged.${i}`;",
            "    let dest = p + \".damaged\";",
        )],
        "killed: quit_test checks second damaged settings.json uses .damaged.1",
        {"gates": ["quit"]},
    ),
    (
        "settings_read_error_persists",
        "electron/main/settings.js",
        [(
            '    if (loaded) writeJson("settings.json", cache);\n    else pending = { ...pending, ...(patch || {}) };',
            '    writeJson("settings.json", cache);',
        )],
        "killed: quit_test checks unread settings are not overwritten",
        {"gates": ["quit"]},
    ),
    (
        "settings_get_recovery_drops_pending",
        "electron/main/settings.js",
        [(
            '            if (hadPending && !inSet) {\n                try { writeJson("settings.json", cache); } catch (err) { console.warn("settings write:", err.message); }\n            }',
            "            /* dropped get() recovery write */",
        )],
        "killed: quit_test checks get() recovery persists pending patches to disk",
        {"gates": ["quit"]},
    ),

    # ---- keys.js --------------------------------------------------------------------------------------------
    (
        "keys_no_fsync",
        "electron/main/keys.js",
        [(
            "        fs.fsyncSync(fd);\n        ok = true;",
            "        ok = true;",
        )],
        "killed: quit_test checks write,write,fsync,rename order in keys",
        {"gates": ["quit"]},
    ),
    (
        "keys_no_short_write_loop",
        "electron/main/keys.js",
        [(
            "        for (let off = 0; off < buf.length; ) {\n            const n = fs.writeSync(fd, buf, off, buf.length - off);\n            if (!(n > 0)) throw Object.assign(new Error(\"short write\"), { code: \"EIO\" });\n            off += n;\n        }",
            "        fs.writeSync(fd, buf, 0, buf.length);",
        )],
        "killed: quit_test checks short-write loop and zero-write abort in keys",
        {"gates": ["quit"]},
    ),
    (
        "keys_no_write_retry",
        "electron/main/keys.js",
        [(
            "    retrying(() => fs.renameSync(tmp, file()));",
            "    fs.renameSync(tmp, file());",
        )],
        "killed: quit_test checks EPERM/EACCES retry on keys rename",
        {"gates": ["quit"]},
    ),
    (
        "keys_no_read_retry",
        "electron/main/keys.js",
        [(
            '        raw = retrying(() => fs.readFileSync(p, "utf8"), cooling ? 0 : 4);',
            '        raw = fs.readFileSync(p, "utf8");',
        )],
        "killed: quit_test checks transient EBUSY retry on keys.get",
        {"gates": ["quit"]},
    ),
    (
        "keys_no_read_cooldown",
        "electron/main/keys.js",
        [(
            "    const cooling = readFailUntil > Date.now();",
            "    const cooling = false;",
        )],
        "killed: quit_test checks keys cooldown skips 4-retry sleeps while unreadable",
        {"gates": ["quit"]},
    ),
    (
        "keys_damaged_not_kept",
        "electron/main/keys.js",
        [(
            "        const aside = setAsideDamaged(p);",
            "        const aside = null;",
        )],
        "killed: quit_test checks damaged secrets.json is renamed to .damaged and allows fresh writes",
        {"gates": ["quit"]},
    ),
    (
        "keys_damaged_no_numbering",
        "electron/main/keys.js",
        [(
            "    let dest = p + \".damaged\";\n    for (let i = 1; fs.existsSync(dest); i++) dest = `${p}.damaged.${i}`;",
            "    let dest = p + \".damaged\";",
        )],
        "killed: quit_test checks second damaged secrets.json uses .damaged.1",
        {"gates": ["quit"]},
    ),
    (
        "keys_read_error_overwrites",
        "electron/main/keys.js",
        [(
            "        if (forWrite) throw err;\n        return {};",
            "        return {};",
        )],
        "killed: quit_test checks keys.set and keys.clear refuse on read error",
        {"gates": ["quit"]},
    ),
    (
        "keys_unmoved_damaged_overwrites",
        "electron/main/keys.js",
        [(
            '        if (forWrite) throw new Error("secrets.json is damaged and could not be set aside; refusing to overwrite stored keys.");\n        return {};',
            "        return {};",
        )],
        "killed: quit_test checks keys.set refuses when damaged secrets.json cannot be renamed aside",
        {"gates": ["quit"]},
    ),
    (
        "keys_clear_ignores_read_error",
        "electron/main/keys.js",
        [(
            "function clear(name) {\n    const all = readAll(true);",
            "function clear(name) {\n    const all = readAll(false);",
        )],
        "killed: quit_test checks keys.clear and keys.set(name, '') refuse when secrets.json cannot be read",
        {"gates": ["quit"]},
    ),

    # ---- main.js --------------------------------------------------------------------------------------------
    (
        "main_close_bounds_unwrapped",
        "electron/main/main.js",
        [(
            '        try { settings.set({ window: { ...b, maximized: viewFullScreen && win.isFullScreen() ? maximizedBeforeView : win.isMaximized() } }); }\n        catch (err) { console.warn("window bounds:", err.message); }',
            "        settings.set({ window: { ...b, maximized: viewFullScreen && win.isFullScreen() ? maximizedBeforeView : win.isMaximized() } });",
        )],
        "killed: quit_test checks try/catch around window bounds settings.set",
        {"gates": ["quit"]},
    ),
    (
        "main_add_recent_unwrapped",
        "electron/main/main.js",
        [(
            'function addRecent(file) {\n    try {\n        const list = recentDocuments().filter((r) => pathKey(r.path) !== pathKey(file));\n        list.unshift({ path: file, name: path.basename(file), time: Date.now() });\n        settings.set({ recentDocuments: list.slice(0, RECENT_MAX) });\n        // a portable copy leaves no jump list entry on the PC it runs on (docs/PLAN_0_1_42.md Q22)\n        if (!PORTABLE) { try { app.addRecentDocument(file); } catch (_) { /* the jump list shows it once the file type is registered */ } }\n        buildMenu();\n    } catch (err) {\n        console.warn("recent documents:", err.message);\n    }\n}',
            'function addRecent(file) {\n    const list = recentDocuments().filter((r) => pathKey(r.path) !== pathKey(file));\n    list.unshift({ path: file, name: path.basename(file), time: Date.now() });\n    settings.set({ recentDocuments: list.slice(0, RECENT_MAX) });\n    // a portable copy leaves no jump list entry on the PC it runs on (docs/PLAN_0_1_42.md Q22)\n    if (!PORTABLE) { try { app.addRecentDocument(file); } catch (_) { /* the jump list shows it once the file type is registered */ } }\n    buildMenu();\n}',
        )],
        "killed: quit_test checks try/catch in addRecent",
        {"gates": ["quit"]},
    ),
    (
        "main_drop_recent_unwrapped",
        "electron/main/main.js",
        [(
            'function dropRecent(file) {\n    try {\n        const list = recentDocuments();\n        const kept = list.filter((r) => pathKey(r.path) !== pathKey(file));\n        if (kept.length !== list.length) { settings.set({ recentDocuments: kept }); buildMenu(); }\n    } catch (err) {\n        console.warn("recent documents:", err.message);\n    }\n}',
            'function dropRecent(file) {\n    const list = recentDocuments();\n    const kept = list.filter((r) => pathKey(r.path) !== pathKey(file));\n    if (kept.length !== list.length) { settings.set({ recentDocuments: kept }); buildMenu(); }\n}',
        )],
        "killed: quit_test checks try/catch in dropRecent",
        {"gates": ["quit"]},
    ),
    (
        "main_prune_swallows_unreadable_generation",
        "electron/main/main.js",
        [(
            '        const kept = autosave.referencedKeys(app.getPath("userData"));',
            '        let kept = [];\n        try { kept = autosave.referencedKeys(app.getPath("userData")); } catch (_) {}',
        )],
        "killed: quit_test checks files:prune does not swallow unreadable generation error",
        {"gates": ["quit"]},
    ),

    # ---- files.js -------------------------------------------------------------------------------------------
    (
        "files_mirror_path_no_bad_part",
        "electron/main/files.js",
        [(
            '    if (typeof filename !== "string" || filename === "." || filename === ".." || badPart(filename)) throw new Error("bad file name: " + filename);',
            '    if (typeof filename !== "string" || filename === "." || filename === ".." || !SAFE_NAME.test(filename)) throw new Error("bad file name: " + filename);',
        )],
        "killed: document_test checks files.mirrorPath refuses device names",
        {"gates": ["document"]},
    ),
    (
        "files_mirror_path_no_sub_bad_part",
        "electron/main/files.js",
        [(
            '    for (const s of sub) if (badPart(s)) throw new Error("bad folder name: " + s);',
            "    /* dropped subfolder badPart check */",
        )],
        "killed: document_test checks files.mirrorPath refuses reserved subfolder names",
        {"gates": ["document"]},
    ),
    (
        "files_store_no_safe_mirror_name",
        "electron/main/files.js",
        [(
            "    if (overwrite) {\n        const filename = safeMirrorName(rawName);",
            "    if (overwrite) {\n        const filename = rawName;",
        )],
        "killed: document_test checks overwrite:true upload of aux.ttf succeeds",
        {"gates": ["document"]},
    ),
    (
        "files_store_no_collision_hash",
        "electron/main/files.js",
        [(
            "        if (filename !== rawName) {",
            "        if (false && filename !== rawName) {",
        )],
        "killed: document_test checks collision on mapped aux_.ttf uses contentName",
        {"gates": ["document"]},
    ),
    (
        "files_view_uses_strict_mirror_path",
        "electron/main/files.js",
        [(
            "        try { local = mirrorReadPath(type, subfolder, filename, this.root()); } catch (err) { return new Response(err.message, { status: 400 }); }",
            "        try { local = mirrorPath(type, subfolder, filename, this.root()); } catch (err) { return new Response(err.message, { status: 400 }); }",
        )],
        "killed: document_test checks handleView serves existing aux.png and server subfolder aux",
        {"gates": ["document"]},
    ),
    (
        "files_ensure_uses_strict_mirror_path",
        "electron/main/files.js",
        [(
            "                local = mirrorReadPath(type, subfolder, ref.filename, this.root());",
            "                local = mirrorPath(type, subfolder, ref.filename, this.root());",
        )],
        "killed: document_test checks ensureOnServer finds and uploads existing aux.png",
        {"gates": ["document"]},
    ),
]
