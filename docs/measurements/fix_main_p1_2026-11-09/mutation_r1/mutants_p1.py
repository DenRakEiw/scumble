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
    (
        "autosave_no_fsync",
        "electron/main/autosave.js",
        [(
            '        fs.writeSync(fd, JSON.stringify(value) + "\\n", null, "utf8");\n        fs.fsyncSync(fd);',
            '        fs.writeSync(fd, JSON.stringify(value) + "\\n", null, "utf8");',
        )],
        "killed: quit_test stores_fsync_retry_busy_and_keep_damaged_files checks fsync before rename in autosave",
        {"gates": ["quit"]},
    ),
    (
        "autosave_no_retry",
        "electron/main/autosave.js",
        [(
            "    retrying(() => fs.renameSync(tmp, file));",
            "    fs.renameSync(tmp, file);",
        )],
        "killed: quit_test stores_fsync_retry_busy_and_keep_damaged_files checks EBUSY retry in autosave",
        {"gates": ["quit"]},
    ),
    (
        "autosave_damaged_not_kept",
        "electron/main/autosave.js",
        [(
            '        try { retrying(() => fs.renameSync(file, file + ".damaged")); } catch (_) { /* keep as-is */ }',
            "        /* dropped rename to .damaged */",
        )],
        "killed: quit_test stores_fsync_retry_busy_and_keep_damaged_files checks damaged autosave.json is renamed to .damaged",
        {"gates": ["quit"]},
    ),
    (
        "settings_no_fsync",
        "electron/main/settings.js",
        [(
            '        fs.writeSync(fd, JSON.stringify(value, null, 2) + "\\n", null, "utf8");\n        fs.fsyncSync(fd);',
            '        fs.writeSync(fd, JSON.stringify(value, null, 2) + "\\n", null, "utf8");',
        )],
        "killed: quit_test stores_fsync_retry_busy_and_keep_damaged_files checks fsync before rename in settings",
        {"gates": ["quit"]},
    ),
    (
        "settings_no_retry",
        "electron/main/settings.js",
        [(
            "    retrying(() => fs.renameSync(tmp, file(name)));",
            "    fs.renameSync(tmp, file(name));",
        )],
        "killed: quit_test stores_fsync_retry_busy_and_keep_damaged_files checks EBUSY retry in settings",
        {"gates": ["quit"]},
    ),
    (
        "settings_read_error_persists",
        "electron/main/settings.js",
        [(
            '    if (loaded) writeJson("settings.json", cache);',
            '    writeJson("settings.json", cache);',
        )],
        "killed: quit_test stores_fsync_retry_busy_and_keep_damaged_files checks unread/damaged settings are not overwritten",
        {"gates": ["quit"]},
    ),
    (
        "keys_no_fsync",
        "electron/main/keys.js",
        [(
            '        fs.writeSync(fd, JSON.stringify(data, null, 2) + "\\n", null, "utf8");\n        fs.fsyncSync(fd);',
            '        fs.writeSync(fd, JSON.stringify(data, null, 2) + "\\n", null, "utf8");',
        )],
        "killed: quit_test stores_fsync_retry_busy_and_keep_damaged_files checks fsync before rename in keys",
        {"gates": ["quit"]},
    ),
    (
        "keys_no_retry",
        "electron/main/keys.js",
        [(
            "    retrying(() => fs.renameSync(tmp, file()));",
            "    fs.renameSync(tmp, file());",
        )],
        "killed: quit_test stores_fsync_retry_busy_and_keep_damaged_files checks EBUSY retry in keys",
        {"gates": ["quit"]},
    ),
    (
        "keys_read_error_overwrites",
        "electron/main/keys.js",
        [(
            "        if (forWrite) throw err;\n        return {};",
            "        return {};",
        )],
        "killed: quit_test stores_fsync_retry_busy_and_keep_damaged_files checks keys.set refuses on read error",
        {"gates": ["quit"]},
    ),
    (
        "main_close_bounds_unwrapped",
        "electron/main/main.js",
        [(
            '        try { settings.set({ window: { ...b, maximized: viewFullScreen && win.isFullScreen() ? maximizedBeforeView : win.isMaximized() } }); }\n        catch (err) { console.warn("window bounds:", err.message); }',
            "        settings.set({ window: { ...b, maximized: viewFullScreen && win.isFullScreen() ? maximizedBeforeView : win.isMaximized() } });",
        )],
        "killed: quit_test main_prevents_a_close_until_the_window_saved checks try/catch around window bounds settings.set",
        {"gates": ["quit"]},
    ),
    (
        "main_add_recent_unwrapped",
        "electron/main/main.js",
        [(
            'function addRecent(file) {\n    try {\n        const list = recentDocuments().filter((r) => pathKey(r.path) !== pathKey(file));\n        list.unshift({ path: file, name: path.basename(file), time: Date.now() });\n        settings.set({ recentDocuments: list.slice(0, RECENT_MAX) });\n        // a portable copy leaves no jump list entry on the PC it runs on (docs/PLAN_0_1_42.md Q22)\n        if (!PORTABLE) { try { app.addRecentDocument(file); } catch (_) { /* the jump list shows it once the file type is registered */ } }\n        buildMenu();\n    } catch (err) {\n        console.warn("recent documents:", err.message);\n    }\n}',
            'function addRecent(file) {\n    const list = recentDocuments().filter((r) => pathKey(r.path) !== pathKey(file));\n    list.unshift({ path: file, name: path.basename(file), time: Date.now() });\n    settings.set({ recentDocuments: list.slice(0, RECENT_MAX) });\n    // a portable copy leaves no jump list entry on the PC it runs on (docs/PLAN_0_1_42.md Q22)\n    if (!PORTABLE) { try { app.addRecentDocument(file); } catch (_) { /* the jump list shows it once the file type is registered */ } }\n    buildMenu();\n}',
        )],
        "killed: quit_test main_prevents_a_close_until_the_window_saved checks try/catch in addRecent",
        {"gates": ["quit"]},
    ),
    (
        "files_mirror_path_no_bad_part",
        "electron/main/files.js",
        [(
            '    if (typeof filename !== "string" || filename === "." || filename === ".." || badPart(filename)) throw new Error("bad file name: " + filename);',
            '    if (typeof filename !== "string" || filename === "." || filename === ".." || !SAFE_NAME.test(filename)) throw new Error("bad file name: " + filename);',
        )],
        "killed: document_test content_addressed_names_and_ensure_on_server checks files.mirrorPath refuses device names",
        {"gates": ["document"]},
    ),
    (
        "files_store_no_safe_mirror_name",
        "electron/main/files.js",
        [(
            "    if (overwrite) {\n        const filename = safeMirrorName(rawName);",
            "    if (overwrite) {\n        const filename = rawName;",
        )],
        "killed: document_test content_addressed_names_and_ensure_on_server checks overwrite:true upload of aux.ttf succeeds",
        {"gates": ["document"]},
    ),
]
