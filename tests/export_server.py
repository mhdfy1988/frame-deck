"""仅独立测试服务使用合成RGBA，生产入口绝不加载此处理器。"""
from app.batch_matting import BatchManager
from synthetic_matting import Shapes
original = BatchManager.__init__

def init(self, store, model_factory=None):
    original(self, store, Shapes)

BatchManager.__init__ = init
from app.main import app
app.state.model_setup.status = lambda: {'phase': 'ready', 'stage': '合成测试处理器', 'ready': True}
