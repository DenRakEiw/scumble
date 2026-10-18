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

    // a timed run (an API run) beside a local Generate, and a pass on ComfyUI under its label
    p.timer({ label: "FLUX.2 [pro] on fal", started: t - 3000 });
    check("a timed run: its label and seconds, busy", last().label === "FLUX.2 [pro] on fal · 3 s" && last().fraction === null, last());
    p.track("C", 4);
    p.event("progress", { prompt_id: "C", node: "2", value: 1, max: 4 });
    check("a local Generate beside an API run: its own label and seconds, the API run's after them",
        /^Generating · step 1\/4 · 0 s · FLUX\.2 \[pro\] on fal · 3 s$/.test(last().label) && last().fraction === 0.25, last());
    p.timer({ label: "Realism Pass", started: t - 5000, promptId: "C" });
    check("the timed run's own prompt: its steps under the timed run's label and seconds",
        /^Realism Pass · step 1\/4 · 5 s$/.test(last().label) && last().fraction === 0.25, last());
    p.event("execution_interrupted", { prompt_id: "C" });
    p.timer(null);
    check("the timed run ended: hidden", last() === null && ticks.filter(Boolean).length === 0, [last(), ticks.filter(Boolean).length]);

    // idle and clear
    p.track("D", 3);
    p.track("E", 3);
    p.idle();
    check("the queue went empty: hidden", last() === null && p.runs.size === 0);
    check("a dropped prompt's events are still wanted (the host routes them here)", p.wants("D") && !p.has("D") && !p.wants("nope"));
    p.event("execution_start", { prompt_id: "D" });
    check("a stale \"queue empty\": the prompt's own event takes it back", p.runs.has("D") && last() && /^Generating/.test(last().label), last());
    p.event("execution_success", { prompt_id: "D" });
    check("an end event does not take a dropped prompt back", p.event("execution_success", { prompt_id: "E" }) === false && !p.runs.has("E"));
    p.track("F", 2);
    p.idle();
    t += 61000;
    check("a minute later it is not wanted", !p.wants("F"));
    check("the queue still holds it: revive brings it back however long it was away", p.revive("F") && p.runs.has("F") && !p.dropped.has("F") && last() && last().label === "Queued", last());
    p.done("F");
    check("revive of a prompt never dropped does nothing", p.revive("G") === false);
    check("a minute later it stays gone", p.event("execution_start", { prompt_id: "F" }) === false && !p.runs.has("F"));
    // a provider's run without sampler steps (Comfy Cloud's frames, measured live 2026-10-18): the share done of all
    // nodes, nodes_done of them whole; under the timed run's own id
    p.timer({ label: "Comfy Cloud", started: t - 4000, promptId: "K" });
    p.track("K", 1);
    p.event("fraction", { prompt_id: "K", value: 0, nodes_done: 0, nodes_total: 1 });
    check("a share of nothing yet: node 1/1, busy, under the run's label and seconds", last().label === "Comfy Cloud · node 1/1 · 4 s" && last().fraction === null, last());
    p.event("fraction", { prompt_id: "K", value: 0.9208333333333334, nodes_done: 11, nodes_total: 12 });
    check("11 of 12 nodes whole, the sampler at 1/20: node 12/12, filled to the running node's part (0.05), not 92 %", /· node 12\/12 · /.test(last().label) && Math.abs(last().fraction - 0.05) < 1e-6, last());
    p.event("fraction", { prompt_id: "K", value: 0.9958333333333332, nodes_done: 11, nodes_total: 12 });
    check("the sampler at 19/20: 0.95", Math.abs(last().fraction - 0.95) < 1e-6, last());
    p.event("fraction", { prompt_id: "K", value: 1, nodes_done: 14, nodes_total: 14 });
    check("all nodes whole (the total grew): node 14/14, busy", /· node 14\/14 · /.test(last().label) && last().fraction === null, last());
    p.track("L", 3);
    p.idle(new Set(["K"]));
    check("the local queue went empty: a local prompt goes, the provider's run in `keep` stays", p.runs.has("K") && !p.runs.has("L") && p.dropped.has("L") && /^Comfy Cloud · node 14\/14/.test(last().label), last());
    p.idle(new Set(["K"]));
    check("idle with only kept runs changes nothing", p.runs.has("K") && p.runs.size === 1);
    p.done("K");
    p.timer(null);
    check("the provider's run ended: hidden", last() === null, last());

    // a local Generate and a provider's run in one tab, in both orders: the local prompt keeps the bar, the provider's
    // run shows beside it as the timed run, and it is not counted as queued
    p.timer({ label: "Comfy Cloud", started: t - 6000, promptId: "P" });
    p.track("M", 5);
    p.event("execution_start", { prompt_id: "M" });
    p.event("progress", { prompt_id: "M", node: "3", value: 4, max: 20 });
    p.track("P", 12);
    p.event("fraction", { prompt_id: "P", value: 0.9375, nodes_done: 11, nodes_total: 12 });
    check("local first, then the provider's frame: the local prompt keeps the bar, the provider's run beside it, nothing queued",
        /^Generating · step 4\/20 · \d+ s · Comfy Cloud · 6 s$/.test(last().label) && last().fraction === 0.2 && last().queued === 0, last());
    p.done("M");
    check("the local prompt ended: the provider's run takes the bar under its own label", /^Comfy Cloud · node 12\/12 · 6 s$/.test(last().label) && Math.abs(last().fraction - 0.25) < 1e-9, last());
    p.track("N", 5);
    p.event("execution_start", { prompt_id: "N" });
    p.event("progress", { prompt_id: "N", node: "3", value: 10, max: 20 });
    check("provider first, then a local Generate: the local prompt takes the bar, the provider's run beside it, nothing queued",
        /^Generating · step 10\/20 · \d+ s · Comfy Cloud · 6 s$/.test(last().label) && last().queued === 0, last());
    // the socket drops (idle keeps the provider's run) and the local prompt comes back, by its own next event or by
    // revive(): it is the run shown again, not "1 more queued" behind the provider's run (review F10)
    p.idle(new Set(["P"]));
    check("the socket lost: the provider's run alone", /^Comfy Cloud · node 12\/12 · 6 s$/.test(last().label) && !p.runs.has("N"), last());
    p.event("progress", { prompt_id: "N", node: "3", value: 11, max: 20 });
    check("revived by its own next event: the local prompt has the bar again, the provider's run beside it, nothing queued",
        /^Generating · step 11\/20 · \d+ s · Comfy Cloud · 6 s$/.test(last().label) && last().queued === 0, last());
    p.idle(new Set(["P"]));
    check("revived by the queue's read: the local prompt has the bar again", p.revive("N") && /^Generating · step 11\/20 · \d+ s · Comfy Cloud · 6 s$/.test(last().label) && last().queued === 0, last());
    p.done("N");
    p.done("P");
    p.timer(null);
    check("both ended: hidden", last() === null, last());

    p.timer({ label: "Upscale", started: t });
    p.clear();
    check("clear ends the timed run too", last() === null && p.timed === null && ticks.filter(Boolean).length === 0);
    check("a renderer that throws does not break it", (() => { const q = new RunProgress(() => { throw new Error("x"); }); q.track("Z", 1); return q.runs.size === 1; })());

    console.log(failed ? `${failed} failed` : "PASS");
    process.exit(failed ? 1 : 0);
})();
