import test from 'node:test';
import assert from 'node:assert/strict';
import {exportSettings,exportGeometry,previewKey} from '../../web/export-core.js';
import {PreviewCache} from '../../web/preview-cache.js';
const input={batchId:'a',frameIds:['1','2','3'],revisions:{1:0,2:0,3:0}};
const analysis={canvas:{width:320,height:180}};
const values={crop:[0,0,320,180],size:'half',width:64,height:64,fps:12,columns:2,format:'sequence',name:'跑步',filter:'smooth',upscale:false};

test('比例尺寸取整、统一画布和导出参数边界',()=>{
  assert.deepEqual([exportSettings(input,analysis,values).width,exportSettings(input,analysis,values).height],[160,90]);
  assert.equal(exportSettings(input,analysis,{...values,size:'eighth'}).height,23);
  const s=exportSettings(input,analysis,{...values,size:'custom',width:64,height:64});
  assert.equal(exportGeometry(s,3).scale,.2);
  for(const bad of [{fps:0},{fps:12.5},{columns:0},{crop:[-1,0,2,2]},{size:'custom',width:8192,height:8192},{name:'../bad'}])assert.throws(()=>exportSettings(input,analysis,{...values,...bad}));
});
test('缓存键按像素而非名称/帧率/文件格式失效，图集列数与修订保持隔离',()=>{
  const s=exportSettings(input,analysis,values);
  assert.equal(previewKey(s,0),previewKey({...s,name:'跳跃',fps:24,format:'sheet',columns:3},0));
  assert.notEqual(previewKey(s,0,'sheet'),previewKey({...s,columns:3},0,'sheet'));
  assert.notEqual(previewKey(s,0),previewKey({...s,revisions:{1:1,2:0,3:0}},0));
  assert.notEqual(previewKey(s,0),previewKey({...s,width:128},0));
});
test('最近使用淘汰、替换计数及大于8帧循环有界复用',()=>{
  const cache=new PreviewCache({maxEntries:2,maxBytes:32});const image={width:2,height:2};
  cache.set('a',image);cache.set('b',image);assert.equal(cache.get('a'),image);cache.set('c',image);
  assert.equal(cache.get('b'),undefined);assert.equal(cache.bytes,32);
  cache.set('a',{width:1,height:1});assert.equal(cache.bytes,20);
  cache.set('large',{width:100,height:100});assert.equal(cache.get('large'),undefined);assert.equal(cache.bytes,20);
  cache.clear();assert.equal(cache.bytes,0);assert.equal(cache.size,0);
  const frames=new PreviewCache();for(let i=0;i<13;i++)frames.set(i,{width:64,height:64});
  for(let loop=0;loop<4;loop++)for(let i=0;i<13;i++)assert.ok(frames.get(i));
  assert.equal(frames.size,13);assert.equal(frames.bytes,13*64*64*4);
});
