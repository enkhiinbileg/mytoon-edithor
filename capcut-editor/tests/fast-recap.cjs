const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {execFileSync} = require('node:child_process');
const dir = path.resolve(__dirname,'../.test-output/fast-recap-'+Date.now());
fs.mkdirSync(dir,{recursive:true});
const originalLoad = Module._load;
Module._load = function(id,...rest) {
  if(id==='electron') return {app:{getPath:()=>dir}};
  return originalLoad.call(this,id,...rest);
};
const ff = require('../electron/ffmpeg');
const tts = require('../electron/tts');
const dub = require('../electron/dub');
const engine = require('../electron/fast-recap');
const work = require('../electron/recap-work');
const {exportRecap} = require('../electron/recap-export');
const {validateProject} = require('../electron/project-store');
const {validateUrl} = require('../electron/recap-download');
const run = args => execFileSync(ff.FFMPEG,['-hide_banner','-loglevel','error',...args],{windowsHide:true,maxBuffer:16*1024*1024});
const source = path.join(dir,'source.mp4');
const tone = path.join(dir,'voice.mp3');
run(['-y','-f','lavfi','-i','color=blue:s=160x90:r=24:d=36','-f','lavfi','-i','sine=frequency=300:duration=36','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source]);
run(['-y','-f','lavfi','-i','sine=frequency=800:duration=0.25','-c:a','libmp3lame',tone]);
let active=0,peak=0,calls=0,translations=0;
tts.speak = async (_provider,opts)=>{
  active++; peak=Math.max(peak,active); calls++;
  try {await new Promise(r=>setTimeout(r,15));work.check(opts.signal);fs.copyFileSync(tone,opts.file);}
  finally {active--;}
};
const options = {providerId:'elevenlabs',apiKey:'test-only',voiceId:'fixture-voice',modelId:'fixture-model',concurrency:3,maxTempo:1.35,mediaDuration:36};
const segments = Array.from({length:34},(_,i)=>({id:i,start:i+1,end:i+1.7,text:`Source ${i}`,translated:`Монгол ${i}`}));
(async()=>{
  const res = await dub.synthesize(segments,options);
  assert.equal(res.clips.length,34);assert.ok(peak>1&&peak<=3,'bounded parallel synthesis');
  const before=calls;
  const again=await dub.synthesize(segments,options);
  assert.equal(calls,before,'resume never repeats completed paid requests');assert.equal(again.cached,34);
  const changed=segments.map(s=>s.id===7?{...s,translated:'Шинэ өгүүлбэр'}:s);
  await dub.synthesize(changed,options);
  assert.equal(calls-before,3,'changed text and its context neighbors are invalidated');
  await assert.rejects(()=>dub.synthesize([{...segments[0],translated:'budget reject'}],{...options,reserveCharacters:()=>{throw new Error('budget');}}),/budget/);
  const output=path.join(dir,'dubbed.mp4');
  await exportRecap({source,clips:res.clips,duration:36,outPath:output,dir});
  const hash=file=>run(['-i',file,'-map','0:v:0','-c','copy','-f','hash','-']).toString().trim();
  assert.equal(hash(source),hash(output),'video packet payloads are copied unchanged');
  const info=await ff.probe(output);assert.ok(Math.abs(info.duration-36)<0.1);
  const pcm=run(['-i',output,'-vn','-ar','48000','-ac','1','-f','s16le','-']);
  const peakAt=(a,b)=>{let max=0;for(let i=Math.floor(a*48000)*2;i<Math.min(pcm.length,b*48000*2);i+=2)max=Math.max(max,Math.abs(pcm.readInt16LE(i)));return max;};
  assert.ok(peakAt(0.1,0.8)<10,'foreign narration removed and leading silence preserved');
  assert.ok(peakAt(1.05,1.15)>1000,'voice starts at source timestamp');
  assert.ok(peakAt(24.6,24.8)<10,'silence at block boundary');
  assert.ok(peakAt(25.05,25.15)>1000,'later audio blocks do not drift');
  await assert.rejects(()=>exportRecap({source,clips:[{...res.clips[0],duration:40}],duration:36,outPath:path.join(dir,'bad.mp4'),dir}),/shorter translation/);
  assert.equal(fs.existsSync(path.join(dir,'bad.mp4')),false);
  const signal=AbortSignal.abort();
  await assert.rejects(()=>dub.synthesize(segments,{...options,signal}),/Stopped/);
  assert.throws(()=>engine.validateSegments([{id:1,start:1,end:2,text:'x'},{id:1,start:3,end:4,text:'y'}],36));
  assert.throws(()=>validateUrl('https://example.com/video'));
  assert.throws(()=>validateUrl('file:///etc/passwd'));
  assert.equal(validateUrl('https://youtu.be/abc'),'https://youtu.be/abc');
  const tr={translateSegments:async(rows)=>{translations++;return rows.map(s=>({...s,translated:`Монгол ${s.id}`}));}};
  const spec={source,outPath:path.join(dir,'pipeline.mp4'),segments:segments.map(({translated,...s})=>s),
    sourceLanguage:'en',whisperModel:'base',language:'Mongolian',translation:{providerId:'fixture',model:'fixture'},
    voice:options,concurrency:3,characterBudget:100000};
  const credentials={translation:'test-only',voice:{apiKey:'test-only'}};
  const first=await engine.run(spec,credentials,undefined,()=>{}, {translate:tr});
  assert.equal(first.status,'complete');assert.equal(first.issues.length,0);assert.ok(first.elapsedSeconds>0);
  const project=JSON.parse(fs.readFileSync(first.projectPath));validateProject(project);
  assert.equal(project.clips.length,35);assert.equal(project.tracks[0].muted,true);
  assert.ok(!fs.readFileSync(first.reportPath,'utf8').includes('test-only'),'report contains no keys');
  const oldTranslations=translations,oldCalls=calls;
  await engine.run(spec,credentials,undefined,()=>{}, {translate:tr});
  assert.equal(translations,oldTranslations,'translation checkpoint reuse');assert.equal(calls,oldCalls,'pipeline paid audio reuse');
  let exported=false;
  const review=await engine.run({...spec,voice:{...options,voiceId:'review'}},credentials,undefined,()=>{}, {
    translate:tr,dub:{synthesize:async(rows)=>({clips:rows.map(s=>({id:s.id,file:tone,start:s.start,duration:4,tempo:1,overflow:3,text:s.translated})),cached:0})},
    exportRecap:async()=>{exported=true;}
  });
  assert.equal(review.status,'review');assert.ok(review.issues.length);assert.equal(exported,false,'overflow blocks final export');
  console.log(JSON.stringify({ok:true,checks:['parallel limit','paid cache reuse','context invalidation','budget stop','stream copy hashes','timed audio including block boundary','foreign speech muted','overflow review','cancel','input validation','end-to-end pipeline','editable project','checkpoint resume'],dir,elapsed:first.elapsedSeconds},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
