import { BlobArchive } from "./archive.js";
import { exportSettings, exportGeometry } from "../web/export-core.js";
import { decode, png } from "./images.js";

export function drawTransformed(context, image, settings) {
  const { scale } = exportGeometry(settings, 1),
    [x, y, w, h] = settings.crop,
    width = Math.max(1, Math.round(w * scale)),
    height = Math.max(1, Math.round(h * scale));
  context.clearRect(0, 0, settings.width, settings.height);
  context.imageSmoothingEnabled = settings.filter !== "pixel";
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    x,
    y,
    w,
    h,
    Math.floor((settings.width - width) / 2),
    Math.floor((settings.height - height) / 2),
    width,
    height,
  );
}
export async function renderExportPreview(
  frames,
  settings,
  index,
  { sheet = false, raw = false } = {},
) {
  const geometry = exportGeometry(settings, frames.length),
    canvas = new OffscreenCanvas(
      raw ? frames[index].width : sheet ? geometry.sheetWidth : settings.width,
      raw
        ? frames[index].height
        : sheet
          ? geometry.sheetHeight
          : settings.height,
    ),
    ctx = canvas.getContext("2d");
  const targets = sheet ? frames : [frames[index]],
    cell = new OffscreenCanvas(settings.width, settings.height),
    cellContext = cell.getContext("2d");
  for (const [at, frame] of targets.entries()) {
    const bitmap = await decode(frame.current);
    try {
      if (raw) ctx.drawImage(bitmap, 0, 0);
      else {
        drawTransformed(cellContext, bitmap, settings);
        ctx.drawImage(
          cell,
          sheet ? (at % geometry.cols) * settings.width : 0,
          sheet ? Math.floor(at / geometry.cols) * settings.height : 0,
        );
      }
    } finally {
      bitmap.close();
    }
  }
  return canvas;
}
export async function commonCrop(frames, padding, { signal, onProgress }) {
  if (!Number.isInteger(padding) || padding < 0 || padding > 256)
    throw new Error("留白须为0–256整数");
  let left = frames[0].width,
    top = frames[0].height,
    right = 0,
    bottom = 0;
  for (const [index, frame] of frames.entries()) {
    signal.throwIfAborted();
    onProgress(`测量共同范围 ${index + 1} / ${frames.length}`);
    const bitmap = await decode(frame.current),
      canvas = new OffscreenCanvas(frame.width, frame.height),
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    try {
      ctx.drawImage(bitmap, 0, 0);
    } finally {
      bitmap.close();
    }
    const data = ctx.getImageData(0, 0, frame.width, frame.height).data;
    canvas.width = canvas.height = 1;
    for (let y = 0; y < frame.height; y++)
      for (let x = 0; x < frame.width; x++)
        if (data[(y * frame.width + x) * 4 + 3]) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x + 1);
          bottom = Math.max(bottom, y + 1);
        }
  }
  if (right <= left) throw new Error("全部帧透明，无法裁剪");
  const x = Math.max(0, left - padding),
    y = Math.max(0, top - padding);
  return [
    x,
    y,
    Math.min(frames[0].width, right + padding) - x,
    Math.min(frames[0].height, bottom + padding) - y,
  ];
}
export async function exportFrames(frames, values, { signal, onProgress }) {
  if (!frames.length) throw new Error("没有可导出的帧");
  const input = { frameIds: frames.map((frame) => frame.id) };
  const settings = exportSettings(input, { canvas: frames[0] }, values),
    geometry = exportGeometry(settings, frames.length);
  const canvas = new OffscreenCanvas(settings.width, settings.height),
    ctx = canvas.getContext("2d");
  const sheet =
    settings.format === "sheet"
      ? new OffscreenCanvas(geometry.sheetWidth, geometry.sheetHeight)
      : null;
  const sheetCtx = sheet?.getContext("2d"),
    manifestFrames = [];
  const archive = new BlobArchive(signal);
  try {
    const [x, y, w, h] = settings.crop;
    for (const [index, frame] of frames.entries()) {
      signal.throwIfAborted();
      onProgress(`导出 ${index + 1} / ${frames.length}`);
      const unchanged =
        !sheet &&
        x === 0 &&
        y === 0 &&
        w === frame.width &&
        h === frame.height &&
        settings.width === w &&
        settings.height === h;
      let blob = frame.current;
      if (!unchanged) {
        const image = await decode(blob);
        try {
          drawTransformed(ctx, image, settings);
        } finally {
          image.close();
        }
        if (sheet)
          sheetCtx.drawImage(
            canvas,
            (index % geometry.cols) * settings.width,
            Math.floor(index / geometry.cols) * settings.height,
          );
        else blob = await png(canvas);
      }
      const path = `frames/frame_${String(index + 1).padStart(6, "0")}.png`;
      if (!sheet) {
        await archive.add(path, blob);
      }
      manifestFrames.push({
        id: frame.id,
        index,
        image: path,
        sourceTimeSeconds: frame.time ?? null,
        sampleTimeSeconds: frame.sampleTimeSeconds ?? null,
        durationSeconds: `1/${settings.fps}`,
        rect: {
          x: (index % geometry.cols) * settings.width,
          y: Math.floor(index / geometry.cols) * settings.height,
          width: settings.width,
          height: settings.height,
        },
      });
    }
    const playback = {
      fps: settings.fps,
      frameCount: frames.length,
      frameDuration: { numerator: 1, denominator: settings.fps },
      duration: { numerator: frames.length, denominator: settings.fps },
    };
    const metadata = sheet
      ? {
          formatVersion: 1,
          kind: "fixed-grid",
          image: "sheet.png",
          name: settings.name,
          canvas: { width: sheet.width, height: sheet.height },
          cell: { width: settings.width, height: settings.height },
          columns: geometry.cols,
          rows: geometry.rows,
          playback,
          frames: manifestFrames,
        }
      : {
          formatVersion: 6,
          kind: "uniform-frame-export",
          name: settings.name,
          canvas: { width: settings.width, height: settings.height },
          playback,
          frames: manifestFrames,
        };
    if (sheet) {
      const blob = await png(sheet);
      await archive.add("sheet.png", blob);
    }
    await archive.add(
      sheet ? "sheet.json" : "frame-sequence.json",
      new Blob([JSON.stringify(metadata, null, 2)]),
    );
    signal.throwIfAborted();
    onProgress("打包ZIP");
    return {
      blob: archive.finish(),
      name: `${settings.name}.zip`,
    };
  } finally {
    archive.dispose();
    canvas.width = canvas.height = 1;
    if (sheet) sheet.width = sheet.height = 1;
  }
}
export function download({ blob, name }) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
