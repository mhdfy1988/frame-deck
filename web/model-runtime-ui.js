// 仅在用户首次启用抠图时安装；不在打开页面时下载大型模型。
export async function ensureModelRuntime(api, status, progress=()=>{}){
  let state=await api('/api/model-runtime');
  if(state.ready)return;
  status('首次抠图：正在安装独立环境和模型，可能下载数GB');
  await api('/api/model-runtime/install',{method:'POST'});
  try{for(;;){
    await new Promise(resolve=>setTimeout(resolve,1000));
    state=await api('/api/model-runtime');
    progress(state.progress||null);
    const file=state.progress;
    const mb=value=>(value/1024**2).toFixed(1)+' MB';
    status(file ? `${file.file} · ${mb(file.downloaded)}${file.total?' / '+mb(file.total)+' · '+Math.min(100,Math.floor(file.downloaded/file.total*100))+'%':''}` : state.stage);
    if(state.ready)return;
    if(state.phase==='failed')throw new Error(state.error||'抠图环境安装失败，请重试');
  }}finally{progress(undefined);}
}
