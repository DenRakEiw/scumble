"""Build the px kernels (crates/px) into renderer/editor/px/px.wasm and px_scalar.wasm.

    python tools/build_px.py            build both variants and copy them into place
    python tools/build_px.py --check    build both and compare against the committed files

Both variants set RUSTFLAGS (which replaces crates/px/.cargo/config.toml's flags): the target features, and
path remaps so no path of this machine ends up in a binary (CI rebuilds them elsewhere and compares
bytes). Each variant has its own target directory so the two builds never invalidate each other. The compiler is pinned by
crates/px/rust-toolchain.toml. docs/PLAN_BCE.md §B0.
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CRATE = os.path.join(ROOT, "crates", "px")
OUT = os.path.join(ROOT, "renderer", "editor", "px")
TARGET = "wasm32-unknown-unknown"

VARIANTS = [
    # (output name, target dir, target features)
    ("px.wasm", "simd", "-C target-feature=+simd128,+bulk-memory"),
    ("px_scalar.wasm", "scalar", "-C target-feature=+bulk-memory"),
]


def remaps():
    cargo_home = os.environ.get("CARGO_HOME") or os.path.join(os.path.expanduser("~"), ".cargo")
    return [f"--remap-path-prefix={CRATE}=/px", f"--remap-path-prefix={cargo_home}=/cargo"]


def cargo():
    home = os.path.join(os.path.expanduser("~"), ".cargo", "bin")
    exe = shutil.which("cargo") or shutil.which("cargo", path=home)
    if not exe:
        sys.exit("cargo not found: install rustup (winget install --id Rustlang.Rustup -e)")
    return exe


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def build(name, tdir, flags):
    env = dict(os.environ)
    env.pop("RUSTFLAGS", None)
    env.pop("CARGO_ENCODED_RUSTFLAGS", None)
    # the encoded form (0x1f between flags) survives spaces in a path
    env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(flags.split() + remaps())
    target_dir = os.path.join(CRATE, "target", tdir)
    cmd = [cargo(), "build", "--release", "--locked", "--target", TARGET, "--target-dir", target_dir]
    print(">", " ".join(cmd), f"(RUSTFLAGS={flags!r})" if flags else "")
    subprocess.run(cmd, cwd=CRATE, env=env, check=True)
    return os.path.join(target_dir, TARGET, "release", "px.wasm")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="compare with the committed files, write nothing")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    bad = 0
    for name, tdir, flags in VARIANTS:
        built = build(name, tdir, flags)
        dst = os.path.join(OUT, name)
        size = os.path.getsize(built)
        if args.check:
            same = os.path.exists(dst) and sha(dst) == sha(built)
            print(f"{name}: {size} bytes, {'identical' if same else 'DIFFERS'}")
            bad += 0 if same else 1
        else:
            shutil.copyfile(built, dst)
            print(f"{name}: {size} bytes, sha256 {sha(dst)[:16]}")
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
