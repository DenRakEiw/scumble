TITLE = "SP6: relight on the surface maps, the light brush"
WORKING = [
    "renderer/editor/inpaint_relight.js",
    "renderer/editor/inpaint_surfacefx.js",
    "renderer/editor/inpaint_filters.js",
    "renderer/editor/inpaint_ed_filters.js",
    "renderer/commands_runs.js",
    "electron/main/main.js",
    "renderer/shell.js",
    "tools/deeppaint_test.py",
]
GATES = ["deeppaint", "relight"]
TILES = "on"

R = "renderer/editor/inpaint_relight.js"
F = "renderer/editor/inpaint_filters.js"
E = "renderer/editor/inpaint_ed_filters.js"
K = {"gates": ["deeppaint"]}

MUTANTS = [
    ("gl_keep_without_R", R,
     [("vec3 keepLin = u_surf == 1 ? sR + u_original * fLin * sS : u_original * pLin;",
       "vec3 keepLin = u_surf == 1 ? u_original * fLin * sS : u_original * pLin;")],
     "killed: the reflections lost on the GPU", K),
    ("cpu_base_without_R", R,
     [("const baseR = surf ? surf.r[0] + o * keepR : o * pr,",
       "const baseR = surf ? o * keepR : o * pr,")],
     "killed: the CPU twin loses R in red", K),
    ("gl_albedo_without_R", R,
     [("fLin = vec3(sS.r > 1e-4 ? (pLin.r - sR.r) / sS.r : 0.0,",
       "fLin = vec3(sS.r > 1e-4 ? (pLin.r) / sS.r : 0.0,")],
     "killed: the GPU's colour keeps R (the twin disagrees)", K),
    ("cpu_no_sscale", R,
     [("surf.s[0] *= sScaleS; surf.s[1] *= sScaleS; surf.s[2] *= sScaleS;",
       "surf.s[0] *= 1; surf.s[1] *= 1; surf.s[2] *= 1;")],
     "killed: the CPU twin without sScale", K),
    ("surface_never_on", R,
     [("return !!(params && params.surface && m && m.shading",
       "return !!(false && params && params.surface && m && m.shading")],
     "killed: the surface branch never runs", K),
    ("no_surface_default", E,
     [("if (this.hasSurfaceMaps && this.hasSurfaceMaps()) params.surface = true;",
       "if (false) params.surface = true;")],
     "killed: a new relight layer keeps the fit", K),
    ("brush_mask_reveals", E,
     [("        this.fillLayerMask(layer, false);\n        layer.maskEdit = true;",
       "        this.fillLayerMask(layer, true);\n        layer.maskEdit = true;")],
     "killed: the light brush lights everything at once", K),
    ("maps_list_depth_only", F,
     [("maps: (p) => (p && p.surface ? [\"depth\", \"shading\", \"residual\"] : [\"depth\"]),",
       "maps: (p) => [\"depth\"],")],
     "unknown: relight already keys on mapsVersion for depth", K),
]
