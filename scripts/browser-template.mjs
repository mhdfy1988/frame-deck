import { LIMITS } from "../browser/domain.js";

// 正式界面结构直接来自本机版；只适配资源路径和无模型版能力，不另维护第二套布局。
export function browserTemplate(source) {
  const replace = (from, to) => {
    if (source.split(from).length !== 2)
      throw new Error(`原界面适配点变化：${from}`);
    source = source.replace(from, to);
  };
  replace('href="/assets/style.css"', 'href="./app.css"');
  replace('href="/assets/icons.css"', 'href="./icons.css"');
  replace('src="/assets/app.js"', 'src="./app.js"');
  replace(
    "<head>",
    "<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'\">",
  );
  replace(" 本机处理", " 浏览器本地 · 无模型");
  replace(
    '<button id="open" class="text-button">选择视频</button>',
    '<button id="open-images" class="text-button">导入PNG</button><input id="images-file" type="file" accept="image/png" multiple hidden><button id="open" class="text-button">选择视频</button>',
  );
  replace(
    '<video id="video"',
    '<img id="source-png" alt="导入序列首帧" hidden><video id="video"',
  );
  replace(
    '<div class="parameters" aria-label="抽帧设置">',
    '<div id="video-parameters" class="parameters" aria-label="抽帧设置">',
  );
  replace("批量抠图 →", "纯色去背 →");
  replace(
    '<div id="matting-workspace" class="stage-panel"',
    '<div id="matting-workspace" class="stage-panel browser-keying-panel"',
  );
  replace(
    '<span id="matting-progress-label"',
    '<label class="browser-keying-color" title="整组共用一个底色；自动时取首个保留帧的边缘多数色">底色 <input id="matting-color" type="color" value="#00ff00" aria-label="背景底色" disabled></label><label><input id="matting-auto-color" type="checkbox" checked>自动底色</label><button id="matting-pick" class="text-button" aria-pressed="false" title="显示当前原图，点击背景取色；Esc取消">取色</button>' +
      [
        ["tolerance", "容差", 100, 30, ""],
        ["softness", "柔边", 50, 12, ""],
        [
          "cleanup",
          "去底色",
          100,
          70,
          "只减轻新生成半透明边缘的底色污染，不修改不透明主体",
        ],
      ]
        .map(
          ([id, label, max, value, title]) =>
            `<label class="browser-keying-slider" title="${title}">${label} <input id="matting-${id}" type="range" min="0" max="${max}" step="1" value="${value}"><output id="matting-${id}-value" for="matting-${id}" aria-hidden="true">${value}</output></label>`,
        )
        .join("") +
      '<label title="取消后可去封闭孔洞，也可能误删主体同色部分"><input id="matting-connected" type="checkbox" checked>仅边缘连通</label><span id="matting-progress-label"',
  );
  replace(
    '<span class="footer-note">不抠图 · 不补帧 · 不去重</span>',
    `<span class="footer-note">本地分批解码 · 最多${LIMITS.frames}帧 · <a href="./licenses/index.html" target="_blank" rel="noopener">许可与源码</a></span>`,
  );
  source = source
    .replaceAll("请先完成当前序列的抠图", "请先导入帧序列")
    .replaceAll("等待透明帧", "等待帧序列");
  replace(
    '<button id="export-download"',
    '<button id="export-cancel" class="button secondary" hidden>取消任务</button><button id="export-download"',
  );
  return source;
}
