import io
import json
import zipfile
from PIL import Image
from fastapi.testclient import TestClient
from app.main import create_app
from app.export_frames import ExportSettings, transform
from test_organizer import ready
from test_batch_matting import settled
from synthetic_matting import Shapes


def test_export_crop_preview_zip_sheet_repair_and_source_immutable(fixtures,tmp_path):
    with TestClient(create_app(tmp_path/'cache')) as client:
        job=ready(client,fixtures['cfr']);session=client.post('/api/edit-sessions',json={'jobId':job['id']}).json()
        ids=[frame['id'] for frame in job['sequence']['frames']][:3]
        client.app.state.store.batches.model_factory=Shapes
        batch=settled(client,client.post('/api/matting-batches',json={'sessionId':session['id'],'frameIds':ids}).json()['id'])
        ids=ids[::-1];source={'batchId':batch['id'],'frameIds':ids,'revisions':{key:0 for key in ids}}
        analyzed=client.post('/api/export/analyze',json=source)
        assert analyzed.status_code==200,analyzed.text
        assert analyzed.json()['bounds']==[5,10,39,50]
        request={**source,'crop':[5,10,34,40],'width':64,'height':64,'filter':'pixel','format':'sequence','columns':2,'name':'跑步','fps':15}
        originals=[client.get(f"/api/matting-batches/{batch['id']}/frames/{key}/current").content for key in ids]
        response=client.post('/api/export/download',json=request)
        assert response.status_code==200,response.text
        with zipfile.ZipFile(io.BytesIO(response.content)) as packed:
            data=json.loads(packed.read('frame-sequence.json'))
            assert data['formatVersion']==6 and [f['id'] for f in data['frames']]==ids
            assert data['playback']['fps']==15 and data['playback']['frameDuration']=={'numerator':1,'denominator':15}
            images=[Image.open(io.BytesIO(packed.read(f['image']))).convert('RGBA') for f in data['frames']]
        for i,image in enumerate(images):
            expected=transform(Image.open(io.BytesIO(originals[i])),ExportSettings(**request))
            assert image.size==(64,64) and image.tobytes()==expected.tobytes()
            preview=client.post('/api/export/preview',json={**request,'index':i})
            assert Image.open(io.BytesIO(preview.content)).tobytes()==image.tobytes()
        sheet=client.post('/api/export/download',json={**request,'format':'sheet'})
        assert sheet.status_code==200 and sheet.headers['content-type']=='application/zip'
        with zipfile.ZipFile(io.BytesIO(sheet.content)) as packed:
            assert set(packed.namelist())=={'sheet.png','sheet.json'}
            metadata=json.loads(packed.read('sheet.json'))
            assert metadata['columns']==2 and metadata['rows']==2 and metadata['playback']['fps']==15
            assert [f['source']['id'] for f in metadata['frames']]==ids
            assert metadata['frames'][2]['rect']=={'x':0,'y':64,'width':64,'height':64}
            im=Image.open(io.BytesIO(packed.read('sheet.png'))).convert('RGBA')
        assert im.size==(128,128)
        full_preview=client.post('/api/export/preview',json={**request,'format':'sheet','index':0,'view':'sheet'})
        assert full_preview.status_code==200 and Image.open(io.BytesIO(full_preview.content)).tobytes()==im.tobytes()
        for i,image in enumerate(images):
            x=(i%2)*64;y=(i//2)*64
            assert im.crop((x,y,x+64,y+64)).tobytes()==image.tobytes()
        assert im.crop((64,64,128,128)).getchannel('A').getbbox() is None
        for key,original in zip(ids,originals):assert client.get(f"/api/matting-batches/{batch['id']}/frames/{key}/current").content==original
        stale={**request,'revisions':{key:1 for key in ids}}
        assert client.post('/api/export/download',json=stale).status_code==400
        assert client.post('/api/export/download',json={**request,'format':'sheet','width':8192,'height':8192}).status_code==400
        assert client.post('/api/export/preview',json={**request,'crop':[-1,0,1,1],'index':0}).status_code==400
        assert client.post('/api/export/download',json={**request,'name':'../evil'}).status_code==422
        assert client.post('/api/export/download',json={**request,'fps':0}).status_code==422
        assert client.post('/api/export/preview',json={**request,'view':'sheet','index':0}).status_code==400
        repaired=Image.open(io.BytesIO(originals[0])).convert('RGBA');repaired.putpixel((120,90),(50,80,100,200));buffer=io.BytesIO();repaired.save(buffer,format='PNG')
        response=client.put(f"/api/matting-batches/{batch['id']}/frames/{ids[0]}?revision=0",content=buffer.getvalue(),headers={'Content-Type':'image/png'})
        assert response.status_code==200,response.text
        assert client.post('/api/export/analyze',json=source).status_code==400
        fresh={**source,'revisions':{key:int(key==ids[0]) for key in ids}}
        assert client.post('/api/export/analyze',json=fresh).json()['bounds']==[5,10,121,91]
        assert not list((tmp_path/'cache').glob('export-*'))
        assert client.get('/api/health').json()['busy'] is False


def test_rgba_no_double_alpha_and_uniform_position():
    base={'batchId':'a'*32,'frameIds':['f'],'revisions':{'f':0},'crop':[0,0,8,4],'width':8,'height':8}
    im=Image.new('RGBA',(8,4));im.putpixel((2,1),(200,50,30,128))
    result=transform(im,ExportSettings(**base))
    assert result.getpixel((2,3))==(200,50,30,128)
    assert result.getchannel('A').getbbox()==(2,3,3,4)
    assert transform(im,ExportSettings(**{**base,'width':4,'height':4})).size==(4,4)
