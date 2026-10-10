// @ts-check
// Effects pack: Creative optical and distortion effects plugin.
// Registers filters and plugins menu actions.

import { makeChromaticShift } from "./chromatic.js";

export function activate(scumble) {
    const chromatic = makeChromaticShift(scumble);
    scumble.filters.register({ ...chromatic.filter, chain: true });

    const addFilter = (type, name) => (doc) => doc.run("add_filter", { type, name });
    scumble.actions.register({
        id: "add_chromatic",
        label: "Chromatic shift layer",
        run: addFilter("effects.chromatic_shift", "Chromatic shift"),
    });
}
