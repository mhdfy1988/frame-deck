import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { context as esbuildContext, build } from "esbuild";
import { unzipSync, strFromU8 } from "fflate";
import { execFileSync } from "node:child_process";

const evidence = resolve("output/pages-evidence");
await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(resolve("output/browser-fixture-"));
const server = await esbuildContext({ logLevel: "silent" }),
  { port } = await server.serve({
    host: "127.0.0.1",
    port: 0,
    servedir: resolve("output/browser-site"),
  });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const baseUrl =
  process.env.FRAMEDECK_TEST_URL || `http://127.0.0.1:${port}/frame-deck/`;
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    }),
    errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${m.text()} (${m.location().url})`);
  });
  page.on("request", (request) => {
    const url = request.url();
    if (
      url.includes("/api/") ||
      (!url.startsWith(baseUrl) && !/^(blob:|data:)/.test(url))
    )
      requests.push(url);
  });
  page.on("dialog", (d) => d.accept());
  await page.goto(baseUrl);
  assert.equal(
    await page.locator('link[rel="icon"]').getAttribute("href"),
    "./favicon.svg",
  );
  assert.equal(await page.locator(".workflow-sidebar").count(), 1);
  assert.equal(
    await page.locator("#extract-workspace .workarea>.source-panel").count(),
    1,
  );
  assert.equal(await page.locator(".fd-app").count(), 0);
  // 原样式是权威来源，不接受另一套“近似”布局；附加样式仅补必要浏览器控件。
  const css = await readFile("output/browser-site/frame-deck/app.css", "utf8");
  assert(css.startsWith(await readFile("web/style.css", "utf8")));
  await page.screenshot({
    path: resolve(evidence, "original-extract-empty.png"),
  });
  const pngs = await page.evaluate(() => {
    const values = [];
    for (let i = 0; i < 8; i++) {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#00ff00";
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = `rgb(${200 - i * 10},40,20)`;
      ctx.fillRect(16 + i, 16, 24, 32);
      values.push(c.toDataURL().split(",")[1]);
    }
    return values;
  });
  const paths = [];
  for (const [i, png] of pngs.entries()) {
    const path = resolve(fixture, `frame_${i + 1}.png`);
    await writeFile(path, Buffer.from(png, "base64"));
    paths.push(path);
  }
  const idle = () =>
    page.waitForFunction(() => document.querySelector("#cancel").hidden);
  const stage = async (id) => {
    await page.locator(`#${id}`).click();
  };
  const portrait = resolve(fixture, "portrait.png");
  const portraitPNG = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 768;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#8a4735";
    ctx.fillRect(160, 90, 192, 600);
    return canvas.toDataURL().split(",")[1];
  });
  await writeFile(portrait, Buffer.from(portraitPNG, "base64"));
  await page.locator("#images-file").setInputFiles(portrait);
  await idle();
  assert.equal(await page.locator("#source-title").textContent(), "源图片");
  assert.match(await page.locator("#tab-extract").textContent(), /导入/);
  assert(await page.locator("#video-parameters").isHidden());
  assert.equal(await page.locator("#estimate").textContent(), "");
  assert.match(
    await page.locator("#result-meta").textContent(),
    /1 帧 · 512 × 768$/,
  );
  await page.waitForFunction(
    () => document.querySelector("#source-png").naturalWidth === 512,
  );
  await page.screenshot({ path: resolve(evidence, "import-single-image.png") });
  await page.locator("#images-file").setInputFiles(paths);
  await idle();
  assert.equal(await page.locator("#grid .frame").count(), 8);
  // 直接播放必须由弹窗时钟负责；关闭后跨多个动画帧仍保持关闭。
  await page.locator("#play").click();
  await page.locator("#viewer").waitFor({ state: "visible" });
  const directPlayLabel = await page.locator("#viewer-play").textContent();
  await page.locator("#close-viewer").click();
  const staysClosed = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let remaining = 6;
        function check() {
          if (document.querySelector("#viewer").open) return resolve(false);
          if (--remaining === 0) return resolve(true);
          requestAnimationFrame(check);
        }
        requestAnimationFrame(check);
      }),
  );
  assert(staysClosed, "直接播放关闭后不应被后台时钟重新打开");
  assert.equal(directPlayLabel.trim(), "暂停");
  await page.locator("#play").click();
  await page.locator("#viewer-play-fps").fill("2");
  await page.waitForFunction(
    () => document.querySelector("#viewer-title").textContent !== "第 1 / 8 帧",
  );
  await page.locator("#viewer-play").click();
  assert.equal(
    (await page.locator("#viewer-play").textContent()).trim(),
    "播放",
  );
  const pausedTitle = await page.locator("#viewer-title").textContent();
  await page.screenshot({
    path: resolve(evidence, "viewer-direct-paused.png"),
  });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let remaining = 6;
        function tick() {
          if (--remaining === 0) resolve();
          else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      }),
  );
  assert.equal(await page.locator("#viewer-title").textContent(), pausedTitle);
  await page.locator("#viewer-play").click();
  assert.equal(
    (await page.locator("#viewer-play").textContent()).trim(),
    "暂停",
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await page.locator("#viewer-title").textContent(),
    pausedTitle,
    "恢复播放应从暂停帧继续，不能重置为首帧",
  );
  await page.keyboard.press("Escape");
  await page.locator("#viewer").waitFor({ state: "hidden" });
  assert.equal(
    (await page.locator("#viewer-play").textContent()).trim(),
    "播放",
  );
  await page.locator("#play").click();
  await page.locator("#viewer-play-fps").fill("60");
  await page.waitForFunction(
    () => document.querySelector("#viewer-play").textContent.trim() === "播放",
  );
  assert(
    await page.locator("#viewer").isVisible(),
    "自然播完保留弹窗并恢复播放按钮",
  );
  await page.screenshot({ path: resolve(evidence, "viewer-direct-ended.png") });
  await page.locator("#viewer-play-fps").fill("2");
  await page.locator("#viewer-play").click();
  await page.waitForFunction(
    () => document.querySelector("#viewer-title").textContent === "第 1 / 8 帧",
  );
  await page.locator("#close-viewer").click();
  await page.locator("#grid button").first().click();
  await page.locator("#viewer").waitFor({ state: "visible" });
  await page.locator("#next").click();
  await page.locator("#zoom-100").click();
  await page.locator("#close-viewer").click();
  await stage("organize");
  assert.equal(await page.locator("#edit-grid .frame").count(), 8);
  await page.locator("#edit-all").click();
  assert.equal(await page.locator("#edit-grid input:checked").count(), 8);
  await page.locator("#edit-play").click();
  await page.waitForTimeout(160);
  await page.locator("#edit-play").click();
  await page.locator("#edit-find-loop").click();
  await page.waitForFunction(
    () =>
      !["准备分析", ""].includes(
        document.querySelector("#loop-state").textContent,
      ) &&
      !document.querySelector("#loop-state").textContent.startsWith("分析帧") &&
      !document.querySelector("#loop-state").textContent.startsWith("比较动作"),
  );
  await page.locator("#loop-cancel").click();
  await page.waitForFunction(
    () => !document.querySelector("#organize").disabled,
  );
  async function exported(format = "sequence", crop = false) {
    await stage("tab-export");
    await page.locator("#export-format").selectOption(format);
    if (crop) {
      await page.locator("#export-advanced").evaluate((el) => (el.open = true));
      await page.locator("#export-padding").fill("0");
      await page.locator("#export-auto").click();
      await page.waitForFunction(
        () => Number(document.querySelector("#export-cw").value) < 64,
      );
    }
    const next = page.waitForEvent("download");
    await page.locator("#export-download").click();
    const file = await next,
      target = resolve(evidence, `original-${format}-${Date.now()}.zip`);
    await file.saveAs(target);
    await idle();
    return unzipSync(await readFile(target));
  }
  const pixel = async (bytes) =>
    page.evaluate(async (base64) => {
      const image = await createImageBitmap(
          new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], {
            type: "image/png",
          }),
        ),
        canvas = new OffscreenCanvas(image.width, image.height),
        ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      image.close();
      return {
        width: canvas.width,
        corner: [...ctx.getImageData(0, 0, 1, 1).data],
        center: [...ctx.getImageData(24, 24, 1, 1).data],
      };
    }, Buffer.from(bytes).toString("base64"));
  const original = await exported();
  assert.deepEqual(
    original["frames/frame_000001.png"],
    new Uint8Array(Buffer.from(pngs[0], "base64")),
  );
  await stage("organize");
  await page.locator("#edit-grid .frame-preview").first().focus();
  await page.keyboard.press("Alt+ArrowRight");
  const sorted = await exported();
  assert.deepEqual(
    sorted["frames/frame_000001.png"],
    new Uint8Array(Buffer.from(pngs[1], "base64")),
  );
  await stage("organize");
  await page.locator("#edit-undo").click();
  await page
    .locator("#edit-grid .frame")
    .nth(0)
    .dragTo(page.locator("#edit-grid .frame").nth(1));
  const dragged = await exported();
  assert.deepEqual(
    dragged["frames/frame_000001.png"],
    new Uint8Array(Buffer.from(pngs[1], "base64")),
  );
  await stage("organize");
  await page.locator("#edit-undo").click();
  await page.locator("#edit-grid .frame").first().hover();
  await page.locator("#edit-grid .frame-delete").first().click();
  assert.equal(await page.locator("#edit-grid .frame").count(), 7);
  await page.locator("#edit-undo").click();
  assert.equal(await page.locator("#edit-grid .frame").count(), 8);
  await page.screenshot({ path: resolve(evidence, "original-organizer.png") });
  await stage("tab-matting");
  await page.locator("#matting-start").click();
  await idle();
  assert.equal(await page.locator("#matting-error").textContent(), "");
  const cut = await exported(),
    rgba = await pixel(cut["frames/frame_000001.png"]);
  assert.equal(rgba.corner[3], 0);
  assert.deepEqual(rgba.center, [200, 40, 20, 255]);
  await stage("organize");
  await stage("tab-matting");
  await page.locator("#matting-grid button").first().dblclick();
  const repair = page.frameLocator("#repair-frame");
  await repair.getByRole("button", { name: "魔法棒", exact: true }).waitFor();
  await repair.getByRole("button", { name: "去除画笔", exact: true }).click();
  await repair.locator("#brush-size-number").fill("12");
  await repair.locator("#brush-size-number").press("Tab");
  await repair.locator("#brush-hardness-number").fill("100");
  await repair.locator("#brush-hardness-number").press("Tab");
  const bounds = await repair.locator("#resultImage").boundingBox();
  await page.mouse.click(
    bounds.x + (bounds.width * 24) / 64,
    bounds.y + (bounds.height * 24) / 64,
  );
  await page.screenshot({ path: resolve(evidence, "original-repair.png") });
  await page.locator("#repair-close").click();
  await page.locator("#repair-dialog").waitFor({ state: "hidden" });
  const repaired = await exported();
  assert.equal((await pixel(repaired["frames/frame_000001.png"])).center[3], 0);
  assert.equal(
    (await pixel(repaired["frames/frame_000002.png"])).center[3],
    255,
  );
  const sheet = await exported("sheet", true),
    metadata = JSON.parse(strFromU8(sheet["sheet.json"]));
  assert.equal(metadata.frames.length, 8);
  assert(metadata.cell.width < 64);
  await page.locator("#export-sheet-view").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(evidence, "original-export.png") });
  await page.setViewportSize({ width: 1024, height: 640 });
  for (const tab of ["organize", "tab-matting", "tab-export"]) {
    await stage(tab);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: resolve(evidence, `original-short-${tab}.png`),
    });
  }
  await stage("tab-extract");
  const video = resolve(fixture, "video.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      "4",
      "-i",
      resolve(fixture, "frame_%d.png"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      video,
    ],
    { stdio: "pipe", windowsHide: true },
  );
  await page.locator("#file").setInputFiles(video);
  await page.waitForFunction(
    () => !document.querySelector("#extract").disabled,
  );
  assert.equal(await page.locator("#source-title").textContent(), "原视频");
  assert(await page.locator("#video-parameters").isVisible());
  assert.match(await page.locator("#tab-extract").textContent(), /抽帧/);
  await page.locator("#start").fill("0");
  await page.locator("#end").fill("1");
  await page.locator("#fps").fill("4");
  await page.locator("#extract").click();
  await idle();
  assert.equal(await page.locator("#error").textContent(), "");
  assert.equal(await page.locator("#grid .frame").count(), 4);
  const videoFiles = await exported(),
    videoMetadata = JSON.parse(strFromU8(videoFiles["frame-sequence.json"]));
  assert.equal(videoMetadata.playback.fps, 4);
  assert.equal(videoMetadata.frames.length, 4);
  assert.equal(videoMetadata.frames[0].sampleTimeSeconds, 0);
  assert.equal(videoMetadata.frames[0].sourceTimeSeconds, null);
  assert((await pixel(videoFiles["frames/frame_000001.png"])).center[0] > 180);
  await stage("tab-extract");
  await page.locator("#extract").click();
  await page.locator("#cancel").click();
  await idle();
  assert.match(await page.locator("#error").textContent(), /已取消/);
  assert.equal(await page.locator("#grid .frame").count(), 4);
  const broken = resolve(fixture, "broken.mp4");
  await writeFile(broken, "not a video");
  await page.locator("#file").setInputFiles(broken);
  await page.waitForFunction(
    () => !document.querySelector("#extract").disabled,
  );
  await page.locator("#extract").click();
  await idle();
  assert.notEqual(await page.locator("#error").textContent(), "");
  assert.equal(await page.locator("#grid .frame").count(), 4);
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
  // 音轨比视频长：页面总时长不能作为视频轨的默认抽帧终点。
  const mismatch = resolve(fixture, "duration-mismatch.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      video,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "2.048",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      mismatch,
    ],
    { stdio: "pipe", windowsHide: true },
  );
  await page.locator("#file").setInputFiles(mismatch);
  await page.waitForFunction(
    () => Number(document.querySelector("#end").value) > 2,
  );
  await page.locator("#fps").fill("4");
  await page.locator("#extract").click();
  await idle();
  assert.equal(await page.locator("#error").textContent(), "");
  assert.equal(await page.locator("#end").inputValue(), "2");
  assert.equal(await page.locator("#grid .frame").count(), 8);
  await page.screenshot({ path: resolve(evidence, "duration-reconciled.png") });
  await page.locator("#end").fill("3");
  await page.locator("#extract").click();
  await idle();
  assert.match(
    await page.locator("#error").textContent(),
    /结束时间3秒超出视频轨时长2秒/,
  );
  assert.equal(await page.locator("#status").textContent(), "处理未完成");
  assert.equal(await page.locator("#grid .frame").count(), 8);
  // 截图同规模的720p动态素材：跨8批抽取121帧，不能降低帧率或分辨率。
  const hdVideo = resolve(fixture, "hd-duration-mismatch.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=1280x720:r=24:d=10.041666",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "10.048",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      hdVideo,
    ],
    { stdio: "pipe", windowsHide: true },
  );
  await page.locator("#file").setInputFiles(hdVideo);
  await page.waitForFunction(
    () => Number(document.querySelector("#end").value) > 10,
  );
  await page.locator("#fps").fill("12");
  const hdStarted = performance.now();
  await page.locator("#extract").click();
  await page.waitForFunction(
    () => document.querySelector("#cancel").hidden,
    null,
    { timeout: 150000 },
  );
  assert.equal(await page.locator("#error").textContent(), "");
  assert.equal(await page.locator("#grid .frame").count(), 121);
  const hdExtractMs = Math.round(performance.now() - hdStarted);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#grid img")]
      .slice(0, 9)
      .every((image) => image.naturalWidth === 192),
  );
  await page.screenshot({ path: resolve(evidence, "batched-hd-121.png") });
  const hdFiles = await exported(),
    hdMetadata = JSON.parse(strFromU8(hdFiles["frame-sequence.json"]));
  assert.equal(hdMetadata.frames.length, 121);
  assert.deepEqual(hdMetadata.canvas, { width: 1280, height: 720 });
  assert.equal(hdMetadata.playback.fps, 12);
  assert.equal(hdMetadata.frames.at(-1).sampleTimeSeconds, 10);
  // 测试专用同版本WASM一次性参考，不向生产入口加入测试开关或回退路径。
  const oracle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
    import { FFmpeg } from '@ffmpeg/ffmpeg';
    import { guessBackground, removeBackground } from './browser/keying/core.js';
    export async function expectedKey(base64) {
      const bytes=Uint8Array.from(atob(base64),x=>x.charCodeAt(0)), bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');
      ctx.drawImage(bitmap,0,0);bitmap.close();
      const image=ctx.getImageData(0,0,canvas.width,canvas.height),color=guessBackground(image.data,canvas.width,canvas.height);
      const result=removeBackground(image.data,canvas.width,canvas.height,{color,tolerance:30,softness:12,cleanup:70,connected:true});
      ctx.putImageData(new ImageData(result.data,canvas.width,canvas.height),0,0);
      const canonical=await createImageBitmap(await canvas.convertToBlob({type:'image/png'}));
      ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(canonical,0,0);canonical.close();
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,canvas.width,canvas.height).data))).join(',');
      canvas.width=canvas.height=1;
      return {hash,color};
    }
    export async function reference(duration) {
      const ffmpeg = new FFmpeg(), base = new URL('./vendor/ffmpeg/', document.baseURI);
      try {
        await ffmpeg.load({ classWorkerURL:new URL('worker.js',base).href, coreURL:new URL('ffmpeg-core.js',base).href, wasmURL:new URL('ffmpeg-core.wasm',base).href });
        await ffmpeg.writeFile('input', new Uint8Array(await (await fetch('./__test-input.mp4')).arrayBuffer()));
        await ffmpeg.createDir('frames');
        const result = await ffmpeg.exec(['-v','error','-i','input','-an','-vf', 'trim=start=0:end='+duration+',setpts=PTS-STARTPTS,fps=fps=12:round=up','-frames:v','121','frames/%06d.png'],120000);
        if(result!==0)throw new Error('参考解码失败');
        const names=(await ffmpeg.listDir('frames')).map(x=>x.name).filter(x=>/^\\d+\\.png$/.test(x)).sort(), hashes=[];
        for(const name of names){
          const bytes=await ffmpeg.readFile('frames/'+name), bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
          const canvas=new OffscreenCanvas(bitmap.width, bitmap.height), ctx=canvas.getContext('2d');
          ctx.drawImage(bitmap,0,0);bitmap.close();
          hashes.push(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,canvas.width,canvas.height).data))).join(','));
          canvas.width=canvas.height=1;
          await ffmpeg.deleteFile('frames/'+name);
        }
        return hashes;
      } finally { ffmpeg.terminate(); }
    }`,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
  });
  await page.route("**/__test-oracle.js", (route) =>
    route.fulfill({
      body: oracle.outputFiles[0].text,
      contentType: "text/javascript",
    }),
  );
  await page.route("**/__test-input.mp4", (route) =>
    route.fulfill({ path: hdVideo, contentType: "video/mp4" }),
  );
  const referenceHashes = await page.evaluate(
    async (duration) => {
      const { reference } = await import("./__test-oracle.js");
      return reference(duration);
    },
    Number(await page.locator("#end").inputValue()),
  );
  assert.equal(referenceHashes.length, 121);
  const rgbaHash = async (bytes) =>
    page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (value) =>
        value.charCodeAt(0),
      );
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const digest = await crypto.subtle.digest(
        "SHA-256",
        ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      );
      canvas.width = canvas.height = 1;
      return Array.from(new Uint8Array(digest)).join(",");
    }, Buffer.from(bytes).toString("base64"));
  for (let i = 1; i <= 121; i++) {
    const name = String(i).padStart(6, "0");
    assert.equal(
      await rgbaHash(hdFiles[`frames/frame_${name}.png`]),
      referenceHashes[i - 1],
      `第${i}帧像素与连续采样不一致`,
    );
  }
  console.log(
    `720p / 121帧抽取：${hdExtractMs}ms；含ZIP回读与逐帧像素核对共${Math.round(performance.now() - hdStarted)}ms`,
  );
  await stage("tab-extract");
  // 第二批开始后取消，不发布第一批候选，不影响上一组121帧。
  await page.evaluate(() => {
    const status = document.querySelector("#status"),
      observer = new MutationObserver(() => {
        if (status.textContent.startsWith("分批解码 2 /")) {
          observer.disconnect();
          document.querySelector("#cancel").click();
        }
      });
    observer.observe(status, { childList: true });
  });
  await page.locator("#extract").click();
  await idle();
  assert.match(await page.locator("#error").textContent(), /已取消/);
  assert.equal(await page.locator("#grid .frame").count(), 121);
  // 大组PNG重新导入、去背、下载都走真实入口，避免只放宽抽帧而下游仍拒绝。
  const hdPaths = [];
  for (let i = 1; i <= 121; i++) {
    const name = `frame_${String(i).padStart(6, "0")}.png`,
      path = resolve(fixture, name);
    await writeFile(path, hdFiles[`frames/${name}`]);
    hdPaths.push(path);
  }
  await page.locator("#images-file").setInputFiles(hdPaths);
  await idle();
  assert.equal(await page.locator("#grid .frame").count(), 121);
  assert.equal(await page.locator("#error").textContent(), "");
  assert.equal(await page.locator("#source-title").textContent(), "源图片");
  assert(await page.locator("#video-parameters").isHidden());
  assert.equal(await page.locator("#estimate").textContent(), "");
  assert.equal(await page.locator("#end").inputValue(), "0");
  assert.equal(await page.locator("#video").getAttribute("src"), null);
  // 即使旧视频元数据事件到达，也不能覆盖已经确认的图片模式。
  await page.locator("#video").dispatchEvent("loadedmetadata");
  assert.match(
    await page.locator("#metadata").textContent(),
    /PNG序列 · 121 帧/,
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#grid img")]
      .slice(0, 9)
      .every((image) => image.naturalWidth === 192),
  );
  await page.screenshot({
    path: resolve(evidence, "import-images-after-video.png"),
  });
  await stage("organize");
  await stage("tab-matting");
  await page.locator("#matting-start").click();
  await page.waitForFunction(
    () => document.querySelector("#cancel").hidden,
    null,
    { timeout: 150000 },
  );
  assert.equal(await page.locator("#matting-error").textContent(), "");
  const hdCut = await exported(),
    cutMetadata = JSON.parse(strFromU8(hdCut["frame-sequence.json"]));
  assert.equal(cutMetadata.frames.length, 121);
  assert.deepEqual(cutMetadata.canvas, { width: 1280, height: 720 });
  // 新方案取边缘多数色，不再假设复杂测试图的四角都应被抠除。
  const expectedKey = await page.evaluate(
    async (base64) => (await import("./__test-oracle.js")).expectedKey(base64),
    Buffer.from(hdFiles["frames/frame_000001.png"]).toString("base64"),
  );
  assert.equal(
    await rgbaHash(hdCut["frames/frame_000001.png"]),
    expectedKey.hash,
  );
  await stage("tab-extract");
  const keyingImages = await page.evaluate(() =>
    ["#00ff00", "#0000ff"].map((background) => {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const ctx = c.getContext("2d");
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = "rgb(200,40,20)";
      ctx.fillRect(16, 16, 32, 40);
      ctx.fillStyle = "#00ff00";
      ctx.fillRect(22, 22, 6, 6);
      return c.toDataURL().split(",")[1];
    }),
  );
  const keyingPaths = [];
  for (const [i, base64] of keyingImages.entries()) {
    const path = resolve(fixture, `keying_${i}.png`);
    await writeFile(path, Buffer.from(base64, "base64"));
    keyingPaths.push(path);
  }
  await page.locator("#images-file").setInputFiles(keyingPaths);
  await idle();
  const openKeying = async () => {
    await stage("organize");
    await stage("tab-matting");
  };
  await openKeying();
  await page.locator("#matting-tolerance").focus();
  await page.keyboard.press("Home");
  await page.locator("#matting-softness").focus();
  await page.keyboard.press("Home");
  await page.locator("#matting-start").click();
  await idle();
  assert.equal(await page.locator("#matting-error").textContent(), "");
  assert.equal(await page.locator("#matting-color").inputValue(), "#00ff00");
  const edgeCut = await exported();
  assert.equal((await pixel(edgeCut["frames/frame_000001.png"])).corner[3], 0);
  assert.equal(
    (await pixel(edgeCut["frames/frame_000001.png"])).center[3],
    255,
    "连通模式保留封闭孔",
  );
  assert.equal(
    (await pixel(edgeCut["frames/frame_000002.png"])).corner[3],
    255,
    "整组共用首帧底色，不对下一帧重新估色",
  );
  await openKeying();
  for (const [id, max] of [
    ["tolerance", 100],
    ["softness", 50],
    ["cleanup", 100],
  ]) {
    const slider = page.locator(`#matting-${id}`);
    assert.equal(await slider.getAttribute("type"), "range");
    await slider.focus();
    await slider.press("End");
    await slider.press("ArrowLeft");
    assert.equal(await slider.inputValue(), String(max - 1));
    assert.equal(
      await page.locator(`#matting-${id}-value`).textContent(),
      String(max - 1),
    );
    await slider.press("Home");
    await slider.press("ArrowLeft");
    assert.equal(await slider.inputValue(), "0");
  }
  await page.locator("#matting-softness").press("Home");
  await page.locator("#matting-cleanup").press("End");
  for (let i = 0; i < 30; i++)
    await page.locator("#matting-cleanup").press("ArrowLeft");
  await page.locator("#matting-tolerance").press("Home");
  await page.locator("#matting-pick").click();
  assert.equal(
    await page.locator("#matting-pick").getAttribute("aria-pressed"),
    "true",
  );
  // 当前结果背景已透明，取色必须从原图得到绿色，而不是屏幕棋盘格。
  const pickRect = await page.locator("#matting-image").boundingBox();
  const pickScale = Math.min(pickRect.width / 64, pickRect.height / 64);
  await page.mouse.click(
    pickRect.x + (pickRect.width - 64 * pickScale) / 2 + 2 * pickScale,
    pickRect.y + (pickRect.height - 64 * pickScale) / 2 + 2 * pickScale,
  );
  await idle();
  assert.equal(await page.locator("#matting-color").inputValue(), "#00ff00");
  assert(!(await page.locator("#matting-auto-color").isChecked()));
  assert.equal(await page.locator("#matting-error").textContent(), "");
  await page.locator("#matting-pick").click();
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#matting-pick").getAttribute("aria-pressed"),
    "false",
  );
  await page.locator("#matting-connected").uncheck();
  await page.locator("#matting-start").click();
  await idle();
  const fullCut = await exported();
  assert.equal(
    (await pixel(fullCut["frames/frame_000001.png"])).center[3],
    0,
    "全图模式去除封闭孔",
  );
  await openKeying();
  await page.locator("#matting-connected").check();
  await page.locator("#matting-start").click();
  await idle();
  const restoredHole = await exported();
  assert.equal(
    (await pixel(restoredHole["frames/frame_000001.png"])).center[3],
    255,
    "参数重算从原图开始，不累积旧误删",
  );
  await openKeying();
  await page.evaluate(() => {
    const status = document.querySelector("#matting-status"),
      observer = new MutationObserver(() => {
        if (status.textContent === "去背 2 / 2") {
          observer.disconnect();
          document.querySelector("#matting-cancel").click();
        }
      });
    observer.observe(status, { childList: true });
  });
  await page.locator("#matting-start").click();
  await idle();
  assert.match(await page.locator("#matting-error").textContent(), /已取消/);
  const canceledKey = await exported();
  assert.deepEqual(
    canceledKey["frames/frame_000001.png"],
    restoredHole["frames/frame_000001.png"],
  );
  await openKeying();
  for (const [width, height] of [
    [1440, 900],
    [1024, 640],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#matting-grid img")].every(
        (img) => img.complete && img.naturalWidth,
      ),
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const applyRect = await page.locator("#matting-start").boundingBox();
    assert(applyRect.y >= 0 && applyRect.y + applyRect.height <= height);
    await page.screenshot({
      path: resolve(evidence, `eazycut-keying-${width}.png`),
    });
  }
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
  console.log(
    "原界面静态验收通过：四屏导航、原样式、勾选／播放、拖动／撤销／删除、循环弹窗、去背Alpha、原精修保存隔离、导出整屏／图集裁剪、短屏、真实WASM抽帧及取消／损坏保护、720p 121帧分批与连续抽取逐像素一致、中途取消、大组PNG导入去背及ZIP回读；无API或外部请求",
  );
} finally {
  await browser.close();
  await server.dispose();
}
