const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const profile=fs.mkdtempSync(path.join(root,'.test-output','recap-package-'));
(async()=>{
  const app=await _electron.launch({executablePath:path.join(root,'release/Cutline/Cutline.exe'),args:[],cwd:root,env:{...process.env,CUTLINE_TEST_DIR:profile}});
  try {
    const page=await app.firstWindow();
    page.on('dialog',d=>{void d.dismiss().catch(()=>{});});
    assert.equal(await app.evaluate(({app})=>app.getPath('userData')),profile);
    const status=await page.evaluate(()=>window.api.whisperStatus());
    assert.equal(status.available,true);assert.equal(status.models.find(m=>m.id==='base').installed,true);
    assert.equal((await page.evaluate(()=>window.api.recapStatus())).downloader,true);
    const fixture=path.join(root,'.test-output/jfk.wav');
    const result=await page.evaluate(file=>window.api.transcribe({mediaPath:file,model:'base',language:'en'}),fixture);
    assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.segments.length>0);
    await page.getByRole('button',{name:'Auto dub',exact:true}).click();
    await page.locator('.voice-edit-panel .fast-recap-title').waitFor();
    await page.screenshot({path:path.join(root,'.test-output/fast-recap-packaged.png')});
    console.log(JSON.stringify({ok:true,checks:['packaged launch','isolated profile','bundled downloader','bundled FFmpeg and Whisper','bundled base model transcription','packaged UI']},null,2));
  } finally {
    await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.destroy();});
    await app.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
