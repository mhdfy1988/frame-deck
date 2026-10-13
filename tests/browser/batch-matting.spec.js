import {test,expect} from '@playwright/test';
import path from 'node:path';

const fixture=path.resolve('output/fixtures/自制 动作测试.mp4');
const batchId='a'.repeat(32);

test('透明序列播放、双击精修、自动同步与失败关闭重试',async({page,request})=>{
  const errors=[],sessions=[];
  page.on('pageerror',reason=>errors.push(reason.message));
  page.on('response',response=>{if(response.request().method()==='POST'&&response.url().endsWith('/api/edit-sessions')&&response.ok())sessions.push(response.json().then(body=>body.id));});
  let ids=[],jobId=null,sequence=null,saveBytes=null,revision=0,failSave=false,failedSaves=0;
  try{
    await page.goto('/');await page.locator('#file').setInputFiles(fixture);
    await expect(page.locator('#status')).toHaveText('已导入');
    await page.locator('#start').fill('.25');await page.locator('#end').fill('.75');
    await page.locator('#extract').click();await expect(page.locator('#result-meta')).toContainText('6 帧');
    await page.locator('#organize').click();await expect(page.locator('#edit-grid .frame')).toHaveCount(6);
    // 只勾一帧；批量抠图仍要接收全部保留帧。
    await page.locator('#edit-grid .frame-check').first().check();
    const sessionId=await sessions[0];
    jobId=await page.evaluate(()=>document.querySelector('#edit-grid .frame img').src.match(/\/api\/jobs\/([a-f0-9]{32})/)[1]);
    const sourceJob=(await (await request.get(`/api/jobs/${jobId}`)).json()).sequence;
    await page.route('**/api/matting-batches**',async route=>{
      const url=new URL(route.request().url()),parts=url.pathname.split('/').filter(Boolean);
      const method=route.request().method();
      if(parts.length===2&&method==='POST'){
        const payload=route.request().postDataJSON();
        expect(payload.sessionId).toBe(sessionId);
        ids=payload.frameIds;
        sequence={...sourceJob,formatVersion:4,frames:ids.map((id,index)=>({...sourceJob.frames.find(frame=>frame.id===id),image:`frames/frame_${String(index+1).padStart(6,'0')}.png`,matting:{manual:false,model:'mock'}}))};
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:batchId,status:'running',total:ids.length,completed:0})});
      }
      if(parts.length===3&&method==='GET')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:batchId,sourceJobId:jobId,processingPolicy:'model-local-despill-v1',status:'done',stage:'完成',total:ids.length,completed:ids.length,sequence,revisions:Object.fromEntries(ids.map(id=>[id,revision])),modifiedFrameIds:[]})});
      if(parts.length===6&&method==='GET'){
        const id=parts[4],variant=parts[5],index=sourceJob.frames.findIndex(frame=>frame.id===id)+1;
        const response=await request.get(`/api/jobs/${jobId}/frames/${index}`);
        return route.fulfill({status:200,contentType:'image/png',body:variant==='current'&&saveBytes?saveBytes:await response.body()});
      }
      if(parts.length===5&&method==='PUT'){
        if(failSave){failedSaves++;return route.fulfill({status:500,contentType:'application/json',body:'{"detail":"模拟同步故障"}'});}
        expect(url.searchParams.get('revision')).toBe(String(revision));
        saveBytes=route.request().postDataBuffer();
        expect(saveBytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))).toBe(true);
        revision++;
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({revision,modified:true})});
      }
      return route.fulfill({status:404,contentType:'application/json',body:'{"detail":"not mocked"}'});
    });
    await page.locator('#tab-matting').click();await expect(page.locator('#matting-workspace')).toBeVisible();
    await page.locator('#matting-start').click();
    // 首次安装状态查询是异步的，卡片占位出现不等于已提交批量任务。
    await expect.poll(()=>ids.length).toBe(6);
    await expect(page.locator('#matting-grid .frame')).toHaveCount(6);
    expect(ids).toHaveLength(6);
    await expect(page.locator('#matting-repair,.matting-card-repair')).toHaveCount(0);
    await page.locator('#matting-fps').fill('2');await page.locator('#matting-play').click();
    await expect(page.locator('#matting-play')).toContainText('暂停');
    await expect(page.locator('#matting-frame-label')).not.toHaveText('1 / 6');
    await expect(page.locator('#matting-image')).toHaveAttribute('src',/matting-batches.*\/current/);
    await page.locator('#matting-play').click();
    await page.locator('#matting-fps').fill('0');await page.locator('#matting-frame-label').click();
    await expect(page.locator('#matting-fps')).toHaveValue('2');
    await page.locator('#matting-grid .matting-card-preview').first().click();
    // 大画布的固有尺寸不得撑高预览，再被容器裁掉。
    await page.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
      const context=canvas.getContext('2d');context.fillStyle='#b94835';context.fillRect(0,0,1280,720);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const image=document.getElementById('matting-image');image.src=URL.createObjectURL(blob);await image.decode();
    });
    for(const size of [{width:1440,height:1000},{width:1920,height:900},{width:800,height:600},{width:390,height:844}]){
      await page.setViewportSize(size);
      expect(await page.locator('#matting-image').evaluate(image=>{
        const r=image.getBoundingClientRect(),parent=image.parentElement.getBoundingClientRect();
        return r.top>=parent.top-1&&r.bottom<=parent.bottom+1&&r.left>=parent.left-1&&r.right<=parent.right+1&&getComputedStyle(image).objectFit==='contain'&&parent.height>0;
      })).toBe(true);
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#matting-grid .matting-card-preview').first().dblclick();
    await expect(page.locator('#repair-dialog')).toBeVisible();
    const frame=page.frameLocator('#repair-frame');
    await expect(frame.locator('#message')).toContainText('修补当前帧');
    await expect(frame.locator('#downloadButton')).toBeHidden();
    await expect(frame.locator('body')).toHaveCSS('background-color','rgb(238, 242, 238)');
    await expect(frame.locator('.edit-toolbar')).toHaveCSS('background-color','rgb(255, 255, 255)');
    await expect(frame.locator('[data-tool=move]')).toHaveCSS('color','rgb(33, 107, 88)');
    await expect(frame.locator('.zoom-controls')).toHaveCSS('color-scheme','light');
    await page.screenshot({path:'output/acceptance/frame-deck-light-repair.png'});
    await expect(frame.locator('[data-tool=remove]')).toHaveText('去除');
    await expect(frame.locator('[data-tool=restore]')).toHaveText('恢复');
    await expect(frame.locator('[data-tool=wand]')).toHaveText('魔法棒');
    await expect(frame.locator('[data-tool=remove] svg')).toHaveClass(/lucide-eraser/);
    await frame.locator('[data-tool=remove]').click();
    const box=await frame.locator('.result-pane').boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.down();await page.mouse.move(box.x+box.width/2+15,box.y+box.height/2+10,{steps:4});await page.mouse.up();
    await expect(frame.locator('#undoButton')).toBeEnabled();
    await expect(frame.locator('#message')).toContainText('已实时同步');
    await page.screenshot({path:'output/live-repair-validation-20261007/repair-auto-sync.png'});
    await expect(page.locator('#matting-status')).toContainText('已同步');
    failSave=true;await frame.locator('#undoButton').click();
    await expect(frame.locator('#message')).toContainText('自动同步失败');
    await page.locator('#repair-close').click();
    await expect.poll(()=>failedSaves).toBe(2);
    await expect(frame.locator('#redoButton')).toBeEnabled();
    await expect(page.locator('#repair-dialog')).toBeVisible();
    await expect(page.locator('#matting-error')).toContainText('自动同步失败');
    failSave=false;
    await page.locator('#repair-close').click();await expect(page.locator('#repair-dialog')).not.toBeVisible();
    expect(revision).toBe(2);
    await page.locator('#matting-image').dblclick();
    await expect(page.locator('#repair-dialog')).toBeVisible();
    await expect(frame.locator('#message')).toContainText('修补当前帧');
    await page.locator('#repair-close').click();await expect(page.locator('#repair-dialog')).not.toBeVisible();
    const savedId=ids[0];
    await page.locator('#process-organize').click();
    await page.locator('#edit-grid .frame-check').first().check();
    await page.locator('#edit-delete').click();
    await page.locator('#tab-matting').click();
    await expect(page.locator('#matting-grid .frame')).toHaveCount(5);
    await expect(page.locator('#matting-start')).toHaveText('重新抠图');
    expect(await page.locator('#matting-grid .frame').evaluateAll(cards=>cards.map(card=>card.dataset.frameId))).not.toContain(savedId);
    await page.locator('#process-organize').click();
    await page.locator('#edit-undo').click();
    await page.locator('#tab-matting').click();
    await expect(page.locator('#matting-grid .frame')).toHaveCount(6);
    await expect(page.locator('#matting-grid .frame img').first()).toHaveAttribute('src',/revision=2/);
    expect(saveBytes).toBeTruthy();expect(errors).toEqual([]);
  }finally{for(const id of await Promise.all(sessions))await request.delete(`/api/edit-sessions/${id}`);}
});
