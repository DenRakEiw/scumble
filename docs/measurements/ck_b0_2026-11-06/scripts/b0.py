"""B0, Route B's remaining probe (docs/PLAN_CORRIDORKEY.md §5 row B0 and "Stop A": "B0, what is left") through the
user's ComfyUI (127.0.0.1:8188) with pack A pinned at c7662de.

    python b0.py <phase> <work dir> [<fixture dir>]

phases: evict    what a key evicts from VRAM and how the next local Generate (FLUX 3 Image Klein) reloads, at 1, 4 and
                 16 MP, keep_on_gpu off (Scumble's default) and once on
        extra    the same at 2 and 8 MP, with and without a hint (only when the evict numbers move KEY_CAP off 16 MP)
        cancel   a Cancel through Scumble's own path (POST /api/jobs/<id>/cancel) early, mid and late in a 16 MP key,
                 after the job ended and while it is pending; each followed by a key that must run normally
        box      a tight box against a loose one and the whole picture (green_plate, flat_green_plant; hint / no hint)
        despill  the despill on blue (blue_plate: screen blue at 0, 0.5, 1; screen green at 0.5), green_plate beside it
        fixture  the key gate's Route B fixture: a 512 x 400 crop of hair_green keyed natively, and at half size
        cleanup  every prompt this probe queued deleted from the history; the queue checked; /free

Every graph is the plan's pack A graph (§4.11: InpaintCanvasLoadRef -> CorridorKey2ModelLoader with auto_download
false -> CorridorKey2Basic -> PreviewImage on rgba), so nothing lands in the user's output folder; inputs are uploaded
with type "temp" (subfolder ck_b0), so nothing lands in the input folder either. The Generate is a plain FLUX 3 Image
Klein text-to-image graph on the models of recipes/flux3_klein_local.json (PreviewImage). The prompt ids go to
<work>/queued.txt; the cleanup phase deletes them. ComfyUI's log (env CK_B0_LOG) is read around each run for the model
manager's load / unload lines.
"""
import asyncio
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid

import aiohttp
import cv2
import numpy as np
import requests
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "ck_i0a_2026-11-06", "scripts"))
import ck_common  # noqa: E402

BASE = "http://127.0.0.1:8188"
CID = "ck-b0-" + uuid.uuid4().hex[:8]
STILLS = r"F:\canvas\.claude\worktrees\corridorkey\dist\ck_ref\stills"
HINTS = r"F:\canvas\.claude\worktrees\corridorkey\dist\ck_ref"
LOG = os.environ.get("CK_B0_LOG", "")
WORK = None
OI = None
QUALITY = {0.95: "clean matte (0.95)", 0.75: "rough matte (0.75)", 0.5: "loose hint (0.5)"}
LOG_RE = re.compile(r"Requested to load|loaded completely|loaded partially|[Uu]nload|CorridorKey|Prompt executed|"
                    r"Processing interrupted|Interrupting|interrupt|model weight dtype|lowvram|offload", re.I)


# ---------------------------------------------------------------------------------------------------------------------
# server helpers (routeb.py's, with the log marks and a cancel hook)

def get(p, **kw):
    r = requests.get(BASE + p, timeout=60, **kw)
    r.raise_for_status()
    return r


def post(p, js):
    r = requests.post(BASE + p, json=js, timeout=60)
    if r.status_code >= 400:
        raise RuntimeError("%s %s: %s" % (p, r.status_code, r.text[:3000]))
    return r


def stats():
    d = get("/system_stats").json()["devices"][0]
    return {k: d.get(k) for k in ("vram_total", "vram_free", "torch_vram_total", "torch_vram_free")}


def smi():
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout.strip().split(",")
    return {"used_mib": int(out[0]), "total_mib": int(out[1]), "util": int(out[2])}


class Peak(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.stop = False
        self.peak = 0

    def run(self):
        while not self.stop:
            try:
                self.peak = max(self.peak, smi()["used_mib"])
            except Exception:
                pass
            time.sleep(0.25)


def log_pos():
    try:
        return os.path.getsize(LOG) if LOG else 0
    except OSError:
        return 0


def log_since(pos):
    if not LOG:
        return []
    try:
        with open(LOG, "rb") as f:
            f.seek(pos)
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return []
    return [ln.strip() for ln in text.splitlines() if LOG_RE.search(ln)][:60]


def object_info():
    global OI
    if OI is None:
        OI = get("/object_info").json()
    return OI


def fill(cls, given):
    spec = object_info()[cls]["input"]
    out = {}
    for name, v in (spec.get("required") or {}).items():
        if name in given:
            continue
        kind = v[0]
        opts = v[1] if len(v) > 1 and isinstance(v[1], dict) else {}
        if isinstance(kind, list):
            out[name] = opts.get("default", kind[0])
        elif kind == "COMBO":
            out[name] = opts.get("default", (opts.get("options") or [None])[0])
        elif "default" in opts:
            out[name] = opts["default"]
    out.update(given)
    return out


def png_bytes(arr):
    """cv2's PNG of an RGB or grey uint8 array (what is uploaded, byte for byte)."""
    ok, buf = cv2.imencode(".png", arr if arr.ndim == 2 else cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
    assert ok
    return buf.tobytes()


def upload(arr_or_bytes, name):
    """Upload as type temp (subfolder ck_b0) under a unique name -> the {filename, subfolder, type} ref."""
    data = arr_or_bytes if isinstance(arr_or_bytes, (bytes, bytearray)) else png_bytes(arr_or_bytes)
    stem, ext = os.path.splitext(name)
    name = "%s_%s%s" % (stem, uuid.uuid4().hex[:6], ext or ".png")
    r = requests.post(BASE + "/upload/image", files={"image": (name, data, "image/png")},
                      data={"type": "temp", "subfolder": "ck_b0", "overwrite": "true"}, timeout=300)
    r.raise_for_status()
    j = r.json()
    return {"filename": j["name"], "subfolder": j.get("subfolder", ""), "type": "temp"}


def remember(pid):
    with open(os.path.join(WORK, "queued.txt"), "a", encoding="utf-8") as f:
        f.write(pid + "\n")


async def _cancel(sess, pid, rec):
    t = time.perf_counter()
    async with sess.post(BASE + "/api/jobs/%s/cancel" % pid, json={}) as r:
        try:
            body = await r.json()
        except Exception:
            body = (await r.text())[:500]
        rec.update({"status": r.status, "body": body, "post_s": round(time.perf_counter() - t, 3)})


async def queue(graph, label, cancel_after=None, cancel_node="ck_key", cancel_after_end=False, pending_cancel=None):
    """Queue `graph`, follow it on the websocket to its end. `cancel_after`: seconds after `cancel_node` starts at which
    Scumble's cancel is sent. `cancel_after_end`: the cancel sent once the prompt ended. `pending_cancel`: a second
    graph queued right behind this one and cancelled while it is pending (its answer and history kept)."""
    timeline, progress = [], []
    peak = Peak()
    s0, m0, lp = stats(), smi(), log_pos()
    cancel = {}
    pend = {}
    async with aiohttp.ClientSession() as sess:
        async with sess.ws_connect("ws://127.0.0.1:8188/ws?clientId=" + CID, max_msg_size=0) as ws:
            t0 = time.perf_counter()
            peak.start()
            async with sess.post(BASE + "/prompt", json={"prompt": graph, "client_id": CID}) as r:
                j = await r.json()
                if r.status >= 400 or "prompt_id" not in j:
                    peak.stop = True
                    raise RuntimeError("%s: %s" % (label, json.dumps(j)[:3000]))
            pid = j["prompt_id"]
            remember(pid)
            if pending_cancel is not None:
                async with sess.post(BASE + "/prompt", json={"prompt": pending_cancel, "client_id": CID}) as r2:
                    j2 = await r2.json()
                pend["prompt_id"] = j2["prompt_id"]
                remember(j2["prompt_id"])
                pend["queue_at_cancel"] = get("/queue").json()
                pend["queue_at_cancel"] = {"running": [x[1] for x in pend["queue_at_cancel"]["queue_running"]],
                                           "pending": [x[1] for x in pend["queue_at_cancel"]["queue_pending"]]}
                await _cancel(sess, pend["prompt_id"], pend)
            task = None
            end = None
            err = None
            while True:
                msg = await ws.receive(timeout=1800)
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                m = json.loads(msg.data)
                d = m.get("data") or {}
                if d.get("prompt_id") not in (None, pid):
                    if m["type"] in ("execution_start", "executing", "execution_success") and d.get("prompt_id") == pend.get("prompt_id"):
                        pend.setdefault("events", []).append([round(time.perf_counter() - t0, 3), m["type"], d.get("node")])
                    continue
                t = time.perf_counter() - t0
                if m["type"] == "executing":
                    timeline.append([round(t, 3), d.get("node")])
                    if d.get("node") == cancel_node and cancel_after is not None and task is None:
                        async def later(delay=cancel_after):
                            await asyncio.sleep(delay)
                            cancel["sent_s"] = round(time.perf_counter() - t0, 3)
                            await _cancel(sess, pid, cancel)
                        task = asyncio.ensure_future(later())
                    if d.get("node") is None and d.get("prompt_id") == pid:
                        end = "done"
                        break
                elif m["type"] == "progress":
                    progress.append([round(t, 3), d.get("node"), d.get("value"), d.get("max")])
                elif m["type"] in ("execution_start", "execution_cached", "execution_success"):
                    timeline.append([round(t, 3), m["type"], d.get("nodes")])
                    if m["type"] == "execution_success":
                        end = "success"
                        break
                elif m["type"] == "execution_interrupted":
                    timeline.append([round(t, 3), "interrupted", d.get("node_id"), d.get("node_type")])
                    end = "interrupted"
                    break
                elif m["type"] == "execution_error":
                    err = {k: d.get(k) for k in ("node_id", "node_type", "exception_message")}
                    timeline.append([round(t, 3), "error"])
                    end = "error"
                    break
            wall = time.perf_counter() - t0
            if task is not None:
                await task
            if cancel_after_end:
                cancel["sent_s"] = round(time.perf_counter() - t0, 3)
                await _cancel(sess, pid, cancel)
    peak.stop = True
    peak.join()
    h = {}
    for _ in range(50):
        h = get("/history/" + pid).json().get(pid) or {}
        if h.get("status", {}).get("completed") is not None or h.get("outputs"):
            break
        time.sleep(0.2)
    msgs = (h.get("status") or {}).get("messages") or []
    ts = {mm[0]: mm[1].get("timestamp") for mm in msgs if isinstance(mm, list) and len(mm) == 2 and isinstance(mm[1], dict)}
    server_s = None
    stop = ts.get("execution_success") or ts.get("execution_error") or ts.get("execution_interrupted")
    if ts.get("execution_start") and stop:
        server_s = (stop - ts["execution_start"]) / 1000.0
    nodes = {}
    ex = [x for x in timeline if len(x) == 2]
    marks = ex + [[round(wall, 3), "end"]]
    for (ta, na), (tb, _nb) in zip(marks, marks[1:]):
        if na not in (None, "end"):
            nodes[na] = round(tb - ta, 3)
    if pend.get("prompt_id"):
        ph = get("/history/" + pend["prompt_id"]).json().get(pend["prompt_id"]) or {}
        pend["history"] = {"present": bool(ph), "status": (ph.get("status") or {}).get("status_str"),
                           "outputs": sorted((ph.get("outputs") or {}).keys())}
    time.sleep(0.6)
    return {"label": label, "prompt_id": pid, "end": end, "wall_s": round(wall, 3), "server_s": server_s, "node_s": nodes,
            "error": err, "outputs": h.get("outputs") or {}, "status_str": (h.get("status") or {}).get("status_str"),
            "history_messages": [mm[0] for mm in msgs if isinstance(mm, list)],
            "vram_before": s0, "vram_after": stats(), "smi_before": m0, "smi_after": smi(), "smi_peak_mib": peak.peak,
            "progress_frames": len(progress), "progress_last": progress[-1] if progress else None,
            "cancel": cancel or None, "pending": pend or None, "timeline": timeline, "log": log_since(lp)}


def view(img):
    r = get("/view", params={"filename": img["filename"], "subfolder": img.get("subfolder", ""), "type": img.get("type", "temp")})
    return r.content


def free(unload=True, mem=True, wait=4.0):
    post("/free", {"unload_models": unload, "free_memory": mem})
    time.sleep(wait)
    return {"vram": stats(), "smi": smi()}


# ---------------------------------------------------------------------------------------------------------------------
# graphs

def g_key(img_ref, hint_ref=None, trust=0.5, despill=0.5, screen="green", keep=False):
    """The plan's pack A graph (§4.11), node ids as there; ck_out on the rgba output."""
    g = {
        "ck_in": {"class_type": "InpaintCanvasLoadRef", "inputs": {"ref": json.dumps(img_ref)}},
        "ck_model": {"class_type": "CorridorKey2ModelLoader",
                     "inputs": fill("CorridorKey2ModelLoader", {"auto_download": False, "keep_on_gpu": keep, "vram_reserve_gb": 0.5})},
        "ck_key": {"class_type": "CorridorKey2Basic",
                   "inputs": fill("CorridorKey2Basic", {"model": ["ck_model", 0], "images": ["ck_in", 0], "hint_quality": QUALITY[trust],
                                                        "invert_hint": False, "despill": despill, "screen": screen})},
        "ck_out": {"class_type": "PreviewImage", "inputs": {"images": ["ck_key", 2]}},
    }
    if hint_ref:
        g["ck_hint_img"] = {"class_type": "InpaintCanvasLoadRef", "inputs": {"ref": json.dumps(hint_ref)}}
        g["ck_hint"] = {"class_type": "ImageToMask", "inputs": {"image": ["ck_hint_img", 0], "channel": "red"}}
        g["ck_key"]["inputs"]["alpha_hint"] = ["ck_hint", 0]
    assert g["ck_model"]["inputs"]["auto_download"] is False
    return g


PROMPTS = [
    "a red ceramic teapot on a wooden table, soft window light, shallow depth of field",
    "a bicycle leaning against a yellow wall in a narrow street, late afternoon sun",
    "a bowl of lemons on a marble counter, morning light, photograph",
    "an old brass key on a stack of books, warm lamp light, close-up",
    "a sailboat on a calm lake at dawn, mist over the water",
    "a glass jar of honey with a wooden dipper, backlit, macro photograph",
    "a fox sitting in fresh snow beside a pine tree, overcast light",
    "a stack of folded blue towels on a white shelf, clean studio light",
    "a cup of espresso on a saucer, top view, dark wooden table",
    "a pair of worn hiking boots on a rock by a stream, summer light",
    "a lighthouse on a cliff at dusk, waves below, long exposure",
    "a ripe pear on a linen cloth, painterly still life lighting",
]


def g_klein(i, w=1024, h=1024):
    """FLUX 3 Image Klein text to image on the models of recipes/flux3_klein_local.json (16 steps, CFG 1, euler,
    simple), the text encoder the stills used (the recipe's default is not on this server, I0a)."""
    return {
        "unet": {"class_type": "UNETLoader", "inputs": fill("UNETLoader", {"unet_name": "flux3-image-klein-int8-convrot.safetensors", "weight_dtype": "default"})},
        "clip": {"class_type": "CLIPLoader", "inputs": fill("CLIPLoader", {"clip_name": "qwen3vl_4b_bf16.safetensors", "type": "flux3", "device": "default"})},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": PROMPTS[i % len(PROMPTS)]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": ""}},
        "latent": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "sched": {"class_type": "BasicScheduler", "inputs": {"model": ["unet", 0], "scheduler": "simple", "steps": 16, "denoise": 1}},
        "guider": {"class_type": "CFGGuider", "inputs": {"model": ["unet", 0], "positive": ["pos", 0], "negative": ["neg", 0], "cfg": 1}},
        "noise": {"class_type": "RandomNoise", "inputs": {"noise_seed": 52000 + i}},
        "sampler": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "run": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["noise", 0], "guider": ["guider", 0], "sampler": ["sampler", 0],
                                                                    "sigmas": ["sched", 0], "latent_image": ["latent", 0]}},
        "decode": {"class_type": "VAEDecode", "inputs": {"samples": ["run", 0], "vae": ["vae", 0]}},
        "out": {"class_type": "PreviewImage", "inputs": {"images": ["decode", 0]}},
    }


# ---------------------------------------------------------------------------------------------------------------------
# pictures

def still(name):
    return cv2.cvtColor(cv2.imread(os.path.join(STILLS, name + ".png")), cv2.COLOR_BGR2RGB)


def sized(img, n):
    interp = cv2.INTER_AREA if n < img.shape[0] else cv2.INTER_LANCZOS4
    return cv2.resize(img, (n, n), interpolation=interp)


def rgba_of(res, node="ck_out"):
    img = ((res["outputs"].get(node) or {}).get("images") or [None])[0]
    if not img:
        return None, None
    data = view(img)
    return data, np.array(Image.open(io.BytesIO(data)))


def short(r):
    keep = ("label", "end", "wall_s", "server_s", "node_s", "error", "smi_peak_mib", "progress_frames", "cancel", "pending")
    return {k: r.get(k) for k in keep}


def strip(r):
    r = dict(r)
    r.pop("outputs", None)
    return r


def comp(rgba, bg):
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    return (rgba[..., :3].astype(np.float32) * a + np.array(bg, np.float32) * (1 - a) + 0.5).clip(0, 255).astype(np.uint8)


def sha(b):
    return hashlib.sha256(b).hexdigest()


# ---------------------------------------------------------------------------------------------------------------------
# phases

async def phase_evict():
    rep = {"phase": "evict", "start": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    hair = still("hair_green")
    pics = {lab: sized(hair, n) for lab, n in (("1MP", 1024), ("4MP", 2048), ("16MP", 4096))}
    rep["free_start"] = free()
    runs = []

    async def run(graph, label):
        r = await queue(graph, label)
        runs.append(strip(r))
        print(json.dumps(short(r)), flush=True)
        return r

    gi = 0

    async def gen(label):
        nonlocal gi
        r = await run(g_klein(gi), label)
        gi += 1
        return r

    # the loader's first run reads the 5 GB of weights into RAM: done once before anything is timed
    await run(g_key(upload(pics["1MP"], "warm_1024.png")), "key 1MP warm-up (loader cold)")
    await gen("generate cold")
    await gen("generate warm a")
    for lab in ("1MP", "4MP", "16MP"):
        await run(g_key(upload(pics[lab], "hair_%s.png" % lab)), "key %s" % lab)
        await gen("generate after key %s" % lab)
        await gen("generate warm after the reload (%s)" % lab)
    # keep_on_gpu on: the 4.6 GB stay parked; what the next Generate does beside them
    await run(g_key(upload(pics["1MP"], "keep_1024.png"), keep=True), "key 1MP keep_on_gpu")
    await gen("generate after key 1MP keep_on_gpu")
    await gen("generate warm after keep_on_gpu")
    rep["keep_parked"] = {"vram": stats(), "smi": smi()}
    rep["free_end"] = free()
    rep["runs"] = runs
    rep["end"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    return rep


async def phase_extra():
    rep = {"phase": "extra", "start": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    hair = still("hair_green")
    hint_full = cv2.imread(os.path.join(HINTS, "hair_green", "hint_full.png"), cv2.IMREAD_GRAYSCALE)
    runs = []

    async def run(graph, label):
        r = await queue(graph, label)
        runs.append(strip(r))
        print(json.dumps(short(r)), flush=True)
        return r

    gi = 6
    await run(g_key(upload(sized(hair, 1024), "warm_x.png")), "key 1MP warm-up")
    for lab, n in (("2MP", 1448), ("8MP", 2896)):
        pic = sized(hair, n)
        hint = cv2.resize(hint_full, (n, n), interpolation=cv2.INTER_AREA if n < 1344 else cv2.INTER_LINEAR)
        await run(g_klein(gi), "generate warm before %s" % lab)
        gi += 1
        await run(g_key(upload(pic, "hair_%s.png" % lab)), "key %s no hint" % lab)
        await run(g_klein(gi), "generate after key %s" % lab)
        gi += 1
        await run(g_key(upload(pic, "hair_%s_h.png" % lab), upload(hint, "hint_%s.png" % lab), trust=0.5), "key %s hint" % lab)
        await run(g_klein(gi), "generate after key %s hint" % lab)
        gi += 1
    rep["runs"] = runs
    rep["free_end"] = free()
    rep["end"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    return rep


async def phase_cancel():
    rep = {"phase": "cancel", "start": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    hair = still("hair_green")
    big = sized(hair, 4096)
    follow = [sized(still(s), 1024) for s in ("green_plate", "blue_plate", "flat_green_plant", "highlights_green",
                                               "hair_green", "green_plate", "blue_plate")]
    runs = []

    async def run(graph, label, **kw):
        r = await queue(graph, label, **kw)
        runs.append(strip(r))
        print(json.dumps(short(r)), flush=True)
        return r

    await run(g_key(upload(sized(hair, 1024), "warm_c.png")), "key 1MP warm-up")
    await run(g_key(upload(big, "big_ref.png")), "key 16MP uncancelled (reference)")
    fi = 0
    for delay in (0.5, 3.0, 5.4):
        variant = [big, np.ascontiguousarray(big[:, ::-1]), np.ascontiguousarray(big[::-1])][fi % 3]
        r = await run(g_key(upload(variant, "big_%s.png" % delay)), "key 16MP cancelled %.1f s into the key node" % delay,
                      cancel_after=delay)
        rep.setdefault("after_cancel", []).append({"delay": delay, "smi": smi(), "vram": stats()})
        await run(g_key(upload(follow[fi], "follow_%d.png" % fi)), "key 1MP right after the cancel at %.1f s" % delay)
        fi += 1
    # a Cancel that arrives once the job has ended (the answer and the click crossing)
    await run(g_key(upload(follow[fi], "follow_%d.png" % fi)), "key 1MP, cancelled after its end", cancel_after_end=True)
    fi += 1
    await run(g_key(upload(follow[fi], "follow_%d.png" % fi)), "key 1MP right after the late cancel")
    fi += 1
    # a Cancel of a job still pending behind a running one
    await run(g_key(upload(big, "big_p.png")), "key 16MP with a 1MP key pending behind it, cancelled while pending",
              pending_cancel=g_key(upload(follow[fi], "follow_%d.png" % fi)))
    rep["runs"] = runs
    rep["end"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    return rep


def edge_metrics(a, b):
    """a, b: float alpha arrays of one region. MAE, max, the edge band's MAE (0.02 < either < 0.98), the interior."""
    d = np.abs(a - b)
    band = ((a > 0.02) & (a < 0.98)) | ((b > 0.02) & (b < 0.98))
    return {"mae": round(float(d.mean()), 5), "max": round(float(d.max()), 4),
            "edge_mae": round(float(d[band].mean()), 5) if band.any() else None, "edge_px": int(band.sum()),
            "px_off_by_over_0.1": int((d > 0.1).sum())}


async def phase_box():
    rep = {"phase": "box", "start": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "cases": {}}
    out = os.path.join(WORK, "box")
    os.makedirs(out, exist_ok=True)
    runs = []
    await queue(g_key(upload(sized(still("hair_green"), 1024), "warm_b.png")), "key 1MP warm-up")
    for name in ("green_plate", "flat_green_plant"):
        img = still(name)
        H, W = img.shape[:2]
        hint_full = cv2.imread(os.path.join(HINTS, name, "hint_full.png"), cv2.IMREAD_GRAYSCALE)
        ref_a = np.load(os.path.join(HINTS, name, "native_nohint", "alpha.npy")).astype(np.float32)
        ys, xs = np.nonzero(ref_a > 0.02)
        x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
        tight = (max(0, x0 - 4), max(0, y0 - 4), min(W, x1 + 4), min(H, y1 + 4))
        gx, gy = int(0.25 * (x1 - x0)), int(0.25 * (y1 - y0))
        loose = (max(0, x0 - gx), max(0, y0 - gy), min(W, x1 + gx), min(H, y1 + gy))
        bp = ck_common.box_plan(hint_full, 768, W, H)
        plan = (bp[0], bp[1], bp[0] + bp[2], bp[1] + bp[3])
        whole = (0, 0, W, H)
        boxes = {"tight": tight}
        if loose != whole:
            boxes["loose"] = loose
        if plan != whole and plan != loose:
            boxes["plan"] = plan
        boxes["whole"] = whole
        case = {"subject_bounds": [x0, y0, x1, y1], "boxes": boxes, "plan_box": plan, "loose_box": loose}
        alphas = {}
        for hint in (False, True):
            for lab, (bx0, by0, bx1, by1) in boxes.items():
                crop = np.ascontiguousarray(img[by0:by1, bx0:bx1])
                href = upload(np.ascontiguousarray(hint_full[by0:by1, bx0:bx1]), "%s_%s_hint.png" % (name, lab)) if hint else None
                r = await queue(g_key(upload(crop, "%s_%s.png" % (name, lab)), href, trust=0.5),
                                "box %s %s %s" % (name, lab, "hint" if hint else "no hint"))
                data, rgba = rgba_of(r)
                runs.append(strip(r))
                print(json.dumps(short(r)), flush=True)
                key = "%s_%s" % (lab, "hint" if hint else "nohint")
                cv2.imwrite(os.path.join(out, "%s_%s.png" % (name, key)), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
                full = np.zeros((H, W), np.float32)
                full[by0:by1, bx0:bx1] = rgba[..., 3].astype(np.float32) / 255.0
                alphas[key] = (full, rgba, (bx0, by0, bx1, by1))
        tx0, ty0, tx1, ty1 = tight
        m = {}
        for hint in ("nohint", "hint"):
            base = alphas["whole_" + hint][0][ty0:ty1, tx0:tx1]
            for lab in boxes:
                k = "%s_%s" % (lab, hint)
                if k not in alphas or lab == "whole":
                    continue
                m["%s vs whole (%s)" % (lab, hint)] = edge_metrics(alphas[k][0][ty0:ty1, tx0:tx1], base)
                # the tight box's own border: the outer 24 px ring of the tight region
                a, b = alphas[k][0][ty0:ty1, tx0:tx1], base
                ring = np.zeros_like(a, bool)
                ring[:24], ring[-24:], ring[:, :24], ring[:, -24:] = True, True, True, True
                m["%s vs whole (%s)" % (lab, hint)]["ring24_mae"] = round(float(np.abs(a - b)[ring].mean()), 5)
            m["hint vs no hint (whole)"] = edge_metrics(alphas["whole_hint"][0], alphas["whole_nohint"][0])
            m["whole (%s) vs I0a native_%s (bf16 reference, upstream code)" % (hint, hint)] = edge_metrics(
                alphas["whole_" + hint][0], np.load(os.path.join(HINTS, name, "native_" + hint, "alpha.npy")).astype(np.float32))
        case["metrics"] = m
        # by eye: the tight region of each key over grey, side by side
        tiles = []
        for k in sorted(alphas):
            full, rgba, (bx0, by0, bx1, by1) = alphas[k]
            canvas = np.full((H, W, 3), 128, np.uint8)
            canvas[by0:by1, bx0:bx1] = comp(rgba, (128, 128, 128))
            t = canvas[ty0:ty1, tx0:tx1].copy()
            cv2.putText(t, k, (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
            tiles.append(t)
        sheet = np.concatenate(tiles, axis=1)
        cv2.imwrite(os.path.join(out, "%s_sheet.jpg" % name), cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
        rep["cases"][name] = case
        print(json.dumps({name: m}), flush=True)
    rep["runs"] = runs
    rep["end"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    return rep


def spill_index(rgba, screen):
    """Alpha-weighted mean of the screen channel's excess over the other two (bytes), in the edge band (0.05 < a <
    0.95) and in the opaque subject (a > 0.98)."""
    rgb = rgba[..., :3].astype(np.float32)
    a = rgba[..., 3].astype(np.float32) / 255.0
    c = 2 if screen == "blue" else 1
    others = np.delete(rgb, c, axis=2).max(axis=2)
    ex = np.maximum(0.0, rgb[..., c] - others)
    band = (a > 0.05) & (a < 0.95)
    opaque = a > 0.98
    return {"edge_px": int(band.sum()), "edge_excess": round(float((ex * a)[band].sum() / max(1e-6, a[band].sum())), 2),
            "edge_px_excess_over_8": int(((ex > 8) & band).sum()),
            "opaque_excess": round(float(ex[opaque].mean()), 2) if opaque.any() else None,
            "opaque_px_excess_over_8": int(((ex > 8) & opaque).sum())}


async def phase_despill():
    rep = {"phase": "despill", "start": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "cases": {}}
    out = os.path.join(WORK, "despill")
    os.makedirs(out, exist_ok=True)
    runs = []
    await queue(g_key(upload(sized(still("hair_green"), 1024), "warm_d.png")), "key 1MP warm-up")
    plans = [("blue_plate", "blue", 0.0), ("blue_plate", "blue", 0.5), ("blue_plate", "blue", 1.0), ("blue_plate", "green", 0.5),
             ("green_plate", "green", 0.0), ("green_plate", "green", 0.5), ("green_plate", "green", 1.0)]
    got = {}
    for name, screen, sp in plans:
        img = still(name)
        r = await queue(g_key(upload(img, "%s_%s_%s.png" % (name, screen, sp)), despill=sp, screen=screen),
                        "despill %s screen %s %.1f" % (name, screen, sp))
        data, rgba = rgba_of(r)
        runs.append(strip(r))
        print(json.dumps(short(r)), flush=True)
        k = "%s_%s_%.1f" % (name, screen, sp)
        cv2.imwrite(os.path.join(out, k + ".png"), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
        true_screen = "blue" if name == "blue_plate" else "green"
        got[k] = rgba
        rep["cases"][k] = {"spill_index_on_its_true_screen": spill_index(rgba, true_screen),
                           "alpha_mean": round(float(rgba[..., 3].mean() / 255.0), 4)}
        print(json.dumps({k: rep["cases"][k]}), flush=True)
    # by eye: the head and the stool / feet of blue_plate over grey and over a warm colour, at 2x
    regions = {"blue_plate": {"head": (560, 70, 820, 330), "stool": (540, 780, 820, 1180)},
               "green_plate": {"head": (600, 40, 800, 260), "hands": (460, 520, 900, 820)}}
    for name, regs in regions.items():
        keys = [k for k in got if k.startswith(name)]
        for rlab, (x0, y0, x1, y1) in regs.items():
            rows = []
            for bg in ((128, 128, 128), (225, 150, 70)):
                tiles = []
                for k in keys:
                    t = comp(got[k][y0:y1, x0:x1], bg)
                    t = cv2.resize(t, ((x1 - x0) * 2, (y1 - y0) * 2), interpolation=cv2.INTER_NEAREST) if (x1 - x0) < 300 else t
                    t = t.copy()
                    cv2.putText(t, k.replace(name + "_", ""), (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
                    tiles.append(t)
                rows.append(np.concatenate(tiles, axis=1))
            cv2.imwrite(os.path.join(out, "%s_%s_sheet.jpg" % (name, rlab)), cv2.cvtColor(np.concatenate(rows, axis=0), cv2.COLOR_RGB2BGR),
                        [cv2.IMWRITE_JPEG_QUALITY, 92])
    rep["runs"] = runs
    rep["end"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    return rep


async def phase_fixture(fix):
    """The key gate's Route B fixture (B2): hair_green's right hair edge, 512 x 400, keyed natively (the graph as the
    plan builds it, the loose-hint trust Scumble sends by default), and the same box keyed at half size (the scaled
    path: the input reduced with INTER_AREA, the answer 256 x 200)."""
    os.makedirs(fix, exist_ok=True)
    img = still("hair_green")
    hint_full = cv2.imread(os.path.join(HINTS, "hair_green", "hint_full.png"), cv2.IMREAD_GRAYSCALE)
    x0, y0, w, h = 832, 96, 512, 400
    crop = np.ascontiguousarray(img[y0:y0 + h, x0:x0 + w])
    hint = np.ascontiguousarray(hint_full[y0:y0 + h, x0:x0 + w])
    half = cv2.resize(crop, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    hint_half = cv2.resize(hint, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    await queue(g_key(upload(sized(still("green_plate"), 1024), "warm_f.png")), "key 1MP warm-up")
    meta = {"source": {"still": "hair_green.png", "sha256": sha(open(os.path.join(STILLS, "hair_green.png"), "rb").read()),
                       "box": [x0, y0, w, h], "hint_source": "dist/ck_ref/hair_green/hint_full.png (I0a's rough brush hint)",
                       "half": "input and hint reduced to 256 x 200 with OpenCV INTER_AREA"},
            "server": {"comfyui": get("/system_stats").json()["system"].get("comfyui_version"), "pack": "ComfyUI-CorridorKey2.0 @ c7662de"},
            "settings": {"hint_quality": QUALITY[0.5], "trust": 0.5, "despill": 0.5, "screen": "green", "keep_on_gpu": False,
                         "auto_download": False, "vram_reserve_gb": 0.5},
            "cases": {}, "date": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    for lab, im, hi in (("native", crop, hint), ("half", half, hint_half)):
        pfx = "" if lab == "native" else "half_"
        ib, hb = png_bytes(im), png_bytes(hi)
        open(os.path.join(fix, pfx + "input.png"), "wb").write(ib)
        open(os.path.join(fix, pfx + "hint.png"), "wb").write(hb)
        iref, href = upload(ib, "fx_%sinput.png" % pfx), upload(hb, "fx_%shint.png" % pfx)
        g = g_key(iref, href, trust=0.5)
        r = await queue(g, "fixture " + lab)
        data, rgba = rgba_of(r)
        open(os.path.join(fix, pfx + "rgba.png"), "wb").write(data)
        # the graph with the upload names replaced by placeholders (the gate fills in its own)
        gj = json.loads(json.dumps(g))
        gj["ck_in"]["inputs"]["ref"] = json.dumps({"filename": "<input>", "subfolder": "ck_b0", "type": "temp"})
        gj["ck_hint_img"]["inputs"]["ref"] = json.dumps({"filename": "<hint>", "subfolder": "ck_b0", "type": "temp"})
        with open(os.path.join(fix, pfx + "graph.json"), "w", encoding="utf-8", newline=chr(10)) as f:
            json.dump(gj, f, indent=1)
            f.write("\n")
        A = rgba[..., 3].astype(np.int16)
        meta["cases"][lab] = {
            "input": pfx + "input.png", "hint": pfx + "hint.png", "rgba": pfx + "rgba.png", "graph": pfx + "graph.json",
            "size": [int(im.shape[1]), int(im.shape[0])], "rgba_shape": list(rgba.shape), "png_bitdepth": data[24], "png_colortype": data[25],
            "sha256": {"input": sha(ib), "hint": sha(hb), "rgba": sha(data)}, "bytes": {"input": len(ib), "hint": len(hb), "rgba": len(data)},
            "alpha_mean": round(float(A.mean() / 255.0), 4), "alpha0_px": int((A == 0).sum()), "alpha255_px": int((A == 255).sum()),
            "px_rgb_above_alpha_plus2": round(float((rgba[..., :3].max(axis=2).astype(np.int16) > A + 2).mean()), 4),
            "node_s": r["node_s"], "wall_s": r["wall_s"]}
        print(json.dumps({lab: meta["cases"][lab]}), flush=True)
    with open(os.path.join(fix, "fixture.json"), "w", encoding="utf-8", newline=chr(10)) as f:
        json.dump(meta, f, indent=1)
        f.write("\n")
    return {"phase": "fixture", "meta": meta}


def phase_cleanup():
    ids = []
    p = os.path.join(WORK, "queued.txt")
    if os.path.exists(p):
        ids = [ln.strip() for ln in open(p, encoding="utf-8") if ln.strip()]
    q = get("/queue").json()
    mine_pending = [x[1] for x in q["queue_pending"] if x[1] in ids]
    if mine_pending:
        post("/queue", {"delete": mine_pending})
    for i in range(0, len(ids), 50):
        post("/history", {"delete": ids[i:i + 50]})
    left = [x for x in ids if get("/history/" + x).json()]
    hist = get("/history").json()
    return {"phase": "cleanup", "ids": len(ids), "still_in_history": left, "history_total_after": len(hist),
            "queue_after": get("/queue").json(), "free": free()}


def main():
    global WORK
    phase, WORK = sys.argv[1], sys.argv[2]
    os.makedirs(WORK, exist_ok=True)
    if phase != "cleanup":
        q = get("/queue").json()
        assert not q["queue_running"] and not q["queue_pending"], "queue not empty"
    if phase == "evict":
        rep = asyncio.run(phase_evict())
    elif phase == "extra":
        rep = asyncio.run(phase_extra())
    elif phase == "cancel":
        rep = asyncio.run(phase_cancel())
    elif phase == "box":
        rep = asyncio.run(phase_box())
    elif phase == "despill":
        rep = asyncio.run(phase_despill())
    elif phase == "fixture":
        rep = asyncio.run(phase_fixture(sys.argv[3]))
    elif phase == "cleanup":
        rep = phase_cleanup()
    else:
        raise SystemExit("unknown phase " + phase)
    with open(os.path.join(WORK, "b0_%s.json" % phase), "w", encoding="utf-8", newline=chr(10)) as f:
        json.dump(rep, f, indent=1, default=str)
        f.write("\n")
    print("DONE", phase)


if __name__ == "__main__":
    main()
