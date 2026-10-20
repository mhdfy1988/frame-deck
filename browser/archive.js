import { Zip, ZipPassThrough } from "fflate";
import { LIMITS } from "./domain.js";

// PNG已经压缩：逐个Blob分块写入存储式ZIP，不再聚合所有输入Uint8Array再拼整包。
export class BlobArchive {
  constructor(signal) {
    signal.throwIfAborted();
    this.signal = signal;
    this.parts = [];
    this.bytes = 0;
    this.error = null;
    this.ended = false;
    this.zip = new Zip((error, chunk, final) => {
      if (error) this.error = error;
      if (chunk) {
        this.bytes += chunk.byteLength;
        if (this.bytes > LIMITS.archive) this.error = new Error("ZIP超过96MiB");
        if (!this.error) this.parts.push(new Blob([chunk]));
      }
      this.ended = final;
    });
    this.abort = () => this.dispose();
    signal.addEventListener("abort", this.abort, { once: true });
  }
  check() {
    this.signal.throwIfAborted();
    if (this.disposed) throw new Error("ZIP任务已结束");
    if (this.error) throw this.error;
  }
  async add(name, blob) {
    this.check();
    if (this.bytes + blob.size > LIMITS.archive)
      throw new Error("导出超过96MiB");
    const entry = new ZipPassThrough(name);
    this.zip.add(entry);
    for (let offset = 0; offset < blob.size; offset += 1024 ** 2) {
      this.check();
      const chunk = new Uint8Array(
        await blob.slice(offset, offset + 1024 ** 2).arrayBuffer(),
      );
      this.check();
      entry.push(chunk, false);
      this.check();
    }
    entry.push(new Uint8Array(), true);
    this.check();
  }
  finish() {
    this.check();
    this.zip.end();
    this.check();
    if (!this.ended) throw new Error("ZIP未完整结束");
    const blob = new Blob(this.parts, { type: "application/zip" });
    this.dispose();
    return blob;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.signal.removeEventListener("abort", this.abort);
    this.zip.terminate();
    this.parts.length = 0;
  }
}
