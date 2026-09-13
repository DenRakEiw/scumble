// Stand-in for ComfyUI's api.js: uploads are kept in memory and /view serves them as blob URLs.
// `__emit(type, detail)` plays a websocket event (the bridge's "inpaint_canvas.command"), and the
// bridge's answers to /inpaint_canvas/reply are kept in `window.__replies`.
const listeners = {};
const files = new Map();
const urls = new Map();
export const api = {
    clientId: "stub",
    apiURL(p) {
        if (p.startsWith("/view?")) {
            const name = new URLSearchParams(p.slice(6)).get("filename");
            if (files.has(name)) { if (!urls.has(name)) urls.set(name, URL.createObjectURL(files.get(name))); return urls.get(name); }
        }
        return p;
    },
    async fetchApi(p, init) {
        if (p.startsWith("/upload/image") || p.startsWith("/upload/mask")) {
            const f = init.body.get("image");
            let name = f.name;
            if (files.has(name) && init.body.get("overwrite") !== "true") name = name.replace(/(\.\w+)$/, ` (${files.size})$1`);
            files.set(name, f); urls.delete(name);
            (window.__uploads = window.__uploads || []).push({ name, type: init.body.get("type") || "input" });
            return new Response(JSON.stringify({ name, subfolder: init.body.get("subfolder") || "", type: init.body.get("type") || "input" }), { status: 200 });
        }
        if (p.startsWith("/view?")) {
            const name = new URLSearchParams(p.slice(6)).get("filename");
            if (files.has(name)) return new Response(files.get(name), { status: 200 });
        }
        if (p.startsWith("/inpaint_canvas/reply")) {
            (window.__replies = window.__replies || []).push(JSON.parse(init.body));
            return new Response("{}", { status: 200 });
        }
        return fetch(p, init);
    },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    __emit(t, detail) { for (const fn of listeners[t] || []) fn({ detail }); },
    async queuePrompt() { return { prompt_id: "stub" }; },
};
