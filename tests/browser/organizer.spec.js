import {test,expect} from '@playwright/test';
import {legacyDownload} from './legacy-download.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const fixture=path.resolve('output/fixtures/自制 动作测试.mp4');
const ownedSessions=new WeakMap();
test.beforeEach(async({page})=>{
  const sessions=[];ownedSessions.set(page,sessions);
  page.on('response',response=>{
    if(response.url().endsWith('/api/videos') && !response.ok())response.text().then(body=>console.error('导入失败响应',response.status(),body));
    if(response.request().method()==='POST' && response.url().endsWith('/api/edit-sessions') && response.ok())sessions.push(response.json().then(body=>body.id));
  });
  page.on('requestfailed',request=>{if(request.url().endsWith('/api/videos'))console.error('导入请求失败',request.failure()?.errorText);});
});
test.afterEach(async({page,request})=>{
  // 只释放本测试创建的会话；浏览器强制关闭不保证pagehide送达。
  for(const identity of await Promise.all(ownedSessions.get(page) || [])){
    const response=await request.delete(`/api/edit-sessions/${identity}`);expect(response.ok()).toBe(true);
  }
});
const cards=page=>page.locator('#edit-grid .frame');
async function extract(page,fps=12){
  await page.goto('/');await page.locator('#file').setInputFiles(fixture);await expect(page.locator('#status')).toHaveText('已导入');
  await page.locator('#start').fill('.25');await page.locator('#end').fill('1.25');await page.locator('#fps').fill(String(fps));await page.locator('#extract').click();
  await expect(page.locator('#result-meta')).toContainText(`${fps} 帧`);
}
async function enter(page,fps=12){await extract(page,fps);await page.locator('#organize').click();await expect(page.locator('#organizer-workspace')).toBeVisible();await expect(cards(page)).toHaveCount(fps);}
const ids=page=>cards(page).evaluateAll(elements=>elements.map(element=>element.dataset.frameId));

test('播放计数即时跟勾选变化，序列帧界面不显示时间',async({page})=>{
  await enter(page);const label=page.locator('#edit-frame-label');
  await expect(label).toHaveText('0 / 0');
  await cards(page).nth(4).locator('.frame-check').check();
  await cards(page).nth(1).locator('.frame-check').check();
  await expect(label).toHaveText('— / 2');
  await cards(page).nth(4).locator('.frame-preview').click();
  await expect(label).toHaveText('2 / 2');
  await expect(label).toHaveAttribute('title','查看第5 / 12帧');
  await cards(page).nth(1).locator('.frame-check').uncheck();
  await expect(label).toHaveText('1 / 1');
  await page.locator('#edit-all').click();await expect(label).toHaveText('5 / 12');
  await page.locator('#edit-none').click();await expect(label).toHaveText('0 / 0');
  await expect(page.locator('#edit-image')).toBeVisible();
  await cards(page).nth(1).locator('.frame-check').check();await cards(page).nth(5).locator('.frame-check').check();
  await cards(page).nth(5).locator('.frame-preview').click();
  await expect(page.locator('#edit-meta')).toHaveText('保留 12 帧');
  expect(await cards(page).locator('.frame-info').allTextContents()).toEqual(Array.from({length:12},(_,index)=>String(index+1).padStart(3,'0')));
  expect(await page.locator('#organizer-workspace').evaluate(element=>/\d{2}:\d{2}\.\d{3}/.test(element.textContent+[...element.querySelectorAll('[title]')].map(item=>item.title).join(' ')))).toBe(false);
  await page.screenshot({path:'output/acceptance/frames-no-time-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await expect(label).toHaveText('2 / 2');
  const bounds=await page.locator('#organizer-workspace .edit-preview-bottom').evaluate(element=>{
    const parent=element.getBoundingClientRect();return [...element.children].map(child=>child.getBoundingClientRect()).every(rect=>rect.left>=parent.left && rect.right<=parent.right && rect.right<=innerWidth);
  });expect(bounds).toBe(true);
  await page.screenshot({path:'output/acceptance/frames-no-time-mobile.png'});
  await page.locator('#edit-delete').click();await expect(label).toHaveText('0 / 0');
  await page.locator('#edit-undo').click();await expect(label).toContainText('/ 2');
  await expect(page.locator('#edit-meta')).toContainText('保留 12 帧');
  await page.locator('#tab-extract').click();
  await expect(page.locator('#result-meta')).not.toContainText('00:');
  expect(await page.locator('#grid .frame-info').allTextContents()).toEqual(Array.from({length:12},(_,index)=>String(index+1).padStart(3,'0')));
  await page.locator('#grid .frame').first().click();await expect(page.locator('#viewer')).toBeVisible();
  await expect(page.locator('#viewer-time')).toHaveCount(0);
  await expect(page.locator('#viewer')).not.toContainText('00:');
});

test('仅播放勾选帧：跳过未勾选、默认12帧率、首帧开始、单帧和取消',async({page})=>{
  await enter(page);await expect(page.locator('#edit-play')).toBeDisabled();
  const original=await ids(page),checkbox=index=>cards(page).nth(index).locator('.frame-check');
  // 先勾后面的帧，再勾前面的；播放仍跟整理顺序走。
  await checkbox(5).check();await checkbox(1).check();
  await cards(page).nth(8).locator('.frame-preview').click();
  const expected=await cards(page).evaluateAll(elements=>[1,5].map(index=>elements[index].querySelector('img').src.replace('?thumb=true','')));
  await page.evaluate(()=>{
    window.playedFrameURLs=[];
    new MutationObserver(()=>window.playedFrameURLs.push(document.querySelector('#edit-image').src)).observe(document.querySelector('#edit-image'),{attributes:true,attributeFilter:['src']});
  });
  const time=new Date('2026-10-06T12:00:00Z');await page.clock.install({time});await page.clock.pauseAt(new Date(time.getTime()+1000));
  await page.locator('#edit-play').click();await page.clock.runFor(32);
  await expect(page.locator('#edit-frame-label')).toHaveText('1 / 2');
  await page.clock.runFor(80);await expect(page.locator('#edit-frame-label')).toHaveText('2 / 2');
  await expect(page.locator('#edit-play')).toHaveText('暂停');
  await page.clock.runFor(80);await expect(page.locator('#edit-play')).toHaveText('播放');
  await expect(page.locator('#edit-frame-label')).toContainText('2 / 2');
  expect(await page.evaluate(()=>window.playedFrameURLs)).toEqual(expected);
  await expect(page.locator('#edit-grid input:checked')).toHaveCount(2);expect(await ids(page)).toEqual(original);
  await expect(page.locator('#edit-meta')).not.toContainText('未导出');
  await page.locator('#edit-none').click();await expect(page.locator('#edit-play')).toBeDisabled();
  await checkbox(9).check();await page.locator('#edit-play').click();await page.clock.runFor(32);
  await expect(page.locator('#edit-frame-label')).toHaveText('1 / 1');
  await page.clock.runFor(80);await expect(page.locator('#edit-play')).toHaveText('播放');
  await expect(page.locator('#edit-frame-label')).toContainText('1 / 1');
  await page.locator('#edit-play').click();await page.locator('#edit-none').click();
  await expect(page.locator('#edit-play')).toBeDisabled();await page.clock.runFor(200);
  await expect(page.locator('#edit-frame-label')).toHaveText('0 / 0');
});

test('独立播放速度：慢放、实时调速、非法值、M1预览且不改采样或导出状态',async({page})=>{
  // 用24帧/秒采样，证明预览12/6/1/60帧率不依赖来源时长。
  await enter(page,24);const original=await ids(page),rate=page.locator('#edit-play-fps');
  await expect(rate).toHaveValue('12');await rate.fill('6');
  await cards(page).nth(1).locator('.frame-check').check();await cards(page).nth(5).locator('.frame-check').check();
  const urls=await cards(page).evaluateAll(elements=>[1,5].map(index=>elements[index].querySelector('img').src.replace('?thumb=true','')));
  const time=new Date('2026-10-06T12:00:00Z');await page.clock.install({time});await page.clock.pauseAt(new Date(time.getTime()+1000));
  await page.locator('#edit-play').click();await page.clock.runFor(112);
  await expect(page.locator('#edit-image')).toHaveAttribute('src',new URL(urls[0]).pathname);
  await page.clock.runFor(80);await expect(page.locator('#edit-image')).toHaveAttribute('src',new URL(urls[1]).pathname);
  await rate.fill('1');await page.clock.runFor(500);
  await expect(page.locator('#edit-play')).toHaveText('暂停');
  await expect(page.locator('#edit-image')).toHaveAttribute('src',new URL(urls[1]).pathname);
  await page.clock.runFor(400);await expect(page.locator('#edit-play')).toHaveText('播放');
  for(const value of ['0','61','2.5','']){
    await rate.fill(value);expect(await rate.evaluate(input=>input.validity.valid)).toBe(false);
    await rate.blur();await expect(rate).toHaveValue('1');
  }
  await rate.fill('60');await page.locator('#edit-play').click();await page.clock.runFor(48);
  await expect(page.locator('#edit-play')).toHaveText('播放');await expect(page.locator('#edit-frame-label')).toHaveText('2 / 2');
  expect(await ids(page)).toEqual(original);await expect(page.locator('#edit-grid input:checked')).toHaveCount(2);
  await expect(page.locator('#edit-meta')).toHaveText('保留 24 帧');
  await page.screenshot({path:'output/acceptance/playback-rate-desktop.png'});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'output/acceptance/playback-rate-mobile.png'});
  await page.locator('#tab-extract').click();await expect(page.locator('#fps')).toHaveValue('24');
  await page.locator('#grid .frame').first().click();const viewerRate=page.locator('#viewer-play-fps');
  await expect(viewerRate).toHaveValue('12');await viewerRate.fill('6');await page.locator('#viewer-play').click();
  await page.clock.runFor(112);await expect(page.locator('#viewer-title')).toHaveText('第 1 / 24 帧');
  await page.clock.runFor(80);await expect(page.locator('#viewer-title')).toHaveText('第 2 / 24 帧');
  await viewerRate.fill('1');await page.clock.runFor(500);await expect(page.locator('#viewer-title')).toHaveText('第 2 / 24 帧');
  await page.locator('#viewer-play').click();await viewerRate.fill('61');await viewerRate.blur();await expect(viewerRate).toHaveValue('1');
  const fits=await page.locator('.viewer-bottom').evaluate(element=>{
    const parent=element.getBoundingClientRect();return [...element.children].every(child=>{const box=child.getBoundingClientRect();return box.left>=parent.left && box.right<=parent.right;});
  });expect(fits).toBe(true);
});

test('真实动画时钟：回调时间戳滞后仍能启动、结束与重复播放',async({page})=>{
  const errors=[];page.on('pageerror',reason=>errors.push(reason.message));
  // 显式放大回调时间与点击performance.now()的差异，复现用户页负帧号。
  await page.addInitScript(()=>{
    const originalRAF=window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame=callback=>originalRAF(timestamp=>callback(timestamp-10000));
  });
  await enter(page);await page.locator('#edit-all').click();await page.locator('#edit-play-fps').fill('50');
  for(let attempt=0;attempt<3;attempt++){
    await page.locator('#edit-play').click();
    await expect(page.locator('#edit-frame-label')).toHaveText('12 / 12',{timeout:1000});
    await expect(page.locator('#edit-play')).toHaveText('播放',{timeout:1000});
  }
  expect(errors).toEqual([]);await page.locator('#tab-extract').click();
  await page.locator('#grid .frame').first().click();await page.locator('#viewer-play-fps').fill('50');
  await page.locator('#viewer-play').click();await expect(page.locator('#viewer-play')).toHaveText('播放',{timeout:1000});
  await expect(page.locator('#viewer-title')).toHaveText('第 1 / 12 帧');expect(errors).toEqual([]);
});

test('查看与勾选独立，普通点击复选框即可多选',async({page})=>{
  const consoleErrors=[],failedResources=[];page.on('console',message=>{if(message.type()==='error')consoleErrors.push({text:message.text(),url:message.location().url});});
  page.on('response',response=>{if(response.status()>=400)failedResources.push({url:response.url(),status:response.status()});});
  await enter(page);
  const boxes=()=>page.locator('#edit-grid input[type=checkbox]');
  const checked=()=>page.locator('#edit-grid input:checked');
  await expect(boxes()).toHaveCount(12);
  await expect(checked()).toHaveCount(0);
  await expect(page.locator('#edit-delete')).toBeDisabled();
  await boxes().nth(1).check();await boxes().nth(3).check();
  await expect(checked()).toHaveCount(2);
  await expect(page.locator('#edit-frame-label')).toHaveAttribute('title',/第1 \/ 12帧/);
  await cards(page).nth(5).locator('.frame-preview').click();
  await expect(page.locator('#edit-frame-label')).toHaveAttribute('title',/第6 \/ 12帧/);
  await expect(checked()).toHaveCount(2);
  await cards(page).nth(5).locator('.frame-preview').click({modifiers:['Control']});
  await expect(checked()).toHaveCount(2);
  await page.locator('#edit-next').click();
  await expect(page.locator('#edit-frame-label')).toHaveAttribute('title',/第7 \/ 12帧/);
  await expect(checked()).toHaveCount(2);
  await page.locator('#edit-play').click();
  await expect(page.locator('#edit-frame-label')).toContainText('/ 2');await expect(page.locator('#edit-frame-label')).not.toContainText('—');
  await page.locator('#edit-play').click();await expect(checked()).toHaveCount(2);
  await boxes().nth(1).uncheck();await expect(checked()).toHaveCount(1);
  await page.locator('#edit-delete').click();await expect(cards(page)).toHaveCount(11);
  await page.locator('#edit-undo').click();await expect(cards(page)).toHaveCount(12);
  await expect(boxes().nth(3)).toBeChecked();await expect(checked()).toHaveCount(1);
  await page.locator('#edit-none').click();await expect(checked()).toHaveCount(0);
  await expect(page.locator('#edit-image')).toBeVisible();
  await boxes().nth(2).focus();await page.keyboard.press('Space');await expect(boxes().nth(2)).toBeChecked();
  await page.keyboard.press('Space');await expect(boxes().nth(2)).not.toBeChecked();
  await page.setViewportSize({width:390,height:844});
  await boxes().nth(0).check();await boxes().nth(2).check();await expect(checked()).toHaveCount(2);
  const marker=cards(page).nth(0).locator('.frame-check-mark');
  expect(await marker.evaluate(element=>getComputedStyle(element,'::after').borderRightWidth)).toBe('3px');
  await page.screenshot({path:'output/acceptance/independent-check-mobile.png'});
  await boxes().nth(2).focus();await page.keyboard.press('Delete');await expect(cards(page)).toHaveCount(10);
  await page.keyboard.press('Control+z');await expect(cards(page)).toHaveCount(12);await expect(checked()).toHaveCount(2);
  // 独立启动Chrome会请求现有未提供的favicon；只区分已确认的这一项，不忽略帧资源或CSP错误。
  const faviconErrors=consoleErrors.filter(error=>error.url==='http://127.0.0.1:8897/favicon.ico');
  expect(faviconErrors.every(error=>error.text==='Failed to load resource: the server responded with a status of 404 (Not Found)')).toBe(true);
  expect({consoleErrors:consoleErrors.filter(error=>!faviconErrors.includes(error)),failedResources}).toEqual({consoleErrors:[],failedResources:[]});
});

test('M1直接交接，范围/多选/删除/历史/删空及返回保留',async({page})=>{
  await enter(page);await expect(page.locator('#edit-meta')).toHaveText('保留 12 帧');
  await expect(page.locator('#edit-undo')).toBeDisabled();
  await cards(page).nth(1).locator('.frame-check').check();await cards(page).nth(3).locator('.frame-check').check();await expect(page.locator('#edit-selection')).toHaveText('已勾选 2 帧');
  await cards(page).nth(5).locator('.frame-check').click({modifiers:['Shift']});await expect(page.locator('#edit-selection')).toHaveText('已勾选 3 帧');
  await expect(page.locator('#edit-undo')).toBeDisabled();
  await page.locator('#edit-delete').click();await expect(cards(page)).toHaveCount(9);await expect(page.locator('#edit-meta')).toHaveText('保留 9 帧 · 未导出');
  await page.keyboard.press('Control+z');await expect(cards(page)).toHaveCount(12);await page.keyboard.press('Control+Shift+z');await expect(cards(page)).toHaveCount(9);
  await page.locator('#tab-extract').click();await expect(page.locator('#result-meta')).toContainText('12 帧');
  await page.locator('#organize').click();await expect(cards(page)).toHaveCount(9);
  page.once('dialog',dialog=>dialog.accept());await page.locator('#edit-reset').click();await expect(cards(page)).toHaveCount(12);
  await page.locator('#edit-undo').click();await expect(cards(page)).toHaveCount(9);
  await page.locator('#edit-all').click();await page.keyboard.press('Delete');await expect(cards(page)).toHaveCount(0);await expect(page.locator('#tab-export')).toBeDisabled();
  await expect(page.locator('#edit-empty')).toBeVisible();await page.locator('#edit-undo').click();await expect(cards(page)).toHaveCount(9);
});

test('悬浮垃圾桶：只删本帧、勾选不被借用、撤销恢复与键盘入口',async({page})=>{
  const errors=[];page.on('pageerror',reason=>errors.push(reason.message));
  await enter(page);await page.emulateMedia({reducedMotion:'reduce'});const original=await ids(page);
  const card=cards(page).nth(2),trash=card.locator('.frame-delete'),before=await card.boundingBox();
  await expect(trash).toHaveCSS('opacity','0');await card.hover();await expect(trash).toHaveCSS('opacity','1');
  expect(await card.boundingBox()).toEqual(before);
  const box=await trash.boundingBox();expect(box.x+box.width).toBeLessThanOrEqual(before.x+before.width);expect(box.y+box.height).toBeLessThanOrEqual(before.y+before.height);expect(box.x).toBeGreaterThan(before.x+before.width/2);expect(box.y).toBeGreaterThan(before.y+before.height/2);
  const info=await card.locator('.frame-info').boundingBox();expect(box.width).toBe(18);expect(box.height).toBe(18);expect(box.y).toBeGreaterThanOrEqual(info.y);expect(box.y+box.height).toBeLessThanOrEqual(info.y+info.height);
  // 窄屏横条更矮，仍完整容纳图标，不伸进图片或遮住原编号。
  await page.setViewportSize({width:390,height:844});await card.hover();const narrow=await trash.boundingBox(),strip=await card.locator('.frame-info').boundingBox();expect(narrow.y).toBeGreaterThanOrEqual(strip.y);expect(narrow.y+narrow.height).toBeLessThanOrEqual(strip.y+strip.height);
  await page.setViewportSize({width:1440,height:1000});await card.hover();
  await expect(trash).toHaveAttribute('aria-label','删除原帧003');await expect(trash.locator('svg')).toHaveClass(/lucide-trash-2/);
  await page.screenshot({path:'output/acceptance/frame-trash-hover.png'});
  await trash.click();await expect.poll(()=>ids(page)).toEqual(original.filter(id=>id!==original[2]));await expect(page.locator('#edit-grid input:checked')).toHaveCount(0);await expect(page.locator('#edit-status')).toHaveText('已删除原帧 003');
  await page.locator('#edit-undo').click();expect(await ids(page)).toEqual(original);await page.locator('#edit-redo').click();await expect(cards(page)).toHaveCount(11);await page.locator('#edit-undo').click();
  await cards(page).nth(1).locator('.frame-check').check();await cards(page).nth(4).locator('.frame-check').check();
  await cards(page).nth(5).locator('.frame-preview').click();const activeURL=await page.locator('#edit-image').getAttribute('src');
  await cards(page).nth(2).hover();await cards(page).nth(2).locator('.frame-delete').click();await expect(page.locator('#edit-grid input:checked')).toHaveCount(2);await expect(page.locator('#edit-image')).toHaveAttribute('src',activeURL);
  await cards(page).nth(1).hover();await cards(page).nth(1).locator('.frame-delete').click();await expect(page.locator('#edit-grid input:checked')).toHaveCount(1);await page.locator('#edit-undo').click();await expect(page.locator('#edit-grid input:checked')).toHaveCount(2);
  await page.locator('#edit-none').click();await page.mouse.move(0,0);const keyboardTrash=cards(page).first().locator('.frame-delete');await keyboardTrash.focus();await expect(keyboardTrash).toHaveCSS('opacity','1');await page.keyboard.press('Enter');await expect(cards(page)).toHaveCount(10);await expect(cards(page).first().locator('.frame-delete')).toBeFocused();
  expect(errors).toEqual([]);
});

test('恢复名称：按钮与两个快捷键仍执行被撤销的操作',async({page})=>{
  const errors=[];page.on('pageerror',reason=>errors.push(reason.message));
  await enter(page);
  const redo=page.locator('#edit-redo');
  await expect(redo).toHaveText('恢复');await expect(redo).toHaveAttribute('title','恢复刚才撤销的操作 Ctrl+Shift+Z / Ctrl+Y');await expect(redo).toBeDisabled();
  await cards(page).first().locator('.frame-check').check();await page.locator('#edit-delete').click();await expect(cards(page)).toHaveCount(11);
  for(const shortcut of [null,'Control+Shift+Z','Control+y']){
    await page.locator('#edit-undo').click();await expect(cards(page)).toHaveCount(12);await expect(redo).toBeEnabled();
    if(shortcut)await page.keyboard.press(shortcut);else await redo.click();
    await expect(cards(page)).toHaveCount(11);await expect(page.locator('#edit-status')).toHaveText('已恢复撤销的操作');await expect(redo).toBeDisabled();
  }
  expect(errors).toEqual([]);
});

test('拖动交换：动画、原编号随图片移动，撤销与勾选不变',async({page})=>{
  const errors=[];page.on('pageerror',reason=>errors.push(reason.message));
  await enter(page);const original=await ids(page);
  // 暂停真实创建的动画，检验两张卡片确实有非零位移而非瞬间换图。
  await page.evaluate(()=>{const animate=Element.prototype.animate;Element.prototype.animate=function(...args){const motion=animate.apply(this,args);if(this.closest('#edit-grid')){motion.pause();motion.currentTime=100;}return motion;};});
  const swapped=[...original];[swapped[1],swapped[8]]=[swapped[8],swapped[1]];
  await expect(page.locator('#edit-move-left,#edit-move-right')).toHaveCount(0);
  const source=await cards(page).nth(1).boundingBox(),target=await cards(page).nth(8).boundingBox();
  await page.mouse.move(source.x+source.width/2,source.y+source.height/2);await page.mouse.down();
  await page.mouse.move(source.x+source.width/2+10,source.y+source.height/2,{steps:5});
  await page.mouse.move(target.x+3,target.y+30,{steps:10});await page.mouse.move(target.x+4,target.y+30);
  await expect(cards(page).nth(8)).toHaveClass(/drop-swap/);
  await page.screenshot({path:'output/acceptance/swap-target.png'});await page.mouse.up();
  await expect.poll(()=>ids(page)).toEqual(swapped);
  const motions=await cards(page).evaluateAll(elements=>elements.flatMap(card=>card.getAnimations().map(animation=>({id:card.dataset.frameId,frames:animation.effect.getKeyframes()}))));
  expect(motions.map(motion=>motion.id).sort()).toEqual([original[1],original[8]].sort());
  expect(motions.every(motion=>motion.frames[0].transform!=='translate(0px, 0px)' && motion.frames.at(-1).transform==='translate(0px, 0px)')).toBe(true);
  await page.screenshot({path:'output/acceptance/swap-motion.png'});
  await page.evaluate(()=>document.getAnimations().forEach(animation=>animation.finish()));
  await expect(cards(page).locator('.frame-info')).toHaveText(['001','009','003','004','005','006','007','008','002','010','011','012']);
  await expect(page.locator('#edit-grid input:checked')).toHaveCount(0);
  await expect(page.locator('#edit-frame-label')).toHaveAttribute('title',/第1 \/ 12帧/);
  await page.locator('#edit-undo').click();expect(await ids(page)).toEqual(original);
  await page.evaluate(()=>document.getAnimations().forEach(animation=>animation.finish()));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('#edit-all').click();const box=await cards(page).nth(8).boundingBox();
  await cards(page).nth(1).dragTo(cards(page).nth(8),{targetPosition:{x:box.width-3,y:30}});
  await expect.poll(()=>ids(page)).toEqual(swapped);
  expect(await cards(page).evaluateAll(elements=>elements.flatMap(card=>card.getAnimations()).length)).toBe(0);
  await expect(page.locator('#edit-grid input:checked')).toHaveCount(12);
  await page.locator('#edit-undo').click();await page.locator('#edit-redo').click();
  expect((await ids(page))[8]).toBe(original[1]);await expect(page.locator('#edit-grid input:checked')).toHaveCount(12);
  await page.screenshot({path:'output/acceptance/swap-desktop.png'});
  await page.locator('#edit-undo').click();await page.locator('#edit-none').click();
  const scroll=await page.locator('#edit-scroll').boundingBox();
  await cards(page).first().dragTo(page.locator('#edit-scroll'),{targetPosition:{x:10,y:scroll.height-10}});
  await expect.poll(()=>ids(page)).toEqual([...original.slice(1),original[0]]);
  await expect(page.locator('#edit-grid input:checked')).toHaveCount(0);expect(errors).toEqual([]);
});

test('真实单帧拖放、原尺寸/缩放/播放、实际v3下载',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await extract(page);
  await fs.mkdir(path.resolve('output/acceptance'),{recursive:true});
  await legacyDownload(page,'source','output/acceptance/organizer-source.zip');
  await page.locator('#organize').click();await expect(cards(page)).toHaveCount(12);const original=await ids(page);
  await cards(page).nth(1).locator('.frame-check').check();await cards(page).nth(2).locator('.frame-check').check();
  await cards(page).nth(1).dragTo(cards(page).nth(8),{targetPosition:{x:3,y:30}});
  const swapped=[...original];[swapped[1],swapped[8]]=[swapped[8],swapped[1]];
  await expect.poll(()=>ids(page)).toEqual(swapped);
  await page.locator('#edit-undo').click();expect(await ids(page)).toEqual(original);
  await expect(page.locator('#edit-grid input:checked')).toHaveCount(2);
  await cards(page).nth(1).dragTo(cards(page).nth(8),{targetPosition:{x:3,y:30}});
  await expect.poll(()=>ids(page)).toEqual(swapped);
  await page.locator('#edit-delete').click();await expect(cards(page)).toHaveCount(10);
  const expected=await ids(page);await page.locator('#edit-100').click();await expect(page.locator('#edit-zoom-label')).toHaveText('100%');
  await expect.poll(()=>page.locator('#edit-image').evaluate(image=>image.naturalWidth)).toBe(320);
  await page.locator('#edit-zoom-in').click();await expect(page.locator('#edit-zoom-label')).toHaveText('125%');
  await page.locator('#edit-all').click();await cards(page).first().click();await page.locator('#edit-play').click();await expect(page.locator('#edit-frame-label')).not.toContainText('1 / 10');await page.locator('#edit-play').click();
  await page.screenshot({path:'output/acceptance/organizer-desktop.png'});
  await page.locator('#edit-play-fps').fill('6');
  await legacyDownload(page,'organized','output/acceptance/organized-frames.zip',await ownedSessions.get(page)[0]);
  await fs.writeFile('output/acceptance/organized-order.json',JSON.stringify(expected));
  // 测试直接调用兼容接口不等于用户完成统一导出，不能清网页脏状态。
  await expect(page.locator('#edit-meta')).toContainText('未导出');expect(errors).toEqual([]);
});

test('新抽帧清空编辑历史，新整理状态独立',async({page})=>{
  await enter(page);const original=await ids(page);await cards(page).first().locator('.frame-check').check();await page.locator('#edit-delete').click();const modified=await ids(page);
  await page.locator('#tab-extract').click();await page.locator('#fps').fill('15');await page.locator('#extract').click();await expect(page.locator('#result-meta')).toContainText('15 帧');
  await expect(cards(page)).toHaveCount(0);
  await page.locator('#organize').click();await expect(cards(page)).toHaveCount(15);expect(await ids(page)).not.toEqual(original);
  await expect(page.locator('#edit-undo')).toBeDisabled();
  await cards(page).first().locator('.frame-check').check();await page.locator('#edit-delete').click();const before=await ids(page);
  expect(await ids(page)).toEqual(before);expect(modified).toHaveLength(11);
});

test('整理工作区窗口矩阵与无额外导入入口',async({page})=>{
  await enter(page);
  for(const size of [{width:1366,height:768},{width:1024,height:768},{width:800,height:600},{width:390,height:844}]){
    await page.setViewportSize(size);
    const issues=await page.evaluate(()=>{
      const issues=[];if(document.documentElement.scrollWidth>innerWidth || document.documentElement.scrollHeight>innerHeight)issues.push('整页溢出');
      for(const element of document.querySelectorAll('#workflow-steps,.topbar .brand,#organizer-workspace .edit-toolbar button,#edit-export,#edit-viewport,.edit-zoom-controls,#organizer-workspace footer')){const rect=element.getBoundingClientRect();if(rect.right>innerWidth || rect.bottom>innerHeight || rect.top<0 || rect.left<0)issues.push(element.id || element.className);}
      if(document.querySelector('#edit-scroll').scrollWidth>document.querySelector('#edit-scroll').clientWidth+1)issues.push('帧区横向溢出');return issues;
    });expect(issues).toEqual([]);
    await expect(page.locator('#organizer-workspace input[type=file]')).toHaveCount(0);
    await page.screenshot({path:`output/acceptance/organizer-${size.width}.png`});
  }
});

test('交接等待中禁重复交接与重新抽帧',async({page})=>{
  await extract(page);let release;const gate=new Promise(resolve=>release=resolve);
  await page.route('**/api/edit-sessions',async route=>{await gate;await route.continue();});
  await page.locator('#organize').click();
  try{await expect(page.locator('#organize')).toBeDisabled();await expect(page.locator('#extract')).toBeDisabled();await expect(page.locator('#open')).toBeDisabled();}
  finally{release();}
  await expect(page.locator('#organizer-workspace')).toBeVisible();
});

test('步骤栏往返保留编辑与会话，统一导出锁定，移除返回与结束入口',async({page})=>{
  const errors=[],prompts=[],deleted=[];page.on('pageerror',reason=>errors.push(reason.message));
  page.on('dialog',dialog=>{prompts.push(dialog.message());dialog.dismiss();});
  page.on('request',request=>{if(request.method()==='DELETE' && /\/api\/edit-sessions\//.test(request.url()))deleted.push(request.url());});
  await page.goto('/');await expect(page.locator('#organize')).toBeDisabled();
  await enter(page);await expect(page.locator('#workflow-steps #organize')).toHaveAttribute('aria-selected','true');
  await expect(page.locator('#edit-back,#edit-finish,.parameters #organize')).toHaveCount(0);
  await expect(page.locator('#edit-export,#download')).toHaveCount(0);await expect(page.locator('#tab-export')).toBeEnabled();
  await cards(page).first().locator('.frame-check').check();await page.locator('#edit-delete').click();
  await cards(page).nth(4).locator('.frame-check').check();await cards(page).nth(5).locator('.frame-preview').click();
  await page.locator('#edit-play-fps').fill('6');
  const before=await ids(page),image=await page.locator('#edit-image').getAttribute('src');
  for(let attempt=0;attempt<2;attempt++){
    await page.locator('#tab-extract').click();await expect(page.locator('#extract-workspace')).toBeVisible();await expect(page.locator('#tab-extract')).toHaveAttribute('aria-selected','true');
    await page.locator('#organize').click();await expect(cards(page)).toHaveCount(11);expect(await ids(page)).toEqual(before);
    await expect(page.locator('#edit-grid input:checked')).toHaveCount(1);await expect(page.locator('#edit-image')).toHaveAttribute('src',image);
    await expect(page.locator('#edit-undo')).toBeEnabled();await expect(page.locator('#edit-play-fps')).toHaveValue('6');await expect(page.locator('#organize')).toHaveAttribute('aria-selected','true');
  }
  expect(deleted).toEqual([]);expect(prompts).toEqual([]);expect(ownedSessions.get(page)).toHaveLength(1);
  await page.screenshot({path:'output/acceptance/sidebar-organizer.png'});
  await page.locator('#edit-undo').click();await expect(cards(page)).toHaveCount(12);expect(errors).toEqual([]);
});

test('M2真实600帧滚动、末帧检查及拖动撤销，源身份不变',async({page})=>{
  const limitFixture=path.resolve('output/fixtures/organizer-limit.mp4');
  execFileSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y','-stream_loop','4','-i',fixture,'-map','0:v:0','-an','-c:v','copy','-t','10',limitFixture],{timeout:10000,windowsHide:true});
  await page.goto('/');await page.locator('#file').setInputFiles(limitFixture);await expect(page.locator('#status')).toHaveText('已导入');
  await page.locator('#fps').fill('60');await page.locator('#extract').click();await expect(page.locator('#result-meta')).toContainText('600 帧');
  await page.locator('#organize').click();await expect(cards(page)).toHaveCount(600);const original=await ids(page);
  await cards(page).last().click();await expect(page.locator('#edit-frame-label')).toHaveAttribute('title',/第600 \/ 600帧/);
  await cards(page).last().locator('.frame-check').check();
  await expect.poll(()=>page.locator('#edit-image').evaluate(image=>image.naturalWidth)).toBe(320);
  await expect.poll(()=>page.locator('#edit-scroll').evaluate(element=>element.scrollTop)).toBeGreaterThan(0);
  await cards(page).last().dragTo(cards(page).nth(598),{targetPosition:{x:3,y:30}});const next=await ids(page);
  expect(next[598]).toBe(original[599]);expect(next[599]).toBe(original[598]);await expect(page.locator('#edit-meta')).toContainText('保留 600 帧');
  await page.locator('#edit-undo').click();expect(await ids(page)).toEqual(original);
  await page.screenshot({path:'output/acceptance/organizer-600.png'});
});

test('勾选标记、范围与取消及撤销一致，查看不改勾选',async({page})=>{
  await enter(page);
  const checked=()=>cards(page).evaluateAll(elements=>elements.map((element,index)=>{
    return {index,selected:element.classList.contains('is-checked'),checked:element.querySelector('.frame-check').checked};
  }));
  const count=async total=>{await expect.poll(async()=>{const states=await checked();expect(states.every(state=>state.selected===state.checked)).toBe(true);return states.filter(state=>state.checked).length;}).toBe(total);};
  await count(0);
  const before=await cards(page).nth(2).boundingBox();await cards(page).nth(2).locator('.frame-check').check();await count(1);
  expect(await cards(page).nth(2).boundingBox()).toEqual(before);
  await cards(page).nth(4).locator('.frame-check').check();await count(2);
  await cards(page).nth(6).locator('.frame-check').click({modifiers:['Shift']});await count(3);
  await cards(page).nth(8).locator('.frame-preview').click();await count(3);
  await page.screenshot({path:'output/acceptance/selection-check-desktop.png'});
  await page.setViewportSize({width:390,height:844});await count(3);
  await page.screenshot({path:'output/acceptance/selection-check-mobile.png'});
  await page.locator('#edit-none').click();await count(0);
  await page.locator('#edit-all').click();await count(12);
  await page.locator('#edit-delete').click();await expect(cards(page)).toHaveCount(0);
  await page.locator('#edit-undo').click();await count(12);
  await page.locator('#edit-redo').click();await expect(cards(page)).toHaveCount(0);
});
