import { checkImages, LIMITS, filenameOrder } from "./domain.js";

export async function decode(blob) {
  return createImageBitmap(blob, { premultiplyAlpha: "none" });
}
export function png(canvas) {
  return canvas.convertToBlob({ type: "image/png" });
}
export async function readImages(files, signal, onProgress = () => {}) {
  if (!files.length || files.length > LIMITS.frames)
    throw new Error(`请选择1–${LIMITS.frames}张PNG`);
  if (files.reduce((sum, file) => sum + file.size, 0) > LIMITS.archive)
    throw new Error("PNG序列累计超过96MiB");
  const frames = [];
  for (const [index, file] of filenameOrder(files).entries()) {
    signal.throwIfAborted();
    if (!/\.png$/i.test(file.name) || file.size > LIMITS.file)
      throw new Error("仅接受不超过64MiB的PNG");
    // 先读PNG头检查尺寸，避免未经预算检查解码巨大图像。
    const bytes = new Uint8Array(await file.slice(0, 24).arrayBuffer());
    if (
      bytes.length < 24 ||
      bytes.slice(0, 8).join(",") !== "137,80,78,71,13,10,26,10"
    )
      throw new Error("不是有效的PNG");
    const view = new DataView(bytes.buffer),
      width = view.getUint32(16),
      height = view.getUint32(20);
    const candidate = {
      id: crypto.randomUUID(),
      width,
      height,
      source: file,
      current: file,
      revision: 0,
    };
    checkImages([...frames, candidate]);
    const bitmap = await decode(file);
    try {
      if (bitmap.width !== width || bitmap.height !== height)
        throw new Error("PNG尺寸不一致");
    } finally {
      bitmap.close();
    }
    frames.push(candidate);
    onProgress(`读取图片 ${index + 1} / ${files.length}`);
  }
  signal.throwIfAborted();
  return frames;
}
export async function validateReplacement(blob, frame) {
  if (!(blob instanceof Blob) || blob.size > LIMITS.file)
    throw new Error("精修结果超出预算");
  const bitmap = await decode(blob);
  try {
    if (bitmap.width !== frame.width || bitmap.height !== frame.height)
      throw new Error("精修不能改变原图尺寸");
  } finally {
    bitmap.close();
  }
}
