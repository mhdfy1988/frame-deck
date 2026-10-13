import subprocess
from pathlib import Path
import pytest
from PIL import Image, ImageDraw


def command(args):
    result = subprocess.run(args, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=30)
    assert result.returncode == 0, result.stderr.decode(errors="replace")


def make_fixture(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    source = directory / "source-images"
    source.mkdir(exist_ok=True)
    for index in range(48):
        image = Image.new("RGB", (320, 180), (30 + index * 4, 90, 145 - index * 2))
        draw = ImageDraw.Draw(image)
        draw.rectangle((8 + index * 5, 100, 40 + index * 5, 135), fill=(240, 223, 160))
        draw.text((28, 24), f"FRAME {index:02d}", fill="white", font_size=30)
        draw.text((29, 66), "24 FPS / SELF-MADE", fill=(220, 235, 220), font_size=14)
        image.save(source / f"{index:03d}.png")
    cfr = directory / "自制 动作测试.mp4"
    command(["ffmpeg", "-v", "error", "-y", "-framerate", "24", "-i", str(source / "%03d.png"),
             "-c:v", "libx264", "-threads", "2", "-g", "24", "-bf", "2", "-crf", "12",
             "-pix_fmt", "yuv420p", str(cfr)])
    return cfr


@pytest.fixture(scope="session")
def fixtures(tmp_path_factory):
    directory = tmp_path_factory.mktemp("source-videos")
    cfr = make_fixture(directory)
    offset = directory / "offset.mp4"
    command(["ffmpeg", "-v", "error", "-y", "-i", str(cfr), "-c", "copy", "-output_ts_offset", "5", str(offset)])
    rotated = directory / "rotated.mov"
    command(["ffmpeg", "-v", "error", "-y", "-display_rotation:v:0", "90", "-i", str(cfr), "-c", "copy", str(rotated)])
    sar = directory / "sar.mp4"
    command(["ffmpeg", "-v", "error", "-y", "-i", str(cfr), "-vf", "setsar=16/15", "-c:v", "libx264", "-threads", "2", str(sar)])
    vfr = directory / "vfr.mp4"
    command(["ffmpeg", "-v", "error", "-y", "-i", str(cfr), "-vf", "select='not(mod(n,3))+eq(n,1)'", "-fps_mode", "vfr", "-c:v", "libx264", "-threads", "2", str(vfr)])
    ntsc = directory / "ntsc.mp4"
    command(["ffmpeg", "-v", "error", "-y", "-framerate", "30000/1001", "-i", str(directory / "source-images" / "%03d.png"), "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", str(ntsc)])
    return {"cfr": cfr, "offset": offset, "rotated": rotated, "sar": sar, "vfr": vfr, "ntsc": ntsc}
