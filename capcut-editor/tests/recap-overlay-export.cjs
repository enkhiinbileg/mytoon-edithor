const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const ff=require('../electron/ffmpeg');
const {canSequenceOverlays}=require('../electron/recap-overlay-sequence');
const dir=path.resolve(__dirname,'../.test-output/recap-overlays');fs.mkdirSync(dir,{recursive:true});
const run=args=>execFileSync(ff.FFMPEG,['-hide_banner','-loglevel','error',...args],{windowsHide:true,maxBuffer:16*1024*1024});
(async()=>{
 const fps=30,width=320,height=180,duration=15;
 const red=path.join(dir,'red.mp4'),blue=path.join(dir,'blue.png'),green=path.join(dir,'green.png');
 run(['-y','-f','lavfi','-i','color=red:s=320x180:r=30:d=1','-c:v','libx264','-pix_fmt','yuv420p',red]);
 for(const [color,file] of [['blue',blue],['green',green]])run(['-y','-f','lavfi','-i',`color=${color}:s=320x180`,'-vf','format=rgba','-frames:v','1',file]);
 const dataUrl='data:image/png;base64,'+fs.readFileSync(green).toString('base64');
 const overlays=Array.from({length:70},(_,i)=>({dataUrl,start:i*0.203+0.04,end:i*0.203+0.123,x:0,y:0,w:width,h:height,opacity:1}));
 assert.ok(canSequenceOverlays(overlays,width,height));
 const clips=Array.from({length:60},(_,i)=>({src:i%2?blue:red,kind:i%2?'image':'video',trackId:'v1',start:i*.25,inPoint:0,outPoint:.25,volume:0,hasAudio:false}));
 const outPath=path.join(dir,'many-captions.mp4');
 await ff.exportTimeline({clips,overlays,width,height,fps,duration,outPath,codec:process.env.EXPORT_TEST_CODEC || 'h264',quality:'draft'});
 const raw=run(['-i',outPath,'-an','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
 assert.equal(raw.length,Math.ceil(duration*fps)*3);
 for(let n=0;n<raw.length/3;n++){
  const t=n/fps,active=overlays.some(o=>n>=Math.ceil(o.start*fps-1e-7)&&n<Math.ceil(o.end*fps-1e-7));
  const clipIndex=Math.min(59,clips.findLastIndex(c=>Math.round(c.start*fps)<=n));
  const rgb=[...raw.subarray(n*3,n*3+3)];
  if(active)assert.ok(rgb[1]>90&&rgb[0]<50&&rgb[2]<50,`Caption frame ${n}: ${rgb}`);
  else {const wanted=clipIndex%2?2:0;assert.ok(rgb[wanted]>180&&rgb[1]<60,`Transparent gap frame ${n}: ${rgb}`);}
 }
 console.log(`PASS: ${overlays.length} captions with transparent gaps over ${clips.length} mixed clips; all 450 frames checked.`);
})().catch(e=>{console.error(e);process.exitCode=1;});
