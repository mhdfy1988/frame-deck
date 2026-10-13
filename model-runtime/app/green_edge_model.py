"""均匀亮绿软边细化器；随机初始化训练，不依赖受限精修权重。"""
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F


class GreenPatchRefiner(nn.Module):
    def __init__(self, residual_scale=.5):
        super().__init__()
        if not 0 < residual_scale <= 1:
            raise ValueError('残差幅度必须在0到1之间')
        self.residual_scale = residual_scale
        def block(cin, cout):
            return nn.Sequential(nn.Conv2d(cin,cout,3,padding=1),nn.GroupNorm(4,cout),nn.SiLU(),
                                 nn.Conv2d(cout,cout,3,padding=1),nn.GroupNorm(4,cout),nn.SiLU())
        self.enc1, self.enc2, self.enc3 = block(7,16), block(16,32), block(32,48)
        self.dec2, self.dec1 = block(80,32), block(48,16)
        self.head = nn.Conv2d(16,1,1)
        nn.init.zeros_(self.head.weight)
        nn.init.zeros_(self.head.bias)

    def forward(self, value):
        a = self.enc1(value)
        b = self.enc2(F.avg_pool2d(a,2))
        c = self.enc3(F.avg_pool2d(b,2))
        d = self.dec2(torch.cat((F.interpolate(c,size=b.shape[-2:],mode='bilinear',align_corners=False),b),1))
        e = self.dec1(torch.cat((F.interpolate(d,size=a.shape[-2:],mode='bilinear',align_corners=False),a),1))
        return (value[:,6:7] + self.residual_scale*self.head(e).tanh()).clamp(0,1)


def model_inputs(rgb, background, coarse):
    rgb, coarse = np.asarray(rgb,dtype=np.float32), np.asarray(coarse,dtype=np.float32)
    background = np.asarray(background,dtype=np.float32)
    if rgb.ndim != 3 or rgb.shape[-1] != 3 or coarse.shape != rgb.shape[:2] or background.shape != (3,):
        raise ValueError('RGB、粗Alpha、背景色尺寸不一致')
    if not all(np.isfinite(x).all() for x in (rgb,coarse,background)):
        raise ValueError('输入包含非有限值')
    return np.ascontiguousarray(np.concatenate((rgb,np.broadcast_to(background,rgb.shape),coarse[...,None]),axis=-1).transpose(2,0,1))


def conservative_soft_alpha(coarse, predicted):
    """低透明度不增厚、接近实心不削薄；这是明确的限定细化协议，不纠正强置信度错误。"""
    result=np.clip(predicted,0,1).copy()
    low=coarse<=.1
    high=coarse>=.9
    result[low]=np.minimum(result[low],coarse[low])
    result[high]=np.maximum(result[high],coarse[high])
    return result


def tiled_predict(model,rgb,background,coarse,unknown,patch=128,halo=16):
    """只处理有未知区的原尺寸块；未知区以外原样保留，不访问真值。"""
    height,width = coarse.shape
    value = model_inputs(rgb,background,coarse)
    value = np.pad(value,((0,0),(halo,halo+patch),(halo,halo+patch)),mode='edge')
    result = coarse.copy()
    with torch.inference_mode():
        for y in range(0,height,patch):
            for x in range(0,width,patch):
                h,w = min(patch,height-y),min(patch,width-x)
                selected = unknown[y:y+h,x:x+w]
                if not selected.any():
                    continue
                tensor=torch.from_numpy(value[:,y:y+patch+2*halo,x:x+patch+2*halo][None].copy())
                predicted=model(tensor)[0,0,halo:halo+h,halo:halo+w].numpy()
                result[y:y+h,x:x+w][selected]=predicted[selected]
    return result
