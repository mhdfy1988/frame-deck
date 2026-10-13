"""单任务服务：原视频只读，完整结果原子发布，有界缓存。"""
import hashlib
import json
import re
import shutil
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from PIL import Image
from .config import LIMITS, Limits
from .domain import DomainError, ExtractionRequest, adapt_v1, choose_samples, exact, manifest, targets
from .media import Cancelled, Video, decode_selected, directory_bytes, normalize_preview, probe, remove_owned
from .organizer import edited_manifest
from .batch_matting import BatchManager


@dataclass
class Asset:
    id: str
    name: str
    directory: Path
    path: Path
    sha256: str
    video: Video
    preview_path: Path | None = None
    touched: float = field(default_factory=time.monotonic)


@dataclass
class Job:
    id: str
    video_id: str
    directory: Path
    request: dict
    status: str = "running"
    stage: str = "提取画面"
    progress: int = 0
    error: str | None = None
    result: dict | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    finished: threading.Event = field(default_factory=threading.Event)
    touched: float = field(default_factory=time.monotonic)


class Store:
    def __init__(self, root: Path, limits: Limits = LIMITS):
        self.root, self.limits = root.resolve(), limits
        self.lock = threading.RLock()
        self.assets: dict[str, Asset] = {}
        self.jobs: dict[str, Job] = {}
        self.edit_sessions: dict[str, dict] = {}
        self.busy: str | None = None
        self.closed = False
        if self.root == Path(self.root.anchor) or self.root == Path.home().resolve():
            raise DomainError("缓存不能指向磁盘根目录或用户根目录")
        self.root.mkdir(parents=True, exist_ok=True)
        marker = self.root / ".frames-cache-owner"
        if not marker.exists() and any(self.root.iterdir()):
            raise DomainError("缓存目录已有未知文件，拒绝接管")
        if marker.exists() and marker.read_text(encoding="utf-8") != "game-video-to-frames-v1":
            raise DomainError("缓存所有权不匹配")
        marker.write_text("game-video-to-frames-v1", encoding="utf-8")
        # 本版不承诺重启恢复：只回收自己的分配目录，不执行用户文件。
        for child in self.root.iterdir():
            if re.fullmatch(r"(?:video|job|batch)-[a-f0-9]{32}", child.name):
                self._remove(child)
        self.batches = BatchManager(self)

    def _remove(self, directory: Path):
        if directory.is_symlink() or directory.is_junction():
            raise DomainError("拒绝清理链接目录")
        remove_owned(directory, self.root)

    def _prune(self):
        now = time.monotonic()
        held = self._held_jobs()
        for key, job in list(self.jobs.items()):
            if key not in held and job.finished.is_set() and now - job.touched > self.limits.ttl_seconds:
                self._remove(job.directory)
                del self.jobs[key]
        referenced = {job.video_id for job in self.jobs.values() if not job.finished.is_set()}
        for key, asset in list(self.assets.items()):
            if key not in referenced and now - asset.touched > self.limits.ttl_seconds:
                self._remove(asset.directory)
                del self.assets[key]

    def _reserve(self, token: str):
        with self.lock:
            if self.closed:
                raise DomainError("服务正在关闭")
            if self.busy is not None:
                raise DomainError("已有导入或抽帧任务，请完成或取消后再操作")
            self._prune()
            if directory_bytes(self.root) >= self.limits.cache_bytes:
                raise DomainError("缓存配额已满，请等待到期清理或重启本工具")
            self.busy = token

    def begin_upload(self, name: str):
        name = name.replace("\\", "/").split("/")[-1]
        if not name or len(name) > 180 or Path(name).suffix.lower() not in {".mp4", ".mov", ".webm"}:
            raise DomainError("请选择MP4、MOV或WebM视频")
        token = uuid.uuid4().hex
        self._reserve(token)
        try:
            with self.lock:
                while len(self.assets) >= self.limits.max_assets:
                    oldest = min(self.assets.values(), key=lambda value: value.touched)
                    self._remove(oldest.directory)
                    del self.assets[oldest.id]
            directory = self.root / f"video-{token}"
            directory.mkdir()
        except Exception:
            with self.lock:
                self.busy = None
            raise
        return token, name, directory, directory / ("input" + Path(name).suffix.lower())

    def finish_upload(self, token: str, name: str, directory: Path, path: Path, digest: str):
        try:
            video = probe(path, self.limits)
            asset = Asset(token, name, directory, path, digest, video)
            if video.origin_pts != 0:
                def monitor():
                    if directory_bytes(self.root) > self.limits.cache_bytes:
                        raise DomainError("预览缓存磁盘配额超限")
                asset.preview_path = normalize_preview(path, video, directory / ("preview" + path.suffix), monitor, self.limits)
            with self.lock:
                self.assets[token] = asset
            return self.asset_public(asset)
        except BaseException:
            self._remove(directory)
            raise
        finally:
            with self.lock:
                if self.busy == token:
                    self.busy = None

    def abort_upload(self, token: str, directory: Path):
        with self.lock:
            self._remove(directory)
            if self.busy == token:
                self.busy = None

    def asset(self, token: str):
        with self.lock:
            if token not in self.assets:
                raise KeyError(token)
            asset = self.assets[token]
            asset.touched = time.monotonic()
            return asset

    def asset_public(self, asset: Asset):
        return {"id": asset.id, "name": asset.name, **asset.video.public(),
                "normalizedPreview": asset.preview_path is not None,
                "url": f"/api/videos/{asset.id}/source"}

    def start(self, request: ExtractionRequest):
        asset = self.asset(request.videoId)
        start, end, grid = targets(request.start, request.end, request.fps,
                                   asset.video.duration, asset.video.width, asset.video.height, self.limits)
        samples = choose_samples(grid, end, list(asset.video.frames))
        token = uuid.uuid4().hex
        self._reserve(token)
        try:
            return self._start_reserved(token, asset, request, start, end, samples)
        except Exception:
            with self.lock:
                if self.busy == token:
                    self.busy = None
                self.jobs.pop(token, None)
            directory = self.root / f"job-{token}"
            self._remove(directory)
            raise

    def _start_reserved(self, token, asset, request, start, end, samples):
        with self.lock:
            # 新任务失败时仍保留最近完整结果，最多三份完整/失败任务。
            while len(self.jobs) >= self.limits.max_jobs:
                complete = [value for value in self.jobs.values() if value.status == "done"]
                protected = max(complete, key=lambda value: value.touched).id if complete else None
                held = self._held_jobs()
                candidates = [value for value in self.jobs.values() if value.id != protected and value.id not in held]
                if not candidates:
                    raise DomainError("其他页面仍在使用历史帧，请关闭这些页面后重新提取")
                oldest = min(candidates, key=lambda value: value.touched)
                self._remove(oldest.directory)
                del self.jobs[oldest.id]
            directory = self.root / f"job-{token}"
            directory.mkdir()
            job = Job(token, asset.id, directory, request.model_dump())
            self.jobs[token] = job
        thread = threading.Thread(target=self._extract, args=(job, asset, start, end, samples),
                                  name=f"frames-{token[:8]}", daemon=True)
        thread.start()
        return self.snapshot(token)

    def _extract(self, job: Job, asset: Asset, start: Fraction, end: Fraction, samples):
        started = time.monotonic()
        staging = job.directory / "staging"
        raw = staging / "raw"
        images = staging / "frames"
        unique = sorted({sample.source.index for sample in samples})

        def guard():
            if job.cancel.is_set():
                raise Cancelled()
            if time.monotonic() - started > self.limits.job_seconds:
                raise DomainError("本次任务超过120秒预算，请缩短范围")
            if directory_bytes(job.directory) > self.limits.job_bytes or directory_bytes(self.root) > self.limits.cache_bytes:
                raise DomainError("任务磁盘配额超限，已停止")

        def monitor():
            guard()
            count = len(list(raw.glob("source_*.png")))
            with self.lock:
                job.progress = min(70, round(count / len(unique) * 70))

        try:
            raw.mkdir(parents=True)
            images.mkdir()
            selected = decode_selected(asset.path, asset.video, unique, raw, job.cancel,
                                       self.limits.job_seconds, monitor, self.limits)
            for i, sample in enumerate(samples):
                guard()
                target = images / f"frame_{i + 1:06d}.png"
                shutil.copyfile(selected[sample.source.index], target)
                with Image.open(target) as image:
                    image.load()
                    if image.size != (asset.video.width, asset.video.height) or image.mode != "RGB":
                        raise DomainError("导出图像尺寸或像素格式不符合协议")
                    image.thumbnail((256, 256))
                    thumbs = staging / "thumbs"
                    thumbs.mkdir(exist_ok=True)
                    image.save(thumbs / f"frame_{i + 1:06d}.jpg", quality=82)
                with self.lock:
                    job.progress = 70 + round((i + 1) / len(samples) * 15)
                    job.stage = "校验画面"
            # raw是本任务私有中间文件；释放后再打包，减少峰值磁盘。
            shutil.rmtree(raw)
            sequence = manifest(job.id, Path(asset.name).stem, {
                "kind": "video", "name": asset.name, "sha256": asset.sha256,
                "timeBase": exact(asset.video.time_base), "originPts": asset.video.origin_pts,
                "metadata": asset.video.public(),
            }, asset.video.width, asset.video.height, start, end, job.request["fps"], samples)
            (staging / "frame-sequence.json").write_text(json.dumps(sequence, ensure_ascii=False, indent=2), encoding="utf-8")
            with self.lock:
                job.stage, job.progress = "打包与重读", 88
            archive = staging / "frames.zip"
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as zip_file:
                zip_file.write(staging / "frame-sequence.json", "frame-sequence.json")
                for frame in sequence["frames"]:
                    guard()
                    zip_file.write(staging / frame["image"], frame["image"])
            guard()
            with zipfile.ZipFile(archive) as zip_file:
                if zip_file.testzip() is not None:
                    raise DomainError("ZIP校验失败")
                reread = json.loads(zip_file.read("frame-sequence.json"))
                if reread != sequence or len(zip_file.namelist()) != len(samples) + 1:
                    raise DomainError("ZIP清单或数量不一致")
            guard()
            with self.lock:
                # 取消与发布通过同一把锁决定先后，取消后不能复活成成功。
                if job.cancel.is_set():
                    raise Cancelled()
                staging.rename(job.directory / "result")
                job.result = sequence
                job.status, job.stage, job.progress = "done", "完成", 100
        except Cancelled:
            with self.lock:
                job.status, job.stage = "cancelled", "已取消"
        except Exception as exc:
            with self.lock:
                job.status, job.stage = "failed", "失败"
                job.error = str(exc) if isinstance(exc, DomainError) else "任务失败，请检查文件或重新导入"
        finally:
            try:
                if staging.exists():
                    shutil.rmtree(staging)
            except OSError:
                with self.lock:
                    job.status, job.stage = "failed", "清理失败"
                    job.error = "中间缓存清理失败，请关闭本工具后检查磁盘权限"
            finally:
                with self.lock:
                    job.touched = time.monotonic()
                    if self.busy == job.id:
                        self.busy = None
                    job.finished.set()

    def snapshot(self, token: str):
        with self.lock:
            if token not in self.jobs:
                raise KeyError(token)
            job = self.jobs[token]
            job.touched = time.monotonic()
            # 对外终态只在清理结束及busy释放后可见，避免立即重提取的竞争。
            settled = job.finished.is_set()
            visible_status = job.status if settled else ("cancelling" if job.cancel.is_set() else "running")
            result = {"id": job.id, "videoId": job.video_id, "status": visible_status,
                      "stage": job.stage, "progress": job.progress if settled else min(99, job.progress),
                      "error": job.error, "request": job.request}
            if job.result is not None and settled:
                result.update({"sequence": job.result, "downloadUrl": f"/api/jobs/{job.id}/download",
                               "duplicateCount": len(job.result["frames"]) - len({frame["sourceFrameIndex"] for frame in job.result["frames"]})})
            return result

    def cancel_job(self, token: str):
        with self.lock:
            job = self.jobs[token]
            if not job.finished.is_set() and job.status != "done":
                job.cancel.set()
                job.status, job.stage = "cancelling", "正在停止"
            return self.snapshot(token)

    def result_file(self, token: str, relative: str):
        with self.lock:
            job = self.jobs[token]
            if job.status != "done":
                raise DomainError("结果尚未完整校验")
            job.touched = time.monotonic()
            return job.directory / "result" / relative

    def legacy(self, token: str):
        with self.lock:
            job = self.jobs[token]
            if job.status != "done":
                raise DomainError("结果未完成")
            return adapt_v1(job.result)

    def _held_jobs(self):
        """心跳更新的有界持有，不永久钉住被遗弃的浏览器任务。调用者持锁。"""
        now = time.monotonic()
        for key, session in list(self.edit_sessions.items()):
            if now - session["touched"] > self.limits.ttl_seconds:
                del self.edit_sessions[key]
        return {session["jobId"] for session in self.edit_sessions.values()} | self.batches.held_jobs()

    def open_editor(self, token: str):
        from copy import deepcopy
        with self.lock:
            self._held_jobs()
            job = self.jobs[token]
            if not job.finished.is_set() or job.status != "done" or job.result is None:
                raise DomainError("只能整理已完成的抽帧结果")
            if len(self.edit_sessions) >= 3:
                raise DomainError("最多三个整理会话，请先关闭其他会话")
            identity = uuid.uuid4().hex
            self.edit_sessions[identity] = {"jobId": token, "touched": time.monotonic()}
            return {"id": identity, "jobId": token, "sequence": deepcopy(job.result)}

    def editor_job(self, token: str):
        with self.lock:
            self._held_jobs()
            session = self.edit_sessions[token]
            session["touched"] = time.monotonic()
            job = self.jobs[session["jobId"]]
            job.touched = time.monotonic()
            return job

    def close_editor(self, token: str):
        with self.lock:
            self.edit_sessions.pop(token, None)

    def reset_workspace(self, session_id: str | None):
        """重新抽帧显式放弃历史；保护其他页面仍持有的会话与运行任务。"""
        with self.lock:
            if self.busy is not None:
                raise DomainError("任务仍在运行，请完成或取消后重新提取")
            self._held_jobs()
            protected = {session["jobId"] for key, session in self.edit_sessions.items()
                         if key != session_id}
            candidates = [job for job in self.jobs.values() if job.id not in protected]
            if any(not job.finished.is_set() for job in candidates):
                raise DomainError("历史任务尚未结束，请稍后重新提取")
            batches = [batch for batch in self.batches.items.values() if batch.job_id not in protected]
            if any(not batch.finished.is_set() for batch in batches):
                raise DomainError("抠图任务尚未结束，请稍后重新提取")
            # 先删除派生结果，再删除源帧；原视频不删除。
            for batch in batches:
                self._remove(batch.directory)
                del self.batches.items[batch.id]
            for job in candidates:
                self._remove(job.directory)
                del self.jobs[job.id]
            self.edit_sessions.pop(session_id, None)
            return {"ok": True, "removedJobs": len(candidates), "removedBatches": len(batches)}

    def export_editor(self, session_id: str, frame_ids: list[str]):
        job = self.editor_job(session_id)
        token = uuid.uuid4().hex
        self._reserve(token)
        archive = job.directory / f"organized-{token}.zip"
        started = time.monotonic()
        try:
            sequence = edited_manifest(job.result, frame_ids, token)
            originals = {frame["id"]: frame for frame in job.result["frames"]}
            sources = [job.directory / "result" / originals[frame_id]["image"] for frame_id in frame_ids]
            # 浏览器下载Blob的独立预算，不把2GiB抽帧上限冒称客户端可安全编辑。
            if sum(path.stat().st_size for path in sources) > 256 * 1024**2:
                raise DomainError("整理导出超过256MiB，请减少帧数")

            def guard():
                if time.monotonic() - started > self.limits.job_seconds:
                    raise DomainError("整理导出超时，请减少帧数")
                if directory_bytes(job.directory) > self.limits.job_bytes or directory_bytes(self.root) > self.limits.cache_bytes:
                    raise DomainError("整理导出磁盘预算不足")

            digests = []
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as packed:
                packed.writestr("frame-sequence.json", json.dumps(sequence, ensure_ascii=False, indent=2))
                for source, frame in zip(sources, sequence["frames"]):
                    guard()
                    with Image.open(source) as image:
                        image.load()
                        if image.size != (sequence["canvas"]["width"], sequence["canvas"]["height"]) or image.mode not in {"RGB", "RGBA"}:
                            raise DomainError("原帧尺寸或格式不一致")
                    digest = hashlib.sha256()
                    with source.open("rb") as original, packed.open(frame["image"], "w") as output:
                        while chunk := original.read(512 * 1024):
                            guard()
                            digest.update(chunk)
                            output.write(chunk)
                    digests.append(digest.digest())
            guard()
            with zipfile.ZipFile(archive) as packed:
                if len(packed.namelist()) != len(frame_ids) + 1 or json.loads(packed.read("frame-sequence.json")) != sequence:
                    raise DomainError("整理ZIP清单不一致")
                for frame, expected in zip(sequence["frames"], digests):
                    digest = hashlib.sha256()
                    with packed.open(frame["image"]) as image:
                        while chunk := image.read(512 * 1024):
                            guard()
                            digest.update(chunk)
                    if digest.digest() != expected:
                        raise DomainError("整理ZIP图片校验失败")
            guard()
            return archive, token
        except BaseException:
            self.finish_editor_export(archive, token)
            raise

    def finish_editor_export(self, archive: Path, token: str):
        # 精确分配路径；忙状态保留到HTTP文件传输结束，避免期间缓存清理。
        try:
            archive.unlink(missing_ok=True)
        finally:
            with self.lock:
                if self.busy == token:
                    self.busy = None

    def close(self):
        with self.lock:
            self.closed = True
            active = [job for job in self.jobs.values() if not job.finished.is_set()]
            for job in active:
                job.cancel.set()
            batches = [batch for batch in self.batches.items.values() if not batch.finished.is_set()]
            for batch in batches:
                batch.cancel.set()
                if batch.runner:
                    batch.runner.stop()
        for job in active:
            job.finished.wait(timeout=8)
        for batch in batches:
            batch.finished.wait(timeout=8)
