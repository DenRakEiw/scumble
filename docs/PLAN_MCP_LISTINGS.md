# Listing Scumble's MCP server in registries and communities

**Status (2026-10-04 evening): researched, nothing submitted, posted or changed.** The user, mid-session: "Trage es in
alle MCP registrys ein in die du es eintragen kannst" (with a pasted list of channels), then "schreibe auch einen
reddit post für r/modelcontextprotocol". Research by one read-only workflow (four agents, every channel's own pages
read 2026-10-04; sources in the workflow journal of that session). **Every submission, post and repository setting
waits for the user's yes, one at a time**; logins and accounts are the user's (Claude never signs in with a password
or creates an account); a form that sends an email address uses the address the user names for it.

## 1. What Scumble's MCP server is (facts for every listing)

- stdio only, server name `scumble`, version = the app's; one capability (`tools`, `listChanged`), no resources, no
  prompts, no auth of its own. `Scumble --mcp` drives the running Scumble over a named pipe, or starts the app headless
  when none runs; `--attach-only` never starts one.
- **96 tools on a fresh profile**: 79 core commands plus 17 from five built-in plugins (ailabel 3, boxes 6, film 3,
  glb 3, sample 2). `docs/MCP.md:202` still says 73 and the README "60+": fix before any listing links there.
- Config: *Help › Copy MCP registration (Claude Code)* / *(Claude Desktop JSON)* writes the exact paths of the running
  install (a Node-mode launcher, `ELECTRON_RUN_AS_NODE=1`, because Electron prints a stray CR LF on stdout). Installer:
  `Scumble.exe` + `resources\app.asar\electron\main\mcp\launch.js --mcp`; Store copy: the execution alias `scumble.exe`
  with an `-e` loader (`docs/STORE.md` §MCP). `docs/MCP.md:67-68` prints the Desktop JSON with single backslashes,
  which is not valid JSON: fix with the count.
- The pasted tool names do not exist; the real ones: `select_by_text` (not create_selection_from_text), `set_mask`
  (add_mask_layer), `generate` / `generate_new` (run_inpaint), `set_layer` with `match` / `match_source`
  (apply_colour_match), `export` with `format: "psd"` (export_psd), `select_recipe` + `generate` (run_comfyui_workflow;
  there is no such tool). `open_document` and `list_layers` exist as named.
- Requirements: Windows 10/11 x64 (installer or Store); Linux AppImage / deb built by CI, never run; no macOS. Local
  recipes need a ComfyUI with ComfyUI-InpaintCanvas; `select_by_text` a connected ComfyUI (SAM3); `select_point` and
  `cutout_layer` the in-app ONNX models; API recipes the user's own keys (no MCP tool sets keys).
- Links: https://github.com/DenRakEiw/scumble, `docs/MCP.md`, `docs/COMMANDS.md`, the Store
  (https://apps.microsoft.com/detail/9NDBTNNMXF2R), https://www.denrakeiw.com/scumble. GPL-3.0.
- Wording rule (the user, 2026-09-29): no other product named as the model for a feature; clients (Claude, Cursor) and
  the providers / models Scumble runs through may be named.

## 2. The channels

| Channel | Route | Login / cost | Takes Scumble today? | Next step |
| --- | --- | --- | --- | --- |
| Official MCP Registry | `mcp-publisher` CLI (`init`, `login github`, `publish`) with a `server.json`; no form, no PR | GitHub device-flow login by the user; free; preview, live at once, moderated after | **Yes, metadata only**: no package needed (documented "Server with Custom Installation Path", live examples of desktop apps); `websiteUrl` to the setup docs | the user's yes; download the CLI from modelcontextprotocol/registry releases (Windows build); the user enters the device code |
| PulseMCP | submissions paused; ingests the official registry automatically | none | via the official registry | nothing to do |
| GitHub MCP registry (github.com/mcp, VS Code's gallery) | manual onboarding after the official registry (staff, discussion github/github-mcp-server#1257) | GitHub; free | no metadata-only entry among its 357; needs an MCPB or npm package | later, with an MCPB |
| mcpservers.org (wong2's list) | form mcpservers.org/submit; no PRs | no login; an email; free (2 weeks) or $39 (24 h, badge) | yes (desktop apps listed) | the user's email and yes |
| MCPMarket | form mcpmarket.com/submit (repo URL, email) | no login to submit, GitHub to claim; free (4-6 weeks) or $29 | yes | the user's email and yes |
| mcp.so | form mcp.so/submit, or a GitHub issue at chatmcp/mcp-directory | the form may need sign-in; issue = the user's GitHub; free or $39 | yes | the user's yes (issue through `gh`) |
| mcp.directory | form mcp.directory/submit (repo URL; email optional) | no login; free; review in 24 h; also reads the official registry | yes | the user's yes |
| TensorBlock awesome list / MCP Index | issue form `add-mcp-server.yml` (a bot makes the PR) or a PR to `docs/multimedia-processing.md` | the user's GitHub; free; merged fast | yes (desktop editors listed) | the user's yes; then the badge for the README |
| Glama | "Add Server", then a Dockerfile that must start and list tools in Linux | GitHub; free | **blocked**: Electron in Linux Docker (xvfb?) unverified | build work, later |
| punkpeye/awesome-mcp-servers | PR, one line | GitHub; free | **blocked**: its bot requires the Glama score badge | after Glama |
| Smithery | hosted URL or an `.mcpb` bundle | Smithery account | **blocked** without an MCPB | build work, later |
| StackPicks | email to info@stackpicks.dev | email | poor fit (every entry an `npx` / remote line) | skip |
| GitHub topics | `gh repo edit DenRakEiw/scumble --add-topic ...` (a repository setting) | the owner; free | 15 of 20 set, `mcp` among them | the user's yes for `mcp-server`, `model-context-protocol`, `image-editing`, `ai-image-editing` (19); `mcp-server` is the topic trackers query |
| r/modelcontextprotocol | a post, flair `new-release` | the user's Reddit account | yes | the draft below; the user posts, or Claude posts in the user's Chrome after the yes |
| r/mcp | a post, flair `showcase` (self-promotion with disclosure) | Reddit | yes | adapt the draft |
| MCP Discords | the official one is contributors only, no marketing; Glama's community server (14k) unverified | Discord | the official one: no | skip the official one |
| X community "MCP" | members post | X | yes | a short screen recording, later |

**Build work that would open the blocked channels** (not planned, the user's call): an `.mcpb` bundle on a GitHub
release (a thin launcher that finds the installed Scumble and runs its MCP launcher; the registry checks only the
URL, a published release and the SHA-256) gives one-click install in Claude Desktop, Smithery and a real chance at
GitHub's registry; a Linux Docker image in which Scumble starts headless and lists its tools opens Glama and with it
the punkpeye list. Windows' own agent registry (`com.microsoft.windows.ai.mcpServer` in the MSIX manifest) is a third
idea, pre-release, unverified for Electron.

## 3. Texts

**Official registry `server.json`** (description at most 100 characters; no tools field):

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.DenRakEiw/scumble",
  "title": "Scumble",
  "description": "Agents drive a layered AI inpainting editor: select by text, inpaint, mask, layers, PSD/ORA export.",
  "version": "0.1.41",
  "websiteUrl": "https://github.com/DenRakEiw/scumble/blob/main/docs/MCP.md",
  "repository": { "url": "https://github.com/DenRakEiw/scumble", "source": "github" }
}
```

(Versions are immutable: every release that changes the tools gets a new publish. A draft GitHub release does not
answer the registry's HEAD check, which matters only for a later MCPB.)

**Directory description** (forms, TensorBlock):

> Scumble is an open-source (GPL-3.0) desktop editor for AI inpainting on Windows; its stdio MCP server exposes the
> editor's 96 commands as tools. Agents open images and documents, select by rectangle, mask, point or a text
> description, inpaint the selection into a new layer, work with masks, blend modes, colour match, filter and text
> layers, take snapshots, and export PNG, JPEG, WebP, TIFF, or PSD and ORA with layers. Pixels come from the user's own
> ComfyUI (local or remote), Comfy Cloud, or image APIs (Black Forest Labs, OpenAI, Google, fal.ai, Replicate,
> OpenRouter) on the user's own keys. It drives the open Scumble window, or starts the app headless.

**Reddit, r/modelcontextprotocol** (flair `new-release`; for r/mcp the flair `showcase`): the draft is in the chat of
2026-10-04 evening and below; the user edits and decides.

Title: *I made every command of my AI inpainting editor an MCP tool: agents can select by text, inpaint into layers,
mask and export layered PSDs*

> I'm the developer of Scumble, an open-source (GPL-3.0) desktop editor for AI inpainting on Windows. All 96 of its
> commands are MCP tools, so an agent works on a picture the way a person does: in layers, with selections, masks and
> undo, in the window you are looking at.
>
> **What an agent can do** (real tool names)
> - open images and `.scumble` documents: `load_image`, `open_document`
> - select by rectangle, mask, point or description: `select_rect`, `select_mask`, `select_point`, `select_by_text`
>   ("the car")
> - prompt and inpaint the selection, the answer lands as a new layer: `set_prompt`, `generate`; a new picture from a
>   prompt: `generate_new`
> - layers: masks, blend modes, opacity, colour match against the picture below, groups, filter and text layers:
>   `set_layer`, `set_mask`, `add_filter`, `add_text`, ...
> - look and step back: `screenshot` (returns a JPEG), `undo`, `take_snapshot` / `restore_snapshot`
> - export PNG, JPEG, WebP, TIFF, or PSD and ORA with layers: `export`
>
> A round trip: `load_image` -> `select_by_text` "the sky" -> `set_prompt` "storm clouds at dusk" -> `generate` ->
> `screenshot` -> `set_layer` (match) -> `export` (psd).
>
> **Where the pixels come from:** your own ComfyUI (local or remote) through workflow recipes, Comfy Cloud, or image
> APIs (Black Forest Labs, OpenAI, Google, fal.ai, Replicate, OpenRouter, ...) on your own keys. Scumble ships no
> models and runs no service; keys stay in the OS credential store and no tool touches them.
>
> **How it connects:** stdio. `Scumble --mcp` drives the Scumble window that is open, so you can watch and step in,
> or starts the app headless when none runs. *Help › Copy MCP registration* writes the config for Claude Code or
> Claude Desktop with your install's paths.
>
> **Limits:** Windows 10/11 (installer or Microsoft Store); Linux builds exist but are untested; no macOS yet.
> `select_by_text` needs a connected ComfyUI; generation needs a ComfyUI or an API key.
>
> GitHub: https://github.com/DenRakEiw/scumble · MCP docs: .../docs/MCP.md · all tools: .../docs/COMMANDS.md
>
> I'd like to hear which tool descriptions or workflows would help your agents most.

## 4. Order once the user says yes

1. Fix `docs/MCP.md` (the tool count, the Desktop JSON's backslashes) and the README's "60+"; push (the listings link
   to `main`).
2. GitHub topics (four).
3. The official registry (metadata only), which also feeds PulseMCP and mcp.directory.
4. The forms without a login (mcpservers.org, MCPMarket, mcp.directory, mcp.so) with the email the user names, free
   tier unless the user says otherwise; TensorBlock's issue form through `gh`.
5. Reddit: r/modelcontextprotocol, then r/mcp a few days later (not the same day).
6. Later, the user's call: the MCPB bundle (Smithery, GitHub registry, one-click install), the Docker check (Glama,
   punkpeye).
