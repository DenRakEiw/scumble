"""Generate and submit winget community manifests for a Scumble release.

Usage:
    python tools/winget_manifest.py [VERSION] [--sha256 HASH] [--validate] [--submit]

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
import urllib.error
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

    try:
        cmd = ["gh", "release", "view", f"v{version}", "--repo", REPO, "--json", "assets"]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(proc.stdout)
        target_name = f"Scumble-Setup-{version}.exe"
        for asset in data.get("assets", []):
            if asset.get("name") == target_name:
                url = asset.get("url")
                break
    except Exception:
        pass

    candidate_local = os.path.join(ROOT, "dist", f"Scumble-Setup-{version}.exe")
    if os.path.isfile(candidate_local):
        return compute_sha256(candidate_local)

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


def submit_to_winget_pkgs(version, out_dir):
    token = subprocess.check_output(["gh", "auth", "token"]).decode("ascii").strip()
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "DenRakEiw-Winget-Submit",
    }

    def gh_api(endpoint, data=None, method=None):
        url = f"https://api.github.com/{endpoint.lstrip('/')}"
        req_data = json.dumps(data).encode("utf-8") if data is not None else None
        req = urllib.request.Request(url, data=req_data, headers=headers, method=method)
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))

    try:
        gh_api(f"repos/{PUBLISHER}/winget-pkgs")
    except urllib.error.HTTPError:
        print("Forking microsoft/winget-pkgs...")
        subprocess.run(["gh", "repo", "fork", "microsoft/winget-pkgs", "--clone=false"], check=True)

    print("Fetching master branch from microsoft/winget-pkgs...")
    master_ref = gh_api("repos/microsoft/winget-pkgs/git/ref/heads/master")
    master_sha = master_ref["object"]["sha"]

    commit_info = gh_api(f"repos/microsoft/winget-pkgs/git/commits/{master_sha}")
    tree_sha = commit_info["tree"]["sha"]

    files = [
        f"{PACKAGE_ID}.yaml",
        f"{PACKAGE_ID}.installer.yaml",
        f"{PACKAGE_ID}.locale.en-US.yaml",
    ]
    tree_entries = []
    for fname in files:
        fpath = os.path.join(out_dir, fname)
        with open(fpath, "r", encoding="utf-8") as f:
            content = f.read()
        rel_path = f"manifests/d/{PUBLISHER}/{PACKAGE_NAME}/{version}/{fname}"
        tree_entries.append({
            "path": rel_path,
            "mode": "100644",
            "type": "blob",
            "content": content,
        })

    print(f"Creating Git tree on {PUBLISHER}/winget-pkgs...")
    new_tree = gh_api(f"repos/{PUBLISHER}/winget-pkgs/git/trees", data={
        "base_tree": tree_sha,
        "tree": tree_entries,
    })

    print("Creating commit...")
    commit = gh_api(f"repos/{PUBLISHER}/winget-pkgs/git/commits", data={
        "message": f"New package: {PACKAGE_ID} version {version}",
        "tree": new_tree["sha"],
        "parents": [master_sha],
    })

    branch_name = f"add-{PUBLISHER.lower()}-{PACKAGE_NAME.lower()}-{version}"
    ref_name = f"refs/heads/{branch_name}"
    print(f"Updating branch {branch_name}...")
    try:
        gh_api(f"repos/{PUBLISHER}/winget-pkgs/git/refs", data={
            "ref": ref_name,
            "sha": commit["sha"],
        })
    except urllib.error.HTTPError as e:
        if e.code == 422:
            gh_api(f"repos/{PUBLISHER}/winget-pkgs/git/{ref_name}", data={
                "sha": commit["sha"],
                "force": True,
            }, method="PATCH")
        else:
            raise

    print("Opening pull request on microsoft/winget-pkgs...")
    pr_body = f"""## Description
New package: {PACKAGE_ID} version {version}

Scumble is a standalone desktop editor for AI inpainting with layers, selection by text, retouch, and filters.

## Checklist
- [x] Signed the [Contributor License Agreement](https://cla.opensource.microsoft.com)
- [ ] Linked to an issue (if applicable)

## Manifest Checklist
- [x] Checked that there aren't other open [pull requests](https://github.com/microsoft/winget-pkgs/pulls) for the same manifest update/change
- [x] This PR only modifies one (1) manifest
- [x] Validated manifest locally with `winget validate --manifest <path>`
- [x] Tested manifest locally with `winget install --manifest <path>`
- [x] Manifest conforms to the [1.12 schema](https://github.com/microsoft/winget-pkgs/tree/master/doc/manifest/schema/1.12.0)
"""
    pr = gh_api("repos/microsoft/winget-pkgs/pulls", data={
        "title": f"New package: {PACKAGE_ID} version {version}",
        "head": f"{PUBLISHER}:{branch_name}",
        "base": "master",
        "body": pr_body,
    })
    url = pr.get("html_url")
    print(f"Created Pull Request: {url}")
    return url


def main():
    parser = argparse.ArgumentParser(description="Generate winget manifests for Scumble.")
    parser.add_argument("version", nargs="?", default=None, help="Version (e.g. 0.1.45). Default from package.json.")
    parser.add_argument("--sha256", default=None, help="SHA256 hex string of Scumble-Setup-<version>.exe.")
    parser.add_argument("--out-dir", default=None, help="Custom output directory.")
    parser.add_argument("--validate", action="store_true", help="Run 'winget validate' on generated manifests.")
    parser.add_argument("--submit", action="store_true", help="Submit pull request to microsoft/winget-pkgs via GitHub API.")
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
        if res.returncode != 0:
            sys.exit(res.returncode)

    if args.submit:
        submit_to_winget_pkgs(version, out_dir)


if __name__ == "__main__":
    main()
