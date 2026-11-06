"""A loopback Comfy Cloud for the app's gates: tools/fake_comfy_v2.js served by tools/fake_comfy_v2_http.js.

Item 50 (docs/PLAN_LORAS.md LR5): the loras and commands gates run a Comfy Cloud recipe in the app against it. The
gate's own profile gets the mock as settings.comfycloud.base and a test key (a key starting "test-" goes only to a
test address, a real key never there: comfysdk.checkKey); a profile that already holds a Comfy Cloud key is left alone
(the step skips), so a run against an instance with the user's key never replaces it. Nothing reaches the network.
"""
import base64
import io
import json
import os
import subprocess
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEST_KEY = "test-loras-gate-0123456789"


def png_b64(w=64, h=48, rgb=(60, 120, 200)):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), rgb).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class FakeCloud:
    """`with FakeCloud(options) as fc:` fc.base (http://127.0.0.1:<port>), fc.state() (what it saw)."""

    def __init__(self, options):
        self.options = options
        self.proc = None
        self.base = None

    def __enter__(self):
        self.proc = subprocess.Popen(["node", os.path.join(ROOT, "tools", "fake_comfy_v2_http.js")], cwd=ROOT,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        self.proc.stdin.write(json.dumps(self.options))
        self.proc.stdin.close()
        line = self.proc.stdout.readline().strip()
        if not line.startswith("LISTEN "):
            err = self.proc.stderr.read()[-800:] if self.proc.poll() is not None else ""
            self.proc.kill()
            raise RuntimeError("the fake Comfy Cloud did not start: %r %s" % (line, err))
        self.base = "http://127.0.0.1:%s" % line.split()[1]
        return self

    def state(self):
        with urllib.request.urlopen(self.base + "/__state", timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))

    def __exit__(self, *exc):
        try:
            urllib.request.urlopen(urllib.request.Request(self.base + "/__quit", method="POST"), timeout=5).read()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            self.proc.kill()
        return False


# the page side: the mock and the test key into the gate's profile, or a skip when a Comfy Cloud key is stored there;
# CLOUD_RESTORE takes them out again (the earlier settings.comfycloud back, the test key cleared, the lists forgotten)
CLOUD_SETUP = r"""
const had = ((await window.scumble.keys.list()).keys || {}).comfycloud;
if (had && had.set) return { skipped: "a Comfy Cloud key is stored in this profile; the step never replaces it" };
window.__fcPrev = (await window.scumble.settings.get()).comfycloud || {};
await window.scumble.settings.set({ comfycloud: { ...window.__fcPrev, base: __BASE__ } });
await window.scumble.keys.set("comfycloud", __KEY__);
window.__fcKeyed = true;
return { keyed: true };
"""

CLOUD_RESTORE = r"""
if (window.__fcKeyed) {
    await window.scumble.keys.clear("comfycloud");
    await window.scumble.settings.set({ comfycloud: window.__fcPrev || {} });
    window.__fcKeyed = false;
}
const h = (await import('./editor/host.js')).host;
h._cloudLoras = null;
return 1;
"""


def setup_js(base, key=TEST_KEY):
    """The page's setup for this mock; `key` a test key of the gate's own (main keeps a node list and LoRA lists per key,
    so two gates in one instance each take their own)."""
    return CLOUD_SETUP.replace("__BASE__", json.dumps(base)).replace("__KEY__", json.dumps(key))
