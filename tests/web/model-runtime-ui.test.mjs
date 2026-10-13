import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureModelRuntime} from '../../web/model-runtime-ui.js';

test('已安装只查询状态，不重新安装',async()=>{
  const calls=[];
  await ensureModelRuntime(async(path,options)=>{calls.push([path,options]);return {ready:true};},()=>{});
  assert.equal(calls.length,1);
});

test('首次启用提交安装并等待就绪，不提前处理素材',async()=>{
  const calls=[],stages=[];let reads=0;
  await ensureModelRuntime(async(path,options)=>{
    calls.push([path,options?.method]);
    if(options?.method==='POST')return {};
    return ++reads===1?{ready:false,phase:'missing'}:{ready:true,stage:'已安装'};
  },text=>stages.push(text));
  assert.equal(calls[1][1],'POST');
  assert.equal(reads,2);
  assert.ok(stages[0].includes('数GB'));
});

test('安装错误显式抛出，不退回旧项目',async()=>{
  let reads=0;
  await assert.rejects(ensureModelRuntime(async(path,options)=>{
    if(options)return {};
    return ++reads===1?{ready:false}:{ready:false,phase:'failed',stage:'失败',error:'网络失败'};
  },()=>{}),/网络失败/);
});
