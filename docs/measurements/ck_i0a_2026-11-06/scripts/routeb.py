"""I0a's Route B facts through the user's ComfyUI (127.0.0.1:8188) with pack A, and /object_info of its nodes.

    python routeb.py objectinfo <out dir>       one JSON per node class of pack A
    python routeb.py probe <work dir>          the timed runs, keep_on_gpu and /free, the rgba read-back, the hint polarity

Every graph sends auto_download false. Inputs are uploaded with type "temp" (subfolder ck_probe), so nothing lands in
the user's input folder; previews are PreviewImage / PreviewAny (temp). Every prompt this script queued is deleted from
the history at the end.
"""
import asyncio
import io
import json
import os
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
sys.path.insert(0, HERE)
import ck_common  # noqa: E402

BASE = "http://127.0.0.1:8188"
CID = "ck-i0a-" + uuid.uuid4().hex[:8]
QUEUED = []
OI = None


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


def object_info():
    global OI
    if OI is None:
        OI = get("/object_info").json()
    return OI


def fill(cls, given):
    """Every required (and listed optional-with-default) input of `cls` from its spec's default, `given` on top."""
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


def upload(arr_or_path, name):
    if isinstance(arr_or_path, str):
        data = open(arr_or_path, "rb").read()
    else:
        ok, buf = cv2.imencode(".png", arr_or_path if arr_or_path.ndim == 2 else cv2.cvtColor(arr_or_path, cv2.COLOR_RGB2BGR))
        assert ok
        data = buf.tobytes()
    r = requests.post(BASE + "/upload/image", files={"image": (name, data, "image/png")},
                      data={"type": "temp", "subfolder": "ck_probe", "overwrite": "true"}, timeout=120)
    r.raise_for_status()
    j = r.json()
    return "%s/%s [temp]" % (j["subfolder"], j["name"]) if j.get("subfolder") else "%s [temp]" % j["name"]


async def queue(graph, label):
    timeline = []
    peak = Peak()
    s0, m0 = stats(), smi()
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
            QUEUED.append(pid)
            err = None
            while True:
                msg = await ws.receive(timeout=3600)
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                m = json.loads(msg.data)
                d = m.get("data") or {}
                if d.get("prompt_id") not in (None, pid):
                    continue
                t = time.perf_counter() - t0
                if m["type"] == "executing":
                    timeline.append([round(t, 3), d.get("node")])
                    if d.get("node") is None and d.get("prompt_id") == pid:
                        break
                elif m["type"] in ("execution_start", "execution_cached", "execution_success"):
                    timeline.append([round(t, 3), m["type"], d.get("nodes")])
                elif m["type"] == "execution_error":
                    err = {k: d.get(k) for k in ("node_id", "node_type", "exception_message")}
                    timeline.append([round(t, 3), "error"])
                    break
            wall = time.perf_counter() - t0
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
    if ts.get("execution_start") and (ts.get("execution_success") or ts.get("execution_error")):
        server_s = ((ts.get("execution_success") or ts.get("execution_error")) - ts["execution_start"]) / 1000.0
    # per node: from its "executing" to the next one
    nodes = {}
    ex = [x for x in timeline if len(x) == 2]
    for (ta, na), (tb, _nb) in zip(ex, ex[1:]):
        if na is not None:
            nodes[na] = round(tb - ta, 3)
    return {"label": label, "prompt_id": pid, "wall_s": round(wall, 3), "server_s": server_s, "node_s": nodes, "error": err,
            "outputs": h.get("outputs") or {}, "vram_before": s0, "vram_after": stats(), "smi_before": m0, "smi_after": smi(),
            "smi_peak_mib": peak.peak, "timeline": timeline}


def view(img):
    r = get("/view", params={"filename": img["filename"], "subfolder": img.get("subfolder", ""), "type": img.get("type", "temp")})
    return r.content


def free(unload=True, mem=True, wait=4.0):
    post("/free", {"unload_models": unload, "free_memory": mem})
    time.sleep(wait)
    return {"vram": stats(), "smi": smi()}


def g_advanced(img_ref, keep=False, hint_ref=None):
    g = {
        "load": {"class_type": "LoadImage", "inputs": fill("LoadImage", {"image": img_ref})},
        "model": {"class_type": "CorridorKey2ModelLoader", "inputs": fill("CorridorKey2ModelLoader", {"auto_download": False, "keep_on_gpu": keep})},
        "key": {"class_type": "CorridorKey2Advanced", "inputs": fill("CorridorKey2Advanced", {"model": ["model", 0], "images": ["load", 0]})},
        "info": {"class_type": "PreviewAny", "inputs": {"source": ["key", 4]}},
    }
    if hint_ref:
        g["hint_img"] = {"class_type": "LoadImage", "inputs": fill("LoadImage", {"image": hint_ref})}
        g["hint"] = {"class_type": "ImageToMask", "inputs": {"image": ["hint_img", 0], "channel": "red"}}
        g["key"]["inputs"]["alpha_hint"] = ["hint", 0]
    return g


def g_basic(img_ref, hint_ref=None, quality="clean matte (0.95)", keep=False, outputs=("fg", "alpha", "rgba")):
    g = {
        "load": {"class_type": "LoadImage", "inputs": fill("LoadImage", {"image": img_ref})},
        "model": {"class_type": "CorridorKey2ModelLoader", "inputs": fill("CorridorKey2ModelLoader", {"auto_download": False, "keep_on_gpu": keep})},
        "key": {"class_type": "CorridorKey2Basic", "inputs": fill("CorridorKey2Basic", {"model": ["model", 0], "images": ["load", 0],
                                                                                         "hint_quality": quality, "despill": 0.5, "screen": "green", "invert_hint": False})},
    }
    if hint_ref:
        g["hint_img"] = {"class_type": "LoadImage", "inputs": fill("LoadImage", {"image": hint_ref})}
        g["hint"] = {"class_type": "ImageToMask", "inputs": {"image": ["hint_img", 0], "channel": "red"}}
        g["key"]["inputs"]["alpha_hint"] = ["hint", 0]
    if "fg" in outputs:
        g["out_fg"] = {"class_type": "PreviewImage", "inputs": {"images": ["key", 0]}}
    if "alpha" in outputs:
        g["alpha_img"] = {"class_type": "MaskToImage", "inputs": {"mask": ["key", 1]}}
        g["out_alpha"] = {"class_type": "PreviewImage", "inputs": {"images": ["alpha_img", 0]}}
    if "rgba" in outputs:
        g["out_rgba"] = {"class_type": "PreviewImage", "inputs": {"images": ["key", 2]}}
    return g


def info_text(res):
    o = res["outputs"].get("info") or {}
    t = o.get("text")
    return t[0] if isinstance(t, list) and t else t


def main_objectinfo(out_dir):
    oi = object_info()
    os.makedirs(out_dir, exist_ok=True)
    mine = {k: v for k, v in oi.items() if "CorridorKey2" in str(v.get("python_module", "")) or "corridorkey" in str(v.get("python_module", "")).lower()}
    for k, v in sorted(mine.items()):
        with open(os.path.join(out_dir, k + ".json"), "w", encoding="utf-8", newline=chr(10)) as f:
            json.dump({k: v}, f, indent=1, ensure_ascii=False)
            f.write("\n")
    print(json.dumps({"classes": sorted(mine), "python_module": sorted({v.get("python_module") for v in mine.values()}),
                      "core": {c: c in oi for c in ("LoadImage", "ImageToMask", "MaskToImage", "PreviewImage", "PreviewAny", "InpaintCanvasLoadRef")}}, indent=1))


async def main_probe(work):
    os.makedirs(work, exist_ok=True)
    rep = {"client_id": CID, "start": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "queue_before": get("/queue").json()}
    assert not rep["queue_before"]["queue_running"] and not rep["queue_before"]["queue_pending"], "queue not empty"
    still = cv2.cvtColor(cv2.imread(r"F:\canvas\.claude\worktrees\corridorkey\dist\ck_ref\stills\hair_green.png"), cv2.COLOR_BGR2RGB)
    sizes = {"1MP": 1024, "4MP": 2048, "16MP": 4096}
    refs = {}
    for lab, n in sizes.items():
        interp = cv2.INTER_AREA if n < still.shape[0] else cv2.INTER_LANCZOS4
        a = cv2.resize(still, (n, n), interpolation=interp)
        refs[lab] = upload(a, "hair_%d.png" % n)
        refs[lab + "_flip"] = upload(np.ascontiguousarray(a[:, ::-1]), "hair_%d_flip.png" % n)
    hint = ck_common.rough_hint(cv2.resize(still, (1024, 1024), interpolation=cv2.INTER_AREA), "green")
    refs["hint"] = upload(hint, "hair_1024_hint.png")
    refs["hint_inv"] = upload(255 - hint, "hair_1024_hint_inv.png")
    cv2.imwrite(os.path.join(work, "hint_1024.png"), hint)
    rep["refs"] = refs
    rep["idle"] = {"vram": stats(), "smi": smi()}
    runs = []
    # 1. seconds cold and warm at 1, 4, 16 MP, the Advanced node with its defaults, keep_on_gpu off
    for lab in sizes:
        rep.setdefault("free_before", {})[lab] = free()
        for kind, ref in (("cold", refs[lab]), ("warm", refs[lab + "_flip"])):
            r = await queue(g_advanced(ref), "advanced %s %s" % (lab, kind))
            r["info"] = info_text(r)
            r.pop("outputs", None)
            runs.append(r)
            print(json.dumps({k: r[k] for k in ("label", "wall_s", "server_s", "node_s", "error", "info", "smi_peak_mib")}), flush=True)
    # 2. keep_on_gpu on at 1 MP, then what /free releases
    rep["free_before_keep"] = free()
    for kind, ref in (("cold", refs["1MP"]), ("warm", refs["1MP_flip"])):
        r = await queue(g_advanced(ref, keep=True), "advanced 1MP keep_on_gpu %s" % kind)
        r["info"] = info_text(r)
        r.pop("outputs", None)
        runs.append(r)
        print(json.dumps({k: r[k] for k in ("label", "wall_s", "server_s", "node_s", "error", "info", "smi_peak_mib")}), flush=True)
    time.sleep(3)
    rep["keep_idle"] = {"vram": stats(), "smi": smi()}
    rep["keep_after_unload_models_only"] = free(unload=True, mem=False)
    rep["keep_after_free_memory"] = free(unload=True, mem=True)
    # 3. the Basic node's three outputs read back at 1 MP (rgba: 8-bit? straight?), with the subject hint
    r = await queue(g_basic(refs["1MP"], hint_ref=refs["hint"]), "basic 1MP hint fg/alpha/rgba")
    outs = r["outputs"]
    pngs = {}
    for k in ("out_fg", "out_alpha", "out_rgba"):
        img = (outs.get(k) or {}).get("images", [None])[0]
        if img:
            data = view(img)
            open(os.path.join(work, k + ".png"), "wb").write(data)
            pil = Image.open(io.BytesIO(data))
            pngs[k] = {"file": img, "mode": pil.mode, "size": pil.size, "bits": pil.info.get("bits"), "bytes": len(data),
                       "png_bitdepth": data[24], "png_colortype": data[25]}
    rgba = np.array(Image.open(os.path.join(work, "out_rgba.png")))
    fg = np.array(Image.open(os.path.join(work, "out_fg.png")).convert("RGB"))
    al = np.array(Image.open(os.path.join(work, "out_alpha.png")).convert("L"))
    A = rgba[..., 3].astype(np.int16)
    rgbmax = rgba[..., :3].max(axis=2).astype(np.int16)
    zero = A == 0
    rb = {
        "pngs": pngs,
        "rgba_rgb_eq_fg": int((np.abs(rgba[..., :3].astype(np.int16) - fg.astype(np.int16)).max())),
        "rgba_a_eq_alpha": int(np.abs(A - al.astype(np.int16)).max()),
        "px_rgb_above_alpha_plus2": float((rgbmax > A + 2).mean()),
        "alpha0_px": int(zero.sum()), "alpha0_rgb_mean": float(rgba[..., :3][zero].mean()) if zero.any() else None,
        "alpha_mean": float(A.mean() / 255.0),
    }
    r.pop("outputs", None)
    r["readback"] = rb
    runs.append(r)
    print(json.dumps({"label": r["label"], "wall_s": r["wall_s"], "readback": rb}), flush=True)
    # 4. the polarity of a grey hint through ImageToMask: the subject hint vs its inverse, clean-matte trust
    pol = {}
    m = hint > 127
    for lab, ref in (("subject_white", refs["hint"]), ("inverted", refs["hint_inv"])):
        r = await queue(g_basic(refs["1MP"], hint_ref=ref, outputs=("alpha",)), "basic 1MP polarity " + lab)
        img = (r["outputs"].get("out_alpha") or {}).get("images", [None])[0]
        a = np.array(Image.open(io.BytesIO(view(img))).convert("L")).astype(np.float32) / 255.0
        cv2.imwrite(os.path.join(work, "polarity_%s.png" % lab), (a * 255).astype(np.uint8))
        pol[lab] = {"alpha_mean_inside_hint_white_area": float(a[m].mean()), "alpha_mean_outside": float(a[~m].mean())}
        r.pop("outputs", None)
        r["polarity"] = pol[lab]
        runs.append(r)
        print(json.dumps({"label": r["label"], "wall_s": r["wall_s"], "polarity": pol[lab]}), flush=True)
    rep["polarity"] = pol
    rep["free_end"] = free()
    rep["runs"] = runs
    # delete every prompt this script queued from the history
    post("/history", {"delete": QUEUED})
    left = [p for p in QUEUED if get("/history/" + p).json()]
    rep["history_deleted"] = {"ids": QUEUED, "still_there": left}
    rep["queue_after"] = get("/queue").json()
    rep["end"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    json.dump(rep, open(os.path.join(work, "routeb.json"), "w"), indent=1)
    print("DONE", json.dumps(rep["history_deleted"]))


if __name__ == "__main__":
    if sys.argv[1] == "objectinfo":
        main_objectinfo(sys.argv[2])
    elif sys.argv[1] == "probe":
        asyncio.run(main_probe(sys.argv[2]))
