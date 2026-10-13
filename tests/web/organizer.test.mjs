import test from 'node:test';
import assert from 'node:assert/strict';
import {FrameEditor,totalTime} from '../../web/organizer-core.js';
const sequence=()=>({formatVersion:2,frames:Array.from({length:6},(_,i)=>({id:String(i),durationSeconds:'1/12',durationMs:1000/12}))});

test('指定单帧删除不借用勾选集合，可撤销恢复，批量删除共用历史',()=>{
  const editor=new FrameEditor(sequence());editor.select('1',{toggle:true});editor.select('4',{toggle:true});editor.view('5');
  assert.equal(editor.remove(['2']),true);assert.deepEqual(editor.order,['0','1','3','4','5']);assert.deepEqual([...editor.selected],['1','4']);assert.equal(editor.active,'5');assert.equal(editor.time.exact,'5/12');
  assert.equal(editor.remove(['missing']),false);assert.equal(editor.undoStack.length,1);
  editor.undo();assert.deepEqual(editor.order,['0','1','2','3','4','5']);assert.deepEqual([...editor.selected],['1','4']);editor.redo();
  editor.remove(['1']);assert.deepEqual([...editor.selected],['4']);editor.undo();assert.deepEqual([...editor.selected],['1','4']);
  editor.remove();assert.deepEqual(editor.order,['0','3','5']);assert.equal(editor.selected.size,0);assert.equal(editor.time.exact,'1/4');
  editor.undo();editor.clearSelection();assert.equal(editor.remove(['5']),true);assert.equal(editor.selected.size,0);assert.notEqual(editor.active,'5');editor.undo();assert.equal(editor.active,'5');
});

test('交换两帧：无需勾选，全选也只交换两帧，编号、历史与来源不变',()=>{
  const editor=new FrameEditor(sequence());editor.view('4');
  assert.equal(editor.swap('1','4'),true);assert.deepEqual(editor.order,['0','4','2','3','1','5']);
  assert.deepEqual(editor.frames.map(frame=>frame.sourceIndex+1),[1,5,3,4,2,6]);
  assert.equal(editor.selected.size,0);assert.equal(editor.active,'4');assert.equal(editor.time.exact,'1/2');
  editor.undo();editor.selectAll();const checked=[...editor.selected];
  assert.equal(editor.swap('1','4'),true);assert.deepEqual(editor.order,['0','4','2','3','1','5']);
  assert.deepEqual([...editor.selected],checked);editor.undo();editor.redo();
  assert.deepEqual(editor.order,['0','4','2','3','1','5']);
  assert.equal(editor.swap('1','1'),false);assert.equal(editor.swap('1',null),false);
  assert.equal(editor.swap('missing','4'),false);assert.equal(editor.swap('1','missing'),false);
  editor.append('1');assert.equal(editor.order.at(-1),'1');assert.equal(editor.append('1'),false);
});
test('播放集合仅含勾选帧，按整理顺序而非勾选顺序，保留原时长',()=>{
  const editor=new FrameEditor(sequence());assert.deepEqual(editor.checkedFrames,[]);
  editor.select('4',{toggle:true});editor.select('1',{toggle:true});
  assert.deepEqual(editor.checkedFrames.map(frame=>frame.id),['1','4']);assert.equal(totalTime(editor.checkedFrames).exact,'1/6');
  editor.select('1');editor.swap('1','5');editor.select('4',{toggle:true});
  assert.deepEqual(editor.checkedFrames.map(frame=>frame.id),['4','1']);assert.equal(totalTime(editor.checkedFrames).exact,'1/6');
  assert.equal(editor.frames.length,6);editor.view('0');assert.equal(editor.checkedFrames.length,2);
});
test('查看与勾选独立，初始未勾选，删除只处理勾选帧',()=>{
  const editor=new FrameEditor(sequence());assert.equal(editor.active,'0');assert.equal(editor.selected.size,0);
  editor.select('1',{toggle:true});editor.select('3',{toggle:true});assert.equal(editor.active,'0');
  editor.view('5');assert.equal(editor.active,'5');assert.deepEqual([...editor.selected],['1','3']);
  editor.select('1',{toggle:true});editor.remove();assert.deepEqual(editor.order,['0','1','2','4','5']);assert.equal(editor.active,'5');
  editor.undo();assert.deepEqual([...editor.selected],['3']);assert.equal(editor.active,'5');
  editor.clearSelection();assert.equal(editor.active,'5');assert.equal(editor.undoStack.length,0);
});
test('精确时间、不可变来源与删除/排序',()=>{const source=sequence();const editor=new FrameEditor(source);assert.equal(editor.time.exact,'1/2');editor.select('1');editor.remove();assert.equal(editor.time.exact,'5/12');assert.equal(source.frames.length,6);assert.equal(editor.swap('1','0'),false);assert.equal(editor.append('1'),false);assert.equal(editor.order.length,5);editor.undo();assert.deepEqual(editor.order,['0','1','2','3','4','5']);assert.equal(editor.time.exact,'1/2');});
test('范围/切换选择不记历史',()=>{const editor=new FrameEditor(sequence());editor.select('1');editor.select('3',{range:true});assert.deepEqual([...editor.selected],['1','2','3']);editor.select('2',{toggle:true});assert.deepEqual([...editor.selected],['1','3']);assert.equal(editor.undoStack.length,0);editor.clearSelection();assert.equal(editor.selected.size,0);});
test('单帧交换、无操作与历史分支',()=>{const editor=new FrameEditor(sequence());editor.select('1');editor.select('2',{toggle:true});assert.equal(editor.swap('1','1'),false);editor.swap('1','5');assert.deepEqual(editor.order,['0','5','2','3','4','1']);assert.equal(editor.time.exact,'1/2');editor.undo();editor.redo();assert.equal(editor.undoStack.length,1);editor.undo();editor.swap('1','0');assert.deepEqual(editor.order,['1','0','2','3','4','5']);assert.equal(editor.redoStack.length,0);editor.swap('1','0');assert.deepEqual(editor.order,['0','1','2','3','4','5']);});
test('删空、重置可撤销与导出脏状态',()=>{const editor=new FrameEditor(sequence());editor.selectAll();editor.remove();assert.equal(editor.time.exact,'0/1');assert.equal(editor.active,null);editor.reset();assert.equal(editor.order.length,6);editor.undo();assert.equal(editor.order.length,0);editor.undo();assert.equal(editor.dirty,false);editor.select('0');editor.remove();editor.markExported();assert.equal(editor.dirty,false);editor.undo();assert.equal(editor.dirty,true);});
test('不接受伪时长或重复身份，历史有界',()=>{assert.throws(()=>totalTime([{durationSeconds:'1/0'}]));assert.throws(()=>new FrameEditor({formatVersion:2,frames:[{id:'x',durationSeconds:'1/1'},{id:'x',durationSeconds:'1/1'}]}));const editor=new FrameEditor(sequence());for(let i=0;i<130;i++)editor.swap('1','0');assert.equal(editor.undoStack.length,100);});
