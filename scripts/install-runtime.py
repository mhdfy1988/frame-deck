"""官方pip与Hugging Face SDK安装固定模型版本，成功后原子发布就绪清单。"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import venv
from filelock import FileLock

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.runtime'
ENV = RUNTIME / 'model-env'
PYTHON = ENV / 'Scripts/python.exe'


def run(args, timeout=3600, env=None):
    subprocess.run(args, cwd=ROOT, env=env, check=True, timeout=timeout,
                   # Windows隐藏子进程必须显式传递管道，否则孙进程输出不会进入安装日志。
                   stdout=sys.stdout, stderr=sys.stderr,
                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def main():
    RUNTIME.mkdir(exist_ok=True)
    with FileLock(str(RUNTIME / 'install.lock'), timeout=1):
        # 独立校验完成后可直接复用，不因旧页面的失败状态重跑下载。
        sys.path.insert(0, str(ROOT))
        from app.model_setup import ModelSetup
        if ModelSetup(ROOT).ready():
            print('STAGE:已校验的本地抠图环境可直接复用', flush=True)
            return
        if shutil.disk_usage(ROOT).free < 12 * 1024**3:
            raise RuntimeError('首次安装请至少预留12GB空闲空间（环境、下载缓存与两套模型）')
        print('STAGE:创建FrameDeck独立抠图环境', flush=True)
        if not PYTHON.is_file():
            venv.create(ENV, with_pip=True)
        profile = os.environ.get('FRAMEDECK_TORCH_PROFILE', 'auto')
        if profile not in {'auto', 'cpu', 'cu128'}:
            raise ValueError('FRAMEDECK_TORCH_PROFILE仅支持auto/cpu/cu128')
        if profile == 'auto':
            nvidia = shutil.which('nvidia-smi')
            profile = 'cu128' if nvidia and subprocess.run([nvidia, '-L'], capture_output=True,
                timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).returncode == 0 else 'cpu'
        print(f'STAGE:安装PyTorch 2.8.0 / {profile}（首次下载可能较大）', flush=True)
        run([str(PYTHON), '-m', 'pip', 'install', 'torch==2.8.0', 'torchvision==0.23.0',
             '--index-url', f'https://download.pytorch.org/whl/{profile}'])
        print('STAGE:安装固定版本模型依赖', flush=True)
        run([str(PYTHON), '-m', 'pip', 'install', '-r', str(ROOT / 'model-runtime/requirements.txt')])
        environment = os.environ.copy()
        environment['HF_HOME'] = str(RUNTIME / 'huggingface')
        environment['PYTHONUTF8'] = '1'
        # 官方SDK默认仅10秒，慢速首连接容易失败；仍保留其缓存续传和完整校验。
        environment['HF_HUB_DOWNLOAD_TIMEOUT'] = '120'
        environment['HF_HUB_ETAG_TIMEOUT'] = '30'
        print('STAGE:下载固定版本ToonOut与BiRefNet HR模型，支持缓存续传', flush=True)
        run([str(PYTHON), '-u', str(ROOT / 'model-runtime/scripts/install_model.py')], env=environment)
        print('STAGE:校验模型加载和运行设备', flush=True)
        run([str(PYTHON), str(ROOT / 'scripts/verify-model-runtime.py'), profile], env=environment)
        print('STAGE:安装完成', flush=True)


if __name__ == '__main__':
    main()
