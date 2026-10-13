import {test,expect} from '@playwright/test';
import {legacyDownload} from './legacy-download.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const fixture=path.resolve('output/fixtures/loop-demo.mp4');
const sessions=new WeakMap(),errors=new WeakMap();
test.beforeEach(async({page})=>{
  const identities=[],messages=[];sessions.set(page,identities);errors.set(page,messages);
  page.on('pageerror',error=>messages.push(error.message));
  page.on('response',response=>{if(response.request().method()==='POST' && response.url().endsWith('/api/edit-sessions') && response.ok())identities.push(response.json().then(body=>body.id));});
});
test.afterEach(async({page,request})=>{
  for(const id of await Promise.all(sessions.get(page)))expect((await request.delete(`/api/edit-sessions/${id}`)).ok()).toBe(true);
  expect(errors.get(page)).toEqual([]);
});
async function enter(page){
  await page.goto('/');await page.locator('#file').setInputFiles(fixture);await expect(page.locator('#status')).toHaveText('已导入');
  await page.locator('#end').fill('4');await page.locator('#fps').fill('12');await page.locator('#extract').click();
  await expect(page.locator('#result-meta')).toContainText('48 帧');await page.locator('#organize').click();
  await expect(page.locator('#edit-grid .frame')).toHaveCount(48);
}
async function candidates(page){
  await page.locator('#edit-find-loop').click();await expect(page.locator('#loop-dialog')).toBeVisible();
  await expect(page.locator('#loop-state')).toContainText('找到');
  await expect(page.locator('.loop-candidate').first().locator('strong')).toHaveText('12 帧');
  const candidate=page.locator('.loop-candidate').filter({has:page.locator('strong',{hasText:/^12 帧$/})}).first();
  await expect(candidate).toBeVisible();await candidate.click();
  await expect(page.locator('#loop-image')).toHaveAttribute('src',/\/frames\/\d+$/);
  return candidate;
}
const snapshot=page=>page.locator('#edit-grid .frame').evaluateAll(items=>items.map(item=>({id:item.dataset.frameId,number:item.querySelector('.frame-info').textContent,checked:item.querySelector('input').checked,active:item.classList.contains('is-active')})));

test('真实工作线程寻找12帧周期，取消/切候选/键盘不影响主序列，桌面窄屏单屏预览',async({page})=>{
  await enter(page);await page.locator('#edit-grid .frame-check').nth(3).check();await page.locator('#edit-grid .frame-preview').nth(6).click();
  const original=await snapshot(page),mainImage=await page.locator('#edit-image').getAttribute('src');
  await candidates(page);expect(await page.locator('.loop-candidate').count()).toBeLessThanOrEqual(5);
  await page.keyboard.press('Control+a');await page.keyboard.press('Delete');expect(await snapshot(page)).toEqual(original);
  await expect(page.locator('#loop-position')).toHaveText('1 / 12');await page.locator('#loop-next').click();await expect(page.locator('#loop-position')).toHaveText('2 / 12');
  await page.locator('#loop-previous').click();await expect(page.locator('#loop-position')).toHaveText('1 / 12');
  await page.locator('#loop-previous').click();await expect(page.locator('#loop-position')).toHaveText('12 / 12');
  await page.locator('#loop-play').click();await expect(page.locator('#loop-play')).toHaveText('暂停');
  await expect.poll(()=>page.locator('#loop-position').textContent()).not.toBe('12 / 12');await page.locator('#loop-play').click();
  await page.screenshot({path:'output/acceptance/loop-candidates-desktop.png'});
  for(const size of [{width:800,height:600},{width:390,height:844}]){
    await page.setViewportSize(size);
    const visible=await page.locator('#loop-dialog').evaluate(dialog=>{
      const within=element=>{const r=element.getBoundingClientRect();return r.width>0 && r.height>0 && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;};
      return ['#loop-apply','#loop-cancel','#loop-play','#loop-image'].every(id=>within(dialog.querySelector(id))) && document.documentElement.scrollHeight<=innerHeight;
    });expect(visible).toBe(true);
  }
  await page.screenshot({path:'output/acceptance/loop-candidates-mobile.png'});
  await page.locator('#loop-cancel').click();await expect(page.locator('#loop-dialog')).not.toBeVisible();expect(await snapshot(page)).toEqual(original);
  await expect(page.locator('#edit-image')).toHaveAttribute('src',mainImage);await expect(page.locator('#edit-undo')).toBeDisabled();
  await candidates(page);await page.keyboard.press('Escape');await expect(page.locator('#loop-dialog')).not.toBeVisible();expect(await snapshot(page)).toEqual(original);
});

test('确认只保留区间、一步撤销恢复、真实下载PNG字节和身份顺序不变',async({page,request})=>{
  await enter(page);await page.locator('#edit-grid .frame-check').nth(40).check();await page.locator('#edit-grid .frame-preview').nth(40).click();
  const original=await snapshot(page);await candidates(page);
  const position=await page.locator('.loop-candidate[aria-pressed=true] small').textContent(),[start,end]=position.match(/\d+/g).map(Number);
  const expected=original.slice(start-1,end);expect(expected.length).toBe(12);
  await page.locator('#loop-apply').click();await expect(page.locator('#loop-dialog')).not.toBeVisible();
  await expect(page.locator('#edit-grid .frame')).toHaveCount(12);expect((await snapshot(page)).map(frame=>frame.id)).toEqual(expected.map(frame=>frame.id));
  await page.locator('#edit-undo').click();expect(await snapshot(page)).toEqual(original);await expect(page.locator('#edit-undo')).toBeDisabled();
  await page.locator('#edit-redo').click();await expect(page.locator('#edit-grid .frame')).toHaveCount(12);
  const target=path.resolve('output/acceptance/loop-organized.zip');await legacyDownload(page,'organized',target,await sessions.get(page)[0]);
  const sourceDir=path.resolve('output/acceptance/loop-originals');await fs.mkdir(sourceDir,{recursive:true});
  const urls=await page.locator('#edit-grid img').evaluateAll(images=>images.map(image=>image.src.replace('?thumb=true','')));
  for(const [index,url] of urls.entries())await fs.writeFile(path.join(sourceDir,`${index}.png`),await (await request.get(url)).body());
  const result=execFileSync(path.resolve('.venv/Scripts/python.exe'),['-c',
    'import json,zipfile,pathlib,sys; z=zipfile.ZipFile(sys.argv[1]); m=json.loads(z.read("frame-sequence.json")); ids=json.loads(sys.argv[3]); assert m["formatVersion"]==3; assert [f["id"] for f in m["frames"]]==ids; assert len(m["frames"])==12; assert all(z.read(f["image"])==(pathlib.Path(sys.argv[2])/f"{i}.png").read_bytes() for i,f in enumerate(m["frames"])); print("12 PNG bytes and ordered IDs verified")',
    target,sourceDir,JSON.stringify(expected.map(frame=>frame.id))],{encoding:'utf8'});
  expect(result).toContain('verified');
});

test('取消分析立即终止，旧结果不会复活；再次分析可正常完成',async({page})=>{
  await enter(page);const original=await snapshot(page);
  await page.route('**/frames/*?thumb=true',async route=>{await new Promise(resolve=>setTimeout(resolve,300));await route.continue().catch(()=>{});});
  await page.locator('#edit-find-loop').click();await page.locator('#loop-cancel').click();
  await expect(page.locator('#loop-dialog')).not.toBeVisible();await page.waitForTimeout(500);expect(await snapshot(page)).toEqual(original);
  await page.unroute('**/frames/*?thumb=true');await candidates(page);await page.locator('#loop-close').click();
});

test('分析失败显式显示且不改旧序列；少于7帧禁用；旧版本候选拒绝',async({page})=>{
  await enter(page);const original=await snapshot(page);
  await page.route('**/frames/*?thumb=true',route=>route.fulfill({status:503,body:'test failure'}));
  await page.locator('#edit-find-loop').click();await expect(page.locator('#loop-state')).toContainText('源帧读取失败');await expect(page.locator('#loop-apply')).toBeDisabled();
  await page.locator('#loop-cancel').click();expect(await snapshot(page)).toEqual(original);await page.unroute('**/frames/*?thumb=true');
  await candidates(page);
  // 人为制造版本变化，模拟未来其他入口编辑；确认入口必须拒绝旧候选。
  await page.evaluate(()=>document.querySelector('#edit-grid .frame-delete').click());
  await page.locator('#loop-apply').click();await expect(page.locator('#loop-state')).toContainText('变化');
  await expect(page.locator('#loop-apply')).toBeDisabled();await page.locator('#loop-cancel').click();await page.locator('#edit-undo').click();
  expect(await snapshot(page)).toEqual(original);
  await page.locator('#edit-all').click();await page.locator('#edit-delete').click();await expect(page.locator('#edit-find-loop')).toBeDisabled();
});

test('无可靠循环不强凑候选，静止视频真实分析返回空',async({page})=>{
  await enter(page);
  // 使用同一已解码源帧替换分析缩略图，独立验证工作线程静止路径而不改生产数据。
  const source=await page.locator('#edit-grid img').first().getAttribute('src');
  const response=await page.request.get(source),bytes=await response.body();
  await page.route('**/frames/*?thumb=true',route=>route.fulfill({status:200,contentType:'image/png',body:bytes}));
  const original=await snapshot(page);await page.locator('#edit-find-loop').click();await expect(page.locator('#loop-state')).toContainText('未找到合适循环');
  await expect(page.locator('.loop-candidate')).toHaveCount(0);await expect(page.locator('#loop-apply')).toBeDisabled();
  await page.locator('#loop-cancel').click();expect(await snapshot(page)).toEqual(original);
});
