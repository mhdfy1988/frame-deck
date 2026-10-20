import { nodes } from "./media.js";

// 取色坐标基于原图object-fit:contain的实际区域，不采屏幕截图颜色。
export function containPoint(clientX, clientY, rect, width, height) {
  const scale = Math.min(rect.width / width, rect.height / height);
  const x = (clientX - rect.left - (rect.width - width * scale) / 2) / scale;
  const y = (clientY - rect.top - (rect.height - height * scale) / 2) / scale;
  return x >= 0 && y >= 0 && x < width && y < height
    ? [Math.floor(x), Math.floor(y)]
    : null;
}

export function createKeyingControls(
  root,
  { onApply, onSample, onPickChange },
) {
  const $ = nodes(root),
    fields = ["matting-tolerance", "matting-softness", "matting-cleanup"];
  let frame = null,
    group = null,
    busy = true,
    picking = false;
  function stopPicking() {
    picking = false;
    root.classList.remove("is-picking-background");
    $("matting-pick").setAttribute("aria-pressed", "false");
    $("matting-pick").textContent = "取色";
    onPickChange();
  }
  function controls() {
    for (const id of fields) $(id + "-value").textContent = $(id).value;
    for (const id of [
      ...fields,
      "matting-auto-color",
      "matting-connected",
      "matting-pick",
    ])
      $(id).disabled = busy || !frame;
    $("matting-color").disabled =
      busy || !frame || $("matting-auto-color").checked;
    $("matting-start").disabled =
      busy ||
      !frame ||
      fields.some((id) => !$(id).validity.valid || !$(id).value);
  }
  for (const id of fields) $(id).oninput = controls;
  $("matting-auto-color").onchange = controls;
  $("matting-start").onclick = () => {
    if ($("matting-start").disabled) return;
    const hex = $("matting-color").value;
    onApply({
      color: $("matting-auto-color").checked
        ? null
        : [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)),
      tolerance: Number($("matting-tolerance").value),
      softness: Number($("matting-softness").value),
      cleanup: Number($("matting-cleanup").value),
      connected: $("matting-connected").checked,
    });
  };
  $("matting-pick").onclick = () => {
    if (picking) return stopPicking();
    picking = true;
    root.classList.add("is-picking-background");
    $("matting-pick").setAttribute("aria-pressed", "true");
    $("matting-pick").textContent = "取消取色";
    onPickChange();
  };
  $("matting-image").onclick = (event) => {
    if (!picking || busy || !frame) return;
    const point = containPoint(
      event.clientX,
      event.clientY,
      $("matting-image").getBoundingClientRect(),
      frame.width,
      frame.height,
    );
    if (!point) return;
    const source = frame;
    stopPicking();
    onSample(source, point);
  };
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && picking) {
      event.preventDefault();
      stopPicking();
    }
  });
  return {
    get picking() {
      return picking;
    },
    stopPicking,
    setColor(color, automatic = false) {
      $("matting-color").value =
        "#" +
        color.map((channel) => channel.toString(16).padStart(2, "0")).join("");
      $("matting-auto-color").checked = automatic;
      controls();
    },
    render(next, identity, locked) {
      const changed = frame?.id !== next?.id;
      frame = next;
      busy = locked;
      if (identity !== group) {
        group = identity;
        $("matting-auto-color").checked = true;
        $("matting-color").value = "#00ff00";
      }
      if (picking && (changed || busy)) stopPicking();
      controls();
    },
  };
}
