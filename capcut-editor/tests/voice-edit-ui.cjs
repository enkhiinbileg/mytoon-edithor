const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.test-output');
const profile=fs.mkdtempSync(path.join(out,'voice-ui-'));
const fixture=fs.readdirSync(out).filter(f=>/^voice-edit-\d+$/.test(f)).sort().at(-1);
(async()=>{
  const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],cwd:root,env:{...process.env,CUTLINE_TEST_DIR:profile}});
  try{
    const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{void d.dismiss().catch(()=>{});});
    await app.evaluate(({ipcMain,dialog},files)=>{
      const set=(id,fn)=>{ipcMain.removeHandler(id);ipcMain.handle(id,fn);};
      set('settings:read',()=>({geminiApiKey:true,elevenLabsApiKey:false,anthropicApiKey:false}));
      set('translate:models',()=>({ok:true,models:['fixture-model']}));
      let n=0;dialog.showOpenDialog=async()=>({canceled:false,filePaths:[files[n++]]});
      set('voice-edit:prepare',(_e,spec)=>{globalThis.voiceEditSpec=spec;return {ok:true,jobId:'fixture',voiceDuration:5,plan:[
        {id:0,sourceStart:0,sourceEnd:2,targetStart:0,targetEnd:2,text:'Баатар хаалгыг нээв.',confidence:.4,review:true},
        {id:1,sourceStart:2,sourceEnd:6,targetStart:2,targetEnd:5,text:'Дайсан гарч ирэв.',confidence:.9,review:false}
      ]};});
      set('voice-edit:render',(_e,spec)=>{globalThis.voiceRenderSpec=spec;return {ok:true,path:files[0],renderSeconds:2,encoder:'fixture'};});
      set('dub:synthesize',()=>{throw Error('Voice generation must never be called in this workflow');});
    },[path.join(out,fixture,'source.mp4'),path.join(out,fixture,'voice.wav')]);
    await page.reload();await page.getByRole('button',{name:'Auto dub',exact:true}).click();
    const panel=page.locator('.voice-edit-panel');await panel.waitFor();
    await panel.getByRole('button',{name:'1 · Эх видео'}).click();await panel.getByRole('button',{name:'2 · Монгол voice'}).click();
    await panel.getByRole('button',{name:'Дүрсийг voice-д автоматаар тааруулах'}).click();
    await page.getByText('1 хэсгийг шалгах шаардлагатай.',{exact:false}).waitFor();
    const request=await app.evaluate(()=>globalThis.voiceEditSpec);assert.equal(request.translation.providerId,'gemini');assert.ok(request.voice.endsWith('voice.wav'));
    assert.equal(await app.evaluate(()=>globalThis.voiceRenderSpec),undefined,'uncertain match blocks automatic render');
    await page.getByRole('button',{name:'Media',exact:true}).click();await page.getByRole('button',{name:'Auto dub',exact:true}).click();
    assert.ok((await panel.innerText()).includes('voice.wav'),'supplied voice survives tab switches');
    await panel.locator('.voice-edit-row').first().getByRole('checkbox').check();
    await panel.getByRole('button',{name:'Энэ эвлүүлгээр экспортлох'}).click();await page.getByText('Voice-д тааруулсан видео бэлэн',{exact:true}).waitFor();
    assert.equal((await app.evaluate(()=>globalThis.voiceRenderSpec)).plan[0].review,false);
    for(const width of [1280,960]){
      await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setSize(w,720),width);
      await panel.locator('.fast-recap-title').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,`voice-edit-ui-${width}.png`)});
      const b=await panel.boundingBox();assert.ok(b.x>=0&&b.x+b.width<=width);
      await panel.getByRole('button',{name:'Энэ эвлүүлгээр экспортлох'}).scrollIntoViewIfNeeded();
    }
    assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['supplied voice input','Gemini matching selection','no ElevenLabs generation','uncertain range review','manual confirmation','tab persistence','export control','960/1280 layout']},null,2));
  }finally{await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.destroy();});await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
