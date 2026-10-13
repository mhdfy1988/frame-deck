import copy
import hashlib
import io
import json
import time
import zipfile
from fractions import Fraction
from dataclasses import replace
import pytest
from fastapi.testclient import TestClient
from app.domain import DomainError
from app.main import create_app, ManagedDownload
from app.organizer import edited_manifest
from test_service import upload, wait_job


def ready(client, fixture):
    video = upload(client, fixture)
    job = client.post('/api/jobs', json={'videoId':video['id'],'start':.25,'end':1.25,'fps':12}).json()
    result = wait_job(client, job['id'])
    assert result['status'] == 'done', result
    return result


def test_v3_time_identity_and_immutable_origin():
    sequence = {'formatVersion':2,'id':'parent','name':'片段','canvas':{'width':1,'height':1},'loop':False,
                'source':{'originPts':17},'extraction':{'durationSeconds':'7/30'},
                'frames':[{'id':str(i),'image':str(i),'durationSeconds':duration,'durationMs':float(Fraction(duration)*1000),
                           'sourcePts':i+17,'sampleTimeSeconds':f'{i}/10'} for i,duration in enumerate(['1/10','1/10','1/30'])]}
    before = copy.deepcopy(sequence)
    result = edited_manifest(sequence, ['2','0'], 'derived')
    assert result['durationSeconds'] == '2/15'
    assert [frame['sequenceTimeSeconds'] for frame in result['frames']] == ['0/1','1/30']
    assert [frame['sourcePts'] for frame in result['frames']] == [19,17]
    assert result['originalExtraction'] == sequence['extraction']
    assert 'extraction' not in result
    assert sequence == before
    for ids in [[],['0','0'],['foreign']]:
        with pytest.raises(DomainError): edited_manifest(sequence, ids, 'bad')


def test_real_direct_handoff_export_original_bytes_and_pin(fixtures,tmp_path):
    original_hash = hashlib.sha256(fixtures['cfr'].read_bytes()).hexdigest()
    with TestClient(create_app(tmp_path/'cache')) as client:
        job = ready(client, fixtures['cfr'])
        source_archive = client.get(job['downloadUrl']).content
        session = client.post('/api/edit-sessions', json={'jobId':job['id']}).json()
        assert session['sequence'] == job['sequence']
        store = client.app.state.store
        held_job = store.jobs[job['id']]
        held_job.touched = time.monotonic()-store.limits.ttl_seconds-10
        with store.lock: store._prune()
        assert job['id'] in store.jobs
        ids = [frame['id'] for frame in job['sequence']['frames']]
        order = [ids[8],ids[3],ids[5]]
        response = client.post(f"/api/edit-sessions/{session['id']}/export",json={'frameIds':order})
        assert response.status_code == 200, response.text
        with zipfile.ZipFile(io.BytesIO(source_archive)) as source, zipfile.ZipFile(io.BytesIO(response.content)) as packed:
            data = json.loads(packed.read('frame-sequence.json'))
            assert data['formatVersion'] == 3 and data['durationSeconds'] == '1/4'
            assert [frame['id'] for frame in data['frames']] == order
            for frame in data['frames']:
                original = next(item for item in job['sequence']['frames'] if item['id'] == frame['id'])
                assert packed.read(frame['image']) == source.read(original['image'])
                assert frame['sourcePts'] == original['sourcePts']
                assert frame['durationSeconds'] == original['durationSeconds']
        assert not list(held_job.directory.glob('organized-*.zip'))
        assert client.get('/api/health').json()['busy'] is False
        assert client.get(job['downloadUrl']).content == source_archive
        client.delete(f"/api/edit-sessions/{session['id']}")
        held_job.touched = time.monotonic()-store.limits.ttl_seconds-10
        with store.lock: store._prune()
        assert job['id'] not in store.jobs
    assert hashlib.sha256(fixtures['cfr'].read_bytes()).hexdigest() == original_hash


def test_validation_failure_and_session_lifetime(fixtures,tmp_path):
    with TestClient(create_app(tmp_path/'cache')) as client:
        assert client.post('/api/edit-sessions',json={'jobId':'../escape'}).status_code == 422
        assert client.post('/api/edit-sessions',json={'jobId':'f'*32}).status_code == 404
        job = ready(client, fixtures['cfr'])
        session = client.post('/api/edit-sessions',json={'jobId':job['id']}).json()
        route = f"/api/edit-sessions/{session['id']}/export"
        ids = [frame['id'] for frame in job['sequence']['frames']]
        for data in [{'frameIds':[]},{'frameIds':[ids[0],ids[0]]},{'frameIds':['../bad']},{'frameIds':[ids[0]],'durationSeconds':'999/1'}]:
            assert client.post(route,json=data).status_code in {400,422}
            assert client.get('/api/health').json()['busy'] is False
        store = client.app.state.store
        previous = store.limits
        store.limits = replace(previous,job_bytes=8)
        assert client.post(route,json={'frameIds':[ids[0]]}).status_code == 400
        assert store.busy is None
        assert not list(store.jobs[job['id']].directory.glob('organized-*.zip'))
        store.limits = previous
        assert client.post(f"/api/edit-sessions/{session['id']}/heartbeat").status_code == 200
        store.edit_sessions[session['id']]['touched'] -= previous.ttl_seconds+1
        assert client.post(f"/api/edit-sessions/{session['id']}/heartbeat").status_code == 404


def test_pinned_job_survives_three_new_extractions(fixtures,tmp_path):
    with TestClient(create_app(tmp_path/'cache')) as client:
        job = ready(client,fixtures['cfr'])
        session = client.post('/api/edit-sessions',json={'jobId':job['id']}).json()
        for _ in range(4):
            next_job = client.post('/api/jobs',json=job['request']).json()
            assert wait_job(client,next_job['id'])['status'] == 'done'
        assert client.get(f"/api/jobs/{job['id']}/frames/1").status_code == 200
        assert client.post(f"/api/edit-sessions/{session['id']}/heartbeat").status_code == 200


def test_download_exception_always_cleans(tmp_path):
    import asyncio
    path = tmp_path/'response.zip'
    path.write_bytes(b'zip')
    released = []
    response = ManagedDownload(path, lambda: released.append(True))
    async def failed_send(message):
        raise ConnectionError('client disconnected')
    async def receive():
        return {'type':'http.disconnect'}
    with pytest.raises(ConnectionError):
        asyncio.run(response({'type':'http','method':'GET','headers':[],'asgi':{'spec_version':'2.4'}},receive,failed_send))
    assert released == [True]
