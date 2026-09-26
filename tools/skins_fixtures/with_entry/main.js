// A skin must carry no code: this module names itself in plugin.json's "entry", which makes the skin an error row,
// and it must never run. tools/skins_test.py checks that the mark below was never set.
globalThis.__skinFixtureRan = "with_entry";
