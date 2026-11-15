"""A frame from a video (CLAUDE.md item 68, docs/PLAN_0_1_57.md): a video dropped on the window or opened with
File › Open shows the frame picker (renderer/videoframe.js), and the frame becomes a new picture, a layer or a
reference layer; what Chromium cannot decode is refused in the status line; commands refuse a video path.

No ComfyUI, no key. The fixtures in tools/fixtures/video are 64 x 48, made by ffmpeg: clip.webm (VP8) and clip.mp4
(H.264), 2 s at 30 fps, the first second red, the second blue; prores.mov (ProRes, which Chromium does not decode) and
broken.mov (text); steps25.webm (25 frames at 25 fps, each a grey 8 luma levels above the one before) and
live.webm (the red / blue clip written to a pipe, so its file names no length). Steps:

- node tools/videofiles_test.js: main's token route (ranges, HEAD, unknown and released tokens, the grant cap);
- a drop of clip.webm on an empty tab opens the picker (Open as new picture has the focus, Add as layer is off),
  the video's size and length;
- one frame step from the last red frame lands on the first blue one and back (1/30 s, the fixture's rate);
- Open as new picture: the tab gets a 64 x 48 picture, blue at 1.5 s;
- File › Open's route (dev-only hook file:testOpenVideo, a fixture only): clip.mp4 through scumble://app/video/<token>,
  Add as layer at 0.5 s: a 64 x 48 layer, the picture red; the token answers 404 once the picker closed;
- a Shift drop puts the focus on Add as reference; it adds a reference layer;
- Escape (the dialog's cancel) takes nothing;
- at 25 fps, never played (the frame rate not known), ten steps forward each show the next frame (0.04 s on, one grey
  further) and the frame length is learnt from them; three steps back each show the frame before;
- a video whose file names no length: its end is found (the slider, End and a seconds jump reach past 0);
- prores.mov and broken.mov are refused in the status line (red), no picker opens;
- load_image, add_image_layer and open_document refuse a video path in plain words.

Normal tier: the tiles backend. Start the app first, offline:
    ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
or bash tools/run_gates.sh <label> --offline videoframe (SCUMBLE_CDP_PORT for another port). The File › Open step needs
a dev build (the hook is not in a packaged exe): with --exe it is skipped and says so.
"""
import asyncio
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures", "video").replace("\\", "/") + "/"

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
    const S = await import('./shell.js');
    const { host } = await import('./editor/host.js');
    const { commands } = await import('./commands.js');
    const VF = await import('./videoframe.js');
    const FIX = __FIX__;
    const g = window.__vf || (window.__vf = { docs: [] });
    const picker = () => document.querySelector('dialog[data-video-frame]');
    const drop = async (name, type, opts = {}) => {
        const r = await window.scumble.file.read(FIX + name);
        const f = new File([r.data], name, { type });
        const dt = new DataTransfer();
        dt.items.add(f);
        const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, shiftKey: !!opts.shift });
        window.dispatchEvent(ev);
        return ev;
    };
    const primary = (d) => Object.entries(d.__videoFrame.buttons).filter(([, b]) => b.className === 'primary').map(([k]) => k)[0] || null;
    // the colour of the frame on screen, read the way the picker takes it
    const frameColor = async (v) => {
        const f = await VF.frameFile(v, 'probe.webm');
        const bmp = await createImageBitmap(f);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const x = c.getContext('2d');
        x.drawImage(bmp, 0, 0);
        const d = x.getImageData(bmp.width >> 1, bmp.height >> 1, 1, 1).data;
        return { size: [bmp.width, bmp.height], rgb: [d[0], d[1], d[2]], name: f.name };
    };
    const isRed = (c) => c[0] > 180 && c[1] < 70 && c[2] < 70;
    const isBlue = (c) => c[2] > 180 && c[0] < 70 && c[1] < 70;
    const mean = async () => { const r = await commands.call('sample.mean_color', {}); if (!r.ok) throw new Error(r.error); return r.result.rgb; };
    const layers = async () => { const r = await commands.call('list_layers', {}); if (!r.ok) throw new Error(r.error); return r.result.layers; };
    const newTab = () => { const e = S.newDocument(); S.activate(e); g.docs.push(e); return e; };
    __BODY__
})()"""


class Gate:
    def __init__(self, c):
        self.c = c

    async def js(self, body, timeout=120):
        code = PRE.replace("__FIX__", json.dumps(FIX)).replace("__BODY__", body)
        return await self.c.eval(code, timeout=timeout)

    async def videofiles_route(self):
        r = subprocess.run(["node", os.path.join(HERE, "videofiles_test.js")], capture_output=True, text=True, timeout=120)
        lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
        if r.returncode != 0 or not lines or lines[-1] != "PASS":
            raise RuntimeError("videofiles_test.js: " + "\n".join(lines[-20:]) + r.stderr[-500:])
        return {"checks": sum(1 for ln in lines if ln.startswith("[ok]"))}

    async def a_dropped_webm_opens_the_picker(self):
        return await self.js("""
            const ed = newTab();
            if (ed.base) throw new Error('the new tab has a picture');
            const ev = await drop('clip.webm', 'video/webm');
            if (!ev.defaultPrevented) throw new Error('the drop was not taken');
            const d = await until(picker, 15000, 'the picker');
            const v = d.__videoFrame.video;
            if (v.videoWidth !== 64 || v.videoHeight !== 48) throw new Error('size ' + v.videoWidth + 'x' + v.videoHeight);
            if (Math.abs(v.duration - 2) > 0.1) throw new Error('duration ' + v.duration);
            if (primary(d) !== 'new') throw new Error('focus on ' + primary(d));
            if (!d.__videoFrame.buttons.layer.disabled) throw new Error('Add as layer is on without a picture');
            if (!/^Pick a frame from clip\\.webm/.test(ed.status)) throw new Error('status ' + ed.status);
            return { size: [v.videoWidth, v.videoHeight], duration: v.duration, step: d.__videoFrame.frameStep() };
        """)

    async def one_frame_step_crosses_the_cut(self):
        return await self.js("""
            const d = picker();
            const vf = d.__videoFrame, v = vf.video;
            vf.seek(29 / 30 + 0.005);
            await vf.settled();
            const a = await frameColor(v);
            if (!isRed(a.rgb)) throw new Error('frame 29 is not red: ' + a.rgb);
            const t0 = v.currentTime;
            await vf.step(1);
            const b = await frameColor(v);
            const dt = v.currentTime - t0;
            if (!isBlue(b.rgb)) throw new Error('one step on is not blue: ' + b.rgb + ' at ' + v.currentTime);
            if (Math.abs(dt - 1 / 30) > 0.01) throw new Error('the step moved ' + dt + ' s');
            await vf.step(-1);
            const c = await frameColor(v);
            if (!isRed(c.rgb)) throw new Error('one step back is not red: ' + c.rgb + ' at ' + v.currentTime);
            return { red: a.rgb, blue: b.rgb, back: c.rgb, moved: dt, size: b.size, learned: vf.frameLength(), callbacks: vf.frames() };
        """)

    async def open_as_new_picture(self):
        return await self.js("""
            const d = picker();
            const vf = d.__videoFrame;
            vf.seek(1.5);
            await vf.settled();
            const n0 = host.editors().length;
            const ed0 = host.editor;
            await vf.take('new');
            await until(() => !picker(), 10000, 'the picker to close');
            const ed = await until(() => host.editor && host.editor.base && host.editor.width ? host.editor : null, 15000, 'the picture');
            if (ed !== ed0) g.docs.push(ed);
            if (ed.width !== 64 || ed.height !== 48) throw new Error('picture ' + ed.width + 'x' + ed.height);
            const rgb = await mean();
            if (!isBlue(rgb)) throw new Error('the picture is not blue: ' + rgb);
            return { tabs: [n0, host.editors().length], reused_empty_tab: ed === ed0, size: [ed.width, ed.height], rgb, name: ed.base && ed.base.ref && ed.base.ref.filename };
        """)

    async def file_open_route_adds_a_layer(self):
        return await self.js("""
            if (typeof window.scumble.file.testOpenVideo !== 'function') return { skipped: 'no preload hook' };
            let p;
            try { p = await window.scumble.file.testOpenVideo('clip.mp4'); }
            catch (err) { if (/No handler registered/i.test(String(err))) return { skipped: 'a packaged build: no test hook' }; throw err; }
            if (!/^scumble:\\/\\/app\\/video\\/[0-9a-f]{32}$/.test(p.url)) throw new Error('url ' + p.url);
            const d = await until(picker, 15000, 'the picker');
            const vf = d.__videoFrame, v = vf.video;
            if (v.currentSrc !== p.url) throw new Error('src ' + v.currentSrc);
            if (primary(d) !== 'new') throw new Error('focus on ' + primary(d));
            if (d.__videoFrame.buttons.layer.disabled) throw new Error('Add as layer is off in a document with a picture');
            const head = await fetch(p.url, { headers: { range: 'bytes=0-9' } });
            if (head.status !== 206) throw new Error('a range answered ' + head.status);
            vf.seek(0.5);
            await vf.settled();
            const before = (await layers()).length;
            await vf.take('layer');
            await until(() => !picker(), 10000, 'the picker to close');
            const after = await until(async () => { const l = await layers(); return l.length > before ? l : null; }, 15000, 'the layer');
            const L = after.find((l) => /clip/.test(l.name || '')) || after[0];
            const rgb = await mean();
            if (!isRed(rgb)) throw new Error('the picture is not red under the layer: ' + rgb);
            // the release goes to main without a wait: give it a moment
            const gone = await until(async () => ((await fetch(p.url).then((r) => r.status, () => 0)) === 404 ? 404 : null), 5000, 'the token to answer 404');
            return { url: p.url, layers: [before, after.length], layer: { name: L.name, w: L.width || L.w, h: L.height || L.h, role: L.role }, rgb, after_close: gone };
        """)

    async def shift_drop_adds_a_reference(self):
        return await self.js("""
            const before = await layers();
            await drop('clip.webm', 'video/webm', { shift: true });
            const d = await until(picker, 15000, 'the picker');
            if (primary(d) !== 'reference') throw new Error('focus on ' + primary(d));
            d.__videoFrame.seek(0.2);
            await d.__videoFrame.settled();
            await d.__videoFrame.take('reference');
            await until(() => !picker(), 10000, 'the picker to close');
            const after = await until(async () => { const l = await layers(); return l.length > before.length ? l : null; }, 15000, 'the reference');
            const added = after.filter((l) => !before.some((b) => b.id === l.id));
            if (added.length !== 1 || added[0].role !== 'reference') throw new Error('added ' + JSON.stringify(added));
            return { added: added.map((l) => ({ name: l.name, role: l.role })) };
        """)

    async def escape_takes_nothing(self):
        return await self.js("""
            const before = (await layers()).length;
            const tabs = host.editors().length;
            await drop('clip.webm', 'video/webm');
            const d = await until(picker, 15000, 'the picker');
            d.dispatchEvent(new Event('cancel', { cancelable: true }));
            await until(() => !picker(), 5000, 'the picker to close');
            await until(() => /No frame taken/.test(host.editor.status), 5000, 'the status');
            if ((await layers()).length !== before || host.editors().length !== tabs) throw new Error('something landed');
            return { status: host.editor.status };
        """)

    async def steps_at_25_fps_land_on_each_frame(self):
        # steps25.webm: 25 frames at 25 fps, frame N grey 16 + 8 N in luma (about 9 levels apart in RGB), never played:
        # each step forward must show the next frame (a 1/30 s step stays inside a 0.04 s frame)
        return await self.js("""
            await drop('steps25.webm', 'video/webm');
            const d = await until(picker, 15000, 'the picker');
            const vf = d.__videoFrame, v = vf.video;
            vf.seek(0.005);
            await vf.settled();
            await until(() => vf.frames() > 0, 3000, 'a frame callback (the window must be shown)');
            if (vf.frameLength()) throw new Error('the frame length is known before any step: ' + vf.frameLength());
            const grey = async () => (await frameColor(v)).rgb[0];
            const seen = [{ t: vf.frameTime(), g: await grey() }];
            for (let i = 0; i < 10; i++) {
                await vf.step(1);
                const s = { t: vf.frameTime(), g: await grey() };
                const prev = seen[seen.length - 1];
                seen.push(s);
                if (!(s.g - prev.g >= 4 && s.g - prev.g <= 15)) throw new Error('step ' + (i + 1) + ' went from grey ' + prev.g + ' to ' + s.g + ': ' + JSON.stringify(seen));
                if (Math.abs(s.t - prev.t - 0.04) > 0.005) throw new Error('step ' + (i + 1) + ' moved ' + (s.t - prev.t) + ' s');
            }
            if (Math.abs(vf.frameLength() - 0.04) > 0.002) throw new Error('frame length ' + vf.frameLength());
            for (let i = 0; i < 3; i++) {
                const prev = seen[seen.length - 1];
                await vf.step(-1);
                const s = { t: vf.frameTime(), g: await grey() };
                seen.push(s);
                if (!(prev.g - s.g >= 4 && prev.g - s.g <= 15)) throw new Error('back step ' + (i + 1) + ' went from grey ' + prev.g + ' to ' + s.g);
            }
            const info = vf.info.textContent;
            vf.cancel();
            await until(() => !picker(), 5000, 'the picker to close');
            return { greys: seen.map((s) => s.g), times: seen.map((s) => +s.t.toFixed(3)), info };
        """)

    async def a_video_without_a_duration(self):
        # live.webm: the 30 fps red / blue clip written by ffmpeg to a pipe, so its file names no length (a recording's
        # shape): the player says Infinity until it has been to the end
        return await self.js("""
            await drop('live.webm', 'video/webm');
            const d = await until(picker, 15000, 'the picker');
            const vf = d.__videoFrame, v = vf.video;
            const found = v.dataset.durationFound || null;
            if (!found) throw new Error('the fixture had a duration (' + v.duration + '): it no longer tests this');
            const end = VF.endOf(v);
            if (!(end > 1.9 && end < 2.2)) throw new Error('end ' + end + ' (duration ' + v.duration + ')');
            if (!(+vf.range.max > 1.9)) throw new Error('slider max ' + vf.range.max);
            vf.jump(true);
            await vf.settled();
            const atEnd = v.currentTime;
            if (!(atEnd > 1.9)) throw new Error('End went to ' + atEnd);
            const blue = await frameColor(v);
            if (!isBlue(blue.rgb)) throw new Error('the end is not blue: ' + blue.rgb);
            vf.jump(false);
            await vf.settled();
            const dur = v.duration;
            vf.seconds(1.4);
            await vf.settled();
            if (Math.abs(v.currentTime - 1.4) > 0.01) throw new Error('Shift+Right went to ' + v.currentTime);
            vf.cancel();
            await until(() => !picker(), 5000, 'the picker to close');
            return { found, duration: dur, end, max: +vf.range.max, at_end: atEnd, after_seconds: 1.4 };
        """)

    async def undecodable_videos_are_refused(self):
        return await self.js("""
            const out = {};
            for (const name of ['prores.mov', 'broken.mov']) {
                await drop(name, 'video/quicktime');
                const ed = host.editor;
                const s = await until(() => /cannot be opened/.test(ed.status) ? ed.status : null, 25000, 'the refusal of ' + name);
                if (picker()) throw new Error('a picker opened for ' + name);
                if (ed.statusKind !== 'error') throw new Error('kind ' + ed.statusKind);
                out[name] = s;
            }
            return out;
        """)

    async def commands_refuse_a_video_path(self):
        return await self.js("""
            const out = {};
            for (const [name, args] of [['load_image', { path: FIX + 'clip.webm' }], ['add_image_layer', { path: FIX + 'clip.mp4' }], ['open_document', { path: FIX + 'clip.mov' }]]) {
                const r = await commands.call(name, args);
                if (r.ok || !/video/.test(r.error)) throw new Error(name + ': ' + JSON.stringify(r));
                out[name] = r.error;
            }
            return out;
        """)

    async def cleanup(self):
        return await self.js("""
            const d = picker();
            if (d) d.__videoFrame.cancel();
            let closed = 0;
            for (const e of g.docs) { if (host.editors().includes(e)) { try { await S.closeDocument(e, { force: true, remember: false }); closed++; } catch (_) { /* gone */ } } }
            delete window.__vf;
            return { closed };
        """)

    async def run_step(self, name, fn):
        try:
            res = await fn()
            print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:700]), flush=True)
            return True
        except Exception as err:  # noqa: BLE001
            print("[FAIL] %s: %s" % (name, err), flush=True)
            return False


STEPS = [
    "videofiles_route",
    "a_dropped_webm_opens_the_picker",
    "one_frame_step_crosses_the_cut",
    "open_as_new_picture",
    "file_open_route_adds_a_layer",
    "shift_drop_adds_a_reference",
    "escape_takes_nothing",
    "steps_at_25_fps_land_on_each_frame",
    "a_video_without_a_duration",
    "undecodable_videos_are_refused",
    "commands_refuse_a_video_path",
]


async def run_all(c):
    g = Gate(c)
    ok = True
    try:
        await c.call("Page.bringToFront")
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
