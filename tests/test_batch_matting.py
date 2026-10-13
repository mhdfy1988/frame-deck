"""批量接口契约：复用有序帧、原子结果、人工像素与失败/取消。"""
import io
import json
import threading
import time
import zipfile

from fastapi.testclient import TestClient
from PIL import Image

from app.domain import DomainError
from app.main import create_app
from test_organizer import ready


class FakeRunner:
    def __init__(self, fail=False, wait=False):
        self.fail = fail
        self.wait = wait
        self.stopped = threading.Event()
        self.entered = threading.Event()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.stop()

    def stop(self):
        self.stopped.set()

    def cutout(self, source, target, batch):
        self.entered.set()
        if self.wait:
            self.stopped.wait(4)
            if batch.cancel.is_set():
                from app.batch_matting import BatchCancelled
                raise BatchCancelled()
        if self.fail:
            raise DomainError("合成模型失败")
        with Image.open(source) as image:
            rgba = image.convert('RGBA')
            rgba.putalpha(180)
            rgba.save(target, format='PNG')
        return 'synthetic-test'


def settled(client, token):
    for _ in range(160):
        state = client.get(f'/api/matting-batches/{token}').json()
        if state['status'] in {'done', 'failed', 'cancelled'}:
            return state
        time.sleep(.05)
    raise AssertionError('batch did not finish')


def test_batch_identity_repair_export_and_immutable_source(fixtures, tmp_path):
    with TestClient(create_app(tmp_path/'cache')) as client:
        original = ready(client, fixtures['cfr'])
        session = client.post('/api/edit-sessions', json={'jobId': original['id']}).json()
        ids = [frame['id'] for frame in original['sequence']['frames']]
        chosen = [ids[5], ids[1], ids[8]]
        client.app.state.store.batches.model_factory = FakeRunner
        response = client.post('/api/matting-batches', json={'sessionId':session['id'], 'frameIds':chosen})
        assert response.status_code == 200, response.text
        batch = settled(client, response.json()['id'])
        assert batch['status'] == 'done' and batch['completed'] == 3
        sequence = batch['sequence']
        assert sequence['formatVersion'] == 4 and [frame['id'] for frame in sequence['frames']] == chosen
        assert sequence['durationSeconds'] == '1/4'
        assert [frame['sourcePts'] for frame in sequence['frames']] == [original['sequence']['frames'][i]['sourcePts'] for i in (5,1,8)]
        token = batch['id']; key = chosen[0]
        path = f'/api/matting-batches/{token}/frames/{key}'
        source = client.get(path+'/source').content
        auto = client.get(path+'/auto').content
        with Image.open(io.BytesIO(auto)) as image:
            assert image.mode == 'RGBA' and image.getchannel('A').getextrema() == (180, 180)
            edited = image.copy()
            edited.putpixel((0, 0), (1, 2, 3, 0))
            bytes_out = io.BytesIO(); edited.save(bytes_out, format='PNG')
        saved = client.put(path+'?revision=0', content=bytes_out.getvalue(), headers={'Content-Type':'image/png'})
        assert saved.status_code == 200 and saved.json()['revision'] == 1
        assert client.put(path+'?revision=0', content=bytes_out.getvalue(), headers={'Content-Type':'image/png'}).status_code == 400
        assert client.get(path+'/source').content == source
        assert client.get(path+'/auto').content == auto
        assert client.get(path+'/current').content == bytes_out.getvalue()
        archive = client.get(f'/api/matting-batches/{token}/download')
        assert archive.status_code == 200
        with zipfile.ZipFile(io.BytesIO(archive.content)) as packed:
            exported = json.loads(packed.read('frame-sequence.json'))
            assert exported['derivation']['manualFrameIds'] == [key]
            assert packed.read(exported['frames'][0]['image']) == bytes_out.getvalue()
            assert [frame['id'] for frame in exported['frames']] == chosen
        assert client.app.state.store.busy is None


def test_failure_and_cancel_do_not_publish_partial_result(fixtures, tmp_path):
    with TestClient(create_app(tmp_path/'cache')) as client:
        original = ready(client, fixtures['cfr'])
        session = client.post('/api/edit-sessions', json={'jobId':original['id']}).json()
        ids = [frame['id'] for frame in original['sequence']['frames'][:2]]
        manager = client.app.state.store.batches
        manager.model_factory = lambda: FakeRunner(fail=True)
        started = client.post('/api/matting-batches',json={'sessionId':session['id'],'frameIds':ids}).json()
        failed = settled(client, started['id'])
        assert failed['status'] == 'failed' and failed['failedFrameId'] == ids[0]
        assert failed['sequence'] is None
        assert client.get(f"/api/matting-batches/{started['id']}/frames/{ids[0]}/current").status_code == 400
        assert client.get(f"/api/jobs/{original['id']}").json()['status'] == 'done'
        runner = FakeRunner(wait=True)
        manager.model_factory = lambda: runner
        retry = client.post('/api/matting-batches',json={'sessionId':session['id'],'frameIds':ids}).json()
        assert runner.entered.wait(5)
        cancelled = client.post(f"/api/matting-batches/{retry['id']}/cancel")
        assert cancelled.status_code == 200
        state = settled(client, retry['id'])
        assert state['status'] == 'cancelled' and state['sequence'] is None
        assert runner.stopped.is_set()


def test_reorder_after_matting_and_restore_missing_frame_without_recutting_saved_frames(fixtures, tmp_path):
    with TestClient(create_app(tmp_path/'cache')) as client:
        job = ready(client, fixtures['cfr'])
        session = client.post('/api/edit-sessions', json={'jobId': job['id']}).json()
        ids = [frame['id'] for frame in job['sequence']['frames'][:3]]
        calls = []

        class CountingRunner(FakeRunner):
            def cutout(self, source, target, batch):
                calls.append(source.name)
                return super().cutout(source, target, batch)

        client.app.state.store.batches.model_factory = CountingRunner
        first = client.post('/api/matting-batches', json={'sessionId': session['id'], 'frameIds': ids[:2]}).json()
        assert settled(client, first['id'])['status'] == 'done'
        assert len(calls) == 2
        current = f"/api/matting-batches/{first['id']}/frames/{ids[0]}/current"
        with Image.open(io.BytesIO(client.get(current).content)) as image:
            changed = image.copy()
            changed.putpixel((0, 0), (4, 5, 6, 0))
            out = io.BytesIO()
            changed.save(out, format='PNG')
        assert client.put(current.rsplit('/current', 1)[0]+'?revision=0', content=out.getvalue(), headers={'Content-Type':'image/png'}).status_code == 200
        rearranged = client.post(f"/api/matting-batches/{first['id']}/download", json={'frameIds':[ids[1], ids[0]]})
        assert rearranged.status_code == 200
        with zipfile.ZipFile(io.BytesIO(rearranged.content)) as packed:
            manifest = json.loads(packed.read('frame-sequence.json'))
            assert [frame['id'] for frame in manifest['frames']] == [ids[1], ids[0]]
            assert manifest['derivation']['manualFrameIds'] == [ids[0]]
            assert packed.read(manifest['frames'][1]['image']) == out.getvalue()
        client.app.state.store.batches.get(first['id']).manifest['derivation']['processingPolicy']='refined-old'
        rejected=client.post('/api/matting-batches',json={'sessionId':session['id'],'frameIds':ids,'parentBatchId':first['id']})
        assert rejected.status_code==400 and '不同处理方式' in rejected.json()['detail']
        assert client.app.state.store.busy is None
        client.app.state.store.batches.get(first['id']).manifest['derivation']['processingPolicy']='model-local-despill-v1'
        assert client.post(f"/api/matting-batches/{first['id']}/download", json={'frameIds':ids}).status_code == 400
        second = client.post('/api/matting-batches', json={'sessionId':session['id'], 'frameIds':[ids[2], ids[0], ids[1]], 'parentBatchId':first['id']}).json()
        done = settled(client, second['id'])
        assert done['status'] == 'done' and len(calls) == 3
        assert done['revisions'][ids[0]] == 1 and ids[0] in done['modifiedFrameIds']
        assert client.get(f"/api/matting-batches/{second['id']}/frames/{ids[0]}/current").content == out.getvalue()
        final = client.post(f"/api/matting-batches/{second['id']}/download", json={'frameIds':[ids[2],ids[0]]})
        assert final.status_code == 200
        with zipfile.ZipFile(io.BytesIO(final.content)) as packed:
            manifest = json.loads(packed.read('frame-sequence.json'))
            assert [frame['id'] for frame in manifest['frames']] == [ids[2],ids[0]]
            assert manifest['durationSeconds'] == '1/6'
            assert packed.read(manifest['frames'][1]['image']) == out.getvalue()
