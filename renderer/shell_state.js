// The state shell.js and its sections share (item 56 S14a, docs/PLAN_SPLIT.md §5.1): the module variables that more than
// one section, or a section and the wiring that stays in shell.js, write. shell.js sets each where it declared it before;
// an import is read-only, a property is not.

export const shellState = {
    settings: undefined,
    providers: undefined,
    recipes: undefined,
    lastStatus: undefined,
    lastProbe: undefined,
    canvasOnlyState: undefined,
    windowFullScreen: undefined,
    takesPending: undefined,
    genRemapOff: undefined,
    genPrevious: undefined,
    helpersRenderTimer: undefined,
    providerTimer: undefined,
    lastUserInput: undefined,
};
