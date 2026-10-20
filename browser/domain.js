import { expectedCount } from "../web/core.js";

// 浏览器预算独立于本机磁盘预算，不宣称与本机版具有相同容量。
export const LIMITS = Object.freeze({
  frames: 600,
  batchPixels: 16_000_000,
  batchFrames: 16,
  framePixels: 12_000_000,
  side: 4096,
  file: 64 * 1024 ** 2,
  archive: 96 * 1024 ** 2,
});
export function checkImages(frames) {
  if (!frames.length || frames.length > LIMITS.frames)
    throw new Error(`浏览器版每组支持1–${LIMITS.frames}帧`);
  const { width, height } = frames[0];
  for (const frame of frames) {
    if (
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.width < 1 ||
      frame.height < 1 ||
      Math.max(frame.width, frame.height) > LIMITS.side
    )
      throw new Error("图片边长须为1–4096像素");
    if (frame.width * frame.height > LIMITS.framePixels)
      throw new Error("单帧超过1200万像素，请降低分辨率");
    if (frame.width !== width || frame.height !== height)
      throw new Error("序列帧须为相同尺寸，未自动裁切或居中");
  }
  return { width, height };
}
export function sampleTimes(start, end, fps, duration) {
  const count = expectedCount(start, end, fps);
  if (!count || !Number.isFinite(duration))
    throw new Error(
      "起止时间须为有效数字、0 ≤ 开始 < 结束，采样率须为1–60整数",
    );
  if (end > duration + 0.000001)
    throw new Error(`结束时间${end}秒超出视频轨时长${duration}秒，请调整范围`);
  if (count > LIMITS.frames)
    throw new Error(
      `预计${count}帧，超过浏览器版${LIMITS.frames}帧限制，请缩短范围或降低采样率`,
    );
  return Array.from({ length: count }, (_, i) => start + i / fps);
}
// 每次只生成有限数量PNG；按同一重采样序列的帧号切批，不能在批边界重新起算采样相位。
export function videoBatches(count, width, height) {
  checkImages([{ width, height }]);
  if (!Number.isInteger(count) || count < 1 || count > LIMITS.frames)
    throw new Error("无效抽帧数量");
  const size = Math.max(
    1,
    Math.min(
      LIMITS.batchFrames,
      Math.floor(LIMITS.batchPixels / (width * height)),
    ),
  );
  return Array.from({ length: Math.ceil(count / size) }, (_, index) => ({
    offset: index * size,
    count: Math.min(size, count - index * size),
  }));
}
export function sequence(frames, fps) {
  const canvas = checkImages(frames);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60)
    throw new Error("帧率须为1–60整数");
  return {
    formatVersion: 2,
    canvas,
    frames: frames.map((frame, index) => ({
      id: frame.id,
      index,
      sourceIndex: index,
      durationSeconds: `1/${fps}`,
      sourceTimeSeconds: frame.time ?? null,
    })),
  };
}
export function filenameOrder(files) {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}
