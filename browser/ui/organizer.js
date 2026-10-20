import { nodes, imageView, playback } from "./media.js";
import { setControl } from "../../web/icons-ui.js";

export function createOrganizerView(
  root,
  { urls, onEdit, onLoop, onControls },
) {
  const $ = nodes(root),
    cards = new Map();
  let session = null,
    locked = false,
    dragged = null;
  const preview = imageView({
    image: $("edit-image"),
    viewport: $("edit-viewport"),
    label: $("edit-zoom-label"),
    fitButton: $("edit-fit"),
    nativeButton: $("edit-100"),
    smaller: $("edit-zoom-out"),
    larger: $("edit-zoom-in"),
  });
  const clock = playback($("edit-play"), {
    frames: () => session?.editor?.checkedFrames || [],
    fps: () => Number($("edit-play-fps").value) || 12,
    onFrame: (frame) => {
      session.editor.view(frame.id);
      render(session, locked);
    },
    onChange: () => onControls(),
  });
  const mutate = (action) => {
    if (locked) return;
    clock.stop();
    onEdit(() => action(session.editor));
  };
  for (const [id, action] of Object.entries({
    "edit-all": (editor) => editor.selectAll(),
    "edit-none": (editor) => editor.clearSelection(),
    "edit-delete": (editor) => editor.remove(),
    "edit-undo": (editor) => editor.undo(),
    "edit-redo": (editor) => editor.redo(),
    "edit-reset": (editor) => editor.reset(),
  }))
    $(id).onclick = () => mutate(action);
  $("edit-find-loop").onclick = onLoop;
  const step = (delta) =>
    mutate((editor) => {
      const index = editor.order.indexOf(editor.active);
      editor.view(
        editor.order[
          Math.max(0, Math.min(editor.order.length - 1, index + delta))
        ],
      );
    });
  $("edit-previous").onclick = () => step(-1);
  $("edit-next").onclick = () => step(1);
  function render(next, busy) {
    session = next;
    locked = busy;
    const editor = session.editor,
      frames = session.ordered,
      ids = new Set(frames.map((frame) => frame.id));
    for (const [id, card] of cards)
      if (!ids.has(id)) {
        card.remove();
        cards.delete(id);
      }
    frames.forEach((frame, index) => {
      let card = cards.get(frame.id);
      const number = String(editor.byId.get(frame.id).sourceIndex + 1).padStart(
        3,
        "0",
      );
      if (!card) {
        card = document.createElement("div");
        card.className = "frame";
        card.dataset.frameId = frame.id;
        card.innerHTML =
          '<button class="frame-preview"><img draggable="false" alt=""><div class="frame-info"><span></span></div></button><input class="frame-check" type="checkbox"><span class="frame-check-mark" aria-hidden="true"></span><button class="frame-delete" type="button"></button>';
        cards.set(frame.id, card);
        card.querySelector(".frame-preview").onclick = () =>
          mutate((value) => value.view(frame.id));
        card.querySelector(".frame-check").onclick = (event) => {
          event.stopPropagation();
          mutate((value) =>
            value.select(frame.id, {
              toggle: !event.shiftKey,
              range: event.shiftKey,
            }),
          );
        };
        const del = card.querySelector(".frame-delete");
        setControl(del, "trash-2");
        del.onclick = (event) => {
          event.stopPropagation();
          mutate((value) => value.remove([frame.id]));
        };
        card.ondragstart = (event) => {
          if (locked || event.target.closest(".frame-delete,.frame-check")) {
            event.preventDefault();
            return;
          }
          clock.stop();
          dragged = frame.id;
          event.dataTransfer.setData("text/plain", frame.id);
          card.classList.add("dragging");
        };
        card.ondragover = (event) => {
          if (dragged && !locked) {
            event.preventDefault();
            card.classList.add("drop-swap");
          }
        };
        card.ondragleave = () => card.classList.remove("drop-swap");
        card.ondrop = (event) => {
          event.preventDefault();
          const id = dragged;
          dragged = null;
          card.classList.remove("drop-swap");
          if (id) mutate((value) => value.swap(id, frame.id));
        };
        card.ondragend = () => {
          dragged = null;
          for (const node of cards.values())
            node.classList.remove("drop-swap", "dragging");
        };
        card.onkeydown = (event) => {
          if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            const order = session.editor.order,
              at = order.indexOf(frame.id),
              target = order[at + (event.key === "ArrowLeft" ? -1 : 1)];
            if (target) mutate((value) => value.swap(frame.id, target));
          }
        };
      }
      const img = card.querySelector("img");
      urls.thumbnail(img, frame, true);
      img.alt = `原帧${number}`;
      card.querySelector(".frame-info span").textContent = number;
      card
        .querySelector(".frame-preview")
        .setAttribute("aria-label", `查看原帧${number}`);
      card
        .querySelector(".frame-preview")
        .setAttribute("aria-current", String(editor.active === frame.id));
      card
        .querySelector(".frame-delete")
        .setAttribute("aria-label", `删除原帧${number}`);
      card
        .querySelector(".frame-check")
        .setAttribute("aria-label", `勾选原帧${number}`);
      card.querySelector(".frame-check").checked = editor.selected.has(
        frame.id,
      );
      card.classList.toggle("is-active", editor.active === frame.id);
      card.classList.toggle("is-checked", editor.selected.has(frame.id));
      card.draggable = !locked;
      for (const element of card.querySelectorAll("button,input"))
        element.disabled = locked;
      if ($("edit-grid").children[index] !== card)
        $("edit-grid").insertBefore(
          card,
          $("edit-grid").children[index] || null,
        );
    });
    const active = session.active;
    preview.show(active, active ? urls.get(active, true) : "");
    $("edit-empty").hidden = !!active;
    $("edit-frame-label").textContent =
      `${active ? editor.order.indexOf(active.id) + 1 : 0} / ${frames.length}`;
    $("edit-meta").textContent =
      `保留 ${frames.length} 帧${session.dirty ? " · 未导出" : ""}`;
    $("edit-selection").textContent = `已勾选 ${editor?.selected.size || 0} 帧`;
    for (const button of root.querySelectorAll(
      ".edit-toolbar button,.edit-preview-bottom button",
    ))
      button.disabled = locked || !editor;
    $("edit-play").disabled = locked || !editor?.selected.size;
    $("edit-play").setAttribute(
      "aria-label",
      clock.active ? "暂停播放勾选帧" : "播放勾选帧",
    );
    $("edit-delete").disabled = locked || !editor?.selected.size;
    $("edit-undo").disabled = locked || !editor?.undoStack.length;
    $("edit-redo").disabled = locked || !editor?.redoStack.length;
    $("edit-find-loop").disabled = locked || frames.length < 7;
  }
  return {
    render,
    pause: clock.stop,
    fit: preview.fit,
    dispose() {
      clock.stop();
      preview.dispose();
    },
  };
}
