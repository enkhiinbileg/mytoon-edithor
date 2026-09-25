const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'.test-output');
const profile=fs.mkdtempSync(path.join(output,'recap-ui-'));
(async()=>{
  const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],cwd:root,env:{...process.env,CUTLINE_TEST_DIR:profile}});
  try {
    const page=await app.firstWindow();
    page.on('dialog',dialog=>{void dialog.dismiss().catch(()=>{});});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await app.evaluate(({ipcMain,BrowserWindow})=>{
      const replace=(name,fn)=>{ipcMain.removeHandler(name);ipcMain.handle(name,fn);};
      replace('settings:read',()=>({anthropicApiKey:true,geminiApiKey:true,elevenLabsApiKey:true}));
      replace('translate:models',()=>({ok:true,models:['fixture-model']}));
      replace('tts:voices',()=>({ok:true,voices:[{id:'fixture-voice',name:'Test voice'}]}));
      replace('tts:models',()=>({ok:true,models:[{id:'fixture-model',label:'Test model',credits:1,note:'fixture'}]}));
      replace('tts:quota',()=>({ok:true,quota:null}));
      replace('recap:run',async(_e,spec)=>{
        globalThis.recapTestSpec=spec;
        BrowserWindow.getAllWindows()[0].webContents.send('recap:progress',{stage:'speak',done:2,total:4,reservedCharacters:12});
        await new Promise(resolve=>{globalThis.recapTestDone=resolve;});
        return {ok:true,status:'complete',totalElapsedSeconds:8,cached:4,reservedCharacters:12,targetMet:true};
      });
      replace('recap:cancel',()=>{globalThis.recapTestDone?.();return true;});
    });
    await page.reload();
    await page.getByRole('button',{name:'Auto dub',exact:true}).click();
    await page.getByText('Нэмэлт: шинэ voice үүсгэх хуучин горим',{exact:true}).click();
    await page.locator('.fast-recap:not(.voice-edit-panel) .fast-recap-title').waitFor();
    assert.equal(await page.locator('.fast-recap:not(.voice-edit-panel) .fast-recap-title').innerText(),'Монгол recap · Хурдан горим');
    await page.getByLabel('YouTube URL').fill('https://youtu.be/fixture');
    const start=page.locator('.fast-recap:not(.voice-edit-panel) button.primary');
    await page.locator('.fast-recap:not(.voice-edit-panel) .fast-recap-check').last().locator('input').check();
    await start.click();
    await page.getByText('Монгол дуу үүсгэж байна',{exact:false}).waitFor();
    const sent=await app.evaluate(()=>globalThis.recapTestSpec);
    assert.equal(sent.concurrency,2);assert.equal(sent.characterBudget,120000);assert.equal(sent.voice.voiceId,'fixture-voice');
    assert.equal(sent.segments,undefined,'unconfirmed restored transcript is never submitted');
    await page.getByRole('button',{name:'Media',exact:true}).click();
    await page.getByRole('button',{name:'Auto dub',exact:true}).click();
    assert.equal(await page.getByLabel('YouTube URL').inputValue(),'https://youtu.be/fixture','tab switches preserve the job');
    await page.getByRole('button',{name:'Зогсоох, хийснийг хадгалах'}).click();
    await page.getByText('Монгол видео бэлэн',{exact:true}).waitFor();
    for(const width of [1280,960]) {
      await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setSize(w,720),width);
      await page.locator('.fast-recap:not(.voice-edit-panel) .fast-recap-title').scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(output,`fast-recap-${width}.png`)});
      const bounds=await page.locator('.fast-recap:not(.voice-edit-panel)').boundingBox();
      assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width,'panel stays inside window');
      await start.scrollIntoViewIfNeeded();
      const button=await start.boundingBox();assert.ok(button&&button.y>=0&&button.y+button.height<720,'start button is reachable');
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({ok:true,checks:['Mongolian UI','preflight gate','IPC spec','progress','tab persistence','stop control','1280 and 960 layout'],output},null,2));
  } finally {await app.evaluate(({BrowserWindow})=>{for(const win of BrowserWindow.getAllWindows())win.destroy();});await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
