"""本机有界配置；不读取其他工具运行时。"""
import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Limits:
    upload_bytes: int = 256 * 1024**2
    source_seconds: int = 600
    segment_seconds: int = 60
    max_frames: int = 600
    rgba_bytes: int = 2 * 1024**3
    job_bytes: int = 2 * 1024**3
    cache_bytes: int = 4 * 1024**3
    probe_seconds: float = 30
    job_seconds: float = 120
    ttl_seconds: int = 3600
    max_assets: int = 3
    max_jobs: int = 3
    max_source_frames: int = 120_000
    max_log_bytes: int = 32 * 1024**2


LIMITS = Limits()
CACHE = Path(os.environ.get("FRAMEDECK_CACHE", str(ROOT / ".cache"))).resolve()
