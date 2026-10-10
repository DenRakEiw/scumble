"""Print a release body: the "Get Scumble" block, then that version's section of CHANGELOG.md.

    python tools/release_notes.py 0.1.3              # the block without sizes, then the section
    python tools/release_notes.py v0.1.3             # a tag works too
    python tools/release_notes.py v0.1.3 --assets    # the block with each file's size, read from the release

The block on top is a heading "### Get Scumble", a table of the ways to get this version (the Microsoft Store and
winget, the Windows installer, the portable zip, the Linux AppImage and .deb, each with its direct link), one line
saying that latest.yml, latest-linux.yml and the .blockmap are for the app's updater, and a horizontal rule. It is a
table and never a bulleted list: the app's update question takes every top-level bullet's bold lead of the release
body as a change (electron/main/updater.js releaseHeadlines), and the app drops this block, from its heading to the
rule after it, before it shows the notes (updater.js withoutDownloads). The block is not part of CHANGELOG.md.

`--assets` reads the release's files read-only (`gh release view <tag> --repo DenRakEiw/scumble --json assets`) and
adds a size column (a dash for the Store and for a file the release does not hold yet); without it the table has no
size column. It exits 3 when gh cannot read the release.

Used by .github/workflows/build.yml when it creates the draft release (without sizes) and again after both builds
uploaded their files (with --assets, a draft only), and by hand when a release body needs fixing afterwards:

    python tools/release_notes.py v0.1.3 --assets > notes.md
    gh release edit v0.1.3 --repo DenRakEiw/scumble --notes-file notes.md

Exits 1 with a message on stderr when the version has no section, so a release never goes out with someone else's
notes; 2 on wrong arguments.
"""
import io
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "DenRakEiw/scumble"
STORE_ID = "9NDBTNNMXF2R"
STORE_URL = "https://apps.microsoft.com/detail/" + STORE_ID


def section(version):
    version = version.lstrip("vV").strip()
    text = io.open(os.path.join(ROOT, "CHANGELOG.md"), encoding="utf-8").read()
    # "## 0.1.3 — 2026-09-10" up to the next "## " or the end
    pattern = re.compile(r"^##\s+" + re.escape(version) + r"\b.*?$(.*?)(?=^##\s|\Z)", re.M | re.S)
    m = pattern.search(text)
    if not m:
        return None
    return m.group(1).strip("\n")


def files(version):
    """The downloads of a release, as electron-builder, tools/portable_zip.js and tools/mcpb_build.js name them on GitHub."""
    return {
        "exe": f"Scumble-Setup-{version}.exe",
        "zip": f"Scumble-{version}-portable-win-x64.zip",
        "appimage": f"scumble-{version}.AppImage",
        "deb": f"scumble-{version}.deb",
        "mcpb": f"scumble-{version}.mcpb",
    }


def asset_sizes(tag):
    """{asset name: bytes} of the release, read-only through gh; None when gh cannot read it."""
    try:
        r = subprocess.run(["gh", "release", "view", tag, "--repo", REPO, "--json", "assets"],
                           capture_output=True, text=True, encoding="utf-8", timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        print(f"release_notes: gh did not run: {e}", file=sys.stderr)
        return None
    if r.returncode != 0:
        print(f"release_notes: gh release view {tag} failed: {r.stderr.strip()}", file=sys.stderr)
        return None
    try:
        return {a["name"]: int(a["size"]) for a in json.loads(r.stdout).get("assets", [])}
    except (ValueError, KeyError, TypeError) as e:
        print(f"release_notes: gh answered something else: {e}", file=sys.stderr)
        return None


def human(size):
    """Bytes as GitHub's asset list shows them (MB of 1,048,576 bytes), or a dash when not known."""
    if size is None:
        return "–"
    mb = size / 1048576
    if mb >= 10:
        return f"{round(mb):d} MB"
    if mb >= 1:
        return f"{mb:.1f} MB"
    return f"{max(1, round(size / 1024)):d} KB"


def block(version, sizes=None):
    """The "Get Scumble" block for a version; `sizes` ({name: bytes}) adds the size column."""
    base = f"https://github.com/{REPO}/releases/download/v{version}/"
    f = files(version)
    early = "Early build made by CI, not tested by the author yet."
    rows = [
        ("**Microsoft Store** (Windows)", f"[Scumble in the Store]({STORE_URL}) or `winget install {STORE_ID}`", None,
         "Signed by Microsoft and updated by the Store; a new version can reach the Store a few days after GitHub "
         "(Microsoft's certification)."),
        ("**Windows installer**", f"[{f['exe']}]({base}{f['exe']})", f["exe"],
         "Updates itself; not code-signed yet, so SmartScreen asks once."),
        ("**Windows portable**", f"[{f['zip']}]({base}{f['zip']})", f["zip"],
         "No install: unpack and start `Scumble.exe`; keeps its data in a folder beside it and does not update "
         "itself."),
        ("**Linux AppImage**", f"[{f['appimage']}]({base}{f['appimage']})", f["appimage"], early),
        ("**Linux .deb**", f"[{f['deb']}]({base}{f['deb']})", f["deb"], early),
        ("**Claude Desktop extension**", f"[{f['mcpb']}]({base}{f['mcpb']})", f["mcpb"],
         "Adds Scumble's MCP tools to Claude Desktop with one click; needs Scumble installed (any of the above)."),
    ]
    out = ["### Get Scumble", ""]
    if sizes is None:
        out += ["| Package | Download | Notes |", "| --- | --- | --- |"]
        out += [f"| {name} | {link} | {note} |" for name, link, _, note in rows]
    else:
        out += ["| Package | Download | Size | Notes |", "| --- | --- | --- | --- |"]
        out += [f"| {name} | {link} | {human(sizes.get(asset) if asset else None)} | {note} |"
                for name, link, asset, note in rows]
    out += [
        "",
        "The other files of this release (`latest.yml`, `latest-linux.yml` and the `.blockmap`) are for the app's "
        "updater; you do not need to download them.",
        "",
        "---",
        "",
    ]
    return "\n".join(out)


def main(argv):
    args = [a for a in argv if a != "--assets"]
    with_assets = len(args) != len(argv)
    if len(args) != 1 or args[0].startswith("-"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    version = args[0].lstrip("vV").strip()
    body = section(version)
    if body is None:
        print(f"CHANGELOG.md has no section for {args[0]}", file=sys.stderr)
        return 1
    sizes = None
    if with_assets:
        sizes = asset_sizes("v" + version)
        if sizes is None:
            return 3
        for name in files(version).values():
            if name not in sizes:
                print(f"release_notes: v{version} holds no {name} yet (its size is a dash)", file=sys.stderr)
    sys.stdout.write(block(version, sizes) + "\n" + body + "\n")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")   # LF bodies on Windows too
    sys.exit(main(sys.argv[1:]))
