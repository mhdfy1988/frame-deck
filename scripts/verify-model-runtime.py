"""仅用独立环境校验两套模型加载，校验成功才写就绪标记。"""
import hashlib
import json
import os
from pathlib import Path
import sys
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'model-runtime'))
from app.engine import GameArtEngine

if sys.argv[1] == 'cu128' and not torch.cuda.is_available():
    raise RuntimeError('NVIDIA/CUDA不可用，请检查驱动，或明确设置FRAMEDECK_TORCH_PROFILE=cpu重试')
engine = GameArtEngine()
for key in ('toonout', 'hr'):
    engine._load(key)
files = {}
for directory in (ROOT / 'model-runtime/.models/toonout', ROOT / 'model-runtime/.models/birefnet-hr-matting'):
    for file in directory.iterdir():
        if file.is_file() and file.suffix in {'.py', '.json', '.safetensors'}:
            with file.open('rb') as stream:
                files[file.relative_to(ROOT).as_posix()] = hashlib.file_digest(stream, 'sha256').hexdigest()
marker = ROOT / '.runtime/model-ready.json'
temporary = marker.with_suffix('.tmp')
temporary.write_text(json.dumps({'formatVersion': 1, 'profile': sys.argv[1], 'files': files}, indent=2), encoding='utf-8')
os.replace(temporary, marker)
