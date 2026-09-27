"""The canvas-only view (CLAUDE.md item 24, docs/PLAN_0_1_31.md step 1): Tab hides the app's chrome and the picture
fills the screen; Tab again or Escape comes back.

No ComfyUI, no key. Real key presses go through CDP (Input.dispatchKeyEvent), not synthetic dispatchEvent. Steps:

- setup: an offline instance only; a new 1600 x 1000 document with a filled paint layer; the mode off, the window
  not full screen; the feature's API present (shell.js canvasOnly / isCanvasOnly, window.scumble.window
  setFullScreen / isFullScreen / onFullScreenChange);
- Tab enters (from a zoomed view with the rulers on): the body class, the hint "Tab or Esc to return", #shell-bar,
  #shell-tabs and the editor's .ipc-top / .ipc-tools / .ipc-side / .ipc-bottom / every .ipc-subbar at display
  none, the view the size of the window, the window full screen, the rulers off, the picture fitted (angle 0);
- Tab again leaves: the view (every field of ed.view), _fitted, the rulers, the chrome and the window put back,
  localStorage ipc.rulers never touched;
- Tab does nothing in the prompt textarea, inside an open <dialog>, while the editor's ask is open, or with Shift;
- Escape first cancels what the editor has pending (a rotate transform, then an open polygon, then a pending canvas
  frame) and the mode stays;
  with nothing pending Escape leaves and the editor never sees it (no "Nothing to cancel.");
- a full-screen exit from outside (setFullScreen(false)) ends the mode and restores the view;
- a window that was full screen before the enter stays full screen after the leave;
- a switch to another tab ends the mode and restores the first tab's view (a rotated one too);
- closing the active tab ends the mode.

The cleanup puts back whatever the steps changed (the mode, full screen, localStorage ipc.rulers / ipc.pane, the
test's documents, the tab that was active) whatever happens. Normal tier: run it on the tiles backend.

    python tools/canvasonly_test.py

Start the app first, offline: ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
(or bash tools/run_gates.sh <label> --offline canvasonly). The test takes the window full screen and back.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

KEYS = {"Tab": 9, "Escape": 27}
SHIFT = 8          # CDP modifier bit
MARK = "canvas-only gate: nothing pending"

# Every step's page code runs inside this wrapper. Waits poll with setTimeout (rAF stops in a hidden window).
PRE = """(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms, what) => {
        const t0 = Date.now();
        for (;;) {
            let v = null;
            try { v = await fn(); } catch (_) { v = null; }
            if (v) return v;
            if (Date.now() - t0 > ms) throw new Error('timed out after ' + ms + ' ms waiting for ' + what);
            await wait(25);
        }
    };
    const soft = async (fn, ms, what) => { try { await until(fn, ms, what); return true; } catch (_) { return false; } };
    const S = await import('./shell.js');
    const { host } = await import('./editor/host.js');
    const { commands } = await import('./commands.js');
    const W = (window.scumble && window.scumble.window) || null;
    const co = window.__co || (window.__co = { docs: [] });
    const ed = co.ed || null;
    const MARK = __MARK__;
    const isOn = () => !!(typeof S.isCanvasOnly === 'function' && S.isCanvasOnly());
    const fs = async () => !!(W && typeof W.isFullScreen === 'function' && await W.isFullScreen());
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
    const lsPut = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* no storage */ } };
    const who = (el) => !el ? null : el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
        + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(' ').filter(Boolean).join('.') : '');
    const viewOf = (e) => ({ ...e.view });
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
    const fillsWindow = (e) => {
        const r = e.viewEl.getBoundingClientRect();
        return Math.abs(r.left) <= 1 && Math.abs(r.top) <= 1 && Math.abs(r.width - innerWidth) <= 1 && Math.abs(r.height - innerHeight) <= 1;
    };
    // what the fit looks like (reported, not judged: the spec's "fitted" is _fitted === true and angle 0)
    const fitInfo = (e) => {
        const r = e.viewEl.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
        const cw = e.canvas.width, ch = e.canvas.height;
        const fitScale = Math.max(0.01, Math.min((cw - 48) / e.width, (ch - 48) / e.height));
        return { canvas: [cw, ch], view: [Math.round(r.width * dpr), Math.round(r.height * dpr)], sized: cw === Math.round(r.width * dpr) && ch === Math.round(r.height * dpr),
            scale: e.view.scale, fitScale, fitted: e._fitted, angle: e.view.angle };
    };
    // the window's size, the view's box and the canvas backing unchanged for 300 ms: a full-screen change and the
    // ResizeObserver refit after it are over
    const settle = async (e) => {
        let last = '', same = 0;
        return soft(() => {
            const r = e.viewEl.getBoundingClientRect();
            const sig = [innerWidth, innerHeight, r.left, r.top, r.width, r.height, e.canvas.width, e.canvas.height].join(',');
            if (sig === last) same += 1; else { same = 0; last = sig; }
            return same >= 12;
        }, 6000, 'the layout to settle');
    };
    const chrome = (e) => {
        const out = [];
        for (const id of ['shell-bar', 'shell-tabs']) out.push(['#' + id, document.getElementById(id)]);
        for (const cls of ['ipc-top', 'ipc-tools', 'ipc-side', 'ipc-bottom', 'ipc-subbar']) {
            const list = Array.from(e.root.querySelectorAll('.' + cls));
            if (!list.length && cls !== 'ipc-subbar') out.push(['.' + cls, null]);
            list.forEach((el, i) => out.push(['.' + cls + '[' + i + ']', el]));
        }
        return out;
    };
    const displays = (e) => Object.fromEntries(chrome(e).map(([n, el]) => [n, el ? getComputedStyle(el).display : 'missing']));
    const columns = () => Object.fromEntries(['help', 'assistant'].map((id) => {
        const el = document.getElementById(id);
        return [id, el ? { open: !!el.open, display: getComputedStyle(el).display } : null];
    }));
    const hintState = () => {
        const h = document.getElementById('shell-canvas-hint');
        return h ? { text: (h.textContent || '').trim(), display: getComputedStyle(h).display, hidden: !!h.hidden, opacity: getComputedStyle(h).opacity } : null;
    };
    const hintGone = () => { const h = document.getElementById('shell-canvas-hint'); return !h || !h.isConnected || h.hidden || getComputedStyle(h).display === 'none'; };
    const snap = async (e) => ({ view: viewOf(e), fitted: e._fitted, rulers: e.showRulers, ls: lsGet('ipc.rulers'), displays: displays(e), rect: rectOf(e.viewEl), fullScreen: await fs() });
    // the mode turned on (the hint is read at once: it may fade), then full screen and the refit
    const waitOn = async (e) => {
        let got;
        try { got = await until(() => (isOn() ? { at: hintState() } : null), 3000, 'isCanvasOnly() to turn true'); }
        catch (err) { throw new Error(err.message + ' (focus on ' + who(document.activeElement) + ', status "' + e.status + '")'); }
        await soft(fs, 5000, 'full screen');
        await settle(e);
        await soft(() => fillsWindow(e) && e._fitted === true, 2000, 'the view to fill the window');
        return got.at;
    };
    const waitOff = async (e, fullScreen) => {
        try { await until(() => !isOn(), 5000, 'isCanvasOnly() to turn false'); }
        catch (err) { throw new Error(err.message + ' (focus on ' + who(document.activeElement) + ', status "' + (e && e.status) + '")'); }
        await soft(async () => (await fs()) === fullScreen, 5000, 'the full-screen state');
        if (e) await settle(e);
    };
    const onProblems = async (e, b) => {
        const p = [];
        if (!isOn()) p.push('isCanvasOnly() is false');
        if (!document.body.classList.contains('shell-canvas-only')) p.push('the body has no class shell-canvas-only');
        for (const [n, d] of Object.entries(displays(e))) if (d !== 'none') p.push(n + ' is display ' + d);
        if (!fillsWindow(e)) p.push('the view is ' + JSON.stringify(rectOf(e.viewEl)) + ' in a window of ' + innerWidth + ' x ' + innerHeight);
        if (!(await fs())) p.push('the window is not full screen');
        if (e.showRulers !== false) p.push('showRulers is ' + e.showRulers);
        if (e._fitted !== true) p.push('_fitted is ' + e._fitted);
        if (e.view.angle !== 0) p.push('view.angle is ' + e.view.angle);
        if (b && lsGet('ipc.rulers') !== b.ls) p.push('localStorage ipc.rulers is ' + lsGet('ipc.rulers') + ', was ' + b.ls);
        return p;
    };
    const sameView = (a, b) => {
        const bad = [];
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) bad.push('view.' + k + ' is ' + a[k] + ', was ' + b[k]);
        return bad;
    };
    const offProblems = async (e, b, fullScreen) => {
        const p = [];
        if (isOn()) p.push('isCanvasOnly() is still true');
        if (document.body.classList.contains('shell-canvas-only')) p.push('the body still has the class shell-canvas-only');
        if (!hintGone()) p.push('the hint is still shown: ' + JSON.stringify(hintState()));
        const d = displays(e);
        for (const k of Object.keys(b.displays)) if (d[k] !== b.displays[k]) p.push(k + ' is display ' + d[k] + ', was ' + b.displays[k]);
        p.push(...sameView(viewOf(e), b.view));
        if (e._fitted !== b.fitted) p.push('_fitted is ' + e._fitted + ', was ' + b.fitted);
        if (e.showRulers !== b.rulers) p.push('showRulers is ' + e.showRulers + ', was ' + b.rulers);
        if (lsGet('ipc.rulers') !== b.ls) p.push('localStorage ipc.rulers is ' + lsGet('ipc.rulers') + ', was ' + b.ls);
        if ((await fs()) !== fullScreen) p.push(fullScreen ? 'the window left full screen' : 'the window is still full screen');
        return p;
    };
    const fail = (where, p, out) => { throw new Error(where + ': ' + p.join('; ') + ' | ' + JSON.stringify(out)); };
    __BODY__
})()"""

SETUP = """
const st = await window.scumble.comfy.status();
if (['connected', 'missing-node'].includes(st.state)) throw new Error('this instance is connected to ComfyUI (' + st.state + '); the canvas-only gate runs offline only');
const missing = [];
if (typeof S.canvasOnly !== 'function') missing.push('canvasOnly() in shell.js');
if (typeof S.isCanvasOnly !== 'function') missing.push('isCanvasOnly() in shell.js');
for (const f of ['setFullScreen', 'isFullScreen', 'onFullScreenChange']) if (!W || typeof W[f] !== 'function') missing.push('window.scumble.window.' + f);
if (missing.length) throw new Error('the feature is not there: ' + missing.join(', ') + ' missing');
for (const k of Object.keys(co)) delete co[k];
Object.assign(co, { docs: [], prevId: host.editor ? host.editor.node.id : null, ls0: lsGet('ipc.rulers'), pane0: lsGet('ipc.pane') });
if (isOn()) await S.canvasOnly(false);
if (await fs()) { await W.setFullScreen(false); await until(async () => !(await fs()), 5000, 'the window to leave full screen'); }
const e = S.newDocument();
co.docs.push(e.node.id);
co.ed = e;
S.activate(e);
const doc = e.node.id;
await commands.run('new_canvas', { width: 1600, height: 1000, doc });
const L = await commands.run('add_paint_layer', { name: 'canvas-only gate', doc });
co.layer = L.id;
await commands.run('set_active_layer', { layer: L.id, doc });
await commands.run('select_rect', { x: 400, y: 250, w: 800, h: 500, doc });
const c0 = e.color;
e.color = '#c04030';
e.fillSelection();
e.color = c0;
await commands.run('select_none', { doc });
e.setTool('select');
co.edRulers0 = e.showRulers;
await settle(e);
if (!e.base || e.width !== 1600 || e.height !== 1000) throw new Error('the canvas is ' + e.width + ' x ' + e.height);
if (host.editor !== e) throw new Error('the new document is not the active one');
return { doc, size: [e.width, e.height], layers: e.layers.length, window: [innerWidth, innerHeight], fullScreen: await fs(), rulers: co.ls0, columns: columns() };
"""

# ---- 2 / 3: Tab enters, Tab leaves -------------------------------------------------------------------------------

ENTER_PREP = """
if (!ed) throw new Error('no test document (the setup failed?)');
if (isOn()) throw new Error('the mode is on before the step');
if (host.editor !== ed) S.activate(ed);
ed.zoomTo(3);
if (!ed.showRulers) ed.toggleRulers();   // the user's way: its button follows (the view reads it on the way out); the cleanup puts localStorage back
ed.draw();
ed.root.focus({ preventScroll: true });
co.before = await snap(ed);
if (co.before.fitted !== false || co.before.fullScreen) throw new Error('the step could not set up its view: ' + JSON.stringify(co.before));
return { view: co.before.view, rect: co.before.rect, ls: co.before.ls, focus: who(document.activeElement) };
"""

ENTER_CHECK = """
const b = co.before;
const hint = await waitOn(ed);
const p = await onProblems(ed, b);
if (!hint || !String(hint.text || '').includes('Tab or Esc to return')) p.push('the hint at the enter: ' + JSON.stringify(hint));
const out = { hint, view: viewOf(ed), fit: fitInfo(ed), window: [innerWidth, innerHeight], columns: columns(), focus: who(document.activeElement) };
if (p.length) fail('while on', p, out);
return out;
"""

LEAVE_CHECK = """
const b = co.before;
await waitOff(ed, false);
const p = await offProblems(ed, b, false);
const out = { view: viewOf(ed), rect: rectOf(ed.viewEl), rectBefore: b.rect, focus: who(document.activeElement) };
if (p.length) fail('after the leave', p, out);
return out;
"""

# ---- 4: Tab that must do nothing ---------------------------------------------------------------------------------

NOTHING = """
await wait(600);             // a mode that turned on would show by now
const p = [];
if (isOn()) p.push('isCanvasOnly() turned true');
if (document.body.classList.contains('shell-canvas-only')) p.push('the body got the class shell-canvas-only');
if (await fs()) p.push('the window went full screen');
const focus = who(document.activeElement);
{
__RESTORE__
}
if (p.length) {
    try { if (isOn()) await S.canvasOnly(false); if (await fs()) await W.setFullScreen(false); } catch (_) { /* the cleanup tries again */ }
    fail(__CASE__, p, { focus });
}
return { focus };
"""

NOTHING_CASES = [
    ("in_the_prompt_textarea", """
if (isOn()) throw new Error('the mode is on before the case');
co.pane = Object.keys(ed.panes).find((k) => !ed.panes[k].hidden) || 'image';
ed.showPane('gen');
const det = ed.promptInput.closest('details');
co.detOpen = det ? det.open : null;
if (det) det.open = true;
ed.promptInput.focus();
if (document.activeElement !== ed.promptInput) throw new Error('the prompt textarea did not take the focus: ' + who(document.activeElement));
return { focus: who(document.activeElement) };
""", """
ed.promptInput.blur();
const det = ed.promptInput.closest('details');
if (det && co.detOpen != null) det.open = co.detOpen;
ed.showPane(co.pane || 'image');
ed.root.focus({ preventScroll: true });
""", 0),
    ("inside_an_open_dialog", """
if (isOn()) throw new Error('the mode is on before the case');
const dlg = document.createElement('dialog');
dlg.id = 'canvasonly-gate-dialog';
const btn = document.createElement('button');
btn.type = 'button';
btn.textContent = 'a button in a dialog';
dlg.appendChild(btn);
document.body.appendChild(dlg);
co.dialog = dlg;
dlg.showModal();
btn.focus();
if (document.activeElement !== btn) throw new Error('the button in the dialog did not take the focus: ' + who(document.activeElement));
return { focus: who(document.activeElement) };
""", """
if (co.dialog) { try { co.dialog.close(); } catch (_) { /* closed */ } co.dialog.remove(); co.dialog = null; }
ed.root.focus({ preventScroll: true });
""", 0),
    ("while_the_editor_asks", """
if (isOn()) throw new Error('the mode is on before the case');
ed.askOpen = document.createElement('div');     // the editor's ask() modal counts as open while askOpen is set
co.askFaked = true;
ed.root.focus({ preventScroll: true });
return { focus: who(document.activeElement) };
""", """
ed.askOpen = null;
co.askFaked = false;
ed.root.focus({ preventScroll: true });
""", 0),
    ("with_shift", """
if (isOn()) throw new Error('the mode is on before the case');
ed.root.focus({ preventScroll: true });
return { focus: who(document.activeElement) };
""", """
ed.root.focus({ preventScroll: true });
""", SHIFT),
]

# ---- 5: Escape cancels what is pending first ---------------------------------------------------------------------

ESC_PREP = """
if (isOn()) throw new Error('the mode is on before the step');
await commands.run('set_active_layer', { layer: co.layer, doc: ed.node.id });
ed.setTool('transform');
ed.zoomTo(1.5);
ed.root.focus({ preventScroll: true });
co.before = await snap(ed);
return { tool: ed.tool, active: ed.activeLayerId, view: co.before.view };
"""

ESC_MAKE_PENDING = """
await waitOn(ed);
const p0 = await onProblems(ed, co.before);
if (p0.length) fail('entering with the transform tool', p0, { fit: fitInfo(ed) });
ed.setTransformMode('rotate');
if (!ed.pending) throw new Error('setTransformMode("rotate") left no pending transform (active layer ' + ed.activeLayerId + ', status "' + ed.status + '")');
ed.root.focus({ preventScroll: true });
return { pending: ed.pending.mode };
"""

ESC_AFTER_TRANSFORM = """
await soft(() => !ed.pending, 2000, 'the transform to be cancelled');
await wait(500);             // a mode that ended late would show by now
const p = [];
if (ed.pending) p.push('the pending transform is still there');
if (!isOn()) p.push('the mode ended: this Escape belonged to the pending transform');
if (!document.body.classList.contains('shell-canvas-only')) p.push('the body class is gone');
if (!(await fs())) p.push('the window left full screen');
if (p.length) fail('the Escape on the transform', p, { status: ed.status });
const status = ed.status;
// the next thing to cancel: an open polygon
ed.setTool('polygon');
ed.polyPoints = [[300, 300], [700, 320], [520, 640]];
ed.draw();
ed.root.focus({ preventScroll: true });
return { status };
"""

ESC_AFTER_POLYGON = """
await soft(() => !ed.polyPoints, 2000, 'the polygon to be cancelled');
await wait(500);
const p = [];
if (ed.polyPoints) p.push('the open polygon is still there');
if (!isOn()) p.push('the mode ended: this Escape belonged to the open polygon');
if (!(await fs())) p.push('the window left full screen');
if (p.length) fail('the Escape on the polygon', p, { status: ed.status });
const status = ed.status;
// the next thing to cancel: a pending canvas frame (PLAN_0_1_31 §7, 23b)
ed.setTool('canvas');
ed.setFrame({ x: 0, y: 0, w: ed.width - 100, h: ed.height });
if (!ed.framePending()) throw new Error('setFrame left no pending frame');
ed.root.focus({ preventScroll: true });
return { status };
"""

ESC_AFTER_FRAME = """
await soft(() => !ed.framePending(), 2000, 'the frame to be reset');
await wait(500);
const p = [];
if (ed.framePending()) p.push('the pending frame is still there');
if (!isOn()) p.push('the mode ended: this Escape belonged to the pending frame');
if (!(await fs())) p.push('the window left full screen');
if (p.length) fail('the Escape on the frame', p, { status: ed.status });
const status = ed.status;
ed.setTool('transform');
ed.setTransformMode('scale');
if (ed.pending) ed.cancelPending();
ed.setStatus(MARK);
ed.root.focus({ preventScroll: true });
return { status };
"""

ESC_LEAVES = """
try { await waitOff(ed, false); } catch (err) { fail('the Escape with nothing pending', [String(err.message || err)], { status: ed.status, pending: !!ed.pending }); }
const p = await offProblems(ed, co.before, false);
if (ed.status === 'Nothing to cancel.') p.push('the editor saw the Escape that ended the mode (its status says "Nothing to cancel.")');
const out = { status: ed.status, view: viewOf(ed) };
ed.setTool('select');
if (p.length) fail('after the leave', p, out);
return out;
"""

# ---- 6: a full-screen exit from outside --------------------------------------------------------------------------

OUTSIDE = """
if (isOn()) throw new Error('the mode is on before the step');
ed.zoomTo(0.5);
ed.root.focus({ preventScroll: true });
co.before = await snap(ed);
const answered = await S.canvasOnly(true);
await waitOn(ed);
let p = await onProblems(ed, co.before);
if (answered !== true) p.push('canvasOnly(true) answered ' + JSON.stringify(answered));
if (p.length) fail('entering by canvasOnly(true)', p, { fit: fitInfo(ed) });
const setAnswer = await W.setFullScreen(false);
await waitOff(ed, false);
p = await offProblems(ed, co.before, false);
const out = { canvasOnly: answered, setFullScreen: setAnswer, view: viewOf(ed) };
if (p.length) fail('after setFullScreen(false)', p, out);
return out;
"""

# ---- 7: full screen before the enter stays -----------------------------------------------------------------------

ALREADY = """
if (isOn()) throw new Error('the mode is on before the step');
const setAnswer = await W.setFullScreen(true);
await until(fs, 5000, 'setFullScreen(true) to take the window full screen');
await settle(ed);
ed.zoomTo(2);
co.before = await snap(ed);
const on = await S.canvasOnly(true);
await waitOn(ed);
let p = await onProblems(ed, co.before);
if (on !== true) p.push('canvasOnly(true) answered ' + JSON.stringify(on));
if (p.length) fail('entering in full screen', p, { fit: fitInfo(ed) });
const off = await S.canvasOnly(false);
await until(() => !isOn(), 5000, 'isCanvasOnly() to turn false');
// the window was full screen before the enter: it has to stay so; watch it for a while
let dropped = false;
const t0 = Date.now();
while (Date.now() - t0 < 1500) { if (!(await fs())) { dropped = true; break; } await wait(50); }
await settle(ed);
p = await offProblems(ed, co.before, true);
if (dropped && !p.some((x) => x.includes('left full screen'))) p.push('the window left full screen for a moment after the leave');
if (off !== false) p.push('canvasOnly(false) answered ' + JSON.stringify(off));
const out = { setFullScreen: setAnswer, canvasOnly: [on, off], view: viewOf(ed) };
await W.setFullScreen(false);
if (!(await soft(async () => !(await fs()), 5000, 'setFullScreen(false)'))) p.push('setFullScreen(false) did not end the full screen');
await settle(ed);
if (p.length) fail('after the leave', p, out);
return out;
"""

# ---- 8: a tab switch, then closing the active tab ----------------------------------------------------------------

SWITCH = """
if (isOn()) throw new Error('the mode is on before the step');
const e2 = S.newDocument();
co.docs.push(e2.node.id);
co.ed2 = e2;
await commands.run('new_canvas', { width: 640, height: 480, doc: e2.node.id });
S.activate(ed);
await settle(ed);
ed.zoomTo(2);
ed.rotateView(Math.PI / 12);
co.before = await snap(ed);
if (!co.before.view.angle) throw new Error('rotateView left the angle at ' + co.before.view.angle);
const on = await S.canvasOnly(true);
await waitOn(ed);
let p = await onProblems(ed, co.before);
if (on !== true) p.push('canvasOnly(true) answered ' + JSON.stringify(on));
if (p.length) fail('entering', p, { fit: fitInfo(ed) });
S.activate(e2);
await waitOff(e2, false);
p = [];
if (document.body.classList.contains('shell-canvas-only')) p.push('the body still has the class shell-canvas-only');
if (!hintGone()) p.push('the hint is still shown: ' + JSON.stringify(hintState()));
if (await fs()) p.push('the window is still full screen');
if (host.editor !== e2) p.push('the active tab is not the one switched to');
p.push(...sameView(viewOf(ed), co.before.view));
if (ed._fitted !== co.before.fitted) p.push('_fitted is ' + ed._fitted + ', was ' + co.before.fitted);
if (ed.showRulers !== co.before.rulers) p.push('showRulers is ' + ed.showRulers + ', was ' + co.before.rulers);
if (lsGet('ipc.rulers') !== co.before.ls) p.push('localStorage ipc.rulers is ' + lsGet('ipc.rulers') + ', was ' + co.before.ls);
for (const [k, d] of Object.entries(displays(e2))) if (!k.startsWith('.ipc-subbar') && d === 'none') p.push('the tab switched to: ' + k + ' is display none');
if (p.length) fail('after the switch', p, { view: viewOf(ed), active: host.editor && host.editor.node.id });
S.activate(ed);
await settle(ed);
p = await offProblems(ed, co.before, false);
const out = { before: co.before.view, view: viewOf(ed) };
if (p.length) fail('back on the first tab', p, out);
return out;
"""

CLOSE = """
if (isOn()) throw new Error('the mode is on before the step');
const e2 = co.ed2;
if (!e2 || !host.editors().includes(e2)) throw new Error('the second document of the step before is gone');
S.activate(e2);
await settle(e2);
const on = await S.canvasOnly(true);
await until(() => isOn(), 3000, 'isCanvasOnly() to turn true');
await soft(fs, 5000, 'full screen');
const closed = await S.closeDocument(e2, { force: true });
if (closed) { co.docs = co.docs.filter((id) => id !== e2.node.id); co.ed2 = null; }
const p = [];
if (on !== true) p.push('canvasOnly(true) answered ' + JSON.stringify(on));
if (closed !== true) p.push('closeDocument answered ' + JSON.stringify(closed));
try { await waitOff(host.editor, false); } catch (err) { p.push(String(err.message || err)); }
if (document.body.classList.contains('shell-canvas-only')) p.push('the body still has the class shell-canvas-only');
if (!hintGone()) p.push('the hint is still shown: ' + JSON.stringify(hintState()));
if (await fs()) p.push('the window is still full screen');
if (host.editor) for (const [k, d] of Object.entries(displays(host.editor))) if (!k.startsWith('.ipc-subbar') && d === 'none') p.push('the tab now active: ' + k + ' is display none');
const out = { closed, active: host.editor ? host.editor.node.id : null };
S.activate(ed);
await settle(ed);
if (p.length) fail('after closing the tab', p, out);
return out;
"""

# ---- 9: cleanup --------------------------------------------------------------------------------------------------

CLEANUP = """
const out = {};
try { if (isOn()) out.canvasOnly = await S.canvasOnly(false); } catch (err) { out.canvasOnlyError = String(err.message || err); }
try {
    if (await fs()) { await W.setFullScreen(false); await soft(async () => !(await fs()), 5000, 'the full screen to end'); }
    out.fullScreen = await fs();
} catch (err) { out.fullScreenError = String(err.message || err); }
try { if (co.dialog) { try { co.dialog.close(); } catch (_) { /* closed */ } co.dialog.remove(); co.dialog = null; } } catch (_) { /* gone */ }
if (co.ed && co.askFaked) co.ed.askOpen = null;
if (co.ed) {
    try {
        if (co.ed.pending) co.ed.cancelPending();
        co.ed.polyPoints = null;
        if (co.edRulers0 != null && co.ed.showRulers !== co.edRulers0) co.ed.toggleRulers();
        co.ed.setTool('select');
    } catch (_) { /* the tab goes anyway */ }
}
if ('ls0' in co && lsGet('ipc.rulers') !== co.ls0) { lsPut('ipc.rulers', co.ls0); out.rulersPutBack = true; }
if ('pane0' in co && lsGet('ipc.pane') !== co.pane0) lsPut('ipc.pane', co.pane0);
for (const id of (co.docs || []).slice()) {
    const e = host.editorById(id);
    if (!e) continue;
    try { await S.closeDocument(e, { force: true }); } catch (err) { out.closeError = String(err.message || err); }
}
const prev = co.prevId != null ? host.editorById(co.prevId) : null;
if (prev) S.activate(prev);
out.docsLeft = (co.docs || []).filter((id) => host.editorById(id)).length;
out.on = isOn();
delete window.__co;
return out;
"""


# ---- 10: what changes inside the view stays; the view's keys under a modal and in a covered column ------------------

INSIDE = """
if (!ed) throw new Error('no test document');
if (isOn()) throw new Error('the mode is on before the step');
if (host.editor !== ed) S.activate(ed);
await settle(ed);
if (ed.showRulers) ed.toggleRulers();
ed.zoomTo(2);
ed.root.focus({ preventScroll: true });
// Ctrl+Shift+R inside the view: the rulers the user turned on stay on after it
if (!(await S.canvasOnly(true))) throw new Error('canvasOnly(true) did not turn the view on');
await waitOn(ed);
ed.toggleRulers();
await S.canvasOnly(false);
await waitOff(ed, false);
let p = [];
if (ed.showRulers !== true) p.push('the rulers turned on in the view are ' + ed.showRulers + ' after it');
if (!ed.rulersBtn.classList.contains('ipc-toggle-on')) p.push('the rulers button is not on');
if (p.length) fail('rulers', p, {});
ed.toggleRulers();
// a picture that changed size in the view stays fitted after it (the old zoom belongs to the old picture)
ed.zoomTo(2);
const w0 = ed.width, h0 = ed.height;
await S.canvasOnly(true);
await waitOn(ed);
await commands.run('extend_canvas', { right: 400, bottom: 200, doc: ed.node.id });
if (ed.width !== w0 + 400 || ed.height !== h0 + 200) fail('extend', ['the canvas is ' + ed.width + ' x ' + ed.height], {});
await S.canvasOnly(false);
await waitOff(ed, false);
await settle(ed);
const f = fitInfo(ed);
if (ed._fitted !== true) p.push('_fitted is ' + ed._fitted + ' after a size change in the view');
if (Math.abs(f.scale - f.fitScale) > 1e-6) p.push('the scale is ' + f.scale + ', the fit is ' + f.fitScale);
if (p.length) fail('size change', p, { fit: f });
ed.undoStep();
await until(() => ed.width === w0 && ed.height === h0, 5000, 'the extend to be undone');
return { rulers: 'kept', fit: f };
"""

MODAL_PREP = """
if (isOn()) throw new Error('the mode is on before the step');
// a modal whose focused field was re-rendered away (Settings > API providers after a save): the focus falls to <body>
const d = document.createElement('dialog');
const inp = document.createElement('input');
d.appendChild(inp);
d.appendChild(document.createElement('button'));
document.body.appendChild(d);
co.dialog = d;
d.showModal();
inp.focus();
inp.remove();
return { focus: who(document.activeElement), modal: !!document.querySelector('dialog:modal') };
"""

MODAL_CHECK = """
await wait(600);
const out = { on: isOn(), fullScreen: await fs(), focus: who(document.activeElement) };
co.dialog.close(); co.dialog.remove(); co.dialog = null;
if (out.on || out.fullScreen) fail('Tab under a modal', ['the view turned on behind the modal'], out);
ed.root.focus({ preventScroll: true });
return out;
"""

COVERED_PREP = """
if (isOn()) throw new Error('the mode is on before the step');
if (host.editor !== ed) S.activate(ed);
ed.root.focus({ preventScroll: true });
await S.canvasOnly(true);
await waitOn(ed);
const H = await import('./help.js');
const A = await import('./assistant.js');
co.helpWasOpen = H.helpOpen();
co.assistantWasOpen = A.assistantOpen();
// an ask opens the assistant's column under the view: the focus must not go into its (covered) chat box
A.toggleAssistant(true);
await wait(100);
const inAssistant = !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('#assistant'));
if (!co.assistantWasOpen) A.toggleAssistant(false);
if (inAssistant) fail('the assistant under the view', ['toggleAssistant(true) took the focus into the covered column'], { focus: who(document.activeElement) });
// Help opened under the view (not by its menu command, which ends the view) puts the caret into its search field
H.toggleHelp(true);
await wait(100);
if (!isOn()) fail('Help under the view', ['the view ended'], {});
return { focus: who(document.activeElement), inHelp: !!(document.activeElement && document.activeElement.closest('#help')) };
"""

COVERED_CHECK = """
const H = await import('./help.js');
let left = true;
try { await waitOff(ed, false); } catch (_) { left = false; }
const out = { left, on: isOn(), fullScreen: await fs(), helpOpen: H.helpOpen() };
if (!co.helpWasOpen) H.toggleHelp(false);
ed.root.focus({ preventScroll: true });
if (!left) { await S.canvasOnly(false); fail('Tab in the covered Help column', ['the view did not end'], out); }
return out;
"""


class Gate:
    def __init__(self, c):
        self.c = c

    async def ev(self, body, timeout=90):
        return await self.c.eval(PRE.replace("__MARK__", json.dumps(MARK)).replace("__BODY__", body), timeout=timeout)

    async def key(self, name, modifiers=0):
        """A real key press through the browser's input pipeline (keydown without a char, then keyup)."""
        vk = KEYS[name]
        for kind in ("rawKeyDown", "keyUp"):
            await self.c.call("Input.dispatchKeyEvent", type=kind, key=name, code=name, windowsVirtualKeyCode=vk, nativeVirtualKeyCode=vk, modifiers=modifiers)

    async def setup(self):
        return await self.ev(SETUP)

    async def cleanup(self):
        out = await self.ev(CLEANUP)
        problems = []
        if out.get("on"):
            problems.append("the mode is still on")
        if out.get("fullScreen"):
            problems.append("the window is still full screen")
        if out.get("docsLeft"):
            problems.append("%d test documents are still open" % out["docsLeft"])
        for k in ("canvasOnlyError", "fullScreenError", "closeError"):
            if out.get(k):
                problems.append("%s: %s" % (k, out[k]))
        if problems:
            raise RuntimeError("; ".join(problems) + " | " + json.dumps(out))
        return out

    # ---- the steps -------------------------------------------------------------------------

    async def tab_enters_the_canvas_only_view(self):
        before = await self.ev(ENTER_PREP)
        await self.key("Tab")
        out = await self.ev(ENTER_CHECK)
        return {"before": before, "on": out}

    async def tab_again_leaves_and_puts_everything_back(self):
        # no refocus between the two presses: a user presses Tab twice where the first one left the focus
        await self.key("Tab")
        return await self.ev(LEAVE_CHECK)

    async def tab_does_nothing_in_a_field_a_dialog_an_ask_or_with_shift(self):
        out = {}
        for name, prep, restore, mods in NOTHING_CASES:
            before = await self.ev(prep)
            await self.key("Tab", mods)
            after = await self.ev(NOTHING.replace("__RESTORE__", restore).replace("__CASE__", json.dumps(name)))
            out[name] = {"before": before["focus"], "after": after["focus"]}
        return out

    async def escape_cancels_what_is_pending_first_then_leaves(self):
        prep = await self.ev(ESC_PREP)
        await self.key("Tab")
        pending = await self.ev(ESC_MAKE_PENDING)
        await self.key("Escape")
        transform = await self.ev(ESC_AFTER_TRANSFORM)
        await self.key("Escape")
        polygon = await self.ev(ESC_AFTER_POLYGON)
        await self.key("Escape")
        frame = await self.ev(ESC_AFTER_FRAME)
        await self.key("Escape")
        left = await self.ev(ESC_LEAVES)
        return {"prep": prep, "pending": pending, "transform": transform, "polygon": polygon, "frame": frame, "left": left}

    async def a_full_screen_exit_from_outside_ends_the_mode(self):
        return await self.ev(OUTSIDE)

    async def a_window_full_screen_before_stays_full_screen(self):
        return await self.ev(ALREADY)

    async def a_tab_switch_ends_the_mode_and_restores_the_first_view(self):
        return await self.ev(SWITCH)

    async def closing_the_active_tab_ends_the_mode(self):
        return await self.ev(CLOSE)

    async def a_ruler_toggle_and_a_new_picture_size_in_the_view_are_kept(self):
        return await self.ev(INSIDE)

    async def tab_under_a_modal_does_nothing_and_leaves_from_a_covered_column(self):
        modal = await self.ev(MODAL_PREP)
        await self.key("Tab")
        modal_after = await self.ev(MODAL_CHECK)
        covered = await self.ev(COVERED_PREP)
        await self.key("Tab")
        covered_after = await self.ev(COVERED_CHECK)
        return {"modal": [modal, modal_after], "covered": [covered, covered_after]}

    async def run_step(self, name, fn):
        try:
            res = await fn()
            print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:700]), flush=True)
            return True
        except Exception as err:  # noqa: BLE001
            print("[FAIL] %s: %s" % (name, err), flush=True)
            return False


STEPS = [
    "tab_enters_the_canvas_only_view",
    "tab_again_leaves_and_puts_everything_back",
    "tab_does_nothing_in_a_field_a_dialog_an_ask_or_with_shift",
    "escape_cancels_what_is_pending_first_then_leaves",
    "a_full_screen_exit_from_outside_ends_the_mode",
    "a_window_full_screen_before_stays_full_screen",
    "a_tab_switch_ends_the_mode_and_restores_the_first_view",
    "closing_the_active_tab_ends_the_mode",
    "a_ruler_toggle_and_a_new_picture_size_in_the_view_are_kept",
    "tab_under_a_modal_does_nothing_and_leaves_from_a_covered_column",
]


async def run_all(c):
    g = Gate(c)
    ok = True
    try:
        try:
            print("[ok] setup: %s" % json.dumps(await g.setup(), ensure_ascii=False), flush=True)
        except Exception as err:  # noqa: BLE001
            print("[FAIL] setup: %s" % err, flush=True)
            ok = False
        if ok:
            await c.call("Page.bringToFront")     # the key presses go to the page in front
            for name in STEPS:
                if not await g.run_step(name, getattr(g, name)):
                    ok = False
                    break
    finally:
        try:
            print("[ok] cleanup: %s" % json.dumps(await g.cleanup(), ensure_ascii=False), flush=True)
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] cleanup: %s" % err, flush=True)
    try:
        for level, text in (await c.logs())[-15:]:
            if level == "error":
                print("  console error:", text[:220])
    except Exception:  # noqa: BLE001
        pass
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
