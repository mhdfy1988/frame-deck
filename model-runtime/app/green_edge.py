"""已知均匀亮绿的软边学习步骤；不扩展到域外或替换基础模型。"""
import hashlib
from pathlib import Path
import numpy as np
from pymatting import estimate_foreground_ml
from .green_foreground import refine_green_foreground

WEIGHT_SHA256='b4916139bdba814992c0fa984fe645c76d9f02578b7e502b541210ec262fe30b'
_model=None


def load_model():
    global _model
    if _model is None:
        from safetensors.torch import load_file
        import torch
        from .green_edge_model import GreenPatchRefiner
        path=Path(__file__).resolve().parents[1]/'.models/green-edge-refiner/model.safetensors'
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=WEIGHT_SHA256:
            raise RuntimeError('绿幕软边模型缺失或哈希不符，不静默跳过')
        torch.set_num_threads(4)
        model=GreenPatchRefiner()
        model.load_state_dict(load_file(str(path)),strict=True)
        _model=model.eval()
    return _model


def refine_green_edges(rgb,pixels,background,unknown):
    from .green_edge_model import tiled_predict,conservative_soft_alpha
    coarse=pixels[...,3]/255.
    selected=unknown&(coarse>0)&(coarse<1)
    if not selected.any():
        return pixels.copy(),0
    predicted=tiled_predict(load_model(),rgb,background,coarse,selected)
    alpha=conservative_soft_alpha(coarse,predicted)
    result=pixels.copy()
    result[...,3]=np.round(alpha*255).astype(np.uint8)
    changed=result[...,3]!=pixels[...,3]
    if not changed.any():
        return result,0
    foreground=estimate_foreground_ml(rgb,result[...,3]/255.)
    result[changed,:3]=np.round(np.clip(foreground[changed],0,1)*255).astype(np.uint8)
    opaque=result[...,3]==255
    result[opaque,:3]=np.round(rgb[opaque]*255).astype(np.uint8)
    result,_=refine_green_foreground(rgb,result,background,changed)
    return result,int(changed.sum())
