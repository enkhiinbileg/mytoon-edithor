'use strict';
const {app}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const ff=require('./ffmpeg');
const whisper=require('./whisper');
const translate=require('./translate');
const visionSync=require('./vision-sync');
const settings=require('./settings');
const work=require('./recap-work');
const {run}=require('./recap-export');

const fingerprint=file=>{const s=fs.statSync(file);return {path:path.resolve(file),size:s.size,modified:s.mtimeMs};};
function groups(segments,seconds=4) {
  const out=[];
  for(const s of segments) {
    if(!s.text?.trim()||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<=s.start) continue;
    let last=out.at(-1);
    if(!last||s.end-last.start>seconds) {last={id:out.length,start:s.start,end:s.end,text:''};out.push(last);}
    last.end=Math.max(last.end,s.end);last.text+=(last.text?' ':'')+s.text.trim();
  }
  return out;
}
function validatePlan(plan,videoDuration,voiceDuration) {
  if(!Array.isArray(plan)||!plan.length||plan.length>2000) throw new Error('No usable picture alignment.');
  let end=0;
  for(const s of plan) {
    if(![s.sourceStart,s.sourceEnd,s.targetStart,s.targetEnd].every(Number.isFinite)||s.sourceStart<0||
      s.sourceEnd<=s.sourceStart||s.sourceEnd>videoDuration+0.05||Math.abs(s.targetStart-end)>0.01||s.targetEnd<=s.targetStart)
      throw new Error('Picture alignment has a gap, overlap, or out-of-range source interval.');
    end=s.targetEnd;
  }
  if(Math.abs(end-voiceDuration)>0.05) throw new Error('Picture alignment must cover the complete supplied voice.');
  return plan;
}
async function prepare(spec,apiKey,signal,progress) {
  const started=Date.now();
  const [video,audio]=await Promise.all([ff.probe(spec.source),ff.probe(spec.voice)]);
  if(!video.hasVideo||!audio.hasAudio||!(video.duration>0&&audio.duration>0)) throw new Error('Choose a video and a recorded voice file.');
  const identity={source:fingerprint(spec.source),voice:fingerprint(spec.voice),sourceLanguage:spec.sourceLanguage,
    whisperModel:spec.whisperModel,translation:spec.translation,sourceSegments:spec.sourceSegments,voiceSegments:spec.voiceSegments,
    promptGuidance:spec.promptGuidance,isSilentVideo:spec.isSilentVideo};
  const dir=path.join(app.getPath('userData'),'voice-edit',work.hash(identity).slice(0,24));
  fs.mkdirSync(dir,{recursive:true});
  const emit=p=>progress?.({...p,elapsedSeconds:(Date.now()-started)/1000});

  const readVoiceTranscript=async(file,language,provided,name)=>{
    if(provided?.length)return provided;
    const cache=path.join(dir,name+'.json');
    const saved=work.read(cache);if(saved?.length)return saved;
    emit({stage:name});
    const result=await whisper.transcribe(file,{model:spec.whisperModel||'base',language,signal,threads:4,
      onProgress:p=>emit({stage:name,seconds:p.seconds})});
    if(!result.segments.length)throw new Error(`Монгол voice файлд яриа танигдсангүй (${name}).`);
    work.write(cache,result.segments);return result.segments;
  };

  let sourceRows=spec.sourceSegments||null;
  let isSilent=Boolean(spec.isSilentVideo||!video.hasAudio);
  if(!isSilent&&!sourceRows) {
    const cache=path.join(dir,'source-transcript.json');
    const saved=work.read(cache);
    if(saved?.length) {
      sourceRows=saved;
    } else {
      try {
        emit({stage:'source-transcript'});
        const result=await whisper.transcribe(spec.source,{model:spec.whisperModel||'base',language:spec.sourceLanguage||'auto',signal,threads:4,
          onProgress:p=>emit({stage:'source-transcript',seconds:p.seconds})});
        if(result.segments?.length) {
          sourceRows=result.segments;
          work.write(cache,sourceRows);
        } else {
          isSilent=true;
        }
      } catch(e) {
        isSilent=true;
      }
    }
  }

  const voiceRows=await readVoiceTranscript(spec.voice,'mn',spec.voiceSegments,'voice-transcript');
  work.check(signal);
  const target=groups(voiceRows,25);
  if(!target.length||target.length>1000)throw new Error('Voice transcript size is unsupported; use a shorter voice file or subtitles.');
  if(target.at(-1).end>audio.duration+0.1)throw new Error('Subtitles extend beyond their matching voice media.');

  const planFile=path.join(dir,'alignment.json');
  let saved=work.read(planFile);
  let sourceCursor = Number.isFinite(spec.sourceOffset) ? Math.max(0, Math.min(video.duration - 0.5, spec.sourceOffset)) : 0;
  if(!saved) {
    if(isSilent) {
      emit({stage:'align',mode:'visual',voiceBlocks:target.length,videoDuration:video.duration});
      const provider=translate.provider(spec.translation.providerId);
      const systemPrompt=`You are an expert AI video director and editor.
You are given a silent video of duration ${Math.floor(video.duration)} seconds, and a series of Mongolian voiceover blocks that will be narrated over the video.

Task:
1. Based on the user's guidance and the Mongolian voice text, choose video cut ranges (sourceStart, sourceEnd) from the silent video (0 to ${Math.floor(video.duration)}s) to accompany each voice block.
2. For each voice block, provide 1 to 4 dynamic cuts (typically 3 to 8 seconds each) rather than one static shot.
3. Return JSON only conforming to the schema.`;

      const userPrompt=JSON.stringify({
        videoTotalSeconds:Math.floor(video.duration),
        userGuidance:spec.promptGuidance||'Match visual events to the narration with dynamic 3-7s cuts.',
        voiceBlocks:target.map(t=>({
          id:t.id,
          targetStart:Math.round(t.start*10)/10,
          targetEnd:Math.round(t.end*10)/10,
          duration:Math.round((t.end-t.start)*10)/10,
          text:t.text.slice(0,500)
        }))
      });

      const schema={
        type:'object',
        properties:{
          cuts:{
            type:'array',
            items:{
              type:'object',
              properties:{
                voiceBlockId:{type:'integer'},
                sourceStart:{type:'number'},
                sourceEnd:{type:'number'},
                description:{type:'string'}
              },
              required:['voiceBlockId','sourceStart','sourceEnd'],
              additionalProperties:false
            }
          }
        },
        required:['cuts'],
        additionalProperties:false
      };

      let cuts=[];
      try {
        const response=await provider.complete({
          apiKey,
          model:spec.translation.model||provider.defaultModel,
          signal,
          schema,
          system:systemPrompt,
          user:userPrompt
        });
        const json=translate.extractJson(response);
        cuts=json.cuts||json.plan||json.matches||[];
      } catch(err) {
        cuts=[];
      }

      saved=[];
      sourceCursor = Number.isFinite(spec.sourceOffset) ? Math.max(0, Math.min(video.duration - 0.5, spec.sourceOffset)) : 0;
      for(let i=0;i<target.length;i++) {
        const t=target[i];
        const blockStart=(i===0)?0:t.start;
        const blockEnd=target[i+1]?.start??audio.duration;
        const blockDur=Math.max(0.1,blockEnd-blockStart);

        let matchingCuts=cuts.filter(c=>c.voiceBlockId===t.id&&Number.isFinite(c.sourceStart)&&Number.isFinite(c.sourceEnd)&&c.sourceEnd>c.sourceStart);
        if(!matchingCuts.length) {
          // Sequential recap pacing: advance chronologically from sourceCursor!
          const desiredCount = Math.max(1, Math.min(4, Math.round(blockDur / 4)));
          const cutDur = blockDur / desiredCount;
          matchingCuts = [];
          for (let k = 0; k < desiredCount; k++) {
            const sStart = Math.min(video.duration - 0.2, sourceCursor);
            const sEnd = Math.min(video.duration, sStart + Math.max(0.4, cutDur));
            matchingCuts.push({
              voiceBlockId: t.id,
              sourceStart: sStart,
              sourceEnd: sEnd
            });
            sourceCursor = (sEnd >= video.duration - 0.5) ? 0 : sEnd;
          }
        }

        const totalSource=matchingCuts.reduce((s,c)=>s+Math.max(0.1,c.sourceEnd-c.sourceStart),0);
        let curTarget=blockStart;

        for(let j=0;j<matchingCuts.length;j++) {
          const c=matchingCuts[j];
          const srcStart=Math.max(0,Math.min(video.duration-0.1,c.sourceStart));
          const srcEnd=Math.max(srcStart+0.1,Math.min(video.duration,c.sourceEnd));
          const isLastCut=(j===matchingCuts.length-1);
          const cutTargetDur=isLastCut?(blockEnd-curTarget):(blockDur*(srcEnd-srcStart)/totalSource);
          const nextTarget=isLastCut?blockEnd:Math.min(blockEnd-0.05,curTarget+cutTargetDur);

          saved.push({
            id:saved.length,
            sourceStart:srcStart,
            sourceEnd:srcEnd,
            targetStart:curTarget,
            targetEnd:nextTarget,
            text:t.text,
            confidence:0.95,
            review:false
          });
          curTarget=nextTarget;
        }
      }
      validatePlan(saved,video.duration,audio.duration);
      work.write(planFile,saved);
    } else {
      const source=groups(sourceRows);
      if(!source.length||source.length>1000)throw new Error('Transcript size is unsupported; use a shorter video or grouped subtitles.');
      if(source.at(-1).end>video.duration+0.1)throw new Error('Subtitles extend beyond their matching media.');

      emit({stage:'align',sourceBlocks:source.length,voiceBlocks:target.length});
      const provider=translate.provider(spec.translation.providerId);
      const schema={type:'object',properties:{matches:{type:'array',items:{type:'object',properties:{targetId:{type:'integer'},sourceFirst:{type:'integer'},sourceLast:{type:'integer'},confidence:{type:'number'}},required:['targetId','sourceFirst','sourceLast','confidence'],additionalProperties:false}}},required:['matches'],additionalProperties:false};
      const response=await provider.complete({apiKey,model:spec.translation.model||provider.defaultModel,signal,schema,
        system:'You align the pictures of an existing narrated video to a separately recorded Mongolian narration. Match the SAME story events, people and actions across languages. The voice is already final and must never be rewritten. For EVERY target block choose an inclusive range of source block IDs showing that event. Preserve story order where possible; repeated or skipped source blocks are allowed when the voice repeats or summarizes events. Do not match by relative time or duration. If the event is absent or uncertain, return sourceFirst=-1, sourceLast=-1, confidence=0. Confidence must be 0 to 1. Return JSON only.',
        user:JSON.stringify({source:source.map(s=>({id:s.id,text:s.text.slice(0,800)})),target:target.map(s=>({id:s.id,text:s.text.slice(0,800)}))})});
      const matches=translate.extractJson(response).matches;
      if(!Array.isArray(matches)||matches.length!==target.length||new Set(matches.map(m=>m.targetId)).size!==target.length)throw new Error('Alignment omitted or duplicated voice blocks. Try again or import clearer transcripts.');
      saved=target.map((t,i)=>{
        const m=matches.find(m=>m.targetId===t.id);
        if(!m||!Number.isInteger(m.sourceFirst)||!Number.isInteger(m.sourceLast)||!Number.isFinite(m.confidence)||m.confidence<0||m.confidence>1)throw new Error('Invalid alignment response.');
        const a=source[m.sourceFirst],b=source[m.sourceLast];
        const matched=!!a&&!!b&&m.sourceLast>=m.sourceFirst;
        return {id:i,sourceStart:matched?a.start:0,sourceEnd:matched?Math.min(b.end,video.duration):Math.min(1,video.duration),
          targetStart:i===0?0:t.start,targetEnd:target[i+1]?.start??audio.duration,text:t.text,
          confidence:m.confidence,review:!matched||m.confidence<0.65};
      });
      for(let i=0;i<saved.length;) {
        let end=i+1;
        while(end<saved.length && saved[end].sourceStart===saved[i].sourceStart && saved[end].sourceEnd===saved[i].sourceEnd && !saved[end].review && !saved[i].review)end++;
        if(end-i>1) {
          const a=saved[i].sourceStart,b=saved[i].sourceEnd,total=saved[end-1].targetEnd-saved[i].targetStart;
          let cursor=a;
          for(let j=i;j<end;j++) {const next=j===end-1?b:cursor+(b-a)*(saved[j].targetEnd-saved[j].targetStart)/total;saved[j].sourceStart=cursor;saved[j].sourceEnd=next;cursor=next;}
        }
        i=end;
      }
      saved.forEach((row,i)=>{if((row.sourceEnd-row.sourceStart)/(row.targetEnd-row.targetStart)>2.5 || (i && row.sourceStart<saved[i-1].sourceEnd-0.1))row.review=true;});
      validatePlan(saved,video.duration,audio.duration);work.write(planFile,saved);
    }
  }
  validatePlan(saved,video.duration,audio.duration);

  const projectPath=path.join(dir,'voice-edited.cutline');
  const common={kind:'av',inPoint:0,filterId:'none',effectId:'none',transitionId:'none',opacity:1,volume:1};
  const document={
    format:'cutline-project',version:1,name:'Voice-edited recap',
    settings:{width:Math.max(2,Math.floor(Math.min(1920,video.width||1920)/2)*2),height:Math.max(2,Math.floor((video.height||1080)*(video.width?Math.min(1920,video.width)/(video.width):1)/2)*2),fps:Math.min(60,video.fps||30)},
    media:[
      {id:'picture-source',path:path.resolve(spec.source),name:path.basename(spec.source),kind:'video',duration:video.duration,width:video.width||1920,height:video.height||1080,fps:video.fps||30,hasAudio:false,thumbs:[]},
      {id:'voice',path:path.resolve(spec.voice),name:path.basename(spec.voice),kind:'audio',duration:audio.duration,width:0,height:0,fps:30,hasAudio:true,thumbs:[]}
    ],
    tracks:[
      {id:'pictures',kind:'video',name:'Voice-matched pictures',muted:false,hidden:false,locked:false},
      {id:'voice',kind:'audio',name:'Supplied Mongolian voice',muted:false,hidden:false,locked:false}
    ],
    clips:[
      ...saved.map((s,i)=>({
        ...common,
        id:`clip-${i}`,
        mediaId:'picture-source',
        trackId:'pictures',
        start:s.targetStart,
        inPoint:s.sourceStart,
        outPoint:s.sourceStart+(s.targetEnd-s.targetStart),
        volume:0
      })),
      {
        ...common,
        id:'voice',
        mediaId:'voice',
        trackId:'voice',
        start:0,
        outPoint:audio.duration
      }
    ]
  };
  work.write(projectPath,document);

  const result={dir,source:spec.source,voice:spec.voice,videoDuration:video.duration,voiceDuration:audio.duration,
    width:video.width,height:video.height,fps:Math.min(60,video.fps||30),plan:saved,projectPath,isSilent,
    nextSourceOffset:sourceCursor,prepareSeconds:(Date.now()-started)/1000};
  work.write(path.join(dir,'project.json'),result);
  return result;
}

async function encoder(dir,signal) {
  for(const id of ['h264_nvenc','h264_qsv','h264_amf']) {
    try {
      await run(ff.FFMPEG,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=s=128x128:d=0.1','-c:v',id,'-f','null','-'],signal);
      return id;
    } catch {work.check(signal);}
  }
  return 'libx264';
}
async function render(project,plan,outPath,signal,progress) {
  validatePlan(plan,project.videoDuration,project.voiceDuration);
  if(plan.some(s=>s.review))throw new Error('Confirm or correct the highlighted picture ranges before rendering.');
  if([project.source,project.voice].some(p=>path.resolve(p).toLowerCase()===path.resolve(outPath).toLowerCase()))throw new Error('Export cannot overwrite an input.');
  const started=Date.now();
  const width=Math.max(2,Math.floor(Math.min(1920,project.width)/2)*2);
  const height=Math.max(2,Math.floor(project.height*width/project.width/2)*2);
  const codec=await encoder(project.dir,signal);
  const dir=path.join(project.dir,'render-'+work.hash({plan,width,height,fps:project.fps,codec}).slice(0,16));
  fs.mkdirSync(dir,{recursive:true});
  let done=0;
  const files=await work.map(plan,2,async(s,i)=>{
    const file=path.join(dir,`${i}.mp4`);
    if(!fs.existsSync(file)) {
      const duration=s.targetEnd-s.targetStart;
      const ratio=(s.sourceEnd-s.sourceStart)/duration;
      // Keep all selected pictures; slow at most 1.5x, then hold the last frame.
      const speed=Math.max(2/3,ratio);
      const filter=`setpts=(PTS-STARTPTS)/${speed},scale=${width}:${height},setsar=1,fps=${project.fps},tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS`;
      const tmp=path.join(dir,`${i}.part.mp4`);
      const args=['-hide_banner','-loglevel','error','-y','-ss',String(s.sourceStart),'-t',String(s.sourceEnd-s.sourceStart),'-i',project.source,'-an','-vf',filter,'-c:v',codec];
      if(codec==='libx264')args.push('-preset','veryfast','-crf','22','-threads','4');
      args.push('-pix_fmt','yuv420p',tmp);
      try {await run(ff.FFMPEG,args,signal);fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
    }
    progress?.({stage:'render',done:++done,total:plan.length,encoder:codec,elapsedSeconds:(Date.now()-started)/1000});
    return file;
  },signal);
  const list=path.join(dir,'video.ffconcat');
  // Explicit timeline durations prevent rounding each clip up to a video frame
  // from accumulating seconds of drift over hundreds of edits.
  fs.writeFileSync(list,'ffconcat version 1.0\n'+files.map((_,i)=>`file '${i}.mp4'\nduration ${(plan[i].targetEnd-plan[i].targetStart).toFixed(6)}`).join('\n'));
  const tmp=path.join(path.dirname(outPath),`.voice-edit-${Date.now()}.mp4`);
  try {
    await run(ff.FFMPEG,['-hide_banner','-loglevel','error','-y','-f','concat','-safe','1','-i',list,'-i',project.voice,
      '-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-t',String(project.voiceDuration),'-movflags','+faststart',tmp],signal);
    const info=await ff.probe(tmp);
    if(!info.hasAudio||!info.hasVideo||Math.abs(info.duration-project.voiceDuration)>0.2)throw new Error('Rendered duration does not match the supplied voice.');
    fs.renameSync(tmp,outPath);
  } finally {if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  work.write(path.join(project.dir,'alignment.json'),plan);
  const media=plan.map((s,i)=>({id:`picture-${i}`,path:files[i],name:`Picture ${i+1}`,kind:'video',duration:s.targetEnd-s.targetStart,width,height,fps:project.fps,hasAudio:false,thumbs:[]}));
  media.push({id:'voice',path:project.voice,name:path.basename(project.voice),kind:'audio',duration:project.voiceDuration,width:0,height:0,fps:30,hasAudio:true,thumbs:[]});
  const common={kind:'av',inPoint:0,filterId:'none',effectId:'none',transitionId:'none',opacity:1,volume:1};
  const document={format:'cutline-project',version:1,name:'Voice-edited recap',settings:{width,height,fps:project.fps},media,
    tracks:[{id:'pictures',kind:'video',name:'Voice-matched pictures',muted:true,hidden:false,locked:false},{id:'voice',kind:'audio',name:'Supplied Mongolian voice',muted:false,hidden:false,locked:false}],
    clips:[...plan.map((s,i)=>({...common,id:`clip-${i}`,mediaId:`picture-${i}`,trackId:'pictures',start:s.targetStart,outPoint:s.targetEnd-s.targetStart,volume:0})),
      {...common,id:'voice',mediaId:'voice',trackId:'voice',start:0,outPoint:project.voiceDuration}]};
  const projectPath=path.join(project.dir,'voice-edited.cutline');work.write(projectPath,document);
  const report={path:outPath,projectPath,encoder:codec,voiceDuration:project.voiceDuration,renderSeconds:(Date.now()-started)/1000,plan};
  const reportPath=path.join(project.dir,'render-report.json');work.write(reportPath,report);
  return {...report,reportPath};
}

/** Synchronize video to voice for direct timeline placement without exporting */
async function syncTimelineVoice(spec, progress) {
  const {
    videoPath,
    voicePath,
    sourceOffset = 0,
    voiceOffset = 0,
    voiceDuration = null,
    style = 'dynamic',
    method = 'auto',
    whisperModel = 'base'
  } = spec;
  const [video, audio] = await Promise.all([ff.probe(videoPath), ff.probe(voicePath)]);
  if (!video.hasVideo || video.duration <= 0) throw new Error('Сонгосон видео олдсонгүй эсвэл дүрсгүй байна.');
  if (!audio.hasAudio || audio.duration <= 0) throw new Error('Сонгосон voice файл аудио дуугүй байна.');

  const effVoiceDuration = (typeof voiceDuration === 'number' && voiceDuration > 0)
    ? Math.min(voiceDuration, Math.max(0.5, audio.duration - voiceOffset))
    : Math.max(0.5, audio.duration - voiceOffset);

  progress?.({ stage: 'start', message: '🎙️ Voice ярианы амьсгаа, хэмнэлийг хэмжиж байна...' });

  let speechSegments = [];
  // Only run local CPU whisper if explicitly requested; otherwise use instant, high-precision speech-pause detection (~0.15s)
  if (method === 'whisper') {
    const ws = whisper.status();
    const hasModel = ws.models.some(m => m.id === whisperModel && m.installed);
    if (ws.available && hasModel) {
      try {
        progress?.({ stage: 'transcribe', message: '🎤 Whisper AI: Яриаг таньж байна...' });
        const res = await whisper.transcribe(voicePath, {
          model: whisperModel,
          language: 'mn',
          onProgress: (p) => progress?.({ stage: 'transcribe', message: `🎤 Whisper AI: Яриаг таньж байна (${Math.round(p?.seconds || 0)}с)...` })
        });
        if (res.segments?.length) {
          speechSegments = res.segments;
        }
      } catch (err) {
        console.warn('[syncTimelineVoice] whisper error:', err.message);
      }
    }
  }

  const apiKey = spec.geminiApiKey || settings.secret('geminiApiKey') || process.env.GEMINI_API_KEY || '';
  let visionAIUsed = false;
  let visionError = null;

  let curSource = Number.isFinite(sourceOffset) ? Math.max(0, Math.min(video.duration - 0.5, sourceOffset)) : 0;

  // If Vision AI is explicitly requested with API key:
  // Transcribe voice with Gemini first to get actual Mongolian speech sentences and scene context
  if (apiKey && spec.useVision === true && !speechSegments.length) {
    try {
      progress?.({ stage: 'transcribe', message: '🎙️ Gemini AI: Монгол яриаг өгүүлбэр бүрээр таньж байна...' });
      const geminiSegs = await visionSync.transcribeVoiceWithGemini({
        voicePath,
        apiKey,
        startOffset: voiceOffset,
        duration: effVoiceDuration
      });
      if (Array.isArray(geminiSegs) && geminiSegs.length) {
        speechSegments = geminiSegs.map((s, idx) => ({
          id: idx,
          start: Math.max(0, Math.min(effVoiceDuration, Number(s.start || 0))),
          end: Math.max(0, Math.min(effVoiceDuration, Number(s.end || 0))),
          text: s.text || `Өгүүлбэр ${idx + 1}`,
          visualEvent: s.visualEvent || ''
        }));
      }
    } catch (tErr) {
      console.warn('[syncTimelineVoice] transcribeVoiceWithGemini fallback:', tErr.message);
    }
  }

  // 1. High-Precision Audio Narration Segmentation
  // Use instant speech pause & cadence detection (~0.15s) to capture breaths and pauses
  if (!speechSegments.length) {
    try {
      const raw = await ff.detectSpeechSegments(voicePath, {
        startOffset: voiceOffset,
        duration: effVoiceDuration,
        minSilence: 0.25,
        noise: '-30dB'
      });
      if (raw.length) {
        for (let idx = 0; idx < raw.length; idx++) {
          const s = raw[idx];
          const segStart = Math.max(0, Math.min(effVoiceDuration, s.start));
          const segEnd = Math.max(segStart + 0.2, Math.min(effVoiceDuration, s.end));
          const dur = segEnd - segStart;
          // Divide long sentences (>4.2s) into natural 2.4s - 3.4s rhythm cuts
          if (dur > 4.2) {
            const subCount = Math.max(2, Math.round(dur / 2.8));
            const subDur = dur / subCount;
            for (let k = 0; k < subCount; k++) {
              speechSegments.push({
                id: speechSegments.length,
                start: segStart + k * subDur,
                end: (k === subCount - 1) ? segEnd : segStart + (k + 1) * subDur,
                text: `Өгүүлбэр ${speechSegments.length + 1}`
              });
            }
          } else {
            speechSegments.push({
              id: speechSegments.length,
              start: segStart,
              end: segEnd,
              text: `Өгүүлбэр ${speechSegments.length + 1}`
            });
          }
        }
      }
    } catch (segErr) {
      console.warn('[syncTimelineVoice] detectSpeechSegments error:', segErr.message);
    }
  }

  // Fallback if audio is completely flat or silent
  if (!speechSegments.length) {
    const chunkLen = style === 'dynamic' ? 3.2 : 4.0;
    const n = Math.ceil(effVoiceDuration / chunkLen);
    for (let i = 0; i < n; i++) {
      const s = i * chunkLen;
      const e = Math.min(effVoiceDuration, (i + 1) * chunkLen);
      speechSegments.push({ id: i, start: s, end: e, text: `Кадр ${i + 1}` });
    }
  }

  // 2. Chunked Progressive Streaming Sync
  // Divide speechSegments into small chunks of ~6 segments (~16-24s each)
  // Each chunk matches and renders to the timeline immediately!
  const CHUNK_SIZE = 6;
  const chunkGroups = [];
  for (let i = 0; i < speechSegments.length; i += CHUNK_SIZE) {
    chunkGroups.push(speechSegments.slice(i, i + CHUNK_SIZE));
  }

  const allCuts = [];
  const totalChunks = chunkGroups.length;

  for (let cIdx = 0; cIdx < totalChunks; cIdx++) {
    const chunkSegs = chunkGroups[cIdx];
    const chunkStart = chunkSegs[0].start;
    const chunkEnd = chunkSegs[chunkSegs.length - 1].end;
    const chunkDuration = Math.max(5, chunkEnd - chunkStart);

    progress?.({
      stage: 'chunk-start',
      chunkIndex: cIdx,
      totalChunks,
      message: `⚡ [${cIdx + 1}/${totalChunks}] ${Math.floor(chunkStart)}s - ${Math.floor(chunkEnd)}s хэсгийг эвлүүлж байна...`
    });

    let chunkMatches = null;
    let chunkKeyframes = [];

    if (apiKey && spec.useVision === true) {
      try {
        // Wide keyframe extraction window so Vision AI can locate the true comic panel/scene
        const searchDur = Math.min(video.duration - curSource, Math.max(75, chunkDuration * 3.5));
        const targetFrames = Math.min(24, Math.max(12, Math.round(chunkSegs.length * 2.5)));
        chunkKeyframes = await visionSync.extractKeyframes(videoPath, {
          startOffset: curSource,
          searchDuration: searchDur,
          targetFrames
        });

        if (chunkKeyframes.length) {
          const matches = await visionSync.matchWithGeminiVision({
            speechSegments: chunkSegs,
            keyframes: chunkKeyframes,
            apiKey,
            model: spec.geminiModel || 'gemini-2.0-flash'
          });
          if (matches && matches.length) {
            chunkMatches = matches;
            visionAIUsed = true;
          }
        }
      } catch (vErr) {
        visionError = vErr.message;
        console.warn(`[VisionSync] Chunk ${cIdx} vision fallback:`, vErr.message);
      }
    }

    // Determine target cuts and timestamps for this chunk
    const chunkCutSpecs = [];
    for (let j = 0; j < chunkSegs.length; j++) {
      const seg = chunkSegs[j];
      const globalIdx = allCuts.length + j;
      const tStart = (globalIdx === 0) ? 0 : seg.start;
      const nextSeg = (j < chunkSegs.length - 1) ? chunkSegs[j + 1] : (cIdx < totalChunks - 1 ? chunkGroups[cIdx + 1][0] : null);
      const tEnd = nextSeg ? nextSeg.start : effVoiceDuration;
      const cutDur = Math.max(0.4, tEnd - tStart);

      const vMatch = chunkMatches?.find((m) => m.blockId === seg.id || m.blockId === j);
      let matchedTs = curSource;
      let shouldFreeze = false;

      if (vMatch && Number.isFinite(vMatch.sourceTimestamp)) {
        matchedTs = Math.max(0, Math.min(video.duration - 0.5, vMatch.sourceTimestamp));
        shouldFreeze = vMatch.freeze !== undefined ? Boolean(vMatch.freeze) : (cutDur > 2.8);
      } else {
        // Intelligent Hybrid Decision:
        // When spec.mode === 'motion': 100% motion
        // When spec.mode === 'freeze': 100% freeze
        // Default (hybrid): dynamic video motion cuts with occasional freeze holds for long explanations
        if (spec.mode === 'motion') {
          shouldFreeze = false;
        } else if (spec.mode === 'freeze') {
          shouldFreeze = true;
        } else {
          // If file is longer than 2 minutes, cap freeze extraction to max 1 per chunk
          const currentChunkFreezes = chunkCutSpecs.filter((c) => c.shouldFreeze).length;
          const freezeAllowed = (effVoiceDuration <= 120) || (currentChunkFreezes === 0);

          if (freezeAllowed && cutDur >= 4.0) {
            shouldFreeze = true; // Long dialogue/explanation panel -> Freeze hold!
          } else {
            shouldFreeze = false; // Fast action / narrative flow -> Dynamic video motion!
          }
        }
      }

      // If near end of video, hold final frame
      if (curSource >= video.duration - 1.2) {
        matchedTs = Math.max(0, video.duration - 0.5);
        shouldFreeze = true;
      }

      // Advance curSource chronologically with zero backward jumps or random skips
      if (!shouldFreeze) {
        curSource = Math.min(video.duration - 0.5, matchedTs + cutDur);
      } else {
        const panelAdvance = Math.max(1.0, Math.min(3.0, cutDur * 0.5));
        curSource = Math.min(video.duration - 0.5, matchedTs + panelAdvance);
      }

      chunkCutSpecs.push({
        id: globalIdx,
        matchedTs,
        tStart,
        tEnd,
        cutDur,
        shouldFreeze,
        text: seg.text || (vMatch?.reason ? vMatch.reason : `Кадр ${globalIdx + 1}`),
        reason: vMatch?.reason || seg.visualEvent || ''
      });
    }

    // Parallel extract freeze frames for this chunk using keyframe cache
    const freezeTimestamps = chunkCutSpecs.filter((c) => c.shouldFreeze).map((c) => c.matchedTs);
    let freezeMap = new Map();
    if (freezeTimestamps.length) {
      try {
        freezeMap = await ff.extractFreezeFrameBatch(videoPath, freezeTimestamps, chunkKeyframes);
      } catch (fErr) {
        console.warn(`[VisionSync] Chunk ${cIdx} freeze batch fallback:`, fErr.message);
      }
    }

    const chunkCuts = [];
    for (const specItem of chunkCutSpecs) {
      const freezeImagePath = specItem.shouldFreeze ? (freezeMap.get(specItem.matchedTs) || null) : null;
      const cutObj = {
        id: specItem.id,
        sourceStart: Math.round(specItem.matchedTs * 1000) / 1000,
        sourceEnd: Math.round((specItem.matchedTs + specItem.cutDur) * 1000) / 1000,
        targetStart: Math.round(specItem.tStart * 1000) / 1000,
        targetEnd: Math.round(specItem.tEnd * 1000) / 1000,
        duration: Math.round(specItem.cutDur * 1000) / 1000,
        text: specItem.text,
        reason: specItem.reason,
        freeze: specItem.shouldFreeze && Boolean(freezeImagePath),
        freezeImagePath
      };
      chunkCuts.push(cutObj);
      allCuts.push(cutObj);
    }

    // EMIT CHUNK PROGRESS EVENT IMMEDIATELY TO TIMELINE!
    progress?.({
      type: 'chunk',
      stage: 'chunk',
      chunkIndex: cIdx,
      totalChunks,
      cuts: chunkCuts,
      isFirst: cIdx === 0,
      isLast: cIdx === totalChunks - 1,
      nextSourceOffset: curSource,
      message: `⚡ [${cIdx + 1}/${totalChunks}] ${chunkCuts.length} кадр Timeline дээр гарлаа!`
    });
  }

  progress?.({ stage: 'done', message: '✨ Бэлэн боллоо!' });

  return {
    ok: true,
    videoDuration: video.duration,
    voiceDuration: effVoiceDuration,
    cuts: allCuts,
    nextSourceOffset: curSource,
    visionAIUsed,
    visionError
  };
}

module.exports={prepare,render,validatePlan,groups,syncTimelineVoice};

