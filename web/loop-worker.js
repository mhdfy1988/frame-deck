import {ANALYSIS_SIZE,screenColor,describeFrame,findLoopCandidates} from './loop-core.js';

// 单个工作线程，缩略图顺序解码并立即释放；关闭弹窗会terminate，不占主界面计算线程。
self.onmessage=async({data})=>{
  try{
    // 旧页使用受限本机URL，新工作流显式传入浏览器持久化的PNG；两种入口不互相回退。
    const blobs=Array.isArray(data.blobs)?data.blobs:null,urls=Array.isArray(data.urls)?data.urls:null;
    if(!!blobs===!!urls)throw new Error('循环分析必须指定唯一帧来源');
    const count=(blobs||urls).length;
    if(count>600 || count<7)throw new Error('至少需要7帧，最多600帧');
    if(blobs&&blobs.some(blob=>!(blob instanceof Blob)||!blob.size||blob.type!=='image/png'))throw new Error('分析只接受PNG帧');
    const started=performance.now(),check=()=>{if(performance.now()-started>45000)throw new Error('循环分析超过45秒，请减少帧数后重试');};
    const canvas=new OffscreenCanvas(ANALYSIS_SIZE,ANALYSIS_SIZE),context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)throw new Error('浏览器不支持离屏分析，请使用新版Chrome');
    const features=[];let background=null;
    for(let index=0;index<count;index++){
      check();let blob=blobs?.[index];
      if(urls){const url=new URL(urls[index],self.location.origin);
        if(url.origin!==self.location.origin || !/^\/api\/jobs\/[^/]+\/frames\/\d+$/.test(url.pathname))throw new Error('分析只接受本机源帧');
        const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error('源帧读取失败，请重新交接抽帧结果');blob=await response.blob();}
      const bitmap=await createImageBitmap(blob,{resizeWidth:ANALYSIS_SIZE,resizeHeight:ANALYSIS_SIZE});
      try{context.clearRect(0,0,ANALYSIS_SIZE,ANALYSIS_SIZE);context.drawImage(bitmap,0,0,ANALYSIS_SIZE,ANALYSIS_SIZE);}finally{bitmap.close();}
      const rgba=context.getImageData(0,0,ANALYSIS_SIZE,ANALYSIS_SIZE).data;
      if(index===0)background=screenColor(rgba);
      features.push(describeFrame(rgba,background));
      self.postMessage({type:'progress',message:`分析帧 ${index+1} / ${count}`});
    }
    const candidates=findLoopCandidates(features,{check,progress:value=>self.postMessage({type:'progress',message:`比较动作 ${Math.round(value*100)}%`})});
    self.postMessage({type:'result',candidates,greenScreen:!!background});
  }catch(reason){self.postMessage({type:'error',message:reason.message || '循环分析失败'});}
};
