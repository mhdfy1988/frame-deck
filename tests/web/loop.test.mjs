import test from 'node:test';
import assert from 'node:assert/strict';
import {ANALYSIS_SIZE,screenColor,describeFrame,frameDistance,findLoopCandidates,bindLoopCandidates,applyLoopCandidate} from '../../web/loop-core.js';
import {FrameEditor} from '../../web/organizer-core.js';
import {FramePlayback} from '../../web/core.js';

function pixels(phase,{drift=0,period=12,background=[0,240,0],style=0}={}){
  const size=ANALYSIS_SIZE,data=new Uint8ClampedArray(size*size*4);
  for(let p=0;p<size*size;p++)data.set([...background,255],p*4);
  const box=(x,y,w,h,color)=>{for(let iy=Math.round(y);iy<Math.round(y)+h;iy++)for(let ix=Math.round(x);ix<Math.round(x)+w;ix++)if(ix>=0 && ix<size && iy>=0 && iy<size)data.set([...color,255],(iy*size+ix)*4);};
  box(10+drift,5,4,12,[120,65,35]);box(11+drift,6,2,2,[230,200,150]);
  const angle=phase*2*Math.PI/period;
  box(12+drift+Math.cos(angle)*5,11+Math.sin(angle)*5,3,3,style?[240,100,30]:[240,25,20]);
  box(9+drift-Math.cos(angle)*4,15-Math.sin(angle)*3,2,3,[50,55,140]);
  return data;
}
function features(phases,options={}){
  const first=pixels(phases[0],options),background=screenColor(first);
  return phases.map(phase=>describeFrame(pixels(phase,options),background));
}
const repeat=(count=48,period=12)=>features(Array.from({length:count},(_,i)=>i%period),{period});

test('绿幕只作分析权重：大背景不能掩盖角色变化，固定画布保留位移',()=>{
  const a=pixels(0),bg=screenColor(a);assert.ok(bg);
  assert.equal(frameDistance(describeFrame(a,bg),describeFrame(a,bg)),0);
  assert.ok(frameDistance(describeFrame(a,bg),describeFrame(pixels(6),bg))>.06);
  assert.ok(frameDistance(describeFrame(a,bg),describeFrame(pixels(0,{drift:3}),bg))>.08);
  assert.equal(screenColor(pixels(0,{background:[255,255,255]})),null);
  assert.deepEqual([...a.slice(0,4)],[0,240,0,255]);
});
test('已知12帧周期：推荐原帧半开区间，排除重复相位端点',()=>{
  const trace=[];const candidates=findLoopCandidates(repeat(),{trace:value=>trace.push(value)});assert.ok(candidates.length,JSON.stringify(trace.slice(0,3)));
  assert.equal(candidates[0].count,12);
  assert.equal(candidates[0].endExclusive-candidates[0].start,12);
  assert.ok(candidates.every(value=>value.count%12===0));
  assert.ok(candidates.length<=5);
});
test('完整运动邻域：同姿势反向动作不能推荐为半周期',()=>{
  const phases=Array.from({length:50},(_,i)=>{const p=i%16;return p<=8?p:16-p;});
  const candidates=findLoopCandidates(features(phases,{period:32}));
  assert.ok(candidates.length);assert.equal(candidates[0].count,16);
  assert.ok(candidates.every(value=>value.count!==8));
});
test('静止、仅一次动作、帧数不足不强凑循环',()=>{
  assert.deepEqual(findLoopCandidates(features(Array(40).fill(0))),[]);
  assert.deepEqual(findLoopCandidates(features(Array.from({length:12},(_,i)=>i),{period:40})),[]);
  assert.deepEqual(findLoopCandidates(repeat(6)),[]);
  assert.throws(()=>findLoopCandidates(Array(601).fill(repeat(1)[0])),/600/);
});
test('不同周期与动作片段保留多个候选，不把全部相位重复列出',()=>{
  const first=repeat(36,12),second=features(Array.from({length:30},(_,i)=>i%10),{period:10,style:1});
  const candidates=findLoopCandidates([...first,...second]);
  assert.ok(candidates.some(value=>value.count===12));assert.ok(candidates.some(value=>value.count===10 && value.start>=36));
});
test('逐周期位置漂移不能通过把角色居中掩盖接缝',()=>{
  const items=Array.from({length:36},(_,i)=>describeFrame(pixels(i%12,{drift:Math.floor(i/12)*3}),[0,240/255,0]));
  assert.deepEqual(findLoopCandidates(items),[]);
});
test('有界600帧、可中止；候选裁剪只提交一次历史，旧版本不得套用',()=>{
  const started=performance.now();assert.ok(findLoopCandidates(repeat(600)).length);
  assert.ok(performance.now()-started<15000);
  assert.throws(()=>findLoopCandidates(repeat(),{check:()=>{throw new Error('取消');}}),/取消/);
  const source={formatVersion:2,frames:Array.from({length:48},(_,i)=>({id:`id${i}`,durationSeconds:'1/12',sourcePTS:i}))};
  const editor=new FrameEditor(source);editor.selected=new Set(['id1','id40']);editor.view('id40');
  const initial=editor.snapshot(),candidate=bindLoopCandidates(editor.order,editor.revision,[{start:4,endExclusive:16,count:12}])[0];
  assert.equal(applyLoopCandidate(editor,candidate),true);assert.equal(editor.undoStack.length,1);
  assert.deepEqual(editor.order,source.frames.slice(4,16).map(frame=>frame.id));assert.equal(editor.selected.size,0);
  editor.undo();assert.deepEqual(editor.snapshot(),initial);editor.redo();assert.equal(editor.order.length,12);
  editor.undo();assert.throws(()=>applyLoopCandidate(editor,candidate),/变化/);
  assert.equal(source.frames.length,48);assert.equal(editor.byId.get('id40').sourcePTS,40);
});
test('独立循环时钟跨尾帧回首帧，调速不倒退，主播放仍单次结束',()=>{
  const clock=new FramePlayback(12,12,1000);
  assert.equal(Math.floor(clock.position(2050))%12,0);assert.equal(clock.index(2050),11);assert.equal(clock.ended(2050),true);
  clock.setRate(6,2050);assert.equal(Math.floor(clock.position(2050))%12,0);assert.equal(Math.floor(clock.position(2220))%12,1);
});
