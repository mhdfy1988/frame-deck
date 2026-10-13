"""独立角色抠图：明确背景路由、模型推理、边缘与前景颜色恢复。"""
from __future__ import annotations
from io import BytesIO
import logging
import os
from pathlib import Path
from threading import Lock
import time
import numpy as np
from PIL import Image
from .refinement import refine, background_statistics

MODEL_ID = "ZhengPeng7/BiRefNet_HR-matting"
MODEL_REVISION = "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f"
ROOT = Path(__file__).resolve().parents[1]
LOG = logging.getLogger(__name__)

def select_model(image: Image.Image) -> str:
    rgb = np.asarray(image.convert("RGB"), dtype=np.float64)/255
    background = background_statistics(rgb)
    dark_green = (background.chroma_channel is None and background.uniform
                  and background.color[1] > background.color[0]*1.5
                  and background.color[1] > background.color[2]*1.3)
    # 工具面向游戏插画，默认动漫模型保留关联道具；暗绿精细立绘保留实测更好的 HR。
    # 模型选择不是硬背景约束，是否精修仍由独立的严格背景判定决定。
    return "hr" if dark_green else "toonout"

class GameArtEngine:
    def __init__(self) -> None:
        self._model = None
        self._device = None
        self._model_key = None
        self._lock = Lock()
        self.last_details: dict = {}

    @property
    def ready(self) -> bool:
        return self._model is not None

    def _load(self, key: str = "hr") -> None:
        import torch
        from transformers import AutoModelForImageSegmentation
        if key not in ("hr", "toonout"):
            raise ValueError(f"未知模型路由：{key}")
        directory = ROOT / (".models/birefnet-hr-matting" if key == "hr" else ".models/toonout")
        if not (directory / "model.safetensors").is_file():
            raise RuntimeError(f"缺少 {key} 模型，必须安装指定模型；不会切换其他模型")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if device == "cuda" else torch.float32
        # 仅加载明确安装的版本，不在运行时下载或静默换模型。
        # 6GiB 设备不能同时缓存两套模型；请求串行，先释放上一模型再加载。
        self._model = None
        self._model_key = None
        import gc
        gc.collect()
        if device == "cuda":
            torch.cuda.empty_cache()
        model, loading = AutoModelForImageSegmentation.from_pretrained(str(directory),
            trust_remote_code=True, local_files_only=True, torch_dtype=dtype,
            output_loading_info=True)
        if loading.get("missing_keys") or loading.get("unexpected_keys") or loading.get("mismatched_keys"):
            raise RuntimeError(f"{key} 模型参数不匹配：{loading}")
        self._model = model.to(device=device, dtype=dtype).eval()
        self._device = device
        self._model_key = key

    def predict_alpha(self, image: Image.Image) -> np.ndarray:
        import torch
        from torchvision import transforms
        key = select_model(image)
        if self._model is None or self._model_key != key:
            self._load(key)
        size = 1024 if key == "toonout" else 2048
        tensor = transforms.Compose([transforms.Resize((size, size)),
            transforms.ToTensor(), transforms.Normalize([.485,.456,.406], [.229,.224,.225])])(
                image).unsqueeze(0).to(device=self._device, dtype=next(self._model.parameters()).dtype)
        started = time.perf_counter()
        if self._device == "cuda":
            torch.cuda.reset_peak_memory_stats()
        with torch.inference_mode():
            prediction = self._model(tensor)[-1].sigmoid().float().cpu()
        self._inference_details = {"device": self._device, "model": key, "input_size": size,
            "dtype": str(next(self._model.parameters()).dtype),
            "inference_seconds": round(time.perf_counter()-started,3),
            "peak_cuda_mib": round(torch.cuda.max_memory_allocated()/1024**2,1) if self._device == "cuda" else None}
        alpha = transforms.ToPILImage()(prediction[0].squeeze()).resize(image.size, Image.Resampling.LANCZOS)
        return np.asarray(alpha, dtype=np.float64)/255

    def cutout(self, image: Image.Image, *, postprocess: bool = True) -> bytes:
        with self._lock:
            started = time.perf_counter()
            rgba = image.convert("RGBA")
            if rgba.getextrema()[3][0] < 255:
                output, details = rgba, {"route": "existing-alpha"}
            else:
                source = image.convert("RGB")
                model = self.predict_alpha(source)
                if postprocess:
                    output, details = refine(np.asarray(source, dtype=np.float64)/255, model)
                else:
                    pixels = np.dstack((np.asarray(source), np.round(np.clip(model, 0, 1)*255).astype(np.uint8)))
                    output, details = Image.fromarray(pixels), {"route": "model-only"}
                details.update(self._inference_details)
            details["seconds"] = round(time.perf_counter()-started, 3)
            self.last_details = details
            LOG.info("cutout %s", details)
            buffer = BytesIO()
            output.save(buffer, format="PNG")
            return buffer.getvalue()
