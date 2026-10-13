import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedCount,formatTime,FramePlayback} from '../../web/core.js';
test('预计帧数与半开区间',()=>{assert.equal(expectedCount(2,4,12),24);assert.equal(expectedCount(.1,.4,10),3);assert.equal(expectedCount(1,0,12),0);assert.equal(expectedCount(0,1,12.1),0);});
test('视频时间显示格式',()=>{assert.equal(formatTime(61.125),'01:01.125');});
test('独立播放帧率：均匀图片间隔、结束与非零起点',()=>{
  for(const fps of [1,6,12,24,60]){
    const clock=new FramePlayback(12,fps,100);
    assert.equal(clock.index(100),0);assert.equal(clock.index(100+1000/fps+.001),1);
    assert.equal(clock.ended(100+12000/fps-.001),false);assert.equal(clock.ended(100+12000/fps+.001),true);
  }
  const clock=new FramePlayback(12,12,100,5);assert.equal(clock.index(100),5);assert.equal(clock.index(200),6);
});
test('播放中调速保留当前帧进度，拒绝非法帧率',()=>{
  const clock=new FramePlayback(12,12,0);clock.setRate(6,125);
  assert.equal(clock.position(125),1.5);assert.equal(clock.index(205),1);assert.equal(clock.index(225),2);
  for(const fps of [0,61,12.5,NaN,Infinity])assert.throws(()=>clock.setRate(fps,225),RangeError);
  assert.equal(clock.fps,6);assert.throws(()=>new FramePlayback(0,12,0),RangeError);
});
test('动画回调时间戳早于操作起点时不产生负帧号或调速倒退',()=>{
  const clock=new FramePlayback(49,50,100.8);
  // 浏览器同一渲染周期的RAF时间戳可能早于点击时performance.now()。
  assert.equal(clock.index(100),0);assert.equal(clock.ended(100),false);
  assert.equal(clock.index(200.8),5);
  clock.setRate(12,200.8);
  assert.equal(clock.index(200),5);assert.ok(Math.abs(clock.position(200)-5)<1e-12);
  assert.equal(clock.index(284.8),6);
});
