# 模型重新下载验证

2026-10-13：用户要求清空模型后亲自重试下载，已确认重启并重新导入。

- 只将本项目HR、ToonOut、Hugging Face缓存及就绪清单移至 `output/acceptance/model-reset-backup-20261013`，安装器不会扫描或复用该目录。执行保护拒绝递归删除，因此采用可恢复隔离，不宣称已永久删除。
- 保留模型虚拟环境和green-edge-refiner。此次验证只重新下载模型，不重新下载PyTorch依赖。
- 当前工作区文件已备份到 `output/acceptance/before-model-redownload-20261013`。服务启动会回收旧缓存，必须提前说明；页面选择状态不能自动恢复。
- 进度显示使用固定版huggingface-hub 0.36.2的 `utils/tqdm.py::_get_progress_bar_context` 及 `file_download.py::http_get`。独立显示适配层只改进度输出，不改HTTP、重试、缓存续传和校验。
- SDK单文件字节数以结构化消息送到控制器，再送至页面进度条。没有总大小的阶段显示不定进度；百分比仅代表当前文件，不代表整个安装。
- 定向Python测试12项、JavaScript进度测试1项、Chrome进度显示测试2项通过；实际安装环境进度适配发出0/4096及4096/4096字节。8902已重启，接口确认missing；本轮真实重新下载留给用户触发。
- 未修改其他项目，未提交推送。

## 真实重试后的进度链路修复

- 本次用户触发重新下载，最终8902接口返回ready，模型下载和加载校验成功。
- 实际日志只有STAGE，没有孙进程的pip及SDK进度。最小Windows隐藏子进程复现确认：未显式传stdout/stderr时，只能捕获父进程输出。
- `scripts/install-runtime.py::run`显式传递当前stdout/stderr，保持下载逻辑不变。`tests/runtime_output_probe.py`验证真正孙进程的标准输出和错误输出均进入捕获管道；相关11项Python测试通过。
- 之前的SDK适配测试和页面模拟测试只能证明各自一段，不能替代跨进程端到端证据。后续进度验证必须包含隐藏安装进程及孙进程输出转发。
- 本轮安装已结束，不再次清模型或打断用户9帧；修复下次安装启动时生效。修复后的真实网络下载进度尚未再次验收。

## 第二次重置与用户验收

- 模型、缓存和就绪清单再次隔离至本机忽略目录`output/acceptance/model-reset-backup-2-20261013`，8902重启后确认missing；保留Python/PyTorch依赖。
- 用户重新测试下载后确认“可以了”。本次真实下载已使用修复后的输出转发；接口已返回ready。该确认不扩写为全面抠图质量验收。
- 精修浅色主题单独经Chrome验证，去除、撤销、自动同步、保存失败重试与关闭流程均通过。
