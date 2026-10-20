import { nodes, playback } from "./media.js";
import { createKeyingControls } from "./keying-controls.js";
export function createMattingView(
  root,
  { urls, onSelect, onRepair, onKey, onSample, onCancel },
) {
  const $ = nodes(root),
    cards = new Map();
  let session = null,
    locked = false;
  const clock = playback($("matting-play"), {
    frames: () => session?.ordered || [],
    fps: () => Number($("matting-fps").value) || 12,
    onFrame: (frame) => onSelect(frame.id),
    loop: true,
  });
  const showImage = () => {
    if (session?.active)
      $("matting-image").src = urls.get(session.active, keying.picking);
  };
  const keying = createKeyingControls(root, {
    onApply: onKey,
    onSample,
    onPickChange: () => {
      clock.stop();
      showImage();
    },
  });
  $("matting-cancel").onclick = onCancel;
  const step = (delta) => {
    clock.stop();
    const order = session.editor.order,
      index = order.indexOf(session.editor.active);
    onSelect(order[(index + delta + order.length) % order.length]);
  };
  $("matting-prev").onclick = () => step(-1);
  $("matting-next").onclick = () => step(1);
  $("matting-image").title = "双击精修";
  $("matting-image").ondblclick = () => {
    clock.stop();
    if (!locked && !keying.picking && session.active) onRepair(session.active);
  };
  return {
    setBackgroundColor: keying.setColor,
    render(next, busy) {
      session = next;
      locked = busy;
      const frames = session.ordered,
        ids = new Set(frames.map((frame) => frame.id));
      keying.render(session.active, session.frames, locked);
      for (const [id, card] of cards)
        if (!ids.has(id)) {
          card.remove();
          cards.delete(id);
        }
      frames.forEach((frame, index) => {
        let card = cards.get(frame.id);
        if (!card) {
          card = document.createElement("div");
          card.className = "frame matting-card";
          card.dataset.frameId = frame.id;
          card.innerHTML =
            '<button class="matting-card-preview" title="双击精修"><img alt=""><div class="frame-info"></div></button>';
          card.querySelector("button").onclick = () => {
            clock.stop();
            onSelect(frame.id);
          };
          card.querySelector("button").ondblclick = () => onRepair(frame);
          cards.set(frame.id, card);
        }
        const img = card.querySelector("img");
        urls.thumbnail(img, frame);
        img.alt = `第${index + 1}帧`;
        card
          .querySelector("button")
          .setAttribute("aria-label", `查看第${index + 1}帧结果`);
        card.querySelector("button").disabled = locked;
        card.querySelector(".frame-info").textContent = String(
          index + 1,
        ).padStart(3, "0");
        card.classList.toggle("is-active", session.editor.active === frame.id);
        if ($("matting-grid").children[index] !== card)
          $("matting-grid").insertBefore(
            card,
            $("matting-grid").children[index] || null,
          );
      });
      const active = session.active;
      $("matting-image").hidden = !active;
      $("matting-empty").hidden = !!active;
      if (active) {
        const url = urls.get(active, keying.picking);
        if ($("matting-image").getAttribute("src") !== url)
          $("matting-image").src = url;
      }
      $("matting-frame-label").textContent = active
        ? `${session.editor.order.indexOf(active.id) + 1} / ${frames.length}`
        : "—";
      $("matting-meta").textContent = frames.length
        ? `${frames.length} 帧`
        : "尚无帧序列";
      if (frames.length && $("matting-status").textContent === "等待抽帧结果")
        $("matting-status").textContent = "可双击精修，或先运行纯色去背";
      for (const id of [
        "matting-prev",
        "matting-next",
        "matting-play",
        "matting-fps",
      ])
        $(id).disabled = locked || !frames.length;
      $("matting-cancel").hidden = !busy;
    },
    pause() {
      clock.stop();
      keying.stopPicking();
    },
  };
}
