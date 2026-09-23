// The linter, for the one class of mistake that `node --check` cannot see: a name that
// does not exist, a write to an imported binding, a write to a const, a variable nobody
// reads. The split of inpaint_canvas.js (2026-09-18) was found out by exactly this - a
// later `++partsSeq` on an imported binding parses fine and throws at run time - and the
// config that found it lived in a session's scratchpad and was lost. It lives here now.
//
// The rule set is deliberately short. This is not a style linter: formatting, quotes,
// semicolons and line length are nobody's business here, and a rule that fires on working
// code teaches people to run the linter with their eyes closed.
//
//   npx eslint .        (or: npm run lint)
//
// Four environments, because the same repository holds four: ES modules in the window,
// ES modules in a worker, CommonJS in the main process and in the Python-driven Node
// tests, and the plugins, which are ES modules with the `scumble` API as a global.

import globals from "globals";

/** Errors only, and only the kinds that are wrong however the code is written. */
const CORRECTNESS = {
    "no-undef": "error",
    "no-import-assign": "error",
    "no-const-assign": "error",
    "no-dupe-keys": "error",
    "no-dupe-args": "error",
    "no-dupe-class-members": "error",
    "no-unreachable": "error",
    "no-fallthrough": "error",
    "no-self-assign": "error",
    "no-unsafe-negation": "error",
    "no-cond-assign": ["error", "except-parens"],
    // An unused name is usually a rename that did not finish. Arguments are exempt: a
    // callback often has to take what it does not use.
    "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
};

const ECMA = { ecmaVersion: 2023 };

export default [
    {
        ignores: [
            "node_modules/**",
            "dist/**",
            "renderer/editor/px/*.wasm",
            // Built from renderer/editor/ by tools/build_node.py; never edited here.
            "**/js/inpaint_canvas.js",
            // Vendored libraries: not ours to fix, and three.js trips no-cond-assign by design.
            "plugins/*/vendor/**",
        ],
    },

    // The editor and the shell: ES modules in the window.
    {
        files: ["renderer/**/*.js"],
        languageOptions: {
            ...ECMA,
            sourceType: "module",
            globals: { ...globals.browser, ...globals.worker },
        },
        rules: CORRECTNESS,
    },

    // The two workers: no document, but a worker scope.
    {
        files: ["renderer/editor/inpaint_worker.js", "renderer/editor/stitch_worker.js"],
        languageOptions: {
            ...ECMA,
            sourceType: "module",
            globals: globals.worker,
        },
        rules: CORRECTNESS,
    },

    // Plugins: ES modules that receive the app's API as a global.
    {
        files: ["plugins/**/*.js"],
        languageOptions: {
            ...ECMA,
            sourceType: "module",
            globals: { ...globals.browser, scumble: "readonly" },
        },
        rules: CORRECTNESS,
    },

    // The main process and the Node-side tests: CommonJS.
    {
        files: ["electron/**/*.js", "tools/**/*.js"],
        languageOptions: {
            ...ECMA,
            sourceType: "commonjs",
            globals: globals.node,
        },
        rules: CORRECTNESS,
    },

    // Two things under tools/ are not Node at all: pixels_test.js is read by its Python
    // driver and evaluated inside the app's renderer, and node_test/ is a stand-in for
    // ComfyUI's own page scripts. Both are browser modules wearing a tools/ path.
    {
        files: ["tools/pixels_test.js", "tools/node_test/**/*.js"],
        languageOptions: {
            ...ECMA,
            sourceType: "module",
            // `gc` is Chromium's, from --expose-gc: the memory cases call it.
            globals: { ...globals.browser, ...globals.worker, gc: "readonly" },
        },
        rules: CORRECTNESS,
    },

    // The preload runs in both worlds.
    {
        files: ["electron/preload.js"],
        languageOptions: {
            ...ECMA,
            sourceType: "commonjs",
            globals: { ...globals.node, ...globals.browser },
        },
        rules: CORRECTNESS,
    },
];
