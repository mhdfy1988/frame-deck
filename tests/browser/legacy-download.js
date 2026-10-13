import fs from 'node:fs/promises';
// 原工作区入口已删除，保留后端原字节输出的独立契约验证。
export async function legacyDownload(page,kind,target,existingSession=null){
  const jobId=await page.locator('#grid img').first().evaluate(image=>image.src.match(/\/api\/jobs\/([a-f0-9]{32})/)[1]);
  let response,session;
  try{
    if(kind==='source')response=await page.request.get(`/api/jobs/${jobId}/download`);
    else{
      if(existingSession)session=existingSession;
      else{const opened=await page.request.post('/api/edit-sessions',{data:{jobId}});if(!opened.ok())throw new Error(await opened.text());session=(await opened.json()).id;}
      const frameIds=await page.locator('#edit-grid .frame').evaluateAll(cards=>cards.map(card=>card.dataset.frameId));
      response=await page.request.post(`/api/edit-sessions/${session}/export`,{data:{frameIds}});
    }
    if(!response.ok())throw new Error(await response.text());
    await fs.writeFile(target,await response.body());
  }finally{if(session&&!existingSession)await page.request.delete(`/api/edit-sessions/${session}`);}
}
