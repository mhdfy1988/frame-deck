"""用真实Windows子进程验证安装器转发日志，不下载模型。"""
import importlib.util
from pathlib import Path
import sys

script = Path(__file__).resolve().parents[1] / 'scripts/install-runtime.py'
spec = importlib.util.spec_from_file_location('runtime_output_probe', script)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
installer.run([sys.executable, '-u', '-c',
    'import sys; print("PROGRESS:child-stdout",flush=True); print("child-stderr",file=sys.stderr,flush=True)'])
