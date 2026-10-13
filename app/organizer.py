"""整理领域与输出适配：只收M1帧身份，不接外部文件或客户端时长。"""
from copy import deepcopy
from fractions import Fraction
from typing import Annotated
from pydantic import BaseModel, ConfigDict, Field
from .domain import DomainError, exact


class HandoffRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    jobId: str = Field(pattern=r"^[a-f0-9]{32}$")


class EditExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    frameIds: list[Annotated[str, Field(strict=True, max_length=80, pattern=r"^[a-f0-9]{32}-[0-9]{6}$")]] = Field(min_length=1, max_length=600)


def edited_manifest(sequence: dict, frame_ids: list[str], identity: str) -> dict:
    if sequence.get("formatVersion") != 2:
        raise DomainError("整理只支持M1的v2结果")
    originals = {frame["id"]: frame for frame in sequence["frames"]}
    if not frame_ids or len(frame_ids) > 600 or len(set(frame_ids)) != len(frame_ids):
        raise DomainError("整理序列不能为空、重复引用或超过600帧")
    if any(frame_id not in originals for frame_id in frame_ids):
        raise DomainError("整理序列包含不属于原任务的帧")
    elapsed = Fraction(0)
    frames = []
    for index, frame_id in enumerate(frame_ids):
        frame = deepcopy(originals[frame_id])
        frame["image"] = f"frames/frame_{index + 1:06d}.png"
        frame["sequenceTimeSeconds"] = exact(elapsed)
        frame["sequenceTimeMs"] = float(elapsed * 1000)
        duration = Fraction(frame["durationSeconds"])
        if duration <= 0:
            raise DomainError("原帧时长无效")
        elapsed += duration
        frames.append(frame)
    return {
        "formatVersion": 3, "id": identity, "name": sequence["name"] + "-整理",
        "canvas": deepcopy(sequence["canvas"]), "loop": sequence["loop"],
        "source": deepcopy(sequence["source"]),
        "originalExtraction": deepcopy(sequence["extraction"]),
        "derivation": {"kind": "manual-frame-organization", "parentSequenceId": sequence["id"],
                       "parentFormatVersion": 2, "originalFrameCount": len(originals),
                       "removedFrameIds": [key for key in originals if key not in set(frame_ids)],
                       "durationPolicy": "retain-surviving-frame-durations"},
        "durationSeconds": exact(elapsed), "durationMs": float(elapsed * 1000), "frames": frames,
    }
