import { nodes, imageView, playback } from "./media.js";
import { findLoops } from "../tasks.js";
import { bindLoopCandidates, applyLoopCandidate } from "../../web/loop-core.js";

export function createViewer(root, { urls }) {
  const $ = nodes(root);
  let frames = [],
    index = 0;
  const preview = imageView({
    image: $("full-image"),
    viewport: $("viewport"),
    label: $("zoom-label"),
    fitButton: $("zoom-fit"),
    nativeButton: $("zoom-100"),
    smaller: $("zoom-out"),
    larger: $("zoom-in"),
  });
  const show = () => {
    const frame = frames[index];
    if (!frame) return;
    preview.show(frame, urls.get(frame, true));
    $("viewer-title").textContent = `第 ${index + 1} / ${frames.length} 帧`;
  };
  const clock = playback($("viewer-play"), {
    frames: () => frames,
    fps: () => Number($("viewer-play-fps").value) || 12,
    startIndex: () => (index === frames.length - 1 ? 0 : index),
    onFrame: (frame) => {
      index = frames.indexOf(frame);
      show();
    },
  });
  $("previous").onclick = () => {
    clock.stop();
    index = (index + frames.length - 1) % frames.length;
    show();
  };
  $("next").onclick = () => {
    clock.stop();
    index = (index + 1) % frames.length;
    show();
  };
  $("close-viewer").onclick = () => {
    clock.stop();
    root.close();
  };
  root.addEventListener("cancel", clock.stop);
  root.addEventListener("close", () => {
    clock.stop();
    frames = [];
    preview.show(null, "");
  });
  return {
    open(frame, values, { fps = 12, play = false } = {}) {
      clock.stop();
      frames = values;
      index = frames.indexOf(frame);
      $("viewer-play-fps").value = String(fps);
      root.showModal();
      show();
      preview.fit();
      if (play) clock.start();
    },
    pause: clock.stop,
    dispose() {
      clock.stop();
      preview.dispose();
    },
  };
}
export function createLoopDialog(root, { session, urls, onApply, onLock }) {
  const $ = nodes(root);
  let controller = null,
    candidates = [],
    active = null,
    index = 0,
    identity = 0;
  const show = () => {
    if (!active) return;
    const frame = session.frames.get(active.frameIds[index]);
    $("loop-image").src = urls.get(frame);
    $("loop-position").textContent = `${index + 1} / ${active.count}`;
    $("loop-original").textContent =
      `原帧 ${session.editor.byId.get(frame.id).sourceIndex + 1}`;
  };
  const clock = playback($("loop-play"), {
    frames: () => active?.frameIds || [],
    fps: () => Number($("loop-fps").value) || 12,
    onFrame: (id) => {
      index = active.frameIds.indexOf(id);
      show();
    },
    loop: true,
  });
  function choose(candidate) {
    clock.stop();
    active = candidate;
    index = 0;
    $("loop-stage").hidden = false;
    $("loop-preview-controls").hidden = false;
    $("loop-apply").disabled = false;
    [...$("loop-list").children].forEach((button, i) =>
      button.setAttribute("aria-pressed", String(candidates[i] === active)),
    );
    show();
  }
  const close = () => root.close();
  $("loop-close").onclick = $("loop-cancel").onclick = close;
  root.addEventListener("close", () => {
    identity++;
    controller?.abort();
    controller = null;
    clock.stop();
    onLock(false);
  });
  $("loop-previous").onclick = () => {
    clock.stop();
    index = (index + active.count - 1) % active.count;
    show();
  };
  $("loop-next").onclick = () => {
    clock.stop();
    index = (index + 1) % active.count;
    show();
  };
  $("loop-apply").onclick = () => {
    if (!active) return;
    const candidate = active;
    root.close();
    onApply(() => applyLoopCandidate(session.editor, candidate));
  };
  return {
    async open() {
      const own = ++identity;
      controller = new AbortController();
      candidates = [];
      active = null;
      clock.stop();
      $("loop-list").replaceChildren();
      $("loop-stage").hidden = true;
      $("loop-preview-controls").hidden = true;
      $("loop-apply").disabled = true;
      $("loop-state").textContent = "准备分析";
      root.showModal();
      onLock(true);
      try {
        const values = await findLoops(session.ordered, {
          signal: controller.signal,
          onProgress: (text) => ($("loop-state").textContent = text),
        });
        if (own !== identity) return;
        candidates = bindLoopCandidates(
          session.editor.order,
          session.editor.revision,
          values,
        );
        $("loop-state").textContent = candidates.length
          ? "推荐循环 · 请检查首尾衔接"
          : "未找到合适循环；可提高抽帧采样率或换一段动作";
        for (const [i, candidate] of candidates.entries()) {
          const button = document.createElement("button");
          button.className = "loop-candidate";
          button.dataset.candidate = String(i);
          button.setAttribute("aria-pressed", "false");
          const title = document.createElement("strong");
          title.textContent = `${candidate.count} 帧`;
          const label = document.createElement("span");
          label.textContent = `当前位置 ${candidate.start + 1}–${candidate.endExclusive}`;
          button.append(title, label);
          button.onclick = () => choose(candidate);
          $("loop-list").append(button);
        }
        if (candidates.length) choose(candidates[0]);
      } catch (error) {
        if (own === identity && !controller?.signal.aborted)
          $("loop-state").textContent = error.message;
      }
    },
    pause: clock.stop,
    dispose() {
      identity++;
      controller?.abort();
      clock.stop();
    },
  };
}
