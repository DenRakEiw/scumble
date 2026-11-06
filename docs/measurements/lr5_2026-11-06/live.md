# LR5's live runs on Comfy Cloud, 2026-11-06

The user's yes in chat ("ja", to the two paid runs). Scumble from `.claude/worktrees/corridorkey` at `eb77d4d`, a dev
instance on port 9571 with the profile `lr5_profile` (the Comfy key typed in by the user; never read here), `--no-comfy`,
restarted on that commit before the runs; driven over CDP through the command core (`new_document`, `load_image`,
`select_recipe`, `set_generation` mode cloud, seed 424242 and `loras`, `set_prompt`, `select_all`, `generate`,
`export_layer`). The machine's busy lock held for both runs ("LR5 live runs (main session)", 09:55, released after).

Picture: LR9's "arch", `docs/images/tutorial/scene-clean.jpg` cropped to (0, 0, 860, 520). Prompt (LR9's E1):
"Change only the sky to a warm orange sunset. Keep the building, the tree, the car and the composition unchanged."
"mean" = the mean absolute difference (0-255, RGB) of the exported result layer against the picture; "lower 40 %" the
same over the crop's lower 40 % (no sky there).

| run | recipe / rows | app s | via line | mean | lower 40 % |
|---|---|---|---|---|---|
| Q | `cloud_qwen_image_edit_2509`, `qwen-80s_fantasy_movie.safetensors` 1.0 | 32.7 | Qwen Image Edit 2509 (Comfy Cloud) via Comfy Cloud + 1 LoRA: qwen-80s_fantasy_movie 1.0, 32 s | 34.2 | 30.5 |
| M | `cloud_moss_image_edit`, no rows | 26.8 | MOSS-Image Edit (Comfy Cloud) via Comfy Cloud, 26 s | 46.5 | 29.7 |

- Q: `loras_sent` and `editor.lastLoras` `[{ name: "qwen-80s_fantasy_movie.safetensors", strength: 1 }]`, the note
  "LoRAs: qwen-80s_fantasy_movie 1.0.", the edge fit "aligned (shift -6.2, -0.2 px, scale 1.0104, 0.9903)". The sky a
  pastel, painted sunset with streaks, the whole picture a cool film grade with deep blacks; the building, the tree and
  the car kept (`Q_crop_vs_answer.jpg`: the picture, then the answer). Comfy Cloud took the name; that the weights
  took effect is judged by eye only (no run without the row, no Cloud log).
- M: `loras_sent` `[]`, no note. An orange sunset, the facade in warm evening light, the tree and the car kept
  (`M_crop_vs_answer.jpg`). The recipe's first run on Comfy Cloud.
- Not run: Generate new of `cloud_moss_image_edit` on Comfy Cloud, an own import under *Your imports* (the user's
  call), a failed Cloud run's LoRA note against the real asset list.
