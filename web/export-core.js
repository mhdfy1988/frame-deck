// 导出参数与几何只依赖值；DOM、网络和播放状态留在export-ui。
export function exportSettings(input, analysis, values){
  if(!input||!analysis)throw new Error('请先完成当前序列抠图');
  const c=values.crop;
  const ratio={original:1,half:.5,quarter:.25,eighth:.125}[values.size];
  const width=ratio?Math.max(1,Math.round(c[2]*ratio)):values.width;
  const height=ratio?Math.max(1,Math.round(c[3]*ratio)):values.height;
  if(!c.every(Number.isInteger)||c[0]<0||c[1]<0||c[2]<1||c[3]<1||c[0]+c[2]>analysis.canvas.width||c[1]+c[3]>analysis.canvas.height)throw new Error('裁剪范围必须在原画布内');
  if(![width,height].every(v=>Number.isInteger(v)&&v>0&&v<=8192)||width*height>16_000_000)throw new Error('请设置有效尺寸（最多1600万像素）');
  const {format,columns,fps,filter,upscale}=values;
  if(!Number.isInteger(columns)||columns<1||columns>600)throw new Error('列数须为1–600');
  const cols=Math.min(columns,input.frameIds.length),rows=Math.ceil(input.frameIds.length/cols);
  if(format==='sheet'&&(Math.max(width*cols,height*rows)>8192||width*height*cols*rows>16_000_000))throw new Error('图集太大，请降低尺寸或调整列数');
  if(width*height*input.frameIds.length*4>2*1024**3)throw new Error('序列超过2GiB预算，请降低尺寸');
  const name=values.name.trim();
  if(!name||/[\\/:*?"<>|\x00-\x1f]/.test(name))throw new Error('请使用有效文件名，不含路径或特殊字符');
  if(!Number.isInteger(fps)||fps<1||fps>60)throw new Error('动作帧率须为1–60帧/秒');
  return {...input,crop:c,width,height,fps,upscale,filter,format,columns,name};
}

export function exportGeometry(settings,count){
  const {width,height,crop,columns,upscale}=settings;
  const cols=Math.min(count,columns),rows=Math.ceil(count/cols);
  return {cols,rows,sheetWidth:width*cols,sheetHeight:height*rows,scale:Math.min(width/crop[2],height/crop[3],upscale?Infinity:1)};
}

export function previewKey(settings,index,view='frame'){
  const {batchId,frameIds,revisions,crop,width,height,filter,upscale,columns}=settings;
  // 文件名和动作帧率不影响像素，不让元数据变化重复请求/解码。
  return JSON.stringify({batchId,frameIds,revisions,view,index,...(view==='raw'?{}:{crop,width,height,filter,upscale,...(view==='sheet'?{columns}: {})})});
}
