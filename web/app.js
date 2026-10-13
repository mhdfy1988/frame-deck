import {expectedCount, formatTime, FramePlayback} from './core.js';
import {createOrganizer} from './organizer-ui.js';
import {createMatting} from './matting-ui.js';
import {createExport} from './export-ui.js';
import {decorateIcons,setControl} from './icons-ui.js';
decorateIcons();
const $ = id => document.getElementById(id);
const exportTab=document.createElement('button');exportTab.id='tab-export';exportTab.className='step-button';exportTab.setAttribute('role','tab');exportTab.setAttribute('aria-controls','export-workspace');exportTab.setAttribute('aria-selected','false');exportTab.tabIndex=-1;exportTab.disabled=true;setControl(exportTab,'download','导出');$('workflow-steps').append(exportTab);
const state = {stage:'extract',video:null, job:null, result:null, busy:false, importing:false, handingOff:false, identity:0, index:0, zoom:1, panX:0, panY:0, playing:false, playback:null, playFPS:12, raf:0};
const showError = message => $('error').textContent = message || '';
const organizer = createOrganizer(api,{onActivate:()=>setStage('organize'),onControls:()=>{updateNavigation();matting.sync();}});
const matting = createMatting(api,{snapshot:()=>organizer.snapshot(),onControls:updateNavigation});
const exportUI=createExport(api,{source:()=>matting.exportSource(),onControls:updateNavigation,name:()=>organizer.name||state.video?.name||'',onExported:()=>organizer.markExported()});
updateNavigation();
function updateNavigation(){
  const locked=state.busy || state.handingOff || organizer.working || matting.working || exportUI.working;
  $('tab-extract').disabled=locked;
  $('organize').disabled=locked || !state.result;
  $('tab-matting').disabled=locked || !organizer.ready;
  $('process-organize').disabled=locked || !organizer.ready;
  $('open').disabled=locked;
  $('tab-export').disabled=locked||!organizer.ready;
  $('extract-complete').hidden=!state.result || state.result.videoId!==state.video?.id;
  const stale=state.result && organizer.jobId && organizer.jobId!==state.result.id;
  $('organize').classList.toggle('needs-update',!!stale);
  $('organize').title=stale?'有新抽帧结果；切换后确认是否替换当前帧序列':'处理当前帧序列';
  if(organizer.ready&&!organizer.working){
    const current=organizer.snapshot();
    $('process-source').textContent=`当前帧序列 · ${current.frameIds.length} 帧`;
  }
}
function setStage(stage){
  if(stage===state.stage)return;
  closeViewer();$('video').pause();organizer.pause();matting.pause();
  const previewFinished=exportUI.pause();
  // 用户切换时才等待在途预览，换帧本身不锁侧栏；新工作区不能抢先写入。
  if(exportUI.working)return previewFinished.then(()=>setStage(stage));
  state.stage=stage;
  $('process-mode').hidden=stage==='extract'||stage==='export';
  $('export-workspace').hidden=stage!=='export';
  $('extract-workspace').hidden=stage!=='extract';$('organizer-workspace').hidden=stage!=='organize';$('matting-workspace').hidden=stage!=='matting';
  for(const [id,active] of [['tab-extract',stage==='extract'],['organize',stage==='organize'||stage==='matting'],['tab-export',stage==='export']]){
    $(id).setAttribute('aria-selected',String(active));$(id).tabIndex=active?0:-1;
  }
  $('process-organize').setAttribute('aria-pressed',String(stage==='organize'));
  $('tab-matting').setAttribute('aria-pressed',String(stage==='matting'));
  updateNavigation();
}
async function api(url, options) {
  const response = await fetch(url,options);
  if (!response.ok) {
    const body = await response.json().catch(()=>({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : '请求参数不正确，请检查输入');
  }
  return response.json();
}
function controls() {
  $('open').disabled = state.busy || state.handingOff || organizer.working;
  $('empty').disabled = state.busy || state.handingOff;
  for (const id of ['start','end','fps','range-start','range-end']) $(id).disabled = !state.video || state.importing || state.handingOff;
  $('extract').disabled = !state.video || state.busy || state.handingOff || expectedCount(Number($('start').value),Number($('end').value),Number($('fps').value))===0;
  $('cancel').hidden = !state.job || !state.busy;
  $('cancel').disabled = state.job?.status === 'cancelling';
  $('progress').hidden = !state.job || !state.busy;
  $('play').disabled = !state.result;
  updateNavigation();
}
function updateRange(fromRange = false, changed = '') {
  if (!state.video) return;
  if (fromRange) {
    let start = Number($('range-start').value), end = Number($('range-end').value);
    if (start >= end) {
      if (changed === 'range-start') start = Math.max(0,end - .001);
      else end = Math.min(state.video.duration,start + .001);
    }
    $('start').value = start.toFixed(3); $('end').value = end.toFixed(3);
  } else {
    $('range-start').value = $('start').value; $('range-end').value = $('end').value;
  }
  const start = Number($('start').value), end = Number($('end').value), fps = Number($('fps').value);
  $('range-fill').style.left = `${start / state.video.duration * 100}%`;
  $('range-fill').style.right = `${100 - end / state.video.duration * 100}%`;
  const count = expectedCount(start,end,fps);
  $('estimate').textContent = `预计 ${count || '—'} 帧`;
  if (changed.startsWith('range-') && !state.busy && Number.isFinite(start)) $('video').currentTime = changed==='range-end'? Math.min(end,state.video.duration-.001):start;
  controls();
}
async function importFile(file) {
  if (!file || state.busy || state.handingOff || organizer.working || matting.working) return;
  if (!/\.(mp4|mov|webm)$/i.test(file.name)) return showError('请选择 MP4、MOV 或 WebM 视频');
  if (file.size > 256*1024**2) return showError('视频超过256MiB，请先压缩或裁剪');
  setStage('extract');closeViewer();
  const identity = ++state.identity;
  state.busy=true;state.importing=true;state.job=null;showError('');stopPlayback();
  $('importing').hidden=false;$('status').textContent='导入与探测中';controls();
  try {
    const video = await api('/api/videos',{method:'POST',headers:{'X-File-Name':encodeURIComponent(file.name),'Content-Type':'application/octet-stream'},body:file});
    if (identity!==state.identity) return;
    state.video=video;
    $('video').src=video.url;$('video').hidden=false;$('empty').hidden=true;$('dropzone').classList.add('has-video');
    $('filename').textContent=video.name;
    $('open').textContent='换视频';
    $('metadata').textContent=`${video.width} × ${video.height} · ${video.fps.toFixed(2)} fps${video.variableFrameRate?' VFR':''} · ${formatTime(video.duration)}`;
    for(const id of ['range-start','range-end']) $(id).max=String(video.duration);
    $('start').value='0';$('end').value=String(video.duration);
    $('status').textContent='已导入';
    // 不覆盖旧完整结果，导入新视频后明确标识旧结果归属。
    if(state.result) { $('result-note').hidden=false;$('result-note').textContent='仍为上一视频的完整结果，新任务完成后替换。'; }
  } catch(error) { showError(error.message);$('status').textContent=state.video?'保留原视频':'导入失败'; }
  finally { if(identity===state.identity){state.busy=false;state.importing=false;$('importing').hidden=true;updateRange();controls();} }
}
async function extract() {
  if (!state.video || state.busy || state.handingOff || organizer.working || matting.working) return;
  closeViewer();const identity=++state.identity;
  const extractionRequest={videoId:state.video.id,start:Number($('start').value),end:Number($('end').value),fps:Number($('fps').value)};
  state.busy=true;state.job=null;showError('');stopPlayback();controls();$('status').textContent='提交任务';
  try {
    await api('/api/workspace/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:organizer.sessionId})});
    state.result=null;organizer.clear();matting.clear();exportUI.clear();
    $('grid').replaceChildren();$('grid').hidden=true;$('result-empty').hidden=false;
    $('result-meta').textContent='尚未提取';$('result-note').hidden=true;
    controls();
    state.job=await api('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(extractionRequest)});
    controls();
    while(identity===state.identity){
      const job=await api(`/api/jobs/${state.job.id}`);
      if(identity!==state.identity) return;
      state.job=job;$('status').textContent=job.stage;$('progress').value=job.progress;controls();
      if(job.status==='done'){
        state.result=job;renderResults();break;
      }
      if(job.status==='cancelled') break;
      if(job.status==='failed') throw new Error(job.error || '提取失败');
      await new Promise(resolve=>setTimeout(resolve,180));
    }
  } catch(error){showError(error.message);$('status').textContent=state.result?'保留原结果':'抽帧未完成，可重新提取';}
  finally {if(identity===state.identity){state.busy=false;controls();}}
}
async function cancel() {
  if(!state.job || !state.busy) return;
  $('cancel').disabled=true;
  try {state.job=await api(`/api/jobs/${state.job.id}/cancel`,{method:'POST'});controls();}
  catch(error){showError(error.message);$('cancel').disabled=false;}
}
function renderResults() {
  const {sequence,duplicateCount,request}=state.result;
  $('result-empty').hidden=true;$('grid').hidden=false;
  $('result-meta').textContent=`${sequence.frames.length} 帧 · ${sequence.canvas.width} × ${sequence.canvas.height} · ${request.fps} fps`;
  $('result-note').hidden=!duplicateCount;
  $('result-note').textContent=duplicateCount?`${duplicateCount} 帧重复采样自同一源画面，未补帧或去重。`:'';
  renderFrames();$('frames-scroll').scrollTop=0;
}
function frameURL(index,thumb=false) {return `/api/jobs/${state.result.id}/frames/${index+1}${thumb?'?thumb=true':''}`;}
function renderFrames() {
  if(!state.result) return;
  const frames=state.result.sequence.frames;
  const fragment=document.createDocumentFragment();
  // 服务端最多600帧；全部按顺序保留，原生懒加载只影响缩略图请求。
  frames.forEach((frame,index)=>{
    const button=document.createElement('button');button.className='frame';button.setAttribute('aria-label',`查看第${index+1}帧`);
    const image=document.createElement('img');image.src=frameURL(index,true);image.alt=`第${index+1}帧`;image.loading='lazy';image.decoding='async';
    const info=document.createElement('div');info.className='frame-info';
    const number=document.createElement('span');number.textContent=String(index+1).padStart(3,'0');
    info.append(number);button.append(image,info);button.addEventListener('click',()=>openViewer(index));fragment.append(button);
  });
  $('grid').replaceChildren(fragment);
}
function positionImage() {$('full-image').style.transform=`translate(calc(-50% + ${state.panX}px),calc(-50% + ${state.panY}px)) scale(${state.zoom})`;$('zoom-label').textContent=`${Math.round(state.zoom*100)}%`;}
function fit() {const {width,height}=state.result.sequence.canvas;state.zoom=Math.min(($('viewport').clientWidth-32)/width,($('viewport').clientHeight-32)/height,1);state.panX=state.panY=0;positionImage();}
function showFrame(index) {
  const frames=state.result.sequence.frames;state.index=Math.max(0,Math.min(index,frames.length-1));
  $('full-image').src=frameURL(state.index);
  $('full-image').width=state.result.sequence.canvas.width;$('full-image').height=state.result.sequence.canvas.height;
  $('viewer-title').textContent=`第 ${state.index+1} / ${frames.length} 帧`;
}
function openViewer(index) {
  if(!state.result || state.stage!=='extract')return;
  stopPlayback();$('video').pause();showFrame(index);
  if(!$('viewer').open)$('viewer').showModal();
  fit();
}
function closeViewer(){
  stopPlayback();if($('viewer').open)$('viewer').close();
}
function stopPlayback() {state.playing=false;state.playback=null;cancelAnimationFrame(state.raf);setControl($('viewer-play'),'play','播放');}
function togglePlayback() {
  if(state.playing)return stopPlayback();
  state.playing=true;state.playback=new FramePlayback(state.result.sequence.frames.length,state.playFPS,performance.now(),state.index);setControl($('viewer-play'),'pause','暂停');
  function tick(){if(!state.playing)return;const now=performance.now();if(state.playback.ended(now)){showFrame(0);stopPlayback();return;}const index=state.playback.index(now);if(index!==state.index)showFrame(index);state.raf=requestAnimationFrame(tick);}state.raf=requestAnimationFrame(tick);
}
$('open').onclick=()=>$('file').click();$('empty').onclick=()=>$('file').click();$('file').onchange=event=>{importFile(event.target.files[0]);event.target.value='';};
for(const id of ['start','end','fps']) $(id).addEventListener('input',()=>updateRange());
for(const id of ['range-start','range-end']) $(id).addEventListener('input',()=>updateRange(true,id));
$('extract').onclick=extract;$('cancel').onclick=cancel;
$('organize').onclick=async()=>{
  if(!state.result || state.busy || state.handingOff || matting.working)return;
  state.handingOff=true;controls();stopPlayback();$('video').pause();
  try{await organizer.open(state.result);}catch(error){showError(error.message);}
  finally{state.handingOff=false;controls();}
};
$('tab-extract').onclick=()=>{if(!state.busy && !state.handingOff && !organizer.working && !matting.working)setStage('extract');};
$('process-organize').onclick=()=>{if(!state.busy&&!state.handingOff&&!matting.working&&organizer.ready)setStage('organize');};
$('tab-matting').onclick=()=>{if(!state.busy&&!state.handingOff&&!organizer.working&&organizer.ready){matting.sync();setStage('matting');}};
$('tab-export').onclick=async()=>{if(state.busy||state.handingOff||organizer.working||matting.working||exportUI.working)return;setStage('export');await exportUI.open();};
// 手动激活：方向键只移动焦点，Enter/Space才切换，避免异步交接抢焦点。
$('workflow-steps').addEventListener('keydown',event=>{
  const vertical=matchMedia('(min-width:701px)').matches;
  const forwards=vertical?'ArrowDown':'ArrowRight',backwards=vertical?'ArrowUp':'ArrowLeft';
  if(![forwards,backwards,'Home','End'].includes(event.key))return;
  const buttons=[...$('workflow-steps').querySelectorAll('[role=tab]')].filter(button=>!button.disabled);
  const index=buttons.indexOf(document.activeElement);if(index<0)return;event.preventDefault();
  const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key===forwards?1:-1)+buttons.length)%buttons.length;
  buttons[next].focus();
});
const orientation=()=>{$('workflow-steps').setAttribute('aria-orientation',matchMedia('(min-width:701px)').matches?'vertical':'horizontal');};orientation();
for(const event of ['dragenter','dragover'])$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.add('dragging');});
for(const event of ['dragleave','drop'])$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.remove('dragging');if(event==='drop')importFile(e.dataTransfer.files[0]);});
$('play').onclick=()=>{openViewer(0);togglePlayback();};$('viewer-play').onclick=togglePlayback;
$('viewer-play-fps').oninput=()=>{const input=$('viewer-play-fps');if(!input.validity.valid || !input.value)return;state.playFPS=input.valueAsNumber;state.playback?.setRate(state.playFPS,performance.now());};
$('viewer-play-fps').onblur=()=>{$('viewer-play-fps').value=state.playFPS;};
$('close-viewer').onclick=closeViewer;
$('viewer').addEventListener('cancel',event=>{event.preventDefault();closeViewer();});
$('viewer').addEventListener('close',()=>{stopPlayback();drag=null;});
$('previous').onclick=()=>{stopPlayback();showFrame(state.index-1);};$('next').onclick=()=>{stopPlayback();showFrame(state.index+1);};
$('zoom-fit').onclick=fit;$('zoom-100').onclick=()=>{state.zoom=1;state.panX=state.panY=0;positionImage();};
function zoom(multiplier){state.zoom=Math.max(.05,Math.min(8,state.zoom*multiplier));positionImage();}
$('zoom-in').onclick=()=>zoom(1.25);$('zoom-out').onclick=()=>zoom(.8);
$('viewport').addEventListener('wheel',event=>{event.preventDefault();zoom(event.deltaY<0?1.12:1/1.12);},{passive:false});
let drag=null;$('viewport').addEventListener('pointerdown',event=>{drag={x:event.clientX,y:event.clientY,panX:state.panX,panY:state.panY};$('viewport').setPointerCapture(event.pointerId);});
$('viewport').addEventListener('pointermove',event=>{if(drag){state.panX=drag.panX+event.clientX-drag.x;state.panY=drag.panY+event.clientY-drag.y;positionImage();}});
for(const name of ['pointerup','pointercancel'])$('viewport').addEventListener(name,()=>drag=null);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPlayback();});
window.addEventListener('resize',()=>{orientation();if($('viewer').open)fit();});
$('video').addEventListener('error',()=>showError('Chrome不支持此视频预览；可尝试抽帧，或将视频转换为H.264 MP4。正式输出不使用浏览器截图。'));
api('/api/health').then(health=>{if(!health.ok)showError('缺少FFmpeg/ffprobe，请先完成本机安装');}).catch(error=>showError(error.message));
