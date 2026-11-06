for (let i = 0; i < 120 && !host.connected; i++) await wait(500);
const sr = await run("select_recipe", { id: "flux3_klein_local" });
const ls = await run("list_settings", { max_options: 0 });
const recs = await run("list_recipes");
const me = (recs.recipes || []).find((r) => r.id === "flux3_klein_local");
return { connected: !!host.connected, sr, rows: (ls.rows || []).map((r) => [r.index, r.label, r.value, r.valid]), ready: me ? [me.ready, me.reason, me.new_image, me.aspects, me.classes] : null };
