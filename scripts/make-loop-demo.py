"""生成独立的已知12帧周期夹具，不读取用户素材；绿色背景角色及脚部运动。"""
import math
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw

root=Path(__file__).resolve().parents[1]
folder=root/'output'/'fixtures'/'loop-demo'
folder.mkdir(parents=True,exist_ok=True)
for index in range(48):
    angle=(index%12)*math.tau/12
    image=Image.new('RGB',(320,240),(0,240,0));draw=ImageDraw.Draw(image)
    draw.ellipse((130,30,180,80),fill=(160,95,40))
    draw.rectangle((140,78,170,150),fill=(120,65,35))
    draw.ellipse((160,45,167,52),fill=(240,210,150))
    hand=(175+int(math.cos(angle)*35),105+int(math.sin(angle)*30))
    draw.line([(164,90),hand],fill=(140,75,40),width=13)
    draw.ellipse((hand[0]-9,hand[1]-9,hand[0]+9,hand[1]+9),fill=(240,25,20))
    for direction in [-1,1]:
        foot=(155+int(math.cos(angle)*40*direction),180+int(math.sin(angle)*20*direction))
        draw.line([(155,145),foot],fill=(50,55,140),width=12)
        draw.rectangle((foot[0]-10,foot[1]-4,foot[0]+10,foot[1]+5),fill=(60,40,30))
    image.save(folder/f'frame-{index:03}.png')
target=root/'output'/'fixtures'/'loop-demo.mp4'
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-framerate','12','-i',str(folder/'frame-%03d.png'),'-frames:v','48','-an','-c:v','libx264','-crf','10','-pix_fmt','yuv420p','-threads','2',str(target)],check=True)
print(target)
