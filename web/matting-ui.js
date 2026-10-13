import {FramePlayback} from './core.js';
import {ensureModelRuntime} from './model-runtime-ui.js';
import {setControl} from './icons-ui.js';
const $=id=>document.getElementById(id);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function createMatting(api,{snapshot,onControls=()=>{}}){
  let batch=null,working=false,run=null,active=null,repairFrame=null,repairDirty=false,repairBusy=false,lastKey='';
  let playback=null,raf=0,playFPS=12,closeRequested=false;
  const error=message=>$('matting-error').textContent=message||'';
  const setStatus=message=>$('matting-status').textContent=message;
  const current=()=>{try{return snapshot();}catch{return null;}};
  const matches=input=>!!batch&&batch.status==='done'&&batch.sourceJobId===input?.jobId&&batch.processingPolicy==='model-local-despill-v1';
  const processed=(input,id)=>matches(input)&&Object.hasOwn(batch.revisions,id);
  const missing=input=>input?input.frameIds.filter(id=>!processed(input,id)):[];
  const url=(frame,variant='current')=>`/api/matting-batches/${batch.id}/frames/${frame}/${variant}`;
  const sourceUrl=(input,frame,thumb=false)=>`/api/jobs/${input.jobId}/frames/${frame.sourceIndex+1}${thumb?'?thumb=true':''}`;

  function controls(){
    const input=current(),remaining=missing(input);
    $('matting-start').disabled=working||!!run||!input;
    $('matting-start').textContent=matches(input)?remaining.length?`补抠 ${remaining.length} 帧 →`:'重新抠图':'批量抠图 →';
    $('matting-cancel').hidden=!run;
    for(const id of ['matting-play','matting-prev','matting-next'])$(id).disabled=!input||!!remaining.length||working||!!run||$('repair-dialog').open;
    onControls();
  }

  function select(id,input=current()){
    active=id;
    for(const card of $('matting-grid').children)card.classList.toggle('is-active',card.dataset.frameId===id);
    const index=input?.frames.findIndex(frame=>frame.id===id)??-1;
    if(!input||index<0){$('matting-image').hidden=true;$('matting-empty').hidden=false;$('matting-frame-label').textContent='—';controls();return;}
    const frame=input.frames[index],done=processed(input,id);
    $('matting-image').src=done?`${url(id)}?revision=${batch.revisions[id]}`:sourceUrl(input,frame);
    $('matting-image').hidden=false;$('matting-empty').hidden=true;
    $('matting-frame-label').textContent=`${index+1} / ${input.frames.length}${done?'':' · 未抠图'}`;
    controls();
  }

  function render(input=current()){
    const fragment=document.createDocumentFragment();
    if(input)input.frames.forEach((frame,index)=>{
      const done=processed(input,frame.id),card=document.createElement('div');
      card.className=`frame matting-card${done?'':' is-pending'}`;card.dataset.frameId=frame.id;
      const button=document.createElement('button');button.type='button';button.className='matting-card-preview';button.setAttribute('aria-label',`查看第${index+1}帧${done?'抠图结果':'原图'}`);
      const image=document.createElement('img');image.src=done?`${url(frame.id,'thumb')}?revision=${batch.revisions[frame.id]}`:sourceUrl(input,frame,true);
      image.alt=`第${index+1}帧`;image.loading='lazy';
      const info=document.createElement('div');info.className='frame-info';info.textContent=String(index+1).padStart(3,'0');
      button.append(image,info);button.onclick=()=>{stopPlayback();select(frame.id);};
      button.title=done?'双击精修':'';button.ondblclick=()=>openRepair(frame.id);
      card.append(button);fragment.append(card);
    });
    $('matting-grid').replaceChildren(fragment);
    const completed=input?input.frameIds.length-missing(input).length:0;
    $('matting-meta').textContent=input?`${input.frameIds.length} 帧 · ${completed} 帧已抠`:'尚无帧序列';
    if(!run){
      if(!input)setStatus('等待抽帧结果');
      else if(completed===input.frameIds.length)setStatus('当前序列已全部抠图，可继续整理或精修');
      else setStatus(completed?`当前序列还有 ${input.frameIds.length-completed} 帧未抠图`:'可直接抠图，也可先整理帧');
    }
    select(input?.frameIds.includes(active)?active:input?.frameIds[0]??null,input);
  }

  function sync(){
    const input=current(),key=input?`${input.jobId}:${input.revision}:${input.frameIds.join(',')}`:'none';
    if(key!==lastKey){stopPlayback();lastKey=key;render(input);}
  }

  function stopPlayback(){cancelAnimationFrame(raf);raf=0;playback=null;setControl($('matting-play'),'play','播放');}
  function tick(){
    if(!playback)return;
    const input=current(),now=performance.now();
    if(!input||missing(input).length){stopPlayback();return;}
    if(playback.ended(now))playback=new FramePlayback(input.frameIds.length,playFPS,now);
    const id=input.frameIds[playback.index(now)];if(id!==active)select(id,input);
    raf=requestAnimationFrame(tick);
  }
  function step(offset){
    stopPlayback();const input=current();if(!input||missing(input).length)return;
    select(input.frameIds[(input.frameIds.indexOf(active)+offset+input.frameIds.length)%input.frameIds.length],input);
  }

  async function start(){
    if(working||run)return;
    let input;
    try{input=snapshot();}catch(reason){error(reason.message);return;}
    const rerun=!missing(input).length;
    if(rerun&&!confirm('重新抠图会建立全新自动结果，当前精修不会自动带入；请先导出保存。继续吗？'))return;
    if(batch&&!matches(input)&&!confirm('素材或处理方式已变化，将建立新结果；旧精修不会自动带入。继续吗？'))return;
    stopPlayback();working=true;error('');setStatus('提交批量任务');controls();
    try{
      await ensureModelRuntime(api,setStatus,value=>{
        const bar=$('model-download-progress');
        bar.hidden=value===undefined;
        if(value?.total)bar.value=Math.min(100,value.downloaded/value.total*100);
        else bar.removeAttribute('value');
      });
      run=await api('/api/matting-batches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:input.sessionId,frameIds:input.frameIds,parentBatchId:matches(input)&&!rerun?batch.id:null})});
      controls();
      while(run){
        const next=await api(`/api/matting-batches/${run.id}`);
        run=next;setStatus(next.stage);
        $('matting-progress').hidden=false;$('matting-progress').value=Math.round(next.completed/next.total*100);
        $('matting-progress-label').textContent=`${next.completed} / ${next.total}`;
        if(next.status==='done'){
          batch=next;active=null;lastKey='';render();setStatus('当前序列已全部抠图，可继续整理或精修');$('matting-scroll').scrollTop=0;break;
        }
        if(next.status==='failed'||next.status==='cancelled'){
          if(next.status==='failed')error(`${next.error||'批量抠图失败'}${next.failedFrameId?' · 帧 '+next.failedFrameId:''}`);
          break;
        }
        await pause(250);
      }
    }catch(reason){error(reason.message);setStatus('未替换之前的完整结果');}
    finally{run=null;working=false;$('matting-progress').hidden=true;controls();}
  }

  async function cancel(){if(!run)return;try{await api(`/api/matting-batches/${run.id}/cancel`,{method:'POST'});setStatus('正在停止');}catch(reason){error(reason.message);}}
  function openRepair(frame){
    const input=current();if(!processed(input,frame)||working||run)return;
    stopPlayback();repairFrame=frame;repairDirty=false;repairBusy=true;closeRequested=false;
    const index=input.frameIds.indexOf(frame);
    $('repair-title').textContent=`精修 · ${String(index+1).padStart(3,'0')}`;
    $('repair-frame').src=`/assets/matting/repair.html?batch=${batch.id}&frame=${frame}&revision=${batch.revisions[frame]}`;
    $('repair-dialog').showModal();
    controls();
  }
  function finishClose(){
    $('repair-dialog').close();$('repair-frame').src='about:blank';repairFrame=null;repairDirty=false;
    closeRequested=false;controls();
  }
  function closeRepair(){
    closeRequested=true;
    $('repair-frame').contentWindow.postMessage({kind:'repair-flush',batch:batch.id,frame:repairFrame},location.origin);
  }
  window.addEventListener('message',event=>{
    const data=event.data;
    if(event.origin!==location.origin||event.source!==$('repair-frame').contentWindow||!batch||data?.batch!==batch.id||data?.frame!==repairFrame)return;
    if(data.kind==='repair-state'){repairDirty=!!data.dirty;repairBusy=!!data.busy;}
    else if(data.kind==='repair-flushed'){if(closeRequested)finishClose();}
    else if(data.kind==='repair-ready')repairBusy=false;
    else if(data.kind==='repair-error'){repairBusy=false;closeRequested=false;error(data.message||'精修加载失败');}
    else if(data.kind==='repair-saved'){
      batch.revisions[repairFrame]=data.revision;batch.modifiedFrameIds=[...new Set([...batch.modifiedFrameIds,repairFrame])];
      $('matting-image').src=`${url(repairFrame)}?revision=${data.revision}`;
      const image=[...$('matting-grid').children].find(card=>card.dataset.frameId===repairFrame)?.querySelector('img');
      if(image)image.src=`${url(repairFrame,'thumb')}?revision=${data.revision}`;
      error('');setStatus(`第 ${current()?.frameIds.indexOf(repairFrame)+1} 帧已同步`);
    }
  });
  $('matting-start').onclick=start;$('matting-cancel').onclick=cancel;
  $('matting-image').ondblclick=()=>{if(active)openRepair(active);};$('matting-image').title='双击精修';
  $('matting-prev').onclick=()=>step(-1);$('matting-next').onclick=()=>step(1);
  $('matting-play').onclick=()=>{
    if(playback){stopPlayback();return;}
    const input=current();if(!input||missing(input).length||working||run||$('repair-dialog').open)return;
    playback=new FramePlayback(input.frameIds.length,playFPS,performance.now(),Math.max(0,input.frameIds.indexOf(active)));
    setControl($('matting-play'),'pause','暂停');tick();
  };
  $('matting-fps').oninput=()=>{const value=Number($('matting-fps').value);if(!Number.isInteger(value)||value<1||value>60)return;playFPS=value;if(playback)playback.setRate(value,performance.now());};
  $('matting-fps').onblur=()=>$('matting-fps').value=playFPS;
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPlayback();});
  $('repair-close').onclick=closeRepair;
  $('repair-dialog').addEventListener('cancel',event=>{event.preventDefault();closeRepair();});
  window.addEventListener('beforeunload',event=>{if(repairDirty){event.preventDefault();event.returnValue='';}});
  return {sync,pause:stopPlayback,
    async exportSource(){
      const input=current();if(!input||missing(input).length)throw new Error('请先完成当前全部保留帧的抠图');
      batch=await api(`/api/matting-batches/${batch.id}`);
      if(!matches(input)||missing(input).length)throw new Error('当前透明序列已变化，请返回帧处理检查');
      return {batchId:batch.id,frameIds:[...input.frameIds],revisions:Object.fromEntries(input.frameIds.map(id=>[id,batch.revisions[id]]))};
    },
    clear(){stopPlayback();batch=null;active=null;lastKey='';render(null);},
    get working(){return working||!!run||$('repair-dialog').open;},get running(){return !!run;}};
}
