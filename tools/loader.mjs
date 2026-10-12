import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// the editor's "/editor/..." imports, mapped onto renderer/editor next to this file (not the cwd: a test run from
// another folder found nothing); "/plugins/<id>/<file>?v=..." (renderer/plugins.js load()) onto plugins/, the query
// kept (a fresh module instance per load, as in the app)
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "renderer", "editor");
const pluginsRoot = path.join(here, "..", "plugins");

export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("/editor/")) {
        return {
            shortCircuit: true,
            url: pathToFileURL(path.join(root, specifier.slice("/editor/".length))).href,
        };
    }
    if (specifier.startsWith("/plugins/")) {
        const q = specifier.indexOf("?");
        const rel = decodeURIComponent(specifier.slice("/plugins/".length, q < 0 ? undefined : q));
        return {
            shortCircuit: true,
            url: pathToFileURL(path.join(pluginsRoot, rel)).href + (q < 0 ? "" : specifier.slice(q)),
        };
    }
    return nextResolve(specifier, context);
}
