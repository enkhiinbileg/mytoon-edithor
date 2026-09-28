'use strict';
const crypto = require('node:crypto');
const srtParser = require('./srt-parser');
const { resolveRecapAlignments } = require('./recap-alignment');
const { materializeFreezeFrames } = require('./recap-freeze');

const EPS = 1e-6;
const finite = Number.isFinite;
const end = c => c.start + c.outPoint - c.inPoint;
const uid = () => crypto.randomUUID();

function resolveInputs(spec) {
  const project = spec.projectData;
  if (!project || !Array.isArray(project.media) || !Array.isArray(project.clips) || !Array.isArray(project.tracks)) {
    throw new Error('Төслийн мэдээлэл дутуу байна.');
  }
  const videoTrack = project.tracks.find(t => t.id === 'v1' && t.kind === 'video');
  if (!videoTrack || videoTrack.locked) throw new Error('V1 дүрсний зам байхгүй эсвэл түгжээтэй байна.');
  const media = new Map(project.media.map(m => [m.id, m]));
  const videoIds = [...new Set(project.clips.filter(c => c.trackId === 'v1' && media.get(c.mediaId)?.kind === 'video').map(c => c.mediaId))];
  const video = spec.videoMediaId ? media.get(spec.videoMediaId) : videoIds.length === 1 ? media.get(videoIds[0]) : null;
  if (!video || video.kind !== 'video' || !finite(video.duration) || video.duration <= 0 || !video.path) {
    throw new Error('V1 дээр тааруулах нэг эх видео байрлуулна уу. Олон эх видео байвал нэгийг сонгоно уу.');
  }
  const audibleTracks = project.tracks.filter(t => t.kind === 'audio' && !t.muted);
  const candidates = audibleTracks.map(t => ({track:t, clips:project.clips.filter(c => c.trackId === t.id && c.kind === 'av' && media.get(c.mediaId)?.kind === 'audio' && (c.volume ?? 1) > 0)})).filter(x => x.clips.length);
  const voice = candidates.find(x => x.track.id === (spec.voiceTrackId || 'a1')) || (candidates.length === 1 ? candidates[0] : null);
  if (!voice) throw new Error('Монгол voice-оо A1 аудио замд байрлуулна уу.');
  const voiceClips = [...voice.clips].sort((a,b) => a.start-b.start);
  for (let i=0; i<voiceClips.length; i++) {
    const c=voiceClips[i], m=media.get(c.mediaId);
    if (![c.start,c.inPoint,c.outPoint,m.duration].every(finite) || c.start<0 || c.inPoint<0 || c.outPoint<=c.inPoint || c.outPoint>m.duration+0.05) throw new Error('Монгол voice clip-ийн хугацаа буруу байна.');
    if (i && c.start < end(voiceClips[i-1])-0.001) throw new Error('Монгол voice clip-үүд давхцаж байна. Эхлээд давхцлыг засна уу.');
  }
  const voiceStart=voiceClips[0].start, voiceEnd=end(voiceClips.at(-1));
  const captions=[...(spec.captions || [])].sort((a,b)=>a.start-b.start);
  if (!captions.length) throw new Error('Монгол voice-ийн цагтай хадмал шаардлагатай.');
  const seen=new Set();
  for (let i=0;i<captions.length;i++) {
    const c=captions[i];
    if (typeof c.id !== 'string' || seen.has(c.id) || c.kind !== 'text' || !c.style?.text?.trim() || ![c.start,c.inPoint,c.outPoint].every(finite) || c.outPoint<=c.inPoint) throw new Error('Монгол хадмал хоосон, давхардсан эсвэл хугацаа буруу байна.');
    seen.add(c.id);
    if (c.start < voiceStart-0.05 || end(c)>voiceEnd+0.05) throw new Error(`Хадмал ${i+1} Монгол voice-ийн хугацаанаас хэтэрсэн байна.`);
    if (!voiceClips.some(v => c.start>=v.start-0.05 && end(c)<=end(v)+0.05)) throw new Error(`Хадмал ${i+1} voice clip-ийн завсарт байна.`);
    if (i && c.start < end(captions[i-1])-0.05) throw new Error(`Монгол хадмал ${i} ба ${i+1}-ийн цаг давхцаж байна.`);
    if (i && c.start <= captions[i-1].start) throw new Error('Хоёр Монгол хадмал ижил эхлэх цагтай байна.');
  }
  return {video,voiceStart,voiceEnd,captions,project};
}

// A cut boundary comes from the current narration clock, never an invented minimum duration.
function planRecapCuts(inputs, alignment) {
  const {video,voiceStart,voiceEnd,captions}=inputs;
  const byCaption=new Map();
  for (const a of alignment.alignments || []) {
    if (byCaption.has(a.captionId)) throw new Error('Тааруулалтад давхардсан хадмал байна.');
    byCaption.set(a.captionId,a);
  }
  if (byCaption.size!==captions.length) throw new Error('Бүх Монгол хадмалд эх дүрс олдоогүй. Timeline өөрчлөгдөөгүй.');
  const scenes=[];
  for (const c of captions) {
    const a=byCaption.get(c.id);
    if (!a || ![a.audioStart,a.audioEnd,a.videoStart,a.videoEnd].every(finite) || Math.abs(a.audioStart-c.start)>EPS || Math.abs(a.audioEnd-end(c))>EPS || a.videoStart<0 || a.videoStart>=video.duration || a.videoEnd<=a.videoStart) throw new Error('Тааруулалтын цаг одоогийн хадмал эсвэл эх видеотой нийцэхгүй байна.');
    const sourceEnd=Math.min(video.duration,a.videoEnd);
    const previous=scenes.at(-1);
    if (previous && Math.abs(previous.sourceStart-a.videoStart)<EPS) {
      previous.sourceEnd=Math.max(previous.sourceEnd,sourceEnd);
      previous.captions.push(c); previous.alignments.push(a);
    } else scenes.push({sourceStart:a.videoStart,sourceEnd,start:c.start,captions:[c],alignments:[a]});
  }
  const cuts=[];
  const frameDuration=1/(video.fps>0?video.fps:30);
  scenes.forEach((s,i)=>{
    const start=i===0?voiceStart:Math.max(voiceStart,s.start);
    const finish=i+1<scenes.length?Math.min(voiceEnd,scenes[i+1].start):voiceEnd;
    if (!(finish>start)) throw new Error('Дүрсний дарааллын хугацаа буруу байна.');
    const duration=finish-start;
    const motionDuration=Math.min(duration,s.sourceEnd-s.sourceStart);
    const metadata={matchedSrtId:s.alignments[0].matchedSrtId,englishText:s.alignments.map(a=>a.englishText).filter((t,j,x)=>t && x.indexOf(t)===j).join(' '),mongolianText:s.captions.map(c=>c.style.text).join(' '),aiVerified:false,aiReason:alignment.method};
    cuts.push({start,inPoint:s.sourceStart,outPoint:s.sourceStart+motionDuration,isFreeze:false,...metadata});
    const hold=duration-motionDuration;
    if (hold>EPS) {
      // Hold the final frame INSIDE the source scene, not the first frame of the next scene.
      const freezeTs=Math.max(s.sourceStart,Math.min(video.duration-frameDuration,Math.floor((s.sourceEnd-1e-7)/frameDuration)*frameDuration));
      cuts.push({start:start+motionDuration,inPoint:0,outPoint:hold,isFreeze:true,freezeTs,...metadata});
    }
  });
  return {cuts,sceneCount:scenes.length};
}

function validateTimeline(clips, media, voiceStart, voiceEnd) {
  if (!clips.length) throw new Error('Дүрсний timeline хоосон байна.');
  const byId=new Map(media.map(m=>[m.id,m]));
  let cursor=voiceStart;
  for (const c of [...clips].sort((a,b)=>a.start-b.start)) {
    const m=byId.get(c.mediaId);
    if (!m || ![c.start,c.inPoint,c.outPoint].every(finite) || c.inPoint<0 || !(c.outPoint>c.inPoint) || Math.abs(c.start-cursor)>EPS) throw new Error('Дүрсний timeline-д завсар, давхцал эсвэл буруу clip байна.');
    if (m.kind==='video' && c.outPoint>m.duration+EPS) throw new Error('Дүрсний clip эх видеоны төгсгөлөөс хэтэрсэн байна.');
    if (c.isFreeze && m.kind!=='image') throw new Error('Freeze clip царцсан зурагтай холбогдоогүй байна.');
    cursor=end(c);
  }
  const durationError=cursor-voiceEnd;
  if (Math.abs(durationError)>EPS) throw new Error('Дүрсний төгсгөл Монгол voice-тэй таарахгүй байна.');
  return {timelineStart:clips[0].start,timelineEnd:cursor,voiceStart,voiceEnd,durationError};
}

async function autoCutByEnglishSrt(spec, progress, dependencies={}) {
  const inputs=resolveInputs(spec);
  if (!spec.srtPath && !spec.srtContent) throw new Error('Англи SRT файлыг сонгоно уу.');
  const raw=spec.srtContent?srtParser.parseSrt(spec.srtContent):srtParser.parseSrtFile(spec.srtPath);
  if (!raw.length || raw.some((s,i)=>i>0 && s.start<raw[i-1].start)) throw new Error('Англи SRT хоосон эсвэл цагийн дараалал буруу байна.');
  const englishSrt=srtParser.reconstructSentences(raw);
  progress?.({stage:'mapping',message:`${inputs.captions.length} Монгол хадмалыг ${englishSrt.length} Англи хэсэгтэй тулгаж байна…`});
  const alignment=await (dependencies.resolveAlignments || resolveRecapAlignments)({captions:inputs.captions,englishSrt,videoDuration:inputs.video.duration,apiKey:spec.geminiApiKey,model:spec.model},progress);
  const plan=planRecapCuts(inputs,alignment);
  const freezes=plan.cuts.filter(c=>c.isFreeze);
  const images=freezes.length?await (dependencies.materializeFrames || materializeFreezeFrames)({video:inputs.video,timestamps:freezes.map(c=>c.freezeTs),outputDir:spec.outputDir},p=>progress?.({...p,message:`Царцсан зураг үүсгэж байна: ${p.completed}/${p.total}`})):new Map();
  const newMedia=[], imageIds=new Map();
  for (const c of freezes) {
    const imagePath=images.get(c.freezeTs);
    if (!imagePath) throw new Error('Freeze зураг үүссэнгүй. Timeline өөрчлөгдөөгүй.');
    if (!imageIds.has(imagePath)) {
      const id=uid(); imageIds.set(imagePath,id);
      newMedia.push({id,path:imagePath,name:`Freeze ${c.freezeTs.toFixed(3)}s`,kind:'image',duration:86400,width:inputs.video.width,height:inputs.video.height,fps:inputs.video.fps,hasAudio:false,thumbs:[]});
    }
  }
  const videoClips=plan.cuts.map(c=>({id:uid(),kind:'av',trackId:'v1',...c,mediaId:c.isFreeze?imageIds.get(images.get(c.freezeTs)):inputs.video.id,filterId:'none',effectId:'none',transitionId:'none',volume:0,opacity:1,sourceStart:c.isFreeze?c.freezeTs:c.inPoint,sourceEnd:c.isFreeze?c.freezeTs:c.outPoint,label:`${c.isFreeze?'❄️ ':''}[#${c.matchedSrtId}] ${c.mongolianText.slice(0,64)}`}));
  const timing=validateTimeline(videoClips,[...inputs.project.media,...newMedia],inputs.voiceStart,inputs.voiceEnd);
  const report={...timing,captionCount:inputs.captions.length,matchedCaptionCount:alignment.alignments.length,sceneCount:plan.sceneCount,alignmentMethod:alignment.method,warnings:alignment.warnings || []};
  progress?.({stage:'done',message:`${report.matchedCaptionCount}/${report.captionCount} хадмал холбогдлоо. Хугацааны шалгалт амжилттай.`});
  return {ok:true,videoClips,newMedia,count:videoClips.length,motionCount:videoClips.length-freezes.length,freezeCount:freezes.length,englishScenesCount:englishSrt.length,videoDuration:inputs.video.duration,voiceDuration:inputs.voiceEnd-inputs.voiceStart,report};
}

module.exports={autoCutByEnglishSrt,resolveInputs,planRecapCuts,validateTimeline};
