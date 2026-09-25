const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {execFileSync}=require('node:child_process');
const ff=require('../electron/ffmpeg');
const root=path.resolve(__dirname,'..'),output=path.join(root,'.test-output');
fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(output,'text-profile-'));
const outFile=path.join(output,'text-only.mp4');
(async()=>{
  const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],cwd:root,env:{...process.env,CUTLINE_TEST_DIR:profile}});
  try {
    const page=await app.firstWindow();
    await page.locator('.rail-item').filter({hasText:'Text'}).click();
    await page.locator('.preset-card').first().click();
    await page.locator('textarea').fill('Сайн байна уу\nMy next story');
    await page.locator('textarea').press('Tab');
    const overlay=page.locator('.stage-inner .overlay-item');
    await overlay.waitFor();
    const raster=await overlay.evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight}));
    assert.ok(raster.h>90,'two text lines occupy two rows');
    await page.screenshot({path:path.join(output,'desktop-text.png')});
    await page.getByRole('button',{name:'Export',exact:true}).click();
    await page.getByLabel('Resolution',{exact:true}).selectOption('720');
    await page.getByLabel('Quality',{exact:true}).selectOption('draft');
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},outFile);
    await page.getByRole('dialog').getByRole('button',{name:'Export',exact:true}).click();
    await page.getByText('Exported to '+outFile,{exact:true}).waitFor({timeout:60000});
    const info=await ff.probe(outFile);
    assert.ok(Math.abs(info.duration-4)<0.1,'text-only export lasts four seconds');
    assert.equal(info.width,1280);assert.equal(info.height,720);
    const pixels=execFileSync(ff.FFMPEG,['-v','error','-ss','1','-i',outFile,'-frames:v','1','-vf','scale=160:90','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true});
    assert.ok(pixels.some(p=>p>150),'text appears in exported video');
    console.log('Multiline Mongolian/English text preview and real text-only MP4 export: passed.');
  } finally {await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy())).catch(()=>{});await app.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exitCode=1;});
