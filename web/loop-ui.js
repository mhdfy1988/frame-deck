import {FramePlayback} from './core.js';
import {setControl} from './icons-ui.js';
import {bindLoopCandidates,applyLoopCandidate} from './loop-core.js';
const $=id=>document.getElementById(id);

export function createLoopFinder({getEditor,frameURL,isLocked,apply}){
  const dialog=$('loop-dialog');
  let worker=null,budget=null,generation=0,candidates=[],candidate=null,snapshot=null;
  let playing=false,clock=null,raf=0,fps=12,index=0,loading=false,imageGeneration=0;
  function stop(){playing=false;clock=null;cancelAnimationFrame(raf);setControl($('loop-play'),'play','播放');}
  function dispose(){generation++;worker?.terminate();worker=null;clearTimeout(budget);budget=null;stop();imageGeneration++;loading=false;}
  function valid(){const editor=getEditor();return editor && !isLocked() && editor.revision===snapshot?.revision && editor.signature===snapshot?.signature;}
  function buttons(){
    const disabled=!candidate || !valid();
    for(const id of ['loop-previous','loop-next','loop-play','loop-fps','loop-apply'])$(id).disabled=disabled;
  }
  function fail(message){dispose();candidate=null;$('loop-state').textContent=message;$('loop-state').setAttribute('role','alert');buttons();}
  async function showFrame(next){
    if(!candidate || !valid())return;
    const ticket=++imageGeneration,chosen=candidate;loading=true;
    const frame=getEditor().byId.get(chosen.frameIds[next]),image=new Image();
    image.src=frameURL(frame);
    try{
      await image.decode();
      if(ticket!==imageGeneration || candidate!==chosen || !dialog.open)return;
      $('loop-image').replaceWith(Object.assign(image,{id:'loop-image',alt:'循环候选原尺寸预览'}));
      index=next;$('loop-position').textContent=`${index+1} / ${chosen.count}`;
      $('loop-original').textContent=`原帧 ${String(frame.sourceIndex+1).padStart(3,'0')}`;
    }catch{
      if(ticket===imageGeneration && dialog.open)fail('预览原帧读取失败，请重新交接');
    }finally{if(ticket===imageGeneration)loading=false;}
  }
  function tick(){
    if(!playing)return;
    if(!valid()){fail('帧顺序或会话已变化，请关闭后重新寻找');return;}
    const next=Math.floor(clock.position(performance.now()))%candidate.count;
    if(next!==index && !loading)showFrame(next);
    raf=requestAnimationFrame(tick);
  }
  function play(){
    if(!candidate || !valid())return;
    if(playing){stop();return;}
    clock=new FramePlayback(candidate.count,fps,performance.now(),index);playing=true;setControl($('loop-play'),'pause','暂停');raf=requestAnimationFrame(tick);
  }
  function choose(value){
    stop();imageGeneration++;loading=false;candidate=value;index=0;
    for(const item of $('loop-list').children)item.setAttribute('aria-pressed',String(Number(item.dataset.candidate)===candidates.indexOf(value)));
    $('loop-stage').hidden=false;$('loop-preview-controls').hidden=false;
    $('loop-image').removeAttribute('src');$('loop-position').textContent=`1 / ${value.count}`;$('loop-original').textContent='';
    buttons();showFrame(0);
  }
  function finish(result,editor){
    worker?.terminate();worker=null;clearTimeout(budget);budget=null;
    if(!valid()){fail('帧顺序或会话已变化，请关闭后重新寻找');return;}
    candidates=bindLoopCandidates(editor.order,editor.revision,result.candidates);
    $('loop-state').textContent=candidates.length?`找到 ${candidates.length} 个候选 · 请检查首尾衔接`:'未找到合适循环；可提高抽帧采样率或换一段动作';
    $('loop-state').setAttribute('role','status');
    for(const [number,value] of candidates.entries()){
      const item=document.createElement('button');item.className='loop-candidate';item.type='button';item.dataset.candidate=number;item.setAttribute('aria-pressed','false');
      const title=document.createElement('strong');title.textContent=`${value.count} 帧`;
      const range=document.createElement('span'),start=editor.byId.get(value.frameIds[0]).sourceIndex+1,end=editor.byId.get(value.frameIds.at(-1)).sourceIndex+1;
      range.textContent=`原帧 ${String(start).padStart(3,'0')} → ${String(end).padStart(3,'0')}`;
      const position=document.createElement('small');position.textContent=`当前位置 ${value.start+1}–${value.endExclusive}`;
      item.append(title,range,position);item.onclick=()=>choose(value);$('loop-list').append(item);
    }
    if(candidates.length)choose(candidates[0]);else buttons();
  }
  function open(){
    const editor=getEditor();if(!editor || isLocked() || editor.order.length<7)return;
    dispose();snapshot={revision:editor.revision,signature:editor.signature};candidates=[];candidate=null;index=0;
    $('loop-list').replaceChildren();$('loop-stage').hidden=true;$('loop-preview-controls').hidden=true;
    $('loop-state').textContent='准备分析';$('loop-state').setAttribute('role','status');$('loop-fps').value=fps;buttons();dialog.showModal();
    const current=generation;
    try{
      worker=new Worker(new URL('./loop-worker.js',import.meta.url),{type:'module'});
      budget=setTimeout(()=>{if(generation===current && dialog.open)fail('循环分析超过45秒，请减少帧数后重试');},45000);
      worker.onerror=event=>{event.preventDefault();if(current===generation)fail('循环分析线程失败，请使用新版Chrome后重试');};
      worker.onmessage=({data})=>{
        if(current!==generation || !dialog.open)return;
        if(data.type==='progress')$('loop-state').textContent=data.message;
        else if(data.type==='error')fail(data.message);
        else if(data.type==='result')finish(data,editor);
      };
      worker.postMessage({urls:editor.frames.map(frame=>frameURL(frame,true))});
    }catch{fail('浏览器无法启动循环分析线程，请使用新版Chrome');}
  }
  $('loop-close').onclick=()=>dialog.close();$('loop-cancel').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{dispose();candidates=[];candidate=null;$('loop-list').replaceChildren();$('loop-image').removeAttribute('src');});
  dialog.addEventListener('cancel',()=>dispose());
  $('loop-previous').onclick=()=>{stop();showFrame((index+candidate.count-1)%candidate.count);};
  $('loop-next').onclick=()=>{stop();showFrame((index+1)%candidate.count);};
  $('loop-play').onclick=play;
  $('loop-fps').oninput=()=>{const input=$('loop-fps');if(!input.value || !input.validity.valid)return;fps=input.valueAsNumber;clock?.setRate(fps,performance.now());};
  $('loop-fps').onblur=()=>{$('loop-fps').value=fps;};
  $('loop-apply').onclick=()=>{
    if(!candidate || !valid()){fail('帧顺序或会话已变化，请重新寻找循环');return;}
    try{const value=candidate;dialog.close();apply(()=>applyLoopCandidate(getEditor(),value),`已保留 ${value.count} 帧循环，可撤销`);}catch(reason){$('edit-error').textContent=reason.message;}
  };
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
  return {open,close:()=>{if(dialog.open)dialog.close();},get active(){return dialog.open;}};
}
