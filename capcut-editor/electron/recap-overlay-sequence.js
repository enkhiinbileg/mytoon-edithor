'use strict';
const fs=require('node:fs');
const path=require('node:path');
const zlib=require('node:zlib');

function crc32(buffer) {
 let crc=0xffffffff;
 for(const byte of buffer){crc^=byte;for(let n=0;n<8;n++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 return (crc^0xffffffff)>>>0;
}
function chunk(name,data){const type=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([size,type,data,crc]);}
function transparentPng(width,height){
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(Buffer.alloc((width*4+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}
function canSequenceOverlays(overlays,width,height,minCount=33){
 let end=0;
 return overlays.length>=minCount && [...overlays].sort((a,b)=>a.start-b.start).every(o=>{
  const ok=[o.start,o.end].every(Number.isFinite)&&o.start>=end-1e-6&&o.end>o.start&&o.x===0&&o.y===0&&o.w===width&&o.h===height&&(o.opacity??1)===1;
  end=o.end;return ok;
 });
}
function prepareOverlaySequence({overlays,width,height,fps,duration,workDir}) {
 if(!canSequenceOverlays(overlays,width,height,1)) throw new Error('Caption sequence must contain nonoverlapping full-canvas images.');
 fs.mkdirSync(workDir,{recursive:true});
 const blank=path.join(workDir,'transparent.png');fs.writeFileSync(blank,transparentPng(width,height));
 const lines=['ffconcat version 1.0'];
 const total=Math.ceil(duration*fps-1e-7);
 const file=name=>`file '${name.replace(/\\/g,'/').replace(/'/g,"'\\''")}'`;
 function add(name,frames){if(frames<=0)return;lines.push(file(name),`option framerate ${fps}`,`duration ${(frames/fps).toFixed(12)}`);}
 let cursor=0;
 for(const [i,o] of [...overlays].sort((a,b)=>a.start-b.start).entries()){
  const start=Math.max(0,Math.min(total,Math.ceil(o.start*fps-1e-7))),end=Math.min(total,Math.ceil(o.end*fps-1e-7));
  if(end<=start)continue;
  if(start>cursor)add(blank,start-cursor);
  const data=Buffer.from(o.dataUrl.replace(/^data:image\/png;base64,/,''),'base64');
  if(data.length<26||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||data.readUInt32BE(16)!==width||data.readUInt32BE(20)!==height||data[24]!==8||data[25]!==6)throw new Error('Caption images must be uniform 8-bit RGBA PNGs at the export canvas size.');
  const output=path.join(workDir,`caption-${i}.png`);fs.writeFileSync(output,data);add(output,end-start);cursor=end;
 }
 if(cursor<total)add(blank,total-cursor);
 // Sentinel supplies a last timestamp so the fps filter can hold the prior image.
 lines.push(file(blank),`option framerate ${fps}`);
 const manifest=path.join(workDir,'captions.ffconcat');fs.writeFileSync(manifest,lines.join('\n'));
 return manifest;
}
module.exports={canSequenceOverlays,prepareOverlaySequence,transparentPng};
