from fastapi.testclient import TestClient
from app.main import create_app
from model_config import resolve_model_runtime
from app.config import ROOT
from app.model_setup import ModelSetup


def test_only_standalone_entry_and_assets(tmp_path):
    app = create_app(tmp_path / 'cache')
    app.state.model_setup = ModelSetup(tmp_path)
    with TestClient(app) as client:
        response = client.get('/')
        assert response.status_code == 200
        assert 'FrameDeck' in response.text
        assert '/workflow' not in response.text
        for path in ['/workflow', '/projects', '/javascript-preview', '/api/character-projects']:
            assert client.get(path).status_code == 404
        assert client.get('/api/model-runtime').json()['phase'] == 'missing'


def test_model_runtime_is_inside_this_project():
    runtime = resolve_model_runtime({'FRAMES_MATTING_ROOT': 'D:/never-use', 'FRAMES_MODEL_PYTHON': 'bad'})
    assert runtime.root == ROOT / 'model-runtime'
    assert runtime.python == ROOT / '.runtime/model-env/Scripts/python.exe'
