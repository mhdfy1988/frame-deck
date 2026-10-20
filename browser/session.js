import { FrameEditor } from "../web/organizer-core.js";
import { sequence } from "./domain.js";

// 唯一图片所有者；异步处理先返回候选，成功后一次提交，不留下半组。
export class BrowserSession {
  constructor() {
    this.frames = new Map();
    this.editor = null;
    this.name = "animation";
    this.fps = 12;
    this.revision = 0;
    this.savedRevision = 0;
  }
  load(frames, fps, name) {
    const next = new FrameEditor(sequence(frames, fps));
    this.frames = new Map(frames.map((frame) => [frame.id, frame]));
    this.editor = next;
    this.fps = fps;
    this.name = name.replace(/\.[^.]+$/, "") || "animation";
    this.revision++;
    this.savedRevision = -1;
  }
  get ordered() {
    return this.editor
      ? this.editor.order.map((id) => this.frames.get(id))
      : [];
  }
  get active() {
    return this.frames.get(this.editor?.active);
  }
  get dirty() {
    return (
      !!this.editor &&
      (this.savedRevision !== this.revision || this.editor.dirty)
    );
  }
  replace(id, blob, expected) {
    const frame = this.frames.get(id);
    if (!frame || frame.revision !== expected)
      throw new Error("帧已变化，请重新打开精修");
    frame.current = blob;
    frame.revision++;
    this.revision++;
    return frame.revision;
  }
  replaceAll(results, expected) {
    if (this.revision !== expected)
      throw new Error("处理期间序列已变化，未应用结果");
    for (const [id] of results)
      if (!this.frames.has(id)) throw new Error("帧已失效");
    for (const [id, blob] of results) {
      const frame = this.frames.get(id);
      frame.current = blob;
      frame.revision++;
    }
    this.revision++;
  }
  markExported() {
    this.editor?.markExported();
    this.savedRevision = this.revision;
  }
}
