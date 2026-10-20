import { FFmpeg } from "@ffmpeg/ffmpeg";
import { LIMITS, sampleTimes, checkImages, videoBatches } from "./domain.js";

// 固定单线程运行库；不依赖SharedArrayBuffer、服务器或模型。
export class VideoExtractor {
  async extract(
    file,
    { start, end, fps, fullRange = false, signal, onProgress, onMetadata },
  ) {
    if (file.size > LIMITS.file) throw new Error("浏览器版视频最多64MiB");
    if (!/\.(mp4|mov|webm)$/i.test(file.name))
      throw new Error("请选择MP4、MOV或WebM");
    const ffmpeg = new FFmpeg();
    const abort = () => ffmpeg.terminate();
    signal.addEventListener("abort", abort, { once: true });
    let tail = "";
    ffmpeg.on("log", ({ message }) => {
      tail = (tail + "\n" + message).slice(-1500);
    });
    try {
      signal.throwIfAborted();
      onProgress("加载浏览器解码器（首次约32MB）");
      const base = new URL("./vendor/ffmpeg/", document.baseURI);
      await ffmpeg.load({
        classWorkerURL: new URL("worker.js", base).href,
        coreURL: new URL("ffmpeg-core.js", base).href,
        wasmURL: new URL("ffmpeg-core.wasm", base).href,
      });
      signal.throwIfAborted();
      onProgress("探测视频轨时长与尺寸");
      await ffmpeg.writeFile("input", new Uint8Array(await file.arrayBuffer()));
      const probe = await ffmpeg.ffprobe(
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height,duration:format=duration",
          "-of",
          "json",
          "input",
          "-o",
          "probe.json",
        ],
        30000,
      );
      // 固定core 0.12.10已知成功时也返回-1（上游#817）；只接受完整可校验JSON，错误仍快速失败。
      if (probe !== 0 && probe !== -1)
        throw new Error(`视频探测失败（${probe}）：${tail.slice(-700)}`);
      const info = JSON.parse(await ffmpeg.readFile("probe.json", "utf8")),
        stream = info.streams?.[0];
      const duration = Number(stream?.duration ?? info.format?.duration);
      if (!stream || !Number.isFinite(duration) || duration <= 0 || tail.trim())
        throw new Error(`视频探测输出无效：${tail.slice(-700)}`);
      if (probe === -1)
        console.warn(
          "FFmpeg core 0.12.10探测返回-1；已核验JSON、尺寸、时长及无错误日志（上游#817）",
        );
      signal.throwIfAborted();
      // 仅“直到视频末尾”随视频轨终点同步；手填的越界范围仍报错，不静默裁切。
      if (fullRange) end = duration;
      onMetadata?.({
        duration,
        width: stream.width,
        height: stream.height,
        end,
      });
      onProgress("校验抽帧范围与容量");
      const times = sampleTimes(start, end, fps, duration);
      checkImages(
        times.map(() => ({ width: stream?.width, height: stream?.height })),
      );
      await ffmpeg.createDir("frames");
      const frames = [],
        batches = videoBatches(times.length, stream.width, stream.height);
      let totalBytes = 0;
      const deadline = performance.now() + 120000;
      for (const [batchIndex, batch] of batches.entries()) {
        signal.throwIfAborted();
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0) throw new Error("视频抽帧超过120秒，未替换原序列");
        onProgress(
          `分批解码 ${batchIndex + 1} / ${batches.length} · 已读取${frames.length}帧`,
        );
        // setpts从零计算；fps明确采用向上取整选择下一源帧，禁止隐式补间。
        const result = await ffmpeg.exec(
          [
            "-v",
            "error",
            "-i",
            "input",
            "-an",
            "-vf",
            `trim=start=${start}:end=${end},setpts=PTS-STARTPTS,fps=fps=${fps}:round=up,trim=start_frame=${batch.offset}:end_frame=${batch.offset + batch.count},setpts=PTS-STARTPTS`,
            "-frames:v",
            String(batch.count),
            "frames/%06d.png",
          ],
          remaining,
        );
        signal.throwIfAborted();
        if (result !== 0)
          throw new Error(`视频抽帧失败或超过120秒：${tail.slice(-300)}`);
        const names = (await ffmpeg.listDir("frames"))
          .filter((entry) => /^\d+\.png$/.test(entry.name))
          .map((entry) => entry.name)
          .sort();
        if (names.length !== batch.count)
          throw new Error(
            `第${batchIndex + 1}批解码得到${names.length}帧，与预计${batch.count}帧不符，未替换原序列；请调整范围`,
          );
        for (const [index, name] of names.entries()) {
          signal.throwIfAborted();
          const bytes = await ffmpeg.readFile(`frames/${name}`);
          // 读出后立即回收MEMFS文件，不让整组PNG与会话Blob同时滞留解码器。
          await ffmpeg.deleteFile(`frames/${name}`);
          totalBytes += bytes.byteLength;
          if (totalBytes > LIMITS.archive)
            throw new Error("视频抽帧结果超过96MiB");
          const blob = new Blob([bytes], { type: "image/png" });
          const header = new DataView(
              bytes.buffer,
              bytes.byteOffset,
              bytes.byteLength,
            ),
            width = header.getUint32(16),
            height = header.getUint32(20);
          frames.push({
            id: crypto.randomUUID(),
            width,
            height,
            source: blob,
            current: blob,
            revision: 0,
            sampleTimeSeconds: times[batch.offset + index],
          });
          onProgress(`读取抽帧结果 ${frames.length} / ${times.length}`);
        }
      }
      checkImages(frames);
      return frames;
    } finally {
      signal.removeEventListener("abort", abort);
      ffmpeg.terminate();
    }
  }
}
