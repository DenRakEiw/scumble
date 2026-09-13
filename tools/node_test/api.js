// Stand-in for ComfyUI's api.js: uploads are kept in memory and /view serves them as blob URLs.
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
            return new Response(JSON.stringify({ name, subfolder: init.body.get("subfolder") || "", type: init.body.get("type") || "input" }), { status: 200 });
        }
        if (p.startsWith("/view?")) {
            const name = new URLSearchParams(p.slice(6)).get("filename");
            if (files.has(name)) return new Response(files.get(name), { status: 200 });
        }
        return fetch(p, init);
    },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    async queuePrompt() { return { prompt_id: "stub" }; },
};
