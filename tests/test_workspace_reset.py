from types import SimpleNamespace
import threading
import time
import pytest
from app.service import Store
from app.config import LIMITS
from app.domain import DomainError

def test_reset_cleans_batches_and_source_but_protects_other_editor(tmp_path):
    store=Store(tmp_path/'cache',LIMITS)
    try:
        for token in ['own','other','orphan']:
            directory=store.root/f'job-{token}';directory.mkdir()
            finished=threading.Event();finished.set()
            store.jobs[token]=SimpleNamespace(id=token,directory=directory,finished=finished)
            batch_dir=store.root/f'batch-{token}';batch_dir.mkdir()
            store.batches.items[token]=SimpleNamespace(id=token,job_id=token,directory=batch_dir,finished=finished,touched=time.monotonic())
        now=time.monotonic()
        store.edit_sessions={'mine':{'jobId':'own','touched':now},'theirs':{'jobId':'other','touched':now}}
        store.busy='running'
        with pytest.raises(DomainError):store.reset_workspace('mine')
        assert len(store.jobs)==3 and len(store.edit_sessions)==2
        store.busy=None
        assert store.reset_workspace('mine')=={'ok':True,'removedJobs':2,'removedBatches':2}
        assert list(store.jobs)==['other'] and list(store.batches.items)==['other']
        assert list(store.edit_sessions)==['theirs']
        assert not (store.root/'job-own').exists() and (store.root/'job-other').exists()
        assert store.reset_workspace(None)['removedJobs']==0
    finally:
        # 测试桩不是运行任务，关闭前移除；只清理pytest临时目录。
        store.jobs.clear();store.batches.items.clear();store.close()
