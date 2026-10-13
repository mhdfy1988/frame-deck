"""测试专用确定性RGBA处理器；不能作为生产抠图或模型质量证据。"""
from PIL import Image


class Shapes:
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def stop(self):pass
    def cutout(self, source, target, batch):
        with Image.open(source) as original:
            image=Image.new('RGBA',original.size)
        index=int(target.stem.split('_')[-1])
        image.paste((220,40,60,128),(10+index*3,20,30+index*3,50))
        image.putpixel((5,10),(20,80,40,1))
        image.save(target)
        return 'test-shapes'
