"""可选真实模型小样本门槛；使用合成视频，CPU有界运行。"""
import io
import json
import os
import time
import zipfile

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import create_app
from test_organizer import ready


@pytest.mark.skipif(os.environ.get('FRAMES_REAL_MATTING') != '1', reason='真实模型需显式启用')
def test_one_frame_real_model_cpu(fixtures, tmp_path):
    assert os.environ.get('FRAMES_MATTING_CPU_ONLY') == '1'
    with TestClient(create_app(tmp_path/'cache')) as client:
        job = ready(client, fixtures['cfr'])
        session = client.post('/api/edit-sessions',json={'jobId':job['id']}).json()
        frame = job['sequence']['frames'][0]
        started = client.post('/api/matting-batches',json={'sessionId':session['id'],'frameIds':[frame['id']]})
        assert started.status_code == 200, started.text
        token = started.json()['id']
        state = None
        for _ in range(360):
            state = client.get(f'/api/matting-batches/{token}').json()
            if state['status'] in ('done','failed','cancelled'):
                break
            time.sleep(.5)
        assert state['status'] == 'done', state
        png = client.get(f"/api/matting-batches/{token}/frames/{frame['id']}/current")
        assert png.status_code == 200
        with Image.open(io.BytesIO(png.content)) as image:
            image.load()
            assert image.mode == 'RGBA' and image.size == (320,180)
        archive = client.get(f'/api/matting-batches/{token}/download')
        assert archive.status_code == 200
        with zipfile.ZipFile(io.BytesIO(archive.content)) as packed:
            manifest=json.loads(packed.read('frame-sequence.json'))
            assert manifest['formatVersion'] == 4 and manifest['frames'][0]['id'] == frame['id']
            assert packed.read(manifest['frames'][0]['image']) == png.content
