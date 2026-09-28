'use strict';
// Register a separately repaired project through the packaged app's normal UI/API.
// The original project stays available in the project list.
const fs=require('node:fs'),path=require('node:path');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const repaired=path.resolve(root,'repaired-projects/Assassin-Reborn.cutline');
const doc=JSON.parse(fs.readFileSync(repaired));
const out=path.join(root,'.test-output');
(async()=>{
 const app=await _electron.launch({executablePath:path.join(root,'release/Cutline/Cutline.exe'),args:[],cwd:path.join(root,'release/Cutline')});
 try {
  const page=await app.firstWindow();page.setDefaultTimeout(25000);page.on('dialog',d=>{void d.accept().catch(()=>{});});
  const details=await app.evaluate(({app})=>({name:app.getName(),userData:app.getPath('userData')}));
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},repaired);
  await page.getByRole('button',{name:/Create project/}).click();
  await page.getByRole('button',{name:'Text',exact:true}).waitFor();
  await page.keyboard.press('Control+o');
  await page.waitForFunction(name=>document.querySelector('input[aria-label="Project name"]')?.value===name,doc.name);
  await page.keyboard.press('Control+s');
  await page.getByRole('status').filter({hasText:'Project saved.'}).waitFor();
  await page.getByRole('button',{name:'Text',exact:true}).click();
  await page.getByRole('button',{name:/Video Sync/}).click();
  await page.getByRole('button',{name:/Video Sync \(689\)/}).waitFor();
  await page.screenshot({path:path.join(out,'recap-packaged-ready.png')});
  const stored=await page.evaluate(async()=>{const active=await window.api.getActiveProjectId();const loaded=await window.api.openProjectById(active.id);return {active,loaded};});
  if(!stored.loaded.ok||stored.loaded.data.clips.filter(c=>c.trackId==='v1').length!==689)throw Error('Saved repaired project validation failed');
  console.log(JSON.stringify({ok:true,...details,projectId:stored.active.id,projectName:stored.loaded.data.name,clips:stored.loaded.data.clips.length},null,2));
 }finally{await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.destroy();}).catch(()=>{});await app.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exitCode=1;});
