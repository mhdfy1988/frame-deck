# FrameDeck · 帧工作台

视频抽帧 → 循环检测与帧整理 → 批量抠图与精修 → PNG、ZIP与图集导出。

直接抽取既有单动作工具，保留原界面与本机算法；无模型浏览器版的纯色去背复用EazyCut方案。动作工坊与MotionDeck代码不改，原数据不迁移。本工具不带工作流画布、角色项目页或3D动作库。

## 无模型浏览器版

[在线使用（GitHub Pages）](https://mhdfy1988.github.io/frame-deck/) · [部署状态](https://github.com/mhdfy1988/frame-deck/actions/workflows/pages.yml)

与本机完整版放在同一仓库，源码在`browser/`，不替换下方8902入口。支持视频抽帧、PNG序列导入、帧播放与整理、循环检测、EazyCut纯色去背、手工精修，以及PNG序列／精灵图ZIP导出。没有AI模型或服务端接口，文件在浏览器本地处理。

```powershell
npm.cmd ci
npm.cmd run build:browser
npm.cmd run preview:browser
```

打开 http://127.0.0.1:8904/frame-deck/ 。这只是独立静态预览，不启动Python、FFmpeg本机进程或模型；首次抽帧加载约32MB的浏览器解码器。源码、容量限制、与本机版的差异及验收命令见[浏览器版说明](browser/README.md)。`main`推送触发Pages构建与部署，只上传`output/browser-site/frame-deck/`的白名单产物及第三方许可／源码归档，不上传整个仓库或私人素材。是否部署成功以对应Actions任务及线上验收为准。

## 本机完整版启动

Windows需已安装Node.js 22.16或更新版本、Python 3.12（py启动器）及FFmpeg/ffprobe，并可从命令行调用。

```powershell
git clone https://github.com/mhdfy1988/frame-deck.git
Set-Location frame-deck
npm.cmd start
```

打开 http://127.0.0.1:8902/ 。首次启动自动建立本项目网页后端环境；模型不会在打开页面时下载。首次点击“批量抠图”才自动安装独立模型环境、下载固定版本模型并校验。下载显示当前文件、已下载大小和单文件百分比；准备、连接和校验阶段显示等待状态。失败明确报错，可重试续传；之后复用本地安装。完整安装日志位于`.runtime/install.log`。

首次抠图可能下载数GB，预留至少12GB空间。自动检测NVIDIA选择PyTorch CUDA 12.8，未检测到则安装CPU版；CUDA初始化失败不会静默换CPU。如需CPU，可在启动前设置`$env:FRAMEDECK_TORCH_PROFILE='cpu'`。网络需可访问PyPI、PyTorch及Hugging Face，不上传图片。

## 独立边界

- 后端环境在`.venv`，模型环境与Hugging Face缓存在`.runtime`，模型在`model-runtime/.models`。
- 缓存默认本项目`.cache`，可显式设置`FRAMEDECK_CACHE`；不读取动作工坊的FRAMES_CACHE或项目仓库。
- 必要抠图源码复制到`model-runtime`，不导入同级game-art-matting，不借用其Python、服务或权重。
- 精修前端沿用已构建资源及原像素编辑器，无AI API调用。
- 精修弹窗与主界面统一为浅色、绿色强调，保留去除、恢复、魔法棒、撤销和自动同步；可切换透明棋盘、白、黑、紫色检查背景。
- 当前仍为单动作临时工作区，未保存工作不跨重启恢复，应导出保存；不是完整工程备份。
- 真实模型重新下载、两套模型CUDA加载与缓存一帧处理已验证，用户已确认修复后的重新下载可用；全面画质仍需验收。见[下载验证与进度修复](docs/model-redownload.md)。

## 开发验证

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd test
.\.venv\Scripts\python.exe -m pytest -q
```

浏览器回归使用独立8903合成处理器服务，不替代8902主入口。先生成测试视频并在单独终端启动测试服务：

```powershell
.\.venv\Scripts\python.exe scripts/make-demo.py
.\.venv\Scripts\python.exe scripts/make-loop-demo.py
$env:FRAMEDECK_CACHE="$PWD/output/browser-test-cache"
.\.venv\Scripts\python.exe -m uvicorn export_server:app --app-dir tests --host 127.0.0.1 --port 8903
```

另一终端运行：

```powershell
$env:FRAMES_EXPORT_SYNTHETIC='1'
npm.cmd run test:e2e
```

结束后关闭测试服务。合成处理器不会下载模型，不能代替真实模型验收。操作及证据见[验证记录](docs/verification.md)，源文件抽取哈希见[抽取记录](docs/extraction-proofs.json)。

## 许可与发布

自有代码采用[MIT许可证](LICENSE)，模型与依赖保留各自许可，见[来源说明](THIRD_PARTY_NOTICES.md)。仓库提供源码，不分发基础模型、Python环境或用户素材；当前没有安装包或GitHub Release。
