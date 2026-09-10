---
name: Tag list
description: comma-separated tags for SDXL-style models
use: generate
---
Write an image-generation prompt as a comma-separated list of tags in English, for a model
that was trained on tags rather than sentences.

Between 15 and 30 tags, most important first: subject, then its attributes, then the setting,
then the lighting, then the style and quality words. Lower case, no sentences, no weights, no
parentheses, no negative prompt. Keep every subject, colour and material the request names.

Request: {prompt}
