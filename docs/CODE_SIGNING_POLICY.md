# Code signing policy

Scumble's Windows installer (`Scumble Setup <version>.exe`) is built by GitHub Actions from
the source in this repository and published on
[GitHub Releases](https://github.com/DenRakEiw/scumble/releases). This page is the code
signing policy the [SignPath Foundation](https://signpath.org/terms) asks an open source
project to publish. It describes who may change the code, who approves a signed release and
what the program sends over the network.

**Status.** Releases up to 0.1.x are **not signed**. Once the project has visible use, the
maintainer applies at the SignPath Foundation; from the first signed release on, the
attribution below applies and the SmartScreen paragraph in the README goes away.

> Free code signing provided by [SignPath.io](https://signpath.io), certificate by
> [SignPath Foundation](https://signpath.org).

## Roles

| Role | Who |
| --- | --- |
| Committers and reviewers | Members of the [DenRakEiw/scumble](https://github.com/DenRakEiw/scumble) repository with write permission: [DenRakEiw](https://github.com/DenRakEiw) |
| Approvers | [DenRakEiw](https://github.com/DenRakEiw) |

Contributions from outside the team arrive as pull requests and are reviewed and merged by a
committer. Every release is approved for signing by hand by an approver; nothing is signed
automatically.

## How a release is built

- A release is a git tag `v<version>` on `main` that matches `version` in `package.json`.
- `.github/workflows/build.yml` builds the installer on a GitHub-hosted `windows-latest`
  runner from that tag with `npm ci` and `electron-builder`. Nobody builds release binaries
  on a private machine.
- The release notes are that version's section of `CHANGELOG.md`; a missing section fails the
  build.
- Product name (`Scumble`), file description and product version are set by electron-builder
  from `package.json` and are the same in every artifact of a release.
- The signing request will be submitted from that workflow (SignPath's GitHub Action) and
  approved by an approver before the signed installer replaces the unsigned one in the
  release.

## Privacy policy

This program will not transfer any information to other networked systems unless
specifically requested by the user or the person installing or operating it.

In detail, Scumble talks to these systems, and to nothing else:

- **Your ComfyUI server**, at the address you enter in Settings › ComfyUI, when you run a
  local recipe, a helper node, or test the connection.
- **An API provider** (ToAPIs, Google, OpenAI, Black Forest Labs, fal.ai, Replicate, WaveSpeedAI,
  Comfy Cloud, OpenRouter, BytePlus ModelArk, Anthropic), only when you run a recipe or a prompt upsampling that names it,
  or click *check balance* next to its key, with the key you stored. Keys are kept in the operating
  system's credential store (Electron `safeStorage`, DPAPI on Windows) and never leave the machine
  except in the request to that provider. OpenRouter (`openrouter.ai`) passes a request on to a host
  that serves the model, and Scumble asks it to leave out every host it lists in China; for that list
  Scumble reads OpenRouter's public host list (`GET /api/v1/providers`, without the key) at the first
  OpenRouter image run or upsampling of a session. No request to OpenRouter carries an attribution
  header ([RECIPES.md, "OpenRouter"](RECIPES.md#openrouter-openrouter)). BytePlus ModelArk is reached
  at one of two regional hosts: `ark.ap-southeast.bytepluses.com` (Johor, Malaysia) or
  `ark.eu-west.bytepluses.com` (Dublin, Ireland). Seedream 5.0 pro always goes to Johor, and 5.0 lite
  goes to the host its *Region* row names. BytePlus may route a request to its other region. Only if
  an answer carries a download link instead of the image, Scumble fetches that link, without the key
  ([RECIPES.md, "BytePlus ModelArk"](RECIPES.md#byteplus-modelark-ark)).
- **Hugging Face**, when you click *Download* for a helper model in Settings › Helpers.
- **GitHub Releases**, for the update check: the packaged app checks for a new version once,
  8 seconds after start, and downloads it in the background when one exists. This check can
  be switched off in Settings › Updates (*Check for updates at start*); *Check now* and
  *Restart and install* only run when you click them.
- **Links you click** (Help menu, "get a key" next to a provider) open in your browser.

Scumble collects no usage data, has no telemetry and no crash reporting. Your images,
documents, autosaves and settings stay in `%APPDATA%\Scumble` on your machine.

## Licence

Scumble is free software under the [GPL-3.0](../LICENSE). It contains no proprietary
component; the dependencies are MIT, Apache-2.0, BSD or OFL licensed.
