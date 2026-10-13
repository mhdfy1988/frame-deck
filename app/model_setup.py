"""FrameDeck专用首次安装状态；不借用其他项目的运行环境。"""
import hashlib
import json
import os
import subprocess
import sys
import threading
from collections import deque
from pathlib import Path
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class RuntimeManifest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    formatVersion: Literal[1]
    profile: Literal['cpu', 'cu128'] = 'cpu'
    files: dict[str, str] = Field(min_length=1)


class DownloadProgress(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    file: str = Field(max_length=300)
    downloaded: int = Field(ge=0)
    total: int | None = Field(default=None, gt=0)


class ModelSetup:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.lock = threading.Lock()
        self.thread = None
        self.process = None
        self.closing = False
        self.phase = 'missing'
        self.stage = '首次抠图将安装独立环境和模型，可能下载数GB'
        self.error = ''
        self.log = ''
        self.progress = None

    def ready(self):
        marker = self.root / '.runtime/model-ready.json'
        try:
            manifest = RuntimeManifest.model_validate_json(marker.read_text(encoding='utf-8'))
            if not (self.root / '.runtime/model-env/Scripts/python.exe').is_file():
                return False
            for name, expected in manifest.files.items():
                file = (self.root / name).resolve()
                if not file.is_relative_to(self.root) or not file.is_file():
                    return False
                with file.open('rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                        return False
            return bool(manifest.files)
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def status(self):
        with self.lock:
            running = self.thread is not None and self.thread.is_alive()
            phase, stage, error, log, progress = self.phase, self.stage, self.error, self.log, self.progress
        # 安装进行中不读取未完成文件；状态查询不反复散列GB级模型。
        if not running and phase == 'missing' and (self.root / '.runtime/model-ready.json').is_file():
            valid = self.ready()
            with self.lock:
                self.phase = 'ready' if valid else 'failed'
                self.stage = '抠图环境已就绪' if valid else '安装文件校验失败，请重试安装'
                self.error = '' if valid else self.stage
            return self.status()
        return {'phase': phase, 'stage': stage, 'error': error, 'log': log, 'ready': phase == 'ready', 'progress': progress}

    def start(self):
        with self.lock:
            if self.closing:
                raise RuntimeError('FrameDeck正在关闭，不能启动安装')
            if self.phase == 'ready' or (self.thread and self.thread.is_alive()):
                return
            self.phase, self.stage, self.error = 'installing', '准备独立抠图环境', ''
            self.log = ''
            self.progress = None
            self.thread = threading.Thread(target=self._install, daemon=True)
            self.thread.start()

    def _install(self):
        try:
            # 限定脚本和路径，无任意命令/模型地址输入；退出后必须验证成品。
            environment = os.environ.copy()
            environment['PYTHONUTF8'] = '1'
            with self.lock:
                if self.closing:
                    return
                process = subprocess.Popen([sys.executable, '-u', str(self.root / 'scripts/install-runtime.py')],
                    cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                    encoding='utf-8', errors='replace', env=environment, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                self.process = process
            recent = deque(maxlen=80)
            log_path = self.root / '.runtime/install.log'
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open('w', encoding='utf-8') as transcript:
                written = 0
                for line in process.stdout:
                    recent.append(line.strip())
                    if written < 16 * 1024**2:
                        transcript.write(line)
                        transcript.flush()
                        written += len(line.encode('utf-8'))
                    with self.lock:
                        if line.startswith('STAGE:'):
                            self.stage = line[6:].strip()
                            self.progress = None
                        if line.startswith('PROGRESS:'):
                            try:
                                self.progress = DownloadProgress.model_validate_json(line[9:].strip()).model_dump()
                            except ValueError:
                                self.progress = None
                            continue
                        self.log = line.strip()[-240:]
            code = process.wait()
            if code != 0 or not self.ready():
                meaningful = [line for line in recent if ('Error' in line or 'Exception' in line or 'timed out' in line)
                              and 'CalledProcessError' not in line and not line.startswith('Traceback')]
                cause = meaningful[-1] if meaningful else self.log
                if 'timed out' in cause or 'ReadTimeout' in cause:
                    cause = '模型下载连接超时；已下载内容保留，可以重试续传'
                raise RuntimeError(f'{cause[:400]}。详细日志：.runtime/install.log（退出码{code}）')
            with self.lock:
                self.phase, self.stage = 'ready', '抠图环境已就绪'
        except Exception as error:
            with self.lock:
                self.phase, self.stage, self.error = 'failed', '安装失败，可重新点击抠图重试', str(error)

    def close(self):
        with self.lock:
            self.closing = True
            process = self.process
        if process is None or process.poll() is not None:
            return
        # 仅结束由本控制器Popen创建且仍存活的安装进程树，不按进程名批量结束。
        if os.name == 'nt':
            result = subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                capture_output=True, timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if result.returncode and process.poll() is None:
                raise RuntimeError('无法停止FrameDeck拥有的安装进程，请检查安装日志')
        else:
            process.terminate()
        process.wait(timeout=15)
