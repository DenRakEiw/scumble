# An `.mcpb` bundle for Scumble's MCP server

**Status (2026-10-09): S1 and S2 built on the branch `mcpb`** (the starter, the manifest, `npm run dist:mcpb`, the `mcpb`
gate, CI, the "Get Scumble" row, `--server-json`, the docs; `node tools/mcpb_test.js --exe … --store` PASS on the
0.1.44 exe and the Store copy 0.1.42, the starter run from the unpacked bundle finds the installer copy). **S3, the
install in Claude Desktop (§7), is the user's hand test:** the desktop app is Claude's own window, which computer use
can never drive. **The first install (2026-10-09 17:38) timed out** ("Request timed out", three restarts): Claude
Desktop runs the server in a UtilityProcess (§1), where the starter's `stdio: "inherit"` reached nobody. Fixed the
same evening (the relay through `process.stdin` / `process.stdout`, the entry check through `process.argv[1]`),
proven in the rebuilt host (`tools/mcpb_utility.js`, part of the `mcpb` gate with `--exe`); the user installed the
rebuilt `.mcpb` again (the installed copy cannot be patched from here). **Passed 2026-10-09 18:19:** Claude Desktop's
log says "Connected to Scumble (109 tools)" in the UtilityProcess, `initialize` answered in 0.6 s, and in a chat
Claude Desktop listed the two open documents and the recipe (proxy mode on the user's window). Not yet looked at by
hand: the headless case (Scumble closed), the *Scumble.exe* field with a portable copy and with a wrong path (§7 3-4). The bundle for it: `.claude/worktrees/mcpb/dist/scumble-0.1.44.mcpb` (it names 0.1.44 because the
branch's `package.json` does; the release build names 0.1.45). The user's word (2026-10-09): released together with
0.1.45; merge into `main` when the Nik 9 agent's state allows. The user's ask: an MCP Bundle (`.mcpb`) so that Scumble installs
into Claude Desktop with one click, can be listed on Smithery, and has a chance at GitHub's MCP registry
(`docs/PLAN_MCP_LISTINGS.md` §2 "Build work"). Built on the branch `mcpb` in a worktree of its own
(`.claude/worktrees/mcpb`), nothing pushed, published, uploaded or registered without the user's word.

## 1. What exists and what the bundle has to do

**Scumble's server today.** `Scumble --mcp` is the stdio server (`docs/MCP.md`). Clients register the Node-mode
launcher, never the exe with `--mcp` (Electron's CR LF on stdout): `ELECTRON_RUN_AS_NODE=1 Scumble.exe
resources\app.asar\electron\main\mcp\launch.js --mcp`. *Help › Copy MCP registration* writes that with the running
install's paths (`electron/main/mcp/registration.js`). Three Windows installations exist, each started differently:

| Install | Where the exe is | How the launcher is started | Found by |
| --- | --- | --- | --- |
| GitHub installer (NSIS, per user; per machine on request) | `%LOCALAPPDATA%\Programs\Scumble\Scumble.exe` (or the folder the user chose) | `Scumble.exe <folder>\resources\app.asar\electron\main\mcp\launch.js --mcp`, `ELECTRON_RUN_AS_NODE=1` | the uninstall key `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\7198d4e4-8820-55de-a96d-85d8f5c1ecfe` (uuid v5 of the appId `app.scumble.desktop` in electron-builder's namespace `50e065bc-3134-11e6-9bab-38c9862bdaf3`, checked 2026-10-09): `InstallLocation` when set, else the folder of `UninstallString` (on this machine `InstallLocation` is empty and the key still says 0.1.11: the updater never rewrites it, the folder is right); then the default folder; HKLM for a per-machine install |
| Microsoft Store (MSIX) | `C:\Program Files\WindowsApps\DenRakEiw.Scumble_<version>_x64__eh52rqbjjrbdj\app\Scumble.exe`, a folder that changes with every update | the execution alias `%LOCALAPPDATA%\Microsoft\WindowsApps\scumble.exe` in Node mode with `-e <STORE_LAUNCH>` (the code in `registration.js` that loads the launcher from `process.resourcesPath`); arguments after `--` reach the launcher | the alias: `fs.existsSync` and `fs.statSync` answer false / EACCES for an app execution alias, **`fs.lstatSync` works** (a reparse point, `isSymbolicLink()` true; `readlinkSync` gives the version folder); measured 2026-10-09, and a Node-mode probe through the alias from plain Node answered 0.1.42's resources folder |
| Portable zip (item 36) | anywhere (`portable.txt` beside the exe) | as the installer | **not discoverable**: the user names the exe in the extension's settings (`user_config`) |

**How Claude Desktop runs a `node` server (read from its `app.asar`, 2.31226, on 2026-10-09 after the first bundle timed
out):** not as a child process with pipes. The main process forks an Electron **UtilityProcess** running its own
`.vite/build/mcp-runtime/nodeHost.js` with the entry point as an argument; that host replaces `process.stdout.write`
and `process.stderr.write` by functions that post `{type: "stdout" | "stderr", content}` over a MessagePort, replaces
`process.stdin`'s methods by those of a `Readable` it feeds with `{type: "stdin", data}` messages (one line each), sets
`process.argv` to `["node.exe", entry, ...args]` and loads the entry with `import()`. It also blocks spawning
`process.execPath` (the built-in Node is Claude's own exe). Three consequences for the starter: (1) a child given
`stdio: "inherit"` writes to the process's real handles, which nobody reads: the first bundle answered nothing and
`initialize` timed out after 120 s ("Couldn't start for Cowork and Code sessions. Error: Request timed out" in
`%LOCALAPPDATA%\Claude\logs\mcp-server-Scumble.log`); the starter relays by hand through `process.stdin` and
`process.stdout`; (2) `require.main === module` is never true under `import()`: the starter also takes
`process.argv[1] === __filename` as "started as the entry"; (3) the server is ended by killing the utility process:
the launcher's child must go with it (the launcher kills the app when its stdin ends; the relay ends the child's
stdin on the host's end / close). `tools/mcpb_utility.js` + `tools/mcpb_utility_host.js` rebuild this host for the
`mcpb` gate. The log of a running extension: `%LOCALAPPDATA%\Claude\logs\mcp-server-<name>.log` and `mcp.log` (the
`%APPDATA%\Claude\logs` folder is stale since August).

**Claude Desktop and MCPB.** An `.mcpb` is a zip with a `manifest.json` (spec 0.3, `@anthropic-ai/mcpb` 2.1.2, MIT:
`init`, `validate`, `pack`, `clean`, `sign`, `verify`, `info`, `unpack`). Opening the file in Claude Desktop shows the
install dialog; the bundle lands under `%APPDATA%\Claude\Claude Extensions\local.mcpb.<author>.<name>\` and a
`server.type: "node"` entry runs on the Node that ships with Claude Desktop (`command: "node"`), so the user needs no
Node of their own. `user_config` fields are asked in the extension's settings and reach the server as
`${user_config.<key>}` in `args` / `env`. The one extension on this machine (DaVinci Resolve's) is a `node` server
with `manifest_version` 0.3 and no `user_config`; what an **empty optional** `${user_config.x}` expands to (empty
string, or the literal) is not documented: the starter treats both as "not set", and the Claude Desktop test (§7 e)
settles it.

**The official registry's rules for an MCPB package** (`modelcontextprotocol/registry` docs, read 2026-10-09):
`packages[]` with `registryType: "mcpb"`, `identifier` = the file's URL on a **GitHub or GitLab release** (the URL
**must contain "mcp"**: `.mcpb` does), `fileSha256` **must** be given (clients verify it, the registry does not),
`transport: {type: "stdio"}`. GitHub's release assets now carry a `digest` (`sha256:…`, seen on 0.1.44's assets through
`gh release view --json assets`), so the hash needs no download. A draft release does not answer the registry's URL
check: publish the release first, then `server.json`.

**Scumble is not in the bundle.** The bundle is a thin starter (one plain-Node file, no dependencies, about 150
lines): it finds the installed Scumble and starts its launcher. The app, its updates and its data stay where they are;
the bundle changes only when the starter or the manifest changes, but it carries the version of the release it ships
with (the registry's `packages` entry is per version).

## 2. The bundle (`mcpb/` in the repo)

```
mcpb/
  manifest.json        the manifest; `version` "0.0.0" and `tools` [] are filled by the build (§4)
  server/index.js      the starter (§3)
  README.md            two paragraphs for people who unpack it (what it is, where Scumble comes from)
build/icon.png         copied in as icon.png (1024², the manifest's `icon`)
LICENSE                copied in (GPL-3.0, the same as the app)
```

`manifest.json`:

```json
{
  "manifest_version": "0.3",
  "name": "scumble",
  "display_name": "Scumble",
  "version": "0.0.0",
  "description": "Drive the Scumble AI inpainting editor: select by text, inpaint into layers, masks, filters, PSD/ORA export.",
  "long_description": "… what the tools do, that Scumble must be installed (installer, Microsoft Store or portable zip), where the pixels come from (the user's ComfyUI or their API keys), the link to docs/MCP.md …",
  "author": { "name": "DenRakEiw", "url": "https://github.com/DenRakEiw" },
  "homepage": "https://www.denrakeiw.com/scumble",
  "documentation": "https://github.com/DenRakEiw/scumble/blob/main/docs/MCP.md",
  "support": "https://github.com/DenRakEiw/scumble/issues",
  "repository": { "type": "git", "url": "https://github.com/DenRakEiw/scumble" },
  "license": "GPL-3.0",
  "icon": "icon.png",
  "server": {
    "type": "node",
    "entry_point": "server/index.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/index.js"],
      "env": { "SCUMBLE_EXE": "${user_config.scumble_exe}" }
    }
  },
  "user_config": {
    "scumble_exe": {
      "type": "file",
      "title": "Scumble.exe (optional)",
      "description": "Leave empty: the installed Scumble (GitHub installer or Microsoft Store) is found by itself. Set it for a portable copy or an install in another folder.",
      "required": false
    }
  },
  "tools": [],
  "tools_generated": true,
  "compatibility": { "platforms": ["win32"], "runtimes": { "node": ">=18.0.0" } },
  "keywords": ["image-editing", "inpainting", "layers", "photoshop-alternative", "comfyui"]
}
```

- `tools` is filled at build time from `docs/COMMANDS.md` (its `### \`name\`` headings and the first line below each,
  `.` written as `_`: 109 today), so the install dialog and Smithery show the real tools; `tools_generated: true`
  because plugins add tools at run time.
- Windows only for now: Claude Desktop runs on macOS and Windows and Scumble has no macOS build; the Linux builds
  were never run and no Claude Desktop exists for Linux. A Linux branch of the starter (the deb's
  `/opt/Scumble/scumble` with the launcher, an AppImage with `--mcp`) is a later ten lines.
- The bundle stays **unsigned** (`mcpb sign` needs a code-signing certificate, the same question as the installer's;
  `docs/CODE_SIGNING_POLICY.md`). Claude Desktop installs unsigned bundles; what it shows for one is read in §7 e.

## 3. The starter (`mcpb/server/index.js`)

Plain CommonJS Node, no dependency, no Electron API, the same rule as `launch.js`. Run as `main` it starts; required
it exports `find`, `plan` and the fallback for the tests.

**Finding Scumble**, in this order, the first hit wins:

1. **Explicit:** `--scumble <path>` on the command line, else `SCUMBLE_EXE` from the environment (the manifest's
   `user_config`). An empty value or the literal `${user_config.scumble_exe}` counts as not set. A path that is set
   but does not exist (`lstat`, so the Store alias counts) ends the search: the user asked for that file, so the
   answer names it instead of silently starting another install (§3 "When Scumble is missing").
2. **The installer:** `reg.exe query` (`%SystemRoot%\System32\reg.exe`) of the uninstall key under HKCU, then HKLM
   (a per-machine install): `InstallLocation`, else the folder of `UninstallString`'s quoted path; then
   `%LOCALAPPDATA%\Programs\Scumble\Scumble.exe` and `%ProgramFiles%\Scumble\Scumble.exe`. A hit needs both
   `Scumble.exe` and `resources\app.asar` in the folder (`portable.txt` beside it is fine: a portable copy that was
   named explicitly, or one that the key happens to name).
3. **The Store:** `%LOCALAPPDATA%\Microsoft\WindowsApps\scumble.exe` by `lstatSync`.
4. Nothing: the fallback server.

`%LOCALAPPDATA%` missing from Claude Desktop's environment is covered by `os.homedir()\AppData\Local`.

**Starting it.** `plan(found, extraArgs)` gives `{command, args, env}`:
- installer / portable / explicit exe: `command` = the exe, `args` = `[<folder>\resources\app.asar\electron\main\mcp\launch.js, ...extraArgs, "--mcp"]`, `env.ELECTRON_RUN_AS_NODE = "1"`;
- the Store alias (the alias path itself, or any exe under `\WindowsApps\`, so an explicit alias takes the same
  route): `command` = the alias, `args` = `["-e", STORE_LAUNCH, "--", ...extraArgs, "--mcp"]`, the same env.
  `STORE_LAUNCH` is copied verbatim from `registration.js` (the bundle cannot require the app; the test asserts the
  two strings are equal, so a change there fails the gate);
- `extraArgs` are the starter's own arguments after `--` (`--user-data-dir=<profile> --no-comfy` for the tests;
  Claude Desktop passes none).

The child is spawned with `stdio: "inherit"`: the launcher already hands over a clean stdout, so the starter does not
touch the stream, forwards `SIGTERM` / `SIGINT`, and exits with the child's code. `ELECTRON_RUN_AS_NODE` is set for
the child only. `--launcher <path>` (also `SCUMBLE_LAUNCHER`) names another launcher than the one in the asar: for a
dev tree (`electron.exe` + `electron/main/mcp/launch.js`), never needed by a user.

**When Scumble is missing** the starter does not die with a stderr line nobody reads (Claude Desktop would show
"server disconnected"): it answers the protocol itself, a 60-line JSON-RPC loop on stdin / stdout:
`initialize` → `serverInfo {name: "scumble", version}`, `capabilities {tools: {}}` and an `instructions` text that
says what is wrong; `ping` → `{}`; `tools/list` → one tool `scumble_not_installed` (read-only) whose description and
`tools/call` answer carry the same text; anything else → `-32601`. The text, in English, with the facts: what was
looked for (the explicit path, or "no installed Scumble found"), the three downloads (Store, installer, portable:
https://github.com/DenRakEiw/scumble/releases/latest and the Store link), and that a portable copy or another folder
is set in the extension's settings as *Scumble.exe*. The same text goes to stderr once (Claude Desktop's log).
After installing Scumble the user restarts the extension (or Claude Desktop); the starter does not poll.

`node server/index.js --where` prints what it found and the command it would run, without starting anything (support).

## 4. The build (`tools/mcpb_build.js`, `npm run dist:mcpb`)

1. Stage `dist/mcpb/scumble/`: `manifest.json` with `version` from `package.json` and `tools` from `docs/COMMANDS.md`,
   `server/index.js`, `README.md`, `icon.png` (from `build/icon.png`), `LICENSE`.
2. `mcpb validate` on the staged manifest, then `mcpb pack dist/mcpb/scumble dist/scumble-<version>.mcpb`.
   `@anthropic-ai/mcpb` 2.1.2 as a **devDependency** (MIT; `npm ci` in CI has it, no network at build time), used as
   `node_modules/.bin/mcpb`. Touches `package.json` and `package-lock.json`: one `devDependencies` line and the
   lock's additions, the merge is trivial.
3. Print the SHA-256 and write it beside the file as `dist/scumble-<version>.mcpb.sha256`; `mcpb info` as the last
   lines of the output.
4. `node tools/mcpb_build.js --server-json [v<version>]`: after the release is public, reads the asset's `digest`
   through `gh release view --json assets` (falls back to downloading the asset into a temp folder and hashing it),
   writes `packages: [{registryType: "mcpb", identifier: "https://github.com/DenRakEiw/scumble/releases/download/v<version>/scumble-<version>.mcpb", fileSha256, transport: {type: "stdio"}}]` into `server.json` and sets its `version`;
   refuses when the release is still a draft or has no `.mcpb`. The commit and `mcp-publisher publish` stay by hand
   (`docs/RELEASING.md`).

The file name `scumble-<version>.mcpb` (lower case like the AppImage and the deb; "mcp" in the URL as the registry
wants). About 400 KB (the icon is most of it).

## 5. CI and the release

- `.github/workflows/build.yml`, the `windows` job after the portable zip: `node tools/mcpb_build.js`, the artifact
  `Scumble-mcpb` on every run, `gh release upload … --clobber` on a tag. (It needs no Electron build and could run
  on Ubuntu; it stays in the Windows job so the draft is complete when `sizes` runs.)
- `tools/release_notes.py`: a sixth row in the "Get Scumble" table, **Claude Desktop extension**:
  `scumble-<version>.mcpb`, "Adds Scumble's MCP tools to Claude Desktop with one click; needs Scumble installed (any
  of the above)". `tools/updater_test.js` compares the block's shape, not its rows: checked when the row goes in.
- `docs/RELEASING.md`: the draft's check list gets the `.mcpb` (`mcpb info` on the downloaded file, its version); the
  MCP Registry step becomes "publish the release, `node tools/mcpb_build.js --server-json`, commit, `mcp-publisher
  validate`, `publish`". The pending 0.1.44 publish stays metadata only (0.1.44 has no `.mcpb`); the first `packages`
  entry goes out with the first release that ships one.
- `CHANGELOG.md` Unreleased: one line.

## 6. Docs

- `docs/MCP.md` "Registering with a client": a first paragraph for Claude Desktop (download the `.mcpb` from the
  release, open it, Install; the optional *Scumble.exe* setting for a portable copy), the JSON stays for other
  clients and for people who prefer it.
- `README.md`: the MCP line gets "or the `.mcpb` for Claude Desktop".
- `docs/MANUAL.md` (the MCP section, if it has one: checked at build time) one sentence.
- `docs/PLAN_MCP_LISTINGS.md`: the status table's last row (Smithery, GitHub registry) points here.

## 7. Tests (normal tier: plain-Node tests, one exe step, one look in Claude Desktop)

`tools/mcpb_test.js`, run by a new gate `mcpb` in `tools/run_gates.sh` (plain Node; with `--exe` it adds the exe
step), and by hand as `node tools/mcpb_test.js [--exe <Scumble.exe>]`:

- a) **Manifest:** the staged manifest passes `mcpb validate`, its `version` is `package.json`'s, its `tools` count
  is the number of `###` headings in `docs/COMMANDS.md` and every name matches `[A-Za-z0-9_-]+`; `STORE_LAUNCH` in
  the starter equals `registration.js`'s.
- b) **The finder**, with injected `env`, `lstat`, `exists` and `reg` answers: an explicit path wins over everything;
  an explicit path that does not exist answers `{missing: <path>}` and searches nothing; `InstallLocation`, then the
  `UninstallString` folder, then the default folders, each needing `Scumble.exe` and `resources\app.asar`; the
  Store alias by `lstat` alone; nothing → `null`. The empty and the literal `${user_config.scumble_exe}` both count
  as not set.
- c) **The plan:** the installer form (`launch.js` in the asar, `ELECTRON_RUN_AS_NODE`), the Store form (`-e`, `--`,
  the extra args after it), the extra args in the right place, and that the uninstall GUID in the starter is the
  uuid v5 the test computes from the appId.
- d) **The fallback over stdio:** the starter spawned with `SCUMBLE_EXE` naming a file that does not exist:
  `initialize`, `tools/list` (one tool), `tools/call` → the text names that path and the download link; stdout
  carries nothing but JSON lines.
- e) **The real thing** (with `--exe dist\win-unpacked\Scumble.exe`, once per release like the other exe gates):
  `SCUMBLE_EXE=<that exe>` and `-- --user-data-dir=<profile> --no-comfy`: `initialize`, `tools/list` ≥ 100 tools,
  `ping` → `mcp.mode` `headless`; the child ends when stdin closes. The Store route the same way with
  `SCUMBLE_EXE=%LOCALAPPDATA%\Microsoft\WindowsApps\scumble.exe` when the alias exists on the machine (it does here:
  the Store copy 0.1.42), skipped otherwise.

**In Claude Desktop, by hand (the user, or this account through computer use on the user's word):**

1. `npm run dist:mcpb`, open `dist\scumble-<version>.mcpb` (double click, or *Settings › Extensions › Advanced ›
   Install extension*): the install dialog shows the name, the icon, the description, the optional *Scumble.exe*
   field, and whatever it says about an unsigned bundle. Install.
2. With Scumble open: in a chat, "ping scumble" → `mode: proxy`; "take a screenshot of the picture" works.
   With Scumble closed: `mode: headless`; a second start of Scumble from the Start menu brings the window up.
3. The extension's settings: *Scumble.exe* set to a portable copy (`dist\portable-test\Scumble\Scumble.exe`, still
   on this machine) → `ping` answers that copy's version; set to a path that does not exist → the one tool and its
   message; empty again → the installed one. This step also tells what an empty optional `user_config` expands to.
4. The Store route: *Scumble.exe* set to the alias path → `ping` answers 0.1.42 (the Store copy), and the window of
   the Store copy opens when started from the Start menu.
5. Uninstall the extension (the settings' trash icon): the folder under `Claude Extensions` is gone.

## 8. After the build, on the user's word only

- Push the branch, merge into `main` when the Nik 9 agent's state allows (the user says when), the next release
  carries the first `.mcpb`.
- Smithery: an account, *Add server* with the `.mcpb` URL of the published release (their form; what it asks beyond
  the URL is read then). GitHub's MCP registry: the onboarding thread (`docs/PLAN_MCP_LISTINGS.md` §2) with the
  registry entry and the `.mcpb`. Both outward-facing: asked first, done through the user's browser.
- The registry entry's `packages` with every later release (§5).

## 9. Sessions

- **S1** the starter, the manifest, the build script, the devDependency, `tools/mcpb_test.js` a-d (one commit).
- **S2** the exe step e, CI, `release_notes.py`, `server.json` support, the docs, the CHANGELOG line (one commit).
- **S3** the Claude Desktop test (§7, by hand or through computer use), fixes from it, the hand-over.

Together about a day. Decisions taken here without asking (say if another is wanted): the devDependency instead of
`npx` at build time; the file name `scumble-<version>.mcpb`; the fallback as a one-tool server rather than an exit;
the search order installer before Store (the installer updates itself and is the recommended download; a user with
only the Store copy is found anyway); Windows only in the manifest; unsigned.
