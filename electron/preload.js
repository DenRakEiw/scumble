// The renderer's only door to the main process. Everything is typed-by-convention here;
// see host.js for how the editor uses it.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function on(channel, cb) {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("scumble", {
    info: () => ipcRenderer.invoke("app:info"),
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
        connect: (url) => ipcRenderer.invoke("comfy:connect", url),
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
        onOpened: (cb) => on("file:opened", cb),
    },
    files: {
        stats: () => ipcRenderer.invoke("files:stats"),
        prune: (args) => ipcRenderer.invoke("files:prune", args),
        openFolder: () => ipcRenderer.invoke("files:openFolder"),
    },
    recipes: {
        list: () => ipcRenderer.invoke("recipes:list"),
    },
    onMenu: (cb) => on("menu", cb),
});
