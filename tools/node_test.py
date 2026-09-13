"""The ComfyUI node's flavour of the editor, without ComfyUI (docs/BUILD_NODE.md).

    python tools/node_test.py [--node PATH]

Serves the node's js/ (as tools/build_node.py wrote it) under /extensions/ComfyUI-InpaintCanvas/
next to stand-ins for ComfyUI's /scripts/app.js and /scripts/api.js (tools/node_test/), loads
tools/node_test/index.html in a hidden Electron window and reads the steps it records: the
extension registers, a node is created with its editor (the constructor threw "host is not
defined" in the node from 2026-09-10 to C0), the editor opens as an overlay with the node's
title, close button and wording, a base image goes through the upload path and composites,
setting targets / result input / widget values come from the graph, and it closes again.
Then a canvas_state in the 0.1.11 format (tools/node_test/state_0_1_11.json: a masked image
layer, a masked filter layer, a paint layer, a text layer, a selection PNG on a document above
1 MP, a saved selection) goes in through the node's canvas_state widget, with a getValue while it
loads (what ComfyUI's graph serialize does): layer count, px / maskPx sizes, pixels, getBounds, the
composite, getValue's layers JSON and its selection PNG decoded are checked; and the MCP bridge
answers list_layers, screenshot what=layer, a screenshot of the picture with the selection overlay,
get_state and an error, delivered as the websocket's inpaint_canvas.command event and answered to
/inpaint_canvas/reply (both stand-ins).

This is not the browser gate against a real ComfyUI page; it catches what the build can break
in the node before anyone opens ComfyUI.
"""
import argparse
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_NODE = r"F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-InpaintCanvas"
ELECTRON = os.path.join(ROOT, "node_modules", "electron", "dist", "electron.exe" if os.name == "nt" else "electron")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", default=DEFAULT_NODE)
    args = ap.parse_args()
    fixtures = os.path.join(HERE, "node_test")
    with tempfile.TemporaryDirectory(prefix="scumble_node_test_") as tmp:
        site = os.path.join(tmp, "site")
        os.makedirs(os.path.join(site, "scripts"))
        shutil.copyfile(os.path.join(fixtures, "app.js"), os.path.join(site, "scripts", "app.js"))
        shutil.copyfile(os.path.join(fixtures, "api.js"), os.path.join(site, "scripts", "api.js"))
        shutil.copyfile(os.path.join(fixtures, "index.html"), os.path.join(site, "index.html"))
        shutil.copyfile(os.path.join(fixtures, "state_0_1_11.json"), os.path.join(site, "state_0_1_11.json"))
        shutil.copytree(os.path.join(args.node, "js"), os.path.join(site, "extensions", "ComfyUI-InpaintCanvas"))

        class Quiet(http.server.SimpleHTTPRequestHandler):
            extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}

            def __init__(self, *a, **k):
                super().__init__(*a, directory=site, **k)

            def log_message(self, *a):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = "http://127.0.0.1:%d/index.html" % server.server_address[1]
        env = dict(os.environ)
        env.pop("ELECTRON_RUN_AS_NODE", None)
        proc = subprocess.run([ELECTRON, "--user-data-dir=" + os.path.join(tmp, "profile"), os.path.join(fixtures, "main.js"), url],
                              capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180, env=env)
        server.shutdown()
    line = next((l for l in proc.stdout.splitlines() if l.startswith("NODE_TEST_RESULT ")), None)
    result = json.loads(line[len("NODE_TEST_RESULT "):]) if line else None
    if not result:
        print("FAIL: the page reported nothing")
        print(proc.stdout[-2000:], proc.stderr[-2000:])
        return 1
    ok = True
    for s in result["steps"]:
        print("[%s] %s%s" % ("ok" if s["ok"] else "FAIL", s["name"], ("  " + s["detail"][:300]) if s["detail"] else ""))
        ok = ok and s["ok"]
    for e in result.get("errors") or []:
        print("  page error:", e[:300])
        ok = False
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
