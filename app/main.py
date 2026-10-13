"""仅本机HTTP入口：限制上传、隔离路径、禁止跨站调用。"""
import hashlib
import ipaddress
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from .config import CACHE, LIMITS, ROOT, Limits
from .domain import DomainError, ExtractionRequest
from .media import binary
from .service import Store
from .video_upload import upload_video
from .model_setup import ModelSetup
from . import export_frames
from .organizer import HandoffRequest, EditExportRequest, edited_manifest
from pydantic import BaseModel, ConfigDict, Field
from pydantic import ValidationError


class BatchStart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sessionId: str = Field(pattern=r"^[a-f0-9]{32}$")
    frameIds: list[str] = Field(min_length=1, max_length=600)
    parentBatchId: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")


class BatchExport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    frameIds: list[str] = Field(min_length=1, max_length=600)


class WorkspaceReset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sessionId: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")


class ManagedDownload(FileResponse):
    """复用文件响应；传输成功、异常或断开均释放临时文件及占用。"""
    def __init__(self, path, cleanup, filename="organized-frames.zip", media_type="application/zip"):
        super().__init__(path, media_type=media_type, filename=filename)
        self.cleanup = cleanup

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            await run_in_threadpool(self.cleanup)


def create_app(cache=CACHE, limits: Limits = LIMITS):
    @asynccontextmanager
    async def lifespan(app):
        app.state.store = Store(cache, limits)
        yield
        await run_in_threadpool(app.state.model_setup.close)
        await run_in_threadpool(app.state.store.close)

    app = FastAPI(title="FrameDeck", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.model_setup = ModelSetup(ROOT)

    @app.get('/api/model-runtime')
    def model_runtime_status():
        return app.state.model_setup.status()

    @app.post('/api/model-runtime/install')
    def install_model_runtime():
        app.state.model_setup.start()
        return app.state.model_setup.status()

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        host = request.headers.get("host", "")
        hostname = host.split(":")[0]
        origin = request.headers.get("origin")
        if hostname not in {"127.0.0.1", "localhost", "testserver"}:
            return JSONResponse({"detail": "仅允许本机访问"}, status_code=403)
        if origin and origin != f"http://{host}":
            return JSONResponse({"detail": "拒绝跨站请求"}, status_code=403)
        if request.headers.get("sec-fetch-site") == "cross-site":
            return JSONResponse({"detail": "拒绝跨站请求"}, status_code=403)
        length = request.headers.get("content-length")
        if length and (not length.isdigit() or int(length) > limits.upload_bytes):
            return JSONResponse({"detail": "上传超过256MiB限制"}, status_code=413)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        ancestors = "'self'" if request.url.path == "/assets/matting/repair.html" else "'none'"
        response.headers["Content-Security-Policy"] = f"default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors {ancestors}"
        return response

    @app.exception_handler(DomainError)
    async def domain_error(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(KeyError)
    async def missing(request, exc):
        return JSONResponse({"detail": "素材或结果已过期，请重新导入"}, status_code=404)

    @app.get("/api/health")
    def health():
        available = {}
        for name in ("ffmpeg", "ffprobe"):
            try:
                binary(name)
                available[name] = True
            except DomainError:
                available[name] = False
        return {"ok": all(available.values()), "tools": available, "busy": app.state.store.busy is not None}

    @app.post("/api/videos")
    async def import_video(request: Request):
        return await upload_video(request, app.state.store)

    @app.get("/api/videos/{token}/source")
    def source(token: str):
        asset = app.state.store.asset(token)
        return FileResponse(asset.preview_path or asset.path, media_type={".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}[asset.path.suffix])

    @app.post("/api/jobs")
    def start(request: ExtractionRequest):
        return app.state.store.start(request)

    @app.post("/api/workspace/reset")
    def reset_workspace(request: WorkspaceReset):
        return app.state.store.reset_workspace(request.sessionId)

    @app.get("/api/jobs/{token}")
    def status(token: str):
        return app.state.store.snapshot(token)

    @app.post("/api/jobs/{token}/cancel")
    def cancel(token: str):
        return app.state.store.cancel_job(token)

    @app.get("/api/jobs/{token}/download")
    def download(token: str):
        return FileResponse(app.state.store.result_file(token, "frames.zip"), media_type="application/zip", filename="video-frames.zip")

    @app.get("/api/jobs/{token}/legacy-v1")
    def legacy(token: str):
        return JSONResponse(app.state.store.legacy(token), headers={"Content-Disposition": 'attachment; filename="frame-sequence-v1.json"'})

    @app.get("/api/jobs/{token}/frames/{index}")
    def frame(token: str, index: int, thumb: bool = False):
        job = app.state.store.snapshot(token)
        if job["status"] != "done" or not 1 <= index <= len(job["sequence"]["frames"]):
            raise DomainError("帧不存在或尚未完成")
        relative = f"thumbs/frame_{index:06d}.jpg" if thumb else f"frames/frame_{index:06d}.png"
        return FileResponse(app.state.store.result_file(token, relative), media_type="image/jpeg" if thumb else "image/png")

    @app.post("/api/edit-sessions")
    def handoff(request: HandoffRequest):
        return app.state.store.open_editor(request.jobId)

    @app.post("/api/edit-sessions/{token}/heartbeat")
    def heartbeat(token: str):
        app.state.store.editor_job(token)
        return {"ok": True}

    @app.delete("/api/edit-sessions/{token}")
    def release_editor(token: str):
        app.state.store.close_editor(token)
        return {"ok": True}

    @app.post("/api/edit-sessions/{token}/export")
    def edited_export(token: str, request: EditExportRequest):
        store = app.state.store
        archive, identity = store.export_editor(token, request.frameIds)
        return ManagedDownload(archive, lambda: store.finish_editor_export(archive, identity))

    @app.post("/api/matting-batches")
    def start_matting(request: BatchStart):
        return app.state.store.batches.start(request.sessionId, request.frameIds, request.parentBatchId)

    @app.get("/api/matting-batches/{token}")
    def matting_status(token: str):
        return app.state.store.batches.get(token).public()

    @app.post("/api/matting-batches/{token}/cancel")
    def cancel_matting(token: str):
        return app.state.store.batches.cancel(token)

    @app.get("/api/matting-batches/{token}/frames/{frame_id}/{variant}")
    def matting_frame(token: str, frame_id: str, variant: str):
        path = app.state.store.batches.frame_file(token, frame_id, variant)
        return FileResponse(path, media_type="image/png")

    @app.put("/api/matting-batches/{token}/frames/{frame_id}")
    async def save_matting_frame(token: str, frame_id: str, request: Request, revision: int):
        if request.headers.get("content-type") != "image/png":
            raise DomainError("精修结果必须为PNG")
        chunks = []
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > 50 * 1024**2:
                raise DomainError("精修PNG超过50MiB")
            chunks.append(chunk)
        data = b"".join(chunks)
        return await run_in_threadpool(app.state.store.batches.save_frame, token, frame_id, revision, data)

    @app.get("/api/matting-batches/{token}/download")
    def matting_download(token: str):
        store = app.state.store
        archive, identity = store.batches.export(token)
        return ManagedDownload(archive, lambda: store.batches.finish_export(archive, identity), "transparent-frames.zip")

    @app.post("/api/matting-batches/{token}/download")
    def matting_download_current(token: str, request: BatchExport):
        store = app.state.store
        archive, identity = store.batches.export(token, request.frameIds)
        return ManagedDownload(archive, lambda: store.batches.finish_export(archive, identity), "transparent-frames.zip")

    @app.get("/")
    def index():
        return FileResponse(ROOT / "web" / "index.html")

    @app.post("/api/export/analyze")
    def export_analyze(request: export_frames.ExportSource):
        return export_frames.analyze(app.state.store, request)

    @app.post("/api/export/preview")
    def export_preview(request: export_frames.PreviewSettings):
        return Response(export_frames.preview(app.state.store, request), media_type="image/png")

    @app.post("/api/export/download")
    def export_download(request: export_frames.ExportSettings):
        store=app.state.store
        path,token,name=export_frames.export(store,request)
        return ManagedDownload(path,lambda:export_frames.finish(store,path.parent,token),name+'.zip',media_type='application/zip')

    app.mount("/assets", StaticFiles(directory=ROOT / "web"), name="assets")
    return app


app = create_app()
