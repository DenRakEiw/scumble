# Release review of 0.1.53, 2026-11-09

Each was found by one reviewer and verified against the code by a second agent. Sorted by severity. `Fix` is the verifier's.

## 1. [should] start-brushtips-skipped-by-new-load-throw (renderer/shell.js:3296)

**Claim:** The fix-main pack made `autosave.load` throw on a read error (`if (r.status === "error") throw r.error;`); in 0.1.52 it returned null. The start code has `const saved = startMode === "safe" ? null : await window.scumble.state.load(); await host.loadBrushTips();` inside one try, so that throw skips `loadBrushTips`. The session then runs with an empty `brushLibrary`, and the next tip change deletes every stored tip: `saveBrushTips` sends only the library, and `brushes.js` `save` does `if (m && !keep.has(m[1])) await fsp.unlink(...)` and rewrites brushes.json.

**Scenario:** A 0.1.52 user has imported brush tips. At the first start after the update, autosave.json is held by an antivirus scan or backup or sync tool for longer than the 250 ms of retries, or the read fails with EIO, so `state:load` rejects. The catch logs only "no autosaved state", and the app opens an empty tab whose Tip list shows only Round. The user imports one new .abr or PNG tip, removes one, or changes a tip's spacing; `brushTipsChanged` calls `saveBrushTips`. Every earlier tip's PNG is unlinked and brushes.json is rewritten without them, permanently. The trigger is rare, but the store-locked state is exactly what this release set out to survive, and the same locked read in 0.1.52 left the tips alone.

**Verified:** The code shows the regression. In 0.1.52 `readJson` was `try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }`, so `load` could not throw. In 0.1.53 `load` has `if (r.status === "error") throw r.error;`. The `state:load` handler passes that to the invoke as a rejection. At renderer/shell.js:3296-3297, `const saved = ... await window.scumble.state.load(); await host.loadBrushTips();` sit in one try, so the throw skips `loadBrushTips`. That is the only call site, so `brushLibrary` stays [] for the session. A later import, remove or spacing change reaches `saveBrushTips`, which sends only the library. brushes.js `save` then does `if (m && !keep.has(m[1])) await fsp.unlink(...)` and rewrites brushes.json, so the deletion is permanent. I rate it should rather than must despite the data loss. It needs a non-ENOENT read failure that outlasts the retries (EPERM, EBUSY or EACCES past 250 ms, or any other code such as EIO at once) and also a tip change in that same session, and the Tip list visibly shows only Round beforehand. The 2 s cooldown can shorten the retries if `rotate` already failed on the same file.

**Fix:** Move the tips out of the autosave try and run them first: `try { await host.loadBrushTips(); } catch (err) { console.warn(err); }`, then `state.load()` and `host.restore()` in the existing try. Worth adding: have `loadBrushTips` set a flag when `brushes.list` fails, and refuse `saveBrushTips` while it is set.

## 2. [nice] UR-1 (CHANGELOG.md:23)

**Claim:** The Liquify bullet says "a 200 px push at 1:1 lands in 19 ms instead of 31". The committed K28 measurement does not show that. docs/measurements/k28_2026-11-08/summary.txt reads "push 1:1 size 200 land 24.9 [19.2-26.2] -> 20.0 [19.7-23.1] inside the spread -> tie rule", and the three before runs in ab/before/liquify_r*.json are 26.2, 24.9 and 19.2, so none reaches 31. The same 31 -> 19 appears only in docs/PLAN_WASM_BUILD.md near line 1867.

**Scenario:** A reader of the 0.1.53 notes takes a 39 % faster landing as measured. The committed data has medians of 24.9 and 20.0 ms with overlapping ranges, and K28's summary itself treats this row as a tie decided by the pool sum.

**Verified:** The 31 -> 19 figure comes from a superseded measurement. K28's first summary (c6bbbb71) had 'push 1:1 size 200 land 30.7 -> 18.8', with the before arm as KERNELS "js", so every kernel ran in JS. The review fix 9979f58b ('isolate liquifyBlock route in perf harness') replaced it with the committed row '24.9 [19.2-26.2] -> 20.0 [19.7-23.1] inside the spread -> tie rule'. I tried to refute it with the October baselines (K0b 30.2 / 30.4, W0b 27-37 ms). They are other sessions with no A/B, so they do not back the bullet's claim that the Rust bake gives this gain. The only isolated A/B is the tie.

**Fix:** CHANGELOG line 23: use 'about 20 ms instead of 25', or drop the landing figure and keep the pool's 1.8x. Correct the stale '31 -> 19' in docs/PLAN_WASM_BUILD.md near line 1867 as well.

## 3. [nice] UR-2 (CHANGELOG.md:13)

**Claim:** "Up to 4096 px on the long side the export and the screen agree exactly; on larger pictures a hard colour edge can differ in a band a few pixels wide, as long as the picture below is still the one the depth map was made from." The condition is attached only to the larger-picture clause, but it applies to both. limitAlphaRows is called without col (inpaint_canvas.js:15727, `limitAlphaRows(rows, 0, y0, W, y1 - y0, p.limit, depthMap)`), so the export snaps to the stored map.guide, while the screen snaps to the current picture below (docs/BUGS.md: "as long as the picture below is still the one").

**Scenario:** A 3000 px picture, depth computed, then the base painted on or a result layer placed under the fill layer with a depth limit and edge snap. The screen follows the new picture and the PSD's fill alpha follows the old guide, so the two differ even though the note says they agree exactly below 4096 px.

**Verified:** inpaint_canvas.js:15712 and :15727 call limitAlphaRows without col, so the export takes its reference colour from the stored map.guide. docs/BUGS.md line 36 says the screen uses the colour of the picture below and matches the export only 'as long as the picture below is still the one the depth map was made from', and states the 4096 px limit separately. In the CHANGELOG the 'as long as' sits after the semicolon, so it reads as a condition on the larger-picture clause only. Below 4096 px 'agree exactly' is then unconditional, which is wrong once the base is painted on after the depth was computed.

**Fix:** Put the condition first: 'As long as the picture below is still the one the depth map was made from, export and screen agree exactly up to 4096 px on the long side; on larger pictures a hard colour edge can differ in a band a few pixels wide.'

## 4. [nice] UR-3 (CHANGELOG.md:15)

**Claim:** The Each area bullet says "While the areas run the button reads *Stop*; it and Cancel stop the run going and the areas not yet sent." That is true only for API runs. On the user's ComfyUI the button's own tooltip says "Click to stop: the area going finishes there, the areas not yet sent never go." (eacharea.js near 302), and the manual says "one on your ComfyUI finishes there".

**Scenario:** A user runs Each area on a local recipe and presses Stop, expecting the render to stop as the release note says. The current area renders to the end and lands.

**Verified:** eacharea.js:302, the local tooltip, reads 'Click to stop: the area going finishes there, the areas not yet sent never go.' The comment at :268 and docs/MANUAL.md:105 say the same ('an API run as Cancel does; one on your ComfyUI finishes there'). The CHANGELOG says without qualification that it and Cancel 'stop the run going and the areas not yet sent', which is untrue for the area already rendering on the user's ComfyUI.

**Fix:** Use the manual's parenthesis: 'it stops the run going (an API run as Cancel does; one on your ComfyUI finishes there) and the areas not yet sent'.

## 5. [nice] UR-4 (CHANGELOG.md:22)

**Claim:** Two bullets give different before figures for the same operation. Line 16 says "frequency separation of a 16-megapixel area about 1 s instead of 2 s" (K26), and line 22 says "frequency separation of a 4000 x 4000 area takes 0.72 s instead of 1.03 s" (K27). 4000 x 4000 is the same 16 MP box, and each figure is one session's step. Against 0.1.52 the real change is 2.05 s -> 0.72 s (k26 summary_rows 2053.3 -> 1012.0, k27 summary 1,032.9 -> 715.8). The liquify and select-by-depth bullets already give cumulative figures.

**Scenario:** A reader sees 2 s -> 1 s and 1.03 s -> 0.72 s for one size and cannot tell what 0.1.53 does compared with 0.1.52. Neither bullet states the actual result of 0.72 s against 2 s.

**Verified:** Both figures are the same row, 'freqsep 4000^2 r 40 wall': K26 2053.3 -> 1012.0 and K27 1032.9 -> 715.8. Each is one session's step. Against 0.1.52 the result is about 2 s -> 0.72 s, which neither bullet states, and the notes describe this release against the last one.

**Fix:** State it once as about 0.7 s instead of 2 s in the K26 bullet, and remove frequency separation from the dodge / burn and sponge bullet.

## 6. [nice] UR-5 (CHANGELOG.md:20)

**Claim:** The filter sizes bullet says layers of a plugin that is off keep their sizes "(the status line names them)". The line gives only a count: inpaint_canvas.js:6214 `keptFilters === 1 ? " 1 filter layer of a plugin that is off kept its sizes." : ` ${keptFilters} filter layers of plugins that are off kept their sizes.``. The manual has it right ("the status line names how many").

**Scenario:** After a resize with two such layers the user looks for their names in the status line and finds only "2 filter layers of plugins that are off kept their sizes."

**Verified:** inpaint_canvas.js:6214 builds only a count ('${keptFilters} filter layers of plugins that are off kept their sizes.'), so the status line names no layers. docs/MANUAL.md:313 has it right: 'the status line names how many'. The CHANGELOG's 'the status line names them' is inaccurate.

**Fix:** Change to '(the status line says how many)'.

## 7. [nice] UR-6 (electron/main/updater.js:91)

**Claim:** The 0.1.53 section has 35 top-level bullets and releaseHeadlines stops at 30 (`if (out.length >= 30) break;`). updateQuestionDetail in renderer/shell.js computes its tail from the capped list: `… and ${heads.length - lines} more in Settings › Updates.`. So the update question undercounts.

**Scenario:** A 0.1.52 user gets the update question for 0.1.53. It shows eight headlines and "… and 22 more in Settings › Updates", while 27 more are listed there. The five dropped from the headline list are the last bullets: the noisy-picture save fix, Hardening, --run, Snapping and the eyedropper.

**Verified:** The 0.1.53 section has 35 top-level bullets. updater.js:91 stops at 30 (`if (out.length >= 30) break;`) and shell.js:2641 computes `heads.length - lines` from the capped list with lines = 8. The tail therefore says '22 more' while 27 more exist in Settings › Updates. A 0.1.53 section this long is the first to exceed the cap with a single release's notes. Nothing is lost except the count, and Settings shows the full notes.

**Fix:** Pass the true total beside the capped list, or raise the cap. Optionally move the new features and the data-loss fix above the speed bullets.

## 8. [nice] UR-7 (docs/HELPERS.md:395)

**Claim:** The depth section still says "Runs on the main process thread via DirectML on Windows and CPU on Linux". Since U1 depth runs in the helpers' utility process, as the same file says at line 244 ("never on the main process's thread") and as the CHANGELOG says ("SAM2, the background-removal models and depth now run in a process of their own").

**Scenario:** Someone reading docs/HELPERS.md for the depth feature concludes it still blocks the main process, which contradicts the 0.1.53 note and the file's own architecture section.

**Verified:** docs/HELPERS.md:395 still reads 'Runs on the main process thread via DirectML on Windows and CPU on Linux'. The same file says at :244 'The models run in processes of their own, never on the main process's thread', and :239 lists the depth job in engine.js in the helpers' process. The depth line was not updated for U1.

**Fix:** Change to 'Runs in the helpers' process (main's thread only after the fallback) via DirectML on Windows and CPU on Linux'.

## 9. [nice] unsafe-recipe-id-orphans-stored-settings (electron/main/recipes.js:292)

**Claim:** H1's `readId` rewrites an id read from the user folder (`my recipe` becomes `my_recipe`) with only a console warning, and nothing migrates the settings keyed by the old id. `settings.recipe`, `recipeByMode`, `recipeProviders`, `recipePresets` and `recipeLoras` keep the old key and no recipe matches it any more.

**Scenario:** A 0.1.52 user has a hand-placed `<userData>/recipes/my recipe.json` with no `id` (the id came from the file name) or an id with a space, selected, with LoRA rows and a preset stored. After the update `selectRecipe(settings.recipe)` finds no match and falls back to `recipes.find((x) => x.task !== "relight")`, which may be a paid API recipe, and then writes that over `settings.recipe` and `recipeByMode` without a word. The LoRA rows and presets under the old key are never read again, and a downgrade finds the selection already overwritten. Imports always made slugged ids, so only hand-placed files are affected.

**Verified:** The code shows it. 0.1.52 had `r.id = r.id || n.replace(/\.json$/, "")`. 0.1.53 wraps that in `readId`, which turns an unsafe id into `s.replace(/[^A-Za-z0-9._-]+/g, "_")` with only a console.warn, and nothing migrates the settings. `selectRecipe` at shell.js:543 then falls back with `recipes.find((x) => x.id === id && x.task !== "relight") || recipes.find((x) => x.task !== "relight")`, and line 561 writes the fallback over `recipe` and `recipeByMode`. LoRA rows are read by `this.loras[id]`, so rows under the old key are no longer read. Only hand-placed files are affected, which docs/RECIPES.md:621 acknowledges exists; `slug` only emits [a-z0-9_]. Nothing is deleted and the recipe still lists under its new id, so the cost is a silent recipe switch and re-entering the rows. CLAUDE.md already lists this as an open question for the user ("H1: ids made safe vs settings stored under an old id").

**Fix:** At `loadRecipes`, move the `recipe`, `recipeByMode`, `recipeProviders`, `recipePresets` and `recipeLoras` entries from the old id to the new one once and say so in the status line, or at least name the id change in the status line. This is the user's open H1 question.

## 10. [nice] renamed-plain-ref-reuploaded-every-run (electron/main/files.js:353)

**Claim:** When `ensureOnServer` uploads a plain-named file and the server stores it under another name, the mapping lives only in that call's `report.renamed`, and `known` is not updated (`if (serverName && serverName !== ref.filename) { report.renamed[k] = serverName; ... } else { known.add(k); }`). The editor keeps the plain ref, so every later run repeats the HEAD, the read of the whole file and the upload.

**Scenario:** An old document's base `photo.png` meets a ComfyUI whose input folder holds another `photo.png` of a different size, the state D1 handles. The first run uploads it as `photo (1).png`. Each following Generate again HEADs `photo.png`, sees the size mismatch, reads the file and POSTs it with overwrite false. ComfyUI's hash compare dedupes it to `photo (1).png`, so the picture is right. But on a remote server (RunPod) a 150 MB base goes over the network on every run, the status says "Uploaded 1 file" each time, and the main process reads the file again each time.

**Verified:** The code shows it. In `ensureOnServer`, the rename branch sets `report.renamed[k] = serverName; ref.filename = serverName;` and only the else branch does `known.add(k)`; `pushToServer` also skips `knownSet().add` on a rename. The rewrite is applied only to the queued copy (host.js:5549, `if (ensured && typeof ensured.state === "string") state = ensured.state;`), and I found no write back to the editor, so the next run asks again for the plain name. Its HEAD still sees the other file's different size (`Number(len) === st.size` is false), so the file is read and POSTed again and the status says "Uploaded 1 file". The picture sent is correct and the case only arises for plain-named refs from old documents meeting a different file on the server, so the cost is repeated traffic on remote servers. A detail in the suggested fix checks out: `prune` does `this.known.clear()`, so the map can be cleared at the same point.

**Fix:** Keep a per-server map from plain key to server name beside `known`. Fill it on a rename, clear it with `known`, answer from it before the HEAD by setting `ref.filename` and `report.renamed[k]`, and drop the entry when the mirror file's size changes.

## 11. [nice] EachArea-x-Krea-sent-count (renderer/editor/host.js:2468)

**Claim:** Pieces and sequence: item 54 marks an area as sent just before `providerEdit` and takes that back only when the error text matches NOT_SENT. Krea 3 was merged later and adds a new step before the job exists: `kreaAsset` POSTs each picture to /proxy/krea/assets and throws `Comfy Router ...: the upload of the crop failed: ...`. That text does not match NOT_SENT, so a run that never submitted a job counts as sent. The code is `if (area && !token.cancelled) area.sent = true; try { res = await providerEdit(request, token); } catch (err) { if (area && NOT_SENT.test(...)) area.sent = false; throw err; }`.

**Scenario:** The recipe is Krea 3 Edit via Comfy Router and Each area runs 3 areas. Area 2's asset upload answers 401 or 5xx, so no Router job was submitted and nothing is charged. runEachArea reads `failedSent = area.sent` (true), so `sent` is 2 and the line says `Each area stopped at area 2 of 3: ...` instead of `stopped before area 2 of 3 was sent`. The generate each_area MCP result reports `sent: 2`, which its description defines as the areas that went out and are charged on an API model. The true count is 1.

**Verified:** Code confirms the path. host.js:2467 sets `area.sent = true` before `providerEdit`, and line 2468 resets it only when NOT_SENT matches. In comfyrouter.js `run()`, `d.body(...)` (line 997) reaches `krea3Body`, then `kreaAsset`, which throws `Comfy Router ${modelId}: the upload of the ${pic.what} failed: ...` (line 350) before `send` (line 1003). providers/index.js:317-318 rethrows that error unchanged, because only an aborted run gets new words. NOT_SENT has no alternative matching that text. eacharea.js:508 then takes `failedSent = area.sent`, `inFlight` is 1, so `sent` is done + 1, and line 569 says 'stopped at area' instead of 'stopped before area ... was sent'. The MCP tool describes `sent` as the areas that went out, 'charged on an API model', yet no Router job exists, so the count is one too high. Impact is small: the status line still carries 'the upload of the crop failed', the count errs on the cautious side, and no pixels or money are lost. It is also not unique to Krea: comfypartner.js:111 has the same kind of pre-submit upload failure text.

**Fix:** Use what main already tracks: `run()` sets `flags.jobSent = false` before anything goes out. Have main mark the error when `ctx.jobSent === false` (for example a 'nothing was sent' suffix that NOT_SENT already matches, or a field carried across IPC), instead of extending the regex per provider.
