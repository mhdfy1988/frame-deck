export function expectedCount(start, end, fps) {
  if (![start,end,fps].every(Number.isFinite) || start < 0 || end <= start || !Number.isInteger(fps) || fps < 1 || fps > 60) return 0;
  // 界面显示估算；正式有理数计数由服务端决定。
  return Math.ceil((end - start) * fps - 1e-10);
}
export function formatTime(seconds) {
  const ms = Math.round(Math.max(0,seconds) * 1000);
  return `${String(Math.floor(ms / 60000)).padStart(2,'0')}:${String(Math.floor(ms / 1000) % 60).padStart(2,'0')}.${String(ms % 1000).padStart(3,'0')}`;
}
// 预览时钟只管理图片播放，不读写来源时间或导出时长。
export class FramePlayback {
  constructor(count, fps, now, startIndex=0) {
    if (!Number.isInteger(count) || count<1 || !Number.isInteger(startIndex) || startIndex<0 || startIndex>=count) throw new RangeError('播放帧数或起点无效');
    this.count=count;this.offset=startIndex;this.start=now;
    this.setRate(fps,now);
  }
  // 时间戳落在起点之前时保持现有进度，不生成负帧号或向前一帧倒退。
  position(now) {return this.offset+Math.max(0,now-this.start)*this.fps/1000;}
  setRate(fps,now) {
    if (!Number.isInteger(fps) || fps<1 || fps>60) throw new RangeError('播放帧率须为1–60的整数');
    if (this.fps!==undefined) this.offset=this.position(now);
    this.start=now;this.fps=fps;
  }
  index(now) {return Math.min(this.count-1,Math.floor(this.position(now)));}
  ended(now) {return this.position(now)>=this.count;}
}
