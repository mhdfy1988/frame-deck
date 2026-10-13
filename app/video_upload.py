"""旧入口与工作流共用的有界视频上传适配。"""
import hashlib
from urllib.parse import unquote
from starlette.concurrency import run_in_threadpool
from .domain import DomainError
from .media import directory_bytes


async def upload_video(request, store):
    token, name, directory, path = store.begin_upload(unquote(request.headers.get("x-file-name", "")))
    transferred = 0
    digest = hashlib.sha256()
    try:
        with path.open("wb") as target:
            async for chunk in request.stream():
                transferred += len(chunk)
                if transferred > store.limits.upload_bytes:
                    raise DomainError("上传超过256MiB限制")
                if directory_bytes(store.root) + len(chunk) > store.limits.cache_bytes:
                    raise DomainError("缓存磁盘预算不足")
                target.write(chunk)
                digest.update(chunk)
        if transferred == 0:
            raise DomainError("视频文件为空")
        return await run_in_threadpool(store.finish_upload, token, name, directory, path, digest.hexdigest())
    except BaseException:
        store.abort_upload(token, directory)
        raise
