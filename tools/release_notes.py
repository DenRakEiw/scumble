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
notes, and when the section holds an @token outside a code span (`@img1` written bare): GitHub reads it as a mention,
notifies that account and lists it among the release's contributors (it happened at 0.1.48-0.1.50). Each such token is
named with its line in CHANGELOG.md; write it in backticks. 2 on wrong arguments.

    python tools/release_notes.py Unreleased         # the check before the section is renamed (the links say vUnreleased)
    python tools/release_notes.py --self-test        # the mention check's cases and every section of CHANGELOG.md
"""
import contextlib
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


def changelog():
    return io.open(os.path.join(ROOT, "CHANGELOG.md"), encoding="utf-8").read()


def section_at(version, text=None):
    """(the version's section, the line of CHANGELOG.md its first line is on), or (None, None) when it has none."""
    version = version.lstrip("vV").strip()
    text = changelog() if text is None else text
    # "## 0.1.3 — 2026-09-10" up to the next "## " or the end
    pattern = re.compile(r"^##\s+" + re.escape(version) + r"\b.*?$(.*?)(?=^##\s|\Z)", re.M | re.S)
    m = pattern.search(text)
    if not m:
        return None, None
    body = m.group(1)
    lead = len(body) - len(body.lstrip("\n"))
    return body.strip("\n"), text.count("\n", 0, m.start(1) + lead) + 1


def section(version):
    return section_at(version)[0]


# a Markdown code span or fenced block (a run of backticks up to the same run), and a GitHub mention outside one: an @
# and a letter not right after a word character (an e-mail address) or a backtick
CODE_SPAN = re.compile(r"(`+).*?(?<!`)\1(?!`)", re.S)
MENTION = re.compile(r"(?<![\w`])@[A-Za-z][\w-]*")


def bare_mentions(text, first_line=1):
    """[(line, token)] of every @token outside a code span; `first_line` is the line `text` starts on."""
    blank = CODE_SPAN.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)
    return [(first_line + blank.count("\n", 0, m.start()), m.group(0)) for m in MENTION.finditer(blank)]


def checked_section(version, text=None):
    """(section, exit code): 1 with the reason on stderr when there is no section or it holds a bare @token."""
    body, line = section_at(version, text)
    if body is None:
        print(f"CHANGELOG.md has no section for {version}", file=sys.stderr)
        return None, 1
    found = bare_mentions(body, line)
    for ln, tok in found:
        print(f"CHANGELOG.md:{ln}: {tok} is outside a code span: GitHub would mention the account {tok[1:]} in the "
              f"release body; write it as `{tok}`", file=sys.stderr)
    if found:
        print(f"release_notes: the section for {version} holds {len(found)} bare @token(s); nothing printed",
              file=sys.stderr)
        return None, 1
    return body, 0


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
        ("**Microsoft Store** (Windows)", f"[Scumble in the Store]({STORE_URL}) or `winget install scumble`", None,
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


def self_test():
    """The mention check's cases, then every section of the real CHANGELOG.md; prints PASS / FAIL lines and RESULT."""
    fails = 0

    def case(name, got, want):
        nonlocal fails
        ok = got == want
        fails += not ok
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else f": got {got!r}, want {want!r}"))

    case("a bare @img1 is found", bare_mentions("- name it @img1 in the prompt"), [(1, "@img1")])
    case("@img1 in backticks passes", bare_mentions("- name it `@img1` in the prompt"), [])
    case("a double-backtick span with a backtick inside passes", bare_mentions("- ``a ` and @img1`` here"), [])
    case("a fenced block passes", bare_mentions("text\n```\n@img1 @img2\n```\nmore"), [])
    case("an e-mail address passes", bare_mentions("- 89697885+DenRakEiw@users.noreply.github.com"), [])
    case("a token in brackets and one with a dash are found, with their lines",
         bare_mentions("first\n(@Image2) and\nalso @img-3.", 10), [(11, "@Image2"), (12, "@img-3")])
    case("an @ before a digit passes", bare_mentions("- at @2x"), [])
    case("one spanned and one bare token: the bare one", bare_mentions("`@img1` but @img2"), [(1, "@img2")])
    text = ("# Changelog\n\nIntro.\n## 9.9.9 - 2026-11-07\n\n- **Edits** (\"@img1 is the bag\"), then more.\n\n"
            "## 9.9.8 - 2026-11-06\n\n- **Edits** (\"`@img1` is the bag\").\n")
    case("a section's bare token is named with its line in CHANGELOG.md",
         bare_mentions(*section_at("9.9.9", text)), [(6, "@img1")])
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        body, code = checked_section("v9.9.9", text)
    case("a section with a bare @img1 is refused (exit 1, the token and its line named)",
         (body, code, "CHANGELOG.md:6: @img1" in err.getvalue()), (None, 1, True))
    with contextlib.redirect_stderr(io.StringIO()):
        body, code = checked_section("9.9.8", text)
    case("a section with `@img1` in backticks is accepted", (code, body), (0, "- **Edits** (\"`@img1` is the bag\")."))
    with contextlib.redirect_stderr(io.StringIO()):
        case("a missing section is refused", checked_section("9.9.7", text), (None, 1))
    real = changelog()
    for m in re.finditer(r"^##\s+(\S+)", real, re.M):
        case(f"CHANGELOG.md's section {m.group(1)} holds no bare @token", bare_mentions(*section_at(m.group(1), real)), [])
    print(f"\nRESULT {'PASS' if not fails else 'FAIL'} ({fails} failed)")
    return 1 if fails else 0


def main(argv):
    if argv == ["--self-test"]:
        return self_test()
    args = [a for a in argv if a != "--assets"]
    with_assets = len(args) != len(argv)
    if len(args) != 1 or args[0].startswith("-"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    version = args[0].lstrip("vV").strip()
    body, code = checked_section(version)
    if body is None:
        return code
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
