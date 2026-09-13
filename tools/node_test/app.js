// Stand-in for ComfyUI's app.js: just enough graph for the node extension and the editor.
export const app = {
    graph: { _nodes: [], serialize() { return { stub: true }; }, getNodeById(id) { return this._nodes.find((n) => n.id === id) || null; }, setDirtyCanvas() {} },
    canvas: { setDirty() {} },
    extensionManager: null,
    registerExtension(ext) { (window.__exts = window.__exts || []).push(ext); },
    async queuePrompt() { window.__queued = (window.__queued || 0) + 1; },
};
