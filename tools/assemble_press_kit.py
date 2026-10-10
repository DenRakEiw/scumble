import os
import shutil
import zipfile
from PIL import Image

def assemble():
    base_dir = r"F:\canvas\dist\Scumble - Press Kit"
    if os.path.exists(base_dir):
        shutil.rmtree(base_dir)

    dir_logos = os.path.join(base_dir, "01_Logos_and_Icons")
    dir_shots = os.path.join(base_dir, "02_Screenshots_HighRes")
    dir_videos = os.path.join(base_dir, "03_Video_Clips_GIFs")

    os.makedirs(dir_logos, exist_ok=True)
    os.makedirs(dir_shots, exist_ok=True)
    os.makedirs(dir_videos, exist_ok=True)

    # 1. Factsheet
    factsheet_content = """================================================================================
SCUMBLE - FACTSHEET & MEDIA INFO
================================================================================

PROJECT OVERVIEW
----------------
Name:          Scumble
Type:          Open-Source Desktop Image Editor for AI Inpainting & Retouching
Developer:     Dennis Schoeneberg
License:       GNU General Public License v3.0 (GPL-3.0)
Price:         100% Free & Open Source (No subscriptions, No cloud lock-in)
Platforms:     Windows 10/11 (Microsoft Store, Installer, Portable ZIP, winget)
               Linux (x64)

OFFICIAL LINKS
--------------
Website:       https://www.denrakeiw.com/scumble
Source Code:   https://github.com/DenRakEiw/scumble
Documentation: https://www.denrakeiw.com/scumble/manual
Blog / News:   https://www.denrakeiw.com/scumble/blog
Contact:       schoenebergde@gmail.com
Windows CLI:   winget install Scumble

WHAT IS SCUMBLE?
----------------
Scumble is a standalone desktop image editor tailored specifically for generative
AI inpainting, outpainting, and layered retouching. 

Traditional image editors (Photoshop, Krita, GIMP) lack first-class, reproducible
AI generation workflows. Conversely, node-based tools (like ComfyUI) or web-based
generators force users into cumbersome node graphs, cloud lock-ins, or destructive
flat image edits.

Scumble bridges this gap: it provides a complete, familiar desktop editor workflow
(layers, non-destructive filter layers, 27 blend modes, PSD/ORA export) powered by
local ComfyUI execution or cloud API adapters.

KEY FEATURES
------------
1. Layer Stack & Non-Destructive Filters:
   - Full layer stack with opacity, group folders, and clipping masks.
   - Non-destructive filter layers: Film looks, grain, vignette, curves,
     chromatic shift, glass displacement, and colour grading.
   - 27 Photoshop-compatible blend modes with full WebGL2 & Rust/WASM parity.

2. Smart AI Inpainting & Edge Snapping:
   - Built-in ONNX Runtime models (SAM2, RMBG-2.0, Depth Anything V2).
   - Prompt/text-based selection and one-click object segmentation.
   - Depth-aware bilateral edge snapping: generated patches snap seamlessly
     to the depth contours of the original image without halo artifacts.
   - Automatic per-layer colour matching between base picture and inpainting.

3. ComfyUI Integration via "Recipes":
   - Connects directly to local ComfyUI instances or cloud providers (fal.ai,
     OpenAI, Flux, Gemini).
   - "Recipes" provide clean, one-click execution templates with fixed prompt
     fields and reference image chips, eliminating graph spaghetti.
   - Users can import their own custom ComfyUI workflows as recipes.

4. World's First Editor with Native Model Context Protocol (MCP):
   - Built-in in-process MCP server and standalone .mcpb bundle.
   - AI assistants (e.g. Claude Desktop, Cline) can programmatically inspect,
     select, inpaint, apply filters, and manipulate layers on the canvas.

5. Technical Performance & Privacy:
   - Custom tile compositor built in Rust/WASM with SIMD128 acceleration.
   - WebGL2 hardware-accelerated shaders with bit-identical CPU fallbacks.
   - 100% local-first: runs offline, zero telemetry, local credential storage.

MEDIA ASSETS IN THIS KIT
------------------------
- 01_Logos_and_Icons/:
  * scumble-icon-512.png (High-res 512x512 PNG with transparent background)
  * scumble-icon-vector.svg (Clean vector SVG icon)

- 02_Screenshots_HighRes/:
  * 01_main_editor_layers.png (Full UI with image layers and toolbars)
  * 02_depth_map_snapping.png (Smart object selection & depth map workflow)
  * 03_color_grading_wheels.png (Non-destructive filters & grading controls)
  * 04_comfyui_recipe_connection.png (ComfyUI recipe runner & provider settings)
  * 05_export_psd.png (Multi-layer PSD & OpenRaster export dialog)

- 03_Video_Clips_GIFs/:
  * scumble_quick_workflow_demo.gif (Animated 72-frame workflow GIF)
  * scumble_quick_workflow_demo.mp4 (Full workflow demonstration video)
================================================================================
"""

    factsheet_path_txt = os.path.join(base_dir, "Factsheet_Scumble.txt")
    with open(factsheet_path_txt, "w", encoding="utf-8") as f:
        f.write(factsheet_content)

    factsheet_path_md = os.path.join(base_dir, "Factsheet_Scumble.md")
    with open(factsheet_path_md, "w", encoding="utf-8") as f:
        f.write(factsheet_content)

    # 2. Logos and Icons
    src_icon_png = r"F:\canvas\build\icon.png"
    if os.path.exists(src_icon_png):
        im = Image.open(src_icon_png)
        im512 = im.resize((512, 512), Image.Resampling.LANCZOS)
        im512.save(os.path.join(dir_logos, "scumble-icon-512.png"), "PNG")

    src_icon_svg = r"F:\canvas\build\icon.svg"
    if os.path.exists(src_icon_svg):
        shutil.copyfile(src_icon_svg, os.path.join(dir_logos, "scumble-icon-vector.svg"))

    # 3. High-Res Screenshots (converted to crisp PNG)
    shots = [
        (r"F:\portfolio_web\public\projects\scumble\manual\layers.jpg", "01_main_editor_layers.png"),
        (r"F:\portfolio_web\public\projects\scumble\manual\selection.jpg", "02_depth_map_snapping.png"),
        (r"F:\portfolio_web\public\projects\scumble\manual\filters.jpg", "03_color_grading_wheels.png"),
        (r"F:\portfolio_web\public\projects\scumble\manual\recipes.jpg", "04_comfyui_recipe_connection.png"),
        (r"F:\portfolio_web\public\projects\scumble\manual\export.jpg", "05_export_psd.png"),
    ]

    for src_path, dst_name in shots:
        if os.path.exists(src_path):
            im = Image.open(src_path)
            im.save(os.path.join(dir_shots, dst_name), "PNG")
        else:
            print("Warning: Missing screenshot source", src_path)

    # 4. Videos and GIFs
    src_gif = r"F:\canvas\docs\images\readme\hero.gif"
    if os.path.exists(src_gif):
        shutil.copyfile(src_gif, os.path.join(dir_videos, "scumble_quick_workflow_demo.gif"))

    src_mp4 = r"F:\portfolio_web\public\scumble\videos\scumble-explained.mp4"
    if os.path.exists(src_mp4):
        shutil.copyfile(src_mp4, os.path.join(dir_videos, "scumble_quick_workflow_demo.mp4"))

    # Also build a single zip archive for one-click download/upload
    zip_path = r"F:\canvas\dist\Scumble_Press_Kit.zip"
    if os.path.exists(zip_path):
        os.remove(zip_path)

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk(base_dir):
            for file in files:
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, os.path.dirname(base_dir))
                zf.write(full_path, rel_path)

    print("Successfully assembled press kit at:")
    print("Folder: ", base_dir)
    print("ZIP:    ", zip_path)
    print(f"Total files in folder: {sum([len(files) for _, _, files in os.walk(base_dir)])}")

if __name__ == "__main__":
    assemble()
