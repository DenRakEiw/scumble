import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// the editor's "/editor/..." imports, mapped onto renderer/editor next to this file (not the cwd: a test run from
// another folder found nothing)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer", "editor");

export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("/editor/")) {
        return {
            shortCircuit: true,
            url: pathToFileURL(path.join(root, specifier.slice("/editor/".length))).href,
        };
    }
    return nextResolve(specifier, context);
}
