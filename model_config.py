"""私有模型依赖的唯一Python配置口径；不加载模型或修改环境。"""
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


@dataclass(frozen=True)
class ModelRuntime:
    root: Path
    python: Path


def resolve_model_runtime(environment: Mapping[str, str] | None = None) -> ModelRuntime:
    env = os.environ if environment is None else environment
    project = Path(__file__).resolve().parent
    root = project / 'model-runtime'
    python = project / '.runtime' / 'model-env' / 'Scripts' / 'python.exe'
    return ModelRuntime(root, python)
