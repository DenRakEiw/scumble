"""Build the ComfyUI node's editor from this repo (docs/BUILD_NODE.md).

    python tools/build_node.py              write the editor into the node's js/ and record the hash
    python tools/build_node.py --check      write nothing: the node's js/ is what a build would write,
                                            and both hosts answer every host.* the editor calls
    python tools/build_node.py --node PATH  another checkout of ComfyUI-InpaintCanvas

renderer/editor/ is the source of the editor. The node keeps three files of its own:
js/host.js (what the editor asks ComfyUI), js/inpaint_node.js (the litegraph extension)
and js/inpaint_bridge.js (the MCP command bridge); the build never writes those. Every
generated file starts with a line saying where it comes from, and the node's DEVELOPMENT.md
carries the hash of the last build, so a hand edit in js/ shows up in --check.

The static checks, run by --check and after every build:
- every file parses as a module (node --input-type=module --check; a plain `node --check` on a
  .js file with import syntax exits 0 without parsing it, which a self-test guards against),
- every named import between the node's modules resolves to an export of the target,
- every host.<member> the editor modules use exists in the node's js/host.js and in
  renderer/editor/host.js (the node shipped a ReferenceError on `host` for three days
  because nothing checked this).
"""
import argparse
import glob
import hashlib
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "renderer", "editor")
DEFAULT_NODE = r"F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-InpaintCanvas"

# the editor modules both hosts load (paths under renderer/editor/, "/" separated); app-only files
# (host.js, stitch.js) stay here. px/ goes with the tile store (C2), which imports it: the kernels, their JS twins, the
# loader and the Rust build (BINARIES, copied byte for byte).
FILES = [
    "inpaint_canvas.js", "inpaint_filters.js", "inpaint_filters_gl.js", "inpaint_curves.js",
    "inpaint_text.js", "inpaint_raster.js", "inpaint_export.js", "inpaint_worker.js",
    "inpaint_compositor.js", "inpaint_brushes.js", "inpaint_pixels.js", "inpaint_tiles.js", "inpaint_arena.js", "inpaint_pool.js", "inpaint_png.js", "inpaint_bands.js",
    "inpaint_jobs.js", "inpaint_encode.js", "inpaint_upload.js", "inpaint_modal.js",
    "px/kernels_js.js", "px/kernels.js", "px/px.js",
]
BINARIES = ["px/px.wasm"]
NODE_OWN = ["host.js", "inpaint_node.js", "inpaint_bridge.js"]
HEADER = "// Generated from DenRakEiw/scumble renderer/editor/{name} by tools/build_node.py. Do not edit here: edit it in the app repo and build.\n"
DEV_MARK = "> **js/ is generated**"


def read(p):
    with open(p, "r", encoding="utf-8", newline="") as f:
        return f.read().replace("\r\n", "\n")


def write(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline=chr(10)) as f:
        f.write(text)


def generated(name):
    return HEADER.format(name=name) + read(os.path.join(SRC, name))


def font_files(base):
    out = []
    for p in sorted(glob.glob(os.path.join(base, "fonts", "**", "*"), recursive=True)):
        if os.path.isfile(p):
            out.append(os.path.relpath(p, base).replace("\\", "/"))
    return out


def tree_hash(js_dir):
    h = hashlib.sha256()
    for name in FILES + BINARIES + font_files(js_dir):
        p = os.path.join(js_dir, name)
        if not os.path.exists(p):
            continue
        h.update(name.encode() + b"\0")
        with open(p, "rb") as f:
            h.update(f.read().replace(b"\r\n", b"\n"))
        h.update(b"\0")
    return h.hexdigest()[:16]


def app_revision():
    try:
        sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "renderer/editor"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        return sha + ("+local changes" if dirty else "")
    except Exception:
        return "unknown"


# ---- static checks -----------------------------------------------------------------------------

EXPORT_DECL = re.compile(r"^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)", re.M)
EXPORT_LIST = re.compile(r"^export\s*\{([^}]*)\}", re.M)
IMPORT_NAMED = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*[\"'](\./[^\"']+)[\"']", re.M)
# const { a, b } = await import("./x.js")  (the node's host.js loads uploadBlob lazily)
IMPORT_DYNAMIC = re.compile(r"\{([^{}]*)\}\s*=\s*await\s+import\(\s*[\"'](\./[^\"']+)[\"']\s*\)")
HOST_USE = re.compile(r"\bhost\.([A-Za-z_$][\w$]*)")
HOST_KEY = re.compile(r"^    (?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|:)", re.M)


def exports_of(text):
    names = set(EXPORT_DECL.findall(text))
    for group in EXPORT_LIST.findall(text):
        for part in group.split(","):
            part = part.strip()
            if part:
                names.add(part.split(" as ")[-1].strip())
    return names


def host_members(host_text):
    start = host_text.find("export const host = {")
    if start < 0:
        return set()
    return set(HOST_KEY.findall(host_text[start:]))


def parses_as_module(text):
    r = subprocess.run(["node", "--input-type=module", "--check"], input=text.encode("utf-8"), capture_output=True)
    return r.returncode == 0, r.stderr.decode("utf-8", "replace").strip()


def check_dir(js_dir, label, problems):
    # every module under js/ (ComfyUI loads subfolders too), keyed by its "/" separated path
    texts = {}
    for p in glob.glob(os.path.join(js_dir, "**", "*.js"), recursive=True):
        rel = os.path.relpath(p, js_dir).replace("\\", "/")
        if not rel.startswith("fonts/"):
            texts[rel] = read(p)
    if parses_as_module("export const a = 1;\nconst = ;\n")[0]:
        problems.append("the parse check accepts a broken module: it checks nothing")
    for name, text in texts.items():
        ok, err = parses_as_module(text)
        if not ok:
            problems.append(f"{label}/{name}: does not parse: {[l for l in err.splitlines() if 'Error' in l][-1:] or err[-200:]}")
        if name != "host.js" and set(HOST_USE.findall(text)) - {"js"}:
            imported = any("host" in [x.strip().split(" as ")[-1].strip() for x in g.split(",")] for g, t in IMPORT_NAMED.findall(text) if t.endswith("host.js"))
            if not imported:
                problems.append(f"{label}/{name}: uses host.* but does not import host from ./host.js")
        for group, target in IMPORT_NAMED.findall(text) + IMPORT_DYNAMIC.findall(text):
            # resolved against the importing module's folder
            tname = os.path.normpath(os.path.join(os.path.dirname(name), target)).replace("\\", "/")
            if tname not in texts:
                problems.append(f"{label}/{name}: imports from {target}, which is not there")
                continue
            have = exports_of(texts[tname])
            for part in group.split(","):
                want = part.strip().split(" as ")[0].strip()
                if want and want not in have:
                    problems.append(f"{label}/{name}: imports {want} from {target}, which does not export it")
    return texts


def check_host(editor_texts, host_path, label, problems):
    members = host_members(read(host_path))
    used = set()
    for name in FILES:
        used |= set(HOST_USE.findall(editor_texts.get(name, "")))
    used.discard("js")   # "./host.js" in an import line
    for m in sorted(used - members):
        problems.append(f"{label}: the editor calls host.{m}, which {os.path.relpath(host_path, ROOT) if host_path.startswith(ROOT) else host_path} does not have")
    return used


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", default=DEFAULT_NODE)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    js_dir = os.path.join(args.node, "js")
    if not os.path.isdir(js_dir):
        sys.exit(f"node js folder not found: {js_dir}")
    for own in NODE_OWN:
        if not os.path.exists(os.path.join(js_dir, own)):
            sys.exit(f"the node's own {own} is missing in {js_dir}")

    problems = []
    if args.check:
        for name in FILES:
            p = os.path.join(js_dir, name)
            if not os.path.exists(p) or read(p) != generated(name):
                problems.append(f"node js/{name} differs from what renderer/editor/{name} builds (hand edit, or a build is due)")
        for name in BINARIES:
            p = os.path.join(js_dir, name)
            with open(os.path.join(SRC, name), "rb") as f:
                want = f.read()
            if not os.path.exists(p) or open(p, "rb").read() != want:
                problems.append(f"node js/{name} differs from renderer/editor/{name}")
        if sorted(font_files(js_dir)) != sorted(font_files(SRC)):
            problems.append("node js/fonts differs from renderer/editor/fonts")
        dev = read(os.path.join(args.node, "DEVELOPMENT.md"))
        m = re.search(re.escape(DEV_MARK) + r".*?build ([0-9a-f]{16})", dev)
        if not m or m.group(1) != tree_hash(js_dir):
            problems.append(f"node DEVELOPMENT.md records build {m.group(1) if m else 'none'}, js/ hashes to {tree_hash(js_dir)}")
    else:
        for name in FILES:
            write(os.path.join(js_dir, name), generated(name))
            print("wrote", name)
        for name in BINARIES:
            os.makedirs(os.path.dirname(os.path.join(js_dir, name)), exist_ok=True)
            shutil.copyfile(os.path.join(SRC, name), os.path.join(js_dir, name))
            print("copied", name)
        fonts_dst = os.path.join(js_dir, "fonts")
        if os.path.isdir(fonts_dst):
            shutil.rmtree(fonts_dst)
        shutil.copytree(os.path.join(SRC, "fonts"), fonts_dst)
        print("copied fonts", len(font_files(js_dir)), "files")
        digest = tree_hash(js_dir)
        dev_path = os.path.join(args.node, "DEVELOPMENT.md")
        dev = read(dev_path)
        line = (f"{DEV_MARK} (build {digest} from scumble {app_revision()}): every file in js/ except host.js, "
                "inpaint_node.js and inpaint_bridge.js comes from `renderer/editor/` in DenRakEiw/scumble through its "
                "`tools/build_node.py`. Edit the editor there, build, commit both repos.\n")
        lines = dev.split("\n")
        lines = [l for l in lines if not l.startswith(DEV_MARK)]
        at = 1 if lines and lines[0].startswith("# ") else 0
        lines[at:at] = ["", line.rstrip("\n")] if at else [line.rstrip("\n")]
        text = "\n".join(lines)
        text = re.sub(r"\n{3,}", "\n\n", text)
        write(dev_path, text)
        print("recorded build", digest, "in DEVELOPMENT.md")

    texts = check_dir(js_dir, "node js", problems)
    app_texts = {name: read(os.path.join(SRC, name)) for name in FILES}
    used = check_host(texts, os.path.join(js_dir, "host.js"), "node", problems)
    check_host(app_texts, os.path.join(SRC, "host.js"), "app", problems)
    if problems:
        for p in problems:
            print("PROBLEM", p)
        sys.exit(1)
    print(f"ok: {len(texts)} modules parse and resolve, {len(used)} host members answered by both hosts")


if __name__ == "__main__":
    main()
