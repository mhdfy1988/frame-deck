import {test,expect} from '@playwright/test';
import path from 'node:path';
const fixture=path.resolve('output/fixtures/自制 动作测试.mp4');
test('固定工作台、弹窗预览、侧栏键盘、导出锁定及旧整理更新提示',async({page,request})=>{
  const errors=[],sessions=[];page.on('pageerror',reason=>errors.push(reason.message));
  page.on('response',response=>{if(response.request().method()==='POST' && response.url().endsWith('/api/edit-sessions') && response.ok())sessions.push(response.json().then(body=>body.id));});
  try{
    await page.goto('/');await page.locator('#file').setInputFiles(fixture);await expect(page.locator('#status')).toHaveText('已导入');
    await expect(page.locator('#extract-workspace .source-panel #open')).toHaveText('换视频');
    await expect(page.locator('#extract-workspace .source-meta #filename')).toHaveText(path.basename(fixture));
    await expect(page.locator('.topbar #open,.topbar #filename,.topbar #file')).toHaveCount(0);
    await page.locator('#start').fill('.25');await page.locator('#end').fill('1.25');await page.locator('#extract').click();await expect(page.locator('#result-meta')).toContainText('12 帧');
    await expect(page.locator('#extract-complete')).toBeVisible();
    await expect(page.locator('#results .section-title #play')).toBeEnabled();
    await page.locator('#play').click();await expect(page.locator('#viewer')).toBeVisible();
    await expect(page.locator('#viewer-play')).toHaveText('暂停');await page.locator('#close-viewer').click();
    await page.locator('#grid .frame').nth(4).click();await expect(page.locator('#viewer')).toBeVisible();
    await expect(page.locator('#viewer')).toHaveAttribute('open','');await expect(page.locator('#viewer-title')).toHaveText('第 5 / 12 帧');
    await expect(page.locator('#video')).toBeVisible();await page.locator('#close-viewer').click();await expect(page.locator('#viewer')).not.toBeVisible();
    const geometry=async id=>page.locator(`#${id} .workarea`).evaluate(element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
    for(const size of [{width:1440,height:1000},{width:800,height:600},{width:390,height:844}]){
      await page.setViewportSize(size);const before=await geometry('extract-workspace');
      await page.locator('#play').click();await expect(page.locator('#viewer')).toHaveAttribute('open','');
      expect(await geometry('extract-workspace')).toEqual(before);
      expect(await page.locator('#viewer').evaluate(element=>{const r=element.getBoundingClientRect();return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight;})).toBe(true);
      await page.screenshot({path:`output/acceptance/frame-modal-${size.width}.png`});
      await page.keyboard.press('Escape');await expect(page.locator('#viewer')).not.toBeVisible();await expect(page.locator('#viewer-play')).toHaveText('播放');await expect(page.locator('#play')).toBeFocused();
      await page.locator('#organize').click();
      await expect(page.locator('#organizer-workspace')).toBeVisible();
      const processing=await geometry('organizer-workspace');
      expect(processing.x).toBe(before.x);expect(processing.width).toBe(before.width);
      expect(processing.y+processing.height).toBe(before.y+before.height);
      expect(await page.locator('#process-mode').evaluate(element=>{const r=element.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;})).toBe(true);
      await expect(page.locator('#edit-export')).toHaveCount(0);await expect(page.locator('#open')).toBeHidden();await expect(page.locator('#filename')).toBeHidden();
      await page.screenshot({path:`output/acceptance/sidebar-edit-${size.width}.png`});
      await page.locator('#tab-extract').click();expect(await geometry('extract-workspace')).toEqual(before);
      await expect(page.locator('#open')).toBeVisible();await expect(page.locator('#filename')).toHaveText(path.basename(fixture));
    }
    await page.locator('#tab-extract').focus();await page.keyboard.press('ArrowRight');await expect(page.locator('#organize')).toBeFocused();
    await expect(page.locator('#extract-workspace')).toBeVisible();await page.keyboard.press('Enter');await expect(page.locator('#organizer-workspace')).toBeVisible();
    await page.locator('#edit-grid .frame-check').first().check();await page.locator('#edit-delete').click();await expect(page.locator('#edit-grid .frame')).toHaveCount(11);
    await page.setViewportSize({width:1440,height:1000});await page.locator('#edit-100').click();await page.locator('#edit-zoom-in').click();
    const transform=await page.locator('#edit-image').getAttribute('style');await page.locator('#tab-extract').click();await page.locator('#organize').click();
    await expect(page.locator('#edit-image')).toHaveAttribute('style',transform);
    await expect(page.locator('#tab-extract')).toBeEnabled();
    await page.locator('#tab-extract').click();await page.locator('#fps').fill('15');await page.locator('#extract').click();await expect(page.locator('#result-meta')).toContainText('15 帧');
    await expect(page.locator('#edit-grid .frame')).toHaveCount(0);
    await page.locator('#organize').click();await expect(page.locator('#edit-grid .frame')).toHaveCount(15);
    await expect(page.locator('#edit-undo')).toBeDisabled();
    await expect(page.locator('#organize')).not.toHaveClass(/needs-update/);expect(errors).toEqual([]);
  }finally{for(const id of await Promise.all(sessions))expect((await request.delete(`/api/edit-sessions/${id}`)).ok()).toBe(true);}
});
