import {setControl} from './icons-ui.js';
import {FramePlayback} from './core.js';
import {exportSettings,exportGeometry,previewKey} from './export-core.js';
import {PreviewCache} from './preview-cache.js';
const $=id=>document.getElementById(id);
export function createExport(api,{source,onControls,name=()=>'',onExported=()=>{}}){
  let input=null,analysis=null,sourceKey='',index=0,busy=false,boxMode=false,rawImage=null,clock=null,raf=0,version=0,wanted=null,loading=false;
  const cache=new PreviewCache();
  let pending=Promise.resolve(),settling=false,sheetView=false;
  const canvas=$('export-canvas'),ctx=canvas.getContext('2d');
  let viewMode='fit';
  function pose(){
    const stage=$('export-stage');if(canvas.hidden||!stage.clientWidth||!stage.clientHeight)return;
    // 显示倍率与输出缩放独立；适配只缩小，避免低清输出被二次放大。
    const scale=viewMode==='native'?1:Math.min(1,stage.clientWidth/canvas.width,stage.clientHeight/canvas.height);
    canvas.style.width=`${canvas.width*scale}px`;canvas.style.height=`${canvas.height*scale}px`;
    stage.classList.toggle('native-overflow',canvas.width*scale>stage.clientWidth||canvas.height*scale>stage.clientHeight);
    $('export-zoom-label').textContent=`${Math.round(scale*100)}%`;
    $('export-zoom-label').title='1个图片像素对应1个CSS像素时为100%';
    $('export-fit').setAttribute('aria-pressed',String(viewMode==='fit'));
    $('export-100').setAttribute('aria-pressed',String(viewMode==='native'));
  }
  const error=text=>$('export-error').textContent=text||'';
  function stop(){clock=null;cancelAnimationFrame(raf);setControl($('export-play'),'play','播放');}
  function clearCache(){version++;cache.clear();wanted=null;}
  function crop(){return $('export-crop-enabled').checked?['x','y','cw','ch'].map(id=>Number($(`export-${id}`).value)):[0,0,analysis.canvas.width,analysis.canvas.height];}
  function settings(){
    if(!input||!analysis)throw new Error('请先完成当前序列抠图');
    return exportSettings(input,analysis,{crop:crop(),size:$('export-size').value,width:Number($('export-width').value),height:Number($('export-height').value),fps:Number($('export-fps').value),columns:Number($('export-columns').value),format:$('export-format').value,name:$('export-name').value,filter:$('export-filter').value,upscale:$('export-upscale').checked});
  }
  function controls(){
    let valid=!!analysis;
    try{
      const s=settings(),count=input.frameIds.length,{cols,rows,scale}=exportGeometry(s,count);
      $('export-summary').textContent=`${count} 帧 · 单帧 ${s.width} × ${s.height}${s.format==='sheet'?` · 图集 ${cols} × ${rows} · ${s.width*cols} × ${s.height*rows}`:''}`;
      const b=analysis.bounds,c=s.crop;
      $('export-geometry').textContent=`画布 ${s.width} × ${s.height} · 缩放 ${Math.round(scale*1000)/10}%`;
      $('export-crop-warning').textContent=b&&(c[0]>b[0]||c[1]>b[1]||c[0]+c[2]<b[2]||c[1]+c[3]<b[3])?'裁剪框可能截断部分主体':'';
    }catch(reason){valid=false;$('export-summary').textContent=reason.message;}
    // 每个控件一次计算最终状态，换帧不先启用再禁用，也不传播预览加载状态。
    for(const element of $('export-workspace').querySelectorAll('input,select,button')){
      let disabled=busy||!analysis;
      if(element.id==='export-download')disabled=busy||!valid;
      else if(['export-play','export-prev','export-next'].includes(element.id))disabled=busy||!valid||boxMode||sheetView;
      else if(['export-x','export-y','export-cw','export-ch'].includes(element.id))disabled ||= !$('export-crop-enabled').checked;
      else if(['export-width','export-height'].includes(element.id))disabled ||= $('export-size').value!=='custom';
      if(element.disabled!==disabled)element.disabled=disabled;
    }
    $('export-columns-label').hidden=$('export-format').value!=='sheet';
    $('export-custom-size').hidden=$('export-size').value!=='custom';
    $('export-sheet-view').hidden=$('export-format').value!=='sheet';
    $('export-sheet-view').textContent=sheetView?'查看动作':'查看图集';
    $('export-sheet-view').setAttribute('aria-pressed',String(sheetView));
    $('export-position').textContent=sheetView?'整张图集':input?`${index+1} / ${input.frameIds.length}`:'—';onControls();
  }
  function autoCrop(){
    const a=analysis,b=a.bounds||[0,0,a.canvas.width,a.canvas.height],p=Number($('export-padding').value);
    if(!Number.isInteger(p)||p<0||p>512)throw new Error('边距须为0–512像素');
    const x=Math.max(0,b[0]-p),y=Math.max(0,b[1]-p),r=Math.min(a.canvas.width,b[2]+p),bottom=Math.min(a.canvas.height,b[3]+p);
    [x,y,r-x,bottom-y].forEach((v,i)=>$(`export-${['x','y','cw','ch'][i]}`).value=v);
  }
  function draw(image){
    canvas.style.imageRendering=$('export-filter').value==='pixel'&&!boxMode?'pixelated':'auto';
    canvas.width=image.width;canvas.height=image.height;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0);
    if(boxMode){const c=crop();ctx.strokeStyle='#236b56';ctx.lineWidth=Math.max(2,canvas.width/400);ctx.setLineDash([canvas.width/100,canvas.width/200]);ctx.strokeRect(...c);}
    canvas.hidden=false;$('export-empty').hidden=true;pose();controls();
  }
  async function imageFrom(blob){const image=new Image(),url=URL.createObjectURL(blob);try{image.src=url;await image.decode();return image;}finally{URL.revokeObjectURL(url);}}
  async function drain(){
    if(loading)return;loading=true;
    while(wanted){
      const request=wanted;wanted=null;
      try{
        let image=cache.get(request.key);
        if(!image){
          const response=await fetch(request.raw?`/api/matting-batches/${input.batchId}/frames/${input.frameIds[request.index]}/current`: '/api/export/preview',request.raw?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request.settings,index:request.index,view:request.sheet?'sheet':'frame'})});
          if(!response.ok){const problem=await response.json();throw new Error(problem.detail||'预览失败');}
          image=await imageFrom(await response.blob());
          if(request.version!==version)continue;
          cache.set(request.key,image);
        }
        if(request.version===version&&request.index===index){if(request.raw)rawImage=image;draw(image);error('');}
      }catch(reason){if(request.version===version){stop();error(reason.message);canvas.hidden=true;$('export-empty').hidden=false;$('export-empty').textContent='预览失败，请检查设置';}}
    }
    loading=false;settling=false;controls();
  }
  function render(){
    try{const s=settings();wanted={settings:s,index,key:previewKey(s,sheetView?0:index,boxMode?'raw':sheetView?'sheet':'frame'),raw:boxMode,sheet:sheetView,version};if(!loading)pending=drain();}catch(reason){stop();error(reason.message);controls();}
  }
  function changed(){stop();if($('export-format').value!=='sheet')sheetView=false;version++;wanted=null;error('');controls();render();}
  function defaults(){
    viewMode='fit';
    $('export-crop-enabled').checked=false;$('export-size').value='original';$('export-padding').value=8;$('export-upscale').checked=false;
    $('export-filter').value='smooth';$('export-format').value='sequence';$('export-columns').value=4;$('export-fps').value=12;lastFPS=12;
    $('export-name').value=(name().replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,80)||'animation');
    boxMode=false;sheetView=false;$('export-preview-title').textContent='输出预览';$('export-box-mode').textContent='框选裁剪';$('export-advanced').open=false;
  }
  async function open(){
    stop();error('');busy=true;controls();
    try{
      await pending;
      const next=await source(),key=JSON.stringify(next);
      if(key!==sourceKey){
        busy=true;controls();const nextAnalysis=await api('/api/export/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)});
        if(nextAnalysis.exportVersion!==6)throw new Error('导出功能已升级，请重启动作工坊服务后使用');
        const newBatch=input?.batchId!==next.batchId;
        input=next;analysis=nextAnalysis;sourceKey=key;index=0;boxMode=false;clearCache();
        if(newBatch)defaults();
        if(newBatch)autoCrop();$('export-status').textContent='当前透明序列';
      }
      render();
    }catch(reason){input=null;analysis=null;sourceKey='';clearCache();canvas.hidden=true;$('export-empty').hidden=false;$('export-empty').textContent=reason.message;error(reason.message);}
    finally{busy=false;controls();}
  }
  for(const id of ['crop-enabled','x','y','cw','ch','width','height','upscale','filter','format','columns','name'])$(`export-${id}`).addEventListener('change',changed);
  $('export-size').onchange=()=>{const value=$('export-size').value;if(/^\d+$/.test(value)){$('export-width').value=value;$('export-height').value=value;}changed();};
  $('export-padding').onchange=()=>{try{autoCrop();changed();}catch(reason){error(reason.message);controls();}};
  $('export-auto').onclick=()=>{$('export-crop-enabled').checked=true;autoCrop();changed();};
  $('export-reset').onclick=()=>{defaults();autoCrop();changed();};
  $('export-fit').onclick=()=>{viewMode='fit';pose();};
  $('export-100').onclick=()=>{viewMode='native';pose();};
  $('export-sheet-view').onclick=()=>{stop();sheetView=!sheetView;boxMode=false;$('export-preview-title').textContent='输出预览';$('export-box-mode').textContent='框选裁剪';clearCache();controls();render();};
  window.addEventListener('resize',pose);
  $('export-box-mode').onclick=()=>{stop();sheetView=false;boxMode=!boxMode;$('export-crop-enabled').checked=true;$('export-preview-title').textContent=boxMode?'框选整组裁剪范围':'输出预览';$('export-box-mode').textContent=boxMode?'查看输出':'框选裁剪';changed();};
  let start=null;
  const point=event=>{const r=canvas.getBoundingClientRect(),scale=Math.min(r.width/canvas.width,r.height/canvas.height),left=r.left+(r.width-canvas.width*scale)/2,top=r.top+(r.height-canvas.height*scale)/2;return [Math.max(0,Math.min(canvas.width,Math.round((event.clientX-left)/scale))),Math.max(0,Math.min(canvas.height,Math.round((event.clientY-top)/scale)))];};
  canvas.onpointerdown=event=>{if(!boxMode||busy)return;start=point(event);canvas.setPointerCapture(event.pointerId);};
  canvas.onpointermove=event=>{if(!start||!rawImage)return;const p=point(event),c=[Math.min(start[0],p[0]),Math.min(start[1],p[1]),Math.max(1,Math.abs(p[0]-start[0])),Math.max(1,Math.abs(p[1]-start[1]))];c.forEach((v,i)=>$(`export-${['x','y','cw','ch'][i]}`).value=v);draw(rawImage);};
  canvas.onpointerup=()=>{if(start){start=null;changed();}};canvas.onpointercancel=()=>start=null;
  const step=delta=>{stop();index=(index+delta+input.frameIds.length)%input.frameIds.length;render();};
  $('export-prev').onclick=()=>step(-1);$('export-next').onclick=()=>step(1);
  function tick(){if(!clock)return;const frame=Math.floor(clock.position(performance.now()))%input.frameIds.length;if(frame!==index){index=frame;render();}raf=requestAnimationFrame(tick);}
  $('export-play').onclick=()=>{if(clock){stop();return;}const fps=Number($('export-fps').value);if(!Number.isInteger(fps)||fps<1||fps>60)return error('播放速度须为1–60帧/秒');clock=new FramePlayback(input.frameIds.length,fps,performance.now(),index);setControl($('export-play'),'pause','暂停');tick();};
  let lastFPS=12;
  $('export-fps').onchange=()=>{const fps=Number($('export-fps').value);if(!Number.isInteger(fps)||fps<1||fps>60){$('export-fps').value=lastFPS;return;}lastFPS=fps;clock?.setRate(fps,performance.now());controls();};
  $('export-download').onclick=async()=>{
    stop();busy=true;wanted=null;error('');controls();$('export-status').textContent='处理与校验中';
    try{
      // 先等待在途预览释放服务端忙锁，不能让导出与预览争抢。
      await pending;
      const s=settings(),response=await fetch('/api/export/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(s)});
      if(!response.ok){const problem=await response.json();throw new Error(problem.detail||'导出失败');}
      const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=s.name+'.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);onExported();$('export-status').textContent='导出完成';
    }catch(reason){error(reason.message);$('export-status').textContent='导出失败，源帧保持不变';}finally{busy=false;controls();}
  };
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
  for(const [id,name,label] of [['export-prev','chevron-left'],['export-next','chevron-right'],['export-play','play','播放'],['export-download','download','导出'],['export-reset','rotate-ccw','重置参数']])setControl($(id),name,label);
  return {open,pause(){stop();version++;wanted=null;settling=loading;controls();return pending;},
    clear(){stop();clearCache();input=null;analysis=null;sourceKey='';rawImage=null;canvas.width=1;canvas.height=1;canvas.hidden=true;$('export-empty').hidden=false;$('export-zoom-label').textContent='—';viewMode='fit';},
    get working(){return busy||settling;}};
}
