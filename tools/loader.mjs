import path from "node:path";
import { pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("/editor/")) {
        const root = path.resolve("renderer/editor");
        return {
            shortCircuit: true,
            url: pathToFileURL(path.join(root, specifier.slice("/editor/".length))).href,
        };
    }
    return nextResolve(specifier, context);
}
