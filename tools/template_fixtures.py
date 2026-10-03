"""Fixtures for the role detection of graphs made for Comfy Cloud (item 35 V6, docs/PLAN_COMFY_VIEW.md): ComfyUI's
image-edit workflow templates (Comfy-Org/workflow_templates, MIT) and the node definitions they use.

    python tools/template_fixtures.py <templates folder> [ComfyUI URL]

Copies the image-edit templates of <templates folder> (the `templates` folder of the comfyui_workflow_templates_json
package) to tools/refs/comfy_templates/, with the package's MIT notice, and writes object_info.json: the /object_info
entries of every node type they use, read from the ComfyUI at the URL (default http://127.0.0.1:8188; one GET, queues
nothing). Run it again when the templates change; tools/recipes_test.js section 9 reads the result.
"""
import glob
import json
import os
import re
import shutil
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "refs", "comfy_templates")
EDIT = re.compile(r"^(image|template).*(edit|inpaint)", re.I)

MIT = """MIT License

Copyright (c) 2025 Comfy Org

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""


def types_of(wf):
    nodes = list(wf.get("nodes") or [])
    for d in (wf.get("definitions") or {}).get("subgraphs") or []:
        nodes += d.get("nodes") or []
    return {n.get("type") for n in nodes if n.get("type")}


def main():
    src = sys.argv[1]
    url = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8188").rstrip("/")
    os.makedirs(OUT, exist_ok=True)
    names = sorted(n for n in os.listdir(src) if n.endswith(".json") and EDIT.match(n) and "all_in_one" not in n)
    used = set()
    for n in names:
        wf = json.load(open(os.path.join(src, n), encoding="utf-8"))
        used |= types_of(wf)
        shutil.copyfile(os.path.join(src, n), os.path.join(OUT, n))
    info = json.load(urllib.request.urlopen(url + "/object_info", timeout=60))
    subset = {k: v for k, v in info.items() if k in used}
    with open(os.path.join(OUT, "object_info.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(subset, f, indent=0)   # the order of the inputs is the widget order: never sorted
    with open(os.path.join(OUT, "LICENSE"), "w", encoding="utf-8", newline="\n") as f:
        f.write(MIT)
    missing = sorted(t for t in used if t not in info)
    print(f"{len(names)} templates, {len(subset)} node types kept" + (f"; unknown to that ComfyUI (subgraph ids and the like): {len(missing)}" if missing else ""))


if __name__ == "__main__":
    main()
