import json
import hashlib
from app.model_setup import ModelSetup


def installed(root):
    python = root / '.runtime/model-env/Scripts/python.exe'
    python.parent.mkdir(parents=True)
    python.write_bytes(b'unit-test-placeholder')
    model = root / 'model-runtime/.models/toonout/model.safetensors'
    model.parent.mkdir(parents=True)
    model.write_bytes(b'unit-test-model')
    marker = root / '.runtime/model-ready.json'
    marker.write_text(json.dumps({'formatVersion': 1, 'files': {
        model.relative_to(root).as_posix(): hashlib.sha256(model.read_bytes()).hexdigest()}}), encoding='utf-8')
    return model, marker


def test_missing_runtime_never_borrows_sibling(tmp_path):
    setup = ModelSetup(tmp_path)
    assert setup.status()['phase'] == 'missing'
    assert not setup.ready()


def test_valid_local_manifest_is_reused(tmp_path):
    installed(tmp_path)
    setup = ModelSetup(tmp_path)
    assert setup.status()['ready']


def test_corrupt_and_escaping_manifest_fail_explicitly(tmp_path):
    model, marker = installed(tmp_path)
    model.write_bytes(b'corrupted')
    assert ModelSetup(tmp_path).status()['phase'] == 'failed'
    marker.write_text(json.dumps({'formatVersion': 1, 'files': {'../../outside': 'bad'}}), encoding='utf-8')
    assert not ModelSetup(tmp_path).ready()


def test_install_failure_not_ready(tmp_path, monkeypatch):
    def fail(*args, **kwargs):
        raise OSError('test installer unavailable')
    monkeypatch.setattr('app.model_setup.subprocess.Popen', fail)
    setup = ModelSetup(tmp_path)
    setup._install()
    assert setup.status()['phase'] == 'failed'
    assert 'test installer unavailable' in setup.status()['error']


def test_close_only_targets_owned_process(tmp_path, monkeypatch):
    from types import SimpleNamespace
    calls = []
    process = SimpleNamespace(pid=12345, poll=lambda: None, wait=lambda **kwargs: calls.append('wait'))
    setup = ModelSetup(tmp_path)
    setup.process = process
    monkeypatch.setattr('app.model_setup.subprocess.run', lambda args, **kwargs: (calls.append(args) or SimpleNamespace(returncode=0)))
    setup.close()
    assert calls[0] == ['taskkill', '/PID', '12345', '/T', '/F']
    assert calls[1] == 'wait'


def test_failure_keeps_root_cause_and_log(tmp_path, monkeypatch):
    from types import SimpleNamespace
    process = SimpleNamespace(stdout=iter([
        'requests.exceptions.ReadTimeout: CDN read timed out\n',
        'subprocess.CalledProcessError: install failed\n']), wait=lambda: 1)
    monkeypatch.setattr('app.model_setup.subprocess.Popen', lambda *args, **kwargs: process)
    setup = ModelSetup(tmp_path)
    setup._install()
    assert '下载连接超时' in setup.status()['error']
    assert 'CalledProcessError' not in setup.status()['error']
    assert 'ReadTimeout' in (tmp_path / '.runtime/install.log').read_text(encoding='utf-8')


def test_download_progress_is_exposed(tmp_path, monkeypatch):
    from types import SimpleNamespace
    process = SimpleNamespace(stdout=iter([
        'STAGE:下载模型\n',
        'PROGRESS:{"file":"model.safetensors","downloaded":1024,"total":4096}\n',
    ]), wait=lambda: 1)
    monkeypatch.setattr('app.model_setup.subprocess.Popen', lambda *args, **kwargs: process)
    setup = ModelSetup(tmp_path)
    setup._install()
    assert setup.status()['progress'] == {'file': 'model.safetensors', 'downloaded': 1024, 'total': 4096}
