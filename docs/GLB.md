# 3D objects: the GLB layer plugin

`plugins/glb/` (built in) places a 3D model in the picture and renders it into an ordinary
paint layer. The point is the inpainting workflow: put the object where it belongs with the
right pose and perspective, then *Generate* over it with a denoise below 1, and the model
paints light, shadow and material into the scene. A render also yields an exact depth map,
which a local depth ControlNet can use where an estimator only guesses.

## Using it

- **Plugins › Place 3D object (.glb)...** or the *3D object* panel in the Image pane: pick a
  `.glb` or `.gltf` file. The dialog shows the picture as the backdrop with the object over
  it. Drag turns the object, Shift+drag moves it, the wheel scales it; the sliders set the
  position (X / Y as a share of the frame), the distance, tilt / turn / roll, the scale, the
  focal length (field of view), the key light's direction and strength and the room light.
  *Ground shadow* adds a soft contact shadow on an invisible ground under the object. *Place*
  renders at the document's resolution and adds the layer, cropped to the object.
- **Depth layer for a ControlNet**: a second, hidden layer with role `control` at the
  document's size, the object's depth with near = white over black.
- **Re-editable**: the file is copied into the local file store and the parameters are kept
  by layer id in the plugin's storage, so *Edit* in the panel (or *Plugins › Edit 3D object*
  on the active layer) reopens the dialog and replaces the layer's pixels and placement. The
  layer is otherwise ordinary: T moves and scales it, Delete removes it, the layer row sets
  opacity and blend, colour match works on it, exports flatten it.

The camera sits at the origin looking down -Z; the object is placed by the point of the
frame its centre projects to, its distance, its rotation and its scale, and the model is
normalised to one unit on its longest side. A photo has no known camera, so the perspective
is matched by eye with the focal length slider: that is honest, and enough for a generation
model to take over.

## Commands

- `glb.place({ path | filename, position: { x, y }, depth, rotation: { x, y, z }, scale, fov,
  light: { azimuth, elevation, intensity, ambient }, shadow, depth_layer, name })`: a new
  layer; `path` copies the file into the store, `filename` reuses one placed before.
- `glb.edit({ layer, ...the same })`: re-render the layer in place with the changed values.
- `glb.info()`: the document's 3D layers with their parameters, and the defaults.

## Inside

- `render.js`: one `WebGLRenderer` for the plugin (made on first use, disposed on unload),
  `GLTFLoader.parse` into a group normalised to a unit box, `RoomEnvironment` through
  `PMREMGenerator` as the environment, a directional key light with a 2048 px shadow map, a
  `ShadowMaterial` ground plane, ACES tone mapping. The colour pass renders with alpha; the
  depth pass uses `MeshDepthMaterial` with the near / far planes hugging the object, so the
  values spread over the object instead of crowding near 1. `alphaBounds` / `crop` cut the
  layer to the object; a document above the GPU's texture limit or 12 MP renders smaller and
  the layer is placed scaled.
- `dialog.js`: a native `<dialog>` (Escape closes it: the editor lets keys inside an open
  dialog through; both `cancel` and `close` are handled, Chromium does not always follow the
  one with the other), the preview coalesced to one render per frame.
- `main.js`: the file into the store through `/upload/image` (a `.glb` is bytes to the mirror;
  the server push, when ComfyUI is connected, is not required), the storage entry
  `{ ref, name, params, depthId }` per layer id, the panel, the actions, the commands.
- `vendor/`: three.js 0.186 (MIT), vendored by `tools/vendor_three.py`, which rewrites the
  example modules' bare `'three'` imports to a relative path because the plugin folder is
  served as plain files. No Draco / KTX2 decoders (they need WASM); such a file fails with a
  clear message.
- Found on the way: `scumble.storage.get()` used to return a promise, so no plugin ever read
  its stored data back (the film pack's group, the AI label's settings). It is synchronous now,
  loaded once before `activate`, and `set` writes through.

## Gate

`python tools/glb_test.py`: a cube written by the test as a valid glTF binary, `glb.place`
with a depth layer (size and centre against the parameters, alpha inside and outside the
silhouette, the colour, the depth layer's role, near brighter than far, black outside), a
second object, `glb.edit` replacing rather than stacking (the face-on cube square), the
dialog through the action with a real Escape, and the objects surviving a reload with
`glb.edit` working on the restored layer.

## Not in stage 1

A live 3D layer kind drawn in the canvas view every frame, a camera solved from the photo,
animations, Draco / KTX2, HDRI files, normals as a control layer, several objects in one
dialog.
