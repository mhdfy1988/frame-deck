import test from "node:test";
import assert from "node:assert/strict";
import {
  checkImages,
  sampleTimes,
  sequence,
  filenameOrder,
  videoBatches,
  LIMITS,
} from "../../browser/domain.js";
import { BlobArchive } from "../../browser/archive.js";
import { unzipSync, strFromU8 } from "fflate";
import { BrowserSession } from "../../browser/session.js";
import { browserTemplate } from "../../scripts/browser-template.mjs";
import { readFileSync } from "node:fs";
const frame = (id) => ({
  id,
  width: 64,
  height: 64,
  source: new Blob(["source"]),
  current: new Blob(["current"]),
  revision: 0,
});
test("浏览器构建复用原四屏模板，适配点变化失败而不另造布局", () => {
  const source = readFileSync(
      new URL("../../web/index.html", import.meta.url),
      "utf8",
    ),
    html = browserTemplate(source);
  for (const id of [
    "extract-workspace",
    "organizer-workspace",
    "matting-workspace",
    "export-workspace",
    "repair-dialog",
    "loop-dialog",
    "viewer",
  ])
    assert(html.includes(`id="${id}"`));
  assert(!html.includes("/assets/"));
  assert(html.includes('id="matting-tolerance"'));
  assert(html.includes('id="video-parameters"'));
  assert(!html.includes("fd-app"));
  assert(html.includes(`最多${LIMITS.frames}帧`));
  assert.throws(
    () =>
      browserTemplate(
        source.replace('href="/assets/style.css"', 'href="changed.css"'),
      ),
    /适配点变化/,
  );
});
test("浏览器预算、等尺寸、自然排序及半开时间范围", () => {
  assert.deepEqual(sampleTimes(0, 1, 4, 2), [0, 0.25, 0.5, 0.75]);
  assert.equal(sampleTimes(0, 3, 60, 3).length, 180);
  assert.throws(() => sampleTimes(1, 4, 12, 3));
  assert.equal(sampleTimes(0, 10.048, 12, 10.048).length, 121);
  assert.throws(() => sampleTimes(0, 11, 60, 11), /预计660帧/);
  assert.throws(() => sampleTimes(0, 10.048, 12, 10), /超出视频轨时长10秒/);
  checkImages(
    Array.from({ length: 121 }, () => ({ width: 1280, height: 720 })),
  );
  assert.throws(() => checkImages([{ width: 5000, height: 1 }]));
  assert.throws(() => checkImages([frame("a"), { ...frame("b"), width: 32 }]));
  assert.deepEqual(
    filenameOrder([
      { name: "2.png" },
      { name: "10.png" },
      { name: "1.png" },
    ]).map((f) => f.name),
    ["1.png", "2.png", "10.png"],
  );
  assert.equal(sequence([frame("a")], 12).frames[0].durationSeconds, "1/12");
});
test("按像素控制批大小，帧号连续且总数不丢失", () => {
  const batches = videoBatches(121, 1280, 720);
  assert.equal(batches.length, 8);
  assert.deepEqual(batches.at(-1), { offset: 112, count: 9 });
  assert.deepEqual(
    batches.flatMap(({ offset, count }) =>
      Array.from({ length: count }, (_, i) => offset + i),
    ),
    Array.from({ length: 121 }, (_, i) => i),
  );
  assert(videoBatches(50, 3840, 2160).every((batch) => batch.count === 1));
  assert.throws(() => videoBatches(601, 1280, 720));
});
test("分块ZIP回读原字节，取消和超限清理临时包", async () => {
  const controller = new AbortController(),
    archive = new BlobArchive(controller.signal);
  const bytes = new Uint8Array(2 * 1024 ** 2 + 7).fill(129);
  await archive.add("frame.png", new Blob([bytes]));
  await archive.add("metadata.json", new Blob(['{"frames":121}']));
  const files = unzipSync(new Uint8Array(await archive.finish().arrayBuffer()));
  assert.deepEqual(files["frame.png"], bytes);
  assert.equal(strFromU8(files["metadata.json"]), '{"frames":121}');
  const aborted = new BlobArchive(controller.signal);
  controller.abort();
  await assert.rejects(aborted.add("ignored", new Blob(["x"])));
  assert.equal(aborted.parts.length, 0);
  const limited = new BlobArchive(new AbortController().signal);
  await assert.rejects(limited.add("large", { size: 97 * 1024 ** 2 }), /96MiB/);
  limited.dispose();
});
test("浏览器图片修订与排序共用原编辑器，迟到批处理不能覆盖", () => {
  const session = new BrowserSession();
  session.load([frame("a"), frame("b")], 12, "demo.png");
  const revision = session.revision;
  session.editor.swap("a", "b");
  assert.equal(session.ordered[0].id, "b");
  session.editor.undo();
  assert.equal(session.ordered[0].id, "a");
  session.replace("a", new Blob(["new"]), 0);
  assert.throws(() => session.replace("a", new Blob(), 0));
  assert.throws(() => session.replaceAll([["a", new Blob()]], revision));
  assert.equal(session.frames.get("a").revision, 1);
  assert(session.dirty);
  session.markExported();
  assert.equal(session.dirty, false);
});
