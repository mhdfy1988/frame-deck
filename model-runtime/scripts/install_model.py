"""安装固定版本 HR 与 ToonOut 到本项目，不依赖旧桌面应用目录。"""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.engine import MODEL_ID, MODEL_REVISION, ROOT
from huggingface_hub import snapshot_download, hf_hub_download
from huggingface_hub import get_hf_file_metadata, hf_hub_url
import hashlib
from scripts.prepare_toonout_local import main as prepare_toonout, BASE_REVISION, TOON_REVISION
from scripts.download_progress import enable_progress
enable_progress()
def verify_file(repo, revision, filename, local):
    metadata = get_hf_file_metadata(hf_hub_url(repo, filename, revision=revision), timeout=30)
    with Path(local).open('rb') as stream:
        if len(metadata.etag) == 64:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        elif len(metadata.etag) == 40:
            content = stream.read()
            actual = hashlib.sha1(b'blob '+str(len(content)).encode()+b'\0'+content).hexdigest()
        else:
            raise RuntimeError(f'未知模型文件校验格式：{filename}')
    if actual != metadata.etag:
        raise RuntimeError(f'模型文件校验失败：{repo}/{filename}')


def verify_directory(repo, revision, directory):
    for file in Path(directory).iterdir():
        if file.is_file():
            verify_file(repo, revision, file.name, file)


hr = snapshot_download(MODEL_ID, revision=MODEL_REVISION,
    local_dir=str(ROOT / ".models/birefnet-hr-matting"),
    allow_patterns=["*.py", "config.json", "model.safetensors", "README.md", "LICENSE*"])
verify_directory(MODEL_ID, MODEL_REVISION, hr)
base = snapshot_download("ZhengPeng7/BiRefNet",revision=BASE_REVISION,
    allow_patterns=["*.py","config.json"])
verify_directory('ZhengPeng7/BiRefNet', BASE_REVISION, base)
checkpoint = hf_hub_download("joelseytre/toonout","birefnet_finetuned_toonout.pth",revision=TOON_REVISION)
verify_file('joelseytre/toonout', TOON_REVISION, 'birefnet_finetuned_toonout.pth', checkpoint)
prepare_toonout()
print("HR and ToonOut models installed.")
