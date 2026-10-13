"""统一裁剪/缩放导出；与抠图核心隔离，原始及精修PNG只读。"""
import io
import json
import math
import time
import uuid
import zipfile
from copy import deepcopy
from typing import Literal
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field
from .domain import DomainError
from .media import directory_bytes


class ExportSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    batchId: str = Field(pattern=r"^[a-f0-9]{32}$")
    frameIds: list[str] = Field(min_length=1, max_length=600)
    revisions: dict[str, int]


class ExportSettings(ExportSource):
    crop: tuple[int, int, int, int]
    width: int = Field(ge=1, le=8192, strict=True)
    height: int = Field(ge=1, le=8192, strict=True)
    upscale: bool = False
    filter: Literal["smooth", "pixel"] = "smooth"
    format: Literal["sequence", "sheet"] = "sequence"
    columns: int = Field(default=4, ge=1, le=600, strict=True)
    fps: int = Field(default=12, ge=1, le=60, strict=True)
    name: str = Field(default="animation", min_length=1, max_length=80, pattern=r"^[^\\/:*?\"<>|\x00-\x1f]+$")


class PreviewSettings(ExportSettings):
    index: int = Field(ge=0, le=599, strict=True)
    view: Literal['frame', 'sheet'] = 'frame'


def sheet_layout(settings, count):
    cols = min(settings.columns, count)
    rows = math.ceil(count/cols)
    size = (settings.width*cols, settings.height*rows)
    if max(size)>8192 or math.prod(size)>16_000_000:
        raise DomainError('图集超过8192边长或1600万像素，请降低单帧尺寸或调整列数')
    return cols, rows, size


def compose_sheet(store, batch, frames, settings):
    cols, _, size = sheet_layout(settings, len(frames))
    sheet = Image.new('RGBA', size)
    deadline = time.monotonic()+120
    for index, frame in enumerate(frames):
        if time.monotonic()>deadline:raise DomainError('图集处理超过120秒')
        with Image.open(store.batches.frame_file(batch.id,frame['id'],'current')) as image:
            output = transform(image, settings)
        # 原样复制RGBA，不能再以自身Alpha作为遮罩。
        sheet.paste(output, ((index%cols)*settings.width, (index//cols)*settings.height))
    return sheet


def layout(settings, count, canvas):
    x, y, w, h = settings.crop
    if min(x, y) < 0 or min(w, h) < 1 or x+w > canvas['width'] or y+h > canvas['height']:
        raise DomainError("裁剪范围必须在原画布内")
    if settings.width * settings.height > 16_000_000:
        raise DomainError("单帧超过1600万像素，请降低尺寸")
    if settings.width * settings.height * count * 4 > 2 * 1024**3:
        raise DomainError("序列RGBA超过2GiB，请降低尺寸或减少帧数")
    scale = min(settings.width/w, settings.height/h)
    if not settings.upscale:
        scale = min(scale, 1)
    rw, rh = max(1, round(w*scale)), max(1, round(h*scale))
    return rw, rh, (settings.width-rw)//2, (settings.height-rh)//2


def transform(image, settings):
    rw, rh, dx, dy = layout(settings, 1, {'width':image.width, 'height':image.height})
    x, y, w, h = settings.crop
    cropped = image.convert('RGBA').crop((x, y, x+w, y+h))
    if cropped.size != (rw, rh):
        cropped = cropped.resize((rw, rh), Image.Resampling.NEAREST if settings.filter=='pixel' else Image.Resampling.LANCZOS)
    result = Image.new('RGBA', (settings.width, settings.height))
    # 无mask复制，保留RGBA精确值；不能重复乘Alpha。
    result.paste(cropped, (dx, dy))
    return result


def source(store, settings):
    batch = store.batches.get(settings.batchId, done=True)
    ids = settings.frameIds
    if len(set(ids)) != len(ids) or any(key not in batch.revisions for key in ids):
        raise DomainError("导出帧集合不存在或重复")
    if settings.revisions != {key:batch.revisions[key] for key in ids}:
        raise DomainError("精修结果已更新，请重新打开导出")
    by_id = {frame['id']:frame for frame in batch.manifest['frames']}
    return batch, [deepcopy(by_id[key]) for key in ids]


def analyze(store, settings):
    token=uuid.uuid4().hex
    store._reserve(token)
    try:
        batch, frames=source(store,settings)
        bbox=None; deadline=time.monotonic()+120
        for frame in frames:
            if time.monotonic()>deadline:raise DomainError("整组范围计算超时")
            with Image.open(store.batches.frame_file(batch.id,frame['id'],'current')) as image:
                box=image.convert('RGBA').getchannel('A').getbbox()
            if box:
                bbox=box if bbox is None else (min(bbox[0],box[0]),min(bbox[1],box[1]),max(bbox[2],box[2]),max(bbox[3],box[3]))
        return {'exportVersion':6,'canvas':batch.manifest['canvas'],'bounds':list(bbox) if bbox else None,'count':len(frames)}
    finally:
        with store.lock:
            if store.busy==token:store.busy=None


def preview(store, settings):
    token=uuid.uuid4().hex
    store._reserve(token)
    try:
        batch,frames=source(store,settings)
        layout(settings,len(frames),batch.manifest['canvas'])
        if settings.index>=len(frames):raise DomainError("预览帧不存在")
        if settings.view=='sheet':
            if settings.format!='sheet':raise DomainError('请先选择精灵图集格式')
            output=compose_sheet(store,batch,frames,settings)
        else:
            with Image.open(store.batches.frame_file(batch.id,frames[settings.index]['id'],'current')) as image:
                output=transform(image,settings)
        buffer=io.BytesIO();output.save(buffer,format='PNG')
        return buffer.getvalue()
    finally:
        with store.lock:
            if store.busy==token:store.busy=None


def export(store, settings):
    token=uuid.uuid4().hex
    store._reserve(token)
    directory=store.root/f'export-{token}'
    try:
        batch,frames=source(store,settings)
        geometry=layout(settings,len(frames),batch.manifest['canvas'])
        if settings.format=='sheet':cols,rows,sheet_size=sheet_layout(settings,len(frames))
        directory.mkdir();deadline=time.monotonic()+120
        available=store.limits.cache_bytes-directory_bytes(store.root)
        path=directory/'asset.zip'
        playback={'fps':settings.fps,'frameCount':len(frames),'frameDuration':{'numerator':1,'denominator':settings.fps},'duration':{'numerator':len(frames),'denominator':settings.fps}}
        sheet=compose_sheet(store,batch,frames,settings) if settings.format=='sheet' else None
        archive=zipfile.ZipFile(path,'w',zipfile.ZIP_STORED)
        try:
            for index,frame in enumerate(frames if sheet is None else []):
                if time.monotonic()>deadline:raise DomainError("导出超过120秒，请减少帧数或尺寸")
                with Image.open(store.batches.frame_file(batch.id,frame['id'],'current')) as image:
                    image=transform(image,settings)
                buffer=io.BytesIO();image.save(buffer,format='PNG');archive.writestr(f'frames/frame_{index+1:06d}.png',buffer.getvalue())
                if archive.fp.tell()>min(available,store.limits.job_bytes):raise DomainError("导出超过磁盘预算，请降低尺寸或减少帧数")
            if sheet is not None:
                buffer=io.BytesIO();sheet.save(buffer,format='PNG');archive.writestr('sheet.png',buffer.getvalue())
                metadata={'formatVersion':1,'kind':'fixed-grid','image':'sheet.png','name':settings.name,'canvas':{'width':sheet_size[0],'height':sheet_size[1]},'cell':{'width':settings.width,'height':settings.height},'columns':cols,'rows':rows,'playback':playback,'frames':[{'index':i,'rect':{'x':(i%cols)*settings.width,'y':(i//cols)*settings.height,'width':settings.width,'height':settings.height},'source':frame} for i,frame in enumerate(frames)]}
                archive.writestr('sheet.json',json.dumps(metadata,ensure_ascii=False,indent=2))
            else:
                manifest={'formatVersion':6,'kind':'uniform-frame-export','playback':playback,'source':batch.manifest.get('source'),'canvas':{'width':settings.width,'height':settings.height},'transform':{**settings.model_dump(exclude={'revisions','frameIds','name'}),'geometry':geometry},'frames':[{**frame,'image':f'frames/frame_{i+1:06d}.png'} for i,frame in enumerate(frames)]}
                archive.writestr('frame-sequence.json',json.dumps(manifest,ensure_ascii=False))
        finally:
            archive.close()
            if sheet:sheet.close()
        if time.monotonic()>deadline:raise DomainError("导出超过120秒，请减少帧数或尺寸")
        if path.stat().st_size>min(available,store.limits.job_bytes):raise DomainError("导出文件超过磁盘预算")
        with zipfile.ZipFile(path) as check:
            if check.testzip() is not None or len(check.namelist())!=(len(frames)+1 if settings.format=='sequence' else 2):raise DomainError("导出ZIP校验失败")
            for entry in check.namelist():
                if entry.endswith('.png'):
                    with Image.open(io.BytesIO(check.read(entry))) as image:image.verify()
        return path,token,settings.name.strip().rstrip('.') or 'animation'
    except BaseException:
        finish(store,directory,token)
        raise


def finish(store,directory,token):
    try:
        if directory.exists():store._remove(directory)
    finally:
        with store.lock:
            if store.busy==token:store.busy=None
