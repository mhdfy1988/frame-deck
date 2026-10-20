import { FramePlayback } from "../../web/core.js";
import { setControl } from "../../web/icons-ui.js";

export const nodes = (root) => (id) => {
  const element = root.querySelector(`#${id}`);
  if (!element) throw new Error(`缺少原界面节点：${id}`);
  return element;
};
export class ImageURLs {
  constructor() {
    this.entries = new Map();
    this.thumbnails = new Map();
    this.queue = Promise.resolve();
  }
  get(frame, source = false) {
    const key = `${frame.id}:${source ? "source" : "current"}`;
    const blob = source ? frame.source : frame.current;
    let entry = this.entries.get(key);
    if (!entry || entry.blob !== blob) {
      if (entry) URL.revokeObjectURL(entry.url);
      entry = { url: URL.createObjectURL(blob), blob };
      this.entries.set(key, entry);
    }
    // 全尺寸URL只服务少量大预览，防止逐帧查看后一直保留所有解码缓存入口。
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > 8) {
      const oldest = this.entries.keys().next().value;
      URL.revokeObjectURL(this.entries.get(oldest).url);
      this.entries.delete(oldest);
    }
    return entry.url;
  }
  thumbnail(image, frame, source = false) {
    const key = `${frame.id}:${source || frame.current === frame.source ? "source" : "current"}`;
    const blob = source ? frame.source : frame.current;
    image.loading = "lazy";
    image.decoding = "async";
    let entry = this.thumbnails.get(key);
    if (!entry || entry.blob !== blob) {
      if (entry?.url) URL.revokeObjectURL(entry.url);
      entry = { blob, url: null, images: new Set() };
      this.thumbnails.set(key, entry);
      const current = entry;
      this.queue = this.queue.then(async () => {
        if (this.thumbnails.get(key) !== current) return;
        const ratio = Math.min(1, 192 / Math.max(frame.width, frame.height));
        let bitmap, canvas;
        try {
          bitmap = await createImageBitmap(blob, {
            resizeWidth: Math.max(1, Math.round(frame.width * ratio)),
            resizeHeight: Math.max(1, Math.round(frame.height * ratio)),
          });
          canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          canvas.getContext("2d").drawImage(bitmap, 0, 0);
          const small = await canvas.convertToBlob({ type: "image/png" });
          if (this.thumbnails.get(key) !== current) return;
          current.url = URL.createObjectURL(small);
          for (const target of current.images) {
            target.src = current.url;
            target.hidden = false;
          }
          current.images.clear();
        } catch (error) {
          if (this.thumbnails.get(key) === current)
            for (const target of current.images)
              target.title = `缩略图失败：${error.message}`;
          current.images.clear();
        } finally {
          bitmap?.close();
          if (canvas) canvas.width = canvas.height = 1;
        }
      });
    }
    if (entry.url) {
      if (image.getAttribute("src") !== entry.url) image.src = entry.url;
      image.hidden = false;
    } else {
      image.hidden = true;
      entry.images.add(image);
    }
  }
  clear() {
    for (const { url } of this.entries.values()) URL.revokeObjectURL(url);
    this.entries.clear();
    for (const entry of this.thumbnails.values()) {
      if (entry.url) URL.revokeObjectURL(entry.url);
      entry.images.clear();
    }
    this.thumbnails.clear();
  }
}
export function playback(
  button,
  {
    frames,
    fps,
    onFrame,
    onChange = () => {},
    loop = false,
    startIndex = () => 0,
  },
) {
  let clock = null,
    raf = 0;
  function stop() {
    clock = null;
    cancelAnimationFrame(raf);
    setControl(button, "play", button.id === "play" ? "播放帧" : "播放");
    onChange(false);
  }
  function start() {
    if (clock) return;
    const values = frames();
    if (!values.length) return;
    clock = new FramePlayback(
      values.length,
      fps(),
      performance.now(),
      startIndex(),
    );
    setControl(button, "pause", "暂停");
    onChange(true);
    const tick = (now) => {
      if (!clock) return;
      const rate = fps();
      if (
        Number.isInteger(rate) &&
        rate >= 1 &&
        rate <= 60 &&
        rate !== clock.fps
      )
        clock.setRate(rate, now);
      if (!loop && clock.ended(now)) {
        onFrame(values.at(-1));
        stop();
        return;
      }
      onFrame(values[Math.floor(clock.position(now)) % values.length]);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  button.onclick = () => (clock ? stop() : start());
  return {
    start,
    stop,
    get active() {
      return !!clock;
    },
  };
}
export function imageView({
  image,
  viewport,
  label,
  fitButton,
  nativeButton,
  smaller,
  larger,
}) {
  let zoom = 1,
    panX = 0,
    panY = 0,
    pointer = null,
    frame = null;
  const pose = () => {
    image.style.transform = `translate(calc(-50% + ${panX}px),calc(-50% + ${panY}px)) scale(${zoom})`;
    if (label) label.textContent = `${Math.round(zoom * 100)}%`;
  };
  const fit = () => {
    if (!frame) return;
    zoom = Math.max(
      0.05,
      Math.min(
        (viewport.clientWidth - 24) / frame.width,
        (viewport.clientHeight - 24) / frame.height,
        1,
      ),
    );
    panX = panY = 0;
    pose();
  };
  if (fitButton) fitButton.onclick = fit;
  if (nativeButton)
    nativeButton.onclick = () => {
      zoom = 1;
      panX = panY = 0;
      pose();
    };
  if (smaller)
    smaller.onclick = () => {
      zoom = Math.max(0.05, zoom / 1.25);
      pose();
    };
  if (larger)
    larger.onclick = () => {
      zoom = Math.min(16, zoom * 1.25);
      pose();
    };
  viewport.onwheel = (event) => {
    event.preventDefault();
    zoom = Math.max(0.05, Math.min(16, zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
    pose();
  };
  viewport.onpointerdown = (event) => {
    if (event.button !== 0) return;
    pointer = { x: event.clientX, y: event.clientY, panX, panY };
    viewport.setPointerCapture(event.pointerId);
  };
  viewport.onpointermove = (event) => {
    if (pointer) {
      panX = pointer.panX + event.clientX - pointer.x;
      panY = pointer.panY + event.clientY - pointer.y;
      pose();
    }
  };
  viewport.onpointerup = viewport.onpointercancel = () => (pointer = null);
  const resize = () => fit();
  window.addEventListener("resize", resize);
  return {
    show(next, url) {
      const changed =
        frame?.width !== next?.width || frame?.height !== next?.height;
      frame = next;
      image.hidden = !frame;
      if (frame) {
        if (image.getAttribute("src") !== url) image.src = url;
        image.width = frame.width;
        image.height = frame.height;
        if (changed) fit();
        else pose();
      } else image.removeAttribute("src");
    },
    fit,
    dispose() {
      window.removeEventListener("resize", resize);
    },
  };
}
