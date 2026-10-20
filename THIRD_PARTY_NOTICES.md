# 来源与第三方许可

单动作工具源码从action-forge复制；抠图引擎、绿幕处理与安装/转换脚本从game-art-matting复制。仅目标副本做入口适配，原项目不变。仓库所有者已单独确认FrameDeck自有代码采用MIT许可证；第三方代码、模型和训练数据不因该许可变更。

- 图标Lucide：ISC，许可保留在web/licenses/lucide.txt。
- 构建精修包含Culori、fast-png等依赖，保留构建文件内原许可；精修源码来源为game-art-matting固定1668d18提交。
- ToonOut：Matteo Muratori、Joël Seytre / Kartoon AI；[作者模型卡](https://huggingface.co/joelseytre/toonout)标为MIT，固定修订cbf720eca394edcde66b861a8a8c20fbabe9c748。
- BiRefNet HR-matting：[作者模型卡](https://huggingface.co/ZhengPeng7/BiRefNet_HR-matting)标为MIT；固定修订5d6b6f8adcb5b417c871b1d84ceaae9871355b7f。ToonOut架构代码固定BiRefNet修订e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4。
- 既有小型green-edge-refiner保留原训练来源/provenance.json；使用CC-BY-4.0公开训练数据，数据作者Matteo Muratori、Joël Seytre、Gabriel Aubourg。训练数据不分发，基础模型首次从作者渠道下载。
- PyTorch采用官方2.8.0/torchvision0.23.0渠道，下载模型通过Hugging Face官方SDK，不手写OAuth、下载协议或自定义模型服务。

不分发基础模型、私人图片或研究参考源码；本地首次下载不改变第三方许可。

## 无模型浏览器版新增依赖

- EazyCut纯色去背：[上游仓库](https://github.com/mhdfy1988/EazyCut)，固定提交`6d75c86d4c123f3ae2fbb4f5742bb99f61f6f93b`，MIT，版权EazyCut contributors。复制`src/core/keying.js`与色差适配到`browser/keying/`，仅将尺寸保护接入本项目1200万像素上限并补充连通选项类型校验；许可在`browser/licenses/eazycut-MIT.txt`。不运行或依赖同级EazyCut项目。
- `culori@4.0.2`：MIT，版权Dan Burzo；为上述核心提供Lab颜色转换与CIEDE2000色差，隔离在`browser/keying/color-distance.js`。构建复制锁定包的LICENSE到`licenses/culori.txt`；不改变原精修器自带依赖。
- `@ffmpeg/ffmpeg@0.12.15`：MIT包装器，通过工作线程调用运行库；许可副本在`browser/licenses/ffmpeg-wrapper-MIT.txt`。
- `@ffmpeg/core@0.12.10`：官方单线程JS／WASM，包清单标为`GPL-2.0-or-later`，不是AI模型。构建逐字节复制锁定包中的运行文件，不修改运行库；GPL文本在`browser/licenses/FFMPEG-GPL-2.0.txt`。对应[上游发布v12.15](https://github.com/ffmpegwasm/ffmpeg.wasm/releases/tag/v12.15)、[固定构建材料](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/71aa99d37c02a7b4c435275ca9ef50e612f6efa1)及[官方许可说明](https://ffmpegwasm.netlify.app/docs/faq/#what-is-the-license-of-ffmpegwasm)。注意`v0.12.10`旧标签是包装器0.12.10／core0.12.6，并非本次二进制来源。
- `fflate@0.8.3`：MIT，用于浏览器ZIP打包，许可随静态产物保留；替代Python归档适配，不改变原本机打包器。
- `prettier@3.9.10`：MIT，仅格式化新增浏览器源码和测试，不进入网页产物。

公开产物包含`licenses/index.html`、来源及许可文本，并在同站点提供FFmpeg、绑定／构建脚本、Dockerfile列出的外部库及Emscripten／SDL2源码归档；清单为`browser/licenses/ffmpeg-sources.json`，包含版本与SHA-256。上游浮动分支x264／LAME固定为早于该次构建且当前未变的提交；标签归档用哈希锁定。归档保留各自许可，zimg的googletest为未编译的上游测试子模块，不包含在运行二进制中。本项目未重新编译或承诺逐字节可重建官方二进制；此记录为实际交付说明，不是法律合规认证，后续变更运行库须重新核对，不能只更新版本字符串。

复制的小权重provenance中的旧quality_report路径仅是原机器历史证据出处，不是本工具运行依赖或当前验收报告。
