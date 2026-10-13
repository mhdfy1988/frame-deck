"""整理结果的有界批量抠图；模型仍由同级单图项目提供。"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import threading
import time
import uuid
import zipfile
from copy import deepcopy
from contextlib import nullcontext
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from .domain import DomainError
from .media import directory_bytes
from .organizer import edited_manifest
from model_config import resolve_model_runtime

_model_runtime = resolve_model_runtime()
MATTING_ROOT, MODEL_PYTHON = _model_runtime.root, _model_runtime.python
MAX_BATCH_SECONDS = 45 * 60
PROCESSING_POLICY = "model-local-despill-v1"


class LocalMattingRunner:
    """单次批量仅拥有一个模型子进程；取消时只停止这个进程。"""
    def __init__(self):
        self.process: subprocess.Popen | None = None
        self.log = None

    def __enter__(self):
        if not MODEL_PYTHON.is_file():
            raise DomainError("抠图模型环境未安装，请配置FRAMES_MATTING_ROOT和FRAMES_MODEL_PYTHON；见安装说明")
        return self

    def cutout(self, source: Path, target: Path, batch):
        if self.process is None:
            self.log = (batch.directory / "model.log").open("wb")
            environment = os.environ.copy()
            if environment.get("FRAMEDECK_CPU_ONLY") == "1":
                environment["CUDA_VISIBLE_DEVICES"] = ""
            self.process = subprocess.Popen(
                [str(MODEL_PYTHON), "-u", str(Path(__file__).with_name("batch_model_worker.py")), str(MATTING_ROOT)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
                env=environment,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        if batch.cancel.is_set():
            raise BatchCancelled()
        assert self.process.stdin and self.process.stdout
        try:
            self.process.stdin.write((json.dumps({"source": str(source), "target": str(target)}) + "\n").encode("utf-8"))
            self.process.stdin.flush()
            answer = self.process.stdout.readline()
        except (BrokenPipeError, OSError):
            answer = b""
        if batch.cancel.is_set():
            raise BatchCancelled()
        if not answer:
            raise DomainError("抠图模型进程退出，请检查本机模型安装和任务日志")
        try:
            response = json.loads(answer)
        except (ValueError, UnicodeError):
            raise DomainError("抠图模型返回无效结果") from None
        if not response.get("ok"):
            raise DomainError(str(response.get("error", "抠图模型失败"))[:240])
        if self.log and self.log.tell() > 32 * 1024**2:
            raise DomainError("抠图模型日志超过限制")
        return {"model": response.get("model", "existing-alpha"), "details": response.get("details", {})}

    def stop(self):
        if self.process and self.process.poll() is None:
            if os.name == 'nt':
                # 仅结束本批拥有的模型进程树，包含其正在运行的FFmpeg。
                stopped=subprocess.run(['taskkill','/PID',str(self.process.pid),'/T','/F'],capture_output=True,timeout=5)
                if stopped.returncode and self.process.poll() is None:
                    raise RuntimeError('无法停止本批模型进程树')
            else:
                self.process.terminate()

    def __exit__(self, *_):
        self.stop()
        if self.process:
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            if self.process.stdin:
                self.process.stdin.close()
            if self.process.stdout:
                self.process.stdout.close()
        if self.log:
            self.log.close()


class BatchCancelled(Exception):
    pass


@dataclass
class Batch:
    id: str
    job_id: str
    directory: Path
    source_sequence: dict
    manifest: dict
    source_paths: list[Path]
    parent: Batch | None = None
    status: str = "running"
    stage: str = "准备抠图"
    completed: int = 0
    error: str | None = None
    failed_frame: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    finished: threading.Event = field(default_factory=threading.Event)
    touched: float = field(default_factory=time.monotonic)
    runner: object | None = None
    revisions: dict[str, int] = field(default_factory=dict)
    modified: set[str] = field(default_factory=set)
    cached_paths: dict = field(default_factory=dict)

    def public(self):
        return {"id": self.id, "sourceJobId": self.job_id, "processingPolicy": self.manifest["derivation"].get("processingPolicy"), "status": self.status if self.finished.is_set() else ("cancelling" if self.cancel.is_set() else "running"),
                "stage": self.stage, "completed": self.completed, "total": len(self.source_paths),
                "error": self.error, "failedFrameId": self.failed_frame,
                "sequence": deepcopy(self.manifest) if self.status == "done" and self.finished.is_set() else None,
                "revisions": dict(self.revisions), "modifiedFrameIds": sorted(self.modified)}


class BatchManager:
    def __init__(self, store, model_factory=LocalMattingRunner):
        self.store = store
        self.model_factory = model_factory
        self.items: dict[str, Batch] = {}

    def _prune(self):
        now = time.monotonic()
        for key, batch in list(self.items.items()):
            if batch.finished.is_set() and now - batch.touched > self.store.limits.ttl_seconds:
                self.store._remove(batch.directory)
                del self.items[key]

    def held_jobs(self):
        self._prune()
        return {batch.job_id for batch in self.items.values()}

    def get(self, token: str, done=False):
        with self.store.lock:
            batch = self.items[token]
            batch.touched = time.monotonic()
            if done and (batch.status != "done" or not batch.finished.is_set()):
                raise DomainError("批量结果尚未完整完成")
            return batch

    def start(self, session_id: str, frame_ids: list[str], parent_id: str | None = None):
        store = self.store
        job = store.editor_job(session_id)
        parent = self.get(parent_id, done=True) if parent_id else None
        if parent and parent.job_id != job.id:
            raise DomainError("旧抠图结果与当前抽帧任务不属于同一来源")
        if parent and parent.manifest["derivation"].get("processingPolicy") != PROCESSING_POLICY:
            raise DomainError("旧结果使用不同处理方式，请重新抠图，不可混用补抠")
        token = uuid.uuid4().hex
        # 与抽帧/整理导出共用一把全局任务锁与缓存预算。
        store._reserve(token)
        directory = None
        try:
            manifest = edited_manifest(job.result, frame_ids, token)
            originals = {frame["id"]: frame for frame in job.result["frames"]}
            sources = [job.directory / "result" / originals[key]["image"] for key in frame_ids]
            canvas = manifest["canvas"]
            if canvas["width"] * canvas["height"] * 4 * len(sources) > store.limits.rgba_bytes:
                raise DomainError("批量RGBA预算超限，请先整理更短的片段")
            if sum(path.stat().st_size for path in sources) > 512 * 1024**2:
                raise DomainError("源帧总量超过批量预算")
            directory = store.root / f"batch-{token}"
            directory.mkdir()
            manifest["formatVersion"] = 4
            manifest["name"] = manifest["name"].replace("-整理", "-抠图")
            manifest["derivation"] = {"kind": "batch-game-art-matting", "parentJobId": job.id,
                                      "parentSequenceId": job.result["id"], "organizedFrameIds": list(frame_ids),
                                      "sourceFormatVersion": 2, "durationPolicy": "retain-surviving-frame-durations"}
            manifest["derivation"]["processingPolicy"] = PROCESSING_POLICY
            inherited = {frame["id"]: frame for frame in parent.manifest["frames"]} if parent else {}
            for frame in manifest["frames"]:
                frame["matting"] = deepcopy(inherited[frame["id"]]["matting"]) if frame["id"] in inherited else {"manual": False, "model": None}
            batch = Batch(token, job.id, directory, deepcopy(job.result), manifest, sources,
                          parent=parent,
                          revisions={key: parent.revisions[key] if parent and key in parent.revisions else 0 for key in frame_ids},
                          modified=set(frame_ids) & parent.modified if parent else set())
            with store.lock:
                self.items[token] = batch
            thread = threading.Thread(target=self._run, args=(batch,), name=f"matting-{token[:8]}", daemon=True)
            thread.start()
            return batch.public()
        except BaseException:
            if directory is not None and directory.exists() and token not in self.items:
                store._remove(directory)
            with store.lock:
                if store.busy == token:
                    store.busy = None
            raise

    def _run(self, batch: Batch):
        store = self.store
        started = time.monotonic()
        def timeout():
            with store.lock:
                batch.error = "批量抠图超过45分钟预算"
                batch.cancel.set()
                if batch.runner:
                    batch.runner.stop()
        watchdog = threading.Timer(MAX_BATCH_SECONDS, timeout)
        watchdog.daemon = True
        watchdog.start()
        staging = batch.directory / "staging"
        auto = staging / "auto"
        current = staging / "current"
        thumbs = staging / "thumbs"
        frame = None
        try:
            for path in (auto, current, thumbs):
                path.mkdir(parents=True)
            needs_model = any(frame['id'] not in batch.cached_paths and not (batch.parent and frame['id'] in batch.parent.revisions) for frame in batch.manifest['frames'])
            with (self.model_factory() if needs_model else nullcontext(None)) as runner:
                batch.runner = runner
                for index, (source, frame) in enumerate(zip(batch.source_paths, batch.manifest["frames"])):
                    if batch.cancel.is_set():
                        raise BatchCancelled()
                    if time.monotonic() - started > MAX_BATCH_SECONDS:
                        raise DomainError("批量抠图超过45分钟预算")
                    if directory_bytes(batch.directory) > store.limits.job_bytes or directory_bytes(store.root) > store.limits.cache_bytes:
                        raise DomainError("批量抠图磁盘预算不足")
                    name = f"frame_{index+1:06d}.png"
                    output = auto / name
                    if frame['id'] in batch.cached_paths:
                        cached = batch.cached_paths[frame['id']]
                        for variant, folder in (("auto", auto), ("current", current)):
                            shutil.copyfile(cached[variant], folder / name)
                        with Image.open(current / name) as image:
                            image.thumbnail((256, 256))
                            image.save(thumbs / name, format='PNG')
                    elif batch.parent and frame["id"] in batch.parent.revisions:
                        for variant, folder in (("auto", auto), ("current", current), ("thumb", thumbs)):
                            shutil.copyfile(self.frame_file(batch.parent.id, frame["id"], variant), folder / name)
                    else:
                        model = runner.cutout(source, output, batch)
                        with Image.open(output) as image:
                            if image.mode != "RGBA" or image.size != (batch.manifest["canvas"]["width"], batch.manifest["canvas"]["height"]):
                                raise DomainError("抠图结果格式或尺寸不一致")
                            image.load()
                            preview = image.copy()
                            preview.thumbnail((256, 256))
                            preview.save(thumbs / name, format="PNG")
                        shutil.copyfile(output, current / name)
                        frame["matting"]["model"] = model["model"] if isinstance(model, dict) else model
                        if isinstance(model, dict):
                            frame["matting"]["details"] = model["details"]
                    with store.lock:
                        batch.completed = index + 1
                        batch.stage = f"抠图 {batch.completed} / {len(batch.source_paths)}"
            if batch.cancel.is_set():
                raise BatchCancelled()
            (staging / "frame-sequence.json").write_text(json.dumps(batch.manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            with store.lock:
                if batch.cancel.is_set():
                    raise BatchCancelled()
                staging.rename(batch.directory / "result")
                batch.status, batch.stage = "done", "完成"
        except BatchCancelled:
            with store.lock:
                batch.status, batch.stage = ("failed", "超时") if batch.error else ("cancelled", "已取消")
        except Exception as exc:
            with store.lock:
                batch.status, batch.stage = "failed", "失败"
                batch.error = str(exc) if isinstance(exc, DomainError) else "批量抠图失败，请检查本机模型与任务日志"
                batch.failed_frame = frame["id"] if frame else None
        finally:
            watchdog.cancel()
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
            with store.lock:
                batch.runner = None
                batch.touched = time.monotonic()
                batch.finished.set()
                if store.busy == batch.id:
                    store.busy = None

    def cancel(self, token: str):
        with self.store.lock:
            batch = self.get(token)
            if not batch.finished.is_set():
                batch.cancel.set()
                batch.stage = "正在停止"
                if batch.runner:
                    batch.runner.stop()
            return batch.public()

    def frame_file(self, token: str, frame_id: str, variant: str):
        batch = self.get(token, done=True)
        order = [frame["id"] for frame in batch.manifest["frames"]]
        if frame_id not in batch.revisions or variant not in {"source", "auto", "current", "thumb"}:
            raise DomainError("帧不存在")
        index = order.index(frame_id)
        if variant == "source":
            return batch.source_paths[index]
        return batch.directory / "result" / {"auto": "auto", "current": "current", "thumb": "thumbs"}[variant] / f"frame_{index+1:06d}.png"

    def save_frame(self, token: str, frame_id: str, revision: int, data: bytes):
        batch = self.get(token, done=True)
        if frame_id not in batch.revisions:
            raise DomainError("帧不存在")
        if len(data) > 50 * 1024**2:
            raise DomainError("精修PNG超过50MiB")
        if revision != batch.revisions[frame_id]:
            raise DomainError("帧已被其他编辑更新，请重新打开")
        with Image.open(io.BytesIO(data)) as image:
            if image.mode != "RGBA" or image.size != (batch.manifest["canvas"]["width"], batch.manifest["canvas"]["height"]):
                raise DomainError("精修PNG格式或尺寸不一致")
            image.load()
            preview = image.copy()
            preview.thumbnail((256, 256))
            if directory_bytes(batch.directory) + len(data) > self.store.limits.job_bytes:
                raise DomainError("精修结果磁盘预算不足")
            target = self.frame_file(token, frame_id, "current")
            thumb = self.frame_file(token, frame_id, "thumb")
            nonce = uuid.uuid4().hex
            temp = target.with_name(f"{target.name}.{nonce}.new")
            temp_thumb = thumb.with_name(f"{thumb.name}.{nonce}.new")
            try:
                temp.write_bytes(data)
                preview.save(temp_thumb, format="PNG")
                with self.store.lock:
                    if self.store.busy is not None:
                        raise DomainError("正在执行其他任务，请稍后保存")
                    if revision != batch.revisions[frame_id]:
                        raise DomainError("帧已被其他编辑更新，请重新打开")
                    temp.replace(target)
                    temp_thumb.replace(thumb)
                    batch.revisions[frame_id] += 1
                    batch.modified.add(frame_id)
                    for frame in batch.manifest["frames"]:
                        if frame["id"] == frame_id:
                            frame["matting"]["manual"] = True
                            break
            finally:
                temp.unlink(missing_ok=True)
                temp_thumb.unlink(missing_ok=True)
        return {"revision": batch.revisions[frame_id], "modified": True}

    def export(self, token: str, frame_ids: list[str] | None = None):
        batch = self.get(token, done=True)
        frame_ids = list(frame_ids) if frame_ids is not None else [frame["id"] for frame in batch.manifest["frames"]]
        if any(frame_id not in batch.revisions for frame_id in frame_ids):
            raise DomainError("当前序列含未抠图的帧，请先补抠")
        hold = uuid.uuid4().hex
        self.store._reserve(hold)
        archive = batch.directory / f"export-{hold}.zip"
        try:
            manifest = edited_manifest(batch.source_sequence, frame_ids, batch.id)
            manifest["formatVersion"] = 4
            manifest["name"] = manifest["name"].replace("-整理", "-抠图")
            manifest["derivation"] = {"kind": "batch-game-art-matting", "parentJobId": batch.job_id,
                                      "parentSequenceId": batch.source_sequence["id"], "organizedFrameIds": frame_ids,
                                      "sourceFormatVersion": 2, "durationPolicy": "retain-surviving-frame-durations"}
            manifest["derivation"]["processingPolicy"] = batch.manifest["derivation"].get("processingPolicy")
            details = {frame["id"]: frame["matting"] for frame in batch.manifest["frames"]}
            for frame in manifest["frames"]:
                frame["matting"] = deepcopy(details[frame["id"]])
            manifest["derivation"]["manualFrameIds"] = [frame["id"] for frame in manifest["frames"] if frame["id"] in batch.modified]
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as packed:
                packed.writestr("frame-sequence.json", json.dumps(manifest, ensure_ascii=False, indent=2))
                for frame in manifest["frames"]:
                    source = self.frame_file(token, frame["id"], "current")
                    packed.write(source, frame["image"])
                    if directory_bytes(batch.directory) > self.store.limits.job_bytes or directory_bytes(self.store.root) > self.store.limits.cache_bytes:
                        raise DomainError("透明序列导出磁盘预算不足")
            with zipfile.ZipFile(archive) as packed:
                if packed.testzip() or json.loads(packed.read("frame-sequence.json")) != manifest or len(packed.namelist()) != len(manifest["frames"]) + 1:
                    raise DomainError("透明序列ZIP校验失败")
            return archive, hold
        except BaseException:
            self.finish_export(archive, hold)
            raise

    def finish_export(self, archive: Path, hold: str):
        try:
            archive.unlink(missing_ok=True)
        finally:
            with self.store.lock:
                if self.store.busy == hold:
                    self.store.busy = None
