import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureModelRuntime} from '../../web/model-runtime-ui.js';

test('下载百分比来自字节数；结束后清理进度条',async()=>{
  let reads=0;
  const api=async(path)=>path.endsWith('/install')?{}:++reads===1?{ready:false}:reads===2?{
    phase:'installing',stage:'下载模型',progress:{file:'model.safetensors',downloaded:1048576,total:4194304},
  }:{ready:true,stage:'已就绪'};
  const labels=[],values=[];
  await ensureModelRuntime(api,label=>labels.push(label),value=>values.push(value));
  assert.ok(labels.some(label=>label.includes('1.0 MB / 4.0 MB · 25%')));
  assert.equal(values.at(-1),undefined);
});
