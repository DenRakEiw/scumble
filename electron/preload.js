// The renderer's only door to the main process. Everything is typed-by-convention here;
// see host.js for how the editor uses it.
"use strict";

const { contextBridge, ipcRenderer, webFrame } = require("electron");

function on(channel, cb) {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("scumble", {
    info: () => ipcRenderer.invoke("app:info"),
    // memory (docs/PHASE6_PLAN.md step 1a): the process table from main plus what this
    // renderer can say about itself. All sizes are KB.
    metrics: async () => ({
        ...(await ipcRenderer.invoke("app:metrics")),
        renderer: {
            process: await process.getProcessMemoryInfo(),   // { residentSet, private, shared }
            blink: process.getBlinkMemoryInfo(),             // { allocated, total }
            heap: process.getHeapStatistics(),
            resources: webFrame.getResourceUsage(),          // images / fonts / other: { count, size, liveSize }
        },
    }),
    openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
    settings: {
        get: () => ipcRenderer.invoke("settings:get"),
        set: (patch) => ipcRenderer.invoke("settings:set", patch),
    },
    state: {
        load: () => ipcRenderer.invoke("state:load"),
        save: (state) => ipcRenderer.invoke("state:save", state),
    },
    comfy: {
        connect: (conn) => ipcRenderer.invoke("comfy:connect", conn),
        probe: (conn) => ipcRenderer.invoke("comfy:probe", conn),
        disconnect: () => ipcRenderer.invoke("comfy:disconnect"),
        status: () => ipcRenderer.invoke("comfy:status"),
        clientId: () => ipcRenderer.invoke("comfy:clientId"),
        ensure: (refs) => ipcRenderer.invoke("comfy:ensure", refs),
        onEvent: (cb) => on("comfy:event", cb),
        onStatus: (cb) => on("comfy:status", cb),
    },
    file: {
        open: () => ipcRenderer.invoke("file:open"),
        save: (args) => ipcRenderer.invoke("file:save", args),
        read: (file) => ipcRenderer.invoke("file:read", file),
        onOpened: (cb) => on("file:opened", cb),
    },
    files: {
        stats: () => ipcRenderer.invoke("files:stats"),
        prune: (args) => ipcRenderer.invoke("files:prune", args),
        openFolder: () => ipcRenderer.invoke("files:openFolder"),
    },
    recipes: {
        list: () => ipcRenderer.invoke("recipes:list"),
        import: (file) => ipcRenderer.invoke("recipes:import", file),
        remove: (id) => ipcRenderer.invoke("recipes:remove", id),
        openFolder: () => ipcRenderer.invoke("recipes:openFolder"),
    },
    keys: {
        list: () => ipcRenderer.invoke("keys:list"),
        set: (name, value) => ipcRenderer.invoke("keys:set", { name, value }),
        clear: (name) => ipcRenderer.invoke("keys:clear", name),
    },
    providers: {
        list: () => ipcRenderer.invoke("providers:list"),
        edit: (request) => ipcRenderer.invoke("provider:edit", request),
    },
    llm: {
        list: () => ipcRenderer.invoke("llm:list"),
        ask: (req) => ipcRenderer.invoke("llm:ask", req),
        models: (url) => ipcRenderer.invoke("llm:models", url),
    },
    helpers: {
        status: () => ipcRenderer.invoke("helpers:status"),
        configure: (patch) => ipcRenderer.invoke("helpers:configure", patch),
        browseDir: () => ipcRenderer.invoke("helpers:browseDir"),
        openFolder: () => ipcRenderer.invoke("helpers:openFolder"),
        download: (id) => ipcRenderer.invoke("helpers:download", id),
        cancel: (id) => ipcRenderer.invoke("helpers:cancel", id),
        remove: (id) => ipcRenderer.invoke("helpers:remove", id),
        free: () => ipcRenderer.invoke("helpers:free"),
        objects: (req) => ipcRenderer.invoke("helpers:objects", req),
        segment: (req) => ipcRenderer.invoke("helpers:segment", req),
        cutout: (req) => ipcRenderer.invoke("helpers:cutout", req),
        onProgress: (cb) => on("helpers:progress", cb),
    },
    plugins: {
        list: () => ipcRenderer.invoke("plugins:list"),
        setEnabled: (id, enabled) => ipcRenderer.invoke("plugins:setEnabled", { id, enabled }),
        openFolder: () => ipcRenderer.invoke("plugins:openFolder"),
        menu: (actions) => ipcRenderer.invoke("plugins:menu", actions),
        getData: (id) => ipcRenderer.invoke("plugins:getData", id),
        setData: (id, patch) => ipcRenderer.invoke("plugins:setData", { id, patch }),
    },
    // the command bridge (electron/main/bridge.js): main asks, the renderer runs commands.call
    commands: {
        onRequest: (cb) => on("commands:request", cb),
        reply: (payload) => ipcRenderer.send("commands:reply", payload),
        ready: () => ipcRenderer.send("commands:ready"),
        changed: () => ipcRenderer.send("commands:changed"),
    },
    updates: {
        status: () => ipcRenderer.invoke("update:status"),
        check: () => ipcRenderer.invoke("update:check"),
        install: () => ipcRenderer.invoke("update:install"),
        onStatus: (cb) => on("update:status", cb),
    },
    onMenu: (cb) => on("menu", cb),
});
