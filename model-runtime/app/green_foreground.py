"""固定透明度的已知绿幕前景色修正；不运行FBA网络或其非商用权重。

Foreground update adapted from FBA_Matting networks/models.py::fba_fusion,
revision 3e72bbe282f764d984090013c8334e2ff26a7731.

MIT License
Copyright (c) 2020 Marco Forte

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
import numpy as np


def foreground_color_step(alpha, image, foreground, background):
    """单次合成残差更新；返回未裁剪值以保持官方后续更新的顺序。"""
    return alpha*image+(1-alpha**2)*foreground-alpha*(1-alpha)*background


def refine_green_foreground(rgb, pixels, background_color, unknown):
    """调用方已确认均匀亮绿幕；两次固定残差更新，只改未知软边RGB。"""
    result=pixels.copy()
    selected=unknown&(pixels[...,3]>0)&(pixels[...,3]<255)
    alpha=pixels[selected,3,None]/255.
    # 次数在14验证/15动作/25姿势逐图验收前固定，不依据图片自动加深去绿。
    # 每次量化与已验收“正式结果再额外一次”协议保持一致；Alpha和硬种子不动。
    for _ in range(2):
        foreground=foreground_color_step(alpha,rgb[selected],result[selected,:3]/255.,background_color)
        result[selected,:3]=np.round(np.clip(foreground,0,1)*255).astype(np.uint8)
    count=int(np.count_nonzero(np.any(result[...,:3]!=pixels[...,:3],axis=2)))
    return result,count
