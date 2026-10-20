import {
  guessBackground,
  removeBackground,
  validateSize,
} from "./keying/core.js";

// 一条消息只解码一张原图。旧四角魔法棒链路已移除，不作为静默回退。
self.onmessage = async ({ data }) => {
  let canvas, bitmap;
  try {
    const { blob, type, options, point } = data;
    if (!(blob instanceof Blob)) throw new Error("缺少源图片");
    bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none" });
    const { width, height } = bitmap;
    validateSize(width, height);
    canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    bitmap = null;
    if (type === "color" && point) {
      const [x, y] = point;
      if (
        ![x, y].every(Number.isInteger) ||
        x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height
      )
        throw new Error("取色点超出原图");
      const pixel = ctx.getImageData(x, y, 1, 1).data;
      if (pixel[3] === 0) throw new Error("请选择非透明的背景位置");
      self.postMessage({ color: Array.from(pixel.slice(0, 3)) });
    } else {
      const image = ctx.getImageData(0, 0, width, height);
      if (type === "color")
        self.postMessage({ color: guessBackground(image.data, width, height) });
      else if (type === "apply") {
        const result = removeBackground(image.data, width, height, options);
        ctx.putImageData(new ImageData(result.data, width, height), 0, 0);
        self.postMessage({
          blob: await canvas.convertToBlob({ type: "image/png" }),
        });
      } else throw new Error("未知去背任务");
    }
  } catch (error) {
    self.postMessage({ error: error.message });
  } finally {
    bitmap?.close();
    if (canvas) canvas.width = canvas.height = 1;
  }
};
