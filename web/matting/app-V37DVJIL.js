// web/src/editor.js
var TILE = 64;
var HISTORY_LIMIT = 128 * 1024 * 1024;
var MAX_PIXELS = 12e6;
var clamp = (v, low, high) => Math.max(low, Math.min(high, v));
function imagePoint(clientX, clientY, rect, width, height) {
  const x = (clientX - rect.left) * width / rect.width;
  const y = (clientY - rect.top) * height / rect.height;
  return { x, y, inside: x >= 0 && y >= 0 && x < width && y < height };
}
function fitScale(width, height, paneWidth, paneHeight) {
  return Math.min((paneWidth - 32) / width, (paneHeight - 80) / height);
}
var Editor = class {
  constructor(width, height, source, automatic, historyLimit = HISTORY_LIMIT) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error("\u56FE\u7247\u5C3A\u5BF8\u8D85\u9650");
    const n = width * height * 4;
    if (source.length !== n || automatic.length !== n) throw new Error("\u539F\u56FE\u4E0E\u7ED3\u679C\u5C3A\u5BF8\u4E0D\u4E00\u81F4");
    this.width = width;
    this.height = height;
    this.source = new Uint8ClampedArray(source);
    this.automatic = new Uint8ClampedArray(automatic);
    this.data = new Uint8ClampedArray(automatic);
    this.history = [];
    this.redoStack = [];
    this.historyBytes = 0;
    this.historyLimit = historyLimit;
    this.active = null;
    this.dirty = false;
    this.trimmed = false;
  }
  tileAt(x, y) {
    const tx = Math.floor(x / TILE) * TILE, ty = Math.floor(y / TILE) * TILE;
    const key = `${tx},${ty}`;
    let t = this.active.tiles.get(key);
    if (!t) {
      const w = Math.min(TILE, this.width - tx), h = Math.min(TILE, this.height - ty);
      const before = new Uint8ClampedArray(w * h * 4);
      for (let j = 0; j < h; j++) before.set(this.data.subarray(((ty + j) * this.width + tx) * 4, ((ty + j) * this.width + tx + w) * 4), j * w * 4);
      t = { x: tx, y: ty, w, h, before, coverage: new Uint8Array(w * h) };
      this.active.tiles.set(key, t);
    }
    return t;
  }
  begin(mode, settings2) {
    if (this.active) throw new Error("\u4E0A\u4E00\u6B65\u5C1A\u672A\u7ED3\u675F");
    if (!["remove", "restore"].includes(mode)) throw new Error("\u672A\u77E5\u753B\u7B14");
    this.active = { mode, settings: { size: clamp(settings2.size, 1, 512), hardness: clamp(settings2.hardness, 0, 100) / 100, strength: clamp(settings2.strength, 1, 100) / 100 }, tiles: /* @__PURE__ */ new Map(), last: null };
  }
  affect(x, y, coverage) {
    if (coverage <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    const t = this.tileAt(x, y), k = (y - t.y) * t.w + x - t.x;
    const weight = Math.round(clamp(coverage, 0, 1) * 255);
    if (weight <= t.coverage[k]) return false;
    t.coverage[k] = weight;
    const m = weight / 255, i = (y * this.width + x) * 4, b = k * 4;
    if (this.active.mode === "remove") this.data[i + 3] = Math.round(t.before[b + 3] * (1 - m));
    else {
      for (let c = 0; c < 4; c++) this.data[i + c] = Math.round(t.before[b + c] * (1 - m) + this.source[i + c] * m);
    }
    return true;
  }
  stamp(px, py) {
    const { size, hardness, strength } = this.active.settings, radius = size / 2;
    if (size === 1) {
      px = Math.floor(px) + 0.5;
      py = Math.floor(py) + 0.5;
    }
    const x0 = Math.max(0, Math.floor(px - radius)), x1 = Math.min(this.width - 1, Math.ceil(px + radius));
    const y0 = Math.max(0, Math.floor(py - radius)), y1 = Math.min(this.height - 1, Math.ceil(py + radius));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const distance = Math.hypot(x + 0.5 - px, y + 0.5 - py) / radius;
      if (distance > 1) continue;
      const coverage = distance <= hardness || hardness === 1 ? 1 : (1 - distance) / (1 - hardness);
      this.affect(x, y, coverage * strength);
    }
    return { x: x0, y: y0, w: Math.max(0, x1 - x0 + 1), h: Math.max(0, y1 - y0 + 1) };
  }
  move(x, y) {
    if (!this.active) return [];
    const last = this.active.last, regions = [];
    if (!last) regions.push(this.stamp(x, y));
    else {
      const distance = Math.hypot(x - last.x, y - last.y), spacing = Math.max(0.5, this.active.settings.size / 5);
      const steps = Math.max(1, Math.ceil(distance / spacing));
      for (let k = 1; k <= steps; k++) regions.push(this.stamp(last.x + (x - last.x) * k / steps, last.y + (y - last.y) * k / steps));
    }
    this.active.last = { x, y };
    return regions;
  }
  writeTile(t, data) {
    for (let j = 0; j < t.h; j++) this.data.set(data.subarray(j * t.w * 4, (j + 1) * t.w * 4), ((t.y + j) * this.width + t.x) * 4);
  }
  readTile(t) {
    const data = new Uint8ClampedArray(t.before.length);
    for (let j = 0; j < t.h; j++) data.set(this.data.subarray(((t.y + j) * this.width + t.x) * 4, ((t.y + j) * this.width + t.x + t.w) * 4), j * t.w * 4);
    return data;
  }
  commit(label = "\u7B14\u753B") {
    if (!this.active) return [];
    const tiles = [];
    for (const t of this.active.tiles.values()) {
      const after = this.readTile(t);
      if (after.some((v, k) => v !== t.before[k])) tiles.push({ x: t.x, y: t.y, w: t.w, h: t.h, before: t.before, after });
    }
    this.active = null;
    if (!tiles.length) return [];
    const entry = { label, tiles, bytes: tiles.reduce((n, t) => n + t.before.byteLength + t.after.byteLength, 0) };
    for (const e of this.redoStack) this.historyBytes -= e.bytes;
    this.redoStack = [];
    this.history.push(entry);
    this.historyBytes += entry.bytes;
    this.dirty = true;
    while (this.historyBytes > this.historyLimit && this.history.length > 1) {
      this.historyBytes -= this.history.shift().bytes;
      this.trimmed = true;
    }
    return tiles;
  }
  cancel() {
    if (!this.active) return [];
    const tiles = [...this.active.tiles.values()];
    tiles.forEach((t) => this.writeTile(t, t.before));
    this.active = null;
    return tiles;
  }
  undo() {
    if (this.active) return [];
    const e = this.history.pop();
    if (!e) return [];
    e.tiles.forEach((t) => this.writeTile(t, t.before));
    this.redoStack.push(e);
    this.dirty = true;
    return e.tiles;
  }
  redo() {
    if (this.active) return [];
    const e = this.redoStack.pop();
    if (!e) return [];
    e.tiles.forEach((t) => this.writeTile(t, t.after));
    this.history.push(e);
    this.dirty = true;
    return e.tiles;
  }
  reset() {
    this.begin("remove", { size: 1, hardness: 100, strength: 100 });
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
      const i = (y * this.width + x) * 4;
      if (this.data[i] !== this.automatic[i] || this.data[i + 1] !== this.automatic[i + 1] || this.data[i + 2] !== this.automatic[i + 2] || this.data[i + 3] !== this.automatic[i + 3]) {
        this.tileAt(x, y);
        this.data.set(this.automatic.subarray(i, i + 4), i);
      }
    }
    return this.commit("\u91CD\u7F6E\u4FEE\u8865");
  }
  async applyMaskAsync(mask, mode, onChunk) {
    if (mask.length !== this.width * this.height) throw new Error("\u9009\u533A\u5C3A\u5BF8\u4E0D\u4E00\u81F4");
    this.begin(mode, { size: 1, hardness: 100, strength: 100 });
    try {
      for (let row = 0; row < this.height; row += 16) {
        const end = Math.min(this.height, row + 16);
        for (let y = row; y < end; y++) for (let x = 0; x < this.width; x++) if (mask[y * this.width + x]) this.affect(x, y, mask[y * this.width + x] / 255);
        await onChunk({ x: 0, y: row, w: this.width, h: end - row });
      }
      return this.commit("\u9B54\u6CD5\u68D2" + (mode === "remove" ? "\u53BB\u9664" : "\u6062\u590D"));
    } catch (error) {
      this.cancel();
      throw error;
    }
  }
};

// web/src/selection-preview.js
function selectionOutline(mask, sourceWidth, sourceHeight, view) {
  const { left, top, scale: scale2, width, height, dpr = 1 } = view;
  if (mask.length !== sourceWidth * sourceHeight || ![left, top, scale2, width, height, dpr].every(Number.isFinite) || scale2 <= 0 || dpr <= 0 || width <= 0 || height <= 0) throw new Error("\u9009\u533A\u9884\u89C8\u5C3A\u5BF8\u65E0\u6548");
  const w = Math.ceil(width * dpr), h = Math.ceil(height * dpr);
  if (w * h > 4e6) throw new Error("\u9009\u533A\u9884\u89C8\u50CF\u7D20\u8D85\u9650");
  const radius = Math.ceil(dpr), stride = w + 2 * radius, binary = new Uint8Array(stride * (h + 2 * radius));
  const sourceX = new Int32Array(stride);
  for (let x = 0; x < stride; x++) sourceX[x] = Math.floor(((x - radius + 0.5) / dpr - left) / scale2);
  for (let y = -radius; y < h + radius; y++) {
    const sy = Math.floor(((y + 0.5) / dpr - top) / scale2);
    if (sy < 0 || sy >= sourceHeight) continue;
    const row = (y + radius) * stride;
    for (let x = 0; x < stride; x++) {
      const sx = sourceX[x];
      if (sx >= 0 && sx < sourceWidth && mask[sy * sourceWidth + sx]) binary[row + x] = 1;
    }
  }
  let edges = new Uint32Array(1024), axes = new Uint8Array(1024), count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y + radius) * stride + x + radius;
    const horizontal = !binary[i - radius * stride] || !binary[i + radius * stride];
    if (binary[i] && (horizontal || !binary[i - radius] || !binary[i + radius])) {
      if (count === edges.length) {
        const size = Math.min(w * h, edges.length * 2), grown = new Uint32Array(size), grownAxes = new Uint8Array(size);
        grown.set(edges);
        grownAxes.set(axes);
        edges = grown;
        axes = grownAxes;
      }
      edges[count] = y * w + x;
      axes[count++] = horizontal ? 0 : 1;
    }
  }
  return { width: w, height: h, dpr, edges: edges.slice(0, count), axes: axes.slice(0, count), data: new Uint8ClampedArray(w * h * 4) };
}
function paintSelectionOutline(outline, phase = 0) {
  const { width, dpr, edges, axes, data } = outline, period = 8 * dpr;
  for (let j = 0; j < edges.length; j++) {
    const i = edges[j], x = i % width, y = Math.floor(i / width), position = axes[j] ? y : x, dark = ((position + phase * dpr) % period + period) % period < 4 * dpr, k = i * 4;
    data[k] = dark ? 24 : 255;
    data[k + 1] = dark ? 32 : 255;
    data[k + 2] = dark ? 39 : 255;
    data[k + 3] = 255;
  }
  return data;
}

// web/src/app.js
document.documentElement.dataset.uiRevision = "163";
var $ = (selector) => document.querySelector(selector);
var input = $("#fileInput");
var choose = $("#chooseButton");
var download = $("#downloadButton");
var comparison = $("#comparison");
var sourceImage = $("#sourceImage");
var resultImage = $("#resultImage");
var sourceEmpty = $("#sourceEmpty");
var resultEmpty = $("#resultEmpty");
var working = $("#working");
var message = $("#message");
var panes = [...comparison.querySelectorAll(".pane")];
var canvases = [sourceImage, resultImage];
var overlays = [...comparison.querySelectorAll(".selection-layer")];
var cursors = [...comparison.querySelectorAll(".brush-cursor")];
var outlineCanvases = [...comparison.querySelectorAll(".selection-outline")];
var reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
var toolbar = $("#editToolbar");
var brushSettings = $("#brushSettings");
var wandSettings = $("#wandSettings");
var selectionActions = $("#selectionActions");
var backgroundChoices = $("#backgroundChoices");
var zoomControls = $("#zoomControls");
var undoButton = $("#undoButton");
var redoButton = $("#redoButton");
var sourceContext = sourceImage.getContext("2d");
var resultContext = resultImage.getContext("2d");
var editor = null;
var originalFile = null;
var currentName = "\u89D2\u8272";
var requestId = 0;
var busy = false;
var exporting = false;
var scale = 1;
var panX = 0;
var panY = 0;
var tool = "move";
var space = false;
var gesture = null;
var cursorPoint = null;
var selection = null;
var wandTask = null;
var selectionId = 0;
var paintData = null;
var pending = null;
var frame = 0;
var wandSeed = null;
var wandTimer = 0;
var wandPending = false;
var wandDrag = null;
var contourViews = [];
var contourFrame = 0;
var contourDirty = false;
var contourTick = -Infinity;
var settings = { size: 32, hardness: 75, strength: 100 };
var embedded = location.pathname === "/assets/matting/repair.html";
var repairParams = new URLSearchParams(location.search);
var repairBatch = repairParams.get("batch");
var repairFrame = repairParams.get("frame");
var repairRevision = Number(repairParams.get("revision") || 0);
var autoSaveTimer = 0;
var autoSaveFailed = false;
var flushRequested = false;
function scheduleAutoSave() {
  if (!embedded || !editor?.dirty || busy || gesture || exporting || wandPending || wandTask || autoSaveFailed || autoSaveTimer) return;
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = 0;
    exportCurrent();
  }, 200);
}
function reportRepair(kind, extra = {}) {
  if (embedded) parent.postMessage({ kind, batch: repairBatch, frame: repairFrame, ...extra }, location.origin);
}
function setMessage(value, error = false) {
  message.textContent = value;
  message.classList.toggle("error", error);
}
function task(kind, payload, transfer = []) {
  const worker = new Worker("/assets/matting/worker-4EQHDEQU.js", { type: "module" });
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    rejectPromise = reject;
    worker.onmessage = ({ data }) => {
      worker.terminate();
      data.error ? reject(new Error(data.error)) : resolve(data.value);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "\u56FE\u50CF\u4EFB\u52A1\u5931\u8D25"));
    };
    worker.postMessage({ kind, ...payload }, transfer);
  });
  return { promise, cancel() {
    worker.terminate();
    rejectPromise(new DOMException("\u5DF2\u53D6\u6D88", "AbortError"));
  } };
}
async function decodeFile(file) {
  if (file.type === "image/png") {
    const bytes = await file.arrayBuffer();
    return task("decode", { bytes }, [bytes]).promise;
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 12e6) throw new Error("\u56FE\u7247\u50CF\u7D20\u4E0D\u80FD\u8D85\u8FC71200\u4E07");
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
  } finally {
    bitmap.close();
  }
}
function fit() {
  if (!editor) return 1;
  return Math.max(0.01, Math.min(...panes.map((p) => fitScale(editor.width, editor.height, p.clientWidth, p.clientHeight))));
}
function renderView() {
  if (!editor) return;
  const minScale = Math.min(fit(), 0.05);
  scale = clamp(scale, minScale, 16);
  const maxX = editor.width * scale / 2 + panes[0].clientWidth / 2 - 40, maxY = editor.height * scale / 2 + panes[0].clientHeight / 2 - 40;
  panX = clamp(panX, -maxX, maxX);
  panY = clamp(panY, -maxY, maxY);
  for (const canvas of [...canvases, ...overlays]) {
    canvas.style.width = `${editor.width * scale}px`;
    canvas.style.height = `${editor.height * scale}px`;
    canvas.style.transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px))`;
  }
  $("#zoomValue").value = `${Math.round(scale * 100)}%`;
  comparison.classList.toggle("editing", tool !== "move" && !space);
  comparison.classList.toggle("has-image", true);
  if (cursorPoint) renderCursor(cursorPoint);
  queueSelectionPreview();
}
function setZoom(next, anchor = null) {
  if (!editor || gesture || busy) return;
  const prior = scale;
  scale = clamp(next, Math.min(fit(), 0.05), 16);
  if (anchor) {
    panX = anchor.x - (anchor.x - panX) * (scale / prior);
    panY = anchor.y - (anchor.y - panY) * (scale / prior);
  }
  renderView();
}
function renderCursor(point) {
  cursorPoint = point;
  cursors.forEach((cursor, k) => {
    const show = !!point && ["remove", "restore"].includes(tool) && !space && !busy;
    cursor.hidden = !show;
    if (!show) return;
    const image = canvases[k].getBoundingClientRect(), pane = panes[k].getBoundingClientRect();
    cursor.style.left = `${image.left - pane.left + point.x * scale}px`;
    cursor.style.top = `${image.top - pane.top + point.y * scale}px`;
    cursor.style.width = cursor.style.height = `${Math.max(1, settings.size * scale)}px`;
  });
}
function pointFor(event, pane) {
  const k = panes.indexOf(pane);
  return imagePoint(event.clientX, event.clientY, canvases[k].getBoundingClientRect(), editor.width, editor.height);
}
function refresh(tiles = []) {
  if (!editor) return;
  if (embedded && editor.dirty) autoSaveFailed = false;
  if (!tiles.length) {
    resultContext.putImageData(paintData, 0, 0);
    return;
  }
  for (const t of tiles) resultContext.putImageData(paintData, 0, 0, t.x, t.y, t.w, t.h);
}
function queuePaint(regions) {
  for (const r of regions) {
    if (!r.w || !r.h) continue;
    pending = pending ? { x: Math.min(pending.x, r.x), y: Math.min(pending.y, r.y), right: Math.max(pending.right, r.x + r.w), bottom: Math.max(pending.bottom, r.y + r.h) } : { x: r.x, y: r.y, right: r.x + r.w, bottom: r.y + r.h };
  }
  if (!frame && pending) frame = requestAnimationFrame(flushPaint);
}
function flushPaint() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  if (pending && editor) {
    resultContext.putImageData(paintData, 0, 0, pending.x, pending.y, pending.right - pending.x, pending.bottom - pending.y);
  }
  pending = null;
}
function updateControls() {
  const locked = !editor || busy || !!gesture || exporting || wandPending;
  const parametersLocked = !editor || busy || !!gesture || exporting;
  toolbar.querySelectorAll("button,input").forEach((el) => {
    const disabled = ["tolerance", "toleranceValue", "smoothSelection"].includes(el.id) ? parametersLocked : locked;
    if (el.disabled !== disabled) el.disabled = disabled;
  });
  choose.disabled = busy || !!gesture || exporting;
  $("#recomputeButton").disabled = locked;
  download.disabled = locked;
  undoButton.disabled = locked || !editor?.history.length;
  redoButton.disabled = locked || !editor?.redoStack.length;
  $("#resetButton").disabled = locked;
  $("#cancelSelection").disabled = busy || !selection && !wandPending;
  selectionActions.hidden = !selection;
  if (editor) $("#historyStatus").textContent = editor.trimmed ? "\u8F83\u65E9\u8BB0\u5F55\u5DF2\u91CA\u653E" : `${editor.history.length}\u6B65`;
  reportRepair("repair-state", { dirty: !!editor?.dirty, busy: busy || exporting || !!gesture || wandPending });
  if (flushRequested && !editor?.dirty && !busy && !exporting && !gesture && !wandPending && !wandTask) {
    flushRequested = false;
    reportRepair("repair-flushed");
  }
  scheduleAutoSave();
}
function setTool(next) {
  if (gesture || busy || wandTask) return;
  tool = next;
  cancelSelection();
  toolbar.querySelectorAll("[data-tool]").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.tool === tool)));
  brushSettings.hidden = !["remove", "restore"].includes(tool);
  wandSettings.hidden = tool !== "wand";
  $("#cancelSelection").hidden = tool !== "wand";
  panes.forEach((p) => p.dataset.tool = tool);
  renderCursor(null);
  renderView();
  updateControls();
}
function cancelSelection() {
  wandDrag = null;
  selectionId++;
  clearTimeout(wandTimer);
  wandTimer = 0;
  wandPending = false;
  wandSeed = null;
  if (wandTask) {
    wandTask.cancel();
    wandTask = null;
  }
  selection = null;
  if (contourFrame) cancelAnimationFrame(contourFrame);
  contourFrame = 0;
  contourViews = [];
  contourDirty = false;
  for (const layer of overlays) {
    layer.getContext("2d").clearRect(0, 0, layer.width, layer.height);
    layer.hidden = true;
  }
  for (const layer of outlineCanvases) {
    layer.getContext("2d").clearRect(0, 0, layer.width, layer.height);
    layer.hidden = true;
  }
  updateControls();
}
function queueSelectionPreview() {
  if (!selection) return;
  contourDirty = true;
  if (!contourFrame && !document.hidden) contourFrame = requestAnimationFrame(drawSelectionPreview);
}
function drawSelectionPreview(time) {
  contourFrame = 0;
  if (!selection || !editor || document.hidden) return;
  const rebuild = contourDirty;
  if (rebuild) {
    contourViews = panes.map((pane, k) => {
      const image = canvases[k].getBoundingClientRect(), rect = pane.getBoundingClientRect(), width = pane.clientWidth, height = pane.clientHeight;
      const dpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(39e5 / Math.max(1, width * height)));
      const outline = selectionOutline(selection, editor.width, editor.height, { left: image.left - rect.left, top: image.top - rect.top, scale, width, height, dpr });
      const canvas = outlineCanvases[k];
      canvas.width = outline.width;
      canvas.height = outline.height;
      canvas.hidden = false;
      return { outline, context: canvas.getContext("2d"), pixels: new ImageData(outline.data, outline.width, outline.height) };
    });
    contourDirty = false;
  }
  if (rebuild || time - contourTick >= 120) {
    const phase = reducedMotion.matches ? 0 : Math.floor(time / 120) % 8;
    for (const view of contourViews) {
      paintSelectionOutline(view.outline, phase);
      view.context.putImageData(view.pixels, 0, 0);
    }
    contourTick = time;
  }
  if (!reducedMotion.matches && !wandDrag) contourFrame = requestAnimationFrame(drawSelectionPreview);
}
reducedMotion.addEventListener("change", queueSelectionPreview);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (contourFrame) cancelAnimationFrame(contourFrame);
    contourFrame = 0;
  } else queueSelectionPreview();
});
function showSelection(mask) {
  selection = mask;
  let count = 0;
  const pixels = new Uint8ClampedArray(mask.length * 4);
  for (let i = 0; i < mask.length; i++) if (mask[i]) {
    count++;
    pixels[i * 4] = 36;
    pixels[i * 4 + 1] = 94;
    pixels[i * 4 + 2] = 232;
    pixels[i * 4 + 3] = Math.round(mask[i] * 0.1);
  }
  if (!count) {
    selection = null;
    setMessage("\u539F\u56FE\u6B64\u5904\u900F\u660E\uFF0C\u6CA1\u6709\u53EF\u6309\u989C\u8272\u9009\u62E9\u7684\u533A\u57DF\u3002");
    updateControls();
    return;
  }
  for (const layer of overlays) {
    layer.hidden = false;
    layer.getContext("2d").putImageData(new ImageData(pixels, editor.width, editor.height), 0, 0);
  }
  queueSelectionPreview();
  $("#selectionCount").textContent = `${count.toLocaleString()}\u50CF\u7D20`;
  setMessage("\u68C0\u67E5\u9009\u533A\uFF0C\u518D\u53BB\u9664\u6216\u6062\u590D\u3002");
  updateControls();
}
async function selectAt(point) {
  cancelSelection();
  wandSeed = { x: point.x, y: point.y };
  await updateWandSelection();
}
function scheduleWandSelection() {
  if (!editor || !wandSeed || busy || exporting) return;
  selectionId++;
  clearTimeout(wandTimer);
  if (wandTask) {
    wandTask.cancel();
    wandTask = null;
  }
  wandPending = true;
  setMessage("\u6B63\u5728\u66F4\u65B0\u9009\u533A\u2026");
  updateControls();
  if (wandDrag) wandDrag.changed = true;
  wandTimer = setTimeout(() => {
    wandTimer = 0;
    updateWandSelection();
  }, 80);
}
function finishWandDrag(event) {
  if (!wandDrag || event && event.pointerId !== wandDrag.pointerId) return;
  wandDrag = null;
  if (wandTimer) {
    clearTimeout(wandTimer);
    wandTimer = 0;
    updateWandSelection();
  }
  queueSelectionPreview();
}
async function updateWandSelection() {
  if (!editor || !wandSeed) return;
  const id = ++selectionId, session = editor, point = wandSeed;
  wandPending = true;
  const source = editor.source.slice();
  wandTask = task("wand", { source, width: editor.width, height: editor.height, x: point.x, y: point.y, tolerance: Number($("#tolerance").value), smooth: $("#smoothSelection").checked }, [source.buffer]);
  setMessage("\u6B63\u5728\u9009\u62E9\u2026");
  updateControls();
  try {
    const mask = await wandTask.promise;
    if (id !== selectionId || session !== editor) return;
    wandTask = null;
    wandPending = false;
    showSelection(mask);
  } catch (error) {
    if (id !== selectionId || session !== editor) return;
    cancelSelection();
    if (error.name !== "AbortError") setMessage(error.message, true);
  }
}
function finishGesture(cancel = false) {
  if (!gesture) return;
  const prior = gesture;
  gesture = null;
  if (prior.kind === "brush") {
    flushPaint();
    const tiles = cancel ? editor.cancel() : editor.commit();
    refresh(tiles);
  }
  if (prior.pane.hasPointerCapture(prior.pointerId)) prior.pane.releasePointerCapture(prior.pointerId);
  panes.forEach((p) => p.classList.remove("panning"));
  updateControls();
}
for (const pane of panes) {
  pane.addEventListener("wheel", (event) => {
    if (!editor) return;
    event.preventDefault();
    const b = pane.getBoundingClientRect();
    setZoom(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { x: event.clientX - b.left - b.width / 2, y: event.clientY - b.top - b.height / 2 });
  }, { passive: false });
  pane.addEventListener("pointerdown", (event) => {
    if (!editor || busy || exporting || wandTask || gesture || event.button !== 0 || event.target.closest("button")) return;
    const point = pointFor(event, pane);
    if (!point.inside && tool !== "move" && !space) return;
    if (tool === "wand" && !space) {
      selectAt(point);
      return;
    }
    const kind = tool === "move" || space ? "pan" : "brush";
    cancelSelection();
    gesture = { kind, pane, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    pane.setPointerCapture(event.pointerId);
    if (kind === "brush") {
      editor.begin(tool, settings);
      queuePaint(editor.move(point.x, point.y));
      renderCursor(point);
    } else pane.classList.add("panning");
    event.preventDefault();
    updateControls();
  });
  pane.addEventListener("pointermove", (event) => {
    if (!editor) return;
    const point = pointFor(event, pane);
    renderCursor(point.inside ? point : null);
    if (!gesture || gesture.pane !== pane || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "pan") {
      panX += event.clientX - gesture.x;
      panY += event.clientY - gesture.y;
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      renderView();
    } else if (point.inside) {
      queuePaint(editor.move(point.x, point.y));
    } else editor.active.last = null;
  });
  pane.addEventListener("pointerleave", () => {
    if (!gesture) renderCursor(null);
  });
  pane.addEventListener("pointerup", (event) => {
    if (gesture?.pointerId === event.pointerId) finishGesture();
  });
  pane.addEventListener("pointercancel", () => finishGesture(true));
  pane.addEventListener("lostpointercapture", () => finishGesture(true));
}
toolbar.addEventListener("click", (event) => {
  const t = event.target.closest("[data-tool]");
  if (t) setTool(t.dataset.tool);
});
for (const key of ["size", "hardness", "strength"]) {
  let change = function(value) {
    if (gesture) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    settings[key] = Math.round(clamp(v, Number(range.min), Number(range.max)));
    range.value = number.value = settings[key];
    if (cursorPoint) renderCursor(cursorPoint);
  };
  const range = $(`#brush-${key}`), number = $(`#brush-${key}-number`);
  range.addEventListener("input", () => change(range.value));
  number.addEventListener("change", () => change(number.value));
}
undoButton.addEventListener("click", () => {
  cancelSelection();
  refresh(editor.undo());
  updateControls();
});
redoButton.addEventListener("click", () => {
  cancelSelection();
  refresh(editor.redo());
  updateControls();
});
$("#resetButton").addEventListener("click", () => {
  cancelSelection();
  refresh(editor.reset());
  updateControls();
});
$("#cancelSelection").addEventListener("click", cancelSelection);
for (const mode of ["remove", "restore"]) $(`#selection-${mode}`).addEventListener("click", async () => {
  if (!selection || busy || wandPending) return;
  busy = true;
  updateControls();
  setMessage("\u6B63\u5728\u5E94\u7528\u9009\u533A\u2026");
  try {
    await editor.applyMaskAsync(selection, mode, async (region) => {
      refresh([region]);
      await new Promise(requestAnimationFrame);
    });
    cancelSelection();
    setMessage(mode === "remove" ? "\u9009\u533A\u5DF2\u53BB\u9664\u3002" : "\u9009\u533A\u5DF2\u6062\u590D\uFF1B\u8BF7\u68C0\u67E5\u6DF7\u8272\u8FB9\u7F18\u3002");
  } catch (error) {
    refresh();
    setMessage(error.message, true);
  } finally {
    busy = false;
    updateControls();
  }
});
$("#tolerance").addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  wandDrag = { pointerId: event.pointerId, changed: false };
  if (contourFrame) cancelAnimationFrame(contourFrame);
  contourFrame = 0;
  if (wandPending) scheduleWandSelection();
});
window.addEventListener("pointerup", finishWandDrag);
window.addEventListener("pointercancel", finishWandDrag);
$("#tolerance").addEventListener("input", () => {
  $("#toleranceValue").value = $("#tolerance").value;
  scheduleWandSelection();
});
$("#toleranceValue").addEventListener("input", () => {
  const field = $("#toleranceValue");
  if (field.value === "") return;
  const value = Number(field.value);
  if (!Number.isFinite(value)) return;
  $("#tolerance").value = String(Math.round(clamp(value, 0, 255)));
  scheduleWandSelection();
});
$("#toleranceValue").addEventListener("change", () => {
  $("#toleranceValue").value = $("#tolerance").value;
});
$("#smoothSelection").addEventListener("change", scheduleWandSelection);
$("#zoomOut").addEventListener("click", () => setZoom(scale / 1.25));
$("#zoomIn").addEventListener("click", () => setZoom(scale * 1.25));
$("#zoomFit").addEventListener("click", () => {
  if (gesture || busy) return;
  scale = fit();
  panX = panY = 0;
  renderView();
});
$("#zoomActual").addEventListener("click", () => setZoom(1));
window.addEventListener("resize", renderView);
window.addEventListener("blur", () => {
  finishGesture(true);
  finishWandDrag();
  space = false;
  renderView();
});
window.addEventListener("beforeunload", (e) => {
  if (!embedded && editor?.dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("keydown", (event) => {
  if (event.target.closest("input,textarea,select,[contenteditable=true]")) return;
  if (event.code === "Space") {
    event.preventDefault();
    if (!gesture) {
      space = true;
      renderCursor(null);
      renderView();
    }
    return;
  }
  if (event.key === "Escape") {
    finishGesture(true);
    cancelSelection();
    return;
  }
  if (!editor || busy || gesture || exporting || wandTask) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === "z") {
    event.preventDefault();
    (event.shiftKey ? redoButton : undoButton).click();
  } else if (mod && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redoButton.click();
  } else if (event.key === "[" || event.key === "]") {
    settings.size = clamp(settings.size + (event.key === "]" ? 4 : -4), 1, 512);
    $("#brush-size").value = $("#brush-size-number").value = settings.size;
    if (cursorPoint) renderCursor(cursorPoint);
  }
});
window.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    space = false;
    renderView();
  }
});
choose.addEventListener("click", () => input.click());
input.addEventListener("change", () => {
  if (input.files[0]) processFile(input.files[0]);
  input.value = "";
});
$("#recomputeButton").addEventListener("click", () => {
  if (originalFile) processFile(originalFile);
});
comparison.addEventListener("dragover", (e) => {
  e.preventDefault();
  comparison.classList.add("dragging");
});
comparison.addEventListener("dragleave", (e) => {
  if (!comparison.contains(e.relatedTarget)) comparison.classList.remove("dragging");
});
comparison.addEventListener("drop", (e) => {
  e.preventDefault();
  comparison.classList.remove("dragging");
  if (!gesture && e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
});
backgroundChoices.addEventListener("click", (e) => {
  const b = e.target.closest("[data-background]");
  if (!b) return;
  $(".result-pane").dataset.background = b.dataset.background;
  backgroundChoices.querySelectorAll("button").forEach((el) => {
    const selected = el === b;
    el.classList.toggle("selected", selected);
    el.setAttribute("aria-pressed", String(selected));
  });
});
async function exportCurrent() {
  if (!editor || busy || gesture || exporting || wandTask) return;
  exporting = true;
  updateControls();
  const session = editor, rgba = editor.data.slice();
  try {
    const bytes = await task("encode", { width: editor.width, height: editor.height, rgba }, [rgba.buffer]).promise;
    if (embedded) {
      const response = await fetch(`${repairParams.get("workflow") === "1" ? "/api/workflow-matting/jobs" : "/api/matting-batches"}/${repairBatch}/frames/${repairFrame}?revision=${repairRevision}`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: bytes });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        throw new Error(problem.detail || "\u4FDD\u5B58\u5931\u8D25");
      }
      repairRevision = (await response.json()).revision;
      if (session === editor) editor.dirty = false;
      setMessage("\u5DF2\u5B9E\u65F6\u540C\u6B65\u3002");
      reportRepair("repair-saved", { revision: repairRevision });
    } else {
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" })), a = document.createElement("a");
      a.href = url;
      a.download = `${currentName}-\u900F\u660E.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3e4);
      if (session === editor) editor.dirty = false;
      setMessage("\u5DF2\u5BFC\u51FA\u5F53\u524D\u4FEE\u8865\u7ED3\u679C\u3002");
    }
  } catch (error) {
    autoSaveFailed = true;
    setMessage(embedded ? `\u81EA\u52A8\u540C\u6B65\u5931\u8D25\uFF1A${error.message}\u3002\u4FEE\u6539\u4ECD\u4FDD\u7559\uFF0C\u5173\u95ED\u65F6\u91CD\u8BD5\u3002` : error.message, true);
    if (embedded) reportRepair("repair-error", { message: "\u81EA\u52A8\u540C\u6B65\u5931\u8D25\uFF0C\u4FEE\u6539\u4ECD\u4FDD\u7559\u5728\u7CBE\u4FEE\u7A97\u53E3\uFF1B\u5173\u95ED\u65F6\u91CD\u8BD5\u3002" });
  } finally {
    exporting = false;
    updateControls();
  }
}
download.addEventListener("click", exportCurrent);
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!embedded || event.origin !== location.origin || event.source !== parent || data?.kind !== "repair-flush" || data.batch !== repairBatch || data.frame !== repairFrame) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = 0;
  autoSaveFailed = false;
  flushRequested = true;
  if (editor?.dirty && !busy && !gesture && !exporting && !wandPending && !wandTask) exportCurrent();
  else updateControls();
});
async function processFile(file) {
  if (embedded) return;
  if (gesture || busy || exporting) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    setMessage("\u53EA\u652F\u6301PNG\u3001JPG\u548CWebP\u3002", true);
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    setMessage("\u56FE\u7247\u4E0D\u80FD\u8D85\u8FC725MB\u3002", true);
    return;
  }
  if (editor?.dirty && !confirm("\u5F00\u59CB\u65B0\u5904\u7406\u5C06\u820D\u5F03\u672A\u4E0B\u8F7D\u7684\u4FEE\u8865\uFF0C\u7EE7\u7EED\uFF1F")) return;
  const id = ++requestId;
  cancelSelection();
  busy = true;
  working.hidden = false;
  updateControls();
  setMessage("\u6B63\u5728\u62A0\u56FE\u2026");
  try {
    const source = await decodeFile(file), form = new FormData();
    form.append("file", file);
    const response = await fetch("/api/cutout", { method: "POST", body: form });
    if (!response.ok) {
      let detail = `\u5904\u7406\u5931\u8D25\uFF08${response.status}\uFF09`;
      try {
        detail = (await response.json()).detail || detail;
      } catch {
      }
      throw new Error(detail);
    }
    const automatic = await decodeFile(await response.blob());
    if (id !== requestId) return;
    if (source.width !== automatic.width || source.height !== automatic.height) throw new Error("\u539F\u56FE\u4E0E\u6A21\u578B\u7ED3\u679C\u5C3A\u5BF8\u4E0D\u4E00\u81F4\uFF1B\u8BF7\u5148\u6821\u6B63\u56FE\u7247\u65B9\u5411\u518D\u5BFC\u5165\u3002");
    const next = new Editor(source.width, source.height, source.data, automatic.data);
    editor = next;
    originalFile = file;
    currentName = file.name.replace(/\.[^.]+$/, "");
    for (const canvas of [...canvases, ...overlays]) {
      canvas.width = editor.width;
      canvas.height = editor.height;
    }
    sourceContext.putImageData(new ImageData(editor.source, editor.width, editor.height), 0, 0);
    paintData = new ImageData(editor.data, editor.width, editor.height);
    refresh();
    sourceImage.hidden = resultImage.hidden = false;
    sourceEmpty.hidden = resultEmpty.hidden = true;
    toolbar.hidden = zoomControls.hidden = backgroundChoices.hidden = false;
    scale = fit();
    panX = panY = 0;
    renderView();
    setMessage("\u5B8C\u6210\u3002\u53EF\u76F4\u63A5\u5728\u5DE6\u53F3\u4E24\u4FA7\u4FEE\u8865\u3002");
  } catch (error) {
    if (id === requestId) setMessage(error.message || "\u62A0\u56FE\u5931\u8D25", true);
  } finally {
    if (id === requestId) {
      busy = false;
      working.hidden = true;
      updateControls();
    }
  }
}
async function loadEmbedded() {
  if (!embedded) return;
  if (!/^[a-f0-9]{32}$/.test(repairBatch || "") || !/^[a-f0-9]{32}-[0-9]{6}$/.test(repairFrame || "")) {
    setMessage("\u7CBE\u4FEE\u5E27\u8EAB\u4EFD\u65E0\u6548", true);
    return;
  }
  busy = true;
  working.hidden = false;
  updateControls();
  setMessage("\u6B63\u5728\u8F7D\u5165\u5F53\u524D\u5E27\u2026");
  try {
    const path = `${repairParams.get("workflow") === "1" ? "/api/workflow-matting/jobs" : "/api/matting-batches"}/${repairBatch}/frames/${repairFrame}`;
    const images = await Promise.all(["source", "auto", "current"].map(async (name) => {
      const response = await fetch(`${path}/${name}`, { cache: "no-store" });
      if (!response.ok) throw new Error("\u7CBE\u4FEE\u5E27\u5DF2\u5931\u6548\uFF0C\u8BF7\u56DE\u5230\u6279\u91CF\u7ED3\u679C");
      return decodeFile(await response.blob());
    }));
    const [source, automatic, current] = images;
    if (source.width !== automatic.width || source.height !== automatic.height || source.width !== current.width || source.height !== current.height) throw new Error("\u539F\u56FE\u4E0E\u7ED3\u679C\u5C3A\u5BF8\u4E0D\u4E00\u81F4");
    editor = new Editor(source.width, source.height, source.data, automatic.data);
    editor.data.set(current.data);
    currentName = "\u5F53\u524D\u5E27";
    for (const canvas of [...canvases, ...overlays]) {
      canvas.width = editor.width;
      canvas.height = editor.height;
    }
    sourceContext.putImageData(new ImageData(editor.source, editor.width, editor.height), 0, 0);
    paintData = new ImageData(editor.data, editor.width, editor.height);
    refresh();
    sourceImage.hidden = resultImage.hidden = false;
    sourceEmpty.hidden = resultEmpty.hidden = true;
    toolbar.hidden = zoomControls.hidden = backgroundChoices.hidden = false;
    scale = fit();
    panX = panY = 0;
    renderView();
    setMessage("\u53EF\u5728\u5DE6\u53F3\u4E24\u4FA7\u4FEE\u8865\u5F53\u524D\u5E27\u3002");
    reportRepair("repair-ready");
  } catch (error) {
    setMessage(error.message || "\u7CBE\u4FEE\u5E27\u52A0\u8F7D\u5931\u8D25", true);
    reportRepair("repair-error", { message: error.message });
  } finally {
    busy = false;
    working.hidden = true;
    updateControls();
  }
}
updateControls();
if (embedded) {
  choose.hidden = true;
  $("#recomputeButton").hidden = true;
  download.hidden = true;
  loadEmbedded();
}
