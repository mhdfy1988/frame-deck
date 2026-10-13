"""仅生成自制验收视频，不读取用户素材。"""
import runpy
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
helpers=runpy.run_path(str(ROOT/'tests'/'conftest.py'))
source=helpers['make_fixture'](ROOT/'output'/'fixtures')
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(source),'-c','copy','-output_ts_offset','5',str(source.parent/'offset.mp4')],check=True)
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=1920x1080:rate=30:duration=4','-an','-c:v','libx264','-preset','ultrafast','-threads','2',str(source.parent/'large.mp4')],check=True)
print(source)
