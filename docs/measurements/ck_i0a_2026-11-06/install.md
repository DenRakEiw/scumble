# I0a part 1: pack A installed, its models in place (2026-11-06)

**The user's word (2026-11-06, in chat):** "ja, in custom nodes laden": pack A (marawan206/ComfyUI-CorridorKey2.0)
cloned and pinned at `c7662de` into the production ComfyUI's `custom_nodes`, its models downloaded. The code check
before it is `findings.md` beside this file (verdict: safe at `c7662de`, pinned; no pip changes; send `auto_download`
false). **ComfyUI was not running and was not started in this step** (`/system_stats` gave no answer before the clone);
nothing was installed into `python_embeded`; `custom_nodes/ComfyUI-InpaintCanvas` and the Manager were not touched.
ComfyUI on disk is `v0.44.0` (`2c75dc1b3`), Python 3.12.9, torch 2.10.0+cu130.

The machine's busy lock (`w1_lock.py`) was held for the clone (taken 09:32:50Z, released right after the checkout), the download (09:35:12-09:36:42Z)
and the copy into place (09:37:06-09:37:18Z); it was free each time (taken after 0 s).

## 1. The clone

- `git clone --no-checkout https://github.com/marawan206/ComfyUI-CorridorKey2.0` into
  `F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\custom_nodes\ComfyUI-CorridorKey2.0` at 2026-11-06T09:33:00Z, then
  `git checkout c7662de` (detached). `git rev-parse HEAD` = `c7662de1832539b257ed055326dd2ead4393f1f1`, tree
  `f239955162f4f75d66dfef09d26928de2362a13c`. `origin/main` and `origin/improvements` are both still `c7662de` (the
  repo has not moved since the code check). A local branch `main` exists (git's default on clone) at the same commit;
  the working tree is detached at the pin. `git status --short --ignored`: empty.
- **Against the code check's copy** (`scratchpad/ck_i0a/exN`, the export at `c7662de` the check read; and the check's
  clone `packA`): the same tree id `f2399551...` in both clones; all **116** files' raw blob ids (`git hash-object
  --no-filters`) of `exN` equal `git ls-tree -r HEAD` of the install, and the install's working-tree files equal its
  tree byte for byte (`core.autocrlf` is true on this machine; no file was rewritten). Size on disk with `.git`:
  2,024,914 bytes.
- A probe of `ck_comfy/paths.py` (§3 below) left `ck_comfy/__pycache__/paths.cpython-312.pyc`; it was removed again, so
  the folder is exactly the checkout.

## 2. The pip dry run

`python_embeded\python.exe -I -m pip install --dry-run --no-input -r <pack>\requirements.txt` (pip 25.3; `-I` so the
pack folder is not on `sys.path` and no user site is read, which is also how ComfyUI runs, `-s`; the requirements file
given by its absolute path, run from the scratchpad): **nothing to install or change.** Every line is "Requirement
already satisfied"; there is no "Would install" line; exit 0. The pack's six pins and what satisfies them:

| Pin | Installed |
|---|---|
| `safetensors>=0.4` | 0.8.0 |
| `einops>=0.8` | 0.8.1 |
| `timm>=1.0` | 1.0.19 |
| `scipy>=1.11` | 1.15.2 |
| `opencv-python>=4.8` | 4.10.0.84 |
| `huggingface_hub>=0.34` | 1.27.0 |

Their dependencies are satisfied as well (torch 2.10.0+cu130, torchvision 0.25.0+cu130, numpy 1.26.4, hf-xet 1.6.0,
httpx 0.28.1, tqdm 4.68.3, pillow 12.2.0 and the rest). Two lines that are not about the pack: pip warns "Ignoring
invalid distribution ~omfy-aimdo" (a leftover folder in `site-packages` from the comfy-aimdo upgrade of the ComfyUI
update earlier the same day; untouched), and pip's notice of a newer pip (not acted on).

## 3. The models

Read from the pack's pinned code: `ck_comfy/download.py` (`CORRIDORKEY_REVISION = cf44a8db...`, `CRADIO_REVISION =
c0457f5d...`, `MOGE_REVISION = ca5f0e07...`, RVM from Google Cloud Storage with `RVM_MD5_B64 = ZJb6kj8+tasiJbVeplXu7Q==`;
the C-RADIO snapshot `ignore_patterns=["*.pth.tar", "model.safetensors"]`, then `model.safetensors` on its own) and
`ck_comfy/paths.py` (the layout under `models/corridorkey2/`). The same 35 files were fetched by hand, so the pack's
loader finds a complete set and `auto_download` can stay false; `c-radio_v4-so400m_half.pth.tar` (1,205,920,113 bytes)
is skipped as the pack skips it. No `huggingface_hub` cache metadata (`.cache/huggingface/`) was written; the loader
does not read it (`AssetPaths.missing()` checks six files, `env.py` loads `hf_model.py`, `config.json` and
`model.safetensors` from the folder).

**How:** the three repos' tree listings at the pinned revisions from the Hugging Face API
(`https://huggingface.co/api/models/<repo>/tree/<revision>?recursive=true`), a `HEAD` of the RVM object (status 200,
`Content-Length` 270,086,372, `x-goog-hash: md5=ZJb6kj8+tasiJbVeplXu7Q==`, `crc32c=h8aUZQ==`, `ETag
"6496fa923f3eb5ab2225b55ea655eeed"`, last modified 2026-02-03); each file with `curl -fL -C -` into a `.part` in its
own empty staging folder per source (`scratchpad/ck_dl/{ck2,cradio,moge,rvm}/`); **every file verified before it was
renamed from `.part`**: the LFS files by sha256 against the API's LFS oid and size, the small C-RADIO files by their git
blob sha1 against the API's `oid` and size, RVM by MD5 (base64) and size as the pack's downloader does. Then copied into
place (a `.copying` name, then a rename) and **verified a second time in place** (all 35 ok). Script:
`scratchpad/ck_scripts/ck_fetch.py` (run with `python -I` from the scratchpad). **No token was sent anywhere:** all
three Hugging Face repos are public (`gated: false`), so the stored HF login was not used. URLs:
`https://huggingface.co/<repo>/resolve/<revision>/<file>` (redirected by Hugging Face to its CDN), and RVM
`https://storage.googleapis.com/representations4d/checkpoints/pretrain_rvm_small16_256_204031069.npz`.

The download took 90 s for 5,076,141,689 bytes (about 56 MB/s), the copy into place 12 s. The 28 C-RADIO code and
config files that the code check read (`scratchpad/ck_i0a/cradio_code/`) are byte-identical to the downloaded ones.

**The check of the pack's own code:** `ck_comfy/paths.py` of the install, loaded by file in `python_embeded -I`,
`AssetPaths.under(models/corridorkey2).missing()` = `[]`; the six files it requires are all present. (`resolve_assets`
in ComfyUI takes the same default root, `models/corridorkey2`: no `extra_model_paths.yaml` on this install.)

| Source | Repo / URL | Revision | Files | Bytes |
|---|---|---|---|---|
| ck2 | `nikopueringer/CorridorKey2.0` | `cf44a8db3f024bb49fd59daa408848ccf05f7477` | 2 | 2,661,717,584 |
| cradio | `nvidia/C-RADIOv4-SO400M` | `c0457f5dc26ca145f954cd4fc5bb6114e5705ad8` | 31 | 1,725,227,573 |
| moge | `Ruicheng/moge-2-vitb-normal` | `ca5f0e07ff01d3e5a364c1d954ed12ee1814b368` | 1 | 419,110,160 |
| rvm | Google Cloud Storage `representations4d` | MD5 `ZJb6kj8+tasiJbVeplXu7Q==` | 1 | 270,086,372 |

Per file (paths under `F:\Comfyui\ComfyUI_windows_portable_nvidia\ComfyUI\models\corridorkey2\`; the sha256 is of the
placed file):

| File | Source | Bytes | sha256 | Verified by |
|---|---|---|---|---|
| `corridorkey_v2.safetensors` | ck2 | 2,661,698,720 | `c43596de98cc8866d577c8a9f9ea239acdf3f7a130ff24e25db4375a50590436` | sha256 = HF LFS oid ok |
| `foundation_stats.safetensors` | ck2 | 18,864 | `924783ceddd293fd470126332ce328166faea6c4c8d2f36402d5b95187166af3` | sha256 = HF LFS oid ok |
| `foundations/cradio/C-RADIOv4-SO400M/.gitattributes` | cradio | 1,519 | `11ad7efa24975ee4b0c3c3a38ed18737f0658a5f75a0a96787b576a78a023361` | git blob sha1 = HF oid a6344aac8c09 ok |
| `foundations/cradio/C-RADIOv4-SO400M/README.md` | cradio | 14,000 | `af7881b8207e7060b8df5b8df4df4e87e628faffc188b494836bbec086233b33` | git blob sha1 = HF oid 50d8db78effa ok |
| `foundations/cradio/C-RADIOv4-SO400M/adaptor_attn.py` | cradio | 1,796 | `baa112b58158d75077e9bba8baba51b2c75f6a6deed2d8046aa5e5f2d5cb669a` | git blob sha1 = HF oid 8f5cd7e3fc96 ok |
| `foundations/cradio/C-RADIOv4-SO400M/adaptor_base.py` | cradio | 1,693 | `f9d285cc76e70f977f9c78e748f610765f0bd068a13f86d804c07c765cece577` | git blob sha1 = HF oid b8bdeb867f29 ok |
| `foundations/cradio/C-RADIOv4-SO400M/adaptor_generic.py` | cradio | 3,747 | `3d1b5a015ff3754a9eb64cd56b4d04cae01e537a1ffa606adaf904c55fff07a1` | git blob sha1 = HF oid 67b220b9499e ok |
| `foundations/cradio/C-RADIOv4-SO400M/adaptor_mlp.py` | cradio | 4,025 | `e75a9ed1f7f58c749dec5a510d699f36f32fdb7f3b61cd8a7e3ccd5afd2c9b77` | git blob sha1 = HF oid 8343bd55ed54 ok |
| `foundations/cradio/C-RADIOv4-SO400M/adaptor_module_factory.py` | cradio | 3,278 | `2beac17dc5824c7d9f925dc782cdd4b49bd15cf206bf1cbaa9108a8966e33316` | git blob sha1 = HF oid f7df3bedd782 ok |
| `foundations/cradio/C-RADIOv4-SO400M/adaptor_registry.py` | cradio | 1,371 | `16963e07de300e5f3cbd5e343aed111d04e4e55a50e07f50ccc2ab930883ea1e` | git blob sha1 = HF oid a1dea8e898fe ok |
| `foundations/cradio/C-RADIOv4-SO400M/cls_token.py` | cradio | 1,787 | `64ee35f128380c3bb9bc1a913e98ac328220be88964f2092686c637ef866fc79` | git blob sha1 = HF oid b41351238f55 ok |
| `foundations/cradio/C-RADIOv4-SO400M/common.py` | cradio | 7,160 | `6cc79e1f7b61f4917602d2efc9e0a833fa74d60563f6aac74e4625de23723bab` | git blob sha1 = HF oid d1df62c1e68b ok |
| `foundations/cradio/C-RADIOv4-SO400M/config.json` | cradio | 7,571 | `6e49e911ff6e980125c208b10ed4b51bb4a92061862cbb8947473f1b33f88fd4` | git blob sha1 = HF oid f9f5dc124f4e ok |
| `foundations/cradio/C-RADIOv4-SO400M/dinov2_arch.py` | cradio | 35,529 | `5433d08522c28f46a69e710da1a86fc1d76fc03562dbb9b2b49baf5db21195d3` | git blob sha1 = HF oid 1ba9e8ba6451 ok |
| `foundations/cradio/C-RADIOv4-SO400M/dual_hybrid_vit.py` | cradio | 7,179 | `86853ae2ed28c902529cd9b78201350e7dba1cf54ea9e57578241ecc0d88d867` | git blob sha1 = HF oid da30449d5260 ok |
| `foundations/cradio/C-RADIOv4-SO400M/enable_cpe_support.py` | cradio | 6,557 | `3c1e3df656960f5c83b38ba5f632fc5b335edf1d6de67731396a865aaa5ce1ed` | git blob sha1 = HF oid b81378307ede ok |
| `foundations/cradio/C-RADIOv4-SO400M/enable_damp.py` | cradio | 1,290 | `7e2a0b6f8934ac6e4a4768e5ca84cb4ff09ba3726a470f1cf046bd5169b2e334` | git blob sha1 = HF oid 9f139f8848da ok |
| `foundations/cradio/C-RADIOv4-SO400M/enable_spectral_reparam.py` | cradio | 11,004 | `b8e703400604ee5f9cdfac0de9b857b7f5126aad8bba03604b04f52f7641d6cb` | git blob sha1 = HF oid dc2d6d10f880 ok |
| `foundations/cradio/C-RADIOv4-SO400M/eradio_model.py` | cradio | 58,289 | `bf76c60b991813eef45c76246cd7dcee3fefbf39bde3d2b6ac8576067012d05f` | git blob sha1 = HF oid a8733a97030f ok |
| `foundations/cradio/C-RADIOv4-SO400M/extra_models.py` | cradio | 5,763 | `a938b96715266d2f65325e56d0d8e42465d23e944e905d2820023472785c55a9` | git blob sha1 = HF oid 1a80626ef1ba ok |
| `foundations/cradio/C-RADIOv4-SO400M/extra_timm_models.py` | cradio | 9,892 | `d7364d5abf5b617782366948f0e593d7a2df275b076094afa1ebc5276a9f7102` | git blob sha1 = HF oid a578c9c3ef17 ok |
| `foundations/cradio/C-RADIOv4-SO400M/feature_normalizer.py` | cradio | 4,399 | `a74401f5220c2e5960d39addce9ba40f481efca9ab44bb9d96535ed23e1ef62b` | git blob sha1 = HF oid 7d4cd2706328 ok |
| `foundations/cradio/C-RADIOv4-SO400M/forward_intermediates.py` | cradio | 5,604 | `eb5a562d11edc655876eeb95bc1c3b4c7484b963dae41a3f76f7acd2a6906b9e` | git blob sha1 = HF oid 364137c8c991 ok |
| `foundations/cradio/C-RADIOv4-SO400M/hf_model.py` | cradio | 7,935 | `d28c0a0238ca8854a9af5a9f003761332bfc9182601b3b7466d9242be91ee96f` | git blob sha1 = HF oid a5bc580d2918 ok |
| `foundations/cradio/C-RADIOv4-SO400M/input_conditioner.py` | cradio | 1,492 | `72062d3b71877e1469e069cf090e5f35d6ad7abaeb451e56502f7f32dc6c1075` | git blob sha1 = HF oid 63ad07a0c95e ok |
| `foundations/cradio/C-RADIOv4-SO400M/model.safetensors` | cradio | 1,724,986,512 | `23e0c117de49d4ce909150fe6658d470829e6639647c7a5b035ce82e0d5b763c` | sha256 = HF LFS oid ok |
| `foundations/cradio/C-RADIOv4-SO400M/open_clip_adaptor.py` | cradio | 1,623 | `c2eb9166de48f5eb5f90f8a750e8ebe67da93698e794dc0bbdab5f013bab8e66` | git blob sha1 = HF oid c96766a179a8 ok |
| `foundations/cradio/C-RADIOv4-SO400M/preprocessor_config.json` | cradio | 331 | `6ca88d165592015b02a183d26a20fc96748e837d1cb21bde5f611141aca593cf` | git blob sha1 = HF oid 005782cf4a3d ok |
| `foundations/cradio/C-RADIOv4-SO400M/radio_model.py` | cradio | 14,018 | `2be659f5cd5b9db9c49db70387b65253c74bc16b3eb86e976f0f693271d4b183` | git blob sha1 = HF oid 4acf510d5341 ok |
| `foundations/cradio/C-RADIOv4-SO400M/siglip2_adaptor.py` | cradio | 3,307 | `1f40f7d77beefd69ad86aac61b12c82ed915b4012e6bea1628fc8abe80782851` | git blob sha1 = HF oid a9bca7b1612d ok |
| `foundations/cradio/C-RADIOv4-SO400M/utils.py` | cradio | 1,109 | `3b83163ce2650ef04973538dd79716ab015d24344ea25d52cfb0c37b093ba4ba` | git blob sha1 = HF oid 5026c70fa30f ok |
| `foundations/cradio/C-RADIOv4-SO400M/vit_patch_generator.py` | cradio | 11,475 | `092e9a0b8eca4fee162484ef3ef77b399f686e5e0ffc7be85fb2d69bc2f9ebd9` | git blob sha1 = HF oid 704b82851a4d ok |
| `foundations/cradio/C-RADIOv4-SO400M/vitdet.py` | cradio | 6,318 | `5b83b4c7b90b797d854a6da2fd4093ce9210a52533d3f7ba6bf505793b6c68c3` | git blob sha1 = HF oid bfd1b413fbc3 ok |
| `foundations/moge/model.pt` | moge | 419,110,160 | `16b8110e86d5dc5a849db120ca96ef3a223fd30b0c9146d1d81db504073da5f6` | sha256 = HF LFS oid ok |
| `foundations/rvm/pretrain_rvm_small16_256_204031069.npz` | rvm | 270,086,372 | `8821ba9f5d983b9a3746bb5fe86b9c2ea834fe9985ab7b02438b917438bf2ede` | MD5 ZJb6kj8+tasiJbVeplXu7Q== = x-goog-hash ok |

## 4. Disk

| | Bytes |
|---|---|
| `models/corridorkey2/` (35 files) | 5,076,141,689 (4.73 GiB) |
| `custom_nodes/ComfyUI-CorridorKey2.0/` (with `.git`) | 2,024,914 |
| F: used, delta over the copy into place (`df -B1`) | 5,076,209,664 |
| F: free after | 1,277,414,232,064 (1.16 TiB, 69 % used of 4.0 TB) |

The staging copies (5,076,141,689 bytes) stay in the session scratchpad `ck_dl/` on C: (2.8 TB free); they are not
needed again (I1 reads the fp32 sources from `models/corridorkey2/`) and go with the scratchpad.

## 5. State left, and what is next

- The pack is on disk and **not loaded**: ComfyUI was down for the whole step. At its next start ComfyUI imports the
  pack (the code check's §10: model-folder keys in memory, `OPENCV_IO_ENABLE_OPENEXR`, two cv2 structuring elements).
  `HOTRELOAD_OBSERVE_ONLY` in `run_nvidia_gpu.bat` does not list it, so HotReloadHack does not watch it.
- **Keep it pinned:** no Manager "Update All" on it; a later version only after a new code check. In every workflow
  that uses it, `CorridorKey2ModelLoader`'s `auto_download` is **false** (its default is true; with the set complete it
  would not download anyway, `missing()` is empty, but a deleted file must fail loudly rather than fetch).
- Not done in this step (I0a's next parts, `docs/PLAN_CORRIDORKEY.md` §5): `/object_info` of the pack's nodes into
  `tools/refs/corridorkey/` (needs the server), the reference keys of five stills into `dist/ck_ref/`, the Route B facts
  (seconds cold and warm, the `info` mode string, `/free` releasing `keep_on_gpu`, the `rgba` read-back, the hint's
  polarity), `summary.txt`.
