"""从固定公开缓存建立本项目 ToonOut 模型；不下载，不依赖旧应用。"""
from pathlib import Path
import hashlib
import json
import shutil
import torch
from safetensors.torch import save_file

ROOT = Path(__file__).resolve().parents[1]
BASE_REVISION = "e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4"
TOON_REVISION = "cbf720eca394edcde66b861a8a8c20fbabe9c748"


def main():
    from huggingface_hub.constants import HF_HUB_CACHE
    cache = Path(HF_HUB_CACHE)
    base = cache/"models--ZhengPeng7--BiRefNet/snapshots"/BASE_REVISION
    checkpoint = cache/"models--joelseytre--toonout/snapshots"/TOON_REVISION/"birefnet_finetuned_toonout.pth"
    target = ROOT/".models/toonout"
    target.mkdir(exist_ok=True)
    state = torch.load(checkpoint,map_location="cpu",weights_only=True)
    clean = {}
    for key,value in state.items():
        if key.startswith("module._orig_mod."):
            key = key[len("module._orig_mod."):]
        elif key.startswith("module."):
            key = key[len("module."):]
        clean[key] = value.to(dtype=torch.float16).contiguous() if value.is_floating_point() else value.contiguous()
    save_file(clean,str(target/"model.safetensors"),metadata={"format":"pt"})
    for name in ("BiRefNet_config.py","birefnet.py","config.json"):
        shutil.copyfile(base/name,target/name)
    provenance = {"base_revision":BASE_REVISION,"toonout_revision":TOON_REVISION,
                  "model_source":"https://huggingface.co/joelseytre/toonout",
                  "license":"MIT (model card); retain author attribution before redistribution",
                  "conversion":"prefix cleanup and FP16, same runtime precision as isolated baseline",
                  "source_sha256":hashlib.file_digest(checkpoint.open("rb"),"sha256").hexdigest(),
                  "local_sha256":hashlib.file_digest((target/"model.safetensors").open("rb"),"sha256").hexdigest()}
    (target/"provenance.json").write_text(json.dumps(provenance,indent=2),encoding="utf-8")
    print(json.dumps(provenance),flush=True)


if __name__ == "__main__":
    main()
