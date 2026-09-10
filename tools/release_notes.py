"""Print one version's section of CHANGELOG.md, for the release body.

    python tools/release_notes.py 0.1.3        # the section for that version
    python tools/release_notes.py v0.1.3       # a tag works too

Used by .github/workflows/build.yml when it creates the draft release, and by hand when a
release body needs fixing afterwards:

    gh release edit v0.1.3 --notes "$(python tools/release_notes.py 0.1.3)"

Exits 1 with a message on stderr when the version has no section, so a release never goes
out with someone else's notes.
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def section(version):
    version = version.lstrip("vV").strip()
    text = io.open(os.path.join(ROOT, "CHANGELOG.md"), encoding="utf-8").read()
    # "## 0.1.3 — 2026-09-10" up to the next "## " or the end
    pattern = re.compile(r"^##\s+" + re.escape(version) + r"\b.*?$(.*?)(?=^##\s|\Z)", re.M | re.S)
    m = pattern.search(text)
    if not m:
        return None
    return m.group(1).strip("\n")


def main():
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    body = section(sys.argv[1])
    if body is None:
        print(f"CHANGELOG.md has no section for {sys.argv[1]}", file=sys.stderr)
        return 1
    sys.stdout.write(body + "\n")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
