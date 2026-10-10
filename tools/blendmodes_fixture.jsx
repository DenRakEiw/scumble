// The blend-mode fixture, written by Photoshop (docs/PLAN_NIK9_BUILD.md R4-D6 / R4-S3): backdrop.png as the
// background, the patch once per blend mode in a 6 x 5 grid, each layer named after its mode, saved as
// blendmodes.psd (maximize compatibility on, so the file carries Photoshop's own merged picture), the merged picture
// as blendmodes_merged.png, and modes.json with each mode's cell. The sources come from tools/blendmodes_fixture.py.
//
//   python tools/blendmodes_fixture.py
//   "C:\Program Files\Adobe\Adobe Photoshop 2026\Photoshop.exe" F:\canvas\tools\blendmodes_fixture.jsx
//
// The folder is dist/fixtures/blendmodes next to this repo (DIR below); Photoshop must be able to open PNGs (it can).
// Every layer: opacity 100, fill 100; the three extra layers at the end test opacity 50 and fill 50 (R4-D8).
// ExtendScript's global scope is the application: a top-level `name` reads as the app's name, hence modeName.
/* global app, File, Folder, BlendMode, ElementPlacement, PhotoshopSaveOptions, PNGSaveOptions, SaveOptions, DialogModes */

var DIR = new Folder(File($.fileName).parent.parent.fsName + "/dist/fixtures/blendmodes");
var MODES = [
    ["normal", BlendMode.NORMAL], ["dissolve", BlendMode.DISSOLVE],
    ["darken", BlendMode.DARKEN], ["multiply", BlendMode.MULTIPLY], ["color_burn", BlendMode.COLORBURN],
    ["linear_burn", BlendMode.LINEARBURN], ["darker_color", BlendMode.DARKERCOLOR],
    ["lighten", BlendMode.LIGHTEN], ["screen", BlendMode.SCREEN], ["color_dodge", BlendMode.COLORDODGE],
    ["linear_dodge", BlendMode.LINEARDODGE], ["lighter_color", BlendMode.LIGHTERCOLOR],
    ["overlay", BlendMode.OVERLAY], ["soft_light", BlendMode.SOFTLIGHT], ["hard_light", BlendMode.HARDLIGHT],
    ["vivid_light", BlendMode.VIVIDLIGHT], ["linear_light", BlendMode.LINEARLIGHT], ["pin_light", BlendMode.PINLIGHT],
    ["hard_mix", BlendMode.HARDMIX],
    ["difference", BlendMode.DIFFERENCE], ["exclusion", BlendMode.EXCLUSION], ["subtract", BlendMode.SUBTRACT],
    ["divide", BlendMode.DIVIDE],
    ["hue", BlendMode.HUE], ["saturation", BlendMode.SATURATION], ["color", BlendMode.COLORBLEND], ["luminosity", BlendMode.LUMINOSITY]
];
// three extra cells: multiply at opacity 50, multiply at fill 50, normal at opacity 50 (R4-D8, the fill question)
var EXTRA = [["multiply_opacity50", BlendMode.MULTIPLY, 50, 100], ["multiply_fill50", BlendMode.MULTIPLY, 100, 50], ["normal_opacity50", BlendMode.NORMAL, 50, 100]];
var CELL = 84, ORIGIN = 4, COLS = 6;

app.displayDialogs = DialogModes.NO;
app.preferences.rulerUnits = Units.PIXELS;

var doc = app.open(new File(DIR.fsName + "/backdrop.png"));
var patchDoc = app.open(new File(DIR.fsName + "/patch.png"));
var cells = [];
var all = MODES.concat(EXTRA);
for (var i = 0; i < all.length; i++) {
    var modeName = all[i][0], mode = all[i][1], opacity = all[i].length > 2 ? all[i][2] : 100, fill = all[i].length > 3 ? all[i][3] : 100;
    var col = i % COLS, row = Math.floor(i / COLS);
    var x = ORIGIN + col * CELL, y = ORIGIN + row * CELL;
    app.activeDocument = patchDoc;
    var layer = patchDoc.artLayers[0].duplicate(doc, ElementPlacement.PLACEATBEGINNING);
    app.activeDocument = doc;
    // the duplicate lands at the patch's own position (0, 0): move it to its cell
    var b = layer.bounds;
    layer.translate(x - b[0].value, y - b[1].value);
    layer.name = modeName;
    layer.blendMode = mode;
    layer.opacity = opacity;
    layer.fillOpacity = fill;
    cells.push({ name: modeName, x: x, y: y, w: 80, h: 80, opacity: opacity, fill: fill });
}
patchDoc.close(SaveOptions.DONOTSAVECHANGES);

var psd = new PhotoshopSaveOptions();
psd.maximizeCompatibility = true;
psd.layers = true;
doc.saveAs(new File(DIR.fsName + "/blendmodes.psd"), psd, true, Extension.LOWERCASE);

var flat = doc.duplicate("merged", true);
var png = new PNGSaveOptions();
png.compression = 6;
flat.saveAs(new File(DIR.fsName + "/blendmodes_merged.png"), png, true, Extension.LOWERCASE);
flat.close(SaveOptions.DONOTSAVECHANGES);

var json = new File(DIR.fsName + "/modes.json");
json.encoding = "UTF-8";
json.open("w");
var lines = [];
for (var j = 0; j < cells.length; j++) {
    var c = cells[j];
    lines.push('  {"name": "' + c.name + '", "x": ' + c.x + ', "y": ' + c.y + ', "w": ' + c.w + ', "h": ' + c.h + ', "opacity": ' + c.opacity + ', "fill": ' + c.fill + '}');
}
json.write('{"editor": "Adobe Photoshop ' + app.version + '", "backdrop": "backdrop.png", "patch": "patch.png", "cell": ' + CELL + ', "origin": ' + ORIGIN + ', "cols": ' + COLS + ', "layers": [\n' + lines.join(",\n") + '\n]}\n');
json.close();

doc.close(SaveOptions.DONOTSAVECHANGES);
