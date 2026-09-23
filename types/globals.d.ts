// Globals the checked files see and the lib files do not declare. Ambient only: this file
// is never loaded, never shipped (build.files in package.json does not list types/), and
// exists for tsconfig.check.json alone.

interface Window {
    /**
     * The preload bridge, electron/preload.js: settings, state, comfy, file, keys, helpers,
     * providers, llm, assistant, log, plugins. It is `any` on purpose. The bridge is a real
     * contract - it is the only door between the window and the main process - but typing it
     * means typing what sixty IPC handlers answer, which is a stage of its own
     * (docs/PLAN_TYPES.md, stage 3). Until then the checker knows the name exists and
     * nothing more.
     */
    scumble: any;
}
