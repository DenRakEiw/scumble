// @ts-check
// Layer names from a caption (item 62, Florence-2): app-only, plain functions (tools/florence2_test.js runs them under
// plain Node). A caption such as "A woman sitting on the hood of a blue car." becomes "Woman sitting on the hood of a
// blue car"; a long one is cut at a word, at most NAME_MAX characters, without a dangling "of" or "are" at its end.

export const NAME_MAX = 40;

// openings a caption often has that say nothing about the picture
const OPENINGS = /^(?:in this (?:image|picture|photo)[, ]*(?:(?:we|i) can (?:also )?see|there (?:is|are))?|this (?:image|picture|photo) (?:shows|is of|contains)|the (?:image|picture|photo) (?:shows|contains)|an? (?:image|picture|photo|close-up|closeup) of|a close up of)\s*/i;
const ARTICLE = /^(?:a|an|the)\s+/i;
// words a cut name may not end on
const DANGLING = new Set(["a", "an", "the", "of", "on", "in", "at", "to", "with", "and", "or", "for", "from", "by", "is", "are", "was", "were", "be", "that", "which", "its", "their", "his", "her", "into", "onto", "over", "under", "near", "behind", "while", "as"]);

/** A short layer name from a caption ("" when nothing is left). */
export function shortName(caption, max = NAME_MAX) {
    let s = String(caption || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    s = s.replace(OPENINGS, "").replace(ARTICLE, "");
    // the first sentence (or clause after a semicolon) only
    s = s.split(/(?<=[a-z0-9)])[.;!?](?:\s|$)/i)[0];
    s = s.replace(/[.,;:!?\s]+$/, "").trim();
    if (!s) return "";
    let words = s.split(" ");
    if (s.length > max) {
        const out = [];
        let len = 0;
        for (const w of words) {
            if (len + (out.length ? 1 : 0) + w.length > max) break;
            out.push(w);
            len += (out.length > 1 ? 1 : 0) + w.length;
        }
        words = out.length ? out : [words[0].slice(0, max)];
    }
    while (words.length > 1 && DANGLING.has(words[words.length - 1].toLowerCase().replace(/[,;:]$/, ""))) words.pop();
    s = words.join(" ").replace(/[,;:]+$/, "");
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// what names a layer only by where it came from: the editor's own names, a camera's or a phone's file names, a
// clipboard's, a hash
const GENERIC_WORDS = /\b(?:result|paste|pasted|copy|layer|image|img|pic|picture|photo|clipboard|screenshot|screen|shot|capture|untitled|download|downloaded|file|scan|export|output|generated|comfyui|temp|tmp|new|reference|ref|dsc|dscn|dscf|dcim|pxl|mvimg|whatsapp|signal|telegram|frame|unknown|final|merged|visible)\b/gi;

/**
 * Whether a layer's name says nothing of its content, so an automatic name may replace it: "Result 3", "Paste 2",
 * "Result 3 copy", "image", "IMG_2041", "Screenshot 2026-11-16 at 07.12", "3f2a9c0e41d7": only the listed words,
 * digits, separators and hashes. "jacket", "anna_face", "me" or a single CJK character are kept.
 */
export function isGenericName(name) {
    const s = String(name || "").trim();
    if (!s) return true;
    // a hash or an id: long hex or a uuid
    if (/^[0-9a-f]{8,}$/i.test(s.replace(/[-_\s]/g, ""))) return true;
    const rest = s.replace(/[_\-.0-9]+/g, " ").replace(GENERIC_WORDS, " ").replace(/\b(?:at|am|pm|from)\b/gi, " ").replace(/[0-9\s()[\]#,:+]+/g, " ").trim();
    // nothing but the listed words, digits and separators
    return !/[\p{L}\p{N}]/u.test(rest);
}
