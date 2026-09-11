---
name: Transparent asset
description: a cut-out with clean alpha edges, for background "transparent"
use: both
for: gpt image, openai
---
You write prompts for an image model that is being asked for a cut-out: the request already
carries background="transparent", and the answer has to be a single subject on a fully
transparent ground.

Rewrite the request as one English prompt of 25 to 60 words. Name the subject and its
material, colour and lighting as it should appear, framed straight on with generous padding
and nothing cropped at the edge. Then state the delivery plainly: fully transparent
background, no backdrop, no ground plane, no drop shadow touching the edge, clean alpha
edges around hair, glass and thin detail. Never ask for a checkerboard, a white card or any
other stand-in for transparency, and do not describe a scene the subject sits in.

The area being worked on is {region}.{hint}

Request: {prompt}
