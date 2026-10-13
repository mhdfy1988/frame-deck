"""原始分辨率抠像与前景颜色恢复；色底约束和语义模型各司其职。"""
from __future__ import annotations
from dataclasses import dataclass
import os
os.environ.setdefault("NUMBA_NUM_THREADS", "4")
import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, binary_erosion, binary_propagation, label
from pymatting import estimate_alpha_cf, estimate_foreground_ml
from app.green_foreground import refine_green_foreground

@dataclass(frozen=True)
class Background:
    color: np.ndarray
    tolerance: float
    uniform: bool
    chroma_channel: int | None
    corner_matches: tuple[bool, ...] = ()

def partial_green_evidence(background: Background) -> bool:
    """相邻两角共同确认幕布；拒绝对角色块伪装的复杂边框。"""
    matches = background.corner_matches
    return (not background.uniform and background.chroma_channel == 1 and len(matches) == 4
            and any(matches[a] and matches[b] for a,b in ((0,1),(0,2),(1,3),(2,3))))

def green_exterior_mask(rgb: np.ndarray, alpha: np.ndarray, background: Background) -> np.ndarray:
    """边框低Alpha种子在近幕布色中传播，避开细小主体；不识别闭合孔。"""
    if background.chroma_channel != 1:
        return np.zeros(alpha.shape, dtype=bool)
    # 不腐蚀主体，单像素手指/饰品也应成为传播屏障。
    protected = binary_dilation(alpha > .5, iterations=1)
    possible = (np.linalg.norm(rgb-background.color, axis=2)
                < min(background.tolerance, .02)) & ~protected
    confident = possible & (alpha < .05)
    seeds = np.zeros(alpha.shape, dtype=bool)
    seeds[0], seeds[-1] = confident[0], confident[-1]
    seeds[:, 0], seeds[:, -1] = confident[:, 0], confident[:, -1]
    return binary_propagation(seeds, mask=possible)

def green_detail_floor(rgb: np.ndarray, background: Background) -> np.ndarray:
    """亮绿幕的保守细节下界：背景亮度与小通道噪声不作为前景证据。"""
    # 在现有编码域颜色混合假设下，只使用超过背景误差的红/蓝正差。
    # 下界不是完整蒙版；调用方只能在未确定区域提高Alpha，不更改硬背景。
    upper = np.minimum(1., background.color + background.tolerance)
    bounds = np.maximum(rgb-upper, 0) / np.maximum(1-upper, 1e-8)
    return np.clip(bounds[:, :, [0, 2]].max(axis=2), 0, 1)

def background_statistics(rgb: np.ndarray) -> Background:
    border = np.concatenate((rgb[:3].reshape(-1, 3), rgb[-3:].reshape(-1, 3),
                             rgb[:, :3].reshape(-1, 3), rgb[:, -3:].reshape(-1, 3)))
    color = np.median(border, axis=0)
    distance = np.linalg.norm(border-color, axis=1)
    tolerance = max(.015, min(.06, float(np.quantile(distance, .99))*1.5))
    border_support = float(np.mean(distance < tolerance))
    corner_size = max(1, min(12, min(rgb.shape[:2])//8))
    corners = (rgb[:corner_size, :corner_size], rgb[:corner_size, -corner_size:],
               rgb[-corner_size:, :corner_size], rgb[-corner_size:, -corner_size:])
    corner_matches = tuple(float(np.mean(np.linalg.norm(corner-color, axis=2)
                                         < tolerance)) > .95 for corner in corners)
    matching_corners = sum(corner_matches)
    dominant = int(np.argmax(color))
    channel = dominant if dominant in (1, 2) and color[dominant]-max(np.delete(color, dominant)) > .2 else None
    # 主体碰边不等于复杂背景；明显幕布须有多数边框与三个角落支持。
    # 暗底混色仍需严格边框，避免把暗衣物与背景混淆后扩大硬约束。
    uniform = border_support > .95 or (channel is not None and border_support > .7
                                      and matching_corners >= 3)
    return Background(color, tolerance, uniform, channel, corner_matches)

def partial_green_trimap(rgb: np.ndarray, model: np.ndarray, background: Background) -> np.ndarray:
    """联合局部颜色与语义确认种子，不能把模型高Alpha直接当已知前景。"""
    distance = np.linalg.norm(rgb-background.color, axis=2)
    bg = green_exterior_mask(rgb, model, background)
    bg |= (distance < min(background.tolerance, .02)) & (model < .05)
    fg = (build_trimap(rgb, model, background) == 1) | binary_erosion(
        (model > .98) & (distance > max(background.tolerance*2, .06)), iterations=2)
    trimap = np.full(model.shape, .5)
    trimap[fg] = 1
    trimap[bg] = 0
    return trimap

def build_trimap(rgb: np.ndarray, model: np.ndarray, background: Background) -> np.ndarray:
    color, tolerance = background.color, background.tolerance
    distance = np.linalg.norm(rgb-color, axis=2)
    bg = distance < tolerance
    shape = distance > max(tolerance*2, .06)
    if background.chroma_channel is not None:
        c = background.chroma_channel
        dominant = rgb[:, :, c]
        other = np.max(np.delete(rgb, c, axis=2), axis=2)
        hue_bg = (dominant-other > .2) & (other < dominant*.3)
        shape &= ~hue_bg
        bg |= hue_bg & (dominant > color[c]*.93)
        if c == 1:
            # 弱正差也可能来自指缝幕布色波动；仅保护至少10%的可靠混色细节。
            bg &= green_detail_floor(rgb, background) < .1
    else:
        model_core = binary_erosion(model > .8, iterations=3)
        bg &= ~model_core
        shape |= model_core
        shape &= binary_dilation(model > .05, iterations=12)
        scale = rgb[:, :, 1] / max(color[1], .01)
        hue_distance = np.linalg.norm(rgb-scale[:, :, None]*color, axis=2)
        shadow_bg = ((hue_distance < .035) & (model < .3)
                     & (rgb[:, :, 1] > rgb[:, :, 0]*1.5)
                     & (rgb[:, :, 1] > rgb[:, :, 2]*1.3))
        bg |= shadow_bg
        shape &= ~shadow_bg
    if background.chroma_channel is None:
        # 暗色幕布与发丝混合像素可能也远离背景色；不能因此把模型软边固定成实心。
        shape &= model > .8
    fg = binary_erosion(shape, iterations=2)
    # 腐蚀会让完全孤立的一像素发丝/装饰没有前景种子，求解器便会整块删掉。
    # 只补无种子的连通片，并要求模型强确认；不把所有模型软边直接实心化。
    components, count = label(shape)
    has_seed = np.bincount(components[fg], minlength=count+1) > 0
    fg |= shape & ~has_seed[components] & (model > .98)
    trimap = np.full(model.shape, .5, dtype=np.float64)
    trimap[fg] = 1
    # 不腐蚀背景：极窄闭合区域也必须留有背景种子。
    trimap[bg] = 0
    return trimap

def refine(rgb: np.ndarray, model: np.ndarray) -> tuple[Image.Image, dict]:
    background = background_statistics(rgb)
    route = "model-color"
    alpha = np.clip(model, 0, 1)
    dark_green = (background.color[1] > background.color[0]*1.5
                  and background.color[1] > background.color[2]*1.3)
    use_color = background.uniform and (background.chroma_channel is not None or dark_green)
    if use_color and min(model.shape) >= 5:
        # 与幕布同色的大面积服装存在歧义，保留模型路径并明确记录路由。
        c = background.chroma_channel
        if c is not None:
            dominant = rgb[:, :, c]
            other = np.max(np.delete(rgb, c, axis=2), axis=2)
            # 模型误保留的幕布原色不能冒充同色衣服，导致整张图跳过精修。
            distinct_from_background = (np.linalg.norm(rgb-background.color, axis=2)
                                        > max(background.tolerance*2, .06))
            green_core = binary_erosion((model > .95) & (dominant-other > .2)
                                        & (other < dominant*.3) & distinct_from_background,
                                        iterations=5)
            use_color = np.sum(green_core) < max(64, np.sum(model > .5)*.005)
        if use_color:
            trimap = build_trimap(rgb, model, background)
            if np.any(trimap == 1) and np.any(trimap == 0):
                alpha = estimate_alpha_cf(rgb, trimap,
                    laplacian_kwargs={"epsilon": 1e-6}, cg_kwargs={"maxiter": 2000})
                if c == 1:
                    unknown = trimap == .5
                    floor = green_detail_floor(rgb, background)
                    alpha[unknown] = np.maximum(alpha[unknown], floor[unknown])
                if c is None:
                    # 闭式解在没有局部背景种子的混色片段里可能把软边补成实心。
                    # 暗色底继续服从主模型的软边上限；已确定的背景仍由颜色约束删除。
                    soft = (trimap == .5) & (model < .8)
                    alpha[soft] = np.minimum(alpha[soft], model[soft])
                route = "chroma-matting" if c is not None else "guided-matting"
    alpha = np.clip(alpha, 0, 1)
    local_background_seeds = 0
    if route == "model-color" and partial_green_evidence(background) and min(model.shape) >= 5:
        trimap = partial_green_trimap(rgb, model, background)
        if not np.any(trimap == 0) or not np.any(trimap == 1):
            raise ValueError("局部绿幕精修缺少可靠的背景或主体种子")
        alpha = estimate_alpha_cf(rgb, trimap, laplacian_kwargs={"epsilon": 1e-6},
                                  cg_kwargs={"maxiter": 2000})
        unknown = trimap == .5
        floor = green_detail_floor(rgb, background)
        alpha[unknown] = np.maximum(alpha[unknown], floor[unknown])
        other = np.max(rgb[:, :, [0,2]], axis=2)
        green = (rgb[:, :, 1]-other > .2) & (other < rgb[:, :, 1]*.3)
        uncertain = green & (model >= .05) & (model <= .5) & unknown
        alpha[uncertain] = np.minimum(alpha[uncertain], model[uncertain])
        protected = green & (model > .5)
        alpha[protected] = model[protected]
        alpha = np.clip(alpha, 0, 1)
        route = "partial-green-matting"
        local_background_seeds = int(np.count_nonzero(trimap == 0))
    foreground = estimate_foreground_ml(rgb, alpha)
    # 完全不透明的主体颜色不能被去污染步骤重绘。
    foreground[alpha >= .999] = rgb[alpha >= .999]
    rgba = np.dstack((np.clip(foreground, 0, 1), alpha))
    pixels = np.round(rgba*255).astype(np.uint8)
    # 输出契约以最终PNG的Alpha为准；0.9981等值也可能量化成完全不透明。
    opaque = pixels[:, :, 3] == 255
    pixels[opaque, :3] = np.round(rgb[opaque]*255).astype(np.uint8)
    green_foreground_changed_pixels = 0
    if route == "chroma-matting" and background.chroma_channel == 1:
        # 已知幕布色减少软边合成残差；不更新Alpha或覆盖硬种子。
        pixels, green_foreground_changed_pixels = refine_green_foreground(
            rgb, pixels, background.color, trimap == .5)
    green_edge_changed_pixels=0
    if route == 'chroma-matting' and background.uniform and background.chroma_channel == 1:
        from .green_edge import refine_green_edges
        pixels,green_edge_changed_pixels=refine_green_edges(rgb,pixels,background.color,trimap==.5)
    image = Image.fromarray(pixels)
    return image, {"route": route, "background_uniform": background.uniform,
                   "background": (background.color*255).round().tolist(),
                   "partial_green_evidence": partial_green_evidence(background),
                   "local_background_seed_pixels": local_background_seeds,
                   "green_foreground_changed_pixels": green_foreground_changed_pixels,
                   "green_edge_changed_pixels": green_edge_changed_pixels}
