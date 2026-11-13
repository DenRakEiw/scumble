TITLE = "SP4a Deep paint layer"
WORKING = [
    "renderer/editor/inpaint_surfacefx.js",
    "renderer/editor/inpaint_filters.js",
    "renderer/editor/inpaint_filters_gl.js",
    "renderer/editor/inpaint_ed_panels.js",
    "renderer/editor/inpaint_ed_filters.js",
    "renderer/editor/inpaint_ed_persist.js",
    "renderer/editor/inpaint_ed_geometry.js",
    "renderer/editor/inpaint_ed_layers.js",
    "renderer/commands_edit.js",
    "electron/main/docfile.js",
    "tools/deeppaint_test.py",
    "tools/build_node.py",
]
GATES = ["deeppaint", "composite"]
TILES = "on"
FX = "renderer/editor/inpaint_surfacefx.js"
EF = "renderer/editor/inpaint_ed_filters.js"
GEO = "renderer/editor/inpaint_ed_geometry.js"
DP = {"gates": ["deeppaint"]}
MUTANTS = [
    ("gl_no_early_return", FX, [("    if (p.a <= 0.0) return c;\n", "")], "killed", DP),
    ("gl_no_reflections", FX, [("vec3 t = s_toLin(p.rgb) * s + u_k * r;", "vec3 t = s_toLin(p.rgb) * s;")], "killed", DP),
    ("gl_no_sscale", FX, [("vec2(dot(u_ms0.xy, pp) + u_ms1.x, dot(u_ms0.zw, pp) + u_ms1.y)) * u_sScale;", "vec2(dot(u_ms0.xy, pp) + u_ms1.x, dot(u_ms0.zw, pp) + u_ms1.y));")], "killed", DP),
    ("gl_mix_in_srgb", FX, [("    vec3 b = s_toLin(c.rgb);", "    vec3 b = c.rgb;")], "killed", DP),
    ("gl_own_flipped", FX, [("texelFetch(u_own, ivec2(floor(uv * u_size)), 0);", "texelFetch(u_own, ivec2(floor(vec2(uv.x, 1.0 - uv.y) * u_size)), 0);")], "killed", DP),
    ("gl_map_axes_swapped", FX, [("u_ms0: [ms[0], ms[2], ms[1], ms[3]]", "u_ms0: [ms[0], ms[1], ms[2], ms[3]]")], "killed", DP),
    ("gl_lo_hi_swapped", FX, [("return vec3(u.x + 256.0 * u.y, u.z + 256.0 * u.w, v.x + 256.0 * v.y) / 65535.0;", "return vec3(256.0 * u.x + u.y, 256.0 * u.z + u.w, 256.0 * v.x + v.y) / 65535.0;")], "killed", DP),
    ("cpu_no_sscale", FX, [("const t = SRGB_TO_LIN[p[i + c]] * s[c] * sScale + k * r[c];", "const t = SRGB_TO_LIN[p[i + c]] * s[c] + k * r[c];")], "killed", DP),
    ("cpu_no_pixel_centre", FX, [("const ppx = origin[0] + x + 0.5;", "const ppx = origin[0] + x;")], "killed", DP),
    ("k_ignored", FX, [("    return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : 1;", "    return 1;")], "killed", DP),
    ("own_origin_ignored", EF, [("        const x0 = o[0] / sx, y0 = o[1] / sy;", "        const x0 = 0, y0 = 0;")], "killed", DP),
    ("key_without_px_version", EF, [("        if (FILTERS[layer.filter] && FILTERS[layer.filter].ownPixels) baseKey.push(layer.px ? layer.px.version : -1);\n", "")], "killed", DP),
    ("restore_ignores_paint", "renderer/editor/inpaint_ed_persist.js", [("if (l.ref && l.ref.filename && FILTERS[l.filter] && FILTERS[l.filter].ownPixels) {", "if (false) {")], "killed", DP),
    ("turn_keeps_old_paint", GEO, [("                    l.w = nw; l.h = nh;\n                    if (t.px) l.px = t.px;\n", "                    l.w = nw; l.h = nh;\n")], "killed", DP),
    ("straighten_keeps_old_paint", GEO, [("if (p.maskPx) l.maskPx = p.maskPx; if (p.px) l.px = p.px; continue; }", "if (p.maskPx) l.maskPx = p.maskPx; continue; }")], "killed", DP),
    ("crop_keeps_old_paint", GEO, [("                    if (ownPx(l) && l.px) { l.px = l.px.resized(nw, nh, { x: -left, y: -top }); l.dirty = true; }\n", "")], "killed", DP),
    ("resize_keeps_old_paint", GEO, [("if (ownPx(l) && l.px) { const c = makeCanvas(nw, nh);", "if (false) { const c = makeCanvas(nw, nh);")], "killed", DP),
    ("duplicate_not_stored", "renderer/editor/inpaint_ed_layers.js", [("if (layer.kind === \"filter\" && !(FILTERS[layer.filter] && FILTERS[layer.filter].ownPixels)) copy.dirty = false;", "if (layer.kind === \"filter\") copy.dirty = false;")], "killed", DP),
    ("set_filter_retypes", "renderer/commands_edit.js", [("if (type && type !== l.filter && (FILTERS[type].ownPixels || FILTERS[l.filter]?.ownPixels)) throw", "if (false) throw")], "killed", DP),
    ("feature_never_matches", "electron/main/docfile.js", [("l.kind === \"filter\" && l.filter === \"surface\"),", "l.kind === \"filter\" && l.filter === \"surfacex\"),")], "killed", {"gates": ["document"]}),
]
