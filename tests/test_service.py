import hashlib
import io
import json
import time
import zipfile
from dataclasses import replace
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from app.config import LIMITS
from app.domain import DomainError, ExtractionRequest
from app.main import create_app
from app.service import Store


def upload(client,path):
    from urllib.parse import quote
    response=client.post('/api/videos',content=path.read_bytes(),headers={'X-File-Name':quote(path.name)})
    assert response.status_code==200,response.text
    return response.json()


def wait_job(client,token):
    for _ in range(300):
        response=client.get(f'/api/jobs/{token}')
        assert response.status_code==200,response.text
        job=response.json()
        if job['status'] in {'done','cancelled','failed'}:return job
        time.sleep(.02)
    raise AssertionError('job did not finish')


def test_real_api_zip_and_range(fixtures,tmp_path):
    original=hashlib.sha256(fixtures['cfr'].read_bytes()).hexdigest()
    with TestClient(create_app(tmp_path/'cache')) as client:
        video=upload(client,fixtures['cfr'])
        assert video['sourceFrameCount']==48
        assert client.get(video['url'],headers={'Range':'bytes=0-31'}).status_code==206
        response=client.post('/api/jobs',json={'videoId':video['id'],'start':.25,'end':1.25,'fps':12})
        assert response.status_code==200,response.text
        job=wait_job(client,response.json()['id'])
        assert job['status']=='done',job
        assert len(job['sequence']['frames'])==12
        archive=client.get(job['downloadUrl'])
        with zipfile.ZipFile(io.BytesIO(archive.content)) as packed:
            assert len(packed.namelist())==13 and packed.testzip() is None
            data=json.loads(packed.read('frame-sequence.json'))
            assert data==job['sequence']
            assert data['frames'][0]['sourceFrameIndex']==6
            assert data['frames'][-1]['sourceFrameIndex']==28
            assert data['source']['sha256']==original
            for frame in data['frames']:
                with Image.open(io.BytesIO(packed.read(frame['image']))) as image:
                    image.load();assert image.size==(320,180)
        assert client.get(f"/api/jobs/{job['id']}/frames/1?thumb=true").headers['content-type']=='image/jpeg'
        legacy=client.get(f"/api/jobs/{job['id']}/legacy-v1").json()
        assert sum(frame['durationMs'] for frame in legacy['frames'])==1000
        assert client.post('/api/jobs',json={'videoId':video['id'],'start':1,'end':0,'fps':12}).status_code==422
        assert client.get(job['downloadUrl']).content==archive.content
        assert client.get(f"/api/jobs/{job['id']}/frames/0").status_code==400
        assert client.get('/api/videos/unknown/source').status_code==404
    assert hashlib.sha256(fixtures['cfr'].read_bytes()).hexdigest()==original


def test_cancel_and_repeat_conflict(fixtures,tmp_path,monkeypatch):
    import app.service as service
    def slow_decode(path,video,indices,destination,cancel,timeout,monitor,limits):
        for _ in range(200):
            monitor();time.sleep(.01)
        raise AssertionError('cancel did not reach guard')
    monkeypatch.setattr(service,'decode_selected',slow_decode)
    with TestClient(create_app(tmp_path/'cache')) as client:
        video=upload(client,fixtures['cfr'])
        request={'videoId':video['id'],'start':0,'end':1,'fps':12}
        job=client.post('/api/jobs',json=request).json()
        assert client.post('/api/jobs',json=request).status_code==400
        cancel=client.post(f"/api/jobs/{job['id']}/cancel").json()
        assert cancel['status']=='cancelling'
        final=wait_job(client,job['id'])
        assert final['status']=='cancelled'
        assert not (tmp_path/'cache'/f"job-{job['id']}"/'staging').exists()
        assert client.get(f"/api/jobs/{job['id']}/download").status_code==400
        assert client.get('/api/health').json()['busy'] is False


def test_rejections_and_origin(tmp_path):
    limits=replace(LIMITS,upload_bytes=8)
    with TestClient(create_app(tmp_path/'cache',limits)) as client:
        assert client.post('/api/videos',content=b'123456789',headers={'X-File-Name':'x.mp4'}).status_code==413
        assert client.post('/api/videos',content=b'broken',headers={'X-File-Name':'x.mp4'}).status_code==400
        assert client.post('/api/videos',content=b'',headers={'X-File-Name':'x.mp4'}).status_code==400
        assert client.post('/api/videos',content=b'a',headers={'X-File-Name':'x.jpg'}).status_code==400
        assert client.get('/api/health',headers={'Host':'attacker.example'}).status_code==403
        assert client.post('/api/jobs',json={},headers={'Origin':'https://attacker.example'}).status_code==403
        assert client.get('/api/health').json()['busy'] is False
        assert not list((tmp_path/'cache').glob('video-*'))


def test_job_quota_failure_preserves_complete(fixtures,tmp_path,monkeypatch):
    import app.service as service
    with TestClient(create_app(tmp_path/'cache')) as client:
        video=upload(client,fixtures['cfr']);request={'videoId':video['id'],'start':0,'end':1,'fps':12}
        good=wait_job(client,client.post('/api/jobs',json=request).json()['id'])
        archive=client.get(good['downloadUrl']).content
        def fail(*args,**kwargs):raise DomainError('测试解码失败')
        monkeypatch.setattr(service,'decode_selected',fail)
        for _ in range(4):
            failed=wait_job(client,client.post('/api/jobs',json=request).json()['id'])
            assert failed['status']=='failed'
        assert client.get(good['downloadUrl']).content==archive
        assert len(client.app.state.store.jobs)==3


def test_cache_ownership_and_cleanup(tmp_path):
    root=tmp_path/'cache';root.mkdir();(root/'user.txt').write_text('keep')
    with pytest.raises(DomainError,match='未知文件'):Store(root)
    assert (root/'user.txt').read_text()=='keep'
    safe=tmp_path/'safe';store=Store(safe)
    foreign=safe/'user-dir';foreign.mkdir();(foreign/'keep').write_text('keep')
    allocated=safe/('job-'+'a'*32);allocated.mkdir();(allocated/'partial').write_text('partial')
    Store(safe)
    assert not allocated.exists() and (foreign/'keep').exists()


def test_disk_budget_stops_and_removes_partial(fixtures,tmp_path):
    limits=replace(LIMITS,job_bytes=1000)
    with TestClient(create_app(tmp_path/'cache',limits)) as client:
        video=upload(client,fixtures['cfr'])
        response=client.post('/api/jobs',json={'videoId':video['id'],'start':0,'end':1,'fps':12})
        job=wait_job(client,response.json()['id'])
        assert job['status']=='failed' and '配额' in job['error']
        assert not (tmp_path/'cache'/f"job-{job['id']}"/'staging').exists()
        assert client.get('/api/health').json()['busy'] is False


def test_offset_preview_preserves_source_and_export(fixtures,tmp_path):
    from app.media import probe
    with TestClient(create_app(tmp_path/'cache')) as client:
        video=upload(client,fixtures['offset'])
        assert video['normalizedPreview'] and video['originPts'] != 0
        asset=client.app.state.store.asset(video['id'])
        preview=probe(asset.preview_path)
        assert preview.origin_pts==0 and preview.duration==asset.video.duration
        assert asset.path.read_bytes()==fixtures['offset'].read_bytes()
        job=wait_job(client,client.post('/api/jobs',json={'videoId':video['id'],'start':.25,'end':1.25,'fps':12}).json()['id'])
        assert job['status']=='done' and job['sequence']['source']['originPts']==video['originPts']
        assert job['sequence']['frames'][0]['sourceFrameIndex']==6


def test_allocation_failure_releases_busy(fixtures,tmp_path,monkeypatch):
    store=Store(tmp_path/'cache')
    token,name,directory,path=store.begin_upload(fixtures['cfr'].name)
    path.write_bytes(fixtures['cfr'].read_bytes())
    asset=store.finish_upload(token,name,directory,path,'test')
    original=Path.mkdir
    def fail_job_directory(self,*args,**kwargs):
        if self.name.startswith('job-'):raise OSError('allocation failure')
        return original(self,*args,**kwargs)
    monkeypatch.setattr(Path,'mkdir',fail_job_directory)
    with pytest.raises(OSError,match='allocation failure'):
        store.start(ExtractionRequest(videoId=asset['id'],start=0,end=1,fps=12))
    assert store.busy is None and not store.jobs
