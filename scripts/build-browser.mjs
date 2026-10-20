import { build } from "esbuild";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  lstat,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { browserTemplate } from "./browser-template.mjs";
import { icons } from "../web/icons-data.js";

const root = resolve(import.meta.dirname, ".."),
  out = resolve(root, "output/browser-site/frame-deck");
const sourceManifest = JSON.parse(
  await readFile(join(root, "browser/licenses/ffmpeg-sources.json"), "utf8"),
);
const directories = [
  "vendor",
  "vendor/ffmpeg",
  "repair",
  "licenses",
  "licenses/sources",
];
await mkdir(out, { recursive: true });
for (const directory of directories)
  await mkdir(join(out, directory), { recursive: true });
const options = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome110",
  minify: false,
  legalComments: "eof",
};
await build({
  ...options,
  entryPoints: [join(root, "browser/main.js")],
  outfile: join(out, "app.js"),
});
await build({
  ...options,
  entryPoints: [join(root, "browser/pixel-worker.js")],
  outfile: join(out, "pixel-worker.js"),
});
await build({
  ...options,
  entryPoints: [join(root, "web/loop-worker.js")],
  outfile: join(out, "loop-worker.js"),
});
// esbuild不自动跟随new URL的Worker；显式固定发布路径，不依赖根目录。
let app = await readFile(join(out, "app.js"), "utf8");
app = replaceOnce(app, "../web/loop-worker.js", "./loop-worker.js");
await writeFile(join(out, "app.js"), app);
await writeFile(
  join(out, "index.html"),
  browserTemplate(await readFile(join(root, "web/index.html"), "utf8")),
);
await writeFile(
  join(out, "favicon.svg"),
  icons.layers.replace('stroke="currentColor"', 'stroke="#246f5b"'),
);
await writeFile(
  join(out, "app.css"),
  (await readFile(join(root, "web/style.css"), "utf8")) +
    "\n" +
    (await readFile(join(root, "browser/compat.css"), "utf8")),
);
for (const name of [
  "classes.js",
  "const.js",
  "errors.js",
  "index.js",
  "types.js",
  "utils.js",
  "worker.js",
])
  await copyFile(
    join(root, "node_modules/@ffmpeg/ffmpeg/dist/esm", name),
    join(out, "vendor/ffmpeg", name),
  );
await copyFile(
  join(root, "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js"),
  join(out, "vendor/ffmpeg/ffmpeg-core.js"),
);
await copyFile(
  join(root, "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm"),
  join(out, "vendor/ffmpeg/ffmpeg-core.wasm"),
);
// 构建产物定向适配已冻结的精修器；原本机文件不写回。每项必须唯一匹配，版本变化即失败。
let repair = await readFile(join(root, "web/matting/app-V37DVJIL.js"), "utf8");
function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2)
    throw new Error(`精修适配点变化：${from}`);
  return source.replace(from, to);
}
repair = replaceOnce(
  repair,
  'var embedded = location.pathname === "/assets/matting/repair.html";',
  "var embedded = true;",
);
repair = replaceOnce(
  repair,
  'new Worker("/assets/matting/worker-4EQHDEQU.js",',
  'new Worker(new URL("./worker-4EQHDEQU.js", import.meta.url),',
);
if ((repair.match(/await fetch\(/g) || []).length !== 3)
  throw new Error("精修网络适配点变化");
repair = repair.replaceAll("await fetch(", "await repairRequest(");
const bridge = await readFile(
  join(root, "browser/repair-transport.js"),
  "utf8",
);
repair =
  bridge.replace("export async function", "async function") + "\n" + repair;
await writeFile(join(out, "repair/app-V37DVJIL.js"), repair);
let html = await readFile(join(root, "web/matting/repair.html"), "utf8");
html = html.replaceAll("/assets/matting/", "./").replaceAll("/assets/", "../");
html = html.replace(
  "<head>",
  "<head><link rel=\"icon\" type=\"image/svg+xml\" href=\"../favicon.svg\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'none'; worker-src 'self'; object-src 'none'\">",
);
await writeFile(join(out, "repair/repair.html"), html);
for (const name of ["worker-4EQHDEQU.js", "embed.css"])
  await copyFile(join(root, "web/matting", name), join(out, "repair", name));
const repairCss = await readFile(
  join(root, "web/matting/style-N4TP222V.css"),
  "utf8",
);
await writeFile(
  join(out, "repair/style-N4TP222V.css"),
  repairCss.replace(
    /^@import "https:\/\/fonts\.googleapis\.com[^\n]+;\r?\n/,
    "",
  ),
);
for (const name of [
  "icons.css",
  "icons-data.js",
  "icons-ui.js",
  "matting-icons.js",
])
  await copyFile(join(root, "web", name), join(out, name));
await copyFile(join(root, "LICENSE"), join(out, "LICENSE"));
await copyFile(
  join(root, "web/licenses/lucide.txt"),
  join(out, "licenses/lucide.txt"),
);
await copyFile(
  join(root, "node_modules/fflate/LICENSE"),
  join(out, "licenses/fflate.txt"),
);
for (const name of [
  "eazycut-MIT.txt",
  "FFMPEG-GPL-2.0.txt",
  "ffmpeg-wrapper-MIT.txt",
  "SOURCES.txt",
])
  await copyFile(
    join(root, "browser/licenses", name),
    join(out, "licenses", name),
  );
await copyFile(
  join(root, "node_modules/culori/LICENSE"),
  join(out, "licenses/culori.txt"),
);
await writeFile(join(out, ".nojekyll"), "");
const sourceRows = [];
for (const entry of sourceManifest) {
  const name = `sources/${entry.name}.tar.gz`;
  let bytes;
  try {
    bytes = await readFile(join(out, "licenses", name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (process.env.FRAMEDECK_RELEASE === "1")
      throw new Error(`发布缺少源码：${name}`);
  }
  if (bytes) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!entry.sha256 || sha256 !== entry.sha256)
      throw new Error(`源码归档未锁定或校验失败：${name}`);
    sourceRows.push(
      `<li><a href="${name}">${entry.name} 源码</a> · ${entry.ref}<br><code>SHA-256 ${sha256}</code></li>`,
    );
  }
}
await writeFile(
  join(out, "licenses/index.html"),
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="icon" type="image/svg+xml" href="../favicon.svg"><title>FrameDeck 第三方许可与源码</title><h1>第三方许可与源码</h1><p>自有代码MIT不改变第三方许可。FFmpeg核心按GPL-2.0-or-later分发；以下归档保留原许可证，构建材料在ffmpeg-wasm源码中的Dockerfile、build/、src/，FFMPEG_ST=1，Emscripten 3.1.40。我们复制官方core 0.12.10二进制，未修改或声称可逐字节重建。</p><p><a href="FFMPEG-GPL-2.0.txt">GPL全文</a> · <a href="SOURCES.txt">版本和来源</a> · <a href="https://github.com/mhdfy1988/frame-deck">FrameDeck完整源码及通知</a></p><ul>${sourceRows.join("")}</ul></html>`,
);
const allowed = new Set([
  "index.html",
  "favicon.svg",
  "app.js",
  "app.css",
  "pixel-worker.js",
  "loop-worker.js",
  "LICENSE",
  ".nojekyll",
  "build-info.json",
  "icons.css",
  "icons-data.js",
  "icons-ui.js",
  "matting-icons.js",
  "repair/repair.html",
  "repair/app-V37DVJIL.js",
  "repair/worker-4EQHDEQU.js",
  "repair/style-N4TP222V.css",
  "repair/embed.css",
  "licenses/lucide.txt",
  "licenses/fflate.txt",
  "licenses/eazycut-MIT.txt",
  "licenses/culori.txt",
  "licenses/FFMPEG-GPL-2.0.txt",
  "licenses/ffmpeg-wrapper-MIT.txt",
  "licenses/SOURCES.txt",
  "licenses/index.html",
  ...sourceManifest.map(({ name }) => `licenses/sources/${name}.tar.gz`),
  ...[
    "classes.js",
    "const.js",
    "errors.js",
    "index.js",
    "types.js",
    "utils.js",
    "worker.js",
    "ffmpeg-core.js",
    "ffmpeg-core.wasm",
  ].map((name) => `vendor/ffmpeg/${name}`),
]);
const hashes = {};
async function check(directory, prefix = "") {
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry),
      name = prefix + entry,
      stat = await lstat(path);
    if (stat.isDirectory()) {
      if (!directories.includes(name)) throw new Error(`禁止发布目录：${name}`);
      await check(path, name + "/");
    } else {
      if (!stat.isFile() || !allowed.has(name))
        throw new Error(`禁止发布文件：${name}`);
      if (name !== "build-info.json")
        hashes[name] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
    }
  }
}
await check(out);
await writeFile(
  join(out, "build-info.json"),
  JSON.stringify(
    {
      version: JSON.parse(await readFile(join(root, "package.json"), "utf8"))
        .version,
      revision: process.env.GITHUB_SHA || null,
      variant: "browser-no-model",
      hashes,
    },
    null,
    2,
  ),
);
console.log(`浏览器版构建完成：${out}`);
