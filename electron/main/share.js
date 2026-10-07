// The star and share links (item 40, docs/PLAN_0_1_43.md S2): the Help menu, Settings › About and the quiet line after
// an update all read from here. The shared link is the GitHub repo (the user, 2026-10-07: "wenn dann den github sharen
// nicht die webseite"); no UTM or tracking parameter goes along. Plain Node: tools/share_test.js.
"use strict";

const REPO = "https://github.com/DenRakEiw/scumble";
const LINE = "Scumble: a free, open-source editor for AI inpainting";
// the user's wording of 2026-10-07 (CLAUDE.md item 40)
const STAR_NOTE = "⭐ If Scumble is useful to you, consider starring the repo — it helps the project get discovered.";

const enc = encodeURIComponent;
// each platform's own share page, opened in the browser with the line and the link
const TARGETS = [
    { id: "x", label: "X", url: () => `https://x.com/intent/tweet?text=${enc(LINE)}&url=${enc(REPO)}` },
    { id: "linkedin", label: "LinkedIn", url: () => `https://www.linkedin.com/sharing/share-offsite/?url=${enc(REPO)}` },
    { id: "bluesky", label: "Bluesky", url: () => `https://bsky.app/intent/compose?text=${enc(`${LINE} ${REPO}`)}` },
    { id: "reddit", label: "Reddit", url: () => `https://www.reddit.com/submit?url=${enc(REPO)}&title=${enc(LINE)}` },
];

/** The text Copy link puts on the clipboard. */
function copyText() {
    return `${LINE} ${REPO}`;
}

/** The share page of a target id, or null for an unknown one. */
function urlFor(id) {
    const t = TARGETS.find((x) => x.id === id);
    return t ? t.url() : null;
}

/**
 * Whether this start shows the star line, and the version to record. `seen` is the last version that showed it (or was
 * recorded), `current` this one, `existing` whether the profile was used before (a fresh install records the version
 * and shows nothing; an install that only lacks the key, as every one before 0.1.43, counts as updated). Nothing is
 * shown or recorded where no one would see the line (`quiet`: headless, an agent's instance).
 */
function versionNote({ seen, current, existing, quiet }) {
    if (!current || quiet) return { show: false, record: null };
    if (seen === current) return { show: false, record: null };
    if (!seen && !existing) return { show: false, record: current };
    return { show: true, record: current };
}

module.exports = { REPO, LINE, STAR_NOTE, TARGETS: TARGETS.map(({ id, label }) => ({ id, label })), copyText, urlFor, versionNote };
