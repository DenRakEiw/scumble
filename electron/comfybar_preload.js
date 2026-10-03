// The ComfyUI window's bar (electron/main/comfyview.js, docs/PLAN_COMFY_VIEW.md §2.1): its only door to the main
// process, a few comfyview:* calls that main answers for this webContents alone. The ComfyUI page under the bar has no
// preload at all, and this one exposes nothing of window.scumble.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("comfybar", {
    // { phase: none | loading | page | error, message, url, host, target, recipe, offline }
    state: () => ipcRenderer.invoke("comfyview:state"),
    onState: (cb) => { const h = (_e, s) => cb(s); ipcRenderer.on("comfyview:state", h); return () => ipcRenderer.removeListener("comfyview:state", h); },
    reload: () => ipcRenderer.invoke("comfyview:reload"),
    // "comfy" (My ComfyUI) or "cloud" (Comfy Cloud): loaded at once, kept for the next open
    setTarget: (kind) => ipcRenderer.invoke("comfyview:target", kind),
    // the page's graph as a recipe: { asNew: false } overwrites the recipe the window holds, { asNew: true, name } makes one
    save: (opts) => ipcRenderer.invoke("comfyview:save", opts || {}),
    // Settings › ComfyUI in the main window
    openSettings: () => ipcRenderer.invoke("comfyview:settings"),
});
