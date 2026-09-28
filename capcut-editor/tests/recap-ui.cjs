'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const [originalPath,repairedPath,srtPath]=process.argv.slice(2);
if(!originalPath||!repairedPath||!srtPath)throw Error('Provide original.cutline repaired.cutline source.srt fixtures.');
const original=JSON.parse(fs.readFileSync(originalPath)),fixed=JSON.parse(fs.readFileSync(repairedPath));
const report=JSON.parse(fs.readFileSync(repairedPath+'.report.json'));
const oldIds=new Set(original.media.map(m=>m.id));
const result={ok:true,videoClips:fixed.clips.filter(c=>c.trackId==='v1'),newMedia:fixed.media.filter(m=>!oldIds.has(m.id)),count:689,motionCount:report.motionCount,freezeCount:report.freezeCount,englishScenesCount:521,voiceDuration:report.voiceEnd-report.voiceStart,videoDuration:4443.766667,report};
const output=path.join(root,'.test-output');fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(output,'recap-ui-'));
fs.mkdirSync(path.join(profile,'projects'));
const name='Auto-Cut integration test',id='proj_recap_test';original.name=name;
const projectFile=path.join(profile,'projects',id+'.cutline');
fs.writeFileSync(projectFile,JSON.stringify(original));
fs.writeFileSync(path.join(profile,'projects','projects.json'),JSON.stringify([{id,name,createdAt:Date.now(),updatedAt:Date.now(),duration:4755.86,clipCount:original.clips.length}]));
fs.writeFileSync(path.join(profile,'active-project.json'),JSON.stringify({id}));
(async()=>{
 const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],cwd:root,env:{...process.env,CUTLINE_TEST_DIR:profile}});
 try {
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{void d.dismiss().catch(()=>{});});
  page.setDefaultTimeout(20000);
  await app.evaluate(({ipcMain,dialog},data)=>{
   dialog.showOpenDialog=async()=>({canceled:false,filePaths:[data.srtPath]});
   globalThis.recapFixture=data.result;globalThis.recapDelay=false;
   ipcMain.removeHandler('recap:autoCutBySrt');
   ipcMain.handle('recap:autoCutBySrt',async(_e,spec)=>{globalThis.recapRequest=spec;if(globalThis.recapDelay)await new Promise(r=>{globalThis.finishRecap=r;});return globalThis.recapFixture;});
  },{result,srtPath});
  await page.getByText(name,{exact:true}).first().hover();
  await page.getByTitle('Үргэлжлүүлэх',{exact:true}).first().click();
  console.log('Opened test project');
  await page.getByRole('button',{name:'Text',exact:true}).click();
  const sync=page.getByRole('button',{name:/Video Sync/});await sync.click();
  const cut=page.getByRole('button',{name:/Өгүүлбэр бүрээр дүрсийг зүсэж өрөх/});
  assert.ok(await cut.isDisabled(),'Explicit source SRT is required');
  await page.getByRole('button',{name:/Англи SRT сонгох/}).click();
  await cut.click();
  await page.getByRole('status').filter({hasText:'1746/1746'}).waitFor();
  console.log('Auto-Cut applied');
  let saved=JSON.parse(fs.readFileSync(projectFile));assert.equal(saved.clips.filter(c=>c.trackId==='v1').length,result.videoClips.length);assert.equal(saved.media.filter(m=>result.newMedia.some(n=>n.id===m.id)).length,190);
  assert.ok(!(await page.getByRole('status').filter({hasText:'1746/1746'}).innerText()).includes('100%'));
  await page.keyboard.press('Control+z');await page.getByRole('button',{name:/Video Sync \(863\)/}).waitFor();
  await page.keyboard.press('Control+Shift+z');await page.getByRole('button',{name:/Video Sync \(689\)/}).waitFor();
  // Selecting a hold must load the durable PNG through the same media protocol as preview.
  await page.getByPlaceholder(/Үзэгдэл хайх/).fill('❄️');
  await page.getByText(`🎬 #${result.videoClips.find(c=>c.isFreeze).matchedSrtId}`,{exact:true}).first().click();
  await page.waitForFunction(()=>[...document.querySelectorAll('img')].some(i=>i.src.includes('recap-freeze')&&i.complete&&i.naturalWidth>0));
  await page.screenshot({path:path.join(output,'recap-ui-success.png')});
  await app.evaluate(()=>{globalThis.recapDelay=true;});
  await cut.click();
  await page.getByLabel('Project name').fill('Edited while matching');await page.getByLabel('Project name').blur();
  await app.evaluate(()=>globalThis.finishRecap());
  await page.getByRole('alert').filter({hasText:'төсөл өөрчлөгдсөн'}).waitFor();
  assert.equal(await page.getByLabel('Project name').inputValue(),'Edited while matching');
  await page.screenshot({path:path.join(output,'recap-ui-stale-guard.png')});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:['explicit SRT','atomic clips and media save','undo/redo','real freeze preview','stale response rejection','no renderer errors'],profile},null,2));
 }catch(e){const p=await app.firstWindow();await p.screenshot({path:path.join(output,'recap-ui-failure.png')}).catch(()=>{});throw e;}
 finally{await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.destroy();}).catch(()=>{});await app.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exitCode=1;});
