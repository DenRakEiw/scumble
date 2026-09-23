"""Help: the manual in the app, and its chat (docs/PLAN_HELP.md §7 item 5).

No ComfyUI and no API key: tools/assistant_mock.py plays the model on 127.0.0.1. First the plain-Node
layer (tools/manual_test.js: the manual parses, its reader refuses what is outside the shape, and the
manual names no shortcut, menu item or settings section the app lacks). Then, in the app:

- without any key the panel is the manual: every chapter, the contents, a line on how to get a chat,
  and no request anywhere;
- the search narrows the chapters to the ones holding every word and marks them, Enter jumps to the
  first, Escape clears it;
- a key typed into the panel never reaches the editor's shortcuts;
- with a (test) key a question goes to the model with the manual as its system text and no tools, the
  answer is rendered and its "Chapter:" line opens that chapter; a second question keeps the chat, New
  chat starts over;
- a provider's refusal shows as words in the panel, without the key.

It refuses an instance connected to ComfyUI and a profile that holds a key in any row; the key it
writes and the settings it changes are put back at the end whatever happens.

    python tools/help_test.py [out_dir]

Start the app first, offline: ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
"""
import asyncio
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402
from assistant_mock import Mock, Turn  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODEL = "anthropic:claude-sonnet-5"
ANSWER = "Hold Alt while you paint with the selection brush.\nChapter: Selecting: brush, shapes, wand, objects, words"

PRE = """(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const H = await import('./help.js');
    const { host } = await import('./editor/host.js');
    const $ = (sel) => document.querySelector('#help ' + sel);
    const $$ = (sel) => Array.from(document.querySelectorAll('#help ' + sel));
    const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await wait(50); } };
    const key = (target, k, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    const ask = async (text) => { const t = $('.hp-text'); t.value = text; key(t, 'Enter'); };
    %s
})()"""


def node_step():
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "manual_test.js")], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=120)
    tail = r.stdout.strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        raise Exception("tools/manual_test.js: " + (tail + r.stderr)[-1500:])
    return {"checks": tail.count("[ok]")}


class Gate:
    def __init__(self, c, mock):
        self.c = c
        self.mock = mock
        self.saved = None
        self.stored_key = False
        self.failures_seen = 0

    async def ev(self, body, timeout=60):
        return await self.c.eval(PRE % body, timeout=timeout)

    async def setup(self):
        out = await self.ev("""
const st = await window.scumble.comfy.status();
if (["connected", "missing-node"].includes(st.state)) throw new Error("this instance is connected to ComfyUI (" + st.state + "); the help gate runs offline only");
const had = (await window.scumble.keys.list()).keys || {};
const held = Object.keys(had).filter((k) => had[k] && had[k].set);
if (held.length) throw new Error("this profile holds keys (" + held.join(", ") + "); the help gate needs a profile without any");
const s = await window.scumble.settings.get();
if (H.helpOpen()) H.toggleHelp(false);
await window.scumble.help.reset();
return { assistant: s.assistant || null, help: s.help || null };
""")
        self.saved = out
        return {"saved": bool(out)}

    async def cleanup(self):
        out = await self.ev("""
const out = {};
try { await window.scumble.help.reset(); out.reset = true; } catch (e) { out.reset = String(e.message || e); }
const s = __SAVED__;
if (s) await window.scumble.settings.set({ assistant: s.assistant || {}, help: s.help || {} });
if (__KEY__) await window.scumble.keys.clear("anthropic");
if (H.helpOpen()) H.toggleHelp(false);
const k = (await window.scumble.keys.list()).keys || {};
out.keyLeft = !!(k.anthropic && k.anthropic.set);
return out;""".replace("__SAVED__", json.dumps(self.saved)).replace("__KEY__", "true" if self.stored_key else "false"))
        if out.get("keyLeft"):
            raise RuntimeError("the test key is still stored")
        return out

    # ---- the steps -------------------------------------------------------------------------

    async def without_a_key_the_panel_is_the_manual(self):
        before = len(self.mock.transcript())
        out = await self.ev("""
H.toggleHelp(true);
await until(() => $$('.hp-chapter').length > 0);
await wait(400);                                   // the model list comes back from main
const r = {
    open: H.helpOpen(), chapters: $$('.hp-chapter').length, links: $$('.hp-link').length,
    none: !$('.hp-none').hidden, ask: !$('.hp-ask').hidden, button: document.getElementById('shell-help').classList.contains('hp-on'),
    focus: document.activeElement === $('.hp-search'),
};
const manual = await window.scumble.help.manual();
r.inFile = (manual.match(/^## /gm) || []).length;
return r;""")
        if not (out["open"] and out["chapters"] == out["inFile"] == out["links"] and out["chapters"] >= 17 and out["none"] and not out["ask"] and out["button"] and out["focus"]):
            raise RuntimeError(json.dumps(out))
        if len(self.mock.transcript()) != before:
            raise RuntimeError("a request went out without a key")
        return out

    async def the_search_narrows_and_marks(self):
        return await self.ev("""
const s = $('.hp-search');
const all = $$('.hp-chapter').length;
s.value = 'feather selection';
s.dispatchEvent(new Event('input', { bubbles: true }));
await wait(300);
const want = H.searchManual('feather selection').map((c) => c.slug);
const shown = $$('.hp-chapter').map((c) => c.dataset.slug);
const marks = $$('.hp-hit').map((m) => m.textContent.toLowerCase());
const count = $('.hp-count').textContent;
if (JSON.stringify(shown) !== JSON.stringify(want) || !want.length || want.length >= all) throw new Error('shown ' + shown + ' against ' + want);
if (!marks.length || marks.some((m) => m !== 'feather' && m !== 'selection')) throw new Error('marks ' + marks.slice(0, 5));
if (!new RegExp('^' + want.length + ' of ' + all + ' chapters$').test(count)) throw new Error('count ' + count);
// Enter jumps to the first hit
const doc = $('.hp-doc');
doc.scrollTop = doc.scrollHeight;
key(s, 'Enter');
await wait(100);
const first = $$('.hp-chapter')[0];
const at = first.offsetTop - doc.offsetTop - doc.scrollTop;
if (Math.abs(at) > 8 && doc.scrollTop < doc.scrollHeight - doc.clientHeight - 2) throw new Error('Enter left the first hit at ' + at + ' px');
// nothing matches: a sentence, not an empty panel
s.value = 'zzqx nowhere';
s.dispatchEvent(new Event('input', { bubbles: true }));
await wait(300);
const none = { shown: $$('.hp-chapter').length, count: $('.hp-count').textContent };
if (none.shown !== 0 || !/No chapter mentions/.test(none.count)) throw new Error(JSON.stringify(none));
// Escape clears the search and every chapter is back
key(s, 'Escape');
await wait(50);
const back = { value: s.value, shown: $$('.hp-chapter').length, open: H.helpOpen() };
if (back.value !== '' || back.shown !== all || !back.open) throw new Error('Escape: ' + JSON.stringify(back));
return { hits: want, marks: marks.length, count };
""")

    async def keys_in_the_panel_never_reach_the_editor(self):
        return await self.ev("""
const ed = host.editor;
if (!ed) throw new Error('no editor');
ed.setTool('select');
key($('.hp-search'), 'e');
key($('.hp-search'), 'Delete');
const inPanel = ed.tool;
// the control: the same key outside the panel does switch the tool, so the step can fail
key(document.body, 'e');
const outside = ed.tool;
ed.setTool('select');
if (inPanel !== 'select') throw new Error('a key in the search switched the tool to ' + inPanel);
if (outside !== 'erase') throw new Error('the control failed: E outside the panel gave ' + outside);
return { inPanel, outside };
""")

    async def with_a_key_a_question_is_answered_from_the_manual(self):
        self.mock.reset()
        self.mock.push(Turn(
            expect=lambda r: (("<manual>" in (r["system"] or "") and "## Selecting: brush, shapes, wand, objects, words" in r["system"]
                               and "Answer only from the manual" in r["system"] and "<!--" not in r["system"])
                              or "the system text is not the manual") if not r["tools"] else "tools were sent: %s" % r["tools"],
            answer={"text": ANSWER}))
        self.stored_key = True
        out = await self.ev("""
await window.scumble.keys.set('anthropic', 'test-gate-anthropic-0000');
const s = await window.scumble.settings.get();
await window.scumble.settings.set({ assistant: { ...(s.assistant || {}), base: __MOCK__ }, help: { ...(s.help || {}), model: __MODEL__ } });
H.toggleHelp(false); H.toggleHelp(true);            // the picker reads the keys again on open
await until(() => !$('.hp-ask').hidden);
const picked = $('.hp-model').value;
await ask('How do I take something out of a selection?');
const answer = await until(() => $$('.hp-bubble.hp-model').find((b) => b.querySelector('.hp-read')));
const link = answer.querySelector('.hp-read');
const user = $$('.hp-bubble.hp-user').map((b) => b.textContent);
const note = $('.hp-note').textContent;
$('.hp-search').value = 'zzqx'; $('.hp-search').dispatchEvent(new Event('input', { bubbles: true })); await wait(300);
link.click();
await wait(100);
const flash = $('.hp-chapter.hp-flash');
return { picked, link: link.textContent, text: answer.textContent, user, note, flash: flash && flash.dataset.slug, search: $('.hp-search').value, send: $('.hp-send').textContent };
""".replace("__MOCK__", json.dumps(self.mock.url)).replace("__MODEL__", json.dumps(MODEL)))
        t = self.mock.transcript()
        if len(t) != 1 or t[0]["model"] != MODEL.split(":", 1)[1]:
            raise RuntimeError("requests: %s" % [(x["model"], x["path"]) for x in t])
        msgs = t[0]["messages"]
        if len(msgs) != 1 or "take something out of a selection" not in msgs[0]["text"]:
            raise RuntimeError("messages: %s" % msgs)
        if out["picked"] != MODEL or out["link"] != "Read: Selecting: brush, shapes, wand, objects, words" or out["flash"] != "selection" \
                or out["search"] != "" or "Hold Alt" not in out["text"] or out["send"] != "Ask" or "no picture" not in out["note"]:
            raise RuntimeError(json.dumps(out))
        return {"system": len(t[0]["system"]), "link": out["link"], "note": out["note"][:80]}

    async def a_second_question_keeps_the_chat_and_new_chat_starts_over(self):
        self.mock.reset()
        self.mock.push(
            Turn(expect=lambda r: len(r["messages"]) == 3 or "%d messages" % len(r["messages"]), answer={"text": "Press F1.\nChapter: Help: this manual in the app, and a chat on it"}),
            Turn(expect=lambda r: len(r["messages"]) == 1 or "a new chat carried %d messages" % len(r["messages"]), answer={"text": "fresh"}),
        )
        out = await self.ev("""
const n = () => $$('.hp-bubble.hp-model').length;
const before = n();
await ask('And how do I open this again?');
await until(() => n() > before && $$('.hp-bubble.hp-model')[n() - 1].querySelector('.hp-read'));
const second = $$('.hp-bubble.hp-model')[n() - 1].querySelector('.hp-read').textContent;
Array.from(document.querySelectorAll('#help button')).find((b) => b.textContent === 'New chat').click();
await wait(200);
const cleared = { bubbles: $$('.hp-bubble').length, hidden: $('.hp-list').hidden };
await ask('first of a new chat');
await until(() => $$('.hp-bubble.hp-model').length === 1);
return { second, cleared };
""")
        t = self.mock.transcript()
        if len(t) != 2 or self.mock.pending():
            raise RuntimeError("%d requests, %d left" % (len(t), self.mock.pending()))
        if out["second"] != "Read: Help: this manual in the app, and a chat on it" or out["cleared"] != {"bubbles": 0, "hidden": True}:
            raise RuntimeError(json.dumps(out))
        return out

    async def a_refusal_reads_as_words_without_the_key(self):
        self.mock.reset()
        self.mock.push(Turn(status=401, body={"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key test-gate-anthropic-0000"}}))
        out = await self.ev("""
const before = $$('.hp-error').length;
await ask('anything');
const err = await until(() => $$('.hp-error')[before]);
await until(() => $('.hp-send').textContent === 'Ask');
return { text: err.textContent };
""")
        if "test-gate-anthropic-0000" in out["text"] or not out["text"].strip():
            raise RuntimeError(json.dumps(out))
        return out

    async def run_step(self, name, fn):
        at = len(self.mock.failures())
        try:
            res = await fn()
            fails = self.mock.failures()[at:]
            if fails:
                raise RuntimeError("the mock says: " + "; ".join(fails))
            print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:300]), flush=True)
            return True
        except Exception as err:  # noqa: BLE001
            print("[FAIL] %s: %s" % (name, err), flush=True)
            return False


async def run_all(c):
    try:
        print("[ok] node: %s" % json.dumps(node_step()), flush=True)
    except Exception as err:  # noqa: BLE001
        print("[FAIL] node: %s" % err)
        print("FAIL")
        return False
    mock = Mock().start()
    g = Gate(c, mock)
    ok = True
    try:
        try:
            print("[ok] setup: %s" % json.dumps(await g.setup()), flush=True)
        except Exception as err:  # noqa: BLE001
            print("[FAIL] setup: %s" % err)
            g.saved = None
            print("FAIL")
            return False
        for name in ["without_a_key_the_panel_is_the_manual", "the_search_narrows_and_marks", "keys_in_the_panel_never_reach_the_editor",
                     "with_a_key_a_question_is_answered_from_the_manual", "a_second_question_keeps_the_chat_and_new_chat_starts_over",
                     "a_refusal_reads_as_words_without_the_key"]:
            if not await g.run_step(name, getattr(g, name)):
                ok = False
                break
    finally:
        try:
            print("[ok] cleanup: %s" % json.dumps(await g.cleanup()), flush=True)
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] cleanup: %s" % err)
        mock.stop()
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
