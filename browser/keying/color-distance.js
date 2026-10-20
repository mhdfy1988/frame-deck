// 来源同core.js；Culori只在此适配层使用，核心不依赖库对象。
import { convertRgbToLab65, differenceCiede2000 } from "culori/fn";

// 复用角色抠图项目已验证的色差适配，缓存上限避免无限增长。
export function seedColorDistance(r, g, b) {
  const seed = convertRgbToLab65({ r: r / 255, g: g / 255, b: b / 255 }),
    delta = differenceCiede2000(),
    cache = new Map();
  return (red, green, blue) => {
    const key = (red << 16) | (green << 8) | blue;
    if (cache.has(key)) return cache.get(key);
    const color = convertRgbToLab65({
      r: red / 255,
      g: green / 255,
      b: blue / 255,
    });
    const value = Math.min(255, delta(seed, color) * 2.55);
    if (cache.size < 65536) cache.set(key, value);
    return value;
  };
}
