"""固定版huggingface-hub的显示适配；下载、重试、续传仍由SDK负责。"""
import importlib
import json
import time


def enable_progress():
    module = importlib.import_module('huggingface_hub.utils.tqdm')
    original = module.tqdm

    class DownloadProgress(original):
        def __init__(self, *args, **kwargs):
            self.last_report = 0
            kwargs['disable'] = False
            super().__init__(*args, **kwargs)

        def display(self, *args, **kwargs):
            # HTTP下载报告字节数；文件计数不冒充下载百分比。
            if self.unit != 'B':
                return
            now = time.monotonic()
            if now - self.last_report < 0.5 and self.n != self.total:
                return
            self.last_report = now
            print('PROGRESS:' + json.dumps({
                'file': self.desc, 'downloaded': self.n, 'total': self.total,
            }, ensure_ascii=False), flush=True)

    module.tqdm = DownloadProgress
