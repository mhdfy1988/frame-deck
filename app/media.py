"""FFmpeg适配：CPU、有界子进程、真实源时间与输出校验。"""
import json
import logging
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from threading import Event
from typing import Callable
from .config import LIMITS, Limits
from .domain import DomainError, SourceFrame, exact, rational


class Cancelled(Exception):
    pass


def directory_bytes(root: Path) -> int:
    # Windows DirEntry缓存目录枚举中的文件属性；避免每帧重复is_file/stat系统调用。
    # 不跟随符号链接或junction；配额始终真实扫描，不用过期缓存冒充当前使用量。
    total = 0
    with os.scandir(root) as entries:
        for entry in entries:
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
                raise DomainError("缓存包含链接，拒绝扫描或清理")
            if stat.S_ISDIR(info.st_mode):
                total += directory_bytes(Path(entry.path))
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
    return total


def remove_owned(path: Path, root: Path):
    """只删除本工具直接分配的缓存子目录，拒绝根目录和逃逸。"""
    resolved, base = path.resolve(), root.resolve()
    if resolved == base or resolved.parent != base or path.is_symlink():
        raise DomainError("拒绝清理非任务目录")
    if resolved.exists():
        shutil.rmtree(resolved)


def binary(name: str) -> str:
    configured = os.environ.get(f"FRAMES_{name.upper()}", name)
    found = shutil.which(configured)
    if not found:
        raise DomainError(f"缺少{name}，请安装FFmpeg或配置FRAMES_{name.upper()}")
    return found


def run_process(args: list[str], timeout: float, cancel: Event | None = None,
                monitor: Callable[[], None] | None = None,
                limits: Limits = LIMITS) -> tuple[str, str]:
    # 临时日志独立限额，不通过PIPE阻塞；结束前确认子进程已退出。
    with tempfile.TemporaryDirectory(prefix="frames-process-") as temp:
        outpath, errpath = Path(temp) / "stdout", Path(temp) / "stderr"
        with outpath.open("wb") as out, errpath.open("wb") as err:
            proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            deadline = time.monotonic() + timeout
            try:
                while True:
                    if cancel is not None and cancel.is_set():
                        raise Cancelled()
                    if time.monotonic() > deadline:
                        raise DomainError("处理超时，已停止本次任务；请缩短视频或范围")
                    if outpath.stat().st_size + errpath.stat().st_size > limits.max_log_bytes:
                        raise DomainError("探测/日志信息超限，已停止本次任务")
                    if monitor:
                        monitor()
                    if proc.poll() is not None:
                        break
                    time.sleep(0.05)
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=3)
            code = proc.returncode
        stdout = outpath.read_text(encoding="utf-8", errors="replace")
        stderr = errpath.read_text(encoding="utf-8", errors="replace")
        if code != 0:
            # 完整诊断仅记录服务端；页面不暴露本机路径或用户视频名。
            logging.getLogger(__name__).warning("media exit=%s: %s", code, stderr[-4000:])
            reason = "表达式解析失败" if "Error while parsing expression" in stderr else "文件损坏或编码不支持"
            raise DomainError(f"视频探测或解码失败：{reason}，请查看本机服务日志")
        return stdout, stderr


@dataclass(frozen=True)
class Video:
    stream_index: int
    width: int
    height: int
    coded_width: int
    coded_height: int
    rotation: int
    sar: str
    fps: Fraction
    time_base: Fraction
    origin_pts: int
    duration: Fraction
    frames: tuple[SourceFrame, ...]
    codec: str
    variable: bool

    def public(self):
        return {"width": self.width, "height": self.height, "codedWidth": self.coded_width,
                "codedHeight": self.coded_height, "rotation": self.rotation,
                "sampleAspectRatio": self.sar, "fps": float(self.fps),
                "duration": float(self.duration), "durationSeconds": exact(self.duration),
                "sourceFrameCount": len(self.frames), "variableFrameRate": self.variable,
                "codec": self.codec, "timeBase": exact(self.time_base),
                "originPts": self.origin_pts, "alphaSupported": False}


def probe(path: Path, limits: Limits = LIMITS) -> Video:
    output, _ = run_process([binary("ffprobe"), "-v", "error", "-protocol_whitelist", "file,pipe",
                             "-show_streams", "-show_format", "-of", "json", str(path)], limits.probe_seconds)
    data = json.loads(output)
    streams = [stream for stream in data.get("streams", []) if stream.get("codec_type") == "video"
               and not stream.get("disposition", {}).get("attached_pic")]
    if not streams:
        raise DomainError("文件没有可用的视频画面轨")
    stream = streams[0]
    coded_w, coded_h = int(stream.get("width", 0)), int(stream.get("height", 0))
    if not 1 <= coded_w <= 3840 or not 1 <= coded_h <= 3840 or coded_w * coded_h > 3840 * 2160:
        raise DomainError("视频显示尺寸超过4K预算")
    if stream.get("color_transfer") in {"smpte2084", "arib-std-b67"} or stream.get("color_primaries") == "bt2020":
        raise DomainError("第一版暂不支持HDR/BT.2020视频，请先转换为SDR")
    reported = rational(stream.get("duration") or data.get("format", {}).get("duration") or "0")
    if not 0 < reported <= limits.source_seconds:
        raise DomainError(f"源视频须有有效时长且不超过{limits.source_seconds}秒")
    fps = rational(stream.get("avg_frame_rate", "0/1"))
    base = rational(stream.get("time_base", "0/1"))
    if fps <= 0 or base <= 0:
        raise DomainError("视频缺少有效帧率或时间基准")
    sar_raw = stream.get("sample_aspect_ratio", "1:1")
    sar = rational(sar_raw.replace(":", "/")) if sar_raw not in {"N/A", "0:1"} else Fraction(1)
    if not Fraction(1, 4) <= sar <= 4:
        raise DomainError("像素宽高比超出支持范围")
    rotation_raw = next((entry["rotation"] for entry in stream.get("side_data_list", [])
                         if "rotation" in entry), stream.get("tags", {}).get("rotate", 0))
    rotation = int(rotation_raw) % 360
    if float(rotation_raw) % 90:
        raise DomainError("第一版只支持90度倍数的旋转")
    display_w, display_h = max(1, round(coded_w * sar)), coded_h
    if rotation in {90, 270}:
        display_w, display_h = display_h, display_w
    if display_w * display_h > 3840 * 2160 or max(display_w, display_h) > 3840:
        raise DomainError("标准化显示尺寸超过4K预算")
    output, _ = run_process([binary("ffprobe"), "-v", "error", "-threads", "2",
                             "-protocol_whitelist", "file,pipe", "-select_streams", str(stream["index"]),
                             "-show_frames", "-show_entries", "frame=best_effort_timestamp,duration,pkt_duration,width,height",
                             "-of", "json", str(path)], limits.probe_seconds)
    records = json.loads(output).get("frames", [])
    if not records or len(records) > limits.max_source_frames:
        raise DomainError("源帧数为空或超出探测预算")
    try:
        origin = int(records[0]["best_effort_timestamp"])
        frames = []
        for index, record in enumerate(records):
            if int(record["width"]) != coded_w or int(record["height"]) != coded_h:
                raise DomainError("源视频中途改变尺寸，暂不支持")
            pts = int(record["best_effort_timestamp"])
            ticks = int(record.get("duration", record.get("pkt_duration", 0)))
            frames.append(SourceFrame(index, pts, (pts - origin) * base, ticks * base))
    except (KeyError, TypeError, ValueError) as exc:
        raise DomainError("缺少可追溯的源PTS或画面信息") from exc
    if any(a.time >= b.time for a, b in zip(frames, frames[1:])) or frames[-1].duration <= 0:
        raise DomainError("展示时间不递增或片尾缺少时长，暂不支持")
    duration = frames[-1].time + frames[-1].duration
    if duration > limits.source_seconds:
        raise DomainError("实际源视频时长超出预算")
    deltas = {b.time - a.time for a, b in zip(frames, frames[1:])}
    return Video(stream["index"], display_w, display_h, coded_w, coded_h, rotation,
                 exact(sar), fps, base, origin, duration, tuple(frames),
                 stream.get("codec_name", "unknown"), len(deltas) > 1)


def selection_expression(indices: list[int]) -> str:
    if not indices or indices != sorted(set(indices)) or any(index < 0 for index in indices):
        raise DomainError("选帧索引须非空、递增且唯一")
    # FFmpeg表达式树深度上限100；平衡加法树避免长链选帧被误报ENOMEM。
    def combine(values):
        if len(values) == 1:
            return f"eq(n\\,{values[0]})"
        middle = len(values) // 2
        return f"({combine(values[:middle])}+{combine(values[middle:])})"
    return combine(indices)


def decode_selected(path: Path, video: Video, indices: list[int], destination: Path,
                    cancel: Event, timeout: float, monitor: Callable[[], None],
                    limits: Limits = LIMITS):
    select = selection_expression(indices)
    filters = f"select='{select}',scale={video.width}:{video.height},setsar=1,showinfo"
    _, stderr = run_process([
        binary("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "info", "-y",
        "-threads", "2", "-filter_threads", "2", "-protocol_whitelist", "file,pipe",
        "-copyts", "-i", str(path), "-map", f"0:{video.stream_index}",
        "-an", "-sn", "-dn", "-vf", filters, "-fps_mode", "passthrough",
        "-frames:v", str(len(indices)), "-c:v", "png", "-threads", "2",
        "-pix_fmt", "rgb24", str(destination / "source_%06d.png"),
    ], timeout, cancel, monitor, limits)
    actual_pts = [int(match) for match in re.findall(r"\bn:\s*\d+\s+pts:\s*(-?\d+)\s+pts_time:", stderr)]
    expected_pts = [video.frames[index].pts for index in indices]
    if actual_pts != expected_pts:
        raise DomainError("解码画面PTS与探测记录不一致，拒绝发布结果")
    generated = sorted(destination.glob("source_*.png"))
    if len(generated) != len(indices):
        raise DomainError("解码输出数量不一致，拒绝发布结果")
    return dict(zip(indices, generated))


def normalize_preview(path: Path, video: Video, destination: Path,
                      monitor: Callable[[], None], limits: Limits = LIMITS):
    """仅重封装预览，不重编码；抽帧仍读取原始文件和原PTS。"""
    run_process([
        binary("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-protocol_whitelist", "file,pipe", "-copyts", "-start_at_zero", "-i", str(path),
        "-map", f"0:{video.stream_index}", "-an", "-sn", "-dn", "-c:v", "copy", str(destination),
    ], limits.probe_seconds, monitor=monitor, limits=limits)
    normalized = probe(destination, limits)
    if (normalized.origin_pts != 0 or normalized.duration != video.duration
            or (normalized.width, normalized.height) != (video.width, video.height)
            or [(frame.time, frame.duration) for frame in normalized.frames]
            != [(frame.time, frame.duration) for frame in video.frames]):
        raise DomainError("预览时间轴无法无损归一化，请先转换视频；未发布错位预览")
    return destination
