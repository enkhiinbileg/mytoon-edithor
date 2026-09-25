'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const ff = require('./ffmpeg');
const whisper = require('./whisper');
const translate = require('./translate');
const dub = require('./dub');
const work = require('./recap-work');
const { exportRecap } = require('./recap-export');

function validateSegments(segments, duration) {
  const ids = new Set();
  for (let i=0; i<segments.length; i++) {
    const s = segments[i];
    if (!Number.isInteger(s.id) || ids.has(s.id) || !Number.isFinite(s.start) || !Number.isFinite(s.end) ||
      s.start < 0 || s.end <= s.start || s.end > duration+0.1 || (i && s.start <= segments[i-1].start) || typeof s.text !== 'string')
      throw new Error('Transcript must have unique IDs and increasing timestamps inside the source video.');
    ids.add(s.id);
  }
}
const stamp = n => {
  const ms = Math.max(0,Math.round(n*1000));
  return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;
};

async function run(spec, credentials, signal, progress, overrides = {}) {
  const deps = { ff, whisper, translate, dub, exportRecap, ...overrides };
  const started = Date.now();
  let reserved = 0, cached = 0, finished = 0;
  const budget = Number(spec.characterBudget);
  if (!Number.isInteger(budget) || budget < 1 || budget > 2000000) throw new Error('Set a character budget between 1 and 2,000,000.');
  const stat = fs.statSync(spec.source);
  const info = await deps.ff.probe(spec.source);
  if (!info.hasVideo || !(info.duration > 0)) throw new Error('Choose a video with a known duration.');
  if (path.resolve(spec.source).toLowerCase() === path.resolve(spec.outPath).toLowerCase()) throw new Error('Output cannot overwrite the source.');
  const concurrency = Math.max(1,Math.min(20,Math.floor(Number(spec.concurrency)||2)));
  const config = { source: path.resolve(spec.source), size: stat.size, mtime: stat.mtimeMs,
    sourceLanguage: spec.sourceLanguage, whisperModel: spec.whisperModel, language: spec.language,
    translation: spec.translation, voice: spec.voice, glossary: spec.glossary || '', segments: spec.segments || null };
  const dir = path.join(app.getPath('userData'),'fast-recap',work.hash(config).slice(0,24));
  fs.mkdirSync(dir,{recursive:true});
  const reportPath = path.join(dir,'report.json');
  const durations = { transcribeMs: 0, translateMs: 0, speechMs: 0, exportMs: 0 };
  const report = { version:1, source:spec.source, duration:info.duration, targetSeconds:600, concurrency, startedAt:new Date().toISOString(), status:'running' };
  const emit = data => progress?.({ elapsedSeconds:(Date.now()-started)/1000, reservedCharacters:reserved, cached, ...data });
  const voiceLimiter = work.limiter(concurrency,signal);
  const translated = [], clips = [];
  const reserveCharacters = count => {
    if (reserved+count > budget) throw new Error(`Character budget reached (${budget}). Completed audio is saved. Increase the budget to resume.`);
    reserved += count;
  };
  const timed = async (key,fn) => { const t=Date.now(); try { return await fn(); } finally { durations[key]+=Date.now()-t; } };
  let chunks;
  try {
    if (spec.segments?.length) {
      validateSegments(spec.segments,info.duration);
      chunks = Array.from({length:Math.ceil(spec.segments.length/30)},(_,i) => ({segments:spec.segments.slice(i*30,i*30+30), start:spec.segments[i*30].start,
        end:spec.segments[(i+1)*30]?.start ?? info.duration}));
    } else {
      const status = deps.whisper.status();
      if (!status.available || !status.models.some(m=>m.id===spec.whisperModel && m.installed)) throw new Error('Install the selected Whisper model, or import matching SRT/VTT and enable Use transcript.');
      chunks = Array.from({length:Math.ceil(info.duration/120)},(_,i)=>({start:i*120,end:Math.min(info.duration,(i+1)*120)}));
    }
    work.write(reportPath,report);
    await work.map(chunks,2,async (chunk,index) => {
      work.check(signal);
      const file = path.join(dir,`chunk-${index}.json`);
      const state = work.read(file) || {};
      let rows = chunk.segments || state.source;
      if (!rows) {
        emit({stage:'transcribe',chunk:index+1,total:chunks.length});
        const result = await timed('transcribeMs',()=>deps.whisper.transcribe(spec.source,{model:spec.whisperModel,language:spec.sourceLanguage,
          start:chunk.start,duration:chunk.end-chunk.start,threads:4,signal}));
        rows = result.segments.map((s,i)=>({...s,id:index*100000+i,end:Math.min(s.end,chunk.end)})).filter(s=>s.end>s.start);
        validateSegments(rows,info.duration);
        state.source = rows;
        work.write(file,state);
      }
      if (!rows.length) { finished++; emit({stage:'processed',done:finished,total:chunks.length}); return; }
      work.check(signal);
      let output = state.translated || rows;
      const missing = output.filter(s=>!s.translated?.trim());
      if (missing.length) {
        emit({stage:'translate',chunk:index+1,total:chunks.length});
        const result = await timed('translateMs',()=>deps.translate.translateSegments(missing,{...spec.translation,apiKey:credentials.translation,
          language:spec.language,glossary:spec.glossary,strict:true,signal}));
        const byId = new Map(result.map(s=>[s.id,s]));
        output = output.map(s=>byId.get(s.id)||s);
        if (output.some(s=>!s.translated?.trim())) throw new Error('Translation is incomplete.');
        state.translated = output;
        work.write(file,state);
      }
      const speak = async (rowsToSpeak) => timed('speechMs',()=>deps.dub.synthesize(rowsToSpeak,{...spec.voice,...credentials.voice,
        concurrency,limiter:voiceLimiter,signal,mediaDuration:info.duration,slotEnd:chunk.end,reserveCharacters},p=>emit({stage:'speak',chunk:index+1,totalChunks:chunks.length,...p})));
      let result = await speak(output);
      cached += result.cached || 0;
      // One bounded rewrite pass. Residual overflow is a review item, never silently cut.
      const long = result.clips.filter(c=>c.overflow>0.06);
      if (long.length && !state.rewritten) {
        const bad = new Map(long.map(c=>[c.id,c]));
        const shorter = output.filter(s=>bad.has(s.id)).map(s=>({...s,end:s.start+Math.max(0.2,(s.end-s.start)*0.72)}));
        emit({stage:'shorten',chunk:index+1,count:long.length});
        const rewritten = await timed('translateMs',()=>deps.translate.translateSegments(shorter,{...spec.translation,apiKey:credentials.translation,
          language:spec.language,glossary:spec.glossary,strict:true,signal,
          instruction:'The narration was too long. Use substantially fewer spoken words while preserving events, names, numbers, and causality. Never invent or remove a plot event.'}));
        const texts = new Map(rewritten.map(s=>[s.id,s.translated]));
        output = output.map(s=>texts.has(s.id)?{...s,translated:texts.get(s.id)}:s);
        state.translated = output; state.rewritten = true; work.write(file,state);
        result = await speak(output); cached += result.cached || 0;
      }
      translated.push(...output); clips.push(...result.clips);
      state.clips = result.clips; work.write(file,state);
      finished++; emit({stage:'processed',done:finished,total:chunks.length});
    },signal);
    translated.sort((a,b)=>a.start-b.start); clips.sort((a,b)=>a.start-b.start);
    if (!clips.length) throw new Error('No speech was found.');
    const issues = clips.filter((c,i)=>c.overflow>0.06 || c.start+c.duration > (clips[i+1]?.start??info.duration)+0.06)
      .map(c=>({id:c.id,start:c.start,overflow:c.overflow,text:c.text}));
    const transcriptPath = path.join(dir,'transcript.json');
    work.write(transcriptPath,{version:1,segments:translated,sourcePath:spec.source,language:spec.language});
    const srtPath = path.join(dir,'mongolian.srt');
    fs.writeFileSync(srtPath,translated.map((s,i)=>`${i+1}\n${stamp(s.start)} --> ${stamp(Math.min(info.duration,clips[i+1]?.start??Math.max(s.end,s.start+(clips[i]?.duration||0))))}\n${s.translated}\n`).join('\n'));
    // A fully editable project uses the original video plus individual narration clips.
    const video = {id:'source',path:spec.source,name:path.basename(spec.source),kind:'video',...info,thumbs:[]};
    const audio = clips.map(c=>({id:`voice-${c.id}`,path:c.file,name:c.text.slice(0,50),kind:'audio',duration:c.duration,width:0,height:0,fps:30,hasAudio:true,thumbs:[]}));
    const base = {kind:'av',inPoint:0,filterId:'none',effectId:'none',transitionId:'none',opacity:1,volume:1};
    const project = {format:'cutline-project',version:1,name:path.basename(spec.source)+' · Монгол',settings:{width:info.width,height:info.height,fps:info.fps},
      media:[video,...audio],tracks:[{id:'video',kind:'video',name:'Original video',muted:true,hidden:false,locked:false},{id:'voice',kind:'audio',name:'Монгол',muted:false,hidden:false,locked:false}],
      clips:[{...base,id:'video',mediaId:'source',trackId:'video',start:0,outPoint:info.duration,volume:0},...clips.map(c=>({...base,id:`clip-${c.id}`,mediaId:`voice-${c.id}`,trackId:'voice',start:c.start,outPoint:c.duration}))]};
    const projectPath = path.join(dir,'recap.cutline');
    work.write(projectPath,project);
    const output = issues.length ? {} : await timed('exportMs',()=>deps.exportRecap({source:spec.source,clips,duration:info.duration,outPath:spec.outPath,dir,signal,onProgress:emit}));
    Object.assign(report,{status:issues.length?'review':'complete',elapsedSeconds:(Date.now()-started)/1000,stageWorkerMilliseconds:durations,
      reservedCharacters:reserved,cached,issues,transcriptPath,srtPath,projectPath,...output});
    work.write(reportPath,report);
    return {...report,reportPath};
  } catch (err) {
    Object.assign(report,{status:signal?.aborted?'stopped':'failed',error:String(err.message||err),elapsedSeconds:(Date.now()-started)/1000,
      reservedCharacters:reserved,cached,stageWorkerMilliseconds:durations});
    work.write(reportPath,report);
    err.reportPath = reportPath;
    throw err;
  }
}
module.exports = { run, validateSegments };
