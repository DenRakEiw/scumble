# licences

## Summary

The deciding points for the design:

1. **CK2's licence (Corridor Key Licence 2.0) covers both the code and the weights.** It is CC BY-NC-SA 4.0 plus Corridor's own terms, which take precedence. Using it on commercial projects is allowed and the outputs belong to the user. It forbids selling the tool, a paid API or inference service, and charging for access to the code or weights. Any public derivative must be free, stay under the same licence and keep the name "CorridorKey". A commercial software package needs a written agreement. Organisations with more than US $20M revenue need one paid seat per person who uses it.

2. **Neex's message waives the "commercial software integration" and "competing product" worries for a free Scumble**, including the free Store copy. It does not clearly cover these points:
   - whether Scumble's port of the inference and pre/post-processing code may be released under GPL-3.0 (the share-alike clause conflicts with GPL §10);
   - whether Scumble may host converted ONNX or fp16 weights;
   - the $20M seat rule, which applies to end users through Scumble too;
   - donations;
   - how Corridor wants to be credited.

   The thank-you reply should ask Corridor to confirm these in one written sentence.

3. **The "RVM" in v2 is Google DeepMind's Recurrent Video MAE, not Robust Video Matting.** The three foundation models are not bundled; Corridor's script downloads them from their publishers:
   - C-RADIOv4-SO400M: NVIDIA Open Model License, commercial use OK, a Notice file is required on redistribution; 1.72 GB.
   - MoGe-2 ViT-B: MIT; 419 MB.
   - RVM small: CC BY 4.0 weights, Apache-2.0 code; 270 MB.

   With CK2's own 2.66 GB, the total is about 5.08 GB.

4. **Scumble's rule and precedent:** none of these may go into the installer, MSIX or zip. The RMBG pattern fits: a download the user starts in Settings › Helpers, with the licence named in the row.

5. **ONNX:** there is no official CK2 ONNX. Two community exports exist: Nucito/corridorkey-web (fp16, 2.43 GB, one day old, ships C-RADIO without NVIDIA's Notice file) and ZumaInnovations' C-RADIO export (opset 17). The official MoGe ONNX lacks the encoder output CK2 needs.

6. **v1 is out anyway:** it is fine-tuned from Meta's Hiera weights, which are CC BY-NC 4.0.

7. **Store:** no policy names model licences. 10.2.2 (dynamic code) and 11.2 (licensed content) are satisfied by a user-started download from the rights holders. Policy 7.20's 11.16 (generative AI disclosure) applies to Scumble generally.

## Report

# CorridorKey 2.0 in Scumble: licences and third-party components

Clone folder (read only, never run): `C:\Users\SCHOEN~1\AppData\Local\Temp\claude\F--canvas\543d44fb-4d2d-4818-8804-974916d10a44\scratchpad\ck_licences\`. It holds:
- `ck` = nikopueringer/CorridorKey @ `97e55a4`, 2026-05-28
- `ck2` = nikopueringer/CorridorKey2.0 @ `485f5e9`, 2026-10-15
- `hf/` = model cards, licence texts and the NVIDIA OML text extracted to `nvidia_oml.txt`

Abbreviations:
- `CK2-LIC` = https://github.com/nikopueringer/CorridorKey2.0/blob/485f5e9ab759ead6138cc990776184b59d6ea971/LICENSE
- `CK1-LIC` = https://github.com/nikopueringer/CorridorKey/blob/97e55a453060745bead1befd293f6e523c4b845c/LICENSE

The Hugging Face copy of the v2 LICENSE (https://huggingface.co/nikopueringer/CorridorKey2.0/blob/cf44a8d/LICENSE) is byte-identical to the GitHub one apart from line endings (diff after CR removal: empty). **read**

---

## 1. CorridorKey's licences

### 1a. v2: "CORRIDOR KEY LICENCE Version 2.0", Corridor Digital LLC

It is CC BY-NC-SA 4.0 with additional terms that "take precedence where they conflict" (CK2-LIC l.1-25). **read**

**Scope.** "This tool" means the CorridorKey software *and the model weights distributed for use with it* (l.19). So the weights carry the same terms as the code. **read**

**What it allows:**
- **§1(a), permitted use:** any lawful purpose, "including for processing images as part of a commercial project" (l.27-33). **read**
- **§1(b), outputs:** the images and video you produce are yours, "You may use them commercially" (l.34-36). **read**
- **Donations:** voluntary donations and pay-what-you-want are allowed if paying nothing stays possible (in §2(c)). **read**

**What it forbids or requires:**
- **§2(a), no repackaging or resale:** no repackaging, redistributing, sublicensing or selling the tool "as a standalone product or as part of a competing product"; no charging for access to its code or weights (l.44-49). **read**
- **§2(b), no paid API or inference services,** "directly or indirectly": no paywall, subscription or usage billing (l.50-56). **read**
- **§2(c), derivatives must be freely accessible:** any project, fork, derivative or modified version you release that incorporates the tool must be free of charge to the public (l.57-64). **read**
- **§2(d), commercial software integration:** "If you operate a commercial software package or inference service" you need a separate written agreement; contact@corridordigital.com (l.65-72). **read**
- **§3, large organisations (the revenue clause):**
  - If you are, or act for, a Legal Entity with gross revenue above US $20M in its last fiscal year, the §1 permissions do not apply unless it bought one CorridorKey plugin seat per individual user (l.74-94). **read**
  - Revenue counts across the whole group under common control (l.86). **read**
  - Seats are sold at corridorkey.com: $27 personal beta price, $42.50 per seat studio beta price, one-time purchase (https://corridorkey.com, fetched 2026-10-24). **read**
- **§4, attribution:** in addition to CC 3(a), any attribution notice must include the name "CorridorKey". Any fork or derivative must keep "CorridorKey" "in a reasonably prominent position". "Corridor Key" is also fine (l.96-108). **read**
- **§5, share-alike:** publicly released variations or derivatives must be distributed under this same licence, including the additional terms, "or a licence with substantially equivalent terms" (l.110-116). **read**
- **§6, third-party components:** these stay under their own licences, listed in THIRD_PARTY_NOTICES.md (l.118-124). **read**
- **§7:** disclaimer of enforceability (l.126). **read**
- **§8:** contributions to the repository are licensed back to Corridor (l.135). **read**

**The CC BY-NC-SA 4.0 base that still applies under the additional terms:**
- Grant "for NonCommercial purposes only", for sharing and for Adapted Material (CK2-LIC l.315-324). **read**
- NonCommercial means "not primarily intended for or directed towards commercial advantage or monetary compensation" (l.285). **read**
- §2(a)(4): format shifting is allowed, and "simply making modifications authorized by this Section 2(a)(4) never produces Adapted Material" (l.334-345). **read**
  - An ONNX or fp16 conversion is arguably a technical modification of format, not Adapted Material. **inferred, not settled**
- No downstream restrictions and no technical protection measures on the licensed material (l.360-366). **read**
- Patents and trademarks are not licensed (l.384). **read**
- Attribution: creator, copyright notice, licence link, marking modifications; can be met by a link (l.404-439). **read**
- ShareAlike: the Adapter's License must be BY-NC-SA or a compatible licence (l.448-461). **read**

**README summary (l.625-645):** "Use CorridorKey for whatever you'd like, including processing footage for commercial projects." The same restrictions follow. It adds a line about Zachary Harris's contact and says the model was "designed and trained by Zachary Harris, in direct collaboration with Niko and Corridor Digital" (README l.3, l.16). **read**

**Dates:**
- LICENSE history: a single commit `26481253` "CorridorKey 2.0", 2026-10-13. **read**
- The GitHub repo was created 2026-07-15; the HF repo on 2026-10-13. **read**

### 1b. v1: "CORRIDOR KEY LICENCE Version 1.0", Corridor Digital

CK1-LIC l.1-100. Compared with v2, the differences are:
- No definition saying the weights are part of "the tool".
- No outputs clause.
- No "derivatives must be free" clause.
- **No $20M revenue clause.**

The rest is the same:
- §1 permitted use including commercial projects (l.24-30).
- §2(a) no repackaging or resale (l.37).
- §2(b) no paid API (l.42).
- §2(c) commercial software integration needs an agreement (l.49).
- §3 attribution with the name "CorridorKey" (l.58).
- §4 share-alike (l.72).
- §6 contributions.

**read**

The v1 HF repos (`nikopueringer/CorridorKey_v1.0`, `CorridorKeyBlue_1.0`) are tagged plain `cc-by-nc-sa-4.0`, with no reference to the additional terms. **read**

**v1 has an upstream problem.** Its HF card names `base_model: facebook/hiera_base_224.mae_in1k_ft_in1k`; the code builds `hiera_base_plus_224.mae_in1k_ft_in1k` (CorridorKeyModule/core/model_transformer.py:148,160). **read**
- Meta's Hiera *model zoo* is CC BY-NC 4.0, while the code is Apache-2.0 (facebookresearch/hiera README l.8-9, l.47, l.74). **read**
- The HF tags of both Hiera checkpoints say `cc-by-nc-4.0`. **read**
- So v1's weights are fine-tuned from non-commercial Meta weights, and Corridor cannot waive Meta's terms. **inferred**

v1's optional hint generators are out of scope for Scumble (README l.401-404):
- VideoMaMa: CC BY-NC 4.0, plus the Stability AI Community License on its checkpoints.
- GVM: BSD-2, but it builds on Stable Video Diffusion weights.

**read**

### 1c. Neex's permission read against the licence

The quote: "as long as the software is free, you may implement CK2.0 (and 1.0) however you like ... if you were to sell a commercial version ... get in touch."

**What it plainly covers (inferred from the text against the licence):**
- §2(d), "commercial software integration": Scumble is free GPL software with no paid tier, so no separate agreement is needed now.
- §2(a), "part of a competing product": Corridor sells a stand-alone app and plugins, so a free editor with CK keying could be argued to compete. "however you like" answers that.
- The free Microsoft Store copy: free of charge, so it satisfies "free" and §2(c).
- CK2's own outputs being used commercially by Scumble users: already allowed by §1(a)/(b).

**What it leaves open or ambiguous (inferred):**

1. **The licence of Scumble's implementation code.**
   - Porting `corridorkey/*.py` (pre/post-processing, the Hann-window logic, `color_utils.py`, the stage graphs) to JS/Rust makes a derivative that §5 and CC 3(b) require to be released under the CK licence.
   - GPL-3.0 §10 forbids "further restrictions" (F:\canvas\LICENSE:463). The FSF lists CC NonCommercial licences as non-free (gnu.org/licenses/license-list.html#CC-BY-NC). **read**
   - So a CK-derived file inside GPL Scumble conflicts, unless one of these happens:
     - (a) Corridor explicitly allows Scumble's implementation to be GPL-3.0 while the weights stay under the CK licence;
     - (b) the CK-derived code sits apart under the CK licence and DenRakEiw adds a GPL §7 additional permission for it. He can: `git log` shows 899 commits, all by DenRakEiw. **read** He would still have a non-free subfolder in the repo.
   - "implement however you like" probably means (a), but it does not say "under GPL".
2. **Hosting converted weights** (ONNX or fp16 on a Scumble-controlled HF repo or GitHub release). §2(a) forbids "redistribute ... in whole or in part" as a product or part of a competing product. Neex's sentence likely covers it, but not explicitly.
3. **End users above $20M revenue.** §3 binds the person or company *using* the tool, and Neex spoke to the developer. Scumble cannot waive it. The download dialog should say it.
4. **"free" if Scumble ever takes money.** A paid Store edition, a "Pro" tier or Store-mediated donations are not covered; §2(c) only allows donations if paying nothing stays possible. CLAUDE.md already notes a sale means asking Corridor first (F:\canvas\CLAUDE.md:686).
5. **Commercial use by Scumble's users.** Allowed by §1(a)/(b), not by Neex's sentence. Nothing extra is needed, except §3.
6. **Routes through paid hosts.** A CK route through fal, Replicate, Comfy Cloud or any hosted paid inference would be someone else's "paid API or inference service" (§2(b)) and is not covered. A local ComfyUI or the user's own RunPod is the user's own use.
7. **Attribution wording, and whether the Corridor or CorridorKey logo may appear.** CC does not license trademarks (CK2-LIC l.384). **read**

**What the user should ask in writing.** Fold the questions into the thank-you reply, or send them by email to contact@corridordigital.com. A Discord message is writing, but an email or a reply in the same thread that states the scope is easier to cite later. Something like:

> "Thank you so much! To get it right, may I confirm three small things: (1) Scumble is GPL-3.0; is it OK that our own code that runs CK2.0 (the ONNX export and pre/post-processing) is released under GPL-3.0, while the CorridorKey weights stay under your licence and are downloaded by the user from your Hugging Face repo? (2) If a converted (ONNX / fp16) copy of the weights is needed, may we host it with your licence and the CorridorKey name, or would you rather publish an official export? (3) How would you like to be credited in the app (wording, link to corridorkey.com)? We'll also tell users that organisations above $20M revenue need seats."

**inferred: suggestion**

---

## 2. The components v2 loads

Sources:
- THIRD_PARTY_NOTICES.md @ `485f5e9` l.1-38 **read**
- scripts/download_weights.py l.27-38: pinned revisions, and none of the three is redistributed by Corridor (notices l.7-9) **read**
- runtime.py:79-95: `validate()` requires all three files to be present **read**

| Component | Publisher, source | Licence | What the licence requires | Size (bytes) | ONNX |
|---|---|---|---|---|---|
| CorridorKey 2.0 | `nikopueringer/CorridorKey2.0` @ `cf44a8d`: `corridorkey_v2.safetensors`, `foundation_stats.safetensors` | Corridor Key Licence 2.0 | see §1 | 2,661,698,720 + 18,864 | None official. Community: `Nucito/corridorkey-web` @ `1ae72ca` (fp16, static shapes in 18 size buckets 384-1024, components cradio / moge / rvm / stage1 / stage2, weights 2,432,112,150 bytes in total; created 2026-10-23; 0 downloads; opset not stated). **read** |
| C-RADIOv4-SO400M (431M params) | NVIDIA, `nvidia/C-RADIOv4-SO400M` @ `c0457f5` (the pinned revision equals the current sha) | NVIDIA Open Model License Agreement, June 14 2024 | see below | `model.safetensors` 1,724,986,512; plus about 0.2 MB of remote-code `.py` files; the 1,205,920,113-byte half `.pth.tar` is skipped | `ZumaInnovations/C-RADIOv4-SO400M-ONNX` @ `f9d63ab`: opset 17, fp32, dynamic H/W in multiples of 16 up to 2048, output `last_hidden_state [B,N,1152]`, `model.onnx_data` 1,724,948,928 bytes; ships NVIDIA's `Notice` and the licence PDF. Also Nucito's fp16 `cradio.weights`, 862,480,006 bytes. **read** |
| MoGe-2 ViT-B normal (104M params, MoGe README l.143-146) | Microsoft, `Ruicheng/moge-2-vitb-normal` @ `ca5f0e0`, `model.pt` | MIT for code and weights; DINOv2 code inside is Apache-2.0 | MIT notice "Copyright (c) Microsoft Corporation." plus the Apache-2.0 notice (vendored at ck2/third_party/MoGe/LICENSE) | 419,110,160 | Official `Ruicheng/moge-2-vitb-normal-onnx` (419,411,850 bytes, FP32, opset ≥ 14 per microsoft/MoGe docs/onnx.md) outputs only points / normal / mask / metric_scale. CK2 uses `moge.encoder(...)` features instead (ck2 foundations.py ~l.273), so a custom export is needed. **read / inferred** Nucito's `moge.weights` (encoder, fp16) is 175,524,992 bytes. **read** |
| RVM small: **Recurrent Video Masked Autoencoder**, ViT-S, 34M params, *not* Robust Video Matting | Google DeepMind, `google-deepmind/representations4d`; file `pretrain_rvm_small16_256_204031069.npz` on storage.googleapis.com (MD5 base64 `ZJb6kj8+tasiJbVeplXu7Q==`) | Code Apache-2.0, weights CC BY 4.0 (repo README "License and disclaimer": "All other materials are licensed under ... CC-BY") | Attribution: Copyright 2026 Google LLC, licence link, mark changes. Not non-commercial. | 270,086,372 (Content-Length; README says 270 MB) | None official. CK2 runs it through its own PyTorch port, `corridorkey/rvm.py` (CK licence). Nucito's `rvm.weights` (fp16) is 66,446,848 bytes. **read** |

All three are used, not optional:
- Nucito's stage1 inputs are `rgb, hint, hint_quality, moge, cradio, rvm` (its manifest.json). **read**
- In the official runtime, `use_cradio` comes from the checkpoint's `model_config`, which I did not download. **unverified**

Other pieces in the v2 Python route, not needed for an ONNX route:
- `utils3d` (MIT, pinned commit), transformers, timm, einops, scipy, opencv, safetensors, huggingface-hub (requirements.txt). **read; licences of those beyond utils3d not checked**
- CK2 notes "EUPE / DINOv3 convention" in blocks.py:47. That is a layout convention; no DINOv3 weights are loaded. **read**
- No SAM and no DINOv2/v3 weights are loaded apart from MoGe's DINOv2-based encoder. **read**

**NVIDIA Open Model License (June 2024 text):**
- **Preamble:** "Models are commercially useable", you may create and distribute Derivative Models, and NVIDIA claims no ownership of outputs.
- **§1.1:** an output is not a Derivative Model.
- **§2.1:** the licence ends for anyone who sues claiming the model infringes. NVIDIA "may update this Agreement", and you must comply or stop.
- **§2.2:** perpetual, worldwide, royalty-free grant, revocable only per §2.1. Covers use, reproduce, derivatives, sell, distribute.
- **§2.3:** "AI Ethics" encouragements, and a ban on unlawful uses: illegal surveillance, biometrics without consent, harassment, intentionally deceiving.
- **§3.1:** whoever distributes the Model must give recipients a copy of the agreement plus a "Notice" text file reading "Licensed by NVIDIA Corporation under the NVIDIA Open Model License".
- **§3.2:** your own terms may apply to your modifications.
- **§4:** no trademark licence beyond describing the origin.
- **§7:** you indemnify NVIDIA.
- **§9:** Delaware law, Santa Clara courts.
- **§10:** export compliance.
- No non-commercial or field-of-use limit. No output restriction beyond lawful use.

**read** (hf/nvidia_oml.txt, extracted from https://developer.download.nvidia.com/licenses/nvidia-open-model-license-agreement-june-2024.pdf)

C-RADIOv4 card (hf/cradio_README.md):
- l.24: "ready for commercial/non-commercial use".
- l.20-22: its teachers were SigLIP2-g, DINOv3-7B and SAM3. **read**
- Whether those teachers' own licence terms reach a distilled student is not addressed anywhere I read. **unverified**

**Nucito's export redistributes C-RADIO weights without a Notice file or licence copy** (file listing). Using it would inherit that gap under §3.1. **read / inferred** Its provenance is one day old and unproven. Treat it as a reference, not a source.

---

## 3. Scumble's rules and precedent, and where the notices go

**The rule.** "Only MIT/Apache/BSD/OFL dependencies in the app" (F:\canvas\CLAUDE.md:72). Item 49's earlier "never in the app without their agreement (no ONNX in the bundle ...)" (CLAUDE.md:675-676) is lifted for the free app by the note at CLAUDE.md:683-688, which says the plan file `docs/PLAN_CORRIDORKEY.md` is to come. It does not exist yet. **read**

**The licence.** F:\canvas\LICENSE is GPL-3.0 (l.1-2). The aggregate clause is at l.236-243; "no further restrictions" at l.463. **read**

**Precedent for non-commercial models as user downloads:**
- docs/HELPERS.md:267-275, the model table: `rmbg14` "BRIA, non-commercial"; `rmbg2` "CC BY-NC 4.0", gated on HF ("accept the licence, save a token"). **read**
- The registry carries `license` and `note` per model, e.g. electron/main/onnx/models.js:46-47, 52-53. The gated error text is at models.js:304. **read**
- Settings › Helpers shows them:
  - the row tooltip `kind · source · license` (renderer/shell.js:2079);
  - the info line `size download · license · note` (shell.js:2094-2098).

  **read**
- The Downloader only knows HF with a Bearer token and the size check (HELPERS.md:233). **read**
- RVM's host, storage.googleapis.com, would be a new host. **inferred**

**Where credits live today:**
- **About:** `renderer/index.html:188` (GPL line) and the About text built at `renderer/shell.js:2460`. It credits Comfy's SDK (MIT), film-name trademarks and the NVIDIA/DLSS trademark line. **read**
- **Manual:** helpers are described at docs/MANUAL.md:773 with no licence lines. Fonts get a licence note at :325 and :489. **read**
- **Privacy policy:** lists "Hugging Face, when you click Download for a helper model" (docs/CODE_SIGNING_POLICY.md:101). It is also the Store's privacy URL (dist/store-listing/STORE_LISTING.md:17). **read**
- There is no THIRD_PARTY_NOTICES file in the repo. **read** (ls)

**Where the notices would have to go (inferred):**
- **Settings › Helpers row and download dialog for "CorridorKey 2.0":**
  - the four sources and licences: Corridor Key Licence 2.0; NVIDIA Open Model License; MIT; CC BY 4.0;
  - the total size, about 5.08 GB;
  - one line that organisations above US $20M revenue need a CorridorKey seat per user, with a link to corridorkey.com.
- **About (shell.js:2460):** "Green and blue screen keying by CorridorKey 2.0 from Corridor Digital (Corridor Key Licence, a CC BY-NC-SA 4.0 variant), used with permission in this free app; it builds on C-RADIOv4 (NVIDIA), MoGe-2 (Microsoft) and RVM (Google DeepMind), downloaded by you from their publishers." This uses the name "CorridorKey" (§4), keeps the NVIDIA mention to origin only (OML §4), and adds no logos.
- **HELPERS.md table:** one row per file, with the pinned revisions and sha256 values, as for LaMa and DA2.
- **MANUAL:** the keying section, the licence and seat note, and the hardware need.
- **CODE_SIGNING_POLICY.md privacy section:** add Google Cloud Storage (RVM) beside Hugging Face.
- **If Scumble ever hosts converted weights:** ship the CK LICENSE, NVIDIA's agreement plus the `Notice` file, Microsoft's MIT notice, the Apache-2.0 notice and the CC BY attribution with them. Mark them "converted to ONNX/fp16 by Scumble".
- **Keep CK code out of `renderer/editor/` shared files,** or gate it to the app host. Otherwise `tools/build_node.py` would carry it into the GPL node on the Comfy Registry.

**What cannot be used, and why (inferred unless marked):**
- **Bundling any of the weights** in the installer, MSIX, zip or asar: CK2 (non-free, NC/SA), C-RADIO (NVIDIA OML) and RVM (CC BY) all fall outside MIT/Apache/BSD/OFL. MoGe (MIT) would be allowed but is pointless at 419 MB. Download only.
- **CK-derived source under GPL** without Corridor's explicit OK or a §7 exception plus a separately licensed folder (section 1c, point 1).
- **v1:** Meta's Hiera NC weights sit underneath it. The user chose v2 anyway (CLAUDE.md:688). **read** for the choice
- **The v1 hint helpers VideoMaMa and GVM:** NC or Stability licences, and 80 GB of VRAM (CK README l.41-42, 401-404). **read**
- **A CK route through paid hosts** (fal, Replicate, Comfy Cloud): CK2 §2(b).

**Hardware note:** the official PyTorch route needs an NVIDIA RTX 30 series or newer with at least 4 GB VRAM up to 1440p, 6 GB for 4K (ck2 README l.21-23). **read** Window `1/1` keys each frame on its own (README l.242), which is the stills mode. **read** Whether ONNX or DirectML runs it on other GPUs is **unverified**.

---

## 4. Microsoft Store

docs/STORE.md:
- The Store copy is `runFullTrust` "so ... the helper models' runtime" works (CODE_SIGNING_POLICY.md:38-40). **read**
- It reads models from LocalCache (STORE.md:59, :128: in-app helpers ran inside the package). **read**
- STORE_LISTING.md:21 gives the GPL LICENSE as the "Additional license terms". **read**
- Nothing in the repo's Store docs mentions model licences or the generative-AI disclosure (grep for 11.16 / generative: no hit). **read**

Microsoft Store Policies **version 7.20, effective October 22, 2026** (https://learn.microsoft.com/windows/apps/publish/store-policies, fetched 2026-10-24):
- **10.2.2:** must not "fundamentally change or extend its described functionality ... through any form of dynamic inclusion of code". The example is downloading and running a remote script. **read**
  - Weights run by the app's own ONNX Runtime, and described in the listing, fit the existing helper-download precedent. Add keying to the description. **inferred**
- **11.2:** all content must be original, "appropriately licensed", or used as permitted by the rights holder. **read**
  - A download the user starts from Corridor's own HF repo, plus Corridor's written permission, meets this. A Scumble-hosted conversion would rest on the permission in 1c, point 2. **inferred**
- **11.16, Live Generative AI Content:** disclose live generative AI in the metadata and in Partner Center, and give a way to report content. **read**
  - This concerns Scumble's generative features generally, not CK, which is a keyer. Whether past submissions ticked it is **unverified**.
- **10.1.5:** the product may, with consent after install, acquire add-ons that enhance functionality. **read**
- **10.8:** voluntary donations need the Microsoft payment request API or a third-party API. **read** This matters only if Scumble adds donations, which CK2 §2(c) allows.
- **10.4:** if a device is incompatible, the product must say what is required. **read** This argues for stating the GPU requirement in the CK feature. **inferred**
- **Not found:** any Store rule about large runtime model downloads or non-commercial model licences.

Two smaller points:
- The CC "no downstream restrictions / no technical measures" clause (CK2-LIC l.360) would matter only if CK weights were inside the Microsoft-signed, Store-licensed package. Downloads avoid it. **inferred**
- The free Store edition satisfies Neex's "as long as the software is free". **inferred**

## Facts

- [read] CorridorKey 2.0's licence is 'CORRIDOR KEY LICENCE Version 2.0', CC BY-NC-SA 4.0 plus additional terms that take precedence; 'this tool' includes the model weights. (https://github.com/nikopueringer/CorridorKey2.0/blob/485f5e9ab759ead6138cc990776184b59d6ea971/LICENSE l.1-25)
- [read] CK2 allows commercial projects (§1a) and says outputs are the user's and may be used commercially (§1b). (CK2 LICENSE l.27-36)
- [read] CK2 forbids repackaging, redistributing or selling the tool as a standalone or competing product and charging for access to code or weights (§2a), and paid API or inference services (§2b). (CK2 LICENSE l.44-56)
- [read] CK2 §2c: released derivatives must be free to the public; donations and pay-what-you-want are allowed if paying nothing stays possible. §2d: a commercial software package needs a written agreement (contact@corridordigital.com). (CK2 LICENSE l.57-72)
- [read] CK2 §3: an entity group with more than US $20M gross revenue must buy one CorridorKey plugin seat per individual user, otherwise the §1 permissions do not apply. (CK2 LICENSE l.74-94)
- [read] CK2 §4 requires the name 'CorridorKey' in attribution and in a reasonably prominent position in derivatives; §5 requires public derivatives under the same licence or substantially equivalent terms. (CK2 LICENSE l.96-116)
- [read] CC BY-NC-SA 4.0 §2(a)(4) says format-shifting technical modifications never produce Adapted Material. (CK2 LICENSE l.334-345)
- [read] The v1 licence (Version 1.0) has no weights definition, no outputs clause, no 'derivatives free' clause and no $20M revenue clause; otherwise it has the same restrictions. (https://github.com/nikopueringer/CorridorKey/blob/97e55a453060745bead1befd293f6e523c4b845c/LICENSE l.1-100)
- [read] v1 weights are based on Meta Hiera (HF card base_model hiera_base_224; code uses hiera_base_plus_224), whose model zoo licence is CC BY-NC 4.0. (huggingface.co/nikopueringer/CorridorKey_v1.0 README; ck CorridorKeyModule/core/model_transformer.py:148,160; facebookresearch/hiera README l.8-9,47,74; HF tags of timm/hiera_*)
- [read] v2 depends on C-RADIOv4-SO400M (NVIDIA Open Model License), MoGe-2 ViT-B (MIT, code and weights, DINOv2 code Apache-2.0) and RVM small (Google DeepMind; code Apache-2.0, weights CC BY 4.0); none is redistributed by Corridor, and a script downloads them. (CorridorKey2.0@485f5e9 THIRD_PARTY_NOTICES.md l.1-38; scripts/download_weights.py l.27-38)
- [read] The 'RVM' in CorridorKey 2.0 is Google DeepMind's Recurrent Video Masked Autoencoder (ViT-S, 34M params), not Robust Video Matting. (CorridorKey2.0@485f5e9 corridorkey/rvm.py:1; google-deepmind/representations4d README checkpoint table)
- [read] File sizes: corridorkey_v2.safetensors 2,661,698,720 B; foundation_stats 18,864 B; C-RADIOv4 model.safetensors 1,724,986,512 B; MoGe model.pt 419,110,160 B; RVM npz 270,086,372 B; about 5.08 GB in total. (HF API ?blobs=true for nikopueringer/CorridorKey2.0@cf44a8d, nvidia/C-RADIOv4-SO400M@c0457f5, Ruicheng/moge-2-vitb-normal@ca5f0e0; HEAD of storage.googleapis.com/representations4d/checkpoints/pretrain_rvm_small16_256_204031069.npz)
- [read] The v2 runtime refuses to start unless the CK weights, stats, RVM, MoGe and C-RADIO files all exist. (CorridorKey2.0@485f5e9 corridorkey/runtime.py:84-95)
- [read] NVIDIA OML (June 2024): commercially usable, derivatives allowed, no claim on outputs; redistribution needs a copy of the agreement plus a Notice file 'Licensed by NVIDIA Corporation under the NVIDIA Open Model License'; licence ends on infringement litigation; NVIDIA may update the terms; indemnity; Delaware law; no non-commercial limit. (https://developer.download.nvidia.com/licenses/nvidia-open-model-license-agreement-june-2024.pdf (text extracted to scratchpad ck_licences/hf/nvidia_oml.txt) §§1-10)
- [read] C-RADIOv4 was distilled from SigLIP2-g, DINOv3-7B and SAM3 teachers and is declared ready for commercial and non-commercial use. (huggingface.co/nvidia/C-RADIOv4-SO400M README l.20-24 @c0457f5)
- [unverified] Whether the teachers' licences (DINOv3, SAM3) reach the distilled C-RADIOv4 is not addressed in anything read. (C-RADIOv4 model card; NVIDIA OML)
- [read] A community fp16 ONNX export of all CK2 components exists (Nucito/corridorkey-web, created 2026-10-23, 18 static shape buckets, about 2.43 GB of weights); it includes C-RADIO weights without NVIDIA's Notice file or licence copy. (HF API Nucito/corridorkey-web@1ae72ca file list, README, manifest.json)
- [read] A C-RADIOv4-SO400M ONNX export exists: opset 17, fp32, dynamic H/W in multiples of 16, output [B,N,1152], 1,724,948,928 B of external data, with NVIDIA's Notice and licence PDF. (huggingface.co/ZumaInnovations/C-RADIOv4-SO400M-ONNX@f9d63ab README and file list)
- [inferred] The official MoGe-2 ViT-B ONNX (419,411,850 B, FP32, opset >= 14) outputs only points/normal/mask/metric_scale, while CK2 consumes the MoGe encoder features, so a custom export is needed. (microsoft/MoGe docs/onnx.md; HF Ruicheng/moge-2-vitb-normal-onnx; CorridorKey2.0 corridorkey/foundations.py (self.moge.encoder))
- [read] v1 ONNX exports exist under CC BY-NC-SA 4.0 by Ale Alvaro (fp16 512-2048 at 145-200 MB, int8 79-101 MB). (huggingface.co/alexandrealvaro/CorridorKey@47c45ae README)
- [read] CK2 official requirements: NVIDIA RTX 30 series or newer with 4 GB VRAM up to 1440p, 6 GB for 4K; window 1/1 keys each frame on its own. (CorridorKey2.0@485f5e9 README l.21-23, l.242)
- [read] Scumble's rule: only MIT/Apache/BSD/OFL dependencies in the app; item 49's 'never in the app' is lifted for the free app by Corridor's answer; docs/PLAN_CORRIDORKEY.md does not exist yet. (F:\canvas\CLAUDE.md:72, :675-676, :683-688; ls docs/PLAN_CORRIDORKEY.md)
- [read] Precedent: RMBG-1.4 (BRIA non-commercial) and RMBG-2.0 (CC BY-NC 4.0, gated with an HF token) are offered as user downloads with the licence shown in the Settings › Helpers row. (F:\canvas\docs\HELPERS.md:267-275; electron/main/onnx/models.js:46-53, :304; renderer/shell.js:2079, 2094-2098)
- [read] The About text credits Comfy's SDK (MIT), film-name trademarks and NVIDIA trademarks; there is no third-party notices file in the repo. (F:\canvas\renderer\shell.js:2460; renderer/index.html:188)
- [read] The privacy policy lists Hugging Face as the helper download host; RVM's Google Cloud Storage host would be new. (F:\canvas\docs\CODE_SIGNING_POLICY.md:101; CorridorKey2.0 scripts/download_weights.py:37)
- [inferred] GPL-3.0 §10 forbids further restrictions; the FSF lists CC NonCommercial licences as non-free; so CK-licensed (share-alike, NC) code inside GPL Scumble conflicts without Corridor's explicit OK or a §7 exception. (F:\canvas\LICENSE:463; https://www.gnu.org/licenses/license-list.html#CC-BY-NC)
- [read] All 899 commits in the Scumble repository are by DenRakEiw, so he can add a GPL §7 additional permission. (git log --all in F:\canvas)
- [read] Microsoft Store Policies 7.20 (effective 2026-10-22): 10.2.2 forbids changing described functionality through dynamic code; 11.2 requires licensed content; 11.16 requires disclosing live generative AI in metadata and Partner Center plus a report channel. No rule found on non-commercial model licences or large runtime model downloads. (https://learn.microsoft.com/windows/apps/publish/store-policies (fetched 2026-10-24))
- [read] Corridor sells CK2.0 plugins and a standalone app as a one-time purchase ($27 personal, $42.50 per studio seat at beta prices). (https://corridorkey.com (fetched 2026-10-24))

## Open questions

- Does Neex's 'implement however you like' allow Scumble's CK2 inference and pre/post-processing code (a port of corridorkey/*.py to JS/Rust, or ONNX glue) to be released under GPL-3.0 instead of the Corridor Key Licence's share-alike?
- May Scumble host converted (ONNX/fp16) CK2 weights under Corridor's licence and name, or would Corridor publish an official ONNX export? If neither, the user must convert locally, which needs Python and Torch, which Scumble never bundles.
- How does Corridor want to be credited in the About dialog and the download dialog (wording, a link to corridorkey.com, no logo)?
- Does the $20M-revenue seat clause stay for Scumble's users? I assume yes; it should then be stated in the download dialog.
- Does the official v2 checkpoint's model_config enable C-RADIO (use_cradio)? This was not checked without downloading the 2.66 GB file. The community export's stage1 inputs say all three foundation models are used.
- Do the C-RADIOv4 teachers' licences (DINOv3, SAM3) carry over to the distilled student? NVIDIA declares it commercial-ready under its OML.
- Can the CK2 graphs run under ONNX Runtime DirectML or CPU in Electron at all, and at what speed? The official route needs CUDA on RTX 30+. This is another research angle, not checked here.
- Did Scumble's past Store submissions declare live generative AI under policy 11.16 (in force since 7.19)? The repo's Store listing draft does not mention it.
