# 首次安装下载超时修复

2026-10-13。用户在8902当前9帧抠图时遇到安装脚本退出码1，网页只显示外层CalledProcessError。

## 证据与根因

- 独立模型环境已安装：PyTorch 2.8.0+cu128，torch.cuda.is_available()为true。HR权重444473596字节已下载，不是CUDA不可用。
- 以同一FrameDeck模型Python、HF_HOME和固定修订复现，ToonOut下载的us.aws.cdn.hf.co连接出现Read timed out；SDK重试续传后完成下载与哈希校验。
- 源ToonOut SHA256：8c7f8a0bc24400f4caade76622f75ff22ca1e93e169add9d2b70093e2487fbe5；FP16转换结果41c1c1390698f3edd2b00cf3cfd67ad543e31201b7cce48aa23cb8387b88ec4a。
- 原控制器只保留最后一行输出，导致实际网络超时被外层“子进程失败”遮蔽；这是独立的可诊断性缺陷。

## 修改与验证

- 官方SDK下载超时设120秒，元数据30秒，仍使用固定修订、缓存续传和哈希校验。依据[官方环境变量说明](https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables)及已安装0.36.2源码，环境变量在导入前设置。
- 控制器保存有界UTF-8安装日志到.runtime/install.log，错误优先显示内部根因，不只显示CalledProcessError；重试清旧日志提示。
- 已校验就绪清单允许直接复用，不因旧失败状态重复安装或下载；未改模型路由，不添加CPU或旧实现回退。
- 两套模型在独立CUDA环境加载成功，就绪清单已原子写入。现有8902状态已由安装接口更新为ready，无需重启或重新导入素材。
- 使用当前用户缓存的一帧，独立模型进程返回ok=true，ToonOut/CUDA/FP16，推理0.836秒；输出1280×720 RGBA，Alpha范围0–255。只写output/acceptance/runtime-live，原帧不改；这是一帧链路验证，不是整段或全面质量验收。
- 安装与独立边界11项测试通过，包括根因日志、超时配置、缓存复用和测试状态隔离。

## 保留当前工作

没有重启用户8902服务，避免清理临时视频/抽帧；没有操作其9帧编排。日志控制器修正已保存源码，下次正常服务启动使用新版；当前安装已恢复可用，用户再次点击批量抠图即可沿原链路处理。

动作工坊、MotionDeck及game-art-matting源码不改。未提交推送。
