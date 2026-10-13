// The status row's bar (docs/PLAN_0_1_48.md S3): renderer/editor/inpaint_progress.js in plain Node, with a clock of its own.
//   node tools/progress_test.js
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
    const { RunProgress } = await import(pathToFileURL(path.join(__dirname, "..", "renderer", "editor", "inpaint_progress.js")).href);

    let failed = 0;
    function check(name, ok, got) {
        if (ok) console.log(`[ok] ${name}`);
        else { failed++; console.log(`[FAIL] ${name}: ${JSON.stringify(got)}`); }
    }

    let t = 1000000;
    const ticks = [];
    const shown = [];
    const p = new RunProgress((s) => shown.push(s), {
        now: () => t,
        setInterval: (fn) => { ticks.push(fn); return ticks.length; },
        clearInterval: (h) => { ticks[h - 1] = null; },
    });
    const last = () => shown[shown.length - 1];

    check("nothing tracked: hidden", p.state() === null);
    check("an unknown prompt's event is not taken", p.event("progress", { prompt_id: "x", node: "3", value: 1, max: 2 }) === false);
    p.track("A", 9);
    check("tracked, not started: queued", last() && last().label === "Queued" && last().fraction === null, last());
    check("no ticker while only queued", ticks.filter(Boolean).length === 0, ticks.length);
    p.event("execution_start", { prompt_id: "A" });
    check("started: a ticker runs", ticks.filter(Boolean).length === 1);
    p.event("execution_cached", { prompt_id: "A", nodes: ["1", "2", "3"] });
    p.event("executing", { prompt_id: "A", node: "4" });
    check("node 1 of 6 (9 nodes, 3 cached), busy", last().fraction === null && /node 1\/6/.test(last().label) && /^Generating · /.test(last().label), last());
    p.event("executing", { prompt_id: "A", node: "5" });
    p.event("progress", { prompt_id: "A", node: "5", value: 5, max: 20 });
    check("a sampler's step: the fraction", Math.abs(last().fraction - 0.25) < 1e-9 && /step 5\/20/.test(last().label) && /node 2\/6/.test(last().label), last());
    p.event("progress", { prompt_id: "A", node: "5", value: 20, max: 20 });
    p.event("progress", { prompt_id: "A", node: "5", value: 3, max: 20 });
    check("the same node sampling again (a tile, a face) is a pass of its own", Math.abs(last().fraction - 0.15) < 1e-9 && /step 3\/20 \(pass 2\)/.test(last().label), last());
    t += 7000;
    ticks.filter(Boolean)[0]();
    check("the seconds tick", / 7 s$/.test(last().label), last());
    p.event("executing", { prompt_id: "A", node: "6" });
    check("the next node without steps: busy again", last().fraction === null && /node 3\/6/.test(last().label), last());
    p.event("executing", { prompt_id: "A", node: "12.3", display_node: "12" });
    p.event("executing", { prompt_id: "A", node: "12.4", display_node: "12" });
    check("subgraph nodes count as their graph's node", /node 4\/6/.test(last().label), last());
    p.event("progress", { prompt_id: "A", node: "12.4", value: 2, max: 4 });
    check("a second stepped node: pass 3", /step 2\/4 \(pass 3\)/.test(last().label) && last().fraction === 0.5, last());
    p.track("B", 5);
    check("a second prompt waits", /1 more queued/.test(last().label) && last().queued === 1, last());
    p.event("executing", { prompt_id: "A", node: null });
    check("A ended (executing null): B shows queued", last().label === "Queued", last());
    check("no ticker while only queued again", ticks.filter(Boolean).length === 0, ticks.filter(Boolean).length);
    p.event("execution_start", { prompt_id: "B" });
    p.event("execution_success", { prompt_id: "B" });
    check("B ended: hidden", last() === null, last());

    // a timed run (an API run) and a pass on ComfyUI under its label
    p.timer({ label: "FLUX.2 [pro] on fal", started: t - 3000 });
    check("a timed run: its label and seconds, busy", last().label === "FLUX.2 [pro] on fal · 3 s" && last().fraction === null, last());
    p.track("C", 4);
    p.event("progress", { prompt_id: "C", node: "2", value: 1, max: 4 });
    check("steps of a tracked prompt under the timed run's label", /^FLUX\.2 \[pro\] on fal · step 1\/4/.test(last().label) && last().fraction === 0.25, last());
    p.event("execution_interrupted", { prompt_id: "C" });
    p.timer(null);
    check("the timed run ended: hidden", last() === null && ticks.filter(Boolean).length === 0, [last(), ticks.filter(Boolean).length]);

    // idle and clear
    p.track("D", 3);
    p.track("E", 3);
    p.idle();
    check("the queue went empty: hidden", last() === null && p.runs.size === 0);
    p.event("execution_start", { prompt_id: "D" });
    check("a stale \"queue empty\": the prompt's own event takes it back", p.runs.has("D") && last() && /^Generating/.test(last().label), last());
    p.event("execution_success", { prompt_id: "D" });
    check("an end event does not take a dropped prompt back", p.event("execution_success", { prompt_id: "E" }) === false && !p.runs.has("E"));
    p.track("F", 2);
    p.idle();
    t += 61000;
    check("a minute later it stays gone", p.event("execution_start", { prompt_id: "F" }) === false && !p.runs.has("F"));
    p.timer({ label: "Upscale", started: t });
    p.clear();
    check("clear ends the timed run too", last() === null && p.timed === null && ticks.filter(Boolean).length === 0);
    check("a renderer that throws does not break it", (() => { const q = new RunProgress(() => { throw new Error("x"); }); q.track("Z", 1); return q.runs.size === 1; })());

    console.log(failed ? `${failed} failed` : "PASS");
    process.exit(failed ? 1 : 0);
})();
