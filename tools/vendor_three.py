"""Vendor three.js (MIT) into plugins/glb/vendor/ for the GLB layer plugin.

    npm pack three@<version>            # in a scratch folder, then tar -xzf the tgz
    python tools/vendor_three.py <path to the extracted package folder>

Copies the ES module build (three.module.js + three.core.js) and the four example modules the
plugin uses (GLTFLoader and its two utils, RoomEnvironment), rewriting their bare `from 'three'`
imports to a relative path, because the plugin folder is served as plain files without an
import map. Writes LICENSE and a NOTICE with the version. Re-run to upgrade.
"""
import io
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, "plugins", "glb", "vendor")

FILES = {
    "build/three.module.js": "three.module.js",
    "build/three.core.js": "three.core.js",
    "examples/jsm/loaders/GLTFLoader.js": "jsm/loaders/GLTFLoader.js",
    "examples/jsm/utils/BufferGeometryUtils.js": "jsm/utils/BufferGeometryUtils.js",
    "examples/jsm/utils/SkeletonUtils.js": "jsm/utils/SkeletonUtils.js",
    "examples/jsm/environments/RoomEnvironment.js": "jsm/environments/RoomEnvironment.js",
}


def main(src):
    with open(os.path.join(src, "package.json"), encoding="utf-8") as f:
        pkg = json.load(f)
    if os.path.isdir(DEST):
        shutil.rmtree(DEST)
    for rel, out in FILES.items():
        target = os.path.join(DEST, out)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        text = io.open(os.path.join(src, rel), encoding="utf-8", newline="").read()
        if out.startswith("jsm/"):
            depth = out.count("/")
            core = "../" * depth + "three.module.js"
            n = text.count("from 'three'")
            assert n == 1, (rel, n)
            text = text.replace("from 'three'", f"from '{core}'")
        io.open(target, "w", encoding="utf-8", newline="").write(text)
    shutil.copyfile(os.path.join(src, "LICENSE"), os.path.join(DEST, "LICENSE"))
    io.open(os.path.join(DEST, "NOTICE"), "w", encoding="utf-8", newline="\n").write(
        f"three.js {pkg['version']} ({pkg['license']}), https://threejs.org, vendored by tools/vendor_three.py.\n"
        "Files: " + ", ".join(FILES.values()) + ".\n"
        "The jsm modules' `from 'three'` imports are rewritten to a relative path; nothing else is changed.\n")
    total = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(DEST) for f in fs)
    print(f"three {pkg['version']} vendored into {DEST}: {len(FILES)} modules, {total / 1e6:.2f} MB")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1])
