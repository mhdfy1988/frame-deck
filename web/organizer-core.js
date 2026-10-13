// 编辑领域只管理稳定身份、选择和顺序；不持有图像像素。
export function totalTime(frames) {
  let numerator=0n, denominator=1n;
  const gcd=(a,b)=>b?gcd(b,a%b):a;
  for(const frame of frames){
    const parts=frame.durationSeconds.split('/');
    if(parts.length!==2 || !parts.every(part=>/^\d+$/.test(part)))throw new Error('原帧时长无效');
    const n=BigInt(parts[0]),d=BigInt(parts[1]);
    if(n<=0n || d<=0n)throw new Error('原帧时长无效');
    numerator=numerator*d+n*denominator;denominator*=d;
    const factor=gcd(numerator,denominator);numerator/=factor;denominator/=factor;
  }
  return {exact:`${numerator}/${denominator}`,seconds:Number(numerator)/Number(denominator)};
}

export class FrameEditor {
  constructor(sequence){
    if(sequence.formatVersion!==2 || !sequence.frames?.length || sequence.frames.length>600)throw new Error('需要M1已完成的v2结果');
    this.sequence=structuredClone(sequence);
    this.original=this.sequence.frames.map(frame=>frame.id);
    if(new Set(this.original).size!==this.original.length)throw new Error('原帧身份重复');
    totalTime(this.sequence.frames);
    this.byId=new Map(this.sequence.frames.map((frame,index)=>[frame.id,{...frame,sourceIndex:index}]));
    this.order=[...this.original];this.selected=new Set();this.active=this.order[0];this.anchor=null;
    this.undoStack=[];this.redoStack=[];this.saved=this.signature;this.revision=0;
  }
  get frames(){return this.order.map(id=>this.byId.get(id));}
  get checkedFrames(){return this.frames.filter(frame=>this.selected.has(frame.id));}
  get signature(){return this.order.join('|');}
  get dirty(){return this.signature!==this.saved;}
  get time(){return totalTime(this.frames);}
  snapshot(){return {order:[...this.order],selected:[...this.selected],active:this.active,anchor:this.anchor};}
  restore(snapshot){this.order=[...snapshot.order];this.selected=new Set(snapshot.selected);this.active=snapshot.active;this.anchor=snapshot.anchor;this.revision++;}
  // 查看帧不改变勾选集合；播放和前后查看也走独立状态。
  view(id){if(this.order.includes(id))this.active=id;}
  select(id,{toggle=false,range=false}={}){
    if(!this.order.includes(id))return;
    if(range && this.order.includes(this.anchor)){
      const a=this.order.indexOf(this.anchor),b=this.order.indexOf(id);
      const ids=this.order.slice(Math.min(a,b),Math.max(a,b)+1);
      this.selected=new Set(toggle?[...this.selected,...ids]:ids);
    }else{
      if(toggle){if(this.selected.has(id))this.selected.delete(id);else this.selected.add(id);}
      else this.selected=new Set([id]);
      this.anchor=id;
    }
  }
  selectAll(){this.selected=new Set(this.order);}
  clearSelection(){this.selected.clear();this.anchor=null;}
  commit(next,selection=null){
    if(next.join('|')===this.signature)return false;
    if(new Set(next).size!==next.length || next.some(id=>!this.byId.has(id)))throw new Error('编辑序列含无效帧');
    this.undoStack.push(this.snapshot());
    // 最多100步，每步仅600个身份/选择引用，不复制PNG。
    if(this.undoStack.length>100)this.undoStack.shift();
    this.redoStack=[];this.order=[...next];
    this.selected=new Set(selection || [...this.selected].filter(id=>next.includes(id)));
    if(!next.includes(this.active))this.active=next[0] || null;
    if(!next.includes(this.anchor))this.anchor=null;
    this.revision++;return true;
  }
  remove(ids=this.selected){
    // 单帧与批量删除共用提交；只移除指定身份，其他勾选帧原样保留。
    const removed=new Set(ids);
    return this.commit(this.order.filter(id=>!removed.has(id)));
  }
  reset(){return this.commit([...this.original],[]);}
  undo(){if(!this.undoStack.length)return false;this.redoStack.push(this.snapshot());this.restore(this.undoStack.pop());return true;}
  redo(){if(!this.redoStack.length)return false;this.undoStack.push(this.snapshot());this.restore(this.redoStack.pop());return true;}
  swap(id,target){
    const from=this.order.indexOf(id),to=this.order.indexOf(target);
    if(from<0 || to<0 || from===to)return false;
    // 交换稳定身份，图片、来源、勾选和当前查看都跟着各自的帧走。
    const next=[...this.order];[next[from],next[to]]=[next[to],next[from]];
    return this.commit(next);
  }
  append(id){
    if(!this.order.includes(id))return false;
    const next=this.order.filter(item=>item!==id);next.push(id);
    return this.commit(next);
  }
  markExported(){this.saved=this.signature;}
}
