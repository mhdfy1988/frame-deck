import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

// 只收集锁定上游的源码，不运行、编译或修改这些第三方代码。
const root = resolve(import.meta.dirname, "..");
const destination = join(
  root,
  "output/browser-site/frame-deck/licenses/sources",
);
const manifest = JSON.parse(
  await readFile(join(root, "browser/licenses/ffmpeg-sources.json"), "utf8"),
);
await mkdir(destination, { recursive: true });
for (const entry of manifest) {
  const url = `https://codeload.github.com/${entry.repo}/tar.gz/${entry.ref}`;
  const file = `${entry.name}.tar.gz`;
  let bytes;
  try {
    bytes = await readFile(join(destination, file));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!bytes) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`${entry.name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (entry.sha256 && sha256 !== entry.sha256)
    throw new Error(`源码校验失败：${entry.name}`);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b)
    throw new Error(`不是源码归档：${entry.name}`);
  await writeFile(join(destination, file), bytes);
  console.log(JSON.stringify({ ...entry, sha256, bytes: bytes.length }));
}
