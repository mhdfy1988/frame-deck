import { nodes } from "./media.js";
import { expectedCount, formatTime } from "../../web/core.js";

export function createExtract(
  root,
  { urls, onVideo, onImages, onPreview, onPlay, onSourceModeChange },
) {
  const $ = nodes(root),
    video = $("video");
  let file = null,
    url = null,
    token = 0,
    busy = false,
    imageMode = false,
    signature = "";
  function sourceMode(images) {
    imageMode = images;
    root.classList.toggle("browser-image-source", images);
    $("source-title").textContent = images ? "源图片" : "原视频";
    $("video-parameters").hidden = images;
    $("open").textContent = images || !file ? "选择视频" : "换视频";
    onSourceModeChange(images);
  }
  function range(fromSlider = false) {
    if (fromSlider) {
      $("start").value = $("range-start").value;
      $("end").value = $("range-end").value;
    } else {
      $("range-start").value = $("start").value;
      $("range-end").value = $("end").value;
    }
    const max = Number($("range-end").max) || 1,
      start = Number($("start").value),
      end = Number($("end").value),
      fps = Number($("fps").value);
    $("range-fill").style.left = `${Math.min(100, (start / max) * 100)}%`;
    $("range-fill").style.right = `${Math.max(0, 100 - (end / max) * 100)}%`;
    $("estimate").textContent = imageMode
      ? ""
      : `预计 ${expectedCount(start, end, fps) || "—"} 帧`;
    $("extract").disabled = busy || !file || !expectedCount(start, end, fps);
  }
  $("open").onclick = $("empty").onclick = () => $("file").click();
  $("open-images").onclick = () => $("images-file").click();
  $("images-file").onchange = (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    if (files.length) onImages(files, Number($("fps").value) || 12);
  };
  async function choose(next) {
    if (!next || busy) return;
    if (next.size > 64 * 1024 ** 2) {
      $("error").textContent = "浏览器版视频最多64MiB";
      return;
    }
    const identity = ++token;
    if (url) URL.revokeObjectURL(url);
    file = next;
    sourceMode(false);
    url = URL.createObjectURL(file);
    video.src = url;
    $("source-png").hidden = true;
    video.hidden = false;
    $("empty").hidden = true;
    $("dropzone").classList.add("has-video");
    $("filename").textContent = file.name;
    $("open").textContent = "换视频";
    for (const id of ["start", "end", "fps", "range-start", "range-end"])
      $(id).disabled = false;
    video.onloadedmetadata = () => {
      if (identity !== token) return;
      const duration = Number.isFinite(video.duration) ? video.duration : 1;
      $("metadata").textContent =
        `${video.videoWidth} × ${video.videoHeight} · ${formatTime(duration)}`;
      $("range-start").max = $("range-end").max = String(duration);
      $("start").value = "0";
      $("end").value = String(duration);
      range();
    };
    video.onerror = () => {
      if (identity === token) {
        $("metadata").textContent = "浏览器无法预览，可尝试WASM抽帧";
        $("start").value = "0";
        $("end").value = "1";
        range();
      }
    };
    range();
  }
  $("file").onchange = (event) => {
    choose(event.target.files[0]);
    event.target.value = "";
  };
  $("dropzone").ondragover = (event) => event.preventDefault();
  $("dropzone").ondrop = (event) => {
    event.preventDefault();
    const files = [...event.dataTransfer.files];
    if (files.every((file) => /\.png$/i.test(file.name)))
      onImages(files, Number($("fps").value) || 12);
    else choose(files[0]);
  };
  for (const id of ["start", "end", "fps"]) $(id).oninput = () => range();
  for (const id of ["range-start", "range-end"])
    $(id).oninput = () => range(true);
  $("extract").onclick = () =>
    onVideo(file, {
      start: Number($("start").value),
      end: Number($("end").value),
      fps: Number($("fps").value),
      fullRange: Number($("end").value) === Number($("range-end").max),
    });
  let originals = [];
  // 播放时钟只归预览弹窗所有，禁止在每个动画帧重复触发打开弹窗。
  $("play").onclick = () => {
    video.pause();
    if (originals.length) onPlay(originals, Number($("fps").value) || 12);
  };
  return {
    setVideoMetadata({ duration, width, height, end }) {
      $("metadata").textContent =
        `${width} × ${height} · ${formatTime(duration)}`;
      $("range-start").max = $("range-end").max = String(duration);
      $("end").value = String(end);
      range();
    },
    render(session, locked) {
      busy = locked;
      const editor = session.editor;
      originals = editor
        ? editor.original.map((id) => session.frames.get(id))
        : [];
      const key = originals.map((frame) => frame.id).join("|");
      if (key !== signature) {
        signature = key;
        $("grid").replaceChildren();
        originals.forEach((frame, index) => {
          const button = document.createElement("button");
          button.className = "frame";
          button.setAttribute("aria-label", `查看第${index + 1}帧`);
          const img = document.createElement("img");
          urls.thumbnail(img, frame, true);
          img.alt = `第${index + 1}帧`;
          img.loading = "lazy";
          const info = document.createElement("div");
          info.className = "frame-info";
          info.textContent = String(index + 1).padStart(3, "0");
          button.append(img, info);
          button.onclick = () => {
            video.pause();
            onPreview(frame, originals);
          };
          $("grid").append(button);
        });
      }
      $("grid").hidden = !originals.length;
      $("result-empty").hidden = !!originals.length;
      $("result-meta").textContent = originals.length
        ? `${originals.length} 帧 · ${originals[0].width} × ${originals[0].height}${originals.length > 1 ? ` · ${session.fps} fps` : ""}`
        : "尚未提取";
      $("play").disabled = locked || !originals.length;
      for (const id of ["open", "open-images", "file", "images-file", "empty"])
        $(id).disabled = locked;
      for (const id of ["start", "end", "fps", "range-start", "range-end"])
        $(id).disabled = locked || !file;
      for (const button of $("grid").querySelectorAll("button"))
        button.disabled = locked;
      range();
    },
    showImages(session) {
      token++;
      file = null;
      video.pause();
      video.onloadedmetadata = video.onerror = null;
      video.removeAttribute("src");
      video.load();
      if (url) URL.revokeObjectURL(url);
      url = null;
      sourceMode(true);
      video.hidden = true;
      $("empty").hidden = true;
      $("source-png").src = urls.get(session.ordered[0], true);
      $("source-png").hidden = false;
      $("filename").textContent = session.name;
      $("metadata").textContent = `PNG序列 · ${session.ordered.length} 帧`;
      $("fps").value = String(session.fps);
      $("start").value = $("end").value = "0";
      $("range-start").max = $("range-end").max = "1";
      range();
    },
    pause() {
      video.pause();
    },
    dispose() {
      token++;
      if (url) URL.revokeObjectURL(url);
    },
  };
}
