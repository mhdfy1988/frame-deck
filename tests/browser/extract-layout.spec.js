import {test,expect} from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';

for(const viewport of [{width:1366,height:768},{width:800,height:600},{width:390,height:844}]){
test(`提取任务开始、运行和完成时原视频区域保持不动 ${viewport.width}×${viewport.height}`,async({page})=>{
  await page.setViewportSize(viewport);
  await page.goto('/');
  await page.locator('#file').setInputFiles(path.resolve('output/fixtures/自制 动作测试.mp4'));
  await expect(page.locator('#status')).toHaveText('已导入');
  await expect.poll(()=>page.locator('#video').evaluate(video=>video.readyState)).toBeGreaterThanOrEqual(2);
  await page.locator('#video').evaluate(async video=>{
    video.pause();
    await new Promise(resolve=>{video.addEventListener('seeked',resolve,{once:true});video.currentTime=.5;});
  });
  const geometry=()=>page.evaluate(()=>Object.fromEntries(['dropzone','range','extract','video'].map(id=>{
    const rect=document.getElementById(id).getBoundingClientRect();
    return [id,{x:rect.x,y:rect.y,width:rect.width,height:rect.height}];
  })));
  const before=await geometry();
  const previewBefore=await page.locator('#video').evaluate(video=>({time:video.currentTime,src:video.currentSrc}));
  // 只延迟本页首次状态请求，让运行态可稳定观测；响应及抽帧仍来自真实接口。
  let release;
  const gate=new Promise(resolve=>release=resolve);
  let held=false;
  await page.route(/\/api\/jobs\/[^/]+$/,async route=>{
    if(route.request().method()==='GET' && !held){held=true;await gate;}
    await route.continue();
  });
  await page.locator('#extract').click();
  let running;
  try{
    await expect(page.locator('#cancel')).toBeVisible();
    running=await geometry();
    await fs.mkdir(path.resolve('output/acceptance'),{recursive:true});
    await page.screenshot({path:`output/acceptance/extract-running-${viewport.width}.png`});
    expect(await page.locator('#video').evaluate(video=>({time:video.currentTime,src:video.currentSrc}))).toEqual(previewBefore);
    expect(running).toEqual(before);
  }finally{release();}
  await expect(page.locator('#result-meta')).toContainText('24 帧');
  await expect(page.locator('#cancel')).toBeHidden();
  const after=await geometry();
  expect(after).toEqual(before);
  expect(await page.locator('#video').evaluate(video=>({time:video.currentTime,src:video.currentSrc}))).toEqual(previewBefore);
  // 重复采样提示只调整右侧网格，不应带动原视频及参数栏。
  await page.locator('#fps').fill('60');await page.locator('#extract').click();
  await expect(page.locator('#result-meta')).toContainText('120 帧');await expect(page.locator('#cancel')).toBeHidden();
  const repeat=await geometry();expect(repeat).toEqual(before);
  await fs.writeFile(`output/acceptance/extract-layout-${viewport.width}.json`,JSON.stringify({before,running,after,repeat,previewBefore},null,2));
});
}
