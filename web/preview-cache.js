// 真正的最近使用淘汰；帧数和RGBA内存两项都保持有界。
export class PreviewCache{
  constructor({maxEntries=64,maxBytes=128*1024**2}={}){this.maxEntries=maxEntries;this.maxBytes=maxBytes;this.entries=new Map();this.bytes=0;}
  get(key){const entry=this.entries.get(key);if(!entry)return undefined;this.entries.delete(key);this.entries.set(key,entry);return entry.image;}
  set(key,image){
    const previous=this.entries.get(key);if(previous){this.bytes-=previous.bytes;this.entries.delete(key);}
    const bytes=image.width*image.height*4;
    if(bytes>this.maxBytes)return; // 超预算单帧可显示，但不留在缓存。
    this.entries.set(key,{image,bytes});this.bytes+=bytes;
    while(this.entries.size>this.maxEntries||this.bytes>this.maxBytes){const oldest=this.entries.keys().next().value;this.bytes-=this.entries.get(oldest).bytes;this.entries.delete(oldest);}
  }
  clear(){this.entries.clear();this.bytes=0;}
  get size(){return this.entries.size;}
}
