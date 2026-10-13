"""模型蒙版冻结后的局部颜色去绿；FFmpeg仅计算RGB，不重算Alpha。"""
import subprocess

import numpy as np
from scipy.ndimage import distance_transform_edt

FILTER = 'despill=type=green:mix=0.5:expand=0:red=0:green=-1:blue=0:brightness=0:alpha=0'

def local_green_despill(pixels, ffmpeg='ffmpeg'):
    if pixels.dtype != np.uint8 or pixels.ndim != 3 or pixels.shape[2] != 4:
        raise ValueError('局部去绿需要8位RGBA')
    alpha=pixels[:,:,3]/255.
    mask=alpha>=.5
    inside=distance_transform_edt(mask)
    outside=distance_transform_edt(~mask)
    band=(alpha>0)&np.where(mask,inside<=2,outside<=2)
    core=(alpha>=.99)&(inside>=3)
    selected=np.zeros(alpha.shape,bool)
    if core.any():
        distance,indices=distance_transform_edt(~core,return_indices=True)
        rgb=pixels[:,:,:3]/255.
        donor=pixels[:,:,:3][indices[0],indices[1]]/255.
        excess=rgb[:,:,1]-rgb[:,:,[0,2]].max(axis=2)
        reference=donor[:,:,1]-donor[:,:,[0,2]].max(axis=2)
        selected=band&(distance<=6)&(excess>reference+.04)&(excess>.04)
    result=pixels.copy()
    details={'method':'ffmpeg-local-despill-v1','selected_pixels':int(selected.sum()),'changed_rgb_pixels':0}
    if not selected.any():
        details['skip_reason']='no-supported-green-edge'
        return result,details
    height,width=pixels.shape[:2]
    try:
        process=subprocess.run([str(ffmpeg),'-v','error','-threads','2','-filter_threads','2',
                                '-f','rawvideo','-pixel_format','rgba','-video_size',f'{width}x{height}',
                                '-i','pipe:0','-vf',FILTER,'-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],
                               input=pixels.tobytes(),capture_output=True,timeout=20,check=True)
    except (OSError,subprocess.SubprocessError) as exc:
        raise RuntimeError('FFmpeg局部去绿失败，未返回旧处理结果') from exc
    if len(process.stdout)!=pixels.size:
        raise RuntimeError('FFmpeg局部去绿输出尺寸不一致')
    corrected=np.frombuffer(process.stdout,np.uint8).reshape(pixels.shape)
    result[selected,:3]=corrected[selected,:3]
    details['changed_rgb_pixels']=int(np.any(result[:,:,:3]!=pixels[:,:,:3],axis=2).sum())
    if not np.array_equal(result[:,:,3],pixels[:,:,3]) or not np.array_equal(result[~band],pixels[~band]):
        raise RuntimeError('局部去绿违反透明度或内部颜色保护')
    return result,details
