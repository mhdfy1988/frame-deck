import {test,expect} from '@playwright/test';

test('首次安装先等待就绪、显示阶段，之后复用缓存，不触发真实下载',async({page})=>{
  let installed=false,reads=0,posts=0;
  await page.route('**/api/model-runtime',async route=>{
    reads++;
    const ready=installed&&reads>=3;
    await route.fulfill({json:{phase:ready?'ready':installed?'installing':'missing',stage:ready?'已就绪':'下载模型',ready}});
  });
  await page.route('**/api/model-runtime/install',async route=>{
    posts++;installed=true;await route.fulfill({json:{phase:'installing'}});
  });
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {ensureModelRuntime}=await import('/assets/model-runtime-ui.js');
    const stages=[];
    const api=async(path,options)=>(await fetch(path,options)).json();
    await ensureModelRuntime(api,text=>stages.push(text));
    await ensureModelRuntime(api,text=>stages.push(text));
    return stages;
  });
  expect(posts).toBe(1);
  expect(result.some(text=>text.includes('数GB'))).toBe(true);
  expect(result).toContain('下载模型');
  expect(result).toContain('已就绪');
});

test('单文件下载进度显示真实百分比，结束后隐藏',async({page})=>{
  await page.goto('/');
  await page.evaluate(()=>{
    window.downloadSamples=[];
    window.downloadFinished=false;
    import('/assets/model-runtime-ui.js').then(async({ensureModelRuntime})=>{
      let reads=0;
      await ensureModelRuntime(async path=>path.endsWith('/install')?{}:++reads===1?{ready:false}:reads===2?{
        phase:'installing',progress:{file:'model.safetensors',downloaded:1048576,total:4194304},
      }:{ready:true,stage:'已就绪'},text=>document.getElementById('matting-status').textContent=text,value=>{
        const bar=document.getElementById('model-download-progress');
        bar.hidden=value===undefined;
        if(value?.total)bar.value=value.downloaded/value.total*100;
        else bar.removeAttribute('value');
        window.downloadSamples.push(bar.value);
      });
      window.downloadFinished=true;
    });
  });
  await expect(page.locator('#matting-status')).toContainText('25%');
  await expect(page.locator('#model-download-progress')).toHaveJSProperty('value',25);
  await expect.poll(()=>page.evaluate(()=>window.downloadFinished)).toBe(true);
  await expect(page.locator('#model-download-progress')).toHaveAttribute('hidden','');
});
