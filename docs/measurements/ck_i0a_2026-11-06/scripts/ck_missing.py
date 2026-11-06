"""Ask pack A's own paths.py (loaded by file, no package import) which assets are missing under models/corridorkey2."""
import importlib.util
import sys
from pathlib import Path

pack, root = Path(sys.argv[1]), Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("ck_paths_probe", pack / "ck_comfy" / "paths.py")
mod = importlib.util.module_from_spec(spec)
sys.modules["ck_paths_probe"] = mod
spec.loader.exec_module(mod)
a = mod.AssetPaths.under(root)
print("missing:", [str(p) for p in a.missing()])
for p in (a.weights, a.foundation_stats, a.cradio_dir / "hf_model.py", a.cradio_dir / "model.safetensors", a.moge_checkpoint, a.rvm_ckpt):
    print(p.is_file(), p)
