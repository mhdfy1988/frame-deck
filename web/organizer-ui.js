import {FrameEditor} from './organizer-core.js';
import {FramePlayback} from './core.js';
import {setControl} from './icons-ui.js';
import {createLoopFinder} from './loop-ui.js';
const $=id=>document.getElementById(id);

export function createOrganizer(api,{onActivate,onControls=()=>{}}){
  let session=null,editor=null,working=false,expired=false,playing=false,raf=0,draggedId=null;
  let zoom=1,panX=0,panY=0,pointer=null;
  let playback=null,playFPS=12;
  const error=message=>$('edit-error').textContent=message || '';
  const frameURL=(frame,thumb=false)=>`/api/jobs/${session.jobId}/frames/${frame.sourceIndex+1}${thumb?'?thumb=true':''}`;
  const loopFinder=createLoopFinder({getEditor:()=>editor,frameURL,isLocked:()=>working || expired,apply:mutate});
  function stop(){playing=false;playback=null;cancelAnimationFrame(raf);setControl($('edit-play'),'play','播放');$('edit-play').setAttribute('aria-label','播放勾选帧');}
  function pose(){$('edit-image').style.transform=`translate(calc(-50% + ${panX}px),calc(-50% + ${panY}px)) scale(${zoom})`;$('edit-zoom-label').textContent=`${Math.round(zoom*100)}%`;}
  function fit(){if(!editor)return;const {width,height}=editor.sequence.canvas;zoom=Math.max(.05,Math.min(($('edit-viewport').clientWidth-24)/width,($('edit-viewport').clientHeight-24)/height,1));panX=panY=0;pose();}
  function preview(){
    const index=editor.order.indexOf(editor.active),frame=editor.byId.get(editor.active);
    $('edit-image').hidden=!frame;$('edit-empty').hidden=!!frame;
    if(frame){const url=frameURL(frame);if($('edit-image').getAttribute('src')!==url)$('edit-image').src=url;$('edit-image').width=editor.sequence.canvas.width;$('edit-image').height=editor.sequence.canvas.height;}
    const checked=editor.checkedFrames,position=checked.findIndex(item=>item.id===editor.active);
    const number=checked.length?(position>=0?position+1:'—'):0;
    $('edit-frame-label').textContent=`${number} / ${checked.length}`;
    // 界面仅保留帧身份；来源时间仍在原清单中，不混入图片查看。
    $('edit-frame-label').title=frame?`查看第${index+1} / ${editor.order.length}帧${position<0?' · 未勾选':''}`:'无保留帧';
    pose();
  }
  function controls(){
    if(!editor)return;
    const locked=working || expired;
    for(const id of ['edit-all','edit-none','edit-delete','edit-reset','edit-undo','edit-redo','edit-play','edit-previous','edit-next'])$(id).disabled=locked;
    $('edit-delete').disabled=locked || !editor.selected.size;
    $('edit-undo').disabled=locked || !editor.undoStack.length;$('edit-redo').disabled=locked || !editor.redoStack.length;
    for(const id of ['edit-previous','edit-next'])$(id).disabled=locked || !editor.order.length;
    $('edit-play').disabled=locked || !editor.selected.size;
    $('edit-play-fps').disabled=locked || !editor.order.length;
    $('edit-find-loop').disabled=locked || editor.order.length<7;
    $('edit-find-loop').title=editor.order.length<7?'至少需要7帧':'分析全部保留帧，推荐动作循环区间';
    $('edit-play').title=playing?'暂停播放勾选帧':editor.selected.size?'播放勾选帧':'先勾选要播放的帧';
    $('edit-play').setAttribute('aria-label',playing?'暂停播放勾选帧':'播放勾选帧');
    $('edit-meta').textContent=`保留 ${editor.order.length} 帧${editor.dirty?' · 未导出':''}`;
    $('edit-selection').textContent=`已勾选 ${editor.selected.size} 帧`;
    for(const control of $('edit-grid').querySelectorAll('.frame-check,.frame-delete'))control.disabled=locked;
    onControls();
  }
  function selection(){
    for(const card of $('edit-grid').children){
      const checked=editor.selected.has(card.dataset.frameId),active=card.dataset.frameId===editor.active;
      card.classList.toggle('is-checked',checked);card.classList.toggle('is-active',active);
      card.querySelector('.frame-check').checked=checked;
      card.querySelector('.frame-preview').setAttribute('aria-current',String(active));
    }
    preview();controls();
  }
  function clearDropMarks(){
    for(const card of $('edit-grid').children)card.classList.remove('drop-swap');
    $('edit-scroll').classList.remove('drop-end');
  }
  function endDrag(){draggedId=null;clearDropMarks();for(const card of $('edit-grid').children)card.classList.remove('dragging');}
  function render(){
    const fragment=document.createDocumentFragment();
    editor.frames.forEach((frame,index)=>{
      const card=document.createElement('div');card.className='frame';card.draggable=true;card.dataset.frameId=frame.id;
      const sourceNumber=String(frame.sourceIndex+1).padStart(3,'0');
      const previewButton=document.createElement('button');previewButton.type='button';previewButton.className='frame-preview';previewButton.setAttribute('aria-label',`查看原帧${sourceNumber}`);previewButton.title=`原帧 ${sourceNumber} · 当前位置 ${index+1}；拖到另一帧交换位置`;
      const image=document.createElement('img');image.src=frameURL(frame,true);image.alt=`原帧${sourceNumber}`;image.loading='lazy';image.decoding='async';image.draggable=false;
      const info=document.createElement('div');info.className='frame-info';const number=document.createElement('span');number.textContent=sourceNumber;info.title=`原帧编号 ${sourceNumber}`;info.append(number);previewButton.append(image,info);
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.className='frame-check';checkbox.setAttribute('aria-label',`勾选原帧${sourceNumber}`);checkbox.title='勾选／取消勾选；Shift连续勾选';
      const marker=document.createElement('span');marker.className='frame-check-mark';marker.setAttribute('aria-hidden','true');card.append(previewButton,checkbox,marker);
      const deleteButton=document.createElement('button');deleteButton.type='button';deleteButton.className='frame-delete';deleteButton.draggable=false;deleteButton.title=`删除原帧 ${sourceNumber}`;deleteButton.setAttribute('aria-label',`删除原帧${sourceNumber}`);
      setControl(deleteButton,'trash-2');card.append(deleteButton);
      deleteButton.onclick=event=>{
        event.stopPropagation();
        if(working || expired)return;
        const keyboard=event.detail===0;
        mutate(()=>editor.remove([frame.id]),`已删除原帧 ${sourceNumber}`);
        // 删除后键盘焦点留在邻近卡片，连续操作无需重新遍历整个工具栏。
        if(keyboard){const neighbor=$('edit-grid').children[Math.min(index,editor.order.length-1)];(neighbor?.querySelector('.frame-delete') || $('edit-undo')).focus();}
      };
      previewButton.onclick=()=>{if(working || expired)return;stop();editor.view(frame.id);selection();};
      checkbox.onclick=event=>{event.stopPropagation();if(working || expired)return;stop();editor.select(frame.id,{toggle:!event.shiftKey,range:event.shiftKey});selection();};
      card.addEventListener('dragstart',event=>{
        if(working || expired || event.target.closest('.frame-check,.frame-delete')){event.preventDefault();return;}stop();
        draggedId=frame.id;card.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',frame.id);
      });
      card.addEventListener('dragover',event=>{if(!draggedId || working || expired)return;event.preventDefault();clearDropMarks();if(draggedId!==frame.id)card.classList.add('drop-swap');event.dataTransfer.dropEffect='move';});
      card.addEventListener('dragleave',event=>{if(!card.contains(event.relatedTarget))card.classList.remove('drop-swap');});
      card.addEventListener('drop',event=>{if(!draggedId)return;event.preventDefault();event.stopPropagation();const id=draggedId;endDrag();mutate(()=>editor.swap(id,frame.id),'已交换两帧位置');});
      card.addEventListener('dragend',endDrag);
      fragment.append(card);
    });
    $('edit-grid').replaceChildren(fragment);selection();
  }
  function mutate(action,message){
    if(working || expired)return;stop();error('');
    // 先记录实际位置，再让同一身份的卡片从旧位置移动到新位置（FLIP）。
    const oldRects=new Map([...$('edit-grid').children].map(card=>[card.dataset.frameId,card.getBoundingClientRect()]));
    if(action()){
      render();$('edit-status').textContent=message;
      if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
      const viewport=$('edit-scroll').getBoundingClientRect();
      for(const card of $('edit-grid').children){
        const old=oldRects.get(card.dataset.frameId),next=card.getBoundingClientRect();
        if(!old || (old.left===next.left && old.top===next.top))continue;
        // 600帧时只动画在可见区域附近移动的卡片，不为屏外帧堆动画。
        if((old.bottom<viewport.top || old.top>viewport.bottom) && (next.bottom<viewport.top || next.top>viewport.bottom))continue;
        card.classList.add('frame-moving');
        const motion=card.animate([{transform:`translate(${old.left-next.left}px,${old.top-next.top}px)`},{transform:'translate(0,0)'}],{duration:360,easing:'cubic-bezier(.2,.8,.2,1)'});
        motion.onfinish=motion.oncancel=()=>card.classList.remove('frame-moving');
      }
    }
  }
  function navigate(step){if(!editor || !editor.order.length)return;stop();const index=Math.max(0,Math.min(editor.order.length-1,editor.order.indexOf(editor.active)+step));editor.view(editor.order[index]);selection();$('edit-grid').children[index]?.scrollIntoView({block:'nearest'});}
  function togglePlayback(){
    if(playing){stop();controls();return;}const frames=editor.checkedFrames;if(!frames.length)return;
    playback=new FramePlayback(frames.length,playFPS,performance.now());
    editor.view(frames[0].id);playing=true;setControl($('edit-play'),'pause','暂停');selection();
    function tick(){if(!playing)return;const now=performance.now();
      if(playback.ended(now)){editor.view(frames.at(-1).id);stop();selection();return;}
      const frame=frames[playback.index(now)];if(editor.active!==frame.id){editor.active=frame.id;selection();}raf=requestAnimationFrame(tick);
    }raf=requestAnimationFrame(tick);
  }
  async function renew(){
    const identity=session?.id;if(!identity || working)return;
    try{await api(`/api/edit-sessions/${identity}/heartbeat`,{method:'POST'});}
    catch(reason){if(session?.id===identity){expired=true;loopFinder.close();stop();error('整理会话已失效或服务断开，请返回抽帧重新交接');controls();}}
  }
  async function open(result){
    if(!result || working)return;
    let received=false;
    if(session?.jobId!==result.id || expired){
      if(editor?.dirty && !confirm('整理结果尚未导出，接收新结果会放弃当前编辑，继续吗？'))return;
      const next=await api('/api/edit-sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:result.id})});
      let candidate;try{candidate=new FrameEditor(next.sequence);}catch(reason){await api(`/api/edit-sessions/${next.id}`,{method:'DELETE'});throw reason;}
      const old=session;session=next;editor=candidate;expired=false;error('');
      received=true;
      if(old)api(`/api/edit-sessions/${old.id}`,{method:'DELETE'}).catch(()=>{});
      render();$('edit-scroll').scrollTop=0;$('edit-status').textContent='已接收抽帧结果';
    }else{await api(`/api/edit-sessions/${session.id}/heartbeat`,{method:'POST'});expired=false;error('');}
    onActivate();if(received)fit();else pose();controls();
  }
  $('edit-all').onclick=()=>{stop();editor.selectAll();selection();};$('edit-none').onclick=()=>{stop();editor.clearSelection();selection();};
  $('edit-find-loop').onclick=()=>{stop();controls();loopFinder.open();};
  $('edit-delete').onclick=()=>mutate(()=>editor.remove(),'已删除勾选帧；总时长已更新');
  $('edit-undo').onclick=()=>mutate(()=>editor.undo(),'已撤销');$('edit-redo').onclick=()=>mutate(()=>editor.redo(),'已恢复撤销的操作');
  $('edit-reset').onclick=()=>{if(editor.dirty && !confirm('恢复全部原始帧和顺序？此操作可以撤销。'))return;mutate(()=>editor.reset(),'已重置，可撤销');};
  $('edit-scroll').addEventListener('dragover',event=>{if(!draggedId || working || expired || event.target.closest('.frame'))return;event.preventDefault();clearDropMarks();$('edit-scroll').classList.add('drop-end');event.dataTransfer.dropEffect='move';});
  $('edit-scroll').addEventListener('dragleave',event=>{if(!$('edit-scroll').contains(event.relatedTarget))$('edit-scroll').classList.remove('drop-end');});
  $('edit-scroll').addEventListener('drop',event=>{if(!draggedId)return;event.preventDefault();const id=draggedId;endDrag();mutate(()=>editor.append(id),'已移到末尾');});
  $('edit-previous').onclick=()=>navigate(-1);$('edit-next').onclick=()=>navigate(1);$('edit-play').onclick=togglePlayback;
  $('edit-play-fps').oninput=()=>{const input=$('edit-play-fps');if(!input.validity.valid || !input.value)return;playFPS=input.valueAsNumber;playback?.setRate(playFPS,performance.now());};
  $('edit-play-fps').onblur=()=>{$('edit-play-fps').value=playFPS;};
  $('edit-fit').onclick=fit;$('edit-100').onclick=()=>{zoom=1;panX=panY=0;pose();};
  const scale=factor=>{zoom=Math.max(.05,Math.min(8,zoom*factor));pose();};
  $('edit-zoom-in').onclick=()=>scale(1.25);$('edit-zoom-out').onclick=()=>scale(.8);
  $('edit-viewport').addEventListener('wheel',event=>{event.preventDefault();scale(event.deltaY<0?1.12:1/1.12);},{passive:false});
  $('edit-viewport').addEventListener('pointerdown',event=>{pointer={x:event.clientX,y:event.clientY,panX,panY};$('edit-viewport').setPointerCapture(event.pointerId);});
  $('edit-viewport').addEventListener('pointermove',event=>{if(pointer){panX=pointer.panX+event.clientX-pointer.x;panY=pointer.panY+event.clientY-pointer.y;pose();}});
  for(const event of ['pointerup','pointercancel'])$('edit-viewport').addEventListener(event,()=>pointer=null);
  $('edit-image').addEventListener('error',()=>error('原尺寸帧不可用，请返回抽帧重新交接'));
  document.addEventListener('keydown',event=>{
    const typing=/^(TEXTAREA|SELECT)$/.test(event.target.tagName) || (event.target.tagName==='INPUT' && event.target.type!=='checkbox');
    if($('organizer-workspace').hidden || !editor || working || expired || typing || loopFinder.active || event.target.closest('#workflow-steps'))return;
    const ctrl=event.ctrlKey || event.metaKey,key=event.key.toLowerCase();
    if(ctrl && key==='a'){event.preventDefault();editor.selectAll();selection();}
    else if(ctrl && key==='z'){event.preventDefault();mutate(()=>event.shiftKey?editor.redo():editor.undo(),event.shiftKey?'已恢复撤销的操作':'已撤销');}
    else if(ctrl && key==='y'){event.preventDefault();mutate(()=>editor.redo(),'已恢复撤销的操作');}
    else if(event.key==='Delete'){event.preventDefault();mutate(()=>editor.remove(),'已删除勾选帧；总时长已更新');}
    else if(event.key==='Escape'){editor.clearSelection();selection();}
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else renew();});
  window.addEventListener('resize',()=>{if(!$('organizer-workspace').hidden)fit();});
  window.addEventListener('beforeunload',event=>{if(editor?.dirty){event.preventDefault();event.returnValue='';}});
  window.addEventListener('pagehide',()=>{if(session)fetch(`/api/edit-sessions/${session.id}`,{method:'DELETE',keepalive:true}).catch(()=>{});});
  setInterval(renew,30000);
  return {open,pause:stop,
    markExported(){if(editor){editor.markExported();controls();}},
    clear(){
      stop();loopFinder.close();session=null;editor=null;expired=false;
      $('edit-grid').replaceChildren();$('edit-image').removeAttribute('src');$('edit-image').hidden=true;
      $('edit-empty').hidden=false;error('');onControls();
    },
    get sessionId(){return session?.id??null;},
    snapshot(){
      if(!session||!editor||expired||working||!editor.order.length)throw new Error('当前帧序列不可用，请至少保留一帧');
      return Object.freeze({sessionId:session.id,jobId:session.jobId,revision:editor.revision,frameIds:Object.freeze([...editor.order]),frames:Object.freeze(editor.order.map(id=>Object.freeze({id,sourceIndex:editor.byId.get(id).sourceIndex})))});
    },
    get ready(){return !!session&&!!editor&&!expired&&!!editor.order.length;},
    get working(){return working;},get jobId(){return session?.jobId;},get name(){return editor?.sequence.source?.name || editor?.sequence.name;}};
}
