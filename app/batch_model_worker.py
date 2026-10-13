"""独立进程适配现有单图引擎；标准输出只承载逐帧协议。"""
import json
import sys
import os
from io import BytesIO
from pathlib import Path
from PIL import Image
import torch

# 批量模型的CPU算子保持有界，并统一离线比较与正式运行的线程设置。
torch.set_num_threads(4)

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
from app.engine import GameArtEngine  # noqa: E402
from app.green_despill import local_green_despill
from app.refinement import background_statistics
import numpy as np

engine = GameArtEngine()
for line in sys.stdin:
    try:
        request = json.loads(line)
        with Image.open(request["source"]) as source:
            source.load()
            output = engine.cutout(source, postprocess=False)
            pixels=np.asarray(Image.open(BytesIO(output)).convert('RGBA'))
            background=background_statistics(np.asarray(source.convert('RGB'),dtype=float)/255)
            if engine.last_details['route']!='existing-alpha' and background.uniform and background.chroma_channel==1:
                pixels,despill=local_green_despill(pixels,os.environ.get('FRAMES_FFMPEG','ffmpeg'))
                buffer=BytesIO();Image.fromarray(pixels).save(buffer,format='PNG');output=buffer.getvalue()
                engine.last_details['despill']=despill
                engine.last_details['route']='model-local-despill'
            else:
                reason='existing-alpha' if engine.last_details['route']=='existing-alpha' else 'not-uniform-bright-green'
                engine.last_details['despill']={'method':'ffmpeg-local-despill-v1','skip_reason':reason}
            Path(request["target"]).write_bytes(output)
        response = {"ok": True, "model": engine.last_details.get("model", engine.last_details.get("route", "existing-alpha")),
                    "details": engine.last_details}
    except Exception as exc:
        response = {"ok": False, "error": str(exc)[:240]}
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()
