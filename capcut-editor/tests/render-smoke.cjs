const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const ff = require('../electron/ffmpeg');
const dir = path.resolve(__dirname,'../.test-output/render');
fs.mkdirSync(dir,{recursive:true});
const run=(args)=>execFileSync(ff.FFMPEG,['-hide_banner','-loglevel','error',...args],{windowsHide:true,maxBuffer:16*1024*1024});
for(const color of ['red','blue']) run(['-y','-f','lavfi','-i',`color=${color}:s=160x90:r=24:d=3`,'-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',path.join(dir,color+'.mp4')]);
run(['-y','-f','lavfi','-i','color=green:s=160x90','-frames:v','1',path.join(dir,'still.png')]);
const clip=(color,start,duration,layer=0)=>({src:path.join(dir,color+'.mp4'),kind:'video',start,inPoint:0,outPoint:duration,hasAudio:true,volume:0,layer,trackId:'v'+layer,filterFf:'',effectFf:'',transition:'',transitionDuration:0.3});
const frame=(file,t)=>Array.from(run(['-ss',String(t),'-i',file,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']).slice(0,3));
const black=rgb=>Math.max(...rgb)<15;
const red=rgb=>rgb[0]>180&&rgb[1]<50&&rgb[2]<50;
const blue=rgb=>rgb[2]>180&&rgb[0]<50&&rgb[1]<50;
async function render(name,spec){const outPath=path.join(dir,name+'.mp4');await ff.exportTimeline({clips:[],audio:[],overlays:[],width:160,height:90,fps:24,quality:'draft',...spec,outPath});return outPath;}
(async()=>{
  const gaps=await render('gaps',{clips:[clip('red',1,1),clip('blue',2.5,1)],duration:4});
  assert.ok(Math.abs((await ff.probe(gaps)).duration-4)<0.1);
  assert.ok(black(frame(gaps,0.3)),'leading gap is black');assert.ok(red(frame(gaps,1.5)),'red stays at 1s');assert.ok(black(frame(gaps,2.2)),'middle gap is black');assert.ok(blue(frame(gaps,2.8)),'blue stays at 2.5s');assert.ok(black(frame(gaps,3.8)),'trailing gap is black');
  const layers=await render('layers',{clips:[clip('red',0,3),clip('blue',1,1,1)],duration:3});
  assert.ok(red(frame(layers,0.5)));assert.ok(blue(frame(layers,1.5)),'upper track covers lower');assert.ok(red(frame(layers,2.5)),'lower track resumes');
  const sound=execFileSync(ff.FFMPEG,['-i',layers,'-af','volumedetect','-vn','-f','null','-'],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  // Decode PCM and inspect samples: muted video tracks must export silence.
  const pcm=run(['-i',layers,'-vn','-f','s16le','-acodec','pcm_s16le','pipe:1']);
  let max=0;for(let i=0;i<pcm.length;i+=2)max=Math.max(max,Math.abs(pcm.readInt16LE(i)));assert.equal(max,0,'muted sources export silence');
  const still=await render('still',{clips:[{...clip('red',0,2),src:path.join(dir,'still.png'),kind:'image',hasAudio:false}],duration:2});
  assert.ok(Math.abs((await ff.probe(still)).duration-2)<0.1);assert.ok(frame(still,1.7)[1]>90,'image holds full duration');
  const trans=await render('transition',{clips:[{...clip('red',0,1),transition:'fade'},clip('blue',1,1)],duration:2});
  assert.ok(Math.abs((await ff.probe(trans)).duration-2)<0.1,'transition keeps timeline duration');assert.ok(red(frame(trans,0.5)));assert.ok(blue(frame(trans,1.8)));
  const audio=await render('audio-only',{duration:2,audio:[{src:path.join(dir,'red.mp4'),start:0.5,inPoint:0,outPoint:1,volume:1}]});assert.ok((await ff.probe(audio)).hasAudio);
  console.log(JSON.stringify({ok:true,checks:['absolute gaps','track layering','mute silence','still duration','transition duration','audio-only export'],dir},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
