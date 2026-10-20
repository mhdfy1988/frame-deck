import { context } from "esbuild";
import { resolve } from "node:path";
const server = await context({ logLevel: "silent" });
const { port } = await server.serve({
  host: "127.0.0.1",
  port: 8904,
  servedir: resolve(import.meta.dirname, "../output/browser-site"),
});
console.log(
  `无模型浏览器版：http://127.0.0.1:${port}/frame-deck/（独立静态服务，不调用8902）`,
);
process.on("SIGINT", async () => {
  await server.dispose();
  process.exitCode = 0;
});
