const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {execFileSync}=require('node:child_process');
const dir=path.resolve(__dirname,'../.test-output/voice-edit-'+Date.now());fs.mkdirSync(dir,{recursive:true});
const load=Module._load;Module._load=function(id,...args){return id==='electron'?{app:{getPath:()=>dir}}:load.call(this,id,...args);};
const ff=require('../electron/ffmpeg'),editor=require('../electron/voice-edit'),translation=require('../electron/translate');
const cmd=args=>execFileSync(ff.FFMPEG,['-hide_banner','-loglevel','error',...args],{windowsHide:true,maxBuffer:16*1024*1024});
const source=path.join(dir,'source.mp4'),voice=path.join(dir,'voice.wav');
cmd(['-y','-f','lavfi','-i','color=red:s=160x90:r=24:d=2','-f','lavfi','-i','color=green:s=160x90:r=24:d=2','-f','lavfi','-i','color=blue:s=160x90:r=24:d=2','-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]','-map','[v]','-c:v','libx264','-pix_fmt','yuv420p',source]);
cmd(['-y','-f','lavfi','-i','sine=frequency=880:duration=5:sample_rate=48000','-c:a','pcm_s16le',voice]);
const frame=(file,t)=>Array.from(cmd(['-ss',String(t),'-i',file,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']).slice(0,3));
(async()=>{
  let calls=0;
  translation.provider=()=>({defaultModel:'fixture',complete:async args=>{
    calls++;assert.ok(args.user.includes('hero'));assert.ok(args.system.includes('must never be rewritten'));
    return JSON.stringify({matches:[{targetId:0,sourceFirst:0,sourceLast:0,confidence:.95}]});
  }});
  const spec={source,voice,whisperModel:'base',sourceLanguage:'en',translation:{providerId:'fixture',model:'fixture'},
    sourceSegments:[{id:0,start:0,end:6,text:'The hero opens the door.'}],voiceSegments:[{id:0,start:0,end:5,text:'Баатар хаалга нээв.'}]};
  const prepared=await editor.prepare(spec,'fixture-key');
  assert.equal(prepared.voiceDuration,5);assert.equal(prepared.plan.length,1);
  await editor.prepare(spec,'fixture-key');assert.equal(calls,1,'matching checkpoint avoids repeated paid request');
  const plan=[{id:0,sourceStart:0,sourceEnd:2,targetStart:0,targetEnd:1,review:false},
    {id:1,sourceStart:2,sourceEnd:4,targetStart:1,targetEnd:4,review:false},
    {id:2,sourceStart:4,sourceEnd:6,targetStart:4,targetEnd:5,review:false}];
  const project={...prepared,fps:24};
  const result=await editor.render(project,plan,path.join(dir,'voice-edited.mp4'));
  require('../electron/project-store').validateProject(JSON.parse(fs.readFileSync(result.projectPath)));
  const info=await ff.probe(result.path);assert.ok(Math.abs(info.duration-5)<.1);assert.equal(info.hasAudio,true);
  assert.ok(frame(result.path,.5)[0]>180,'red footage compressed into first voice slot');
  assert.ok(frame(result.path,2.5)[1]>80,'green footage expanded over second voice slot');
  assert.ok(frame(result.path,4.5)[2]>180,'blue footage follows voice timing');
  const pcm=cmd(['-i',result.path,'-vn','-ar','48000','-ac','1','-f','s16le','-']);
  let crossings=0;for(let i=48000;i<48000*3;i+=2)if(pcm.readInt16LE(i-2)<=0&&pcm.readInt16LE(i)>0)crossings++;
  assert.ok(Math.abs(crossings-880)<5,'supplied voice pitch and playback rate remain unchanged');
  assert.throws(()=>editor.validatePlan([{...plan[0],targetStart:.5}],6,5),/gap/);
  await assert.rejects(()=>editor.render(project,[{...prepared.plan[0],review:true}],path.join(dir,'rejected.mp4')),/Confirm/);
  await assert.rejects(()=>editor.render(project,plan,source),/overwrite/);
  // Holding a still frame fills a longer voice while leaving the audio intact.
  const hold=await editor.render(project,[{id:0,sourceStart:0,sourceEnd:1,targetStart:0,targetEnd:5,review:false}],path.join(dir,'hold.mp4'));
  assert.ok(frame(hold.path,4.7)[0]>180,'last picture holds through longer voice');

  // Test silent video matching with prompt guidance
  translation.provider=()=>({defaultModel:'fixture',complete:async args=>{
    assert.ok(args.system.includes('silent video'));
    return JSON.stringify({cuts:[
      {voiceBlockId:0,sourceStart:0,sourceEnd:3,description:'Opening'},
      {voiceBlockId:0,sourceStart:3,sourceEnd:6,description:'Action'}
    ]});
  }});
  const silentSpec={source,voice,whisperModel:'base',sourceLanguage:'en',translation:{providerId:'fixture',model:'fixture'},
    isSilentVideo:true,promptGuidance:'Динамик 3-5 сек кадрууд сонго',voiceSegments:[{id:0,start:0,end:5,text:'Монгол яриа.'}]};
  const silentPrepared=await editor.prepare(silentSpec,'fixture-key');
  assert.equal(silentPrepared.isSilent,true);
  assert.equal(silentPrepared.plan.length,2);
  assert.ok(fs.existsSync(silentPrepared.projectPath));

  console.log(JSON.stringify({ok:true,checks:['cross-language matching contract','matching cache','picture speed-up','picture slow-down','last-frame hold','voice duration','unchanged voice pitch','no gaps','review gate','input overwrite guard','silent video visual matching'],encoder:result.encoder,dir},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
