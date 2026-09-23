// The manual's reader: docs/MANUAL.md -> chapters (docs/PLAN_HELP.md). No DOM and no imports, so the
// same file runs in the Help panel, in Node (tools/manual_test.js) and on the website, which gets an
// exact copy of it (node tools/manual_sync.js) - one reader, so the two can never disagree about the
// shape.
//
// The shape it reads (the comment at the top of MANUAL.md says the same):
//
//   # Title of the manual
//   ## Chapter title
//   <!-- slug: chapter-slug -->
//   _One-line summary._
//   ![alt text](https://site/path.jpg "1600x946")        optional, before the paragraphs
//   Paragraphs, separated by blank lines.
//   ### Steps      1. **Title.** text
//   ### Keys       #### Group, then | key | what | rows
//   ### Notes      - text
//
// Text keeps its inline Markdown (**bold**, `code`, backslash escapes); inline() splits it into spans
// for a renderer and plain() flattens it for search and for the chat's context.

const SUBSECTIONS = ["Steps", "Keys", "Notes"];

/** Backslash escapes resolved, nothing else touched. */
function unescape(s) {
    return String(s).replace(/\\([\\`*_{}\[\]()#+\-.!<>|])/g, "$1");
}

/**
 * Inline Markdown as spans: [{ type: "text" | "code" | "strong", text }]. Only what the manual uses:
 * backslash escapes, `code` and **strong**. Nothing here is HTML; a renderer builds nodes from it.
 */
export function inline(s) {
    const out = [];
    let buf = "";
    let strong = false;
    const push = (type, text) => { if (text) out.push({ type, text }); };
    const flush = () => { push(strong ? "strong" : "text", buf); buf = ""; };
    const src = String(s);
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === "\\" && i + 1 < src.length) { buf += src[++i]; continue; }
        if (ch === "`") {
            const end = src.indexOf("`", i + 1);
            if (end > i) { flush(); push("code", src.slice(i + 1, end)); i = end; continue; }
        }
        if (ch === "*" && src[i + 1] === "*") { flush(); strong = !strong; i++; continue; }
        buf += ch;
    }
    flush();
    return out;
}

/** The text without its markup. */
export function plain(s) {
    return inline(s).map((p) => p.text).join("");
}

/** Cells of a table row, split on unescaped pipes, still carrying their inline Markdown. */
function cells(line) {
    const out = [];
    let cur = "";
    const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    for (let i = 0; i < body.length; i++) {
        if (body[i] === "\\" && i + 1 < body.length) { cur += body[i] + body[i + 1]; i++; continue; }
        if (body[i] === "|") { out.push(cur.trim()); cur = ""; continue; }
        cur += body[i];
    }
    out.push(cur.trim());
    return out;
}

/**
 * docs/MANUAL.md -> { title, chapters }. A chapter is the website's Chapter shape: { slug, title,
 * summary, body[], steps?[{title, text}], keys?[{group, rows[{key, what}]}], notes?[], shot? { src,
 * url, alt, width, height } }. Titles and summaries are plain text; body, step, key and note texts keep
 * their inline Markdown. Throws with a line number on anything outside the shape, so a malformed edit
 * fails the build instead of dropping a chapter.
 */
export function parseManual(md, { site = "" } = {}) {
    const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
    const chapters = [];
    let title = "";
    let ch = null;
    let section = "body";
    let para = [];
    let group = null;
    let item = null;                                   // the step or note a continuation line belongs to
    const fail = (n, why) => { throw new Error(`MANUAL.md line ${n + 1}: ${why}`); };
    const endPara = () => {
        if (para.length) { ch.body.push(para.join(" ")); para = []; }
    };
    for (let n = 0; n < lines.length; n++) {
        const line = lines[n];
        const t = line.trim();
        // comments: the slug, or a note to the writer (possibly over several lines)
        if (t.startsWith("<!--")) {
            let text = t;
            while (!text.includes("-->") && n + 1 < lines.length) text += "\n" + lines[++n];
            const slug = /^<!--\s*slug:\s*([a-z0-9-]+)\s*-->$/.exec(text.trim());
            if (slug) {
                if (!ch) fail(n, "a slug outside a chapter");
                if (ch.slug) fail(n, "a second slug");
                ch.slug = slug[1];
            }
            continue;
        }
        if (/^# /.test(line)) {
            if (title || ch) fail(n, "a second # title");
            title = unescape(line.slice(2).trim());
            continue;
        }
        if (/^## /.test(line)) {
            if (ch) endPara();
            ch = { slug: "", title: plain(line.slice(3).trim()), summary: "", body: [] };
            chapters.push(ch);
            section = "body";
            group = null;
            item = null;
            continue;
        }
        if (!ch) {
            if (t) fail(n, "text before the first chapter");
            continue;
        }
        if (/^### /.test(line)) {
            endPara();
            const name = line.slice(4).trim();
            if (!SUBSECTIONS.includes(name)) fail(n, `an unknown section "${name}" (${SUBSECTIONS.join(", ")})`);
            const at = SUBSECTIONS.indexOf(name);
            if (section !== "body" && SUBSECTIONS.indexOf(section) >= at) fail(n, `"${name}" after "${section}"`);
            section = name;
            if (name === "Steps") ch.steps = [];
            if (name === "Keys") ch.keys = [];
            if (name === "Notes") ch.notes = [];
            group = null;
            item = null;
            continue;
        }
        if (!t) { endPara(); item = null; continue; }
        if (section === "body") {
            if (!ch.summary && !ch.body.length && !para.length && /^_.*_$/.test(t)) {
                ch.summary = plain(t.slice(1, -1));
                continue;
            }
            const shot = /^!\[(.*)\]\((\S+)(?:\s+"(\d+)x(\d+)")?\)$/.exec(t);
            if (shot) {
                if (ch.shot) fail(n, "a second screenshot");
                const url = shot[2];
                ch.shot = { src: site && url.startsWith(site) ? url.slice(site.length) : url, url, alt: plain(shot[1]), width: +shot[3] || 0, height: +shot[4] || 0 };
                continue;
            }
            para.push(t);
            continue;
        }
        if (section === "Steps") {
            const m = /^\d+\.\s+\*\*(.+?)\*\*\s*(.*)$/.exec(t);
            if (m) {
                item = { title: plain(m[1]).replace(/\.$/, ""), text: m[2] };
                ch.steps.push(item);
            } else if (item && /^\s/.test(line)) item.text += " " + t;
            else fail(n, "a step is '1. **Title.** text'");
            continue;
        }
        if (section === "Keys") {
            if (/^#### /.test(line)) {
                group = { group: plain(line.slice(5).trim()), rows: [] };
                ch.keys.push(group);
                continue;
            }
            if (!group) fail(n, "a key row before its #### group");
            if (!t.startsWith("|")) fail(n, "the Keys section holds #### groups and tables only");
            const c = cells(t);
            if (c.length !== 2) fail(n, `a key row has two cells, not ${c.length}`);
            if (/^-+$/.test(c[0].replace(/:/g, "")) || (!group.rows.length && /^key$/i.test(plain(c[0])) && !group.header)) {
                group.header = true;                   // the header row and the rule under it
                continue;
            }
            group.rows.push({ key: c[0], what: c[1] });
            continue;
        }
        if (section === "Notes") {
            if (t.startsWith("- ")) {
                item = { text: t.slice(2) };
                ch.notes.push(item);
            } else if (item && /^\s/.test(line)) item.text += " " + t;
            else fail(n, "a note is '- text'");
            continue;
        }
    }
    if (ch) endPara();
    for (const c of chapters) {
        if (!c.slug) throw new Error(`MANUAL.md: chapter "${c.title}" has no slug`);
        if (!c.summary) throw new Error(`MANUAL.md: chapter "${c.title}" has no summary`);
        if (c.notes) c.notes = c.notes.map((x) => x.text);
        if (c.keys) for (const g of c.keys) delete g.header;
    }
    const slugs = chapters.map((c) => c.slug);
    const dup = slugs.find((s, i) => slugs.indexOf(s) !== i);
    if (dup) throw new Error(`MANUAL.md: the slug "${dup}" twice`);
    return { title, chapters };
}

/** A chapter as plain text: the chat's context and the search's haystack. */
export function chapterText(c) {
    const out = [c.title, c.summary, ...c.body.map(plain)];
    for (const s of c.steps || []) out.push(`${s.title}: ${plain(s.text)}`);
    for (const g of c.keys || []) for (const r of g.rows) out.push(`${plain(r.key)}: ${plain(r.what)}`);
    for (const x of c.notes || []) out.push(plain(x));
    return out.join("\n");
}
