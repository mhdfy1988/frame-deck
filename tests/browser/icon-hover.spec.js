import {test,expect} from '@playwright/test';

test('精修选中工具悬浮保持深底白字，普通工具保持深色文字',async({page})=>{
  // 只读取实际静态样式，不创建任务或改变主入口素材。
  await page.goto('/');
  await page.setContent(`<link rel="stylesheet" href="/assets/matting/style-N4TP222V.css">
    <link rel="stylesheet" href="/assets/icons.css">
    <div class="edit-toolbar"><button class="tool-icon with-icon" aria-pressed="true">魔法棒</button>
    <button class="tool-icon with-icon" aria-pressed="false">去除</button></div>`);
  const selected=page.getByRole('button',{name:'魔法棒'});
  await expect(selected).toHaveCSS('background-color','rgb(36, 94, 232)');
  await selected.hover();
  await expect(selected).toHaveCSS('background-color','rgb(25, 79, 201)');
  await expect(selected).toHaveCSS('color','rgb(255, 255, 255)');
  const normal=page.getByRole('button',{name:'去除'});
  await normal.hover();
  await expect(normal).toHaveCSS('background-color','rgb(237, 242, 250)');
  await expect(normal).toHaveCSS('color','rgb(70, 86, 80)');
});
