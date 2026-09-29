'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../electron/recap-auto-cut');
const alignment=require('../electron/recap-alignment');
const {validateProject}=require('../electron/project-store');

function fixture() {
  const captions=[{id:'c1',kind:'text',trackId:'ov1',start:3,inPoint:1,outPoint:3,style:{text:'Эхний өгүүлбэр',color:'#fff',background:'transparent',fontSize:32}}, {id:'c2',kind:'text',trackId:'ov1',start:7,inPoint:0,outPoint:2,style:{text:'Дараах өгүүлбэр',color:'#fff',background:'transparent',fontSize:32}}];
  const projectData={format:'cutline-project',version:1,name:'Regression',settings:{width:160,height:90,fps:30},tracks:[{id:'v1',kind:'video',name:'Video'},{id:'a1',kind:'audio',name:'Voice'},{id:'ov1',kind:'overlay',name:'Captions'}],media:[{id:'unused',path:'unused.mp3',name:'Wrong first audio',kind:'audio',duration:1,width:0,height:0,fps:0,thumbs:[]},{id:'video',path:'source.mp4',name:'Source',kind:'video',duration:20,width:160,height:90,fps:30,thumbs:[]},{id:'voice',path:'voice.mp3',name:'Voice',kind:'audio',duration:100,width:0,height:0,fps:0,thumbs:[]}],clips:[{id:'v',kind:'av',trackId:'v1',mediaId:'video',start:0,inPoint:0,outPoint:20},{id:'a',kind:'av',trackId:'a1',mediaId:'voice',start:2,inPoint:10,outPoint:18},...captions]};
  return {projectData,captions,srtContent:'1\n00:00:00,000 --> 00:00:01,000\nFirst sentence.\n\n2\n00:00:05,000 --> 00:00:07,000\nNext sentence.\n\n3\n00:00:12,000 --> 00:00:15,000\nUnmatched outro.'};
}
const mapped=spec=>({method:'fixture',warnings:[],alignments:spec.captions.map((c,i)=>({captionId:c.id,audioStart:c.start,audioEnd:c.start+c.outPoint-c.inPoint,videoStart:i*5,videoEnd:i*5+1,matchedSrtId:i+1,mongolianText:c.style.text,englishText:'Matching source'}))});
const frames=async ({timestamps})=>new Map(timestamps.map(t=>[t,`C:/test/freeze-${t}.png`]));

test('selects timeline voice (including trims/offset), covers all captions, ignores unmatched SRT outro, holds images and roundtrips',async()=>{
 const spec=fixture(),before=JSON.stringify(spec);
 const res=await core.autoCutByEnglishSrt(spec,null,{resolveAlignments:mapped,materializeFrames:frames});
 assert.equal(JSON.stringify(spec),before,'source project remains unchanged');
 assert.equal(res.report.voiceStart,2);assert.equal(res.report.voiceEnd,10);
 assert.equal(res.report.timelineEnd,10);assert.equal(res.report.durationError,0);
 assert.equal(res.motionCount,2);assert.equal(res.freezeCount,2);assert.equal(res.report.matchedCaptionCount,2);
 assert.ok(res.videoClips.every(c=>c.matchedSrtId!==3));
 const media=[...spec.projectData.media,...res.newMedia];
 for(const c of res.videoClips.filter(c=>c.isFreeze)){assert.equal(media.find(m=>m.id===c.mediaId).kind,'image');assert.equal(c.inPoint,0);assert.equal(c.aiVerified,false);}
 const saved=validateProject({...spec.projectData,media,clips:[...spec.projectData.clips.filter(c=>c.trackId!=='v1'),...res.videoClips]});
 assert.equal(saved.clips.filter(c=>c.isFreeze).length,2);assert.equal(saved.media.filter(m=>m.kind==='image').length,2);
});
test('sub-300ms boundaries do not accumulate extra time',()=>{
 const spec=fixture();spec.projectData.clips.find(c=>c.id==='a').outPoint=10.1;spec.projectData.clips.find(c=>c.id==='a').start=0;
 spec.captions=Array.from({length:100},(_,i)=>({id:'c'+i,kind:'text',trackId:'ov1',start:i/1000,inPoint:0,outPoint:0.001,style:{text:'Өгүүлбэр'}}));
 const inputs=core.resolveInputs(spec);const a=mapped(inputs);a.alignments.forEach((x,i)=>{x.videoStart=i/100;x.videoEnd=x.videoStart+0.001;});
 const p=core.planRecapCuts(inputs,a);const last=p.cuts.at(-1);assert.ok(Math.abs(last.start+last.outPoint-last.inPoint-0.1)<1e-8);
});
test('missing/duplicate matches, wrong timing and extraction failures abort without mutation',async()=>{
 for(const corrupt of [a=>a.alignments.pop(),a=>a.alignments.push(a.alignments[0]),a=>a.alignments[0].audioEnd+=1,a=>a.alignments[0].videoStart=100]) {
   const spec=fixture(),before=JSON.stringify(spec);
   await assert.rejects(core.autoCutByEnglishSrt(spec,null,{resolveAlignments:s=>{const a=mapped(s);corrupt(a);return a;},materializeFrames:frames}));
   assert.equal(JSON.stringify(spec),before);
 }
 await assert.rejects(core.autoCutByEnglishSrt(fixture(),null,{resolveAlignments:mapped,materializeFrames:async()=>new Map()}),/Freeze/);
});
test('rejects invalid captions, locked track, ambiguity and bad source bounds',()=>{
 for(const corrupt of [s=>s.captions[0].start=-1,s=>s.captions[0].style.text='',s=>s.captions[1].start=3,s=>s.projectData.tracks[0].locked=true,s=>s.projectData.clips.find(c=>c.id==='a').outPoint=101,s=>s.projectData.clips.find(c=>c.id==='v').mediaId='absent']) {
   const spec=fixture();corrupt(spec);assert.throws(()=>core.resolveInputs(spec));
 }
 assert.throws(()=>core.validateTimeline([{start:0,inPoint:0,outPoint:1,mediaId:'v',isFreeze:true}],[{id:'v',kind:'video',duration:2}],0,1));
});
test('cache remaps fragmented captions using current timings and verifies source identity',()=>{
 const eng=[{id:50,start:0,end:1,text:'The first source sentence is long enough.'},{id:90,start:2,end:3,text:'The second source sentence is long enough.'}];
 const saved=[{mongolianText:'Нэг хоёр.',englishText:eng[0].text,videoStart:0,videoEnd:1,audioStart:999},{mongolianText:'Гурав дөрөв.',englishText:eng[1].text,videoStart:2,videoEnd:3,audioStart:1000}];
 const caps=['Нэг','хоёр.','Гурав','дөрөв.'].map((text,i)=>({id:'c'+i,start:i*2,inPoint:2,outPoint:3,style:{text}}));
 const result=alignment.reuseTranscript(caps,eng,5,saved);assert.equal(result.alignments.length,4);assert.equal(result.alignments[1].audioStart,2);assert.equal(result.alignments[1].audioEnd,3);assert.equal(result.alignments[2].matchedSrtId,90);
 assert.equal(alignment.reuseTranscript(caps,[{...eng[0],text:'Unrelated video'}],5,saved),null);
 assert.equal(alignment.reuseTranscript([{...caps[0],style:{text:'Өөр voice'}}],eng,5,saved),null);
});
test('Gemini rejects missing/uncertain/HTTP-error output instead of proportional guessing',async()=>{
 const spec={captions:fixture().captions,englishSrt:[{id:1,start:0,end:2,text:'English'}],videoDuration:20,apiKey:'test'};
 const response=matches=>async(_url,options)=>({ok:true,json:async()=>options.method==='GET'
   ? {models:[{name:'models/gemini-test-flash',supportedGenerationMethods:['generateContent']}]}
   : {candidates:[{content:{parts:[{text:JSON.stringify({matches})}]}}]}});
 await assert.rejects(alignment.geminiAlign({...spec,apiKey:''},null,response([])),/API key/);
 await assert.rejects(alignment.geminiAlign(spec,null,response([{id:0,startId:1,endId:1,confidence:.9}])),/орхисон/);
 await assert.rejects(alignment.geminiAlign(spec,null,response([{id:0,startId:null,endId:null,confidence:0},{id:1,startId:1,endId:1,confidence:.9}])),/тодорхойгүй/);
 await assert.rejects(alignment.geminiAlign(spec,null,async()=>({ok:false,status:429,json:async()=>({error:{message:'Quota exceeded, limit: 0, model: gemini-test-flash'}})})),/429/);
 const good=await alignment.geminiAlign(spec,null,response([{id:0,startId:1,endId:1,confidence:.9},{id:1,startId:1,endId:1,confidence:.8}]));
 assert.equal(good.alignments.length,2);assert.equal(good.method,'gemini-semantic');
});
