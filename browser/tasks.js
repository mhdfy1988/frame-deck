import { LIMITS } from "./domain.js";

export function workerTask(worker, data, signal, progress = () => {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("处理超过120秒，请减少帧数或尺寸")),
      120000,
    );
    const abort = () =>
      finish(signal.reason || new DOMException("已取消", "AbortError"));
    const fail = (event) => finish(new Error(event.message || "工作线程失败"));
    const receive = ({ data: result }) => {
      if (result.type === "progress") {
        progress(result.message);
        return;
      }
      finish(
        result.error || result.type === "error"
          ? new Error(result.error || result.message)
          : null,
        result,
      );
    };
    function finish(error, result) {
      clearTimeout(timer);
      worker.removeEventListener("message", receive);
      worker.removeEventListener("error", fail);
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve(result);
    }
    worker.addEventListener("message", receive);
    worker.addEventListener("error", fail);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else worker.postMessage(data);
  });
}
export async function removeBackground(
  frames,
  settings,
  { signal, onProgress },
) {
  const worker = new Worker(new URL("./pixel-worker.js", import.meta.url), {
      type: "module",
    }),
    results = [];
  let bytes = 0;
  try {
    signal.throwIfAborted();
    if (!frames.length) throw new Error("没有可处理的帧");
    onProgress("确定整组统一底色");
    const color =
      settings.color ??
      (
        await workerTask(
          worker,
          { type: "color", blob: frames[0].source },
          signal,
        )
      ).color;
    const options = { ...settings, color };
    for (const [index, frame] of frames.entries()) {
      signal.throwIfAborted();
      onProgress(`去背 ${index + 1} / ${frames.length}`);
      const { blob } = await workerTask(
        worker,
        { type: "apply", blob: frame.source, options },
        signal,
      );
      bytes += blob.size;
      if (bytes > LIMITS.archive)
        throw new Error("去背结果超过96MiB，未替换原序列");
      results.push([frame.id, blob]);
    }
    signal.throwIfAborted();
    return { results, color };
  } finally {
    worker.terminate();
  }
}
export async function sampleBackground(frame, point, { signal, onProgress }) {
  const worker = new Worker(new URL("./pixel-worker.js", import.meta.url), {
    type: "module",
  });
  try {
    onProgress("读取原图底色");
    return (
      await workerTask(
        worker,
        { type: "color", blob: frame.source, point },
        signal,
      )
    ).color;
  } finally {
    worker.terminate();
  }
}
export async function findLoops(frames, { signal, onProgress }) {
  const worker = new Worker(new URL("../web/loop-worker.js", import.meta.url), {
    type: "module",
  });
  try {
    return (
      await workerTask(
        worker,
        { blobs: frames.map((frame) => frame.current) },
        signal,
        onProgress,
      )
    ).candidates;
  } finally {
    worker.terminate();
  }
}
