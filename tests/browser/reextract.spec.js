import {test,expect} from '@playwright/test';
import path from 'node:path';
test('重新抽帧清空整理历史，连续五轮不受三任务配额阻塞',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await page.locator('#file').setInputFiles(path.resolve('output/fixtures/自制 动作测试.mp4'));
  await expect(page.locator('#status')).toHaveText('已导入');
  await page.locator('#end').fill('.5');
  for(let round=0;round<5;round++){
    await page.locator('#extract').click();await expect(page.locator('#status')).toHaveText('完成');
    await expect(page.locator('#error')).toHaveText('');
    await page.locator('#organize').click();await expect(page.locator('#edit-grid .frame')).toHaveCount(6);
    await expect(page.locator('#edit-undo')).toBeDisabled();
    await page.locator('#edit-grid .frame-check').first().check();await page.locator('#edit-delete').click();
    await expect(page.locator('#edit-grid .frame')).toHaveCount(5);
    await page.locator('#tab-extract').click();
  }
  await page.route('**/api/jobs',route=>route.fulfill({status:400,contentType:'application/json',body:'{"detail":"模拟抽帧失败"}'}));
  await page.locator('#extract').click();await expect(page.locator('#error')).toHaveText('模拟抽帧失败');
  await expect(page.locator('#grid .frame')).toHaveCount(0);await expect(page.locator('#organize')).toBeDisabled();
  await expect(page.locator('#filename')).not.toHaveText('');expect(errors).toEqual([]);
});
