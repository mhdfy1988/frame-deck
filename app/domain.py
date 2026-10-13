"""时间、采样与协议领域规则，独立于HTTP和FFmpeg。"""
from bisect import bisect_left
from dataclasses import dataclass
from fractions import Fraction
from math import ceil
from pydantic import BaseModel, ConfigDict, Field
from .config import LIMITS, Limits


class DomainError(ValueError):
    pass


def rational(value) -> Fraction:
    try:
        return Fraction(str(value))
    except (ValueError, ZeroDivisionError, OverflowError) as exc:
        raise DomainError("时间不是有效数字") from exc


def exact(value: Fraction) -> str:
    return f"{value.numerator}/{value.denominator}"


class ExtractionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    videoId: str = Field(pattern=r"^[a-f0-9]{32}$")
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    fps: int = Field(ge=1, le=60, strict=True)


@dataclass(frozen=True)
class SourceFrame:
    index: int
    pts: int
    time: Fraction
    duration: Fraction


@dataclass(frozen=True)
class Sample:
    target: Fraction
    duration: Fraction
    source: SourceFrame


def targets(start, end, fps: int, duration: Fraction, width: int, height: int,
            limits: Limits = LIMITS) -> tuple[Fraction, Fraction, list[Fraction]]:
    start, end = rational(start), rational(end)
    # 页面元信息的末尾小数只是精确时长的显示别名，不凭任意容差延长区间。
    if end == rational(float(duration)):
        end = duration
    if isinstance(fps, bool) or not isinstance(fps, int) or not 1 <= fps <= 60:
        raise DomainError("每秒帧数须为1–60的整数")
    if not 0 <= start < end <= duration:
        raise DomainError("时间范围超出视频时长")
    if end - start > limits.segment_seconds:
        raise DomainError(f"单次片段不能超过{limits.segment_seconds}秒")
    count = ceil((end - start) * fps)
    if count > limits.max_frames:
        raise DomainError(f"单次最多{limits.max_frames}帧，请缩短范围或降低频率")
    if width * height * count * 4 > limits.rgba_bytes:
        raise DomainError("帧像素总量超过2GiB预算，请缩短范围或降低频率")
    return start, end, [start + Fraction(k, fps) for k in range(count)]


def choose_samples(grid: list[Fraction], end: Fraction,
                   frames: list[SourceFrame]) -> list[Sample]:
    if not grid:
        raise DomainError("没有采样时刻")
    candidates = [frame for frame in frames if grid[0] <= frame.time < end]
    if not candidates:
        raise DomainError("所选范围内没有源画面，请扩大范围")
    times = [frame.time for frame in candidates]
    if any(a >= b for a, b in zip(times, times[1:])):
        raise DomainError("源展示时间不严格递增，暂不支持该视频")
    samples = []
    for k, target in enumerate(grid):
        position = bisect_left(times, target)
        nearby = candidates[max(0, position - 1):min(len(candidates), position + 1)]
        chosen = min(nearby, key=lambda frame: (abs(frame.time - target), frame.time))
        stop = grid[k + 1] if k + 1 < len(grid) else end
        samples.append(Sample(target, stop - target, chosen))
    return samples


def manifest(sequence_id: str, name: str, source: dict, width: int, height: int,
             start: Fraction, end: Fraction, fps: int, samples: list[Sample]) -> dict:
    return {
        "formatVersion": 2, "id": sequence_id, "name": name, "loop": False,
        "source": source, "canvas": {"width": width, "height": height},
        "extraction": {"startSeconds": exact(start), "endSeconds": exact(end),
                       "fps": fps, "selection": "nearest-in-range-tie-earlier",
                       "interval": "[start,end)", "durationSeconds": exact(end - start)},
        "frames": [{
            "id": f"{sequence_id}-{i + 1:06d}",
            "image": f"frames/frame_{i + 1:06d}.png",
            "durationMs": float(sample.duration * 1000),
            "durationSeconds": exact(sample.duration),
            "sampleTimeMs": float(sample.target * 1000),
            "sampleTimeSeconds": exact(sample.target),
            "sourceTimeMs": float(sample.source.time * 1000),
            "sourceTimeSeconds": exact(sample.source.time),
            "sourceFrameIndex": sample.source.index, "sourcePts": sample.source.pts,
        } for i, sample in enumerate(samples)],
    }


def adapt_v1(sequence: dict) -> dict:
    """显式旧格式导出适配，累计舍入；不能制造不存在的源PTS。"""
    if sequence.get("formatVersion") != 2:
        raise DomainError("适配输入必须是v2清单")
    total = Fraction(0)
    rounded = 0
    converted = []
    for frame in sequence["frames"]:
        total += Fraction(frame["durationSeconds"]) * 1000
        boundary = round(total)
        delta = boundary - rounded
        if delta < 1:
            raise DomainError("旧v1无法表达小于1毫秒的帧时长")
        rounded = boundary
        converted.append({"id": frame["id"], "image": frame["image"],
                          "durationMs": delta, "sourceTimeMs": frame["sourceTimeMs"]})
    return {"formatVersion": 1, "id": sequence["id"], "name": sequence["name"],
            "canvas": sequence["canvas"], "loop": sequence["loop"],
            "source": {"kind": "video"}, "frames": converted}
