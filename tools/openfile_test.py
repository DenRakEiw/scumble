"""The openfile gate: File › Open and load_image hand the window a token, not the file (docs/BUGS.md "Ctrl+O sends the
whole file to the window in one message", fixed 2026-11-16; electron/main/grantedfiles.js, renderer/grantfile.js).

Steps (against the app on SCUMBLE_CDP_PORT, default 9555):
- grantedfiles_route / videofiles_route: tools/grantedfiles_test.js and tools/videofiles_test.js in plain Node;
- fixtures: a two-layer document (a noise base, a half-transparent layer placed off the origin) exported as PSD, ORA,
  TIFF and PNG, saved as .scumble, and a JPEG / WebP / LZW TIFF written by Pillow, into a temporary folder;
- the_file_arrives_byte_for_byte: each file through File › Open's route (the dev-only hook file:testOpen, main's
  openChosen without the dialog) and through load_image: the File the editor's loadFile gets has the file's name, the
  type the window gave it before, its size and its SHA-256 (hashlib's);
- each_route_opens_the_same_layers_as_a_drop: each file opened three ways into fresh tabs: File › Open's route,
  load_image, and a disk-backed File (an <input type=file> given the path over CDP, the editor's drop route, whose code
  this fix does not touch): the same size, layer stack (name, box, opacity, blend, visibility) and every layer's,
  mask's and the base's bytes;
- the_token_is_released: after a File › Open the token's URL answers 404; a grant serves ranges until released;
- a_scumble_document_still_opens: File › Open's route on a .scumble opens it as a document (documents:openRequest);
- worded_refusals: a missing file and a folder through File › Open (the status line, red) and load_image (the error);
  a file deleted between the grant and the read is refused in words and its token is released.

Full tier (file open): run on both backends. Start the app first, offline:
    ./node_modules/.bin/electron . --remote-debugging-port=9555 --no-comfy
or bash tools/run_gates.sh <label> --offline openfile. The hook is not in a packaged exe: with --exe the File › Open
steps say so and are skipped.
"""
import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

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
    const G = await import('./grantfile.js');
    const g = window.__of || (window.__of = { docs: [] });
    const run = async (name, args = {}) => { const r = await commands.call(name, args); if (!r.ok) throw new Error(r.error); return r.result; };
    const newTab = () => { const e = S.newDocument(); S.activate(e); g.docs.push(e); return e; };
    const hasHook = typeof window.scumble.file.testOpen === 'function';
    const sha = async (blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).map((b) => b.toString(16).padStart(2, '0')).join('');
    const fnv = (a) => { let h = 2166136261; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619) >>> 0; } return a.length + ':' + h; };
    const pix = (p) => (p ? fnv(p.readRect(0, 0, p.width, p.height).data) : null);
    const view = (ed) => ({ w: ed.width, h: ed.height, base: pix(ed.basePx),
        layers: ed.layers.map((L) => ({ name: L.name, x: L.x, y: L.y, w: L.w, h: L.h, opacity: L.opacity, blend: L.blend || null, visible: L.visible, kind: L.kind || null, px: pix(L.px), mask: pix(L.maskPx) })) });
    // a tab whose loadFile tells when it is done (and with which File); File › Open's route goes into the active empty tab
    const watched = () => {
        const ed = newTab();
        const W = { file: null, done: false, err: null, ed };
        const orig = ed.loadFile.bind(ed);
        ed.loadFile = (f, o) => { W.file = f; return orig(f, o).then((r) => { W.done = true; return r; }, (e) => { W.err = String(e); W.done = true; throw e; }); };
        return W;
    };
    const settle = async (W, what) => { await until(() => W.done, 120000, what); await wait(150); if (W.err) throw new Error(what + ': ' + W.err); return W; };
    __BODY__
})()"""


class Gate:
    def __init__(self, c):
        self.c = c
        self.dir = tempfile.mkdtemp(prefix="scumble-openfile-")
        self.files = {}

    def p(self, name):
        return os.path.join(self.dir, name).replace("\\", "/")

    async def js(self, body, timeout=300, **subs):
        code = PRE.replace("__BODY__", body)
        for k, v in subs.items():
            code = code.replace("__%s__" % k, json.dumps(v))
        return await self.c.eval(code, timeout=timeout)

    def node(self, script):
        r = subprocess.run(["node", os.path.join(HERE, script)], capture_output=True, text=True, timeout=120)
        lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
        if r.returncode != 0 or not lines or lines[-1] != "PASS":
            raise RuntimeError(script + ": " + "\n".join(lines[-20:]) + r.stderr[-500:])
        return {"checks": sum(1 for ln in lines if ln.startswith("[ok]"))}

    async def grantedfiles_route(self):
        return self.node("grantedfiles_test.js")

    async def videofiles_route(self):
        return self.node("videofiles_test.js")

    async def fixtures(self):
        from PIL import Image
        import random
        rnd = random.Random(11)
        w, h = 96, 64
        base = Image.frombytes("RGB", (w, h), bytes(rnd.randrange(256) for _ in range(w * h * 3)))
        base.save(self.p("base.png"))
        top = Image.new("RGBA", (40, 30))
        top.putdata([(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256), (x * 7 + y * 3) % 256) for y in range(30) for x in range(40)])
        top.save(self.p("top.png"))
        base.save(self.p("photo.jpg"), quality=90)
        base.save(self.p("photo.webp"), lossless=True)
        base.save(self.p("pil_lzw.tif"), compression="tiff_lzw")
        res = await self.js("""
            const d = await run('new_document');
            g.docs.push(host.editors().find((e) => e.node.id === d.id));
            await run('load_image', { doc: d.id, path: __DIR__ + '/base.png' });
            const l = await run('add_image_layer', { doc: d.id, path: __DIR__ + '/top.png', name: 'top' });
            await run('set_layer', { doc: d.id, layer: l.id, x: 37, y: 21, opacity: 0.8 });
            const out = {};
            for (const f of ['psd', 'ora', 'tiff', 'png']) out[f] = (await run('export', { doc: d.id, format: f, path: __DIR__ + '/doc.' + (f === 'tiff' ? 'tif' : f) })).file;
            out.scumble = (await run('save_document', { doc: d.id, path: __DIR__ + '/doc.scumble', copy: true })).path;
            await run('close_document', { doc: d.id, force: true });
            return out;
        """, DIR=self.dir.replace("\\", "/"))
        for name in ("doc.psd", "doc.ora", "doc.tif", "doc.png", "photo.jpg", "photo.webp", "pil_lzw.tif"):
            path = self.p(name)
            with open(path, "rb") as f:
                b = f.read()
            self.files[name] = {"path": path, "size": len(b), "sha": hashlib.sha256(b).hexdigest()}
        return {"exported": res, "files": {k: v["size"] for k, v in self.files.items()}}

    async def the_file_arrives_byte_for_byte(self):
        return await self.js("""
            const out = {};
            const want = (n) => /\\.jpe?g$/i.test(n) ? 'image/jpeg' : /\\.webp$/i.test(n) ? 'image/webp' : /\\.tiff?$/i.test(n) ? 'image/tiff' : 'image/png';
            for (const [name, F] of Object.entries(__FILES__)) {
                const row = {};
                for (const route of hasHook ? ['open', 'load'] : ['load']) {
                    const W = watched();
                    if (route === 'open') { const r = await window.scumble.file.testOpen(F.path); if (r.data) throw new Error('main sent the bytes'); if (r.error) throw new Error(r.error); }
                    else await run('load_image', { path: F.path });
                    await settle(W, name + ' by ' + route);
                    const f = W.file;
                    if (!(f instanceof File)) throw new Error(name + ' by ' + route + ': no File');
                    if (f.name !== name) throw new Error(name + ' by ' + route + ': named ' + f.name);
                    if (f.type !== want(name)) throw new Error(name + ' by ' + route + ': type ' + f.type);
                    if (f.size !== F.size) throw new Error(name + ' by ' + route + ': ' + f.size + ' bytes of ' + F.size);
                    const s = await sha(f);
                    if (s !== F.sha) throw new Error(name + ' by ' + route + ': other bytes');
                    if (!W.ed.base) throw new Error(name + ' by ' + route + ' did not open: ' + W.ed.status);
                    row[route] = f.size;
                }
                out[name] = row;
            }
            return { hook: hasHook, files: out };
        """, timeout=600, FILES=self.files)

    async def each_route_opens_the_same_layers_as_a_drop(self):
        out = {}
        for name, F in self.files.items():
            await self.js("""
                document.querySelectorAll('#__of_input').forEach((n) => n.remove());
                const i = document.createElement('input'); i.type = 'file'; i.id = '__of_input'; i.style.display = 'none'; document.body.appendChild(i);
                return 1;
            """)
            doc = await self.c.call("DOM.getDocument", depth=1)
            q = await self.c.call("DOM.querySelector", nodeId=doc["root"]["nodeId"], selector="#__of_input")
            await self.c.call("DOM.setFileInputFiles", files=[os.path.normpath(F["path"])], nodeId=q["nodeId"])
            out[name] = await self.js("""
                const F = __F__, views = {};
                const drop = document.getElementById('__of_input').files[0];
                if (!drop || drop.size !== F.size) throw new Error('the input holds no file of the size');
                for (const route of hasHook ? ['drop', 'open', 'load'] : ['drop', 'load']) {
                    const W = watched();
                    if (route === 'drop') W.ed.loadFile(drop);
                    else if (route === 'open') await window.scumble.file.testOpen(F.path);
                    else await run('load_image', { path: F.path });
                    await settle(W, route);
                    if (!W.ed.base) throw new Error(route + ' did not open: ' + W.ed.status);
                    views[route] = view(W.ed);
                    await run('close_document', { doc: W.ed.node.id, force: true });
                }
                const a = JSON.stringify(views.drop);
                for (const [route, v] of Object.entries(views)) if (JSON.stringify(v) !== a) throw new Error(route + ' differs from the drop: ' + JSON.stringify(v).slice(0, 400) + ' / ' + a.slice(0, 400));
                return { routes: Object.keys(views), size: [views.drop.w, views.drop.h], layers: views.drop.layers.map((l) => l.name), base: views.drop.base };
            """, timeout=600, F=F)
        return out

    async def the_token_is_released(self):
        return await self.js("""
            const F = __F__;
            let afterOpen = 'no hook';
            if (hasHook) {
                const W = watched();
                const r = await window.scumble.file.testOpen(F.path);
                if (!/^scumble:\\/\\/app\\/file\\/[0-9a-f]{32}$/.test(r.url)) throw new Error('url ' + r.url);
                if (r.url.includes('doc')) throw new Error('the url names the file');
                await settle(W, 'the open');
                const res = await fetch(r.url);
                afterOpen = res.status;
                if (res.status !== 404) throw new Error('the token still answers ' + res.status + ' after the open');
            }
            const gr = await G.grantPath(F.path);
            const part = await fetch(gr.url, { headers: { range: 'bytes=2-9' } });
            const pb = new Uint8Array(await part.arrayBuffer());
            if (part.status !== 206 || pb.length !== 8 || part.headers.get('content-range') !== 'bytes 2-9/' + F.size) throw new Error('a range answered ' + part.status + ' ' + pb.length + ' ' + part.headers.get('content-range'));
            const whole = await fetch(gr.url);
            if (whole.status !== 200 || (await whole.blob()).size !== F.size) throw new Error('the whole file answered ' + whole.status);
            const f = await G.grantedFile(gr);
            if (f.size !== F.size) throw new Error('grantedFile ' + f.size);
            await wait(100);
            const gone = await fetch(gr.url);
            if (gone.status !== 404) throw new Error('released, the token answers ' + gone.status);
            return { afterOpen, range: part.status, whole: whole.status, released: gone.status };
        """, F=self.files["doc.png"])

    async def a_scumble_document_still_opens(self):
        return await self.js("""
            if (!hasHook) return { skipped: 'a packaged build: no test hook' };
            const path = __P__;
            const n0 = host.editors().length;
            const r = await window.scumble.file.testOpen(path);
            if (r.document !== path.replace(/\\//g, '\\\\') && r.document !== path) throw new Error('not routed as a document: ' + JSON.stringify(r));
            const ed = await until(() => host.editors().find((e) => e.docFile && /doc\\.scumble$/i.test(e.docFile.path || '') && e.base && e.layers.length && !e._loading), 60000, 'the document with its layers');
            g.docs.push(ed);
            if (ed.layers.length < 1 || ed.width !== 96 || ed.height !== 64) throw new Error('document ' + ed.width + 'x' + ed.height + ', ' + ed.layers.length + ' layers');
            return { tabs: [n0, host.editors().length], size: [ed.width, ed.height], layers: ed.layers.map((l) => l.name) };
        """, P=self.p("doc.scumble"))

    async def worded_refusals(self):
        victim = self.p("victim.png")
        shutil.copy(self.p("base.png"), victim)
        grown = self.p("grown.png")
        shutil.copy(self.p("base.png"), grown)
        res = await self.js("""
            const out = {};
            const nope = __DIR__ + '/nope.png';
            if (hasHook) {
                const ed = newTab();
                const r = await window.scumble.file.testOpen(nope);
                if (!r.error || r.token) throw new Error('a missing file was granted: ' + JSON.stringify(r));
                await wait(100);
                if (!/^Could not open nope\\.png: nope\\.png is not there any more\\.$/.test(ed.status) || ed.statusKind !== 'error') throw new Error('status ' + JSON.stringify([ed.status, ed.statusKind]));
                out.open_missing = ed.status;
                const r2 = await window.scumble.file.testOpen(__DIR__);
                await wait(100);
                if (!/is a folder, not a file\\.$/.test(ed.status) || ed.base) throw new Error('a folder: ' + ed.status);
                out.open_folder = ed.status;
            }
            const d = await run('new_document');
            g.docs.push(host.editors().find((e) => e.node.id === d.id));
            let m = null;
            try { await run('load_image', { doc: d.id, path: nope }); } catch (e) { m = String(e.message || e); }
            if (m !== 'nope.png is not there any more') throw new Error('load_image of a missing file: ' + m);
            out.load_missing = m;
            m = null;
            try { await run('load_image', { doc: d.id, path: __DIR__ }); } catch (e) { m = String(e.message || e); }
            if (!m || !/is a folder, not a file$/.test(m)) throw new Error('load_image of a folder: ' + m);
            out.load_folder = m;
            window.__of.victim = await G.grantPath(__V__);
            window.__of.grown = await G.grantPath(__GR__);
            return out;
        """, DIR=self.dir.replace("\\", "/"), V=victim, GR=grown)
        os.remove(victim)
        with open(grown, "ab") as f:
            f.write(b"more")
        res.update(await self.js("""
            const gr = window.__of.victim;
            let m = null;
            try { await G.grantedFile(gr); } catch (e) { m = String(e.message || e); }
            if (m !== 'victim.png is not there any more') throw new Error('a file gone after its grant: ' + m);
            await wait(100);
            const after = await fetch(gr.url);
            if (after.status !== 404 || (await after.text()) !== 'no such file') throw new Error('its token answers ' + after.status);
            const gw = window.__of.grown;
            m = null;
            try { await G.grantedFile(gw); } catch (e) { m = String(e.message || e); }
            if (!m || !/^grown\\.png changed while it was read \\(\\d+ of \\d+ bytes\\): open it again$/.test(m)) throw new Error('a file grown after its grant: ' + m);
            return { gone_after_grant: 'victim.png is not there any more', grown_after_grant: m };
        """))
        return res

    async def an_open_beside_a_picture_goes_to_a_new_tab(self):
        return await self.js("""
            if (!hasHook) return { skipped: 'a packaged build: no test hook' };
            const F = __F__;
            const W = watched();
            await window.scumble.file.testOpen(F.path);
            await settle(W, 'the first open');
            const first = W.ed, before = view(first), n0 = host.editors().length;
            const r = await window.scumble.file.testOpen(__J__);
            const ed = await until(() => host.editor !== first && host.editor.base ? host.editor : null, 60000, 'a new tab with the picture');
            g.docs.push(ed);
            if (JSON.stringify(view(first)) !== JSON.stringify(before)) throw new Error('the tab with a picture changed');
            if (host.editors().length !== n0 + 1) throw new Error('tabs ' + n0 + ' -> ' + host.editors().length);
            return { tabs: [n0, host.editors().length], first: [first.width, first.height], second: ed.base.ref.filename };
        """, F=self.files["doc.png"], J=self.files["photo.jpg"]["path"])

    async def cleanup(self):
        res = await self.js("""
            let n = 0;
            for (const ed of g.docs.splice(0)) { if (host.editors().includes(ed)) { await run('close_document', { doc: ed.node.id, force: true }).catch(() => {}); n++; } }
            document.querySelectorAll('#__of_input').forEach((x) => x.remove());
            return { closed: n };
        """)
        shutil.rmtree(self.dir, ignore_errors=True)
        return res

    async def run_step(self, name, fn):
        try:
            res = await fn()
            print("[ok] %s: %s" % (name, json.dumps(res, ensure_ascii=False)[:600]), flush=True)
            return True
        except Exception as err:  # noqa: BLE001
            print("[FAIL] %s: %s" % (name, str(err)[:1200]), flush=True)
            return False


STEPS = ["grantedfiles_route", "videofiles_route", "fixtures", "the_file_arrives_byte_for_byte", "each_route_opens_the_same_layers_as_a_drop",
         "the_token_is_released", "an_open_beside_a_picture_goes_to_a_new_tab", "a_scumble_document_still_opens", "worded_refusals"]


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
