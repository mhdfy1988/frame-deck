import { validateReplacement } from "../images.js";

export function createRepair({ session, onSaved, onClosed, onError, dialog }) {
  if (!dialog) throw new Error("精修必须绑定原界面弹窗");
  const root = dialog;
  const iframe = root.querySelector("iframe");
  const errorText = document.createElement("p");
  errorText.setAttribute("role", "status");
  errorText.hidden = true;
  root.append(errorText);
  let current = null,
    closing = false,
    ready = false;
  const finishClose = () => {
    current = null;
    root.close();
    iframe.src = "about:blank";
    onClosed();
  };
  const close = () => {
    if (!current) return;
    if (!ready) {
      finishClose();
      return;
    }
    closing = true;
    iframe.contentWindow.postMessage(
      { kind: "repair-flush", batch: current.batch, frame: current.token },
      location.origin,
    );
  };
  root.querySelector("#repair-close").onclick = close;
  root.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  async function receive(event) {
    if (
      !current ||
      event.origin !== location.origin ||
      event.source !== iframe.contentWindow
    )
      return;
    const data = event.data;
    if (data?.kind === "browser-repair-request") {
      const port = event.ports[0];
      if (!port) return;
      try {
        const url = new URL(data.url, location.origin),
          path = `/api/matting-batches/${current.batch}/frames/${current.token}`,
          frame = session.frames.get(current.id);
        if (!frame || url.origin !== location.origin)
          throw new Error("精修帧已失效");
        if (
          data.method === "GET" &&
          ["source", "auto", "current"].some(
            (name) => url.pathname === `${path}/${name}`,
          )
        ) {
          port.postMessage({
            ok: true,
            blob: url.pathname.endsWith("/source")
              ? frame.source
              : frame.current,
          });
        } else if (data.method === "PUT" && url.pathname === path) {
          const expected = Number(url.searchParams.get("revision")),
            blob = new Blob([data.body], { type: "image/png" }),
            identity = current;
          await validateReplacement(blob, frame);
          if (current !== identity) throw new Error("精修会话已关闭");
          const revision = session.replace(frame.id, blob, expected);
          port.postMessage({ ok: true, revision });
          onSaved();
        } else throw new Error("静态精修器不支持该操作");
      } catch (error) {
        port.postMessage({ ok: false, detail: error.message });
      } finally {
        port.close();
      }
      return;
    }
    if (data?.batch !== current.batch || data?.frame !== current.token) return;
    if (data.kind === "repair-ready") ready = true;
    if (data.kind === "repair-flushed" && closing) {
      finishClose();
    }
    if (data.kind === "repair-error") {
      closing = false;
      errorText.hidden = false;
      errorText.textContent = data.message;
      onError(data.message);
    }
  }
  window.addEventListener("message", receive);
  return {
    root,
    open(frame) {
      const batch = crypto.randomUUID().replaceAll("-", "");
      current = { id: frame.id, batch, token: `${batch}-000001` };
      closing = false;
      ready = false;
      errorText.hidden = true;
      errorText.textContent = "";
      iframe.src = new URL(
        `./repair/repair.html?batch=${current.batch}&frame=${current.token}&revision=${frame.revision}`,
        document.baseURI,
      ).href;
      root.showModal();
    },
    get opened() {
      return !!current;
    },
    dispose() {
      window.removeEventListener("message", receive);
      current = null;
      iframe.src = "about:blank";
      root.close();
    },
  };
}
