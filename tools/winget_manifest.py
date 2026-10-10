"""Generate winget community manifests for a Scumble release.

Usage:
    python tools/winget_manifest.py [VERSION] [--sha256 HASH] [--validate]

If VERSION is omitted, it is read from package.json.
If --sha256 is omitted, the script checks for:
    1. dist/Scumble-Setup-<version>.exe (or dist/Scumble Setup <version>.exe)
    2. gh release view v<version> --json assets
    3. download header / hash calculation from GitHub releases URL.

Output directory:
    dist/winget/manifests/d/DenRakEiw/Scumble/<version>/
        DenRakEiw.Scumble.yaml
        DenRakEiw.Scumble.installer.yaml
        DenRakEiw.Scumble.locale.en-US.yaml
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "DenRakEiw/scumble"
PUBLISHER = "DenRakEiw"
PACKAGE_NAME = "Scumble"
PACKAGE_ID = "DenRakEiw.Scumble"
SCHEMA_VERSION = "1.6.0"


def read_package_version():
    pkg_path = os.path.join(ROOT, "package.json")
    with open(pkg_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data["version"]


def compute_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest().upper()


def fetch_sha256_from_url(url):
    h = hashlib.sha256()
    sys.stderr.write(f"Downloading {url} to compute SHA256...\n")
    with urllib.request.urlopen(url) as resp:
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest().upper()


def get_installer_sha256(version, explicit_sha=None):
    if explicit_sha:
        return explicit_sha.upper().strip()

    # Try gh release view first if gh is installed
    try:
        cmd = ["gh", "release", "view", f"v{version}", "--repo", REPO, "--json", "assets"]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(proc.stdout)
        target_name = f"Scumble-Setup-{version}.exe"
        for asset in data.get("assets", []):
            if asset.get("name") == target_name:
                url = asset.get("url")
                # If gh gives download url
                break
    except Exception:
        pass

    # Try downloading or inspecting local files
    candidate_local = os.path.join(ROOT, "dist", f"Scumble-Setup-{version}.exe")
    if os.path.isfile(candidate_local):
        return compute_sha256(candidate_local)

    # Check release URL directly
    url = f"https://github.com/{REPO}/releases/download/v{version}/Scumble-Setup-{version}.exe"
    try:
        return fetch_sha256_from_url(url)
    except Exception as e:
        sys.stderr.write(f"Could not download installer from {url}: {e}\n")

    raise RuntimeError(f"Could not determine SHA256 for Scumble-Setup-{version}.exe. Specify with --sha256.")


def generate_manifests(version, sha256, out_dir):
    os.makedirs(out_dir, exist_ok=True)

    version_yaml = f"""# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.{SCHEMA_VERSION}.schema.json

PackageIdentifier: {PACKAGE_ID}
PackageVersion: {version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: {SCHEMA_VERSION}
"""

    installer_yaml = f"""# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.{SCHEMA_VERSION}.schema.json

PackageIdentifier: {PACKAGE_ID}
PackageVersion: {version}
Platform:
- Windows.Desktop
InstallerType: nullsoft
Scope: user
InstallModes:
- interactive
- silent
- silentWithProgress
InstallerSwitches:
  Silent: /S
  SilentWithProgress: /S
UpgradeBehavior: install
Commands:
- scumble
Protocols:
- scumble
FileExtensions:
- scumble
ReleaseDate: 2026-10-10
Installers:
- Architecture: x64
  InstallerUrl: https://github.com/{REPO}/releases/download/v{version}/Scumble-Setup-{version}.exe
  InstallerSha256: {sha256}
ManifestType: installer
ManifestVersion: {SCHEMA_VERSION}
"""

    locale_yaml = f"""# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.{SCHEMA_VERSION}.schema.json

PackageIdentifier: {PACKAGE_ID}
PackageVersion: {version}
PackageLocale: en-US
Publisher: {PUBLISHER}
PublisherUrl: https://github.com/{PUBLISHER}
PublisherSupportUrl: https://github.com/{REPO}/issues
PackageName: {PACKAGE_NAME}
PackageUrl: https://www.denrakeiw.com/scumble
License: GPL-3.0
LicenseUrl: https://github.com/{REPO}/blob/main/LICENSE
Copyright: Copyright (c) 2026 {PUBLISHER}
ShortDescription: "Standalone desktop editor for AI inpainting: layers, selection by text, retouch, and filters."
Description: |-
  Scumble is a standalone desktop editor for AI inpainting with layers, selection by text, retouch, filter layers, color match per layer, text, and PSD/ORA export. Local rendering runs through your own ComfyUI, API rendering through fal.ai and direct providers, and SAM/RMBG in-app via ONNX.
Moniker: scumble
Tags:
- ai
- canvas
- comfyui
- editor
- image
- image-editing
- inpaint
- inpainting
- layers
- photo
- raster
- stable-diffusion
ReleaseNotesUrl: https://github.com/{REPO}/releases/tag/v{version}
ManifestType: defaultLocale
ManifestVersion: {SCHEMA_VERSION}
"""

    with open(os.path.join(out_dir, f"{PACKAGE_ID}.yaml"), "w", encoding="utf-8", newline="\n") as f:
        f.write(version_yaml)

    with open(os.path.join(out_dir, f"{PACKAGE_ID}.installer.yaml"), "w", encoding="utf-8", newline="\n") as f:
        f.write(installer_yaml)

    with open(os.path.join(out_dir, f"{PACKAGE_ID}.locale.en-US.yaml"), "w", encoding="utf-8", newline="\n") as f:
        f.write(locale_yaml)

    print(f"Generated winget manifests in: {out_dir}")


def main():
    parser = argparse.ArgumentParser(description="Generate winget manifests for Scumble.")
    parser.add_argument("version", nargs="?", default=None, help="Version (e.g. 0.1.45). Default from package.json.")
    parser.add_argument("--sha256", default=None, help="SHA256 hex string of Scumble-Setup-<version>.exe.")
    parser.add_argument("--out-dir", default=None, help="Custom output directory.")
    parser.add_argument("--validate", action="store_true", help="Run 'winget validate' on generated manifests.")
    args = parser.parse_args()

    version = args.version or read_package_version()
    version = version.lstrip("vV")

    sha256 = get_installer_sha256(version, args.sha256)
    print(f"Version: {version}")
    print(f"Installer SHA256: {sha256}")

    out_dir = args.out_dir or os.path.join(ROOT, "dist", "winget", "manifests", "d", PUBLISHER, PACKAGE_NAME, version)
    generate_manifests(version, sha256, out_dir)

    if args.validate:
        print(f"Validating with winget...")
        res = subprocess.run(["winget", "validate", "--manifest", out_dir], check=False)
        sys.exit(res.returncode)


if __name__ == "__main__":
    main()
