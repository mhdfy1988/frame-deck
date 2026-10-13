import importlib.util
from pathlib import Path
from types import SimpleNamespace


def test_installer_commands_use_only_own_environment(tmp_path, monkeypatch):
    script = Path(__file__).resolve().parents[1] / 'scripts/install-runtime.py'
    spec = importlib.util.spec_from_file_location('frame_installer', script)
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    installer.ROOT = tmp_path
    installer.RUNTIME = tmp_path / '.runtime'
    installer.ENV = installer.RUNTIME / 'model-env'
    installer.PYTHON = installer.ENV / 'Scripts/python.exe'
    created, commands = [], []
    monkeypatch.setattr(installer.shutil, 'disk_usage', lambda path: SimpleNamespace(free=20*1024**3))
    monkeypatch.setattr(installer.venv, 'create', lambda path, **kwargs: created.append(path))
    monkeypatch.setattr(installer, 'run', lambda args, **kwargs: commands.append((args,kwargs)))
    monkeypatch.setenv('FRAMEDECK_TORCH_PROFILE', 'cpu')
    installer.main()
    assert created == [installer.ENV]
    assert len(commands) == 4
    assert all(args[0] == str(installer.PYTHON) for args, _ in commands)
    assert commands[0][0][-1] == 'https://download.pytorch.org/whl/cpu'
    assert commands[2][1]['env']['HF_HOME'] == str(installer.RUNTIME / 'huggingface')
    assert commands[2][1]['env']['HF_HUB_DOWNLOAD_TIMEOUT'] == '120'
    assert commands[2][1]['env']['HF_HUB_ETAG_TIMEOUT'] == '30'


def test_installer_rejects_insufficient_disk(tmp_path, monkeypatch):
    import pytest
    script = Path(__file__).resolve().parents[1] / 'scripts/install-runtime.py'
    spec = importlib.util.spec_from_file_location('frame_installer_space', script)
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    installer.ROOT = tmp_path
    installer.RUNTIME = tmp_path / '.runtime'
    monkeypatch.setattr(installer.shutil, 'disk_usage', lambda path: SimpleNamespace(free=1))
    with pytest.raises(RuntimeError, match='12GB'):
        installer.main()


def test_valid_ready_marker_skips_download_and_install(tmp_path, monkeypatch):
    script = Path(__file__).resolve().parents[1] / 'scripts/install-runtime.py'
    spec = importlib.util.spec_from_file_location('frame_installer_reuse', script)
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    installer.ROOT = tmp_path
    installer.RUNTIME = tmp_path / '.runtime'
    monkeypatch.setattr('app.model_setup.ModelSetup.ready', lambda self: True)
    commands = []
    monkeypatch.setattr(installer, 'run', lambda *args, **kwargs: commands.append(args))
    installer.main()
    assert commands == []


def test_hidden_installer_forwards_grandchild_output():
    import subprocess
    import sys
    probe = Path(__file__).with_name('runtime_output_probe.py')
    result = subprocess.run([sys.executable, '-u', str(probe)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=15, check=True)
    assert 'PROGRESS:child-stdout' in result.stdout
    assert 'child-stderr' in result.stdout
