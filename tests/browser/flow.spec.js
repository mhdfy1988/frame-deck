import {test,expect} from '@playwright/test';
import {legacyDownload} from './legacy-download.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const fixture=path.resolve('output/fixtures/自制 动作测试.mp4');
async function singleScreen(page){
  const issues=await page.evaluate(()=>{
    const issues=[];
    const root=document.documentElement;
    if(root.scrollWidth>innerWidth || root.scrollHeight>innerHeight)issues.push('页面超出窗口');
    for(const element of document.querySelectorAll('.topbar button,.parameters input,.parameters button,.timeline,.timeline label,.source-meta,.result-actions,footer,.empty>*')){
      const box=element.getBoundingClientRect();
      if(box.width && box.height && (box.left<0 || box.top<0 || box.right>innerWidth+1 || box.bottom>innerHeight+1))issues.push(`${element.id || element.className}不在屏幕内`);
      const parent=element.closest('.source-panel,.results');
      if(parent && box.width && box.height){const pane=parent.getBoundingClientRect();if(box.bottom>pane.bottom+1 || box.right>pane.right+1 || box.top<pane.top-1)issues.push('控件超出所属面板');}
    }
    const grid=document.querySelector('#grid').getBoundingClientRect();
    const scroll=document.querySelector('#frames-scroll');
    if(scroll.scrollWidth>scroll.clientWidth+1)issues.push('结果区横向溢出');
    for(const frame of document.querySelectorAll('.frame')){
      const box=frame.getBoundingClientRect();
      if(box.bottom>grid.bottom+1 || box.right>grid.right+1)issues.push('帧卡片溢出网格');
      if(frame.querySelector('img').getBoundingClientRect().height<35)issues.push('缩略图高度过小');
    }
    const actions=document.querySelector('.topbar-actions').getBoundingClientRect();
    if(actions.right>innerWidth+1)issues.push('顶部状态区溢出');
    return issues;
  });
  expect(issues).toEqual([]);
}
async function imported(page){
  await page.goto('/');await page.locator('#file').setInputFiles(fixture);
  await expect(page.locator('#status')).toHaveText('已导入');
  await expect(page.locator('#video')).toBeVisible();
  await expect.poll(()=>page.locator('#video').evaluate(video=>video.readyState)).toBeGreaterThanOrEqual(2);
}
test('真实导入、拖动、数字同步、任务、原图缩放、播放和下载',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await imported(page);await expect(page.locator('#metadata')).toContainText('320 × 180');
  const slider=page.locator('#range-start'),box=await slider.boundingBox();
  await page.mouse.move(box.x+4,box.y+12);await page.mouse.down();
  await page.mouse.move(box.x+box.width*.20,box.y+12,{steps:12});await page.mouse.up();
  const dragged=Number(await page.locator('#start').inputValue());expect(dragged).toBeGreaterThan(.1);
  await page.locator('#start').fill('0.25');await page.locator('#end').fill('1.25');
  await expect(page.locator('#range-start')).toHaveValue('0.25');await expect(page.locator('#estimate')).toHaveText('预计 12 帧');
  await page.locator('#extract').click();
  // 在任务运行时改参数，不改变本次快照；新值只影响下一次提取。
  await page.locator('#fps').fill('15');
  await expect(page.locator('#result-meta')).toContainText('12 帧');await expect(page.locator('#result-meta')).toContainText('12 fps');
  await expect(page.locator('.frame')).toHaveCount(12);await page.locator('.frame').first().click();
  await expect(page.locator('#viewer')).toBeVisible();await page.locator('#zoom-100').click();await expect(page.locator('#zoom-label')).toHaveText('100%');
  await expect.poll(()=>page.locator('#full-image').evaluate(image=>image.naturalWidth)).toBe(320);
  await page.locator('#zoom-in').click();await expect(page.locator('#zoom-label')).toHaveText('125%');
  await page.locator('#viewer-play').click();await page.waitForTimeout(190);await expect(page.locator('#viewer-title')).not.toHaveText('第 1 / 12 帧');
  await page.locator('#close-viewer').click();
  await fs.mkdir(path.resolve('output/acceptance'),{recursive:true});await legacyDownload(page,'source',path.resolve('output/acceptance/chrome-frames.zip'));
  expect((await fs.stat(path.resolve('output/acceptance/chrome-frames.zip'))).size).toBeGreaterThan(10000);
  await page.screenshot({path:'output/acceptance/desktop.png',fullPage:true});expect(errors).toEqual([]);
});
test('重新提取清旧结果、失败可重试、重复源帧提示',async({page})=>{
  await imported(page);await page.locator('#fps').fill('60');await page.locator('#extract').click();
  await expect(page.locator('#result-meta')).toContainText('120 帧');await expect(page.locator('#result-note')).toContainText('重复采样');
  await page.locator('#end').fill('4');await page.locator('#extract').click();await expect(page.locator('#error')).toContainText('超出');
  await expect(page.locator('#result-meta')).toHaveText('尚未提取');
  await expect(page.locator('.frame')).toHaveCount(0);
  await page.locator('#end').fill('2');await page.locator('#extract').click();
  await expect(page.locator('.frame')).toHaveCount(120);
  await page.locator('.frame').last().click();await expect(page.locator('#viewer-title')).toHaveText('第 120 / 120 帧');await page.locator('#close-viewer').click();
});
test('手机与窄屏无横向溢出，原图弹窗可关闭',async({page})=>{
  await page.setViewportSize({width:390,height:844});await imported(page);await page.locator('#extract').click();
  await expect(page.locator('#result-meta')).toContainText('24 帧');await singleScreen(page);
  await page.locator('.frame').first().click();await expect(page.locator('#viewer')).toBeVisible();await page.locator('#close-viewer').click();
  await page.screenshot({path:'output/acceptance/mobile.png',fullPage:true});
});
test('真实1080p任务取消，停止后可重新导入，旧历史清空',async({page})=>{
  const jobs=[];page.on('response',async response=>{if(response.url().includes('/api/jobs')){const body=await response.json().catch(()=>null);if(body)jobs.push(body);}});
  await imported(page);await page.locator('#extract').click();await expect(page.locator('#result-meta')).toContainText('24 帧');
  await page.locator('#file').setInputFiles(path.resolve('output/fixtures/large.mp4'));await expect(page.locator('#status')).toHaveText('已导入');
  await page.locator('#fps').fill('30');await page.locator('#extract').click();await page.locator('#cancel').click();
  try {await expect(page.locator('#status')).toHaveText('已取消');}finally{await fs.writeFile('output/acceptance/cancel-jobs.json',JSON.stringify(jobs,null,2));console.log('取消诊断',JSON.stringify(jobs.slice(-3)));}
  await expect(page.locator('#extract')).toBeEnabled();
  await expect(page.locator('#download')).toHaveCount(0);
  await expect(page.locator('#grid .frame')).toHaveCount(0);
});
test('非零PTS原视频预览的时间轴核对',async({page})=>{
  await page.goto('/');await page.locator('#file').setInputFiles(path.resolve('output/fixtures/offset.mp4'));
  await expect(page.locator('#status')).toHaveText('已导入');
  await expect.poll(()=>page.locator('#video').evaluate(video=>video.readyState)).toBeGreaterThanOrEqual(2);
  const info=await page.locator('#video').evaluate(video=>({duration:video.duration,currentTime:video.currentTime,seekable:video.seekable.length?{start:video.seekable.start(0),end:video.seekable.end(0)}:null}));
  await fs.writeFile('output/acceptance/offset-preview.json',JSON.stringify(info,null,2));
  expect(info.duration).toBe(2);
});

test('单屏工作台：小缩略图连续滚动、窗口矩阵及全部帧可达',async({page})=>{
  await fs.mkdir(path.resolve('output/acceptance'),{recursive:true});
  const sizes=[{width:1920,height:1080},{width:1366,height:768},{width:1280,height:720},{width:1024,height:768},{width:900,height:600},{width:800,height:600},{width:390,height:844}];
  await page.goto('/');await expect(page.locator('#play')).toBeDisabled();await expect(page.locator('#download')).toHaveCount(0);
  for(const size of sizes){await page.setViewportSize(size);await singleScreen(page);}
  await page.setViewportSize({width:1366,height:768});
  await page.screenshot({path:'output/acceptance/scroll-empty.png'});
  await page.locator('#file').setInputFiles(fixture);await expect(page.locator('#status')).toHaveText('已导入');
  await page.locator('#fps').fill('60');await page.locator('#extract').click();await expect(page.locator('#result-meta')).toContainText('120 帧');
  for(const size of sizes){
    await page.setViewportSize(size);
    await expect(page.locator('.frame')).toHaveCount(120);
    await singleScreen(page);
    const imageHeight=await page.locator('.frame img').first().evaluate(image=>image.getBoundingClientRect().height);
    expect(imageHeight).toBeLessThanOrEqual(78);
    await page.screenshot({path:`output/acceptance/scroll-${size.width}x${size.height}.png`});
  }
  await page.setViewportSize({width:1366,height:768});
  await expect(page.locator('#prev-page,#next-page,#page-label')).toHaveCount(0);
  const ids=await page.locator('.frame').evaluateAll(frames=>frames.map(frame=>frame.getAttribute('aria-label')));
  expect(ids).toEqual(Array.from({length:120},(_,index)=>`查看第${index+1}帧`));
  const before=await page.locator('#video').boundingBox();
  const scroll=page.locator('#frames-scroll');const box=await scroll.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,500);
  await expect.poll(()=>scroll.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>scrollY)).toBe(0);expect(await page.locator('#video').boundingBox()).toEqual(before);
  await page.locator('.frame').last().click();await expect(page.locator('#viewer-title')).toHaveText('第 120 / 120 帧');
  await expect.poll(()=>page.locator('#full-image').evaluate(image=>image.naturalWidth)).toBe(320);await page.locator('#close-viewer').click();
  await page.setViewportSize({width:1024,height:768});
  await expect(page.locator('.frame')).toHaveCount(120);await singleScreen(page);
  await scroll.focus();await page.keyboard.press('Control+Home');await expect.poll(()=>scroll.evaluate(element=>element.scrollTop)).toBe(0);
  await scroll.focus();await page.keyboard.press('Control+End');await expect.poll(()=>scroll.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);
  await page.locator('#end').fill('4');await page.locator('#extract').click();await expect(page.locator('#error')).toContainText('超出');await singleScreen(page);
  await expect(page.locator('.frame')).toHaveCount(0);
});

test('600帧上限全部保留，滚动至末帧并打开原尺寸',async({page})=>{
  const limitFixture=path.resolve('output/fixtures/scroll-limit.mp4');
  // 循环自制视频得到10秒夹具；只重封装，不增加编码依赖或使用私人素材。
  execFileSync('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y','-stream_loop','4','-i',fixture,'-map','0:v:0','-an','-c:v','copy','-t','10',limitFixture],{timeout:10000,windowsHide:true});
  await page.setViewportSize({width:1366,height:768});await page.goto('/');await page.locator('#file').setInputFiles(limitFixture);
  await expect(page.locator('#status')).toHaveText('已导入');await page.locator('#fps').fill('60');await page.locator('#extract').click();
  await expect(page.locator('#result-meta')).toContainText('600 帧');await expect(page.locator('.frame')).toHaveCount(600);
  expect(await page.locator('.frame').evaluateAll(frames=>frames.map(frame=>frame.getAttribute('aria-label')))).toEqual(Array.from({length:600},(_,index)=>`查看第${index+1}帧`));
  await page.locator('.frame').last().click();await expect(page.locator('#viewer-title')).toHaveText('第 600 / 600 帧');
  await expect.poll(()=>page.locator('#full-image').evaluate(image=>image.naturalWidth)).toBe(320);await page.locator('#close-viewer').click();
  await singleScreen(page);await page.screenshot({path:'output/acceptance/scroll-600-last.png'});
});
