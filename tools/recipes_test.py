"""The recipe files and the recipe importer: plain Node first, then the app over CDP.

No ComfyUI and no API key. The first step runs tools/recipes_test.js (the shipped recipes' settings slots and
electron/main/recipes.js importFile against a scratch userData folder). The rest drives the running app:

- FLUX.2 [flex] on fal shows three settings rows on three slots and sends three values (until 2026-09-20 the
  safety tolerance shared slot 1 with the step count and went out as both);
- a copy of a shipped recipe with a variant of the user's own imports through the Settings dialog, is served by
  the list as a user recipe, says so in the dialog's note, and its own variant can be chosen and reaches host;
- a provider recipe that names no provider is refused with its own message and writes nothing.

The imported recipe is removed again whatever happens, and the recipe select is put back where it was.

    python tools/recipes_test.py

Start the app first: ./node_modules/.bin/electron . --remote-debugging-port=9555
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import session  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MINE = "flux2_flex_mine"
MY_MODEL = "black-forest-labs/flux.2-flex:free"

PRE = """(async () => {
    const commands = window.__cmds.commands, host = window.__host;
    const run = (n, a) => commands.run(n, a || {});
    const ednow = (id) => host.editors().find((e) => e.node.id === id);
    const note = () => document.getElementById("set-recipe-note").textContent;
    %s
})()"""


def node_step():
    r = subprocess.run(["node", os.path.join(ROOT, "tools", "recipes_test.js")], cwd=ROOT,
                       capture_output=True, text=True, encoding="utf-8", timeout=120)
    tail = (r.stdout + r.stderr).strip()
    if r.returncode != 0 or not tail.endswith("PASS"):
        raise Exception("tools/recipes_test.js: " + tail[-1500:])
    return {"checks": tail.count("[ok]")}


def write_files(dirname):
    """A copy of the shipped FLUX.2 [flex] recipe with an OpenRouter model the app does not ship, and a broken one."""
    with open(os.path.join(ROOT, "recipes", "flux2_flex.json"), encoding="utf-8") as fh:
        mine = json.load(fh)
    mine["id"] = MINE
    mine["name"] = "FLUX.2 [flex] (mine)"
    mine["providers"]["openrouter"] = dict(mine["providers"]["openrouter"], model=MY_MODEL)
    good = os.path.join(dirname, MINE + ".json")
    with open(good, "w", encoding="utf-8", newline=chr(10)) as fh:
        json.dump(mine, fh, indent=2)
    bad = os.path.join(dirname, "no_provider.json")
    with open(bad, "w", encoding="utf-8", newline=chr(10)) as fh:
        json.dump({"kind": "provider", "id": "no_provider", "name": "No provider"}, fh, indent=2)
    return good, bad


SETUP = """
const d = await run("new_document");
window.__r = d.id;
host.shell.activate(ednow(d.id));
window.__shell = await import("./shell.js");
window.__prev = document.getElementById("shell-recipe").value;
return { doc: d.id, recipe: window.__prev };
"""

THREE_SLOTS = """
const ed = ednow(window.__r);
window.__shell.selectRecipe("flux2_flex", "fal");
const keys = Object.keys(ed.settings).sort();
const labels = keys.map((k) => ed.settings[k].label);
if (keys.length !== 3) throw new Error("expected three settings slots, got " + JSON.stringify(ed.settings));
if (new Set(labels).size !== 3) throw new Error("two rows share a slot: " + JSON.stringify(labels));
const params = host.providerParams(ed);
if (params.num_inference_steps !== 50) throw new Error("steps went out as " + JSON.stringify(params.num_inference_steps));
if (params.guidance_scale !== 2.5) throw new Error("guidance went out as " + JSON.stringify(params.guidance_scale));
if (String(params.safety_tolerance) !== "2") throw new Error("safety tolerance went out as " + JSON.stringify(params.safety_tolerance));
if (Object.keys(params).length !== 3) throw new Error("the request carries " + JSON.stringify(params));
return { slots: keys, labels, params };
"""

IMPORT_MINE = """
const r = await window.__shell.importRecipe(%s);
if (!r) throw new Error("the import was refused: " + note());
if (r.id !== "%s" || r.kind !== "provider") throw new Error("imported " + JSON.stringify({ id: r.id, kind: r.kind }));
if (!(r.providerIds || []).includes("openrouter")) throw new Error("the variants came back as " + JSON.stringify(r.providerIds));
const text = note();
if (!/provider/.test(text) || /undefined/.test(text)) throw new Error("the dialog says: " + text);
const list = await window.scumble.recipes.list();
const mine = list.filter((x) => x.id === "%s");
if (mine.length !== 1 || mine[0].source !== "user") throw new Error("the list serves " + JSON.stringify(mine.map((x) => x.source)));
if (mine[0].providers.openrouter.model !== "%s") throw new Error("the model is " + mine[0].providers.openrouter.model);
window.__shell.selectRecipe("%s", "openrouter");
if (host.recipe.id !== "%s" || host.recipe.model !== "%s") throw new Error("host took " + JSON.stringify({ id: host.recipe.id, model: host.recipe.model }));
if (host.recipe.limits.max !== 1440) throw new Error("the limits did not come through: " + JSON.stringify(host.recipe.limits));
return { note: text, model: host.recipe.model, providers: r.providerIds };
"""

IMPORT_BAD = """
const before = (await window.scumble.recipes.list()).length;
const r = await window.__shell.importRecipe(%s);
if (r) throw new Error("a recipe with no provider was imported: " + JSON.stringify(r.id));
const text = note();
if (!/^This provider recipe names no provider/.test(text)) throw new Error("the dialog says: " + text);
const after = (await window.scumble.recipes.list()).length;
if (after !== before) throw new Error("the list grew from " + before + " to " + after);
return { note: text, recipes: after };
"""

CLEANUP = """
const out = {};
try { await window.scumble.recipes.remove("%s"); out.removed = true; } catch (err) { out.removed = String(err.message || err); }
await window.__shell.loadRecipes();
const list = await window.scumble.recipes.list();
out.left = list.filter((x) => x.id === "%s").length;
if (window.__prev) window.__shell.selectRecipe(window.__prev);
out.recipe = document.getElementById("shell-recipe").value;
try { await run("close_document", { doc: window.__r, force: true }); } catch (_) { /* gone */ }
window.__r = null;
if (out.left) throw new Error("the imported recipe is still served");
return out;
"""


async def run_all(c):
    await c.eval("(async () => { window.__cmds = await import('./commands.js'); window.__host = (await import('./editor/host.js')).host; await import('./shell.js'); return 1; })()")
    tmp = tempfile.mkdtemp(prefix="scumble-recipes-")
    good, bad = write_files(tmp)
    ok = True

    async def js(name, body, timeout=120):
        res = await c.eval(PRE % body, timeout=timeout)
        print("[ok] %s: %s" % (name, json.dumps(res)[:280]))
        return res

    try:
        print("[ok] the_recipes_and_the_importer_in_plain_node: %s" % json.dumps(node_step()))
        await js("setup", SETUP)
        await js("flux2_flex_on_fal_has_three_slots_and_sends_three_values", THREE_SLOTS)
        await js("a_copy_with_an_own_variant_imports_and_is_served",
                 IMPORT_MINE % (json.dumps(good), MINE, MINE, MY_MODEL, MINE, MINE, MY_MODEL))
        await js("a_provider_recipe_without_a_provider_is_refused_and_writes_nothing", IMPORT_BAD % json.dumps(bad))
    except Exception as err:  # noqa: BLE001
        ok = False
        print("[FAIL]", err)
    finally:
        try:
            await js("cleanup", CLEANUP % (MINE, MINE))
        except Exception as err:  # noqa: BLE001
            ok = False
            print("[FAIL] cleanup:", err)
        shutil.rmtree(tmp, ignore_errors=True)
    for level, text in (await c.logs())[-15:]:
        if level == "error":
            print("  console error:", text[:220])
    print("PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(0 if asyncio.run(session(run_all)) else 1)
