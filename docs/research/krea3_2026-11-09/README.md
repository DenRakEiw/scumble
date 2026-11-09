# Krea 3 Edit: the providers' schemas, as read on 2026-11-09

The sources `recipes/krea_3.json` is written from. Nothing here has run against a live API.

| host | file | source |
| --- | --- | --- |
| fal.ai edit | `fal_krea_v3_edit_llms.txt`, `fal_krea_v3_edit_openapi.json` | https://fal.ai/models/krea/v3/edit/llms.txt, https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=krea/v3/edit (`x-fal`: 256..3200 an edge, multiple of 16, 4,220,160 pixels) |
| fal.ai text | `fal_krea_v3_ttimage_llms.txt`, `fal_krea_v3_t2i_openapi.json` | `krea/v3/text-to-image` (reasoning medium / high, no ultra) |
| WaveSpeed edit / text | `wavespeed_krea_v3_edit_llms.txt`, `wavespeed_krea_v3_ttimage_llms.txt` | https://wavespeed.ai/models/krea/v3/edit/llms.txt and `/text-to-image/llms.txt` |
| OpenRouter | `openrouter_krea_k3-edit_llms.txt`, `openrouter_k3-edit_endpoints.json` | https://openrouter.ai/krea/k3-edit/llms.txt, /api/v1/images/models/krea/k3-edit-20260914/endpoints (`input_references` min 1 max 8, `allowed_passthrough_parameters`, prices) |
| Replicate | `replicate_krea-3_input.json` | the input schema embedded in https://replicate.com/krea/krea-3/api/schema |
| Comfy Router | `comfyrouter_krea-3.json` (also `tools/refs/comfyrouter/krea_krea-3.json`) | https://docs.comfy.org/router-schemas/krea/krea-3.json |
| Oxen.ai | `oxen_krea-3.json` (also `tools/refs/oxen/krea-3.json`) | the `krea-3` entry of https://hub.oxen.ai/api/ai/models |
| Comfy Cloud | `tools/refs/comfy_cloud/nodes/Krea3ImageNode.json` | Comfy Cloud's catalog (`get_node`, refreshed), the template `api_krea3_image_edit`, and `comfy_api_nodes/nodes_krea.py` + `comfy_api/latest/_io.py` of the user's ComfyUI v0.44.0 |

Looked at and not listed (no variant): **ToAPIs** (https://docs.toapis.com/llms.txt and its model catalog
`docs/cn/api-reference/models.md`: no Krea), **Magnific** (the whole OpenAPI document,
`fc-freepik-pro-rev1-eu-api-specs/magnific-api-v1-openapi.yaml`: no Krea), **BytePlus ModelArk** (docs page 1330310: no
Krea). Krea's own API is early access through sales: no adapter.

Two things the first reading of the brief had otherwise, each from the sources above:

- Comfy Cloud's catalog names the slot `model.images.item_1`; the wire name is `model.images.image_0` (the node's
  `TemplatePrefix` counts from 0, and Comfy's own template wires `model.images.image_0`).
- fal and WaveSpeed both list a `krea/v3/text-to-image` route, so both have Generate new.
