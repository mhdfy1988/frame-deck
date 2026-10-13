import {icons} from './icons-data.js';
// 只接收本机固定图标和代码里的文案，不渲染外部输入。
export function setControl(element,name,label=''){
  if(!element)return;
  if(!icons[name])throw new Error(`Unknown icon: ${name}`);
  if(element instanceof SVGElement){const template=document.createElement('template');template.innerHTML=icons[name];element.replaceWith(template.content.firstElementChild);return;}
  element.innerHTML=icons[name];
  element.classList.add('with-icon');
  if(label){const text=document.createElement('span');text.textContent=label;element.append(text);}
}
export function decorateIcons(){
  const get=id=>document.getElementById(id);
  setControl(document.querySelector('.brand-mark'),'layers');
  setControl(document.querySelector('#tab-extract>svg'),'film');
  setControl(document.querySelector('#organize>svg'),'layout-grid');
  const controls={play:['play','播放帧'],'viewer-play':['play','播放'],'edit-play':['play','播放'],'matting-play':['play','播放'],'loop-play':['play','播放'],'edit-find-loop':['repeat-2','寻找循环'],'edit-delete':['trash-2','删除'],'edit-undo':['undo-2','撤销'],'edit-redo':['redo-2','恢复'],'edit-reset':['rotate-ccw','重置'],undoButton:['undo-2'],redoButton:['redo-2'],resetButton:['rotate-ccw'],cancelSelection:['x']};
  for(const [id,[name,label]] of Object.entries(controls))setControl(get(id),name,label);
  for(const id of ['previous','edit-previous','matting-prev','loop-previous'])setControl(get(id),'chevron-left');
  for(const id of ['next','edit-next','matting-next','loop-next'])setControl(get(id),'chevron-right');
  for(const id of ['zoom-out','edit-zoom-out','zoomOut'])setControl(get(id),'minus');
  for(const id of ['zoom-in','edit-zoom-in','zoomIn'])setControl(get(id),'plus');
  for(const id of ['repair-close','close-viewer','loop-close'])setControl(get(id),'x');
  for(const [tool,name,label] of [['move','move','移动'],['remove','eraser','去除'],['restore','brush','恢复'],['wand','wand-sparkles','魔法棒']])setControl(document.querySelector(`[data-tool="${tool}"]`),name,label);
  for(const [selector,name] of [['.film-icon','upload'],['.frames-icon','image']])setControl(document.querySelector(selector),name);
}
