// A file main granted the window (electron/main/grantedfiles.js) as a File: File › Open's file and load_image's path
// come as { name, size, token, url } instead of their bytes in one IPC message (docs/BUGS.md "Ctrl+O sends the whole
// file to the window in one message"). The fetch streams into a Blob the browser holds; the window never copies the
// bytes, and a reader slices the File as it does a dropped one. The token is released whatever happens.

/** The content type a picture's name opens as (what the window gave the bytes it was sent before). */
export function pictureType(name, { svg = true } = {}) {
    const n = String(name || "");
    if (/\.jpe?g$/i.test(n)) return "image/jpeg";
    if (/\.webp$/i.test(n)) return "image/webp";
    if (svg && /\.svg$/i.test(n)) return "image/svg+xml";
    if (/\.tiff?$/i.test(n)) return "image/tiff";
    return "image/png";
}

/** main's grant of a path (file:grant): refused in main's words, without Electron's "Error invoking remote method" prefix. */
export async function grantPath(file) {
    try {
        return await window.scumble.file.grant(String(file));
    } catch (err) {
        throw new Error(String((err && err.message) || err).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ""));
    }
}

/**
 * The File for a grant: `name` (default the grant's), `type` (default pictureType of the name). Refuses in words when the file
 * went away or changed size since the grant, or the read failed.
 */
export async function grantedFile(g, { name = null, type = null } = {}) {
    const shown = (g && g.name) || "the file";
    try {
        if (!g || !g.url) throw new Error(`could not read ${shown}: nothing was granted`);
        let res;
        try { res = await fetch(g.url, { cache: "no-store" }); } catch (err) { throw new Error(`could not read ${shown}: ${(err && err.message) || err}`); }
        if (!res.ok) {
            const said = await res.text().catch(() => "");
            // main's words: "the file is gone: <why>" (the why alone), "no such file" (the grant was dropped)
            const why = /: /.test(said) ? said.slice(said.indexOf(": ") + 2) : null;
            throw new Error(why || `could not read ${shown} (${res.status}${said ? ": " + said : ""})`);
        }
        let blob;
        try { blob = await res.blob(); } catch (err) { throw new Error(`could not read ${shown}: ${(err && err.message) || err}`); }
        if (typeof g.size === "number" && blob.size !== g.size) throw new Error(`${shown} changed while it was read (${blob.size} of ${g.size} bytes): open it again`);
        return new File([blob], name || shown, { type: type || pictureType(name || shown) });
    } finally {
        if (g && g.token) window.scumble.file.release(g.token).catch(() => { /* main is gone */ });
    }
}
