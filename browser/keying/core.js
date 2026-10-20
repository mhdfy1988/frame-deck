// 来源：EazyCut 6d75c86d4c123f3ae2fbb4f5742bb99f61f6f93b，MIT；适配FrameDeck尺寸预算并补充输入校验。
import { LIMITS } from "../domain.js";
import { seedColorDistance } from "./color-distance.js";
export const MAX_PIXELS = LIMITS.framePixels;
export function validateSize(width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_PIXELS
  )
    throw Error("图片最多支持 1200 万像素");
}

// 从边缘颜色的多数簇取初始底色，不把它当作语义分割。
export function guessBackground(data, width, height) {
  const buckets = new Map();
  for (let i = 0; i < 32; i++) {
    const x = Math.round((i * (width - 1)) / 31),
      y = Math.round((i * (height - 1)) / 31);
    for (const [px, py] of [
      [x, 0],
      [x, height - 1],
      [0, y],
      [width - 1, y],
    ]) {
      const j = (py * width + px) * 4;
      if (data[j + 3] < 128) continue;
      const key = [data[j] >> 4, data[j + 1] >> 4, data[j + 2] >> 4].join(",");
      const bucket = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      bucket.n++;
      bucket.r += data[j];
      bucket.g += data[j + 1];
      bucket.b += data[j + 2];
      buckets.set(key, bucket);
    }
  }
  const winner = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
  return winner
    ? [winner.r, winner.g, winner.b].map((v) => Math.round(v / winner.n))
    : [0, 255, 0];
}

export function removeBackground(
  source,
  width,
  height,
  { color, tolerance = 30, softness = 12, connected = true, cleanup = 70 },
) {
  validateSize(width, height);
  if (typeof connected !== "boolean") throw Error("连通范围必须为布尔值");
  if (source.length !== width * height * 4) throw Error("图片像素不完整");
  if (
    !Array.isArray(color) ||
    color.length !== 3 ||
    !color.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)
  )
    throw Error("背景色无效");
  if (
    ![tolerance, softness, cleanup].every(Number.isFinite) ||
    tolerance < 0 ||
    tolerance > 100 ||
    softness < 0 ||
    softness > 50 ||
    cleanup < 0 ||
    cleanup > 100
  )
    throw Error("处理参数无效");
  const count = width * height,
    distance = seedColorDistance(...color),
    distances = new Float32Array(count),
    allowed = new Uint8Array(count),
    result = new Uint8ClampedArray(source),
    threshold = tolerance + softness;
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    distances[p] =
      source[i + 3] === 0
        ? 0
        : distance(source[i], source[i + 1], source[i + 2]);
  }
  if (connected) {
    const queue = new Uint32Array(count);
    let head = 0,
      tail = 0;
    function add(p) {
      if (!allowed[p] && distances[p] <= threshold) {
        allowed[p] = 1;
        queue[tail++] = p;
      }
    }
    for (let x = 0; x < width; x++) {
      add(x);
      add((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      add(y * width);
      add(y * width + width - 1);
    }
    while (head < tail) {
      const p = queue[head++],
        x = p % width;
      if (x) add(p - 1);
      if (x < width - 1) add(p + 1);
      if (p >= width) add(p - width);
      if (p < count - width) add(p + width);
    }
  } else allowed.fill(1);
  let removed = 0;
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    if (!source[i + 3] || !allowed[p]) continue;
    let alpha =
      softness === 0
        ? distances[p] <= tolerance
          ? 0
          : 1
        : Math.max(0, Math.min(1, (distances[p] - tolerance) / softness));
    alpha = alpha * alpha * (3 - 2 * alpha);
    result[i + 3] = Math.round(source[i + 3] * alpha);
    if (result[i + 3] < source[i + 3]) removed++;
    // 只在新生成的软边上尝试去底色，完全不透明主体保留原RGB。
    if (alpha > 0.04 && alpha < 1 && cleanup > 0)
      for (let c = 0; c < 3; c++) {
        const clean = Math.max(
          0,
          Math.min(255, (source[i + c] - (1 - alpha) * color[c]) / alpha),
        );
        result[i + c] = Math.round(
          source[i + c] + ((clean - source[i + c]) * cleanup) / 100,
        );
      }
  }
  return { data: result, removed };
}
