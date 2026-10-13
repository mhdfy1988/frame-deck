// 循环检测领域：固定画布特征、重复动作邻域及接缝；不编辑像素或来源时间。
export const ANALYSIS_SIZE=24;
const clamp=value=>Math.max(0,Math.min(1,value));

export function screenColor(rgba,size=ANALYSIS_SIZE){
  const samples=[];
  for(let x=0;x<size;x++)for(const y of [0,size-1])samples.push((y*size+x)*4);
  for(let y=1;y<size-1;y++)for(const x of [0,size-1])samples.push((y*size+x)*4);
  const green=samples.filter(p=>rgba[p+1]>100 && rgba[p+1]-Math.max(rgba[p],rgba[p+2])>65);
  if(green.length<samples.length*.8)return null;
  return [0,1,2].map(channel=>green.reduce((sum,p)=>sum+rgba[p+channel],0)/green.length/255);
}

export function describeFrame(rgba,background=null,size=ANALYSIS_SIZE){
  if(rgba.length!==size*size*4)throw new Error('分析图像尺寸不一致');
  const pixels=new Float32Array(size*size*5);
  let coverage=0;
  for(let p=0;p<size*size;p++){
    const from=p*4,to=p*5,r=rgba[from]/255,g=rgba[from+1]/255,b=rgba[from+2]/255;
    const difference=background?Math.hypot(r-background[0],g-background[1],b-background[2]):1;
    // 仅降低与边框亮绿接近的颜色权重；这是分析特征，不是抠图蒙版。
    const foreground=clamp((difference-.07)/.2)*rgba[from+3]/255;
    pixels[to]=r;pixels[to+1]=g;pixels[to+2]=b;pixels[to+3]=foreground;coverage+=foreground;
    if(p%size) pixels[to+4]=(Math.abs(r-pixels[to-5])+Math.abs(g-pixels[to-4])+Math.abs(b-pixels[to-3]))/3;
  }
  return {pixels,coverage:coverage/(size*size)};
}

export function frameDistance(a,b){
  let total=0,weight=0;
  for(let p=0;p<a.pixels.length;p+=5){
    const w=Math.max(a.pixels[p+3],b.pixels[p+3]);
    if(w<.01)continue;
    const rgb=(Math.abs(a.pixels[p]-b.pixels[p])+Math.abs(a.pixels[p+1]-b.pixels[p+1])+Math.abs(a.pixels[p+2]-b.pixels[p+2]))/3;
    total+=w*(rgb*.6+Math.abs(a.pixels[p+3]-b.pixels[p+3])*.3+Math.abs(a.pixels[p+4]-b.pixels[p+4])*.1);weight+=w;
  }
  return weight?total/weight:0;
}

function motionMismatch(a,b,c,d){
  let error=0,magnitude=0;
  for(let p=0;p<a.pixels.length;p+=5){
    const w=Math.max(a.pixels[p+3],b.pixels[p+3],c.pixels[p+3],d.pixels[p+3]);
    for(let channel=0;channel<4;channel++){
      const v=b.pixels[p+channel]-a.pixels[p+channel],u=d.pixels[p+channel]-c.pixels[p+channel];
      error+=w*Math.abs(v-u);magnitude+=w*(Math.abs(v)+Math.abs(u));
    }
  }
  return magnitude>.001?error/magnitude:0;
}
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)] || 0;};

export function findLoopCandidates(features,{check=()=>{},progress=()=>{},trace=()=>{}}={}){
  const n=features.length;
  if(n>600)throw new Error('循环分析最多600帧');
  if(n<7)return [];
  if(features.some(frame=>!(frame.pixels instanceof Float32Array) || frame.pixels.length!==features[0].pixels.length || !frame.pixels.every(Number.isFinite)))throw new Error('循环分析特征无效');
  const distances=new Float32Array(n*n);
  for(let i=0;i<n;i++){
    check();
    for(let j=i+1;j<n;j++)distances[i*n+j]=distances[j*n+i]=frameDistance(features[i],features[j]);
    if(i%16===0)progress(i/n);
  }
  const distance=(a,b)=>distances[a*n+b];
  const adjacent=Array.from({length:n-1},(_,i)=>distance(i,i+1)),typical=median(adjacent);
  // 静止片段不作为角色动作循环推荐；没有可靠重复就返回空，不强凑结果。
  if(typical<.003)return [];
  const proposals=[];
  for(let start=0;start<n-4;start++){
    check();
    for(let repeat=start+4;repeat<n-1;repeat++){
      const endpoint=distance(start,repeat);
      if(endpoint>Math.min(.12,typical*.75+.008))continue;
      if(endpoint>distance(start,repeat-1) || endpoint>distance(start,repeat+1))continue;
      const pairs=[];
      for(let shift=-2;shift<=2;shift++)if(start+shift>=0 && repeat+shift<n)pairs.push(distance(start+shift,repeat+shift));
      if(pairs.length<3)continue;
      const neighborhood=pairs.reduce((sum,value)=>sum+value,0)/pairs.length;
      if(neighborhood>Math.min(.13,typical*.8+.008))continue;
      const direction=motionMismatch(features[start],features[start+1],features[repeat],features[repeat+1]);
      if(direction>.65)continue;
      const seam=distance(repeat-1,start);
      const local=median(adjacent.slice(Math.max(0,start-1),start+2).concat(adjacent.slice(repeat-2,repeat+1)));
      if(seam>Math.max(.02,local*1.8) || seam>.22)continue;
      const seamMotion=motionMismatch(features[repeat-1],features[start],features[repeat-1],features[repeat]);
      if(seamMotion>.65)continue;
      const motion=median(adjacent.slice(start,repeat));
      if(motion<.003)continue;
      // 周期中的姿态必须发生可见变化，排除近邻静态噪声组成的假循环。
      const span=Math.max(...Array.from({length:repeat-start},(_,i)=>distance(start,start+i)));
      if(span<.012){trace({reason:'motion-span',start,repeat,span,motion});continue;}
      const score=neighborhood/typical+endpoint/typical*.4+seam/Math.max(.003,local)*.2+direction*.35+seamMotion*.35;
      proposals.push({start,endExclusive:repeat,count:repeat-start,score,endpoint,neighborhood,seam,direction,seamMotion});
    }
  }
  proposals.sort((a,b)=>a.score-b.score || a.count-b.count || a.start-b.start);
  // 匹配质量相近时优先短完整周期；避免编码微差让两轮/三轮动作挤掉一轮。
  // 分档只是内部启发式，不是概率，也不在界面伪装成“平滑度百分比”。
  const best=proposals[0]?.score || 0;
  proposals.sort((a,b)=>Math.floor((a.score-best)/.08)-Math.floor((b.score-best)/.08) || a.count-b.count || a.score-b.score || a.start-b.start);
  const candidates=[];
  for(const candidate of proposals){
    // 同周期的相位偏移去重；不同动作片段和明显不同周期仍供用户比较。
    if(candidates.some(other=>Math.abs(other.count-candidate.count)<=1 && Math.min(other.endExclusive,candidate.endExclusive)-Math.max(other.start,candidate.start)>Math.min(other.count,candidate.count)*.5))continue;
    candidates.push(candidate);if(candidates.length===5)break;
  }
  return candidates;
}

export function bindLoopCandidates(order,revision,candidates){
  return candidates.map(candidate=>({...candidate,revision,sequenceIds:[...order],frameIds:order.slice(candidate.start,candidate.endExclusive)}));
}

export function applyLoopCandidate(editor,candidate){
  validateLoopCandidate(editor,candidate);
  return editor.commit(candidate.frameIds);
}

function validateLoopCandidate(editor,candidate){
  if(editor.revision!==candidate.revision || editor.order.join('|')!==candidate.sequenceIds.join('|'))throw new Error('帧顺序已变化，请重新寻找循环');
  if(candidate.count!==candidate.frameIds.length || candidate.count<4 || candidate.frameIds.join('|')!==editor.order.slice(candidate.start,candidate.endExclusive).join('|'))throw new Error('循环候选无效');
}

// 工作流只勾选候选，原编辑器的裁剪入口保留独立语义。
export function selectLoopCandidate(editor,candidate){
  validateLoopCandidate(editor,candidate);
  editor.selected=new Set(candidate.frameIds);editor.active=candidate.frameIds[0];editor.anchor=candidate.frameIds[0];
}
