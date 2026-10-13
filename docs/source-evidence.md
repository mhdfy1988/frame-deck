# 抽取与安装源码证据

- action-forge/web/app.js、organizer-core.js、matting-ui.js、export-core.js：复用既有单动作链路；独立副本只去导航、改品牌和增加首次安装等待。
- action-forge/app/service.py、media.py、organizer.py、batch_matting.py、export_frames.py：有界任务、原PNG/时长、精修事务及导出核心，复制不重写。
- game-art-matting/app/engine.py及scripts/install_model.py、prepare_toonout_local.py：固定模型路由、CPU/GPU精度、前缀清理及FP16转换。独立副本禁止读取其他项目GAME_ART_MODEL_DIR。
- [PyTorch官方旧版本安装](https://pytorch.org/get-started/previous-versions/)提供2.8.0、torchvision0.23.0的CPU/CUDA安装命令。
- [Hugging Face官方下载指南](https://huggingface.co/docs/huggingface_hub/guides/download)：使用hf_hub_download/snapshot_download，固定revision并在独立HF_HOME复用缓存。安装验证文件ETag、模型加载与设备，成功后原子写就绪清单。
- 新边界：app/model_setup.py只控制状态和固定安装脚本；model-runtime保留模型核心。先安装并验证，再提交原批量抠图；失败不进入原处理或借用同级目录。
