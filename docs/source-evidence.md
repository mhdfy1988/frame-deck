# 抽取与安装源码证据

## 2026-10-21 Pages交付来源

- 核对npm core0.12.10的官方发布为[v12.15](https://github.com/ffmpegwasm/ffmpeg.wasm/releases/tag/v12.15)，固定提交`71aa99d37c02a7b4c435275ca9ef50e612f6efa1`；旧v0.12.10实际是包装器0.12.10／core0.12.6，不能继续当作本次核心来源。修正当前第三方说明，历史本地验收记录保持其日期语境。
- 读取该提交Dockerfile与构建脚本，核对FFmpeg n5.1.4、外部库版本、Emscripten3.1.40及其SDL2端口release-2.24.2。19份源码归档按SHA-256锁定并随静态站点下载提供，包含原许可／构建脚本。x264与LAME原浮动分支固定为现存、早于构建的提交；不承诺官方二进制逐字节可重建。
- 部署采用[GitHub官方Pages工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)的构建／上传／部署分离。发布构建要求源码归档完整且哈希正确，再检查产物白名单；`build-info.json`含CI提交及文件哈希，用于核对线上身份。只上传产物子目录，不发布模型、用户素材或本机环境。

## 2026-10-21 EazyCut纯色去背

- 来源为本地只读参考`D:\learn_code\game\eazycut`，对应[上游固定提交](https://github.com/mhdfy1988/EazyCut/tree/6d75c86d4c123f3ae2fbb4f5742bb99f61f6f93b)。`src/core/keying.js`与`src/core/color-distance.js`复制到`browser/keying/`，保留边缘多数色估计、CIEDE2000色差、透明过渡、边缘连通筛选及半透明边缘去底色；本地适配仅为1200万像素统一预算和连通选项类型校验。许可与固定Culori版本见第三方说明，不借用参考项目运行环境。
- `pixel-worker.js`只适配Blob／RGBA／PNG；`tasks.js`从首帧原图确定一次底色、逐帧处理并管理取消与预算；`ui/keying-controls.js`只拥有参数和取色交互。`main.js`确认覆盖后协调任务，全部成功才由唯一会话替换结果。重复执行读取原图而非上轮结果，不保留旧四角算法fallback。
- 默认容差30、柔边12、去底色70、边缘连通开启。全图模式能去封闭同色背景，但会误删主体同色部分；自动底色不是语义识别。取色临时显示原图，坐标排除留黑区域，参数修改不自动触发批处理。
- 合成像素测试与完整Chrome回归支持上述行为，不能替代用户原素材画质验收。本机模型、原手工精修和其他项目源码未修改。

## 2026-10-20 无模型浏览器适配

- 容量优化：`browser/domain.js`统一帧数／批大小，`browser/video.js`按重采样后帧号批量生成，逐PNG读出并调用`deleteFile`；`browser/ui/media.js`队列生成192像素缩略图，原图URL有界；`browser/archive.js`复用fflate的`Zip`／`ZipPassThrough`逐Blob分块写入并回收取消候选。依据[FFmpeg裁切滤镜](https://ffmpeg.org/ffmpeg-filters.html#trim)及[官方裁切源码](https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/trim.c)的帧号半开范围语义，保持原采样相位；库API以本项目固定版本及同版本WASM实际测试为准。接受各批重复解码前段的计算代价，不用输入seek猜测对齐，不保留一次性生产fallback。
- 界面来源为原`web/index.html`、`web/style.css`、`web/icons-ui.js`。浏览器构建通过`scripts/browser-template.mjs`做唯一命中的必要入口／路径适配，沿用四屏及弹窗结构，不维护另一套主页面；原CSS作为产物前缀逐字节保留并有测试检查。早期新布局已移除，当前四屏绑定在`browser/ui/`各模块，详见验证记录的“恢复原界面”。
- `web/core.js`、`web/organizer-core.js`、`web/loop-core.js`：直接导入原播放、帧身份／顺序／历史和循环计算；`web/loop-worker.js`已有Blob输入，静态版复用该入口，不增加服务器。
- `web/matting/app-V37DVJIL.js`及`worker-4EQHDEQU.js`：原连通选区、画笔与PNG读写继续使用；原嵌入器要求32位十六进制批次及特定帧令牌，`browser/ui/repair.js`显式映射临时令牌到会话帧身份，不放宽原校验。`scripts/build-browser.mjs`只对生成物替换网络函数与路径，适配点变化立即失败。
- [FFmpeg.wasm官方用法](https://ffmpegwasm.netlify.app/docs/getting-started/usage/)与[调用接口](https://ffmpegwasm.netlify.app/docs/api/ffmpeg/classes/ffmpeg/)：固定单线程core、同源资源地址、真实WASM文件读写与terminate取消，不调用本机FFmpeg服务。
- 固定core 0.12.10存在[ffprobe返回-1问题817](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/817)；[绑定源码](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/src/bind/ffmpeg/bind.js)显示ret初值／reset为-1。当前适配不把-1无条件当作成功：要求完整探测JSON、合法时长／尺寸、无错误日志，并显示控制台警告；损坏视频真实测试仍拒绝并保留旧结果。
- `app/export_frames.py`是本机裁剪缩放及归档语义参考；浏览器版复用`web/export-core.js`参数和几何，以Canvas＋fflate实现文件适配。平滑滤波、真实PTS及容量不冒称等价，见[差异说明](../browser/README.md#容量与差异)。
- 这些证据只支持本地浏览器版的已实现路径；尚未验证Pages线上部署及完整第三方二进制分发许可，不将静态构建通过写成已经发布。

## 本机抽取来源（历史）

- action-forge/web/app.js、organizer-core.js、matting-ui.js、export-core.js：复用既有单动作链路；独立副本只去导航、改品牌和增加首次安装等待。
- action-forge/app/service.py、media.py、organizer.py、batch_matting.py、export_frames.py：有界任务、原PNG/时长、精修事务及导出核心，复制不重写。
- game-art-matting/app/engine.py及scripts/install_model.py、prepare_toonout_local.py：固定模型路由、CPU/GPU精度、前缀清理及FP16转换。独立副本禁止读取其他项目GAME_ART_MODEL_DIR。
- [PyTorch官方旧版本安装](https://pytorch.org/get-started/previous-versions/)提供2.8.0、torchvision0.23.0的CPU/CUDA安装命令。
- [Hugging Face官方下载指南](https://huggingface.co/docs/huggingface_hub/guides/download)：使用hf_hub_download/snapshot_download，固定revision并在独立HF_HOME复用缓存。安装验证文件ETag、模型加载与设备，成功后原子写就绪清单。
- 新边界：app/model_setup.py只控制状态和固定安装脚本；model-runtime保留模型核心。先安装并验证，再提交原批量抠图；失败不进入原处理或借用同级目录。
