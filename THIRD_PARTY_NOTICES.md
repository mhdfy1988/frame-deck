# 来源与第三方许可

单动作工具源码从action-forge复制；抠图引擎、绿幕处理与安装/转换脚本从game-art-matting复制。仅目标副本做入口适配，原项目不变。仓库所有者已单独确认FrameDeck自有代码采用MIT许可证；第三方代码、模型和训练数据不因该许可变更。

- 图标Lucide：ISC，许可保留在web/licenses/lucide.txt。
- 构建精修包含Culori、fast-png等依赖，保留构建文件内原许可；精修源码来源为game-art-matting固定1668d18提交。
- ToonOut：Matteo Muratori、Joël Seytre / Kartoon AI；[作者模型卡](https://huggingface.co/joelseytre/toonout)标为MIT，固定修订cbf720eca394edcde66b861a8a8c20fbabe9c748。
- BiRefNet HR-matting：[作者模型卡](https://huggingface.co/ZhengPeng7/BiRefNet_HR-matting)标为MIT；固定修订5d6b6f8adcb5b417c871b1d84ceaae9871355b7f。ToonOut架构代码固定BiRefNet修订e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4。
- 既有小型green-edge-refiner保留原训练来源/provenance.json；使用CC-BY-4.0公开训练数据，数据作者Matteo Muratori、Joël Seytre、Gabriel Aubourg。训练数据不分发，基础模型首次从作者渠道下载。
- PyTorch采用官方2.8.0/torchvision0.23.0渠道，下载模型通过Hugging Face官方SDK，不手写OAuth、下载协议或自定义模型服务。

不分发基础模型、私人图片或研究参考源码；本地首次下载不改变第三方许可。

复制的小权重provenance中的旧quality_report路径仅是原机器历史证据出处，不是本工具运行依赖或当前验收报告。
