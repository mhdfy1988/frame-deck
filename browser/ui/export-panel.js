import { nodes, playback } from "./media.js";
import { exportSettings, exportGeometry } from "../../web/export-core.js";
import { commonCrop, renderExportPreview } from "../export.js";

export function createExportPanel(root, { session, onDownload, onCancel }) {
  const $ = nodes(root),
    canvas = $("export-canvas"),
    ctx = canvas.getContext("2d");
  let busy = false,
    identity = "",
    index = 0,
    boxMode = false,
    sheetView = false,
    native = false,
    serial = 0,
    wanted = null,
    loading = false,
    pointer = null,
    cropController = null;
  const values = () => ({
    name: $("export-name").value,
    format: $("export-format").value,
    size: $("export-size").value,
    width: Number($("export-width").value),
    height: Number($("export-height").value),
    fps: Number($("export-fps").value),
    columns: Number($("export-columns").value),
    filter: $("export-filter").value,
    upscale: $("export-upscale").checked,
    crop: $("export-crop-enabled").checked
      ? ["x", "y", "cw", "ch"].map((id) => Number($(`export-${id}`).value))
      : [0, 0, session.ordered[0].width, session.ordered[0].height],
  });
  function settings() {
    const frames = session.ordered;
    if (!frames.length) throw new Error("请先导入帧序列");
    return exportSettings(
      { frameIds: frames.map((frame) => frame.id) },
      { canvas: frames[0] },
      values(),
    );
  }
  function pose() {
    if (canvas.hidden) return;
    const stage = $("export-stage"),
      scale = native
        ? 1
        : Math.min(
            (stage.clientWidth - 24) / canvas.width,
            (stage.clientHeight - 24) / canvas.height,
            1,
          );
    canvas.style.width = `${Math.max(1, canvas.width * scale)}px`;
    canvas.style.height = `${Math.max(1, canvas.height * scale)}px`;
    $("export-zoom-label").textContent = `${Math.round(scale * 100)}%`;
    stage.classList.toggle("native-overflow", native);
    $("export-fit").setAttribute("aria-pressed", String(!native));
    $("export-100").setAttribute("aria-pressed", String(native));
  }
  function controls() {
    let valid = true;
    try {
      const value = settings(),
        geometry = exportGeometry(value, session.ordered.length);
      $("export-summary").textContent =
        `${session.ordered.length} 帧 · 单帧 ${value.width} × ${value.height}${value.format === "sheet" ? ` · 图集 ${geometry.cols} × ${geometry.rows}` : ""}`;
      $("export-geometry").textContent =
        `画布 ${value.width} × ${value.height} · 缩放 ${Math.round(geometry.scale * 100)}%`;
    } catch (error) {
      valid = false;
      $("export-summary").textContent = error.message;
    }
    for (const element of root.querySelectorAll("input,select,button"))
      element.disabled = busy || !session.ordered.length;
    $("export-download").disabled = busy || !valid;
    $("export-cancel").hidden = !busy;
    $("export-cancel").disabled = false;
    for (const id of ["x", "y", "cw", "ch"])
      $(`export-${id}`).disabled = busy || !$("export-crop-enabled").checked;
    $("export-custom-size").hidden = $("export-size").value !== "custom";
    $("export-columns-label").hidden = $("export-format").value !== "sheet";
    $("export-sheet-view").hidden = $("export-format").value !== "sheet";
    $("export-sheet-view").textContent = sheetView ? "查看动作" : "查看图集";
    $("export-sheet-view").setAttribute("aria-pressed", String(sheetView));
    $("export-position").textContent = sheetView
      ? "整张图集"
      : `${session.ordered.length ? index + 1 : 0} / ${session.ordered.length}`;
  }
  async function drain() {
    if (loading) return;
    loading = true;
    while (wanted) {
      const request = wanted;
      wanted = null;
      let result;
      try {
        result = await renderExportPreview(
          request.frames,
          request.settings,
          request.index,
          { sheet: request.sheet, raw: request.raw },
        );
        if (request.token !== serial) continue;
        canvas.width = result.width;
        canvas.height = result.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(result, 0, 0);
        if (request.raw) {
          ctx.strokeStyle = "#236b56";
          ctx.lineWidth = Math.max(1, canvas.width / 300);
          ctx.setLineDash([canvas.width / 100, canvas.width / 100]);
          ctx.strokeRect(...request.settings.crop);
          ctx.setLineDash([]);
        }
        canvas.hidden = false;
        $("export-empty").hidden = true;
        pose();
      } catch (error) {
        if (request.token === serial) {
          $("export-error").textContent = error.message;
          canvas.hidden = true;
        }
      } finally {
        if (result) result.width = result.height = 1;
      }
    }
    loading = false;
  }
  function changed() {
    controls();
    $("export-error").textContent = "";
    const token = ++serial;
    try {
      wanted = {
        frames: session.ordered,
        settings: settings(),
        index,
        sheet: sheetView,
        raw: boxMode,
        token,
      };
      drain();
    } catch (error) {
      wanted = null;
      $("export-error").textContent = error.message;
    }
  }
  function defaults() {
    const frame = session.ordered[0];
    if (!frame) return;
    $("export-name").value = session.name;
    $("export-fps").value = String(session.fps);
    $("export-size").value = "original";
    $("export-width").value = String(frame.width);
    $("export-height").value = String(frame.height);
    $("export-format").value = "sequence";
    $("export-columns").value = "4";
    $("export-filter").value = "smooth";
    $("export-upscale").checked = false;
    $("export-crop-enabled").checked = false;
    [0, 0, frame.width, frame.height].forEach(
      (v, i) => ($(`export-${["x", "y", "cw", "ch"][i]}`).value = String(v)),
    );
    index = 0;
    sheetView = boxMode = false;
    native = false;
    $("export-preview-title").textContent = "输出预览";
    $("export-box-mode").textContent = "框选裁剪";
  }
  const clock = playback($("export-play"), {
    frames: () => session.ordered,
    fps: () => Number($("export-fps").value) || 12,
    onFrame: (frame) => {
      index = session.ordered.indexOf(frame);
      changed();
    },
    loop: true,
  });
  for (const element of root.querySelectorAll("input,select"))
    element.addEventListener("change", () => {
      if (element.id === "export-size" && /^\d+$/.test(element.value)) {
        $("export-width").value = element.value;
        $("export-height").value = element.value;
      }
      clock.stop();
      if (
        ["export-padding", "export-crop-enabled"].includes(element.id) &&
        $("export-crop-enabled").checked
      ) {
        $("export-auto").click();
        return;
      }
      changed();
    });
  $("export-auto").onclick = async () => {
    clock.stop();
    cropController?.abort();
    const controller = new AbortController();
    cropController = controller;
    try {
      const crop = await commonCrop(
        session.ordered,
        Number($("export-padding").value),
        {
          signal: controller.signal,
          onProgress: (text) => ($("export-status").textContent = text),
        },
      );
      if (cropController !== controller || controller.signal.aborted) return;
      crop.forEach(
        (value, i) =>
          ($(`export-${["x", "y", "cw", "ch"][i]}`).value = String(value)),
      );
      $("export-crop-enabled").checked = true;
      changed();
    } catch (error) {
      if (!controller.signal.aborted)
        $("export-error").textContent = error.message;
    }
  };
  $("export-reset").onclick = () => {
    clock.stop();
    defaults();
    changed();
  };
  $("export-fit").onclick = () => {
    native = false;
    pose();
  };
  $("export-100").onclick = () => {
    native = true;
    pose();
  };
  $("export-sheet-view").onclick = () => {
    clock.stop();
    sheetView = !sheetView;
    boxMode = false;
    changed();
  };
  $("export-box-mode").onclick = () => {
    clock.stop();
    sheetView = false;
    boxMode = !boxMode;
    $("export-crop-enabled").checked = true;
    $("export-preview-title").textContent = boxMode
      ? "框选整组裁剪范围"
      : "输出预览";
    $("export-box-mode").textContent = boxMode ? "查看输出" : "框选裁剪";
    changed();
  };
  const point = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return [
      Math.max(
        0,
        Math.min(
          canvas.width,
          Math.round(
            ((event.clientX - bounds.left) * canvas.width) / bounds.width,
          ),
        ),
      ),
      Math.max(
        0,
        Math.min(
          canvas.height,
          Math.round(
            ((event.clientY - bounds.top) * canvas.height) / bounds.height,
          ),
        ),
      ),
    ];
  };
  canvas.onpointerdown = (event) => {
    if (!boxMode || busy) return;
    pointer = point(event);
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = (event) => {
    if (!pointer) return;
    const p = point(event),
      crop = [
        Math.min(pointer[0], p[0]),
        Math.min(pointer[1], p[1]),
        Math.max(1, Math.abs(pointer[0] - p[0])),
        Math.max(1, Math.abs(pointer[1] - p[1])),
      ];
    crop.forEach(
      (v, i) => ($(`export-${["x", "y", "cw", "ch"][i]}`).value = String(v)),
    );
  };
  canvas.onpointerup = () => {
    if (pointer) {
      pointer = null;
      changed();
    }
  };
  canvas.onpointercancel = () => (pointer = null);
  const step = (delta) => {
    clock.stop();
    index = (index + delta + session.ordered.length) % session.ordered.length;
    changed();
  };
  $("export-prev").onclick = () => step(-1);
  $("export-next").onclick = () => step(1);
  $("export-download").onclick = () => {
    try {
      onDownload(values());
    } catch (error) {
      $("export-error").textContent = error.message;
    }
  };
  $("export-cancel").onclick = onCancel;
  window.addEventListener("resize", pose);
  return {
    open() {
      const key = `${session.revision}:${session.editor?.signature}`;
      if (key !== identity) {
        identity = key;
        defaults();
      }
      changed();
    },
    render(locked) {
      busy = locked;
      controls();
    },
    pause() {
      clock.stop();
      cropController?.abort();
      serial++;
      wanted = null;
    },
    dispose() {
      clock.stop();
      cropController?.abort();
      serial++;
      wanted = null;
      window.removeEventListener("resize", pose);
    },
  };
}
