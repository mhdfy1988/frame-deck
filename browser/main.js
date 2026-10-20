import { BrowserSession } from "./session.js";
import { readImages } from "./images.js";
import { VideoExtractor } from "./video.js";
import { removeBackground, sampleBackground } from "./tasks.js";
import { exportFrames, download } from "./export.js";
import { decorateIcons, setControl } from "../web/icons-ui.js";
import { ImageURLs } from "./ui/media.js";
import { createExtract } from "./ui/extract.js";
import { createOrganizerView } from "./ui/organizer.js";
import { createMattingView } from "./ui/matting.js";
import { createExportPanel } from "./ui/export-panel.js";
import { createViewer, createLoopDialog } from "./ui/dialogs.js";
import { createRepair } from "./ui/repair.js";

// 页面壳沿用原模板；这里只协调四屏、任务及唯一会话，不重建模板或像素算法。
const $ = (id) => document.getElementById(id),
  session = new BrowserSession(),
  urls = new ImageURLs();
decorateIcons();
const exportTab = document.createElement("button");
exportTab.id = "tab-export";
exportTab.className = "step-button";
exportTab.setAttribute("role", "tab");
exportTab.setAttribute("aria-controls", "export-workspace");
exportTab.setAttribute("aria-selected", "false");
setControl(exportTab, "download", "导出");
$("workflow-steps").append(exportTab);
let stage = "extract",
  controller = null,
  dialogLocked = false;
const locked = () => !!controller || dialogLocked || repair.opened;
function update() {
  const busy = locked(),
    ready = !!session.ordered.length;
  extract.render(session, busy);
  organizer.render(session, busy);
  matting.render(session, busy);
  exporter.render(busy);
  for (const id of [
    "tab-extract",
    "organize",
    "tab-matting",
    "process-organize",
    "tab-export",
  ])
    $(id).disabled =
      busy ||
      (id === "organize" ? !session.editor : id !== "tab-extract" && !ready);
  $("extract-complete").hidden = !session.editor;
  $("process-source").textContent = ready
    ? `当前帧序列 · ${session.ordered.length} 帧`
    : "当前抽帧结果";
  for (const [id, active] of [
    ["tab-extract", stage === "extract"],
    ["organize", stage === "organize" || stage === "matting"],
    ["tab-export", stage === "export"],
  ]) {
    $(id).setAttribute("aria-selected", String(active));
    $(id).tabIndex = active ? 0 : -1;
  }
  $("process-organize").setAttribute(
    "aria-pressed",
    String(stage === "organize"),
  );
  $("tab-matting").setAttribute("aria-pressed", String(stage === "matting"));
}
function pause() {
  extract.pause();
  organizer.pause();
  matting.pause();
  viewer.pause();
  loops.pause();
  exporter.pause();
}
function activate(next) {
  if (locked()) return;
  pause();
  stage = next;
  for (const name of ["extract", "organize", "matting", "export"])
    $(
      name === "organize" ? "organizer-workspace" : `${name}-workspace`,
    ).hidden = name !== stage;
  $("process-mode").hidden = !["organize", "matting"].includes(stage);
  if (next === "export") exporter.open();
  update();
  if (next === "organize") organizer.fit();
}
const status = (text) =>
  ($(
    stage === "matting"
      ? "matting-status"
      : stage === "export"
        ? "export-status"
        : stage === "organize"
          ? "edit-status"
          : "status",
  ).textContent = text);
const error = (text) =>
  ($(
    stage === "matting"
      ? "matting-error"
      : stage === "export"
        ? "export-error"
        : stage === "organize"
          ? "edit-error"
          : "error",
  ).textContent = text);
async function task(action) {
  if (locked()) return;
  pause();
  controller = new AbortController();
  const own = controller;
  error("");
  update();
  $("cancel").hidden = false;
  $("matting-cancel").hidden = false;
  try {
    await action({ signal: own.signal, onProgress: status });
    status("处理完成");
  } catch (reason) {
    status(own.signal.aborted ? "处理已取消" : "处理未完成");
    error(
      own.signal.aborted
        ? "已取消，保留原序列"
        : reason.message || String(reason),
    );
  } finally {
    controller = null;
    $("cancel").hidden = true;
    $("matting-cancel").hidden = true;
    update();
  }
}
function edit(action) {
  if (locked()) return;
  organizer.pause();
  action();
  update();
}
const canReplace = () =>
  !session.dirty || confirm("导入将替换当前序列，未导出的调整会丢失。继续吗？");
function load(frames, fps, name, images = false) {
  urls.clear();
  session.load(frames, fps, name);
  if (images) extract.showImages(session);
}
const cancel = () =>
  controller?.abort(new DOMException("已取消", "AbortError"));
const viewer = createViewer($("viewer"), { urls });
const extract = createExtract($("extract-workspace"), {
  urls,
  onSourceModeChange: (images) => {
    $("tab-extract").querySelector("span").textContent = images
      ? "导入"
      : "抽帧";
    setControl(
      $("tab-extract").querySelector("svg"),
      images ? "image" : "film",
    );
    $("extract-complete").setAttribute(
      "aria-label",
      images ? "已有导入帧" : "已有抽帧结果",
    );
  },
  onPreview: (frame, frames) =>
    viewer.open(frame, frames, { fps: session.fps }),
  onPlay: (frames, fps) => viewer.open(frames[0], frames, { fps, play: true }),
  onImages(files, fps) {
    if (!canReplace()) return;
    task(async (options) =>
      load(
        await readImages(files, options.signal, options.onProgress),
        fps,
        files[0].name,
        true,
      ),
    );
  },
  onVideo(file, values) {
    if (!file || !canReplace()) return;
    task(async (options) =>
      load(
        await new VideoExtractor().extract(file, {
          ...values,
          ...options,
          onMetadata: extract.setVideoMetadata,
        }),
        values.fps,
        file.name,
      ),
    );
  },
});
const organizer = createOrganizerView($("organizer-workspace"), {
  urls,
  onEdit: edit,
  onLoop: () => {
    if (!locked()) loops.open();
  },
  onControls: () => {},
});
const repair = createRepair({
  session,
  dialog: $("repair-dialog"),
  onSaved: update,
  onClosed: update,
  onError: error,
});
const matting = createMattingView($("matting-workspace"), {
  urls,
  onSelect: (id) => {
    if (!locked()) {
      session.editor.view(id);
      update();
    }
  },
  onRepair: (frame) => {
    if (!locked()) {
      pause();
      repair.open(frame);
      update();
    }
  },
  onCancel: cancel,
  onSample: (frame, point) =>
    task(async (options) => {
      const color = await sampleBackground(frame, point, options);
      matting.setBackgroundColor(color);
    }),
  onKey: (settings) =>
    task(async (options) => {
      if (
        !confirm(
          `将以同一底色从原图重新处理全部保留帧，覆盖当前去背及精修结果。${settings.connected ? "仅去除与图边连通的背景。" : "全图模式可能删除主体中的同色部分。"}继续吗？`,
        )
      )
        return;
      const revision = session.revision,
        { results, color } = await removeBackground(
          session.ordered,
          settings,
          options,
        );
      session.replaceAll(results, revision);
      matting.setBackgroundColor(color, settings.color === null);
    }),
});
const exporter = createExportPanel($("export-workspace"), {
  session,
  onCancel: cancel,
  onDownload: (values) =>
    task(async (options) => {
      download(await exportFrames(session.ordered, values, options));
      session.markExported();
    }),
});
const loops = createLoopDialog($("loop-dialog"), {
  session,
  urls,
  onApply: (action) => {
    dialogLocked = false;
    edit(action);
  },
  onLock: (value) => {
    dialogLocked = value;
    update();
  },
});
for (const [id, next] of [
  ["tab-extract", "extract"],
  ["organize", "organize"],
  ["process-organize", "organize"],
  ["tab-matting", "matting"],
  ["tab-export", "export"],
])
  $(id).onclick = () => activate(next);
$("cancel").onclick = cancel;
document.addEventListener("keydown", (event) => {
  if (
    event.target.closest("input,select,textarea") ||
    document.querySelector("dialog[open]") ||
    locked() ||
    stage !== "organize"
  )
    return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    edit(() => session.editor.selectAll());
  } else if (event.key === "Delete") {
    event.preventDefault();
    edit(() => session.editor.remove());
  } else if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "y"
  ) {
    event.preventDefault();
    edit(() => session.editor.redo());
  } else if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "z"
  ) {
    event.preventDefault();
    edit(() =>
      event.shiftKey ? session.editor.redo() : session.editor.undo(),
    );
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});
window.addEventListener("beforeunload", (event) => {
  if (session.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  controller?.abort();
  pause();
  extract.dispose();
  organizer.dispose();
  viewer.dispose();
  loops.dispose();
  repair.dispose();
  exporter.dispose();
  urls.clear();
});
update();
