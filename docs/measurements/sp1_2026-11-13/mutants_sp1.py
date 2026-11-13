TITLE = "SP1 colour maps"
WORKING = [
    "renderer/editor/inpaint_maps.js",
    "renderer/editor/inpaint_ed_depth.js",
    "electron/main/docfile.js",
    "tools/maps_test.js",
    "tools/maps_test.py",
    "tools/document_test.js",
    "tools/deeppaint/ort_check.js",
]
GATES = ["maps", "document"]
TILES = "on"
M = "renderer/editor/inpaint_maps.js"
MAPS = {"gates": ["maps"]}
MUTANTS = [
    ("pack_bands_swapped", M, [("d[o] = r >> 8; d[o + 1] = g >> 8; d[o + 2] = b >> 8; d[o + 3] = 255;",
                                "d[o] = r & 255; d[o + 1] = g >> 8; d[o + 2] = b >> 8; d[o + 3] = 255;")], "killed", MAPS),
    ("rgba8_alpha_in_file_alpha", M, [("d[o] = src[o]; d[o + 1] = src[o + 1]; d[o + 2] = src[o + 2]; d[o + 3] = 255;",
                                       "d[o] = src[o]; d[o + 1] = src[o + 1]; d[o + 2] = src[o + 2]; d[o + 3] = src[o + 3] || 1;")], "killed", MAPS),
    ("read_one_band", M, [("        const fileH = j.h * e.bands;", "        const fileH = j.h;")], "killed", MAPS),
    ("json_always_u16rg", M, [("        enc: mapEnc(map).json,", "        enc: \"u16rg\",")], "killed", MAPS),
    ("makemap_one_channel", M, [("    const values = ownArray(e.Type, len * e.ch, data);", "    const values = ownArray(e.Type, len, data);")], "killed", MAPS),
    ("derive_drops_enc", M, [("        enc: mapEnc(map).id,\n        w,", "        enc: \"u16\",\n        w,")], "killed", MAPS),
    ("setmap_packs_u16", "renderer/editor/inpaint_ed_depth.js", [("                const c = packMap(map);", "                const c = packRG16(map);"),
                                                               ("makeMap, packMap, selectionOnMap }", "makeMap, packMap, packRG16, selectionOnMap }")], "killed", MAPS),
    ("feature_never_matches", "electron/main/docfile.js", [("Object.values(d.maps).some((m) => m && m.enc != null && m.enc !== \"u16rg\")",
                                                            "Object.values(d.maps).some((m) => m && m.enc != null && m.enc === \"x\")")], "killed", {"gates": ["document"]}),
    ("unknown_enc_read_as_u16", M, [("    const encId = j.enc == null ? \"u16\" : ENC_OF_JSON[j.enc];", "    const encId = j.enc == null ? \"u16\" : (ENC_OF_JSON[j.enc] || \"u16\");")], "killed", MAPS),
]
