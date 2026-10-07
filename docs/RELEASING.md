# Releasing Scumble

Read this before a release (moved out of CLAUDE.md on 2026-09-27, verbatim; CLAUDE.md keeps the short rules). A release
happens only on the user's word; everything before it may be prepared locally.

## The chain

**Every release:** the CHANGELOG section first, the version in `package.json`, `npm run dist`, `npm run dist:portable`,
exe gates `--offline` on both backends (0.1.30's list: `dist/gates/gates/rel30-exe*/summary.txt`), push, tag
`v<version>`, `gh run watch` the tag's build, the draft's assets checked, `gh release edit v<version> --draft=false`,
then the manual sync (`node tools/manual_sync.js`) and the dev blog post (the last section here; `time` is the
release's `published_at` in German time).

Before the tag: the exe gates `--offline` on both backends against `dist/win-unpacked/Scumble.exe`, each on its own
profile (`bash tools/run_gates.sh <label> --offline --exe dist/win-unpacked/Scumble.exe --tiles on|off <gates>`).

**The portable zip** (item 36, since 0.1.42): `npm run dist:portable` (`tools/portable_zip.js`) zips
`dist/win-unpacked` with the marker `portable.txt` into `dist/Scumble-<version>-portable-win-x64.zip` (one top folder
`Scumble\`, no `data`; about 180 MB, a few seconds). It comes **after `npm run dist` and before any `npm run
dist:store`**: dist:store rewrites `win-unpacked` without `resources\app-update.yml`, and the script refuses a layout
without it, of another version than `package.json`, or with a `data` folder in it. The tag build makes its own zip
the same way and adds it to the draft with `gh release upload` (and keeps it as the workflow artifact
`Scumble-windows-portable` on every run, so a failed upload can be redone by hand from that build). **The draft's
check before publishing:** `Scumble Setup <version>.exe`, its blockmap, `latest.yml`, the AppImage, the deb,
`latest-linux.yml` and `Scumble-<version>-portable-win-x64.zip`; the zip downloaded once and unpacked by hand
(Explorer's *Extract all*): one `Scumble` folder, `portable.txt` in it, no `data`, `resources\app-update.yml`
present, and it starts (on this machine only with the user's Scumble closed: a start without `--user-data-dir` that
missed the marker would use `%APPDATA%\Scumble`).

**The "Get Scumble" block** (from the release after 0.1.42 on; 0.1.42's published body only by hand, on the user's
word): `tools/release_notes.py` prints a fixed block above the CHANGELOG section: the heading `### Get Scumble`, a table
(the Microsoft Store with `winget install 9NDBTNNMXF2R`, the installer, the portable zip, the AppImage and the deb, each
with its direct link), one line saying `latest.yml`, `latest-linux.yml` and the `.blockmap` are for the updater, and a
rule. A table, never a bulleted list: the update question takes every top-level bullet's bold lead as a change, and
`electron/main/updater.js` (`withoutDownloads`) drops the block from its heading to the rule, so the app shows none of
it (`node tools/updater_test.js`). Copies up to 0.1.42 do not have that yet: offered a release with the block, they show
its rows as text at the top of *Settings › Updates* (the update question's list of changes is the same). The draft job
writes it without sizes; the `sizes` job at the end of the tag build writes the body again with `--assets` (each file's
size read from the release), for a draft only, only while the body is still the generated one, and never failing the
build. To fix a body by hand (a re-run, an edited draft, a published release on the user's word), from Git Bash
(PowerShell's `>` re-encodes the file): `python tools/release_notes.py v<version> --assets > notes.md`, then `gh release
edit v<version> --repo DenRakEiw/scumble --notes-file notes.md`. The block's wording lives in the script's `block()`,
not in CHANGELOG.md.

**The official MCP Registry** (listed since 2026-10-04, `docs/PLAN_MCP_LISTINGS.md`): after the release is published,
`server.json`'s `version` set to the new version (and its description if the tools changed; at most 100 characters),
committed, then `mcp-publisher validate` and `mcp-publisher publish` from the repo root (a published version is
immutable; the login is the user's GitHub device code, `mcp-publisher login github`, the CLI from
modelcontextprotocol/registry's releases, checksum against its `checksums.txt`). The tool count in `docs/MCP.md` and
the README follows `list_commands`.

## The release channel, signing and the Store

**A Store update goes with every release, clicked through in the user's Chrome** (the user, 2026-10-04): the Store
submission API needs a company account in Partner Center (an Entra app with the Manager role; "Individual accounts do
not support multiple users"), so Claude drives Partner Center in the user's logged-in Chrome (Claude in Chrome: Start
update, the upload, the What's new text) and clicks *Submit for certification* only after the user's yes in chat.
**The upload of the ~190 MB MSIX cannot go through the extension** (checked at 0.1.42, 2026-10-05: its file upload takes at most 10 MB per call), so the package is always the user's drag and drop; Claude in Chrome can still do *Start update*, the What's new text and the rest. If it does not work, the user's rule before:
a Store update only with essential changes, by hand (0.1.41 went that way, after the Comfy Cloud fix of 0.1.40). The
steps either way: `npm run
dist:store` (`dist/Scumble-<version>.msix`, built from the release's tag state; after `npm run dist:portable`, since it
rewrites `dist/win-unpacked`), a short "What's new in this version"
text in English, and the user's part in Partner Center (https://partner.microsoft.com/dashboard): Apps and games ›
Scumble › Start update; Packages: drop the new MSIX in, delete the old one, leave gradual rollout and mandatory off,
save; Store listings › English › What's new in this version, save; Submit for certification. Certification takes hours
to about three working days; the Store then updates its users by itself.

- Release channel: **GitHub Releases** of `DenRakEiw/scumble` (public since 2026-09-09).
  `electron-updater` reads `latest.yml` there; `.github/workflows/build.yml` builds the
  installer and the portable zip on `windows-latest` and publishes a **draft** release on a `v<version>` tag
  (the tag must match `package.json`); publishing the draft makes it visible to the app. A portable copy reads the
  same feed but never downloads: it offers the release page.
  **Every release needs its section in `CHANGELOG.md` first**: the workflow builds the
  release body from it through `tools/release_notes.py` and fails the tag build when the
  section is missing, and the app shows the same text in Settings › Updates before you
  restart into the new version.
  First releases are **unsigned**; code signing goes through the SignPath Foundation
  (free for OSS) once the project has a public release and some use, fallback Certum
  Open Source. Azure Trusted Signing is paid and not for individuals in the EU.
  **Before SignPath comes the Microsoft Store** (the user, 2026-09-23: qualifying for SignPath takes
  time, and a user who needs a signed installer should have one meanwhile). An **MSIX** submitted to
  the Store is **re-signed by Microsoft** after certification - no certificate to buy or hold - and a
  developer account has been free since 2025-09 for individuals and 2026-05 for companies (an identity
  check replaces the fee). **It signs only the Store copy: the GitHub installer stays unsigned** and
  keeps its SmartScreen paragraph, and submitting the `.exe` to the Store instead would require the
  publisher to sign it first, so this is a second channel, not a replacement. The build has to be
  `runFullTrust` (an AppContainer package cannot reach `127.0.0.1`, which would cut the app off from
  the user's ComfyUI), must not self-update (the Store updates its copy), and must register MCP by the
  execution alias rather than the versioned `WindowsApps` path, as the AppImage does. To be tested,
  not assumed: the single-instance pipe, the plugin folder and every `%APPDATA%` path (keys, autosave,
  file mirror) under a packaged app's redirection. GPL-3.0 is no obstacle (VLC and Krita are in the
  Store). `docs/CODE_SIGNING_POLICY.md` holds the whole decision.

## The dev blog post

- **Every published release also gets a post in the dev blog on the user's website**
  (https://www.denrakeiw.com/scumble/blog; the user, 2026-09-21). The site is the repo `F:\portfolio_web`
  (GitHub `DenRakEiw/Portfolio_vercel`, Next.js, deployed by Vercel). A post is one entry at the top of `devlog` in
  `lib/scumble-posts.ts` (slug `v0-1-NN`, `version`, `date`, `time` = the release's `publishedAt` from
  `gh release view` in German time with its offset, `release` link, title, summary, `body` paragraphs): the
  CHANGELOG section retold in a loose, personal first-person voice, in English like the rest of the site, no
  markdown in the strings; `hub.version` in `lib/scumble.ts` follows the release. Before the post, `node tools/manual_sync.js` (the manual and its reader, docs/PLAN_HELP.md), committed
  with it. `npx tsc --noEmit -p .` and
  `npx next build` before committing. **Who pushes matters: Vercel runs on a free (Hobby) account, which deploys
  only commits of its one owner.** Commit with the website repo's own identity (its local `user.email` is
  `schoenebergde@gmail.com` since 2026-09-25, when the user reconnected the Git account to Vercel: the deploys of
  that address go through, one of `dennis.schoeneberg@me.com` was blocked the same day), never as the `DenRakEiw`
  noreply address this repo uses, and **no `Co-Authored-By` trailer** (a second author blocks a Hobby deploy);
  stage only the files of the post. **Git deploys work again since 2026-09-25** (0.1.29's post went live by git,
  `db4197d`). Read the commit's status afterwards (`gh api repos/DenRakEiw/Portfolio_vercel/commits/<sha>/status`);
  should it say blocked again, deploy exactly that commit with the CLI from a clean export, never from the working
  tree: `git archive <sha> | tar -x -C <scratch>`, copy `.vercel/project.json` into it, `vercel --prod --yes`
  there. Then check the live page (posts are anchors on `/scumble/blog`, `#v0-1-NN`, not pages of their own).
