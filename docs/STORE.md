# The Microsoft Store package (MSIX)

Why there is a Store package at all, and what it does not change for the GitHub installer, is in
[CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md): the Store re-signs the package after
certification, so the Store copy installs without a SmartScreen warning while the project waits
for the SignPath Foundation. This page is how the package is built, what is different inside it,
what has been checked and what has not.

## Building it

```
npm run dist:store:test   # dist/Scumble-<version>-test.msix, a test identity, for this machine
npm run dist:store        # dist/Scumble-<version>.msix, the package for Partner Center
```

Both run `tools/build_store.js`, which calls electron-builder's `appx` target with the `appx`
block of `package.json`. Two things are not electron-builder's defaults:

- **The toolset is `winCodeSign` 1.1.0** (the Windows Kits 10.0.26100 tools). The default legacy
  toolset carries a `makeappx.exe` from 2019.
- **The kit is copied to `dist/.store-kit`** and handed over through
  `ELECTRON_BUILDER_WINDOWS_KITS_PATH`. Started from electron-builder's tool cache under
  `%LOCALAPPDATA%`, `makeappx.exe` refused to start on this machine (2026-09-23: "the side-by-side
  configuration is invalid", the event log naming its private assembly
  `Microsoft.Windows.Build.Appx.AppxPackaging.dll` as not found, although the file sat next to
  it); the same files ran from a folder on `F:`. `makepri.exe` from the cache ran. Not looked into
  further.

`npm run dist:store` refuses to run without the package identity Partner Center assigned; it is in
`package.json` since 2026-09-23 (below). The package is never signed by us: the test one is installed another way, the
Store one is signed by Microsoft.

What goes in: the same `win-unpacked` app the NSIS installer carries (the same `build.win.files`
exclusions), `build/AppxManifest.xml` as the manifest, and the tile artwork in `build/appx`,
rendered from the logo's SVGs by `./node_modules/.bin/electron tools/appx_assets.js` (plated
tiles from `icon-plain.svg` on the manifest's `#1B1714`, the taskbar's 16 and 24 px from
`icon-small.svg` as in `icon.ico`). Without its own artwork electron-builder puts in its sample
pictures, which certification rejects. The 0.1.26 test package was 195 MB (the NSIS installer:
134 MB).

## What is different in the Store copy

`electron/main/msix.js` holds all of it; `process.windowsStore` (set by Electron inside a package)
is the switch.

- **Full trust.** The manifest's entry point is `Windows.FullTrustApplication` with the
  `runFullTrust` capability: the app is not in an AppContainer and reaches the user's ComfyUI on
  `127.0.0.1` like the installed app does. An AppContainer package cannot.
- **Its own data folder: `%APPDATA%\Scumble Store`**, not `Scumble`. Windows redirects what a
  packaged app writes under AppData to `%LOCALAPPDATA%\Packages\<family>\LocalCache`, but lets it
  change files that already exist outside. With a GitHub copy installed, a shared `Scumble` folder
  would be split: the settings and keys changed in place, every new file (the file mirror, the
  autosave's pictures) in the private copy. A folder of its own is created by the package and so
  redirected whole. Consequences: the Store copy starts with its own settings and keys, both
  copies can run at once (the single-instance lock and the local command pipe are keyed by the
  data folder), and uninstalling the Store copy removes its data. A `--user-data-dir` wins over
  it, as everywhere.
- **Folders opened in Explorer** (plugins, recipes, prompts, brushes, logs, local files, helper
  models) are opened where they really are, in `LocalCache`: Explorer runs outside the package and
  sees nothing of the redirection. The About line names that real folder too. The package family
  name comes from the `AppxManifest.xml` at the package root (the Identity's `Name`, and the
  publisher id Windows derives from the `Publisher`: the first 64 bits of SHA-256 over it in
  UTF-16LE, in Windows' base32 alphabet, checked against `Get-AppxPackage` on this machine).
- **No self-update.** The Store updates its copy: the updater's state is `store`, it never loads
  electron-updater, *Help › Check for updates* is gone and *Settings › Updates* says so instead of
  offering a check.
- **MCP through the execution alias.** The manifest declares `scumble.exe` as an app execution
  alias (`%LOCALAPPDATA%\Microsoft\WindowsApps\scumble.exe`), which stays when an update moves the
  package to a new versioned folder. *Help › Copy MCP registration* gives the client that alias in
  Node mode (`ELECTRON_RUN_AS_NODE=1`) with `-e` code that loads the launcher from
  `process.resourcesPath` of whichever version the alias starts. The launcher is given no
  arguments and starts the app with its default, `--mcp`.

`node tools/platform_test.js` checks all of that without an app (the registration text, that the
`-e` code really loads a launcher from a resources folder, the publisher id against four real
ones, the path translation, the manifest's macros and alias, the artwork), and the `platform` gate
checks the Updates section in the app. 15 mutations of the Node side and one of the renderer each
turned a check red.

## Installing the test package on this machine

An unsigned MSIX cannot be installed with an app in it: `Add-AppxPackage -AllowUnsigned` answers
0x80073D2B, "an unsigned package cannot contain executable activations" (measured 2026-09-23, even
with the publisher OID Windows 11 asks for unsigned packages, which `build_store.js --test` puts
in). Two ways remain, both a system setting only the user changes:

- **Developer Mode** (*Settings › System › For developers*), then register the unpacked layout.
  The app runs with its package identity, its alias and the AppData redirection, from the
  layout's folder instead of `WindowsApps`:

  ```
  Copy-Item dist\Scumble-0.1.26-test.msix dist\store-layout.zip    # a .msix is a zip; Expand-Archive wants the name
  Expand-Archive dist\store-layout.zip dist\store-layout
  Add-AppxPackage -Register dist\store-layout\AppxManifest.xml
  ```

- **A test certificate** trusted in the machine's *Trusted People* store (administrator), and the
  package signed with it (`signtool sign /fd SHA256 /f test.pfx ...`). Closer to a Store install
  (it lands in `WindowsApps`), more to undo afterwards.

`Remove-AppxPackage (Get-AppxPackage DenRakEiw.ScumbleTest).PackageFullName` takes either out
again, its `LocalCache` with it.

## Not tested yet (needs the package installed)

Each of these is written from Microsoft's documentation and has to be run, not assumed:

1. The app starts from the Start menu and from `scumble.exe`, and connects to ComfyUI on
   `127.0.0.1:8188` (full trust).
2. `%APPDATA%\Scumble Store` lands in `LocalCache\Roaming`, keys saved through safeStorage decrypt
   after a restart, the autosave comes back.
3. A second start (Start menu or alias) shows the running window instead of a second app.
4. *Open plugin folder* and the other folder buttons open the `LocalCache` folder in Explorer, and
   a plugin copied there by hand loads.
5. The MCP registration: `ELECTRON_RUN_AS_NODE` reaches the process the alias starts, the
   launcher's child runs inside the package (same data folder, same pipe), `tools/mcp_test.py`
   against it in proxy mode (the window open) and headless.
6. *Settings › Rendering › Restart now* (`app.relaunch`) comes back inside the package.
7. The helpers' ONNX Runtime (DirectML) loads from the package's unpacked resources.
8. Uninstalling removes the data folder and the alias.
9. The Windows App Certification Kit (`appcert.exe`, part of the Windows SDK) passes the package
   before the first submission.

## The Store identity

Reserved by the user on 2026-09-23 in Partner Center (*Scumble > Product identity*), and in
`package.json` `build.appx`:

| | |
| --- | --- |
| Package/Identity/Name | `DenRakEiw.Scumble` |
| Package/Identity/Publisher | `CN=F2BCAA24-8A1E-43F6-9DFA-1E11616630F1` |
| PublisherDisplayName | `DenRakEiw` |
| Package family name | `DenRakEiw.Scumble_eh52rqbjjrbdj` |
| Store ID | `9NDBTNNMXF2R` (https://apps.microsoft.com/detail/9NDBTNNMXF2R) |

The family name is Partner Center's; `msix.publisherId()` computes the same `eh52rqbjjrbdj`
from the publisher, and `the_store_identity_is_the_one_partner_center_assigned` holds both.
Every submission needs a higher package version than the last (`0.1.26.0` from `package.json`;
the fourth part stays 0, the Store reserves it).

## For the Store submission (the user's part)

1. ~~A Partner Center developer account, the name reserved, the identity in `package.json`~~ - done
   2026-09-23.
2. Not before STORE.md's nine points have run on an installed package.
3. `npm run dist:store`, then upload `dist/Scumble-<version>.msix`. The listing needs its own
   texts and screenshots; the `runFullTrust` capability asks for a sentence why (a desktop editor
   that talks to a local ComfyUI server and reads and writes the user's files).
4. The privacy policy URL can be the policy section of
   [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md#privacy-policy) (or a page on the website).
