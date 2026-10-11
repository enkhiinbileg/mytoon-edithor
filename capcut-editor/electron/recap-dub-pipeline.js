'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const ff = require('./ffmpeg');
const whisper = require('./whisper');
const translate = require('./translate');
const elevenlabsPool = require('./elevenlabs-pool');
const { planFit, validatePlan } = require('./fit-planner');
const { materializeFreezeFrames } = require('./recap-freeze');
const { validateProject, atomicWrite, ensureProjectCover } = require('./project-store');
const settings = require('./settings');

/**
 * Format timestamp in SRT style: 00:00:00,000
 */
function toSrtTimestamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hrs = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const remMs = ms % 1000;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(remMs).padStart(3, '0')}`;
}

/**
 * Group raw Whisper transcription segments into natural speech chunks (target 3-8s).
 */
function chunkTranscript(segments, maxDuration = 7.5, minDuration = 2.5) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const clean = segments
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .map((s, idx) => ({
      id: idx,
      start: Number(s.start || 0),
      end: Number(s.end || 0),
      text: s.text.trim()
    }))
    .filter((s) => s.end > s.start);

  if (clean.length === 0) return [];

  const chunks = [];
  let curGroup = [];
  let curStart = clean[0].start;

  const isSentenceEnd = (text) => /[.!?…]["']?$/.test(text.trim());

  for (let i = 0; i < clean.length; i++) {
    const s = clean[i];
    curGroup.push(s);
    const duration = s.end - curStart;
    const isPunctEnd = isSentenceEnd(s.text);
    const hasNext = i + 1 < clean.length;
    const nextGap = hasNext ? clean[i + 1].start - s.end : 0;
    const isNaturalBreak = nextGap > 0.45;

    // Conditions to commit chunk:
    // 1. Duration >= minDuration and sentence ends with punctuation or noticeable pause
    // 2. Or duration reaches maxDuration
    // 3. Or it's the last segment
    const shouldClose = !hasNext ||
      duration >= maxDuration ||
      (duration >= minDuration && (isPunctEnd || isNaturalBreak));

    if (shouldClose) {
      const combinedText = curGroup.map((g) => g.text).join(' ').replace(/\s+/g, ' ').trim();
      chunks.push({
        id: chunks.length,
        srcStart: Math.round(curStart * 1000) / 1000,
        srcEnd: Math.round(s.end * 1000) / 1000,
        text: combinedText
      });
      curGroup = [];
      if (hasNext) curStart = clean[i + 1].start;
    }
  }

  if (curGroup.length > 0) {
    const s = curGroup[curGroup.length - 1];
    chunks.push({
      id: chunks.length,
      srcStart: Math.round(curStart * 1000) / 1000,
      srcEnd: Math.round(s.end * 1000) / 1000,
      text: curGroup.map((g) => g.text).join(' ').trim()
    });
  }

  return chunks;
}

/**
 * Main Recap Dubbing Pipeline Orchestrator.
 *
 * Steps:
 * 0. Preflight checks (video existence, credentials, disk space)
 * 1. Transcription (Groq Whisper large-v3 or user SRT)
 * 2. Natural sentence chunking (3-8 seconds speech boundaries)
 * 3. Mongolian Translation with character budgeting (Groq / Claude / Gemini)
 * 4. Voiceover Synthesis (ElevenLabs multi-key pool with per-chunk disk cache)
 * 5. Video Fit Planning (Video follows voice: motion cuts + freeze frame holds)
 * 6. Freeze Frame Materialization (High-res PNG extraction via recap-freeze)
 * 7. Cutline Project Document Generation (Editable timeline with V1, A1, O1 tracks)
 * 8. Final MP4 Export (Hardware accelerated render matching the Cutline project)
 */
async function runRecapDubPipeline(spec, onProgress, signal) {
  const startedAt = Date.now();
  const sourcePath = path.resolve(spec.source);

  // --- STAGE 0: Pre-flight checks ---
  onProgress?.({ stage: 'preflight', message: 'Эх видео болон API тохиргоог шалгаж байна...' });
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Эх видео олдсонгүй: ${sourcePath}`);
  }

  const stat = fs.statSync(sourcePath);
  if (stat.size === 0) throw new Error('Эх видео файл хоосон байна.');

  const videoInfo = await ff.probe(sourcePath);
  if (!videoInfo.hasVideo || !(videoInfo.duration > 0)) {
    throw new Error('Видеог уншиж чадсангүй. Видео файл гэмтсэн эсвэл хугацаа нь тодорхойгүй байна.');
  }

  const videoDuration = videoInfo.duration;
  const width = videoInfo.width || 1920;
  const height = videoInfo.height || 1080;
  const fps = videoInfo.fps || 30;

  // Check ElevenLabs keys
  const pool = settings.getKeyPoolDecrypted();
  const singleKey = settings.secret('elevenLabsApiKey') || process.env.ELEVENLABS_API_KEY;
  if ((!pool || pool.length === 0) && !singleKey) {
    throw new Error('ElevenLabs API түлхүүр бүртгэгдээгүй байна. "Түлхүүрийн сан"-д түлхүүр нэмнэ үү.');
  }

  // Determine paths & directories
  const appData = app.getPath('userData');
  const projectDir = path.join(appData, 'projects');
  const freezeDir = path.join(appData, 'freeze-frames');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(freezeDir, { recursive: true });

  const configHash = crypto.createHash('sha256')
    .update(`${sourcePath}\0${stat.size}\0${stat.mtimeMs}\0${spec.voiceId || 'default'}\0${spec.targetLanguage || 'mn'}`)
    .digest('hex').slice(0, 16);

  const cacheDir = path.join(appData, 'recap-dub-cache', configHash);
  fs.mkdirSync(cacheDir, { recursive: true });

  const ext = path.extname(sourcePath);
  const baseName = path.basename(sourcePath, ext);
  const outPath = spec.outPath ? path.resolve(spec.outPath) : path.join(path.dirname(sourcePath), `${baseName}_mongol_recap.mp4`);

  // --- STAGE 1: Transcription ---
  let rawSegments = spec.segments;
  if (!rawSegments || rawSegments.length === 0) {
    onProgress?.({ stage: 'transcribe', message: '🎙️ Англи яриаг таньж байна (Groq Whisper Large-v3)...' });
    const whisperRes = await whisper.transcribe(sourcePath, {
      model: spec.whisperModel || 'groq-whisper-large-v3',
      language: spec.sourceLanguage || 'en',
      signal,
      onProgress: (p) => onProgress?.({ stage: 'transcribe', ...p })
    });
    rawSegments = whisperRes.segments || [];
  }

  if (!rawSegments || rawSegments.length === 0) {
    throw new Error('Яриа олдсонгүй (эсвэл хоосон байна). Эх видео дээр яриа байгаа эсэхийг шалгана уу.');
  }

  // --- STAGE 2: Sentence chunking ---
  onProgress?.({ stage: 'chunking', message: 'Өгүүлбэрүүдийг байгалийн уншилтад тохируулан бүлэглэж байна...' });
  const chunks = chunkTranscript(rawSegments, spec.maxChunkDuration || 7.5, spec.minChunkDuration || 2.5);
  if (chunks.length === 0) {
    throw new Error('Өгүүлбэр хуваарилалт хоосон байна.');
  }

  // --- STAGE 3: Mongolian Translation ---
  onProgress?.({ stage: 'translate', totalChunks: chunks.length, message: `🇲🇳 ${chunks.length} өгүүлбэрийг Монгол хэл рүү орчуулж байна...` });
  const transProvider = spec.translationProvider || 'groq';
  const transKey = settings.secret(
    transProvider === 'groq' ? 'groqApiKey' :
    transProvider === 'claude' ? 'anthropicApiKey' :
    transProvider === 'gemini' ? 'geminiApiKey' : 'openaiApiKey'
  );

  const translatePayload = chunks.map((c) => ({
    id: c.id,
    start: c.srcStart,
    end: c.srcEnd,
    text: c.text
  }));

  const translatedSegments = await translate.translateSegments(translatePayload, {
    providerId: transProvider,
    apiKey: transKey,
    model: spec.translationModel,
    language: spec.targetLanguage || 'Mongolian',
    glossary: spec.glossary || '',
    instruction: 'Narration must be spoken, engaging recap style. Strictly keep word count within character budget so spoken duration matches natural pace.',
    signal,
    onProgress: (p) => onProgress?.({ stage: 'translate', ...p })
  });

  const transMap = new Map(translatedSegments.map((s) => [s.id, s.translated || '']));
  for (const c of chunks) {
    c.mongolianText = (transMap.get(c.id) || '').trim();
    if (!c.mongolianText) {
      c.mongolianText = c.text; // Fallback to avoid empty line crash
    }
  }

  // --- STAGE 4: ElevenLabs TTS Voiceover Synthesis ---
  onProgress?.({ stage: 'tts', totalChunks: chunks.length, message: '🎙️ ElevenLabs-аар Монгол хоолойг боловсруулж байна...' });
  const ttsTexts = chunks.map((c) => c.mongolianText);
  const voiceId = spec.voiceId || 'TX3LPaxmHKxFdv7VOQHJ'; // Default natural Mongolian voice
  const modelId = spec.modelId || 'eleven_v4';

  const ttsResults = await elevenlabsPool.dispatchPoolTTS({
    chunks: ttsTexts,
    voiceId,
    modelId,
    stability: spec.stability ?? 0.5,
    similarity: spec.similarity ?? 0.75,
    speed: spec.speed ?? 1.0,
    outDir: cacheDir,
    resume: true,
    onProgress: (p) => onProgress?.({ stage: 'tts', ...p })
  });

  // Calculate voice timing on output timeline
  let timelineCursor = 0.1; // 100ms lead-in
  const speechGap = 0.15;   // 150ms natural breath pause between sentences

  for (let i = 0; i < chunks.length; i++) {
    const r = ttsResults[i];
    const duration = r.partDuration;
    chunks[i].voiceAudioFile = r.partAudioFile;
    chunks[i].voiceDuration = duration;
    chunks[i].voiceStart = Math.round(timelineCursor * 1000) / 1000;
    chunks[i].voiceEnd = Math.round((timelineCursor + duration) * 1000) / 1000;
    chunks[i].sentences = r.partSentences || [];
    timelineCursor = chunks[i].voiceEnd + speechGap;
  }

  const totalTimelineDuration = Math.round((timelineCursor + 0.2) * 1000) / 1000;

  // --- STAGE 5: Video Fit Planning ---
  onProgress?.({ stage: 'planning', message: 'Дүрс болон хоолойн зохицуулалтыг төлөвлөж байна (Fit Planner)...' });
  const plannerSegments = chunks.map((c) => ({
    id: c.id,
    srcStart: c.srcStart,
    srcEnd: c.srcEnd,
    voiceStart: c.voiceStart,
    voiceEnd: c.voiceEnd
  }));

  const fitResult = planFit(plannerSegments, {
    videoDuration,
    totalDuration: totalTimelineDuration,
    fps,
    minFreeze: 0.3
  });

  const { clips: plannedClips, stats: fitStats } = fitResult;

  // --- STAGE 6: Freeze Frame Materialization ---
  const freezeClips = plannedClips.filter((c) => c.kind === 'freeze');
  const freezeMap = new Map();

  if (freezeClips.length > 0) {
    onProgress?.({
      stage: 'freeze',
      totalFreezes: freezeClips.length,
      message: `Дүрс сунгалтын ${freezeClips.length} кадрыг өндөр нарийвчлалтайгаар бэлтгэж байна...`
    });

    const freezeTimestamps = freezeClips.map((c) => c.freezeTs);
    const materialized = await materializeFreezeFrames({
      video: { path: sourcePath, duration: videoDuration },
      timestamps: freezeTimestamps,
      outputDir: freezeDir
    }, (p) => onProgress?.({ stage: 'freeze', ...p }));

    for (const [ts, imgPath] of materialized.entries()) {
      freezeMap.set(ts, imgPath);
    }
  }

  // --- STAGE 7: Cutline Project Construction ---
  onProgress?.({ stage: 'project', message: 'Cutline засварын төслийг үүсгэж байна (.cutline)...' });
  const projectId = `proj_recap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const projectFilePath = path.join(projectDir, `${projectId}.cutline`);

  // Build Media array
  const mediaList = [];
  const sourceMediaId = 'source_video';
  mediaList.push({
    id: sourceMediaId,
    path: sourcePath,
    name: path.basename(sourcePath),
    kind: 'video',
    duration: videoDuration,
    width,
    height,
    fps,
    hasAudio: Boolean(videoInfo.hasAudio),
    thumbs: []
  });

  // Freeze image media items
  const freezeMediaMap = new Map();
  for (const [ts, imgPath] of freezeMap.entries()) {
    const fId = `freeze_${crypto.createHash('md5').update(imgPath).digest('hex').slice(0, 8)}`;
    freezeMediaMap.set(ts, fId);
    mediaList.push({
      id: fId,
      path: imgPath,
      name: `Freeze @ ${ts.toFixed(1)}s`,
      kind: 'image',
      duration: 3600,
      width,
      height,
      fps: 30,
      hasAudio: false,
      thumbs: []
    });
  }

  // Voice audio media items
  const voiceMediaMap = new Map();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const aId = `voice_${c.id}`;
    voiceMediaMap.set(c.id, aId);
    mediaList.push({
      id: aId,
      path: c.voiceAudioFile,
      name: `Монгол яриа #${i + 1}`,
      kind: 'audio',
      duration: c.voiceDuration,
      width: 0,
      height: 0,
      fps: 30,
      hasAudio: true,
      thumbs: []
    });
  }

  // Build Tracks
  const tracksList = [
    { id: 'v1', kind: 'video', name: 'Дүрс (Video)', hidden: false, muted: false, locked: false },
    { id: 'a1', kind: 'audio', name: 'Монгол хоолой (Voice)', hidden: false, muted: false, locked: false },
    { id: 'ov1', kind: 'overlay', name: 'Хадмал (Subtitles)', hidden: false, muted: false, locked: false }
  ];

  // Build Clips
  const projectClips = [];

  // V1 Clips: Motion and Freeze
  for (let i = 0; i < plannedClips.length; i++) {
    const pc = plannedClips[i];
    const clipId = `vclip_${i}_${Math.random().toString(36).slice(2, 6)}`;
    if (pc.kind === 'motion') {
      projectClips.push({
        id: clipId,
        kind: 'av',
        trackId: 'v1',
        mediaId: sourceMediaId,
        start: pc.start,
        inPoint: pc.inPoint,
        outPoint: pc.outPoint,
        volume: 0, // Mute original English video audio
        opacity: 1,
        label: `[#${pc.segmentId + 1}] Хөдөлгөөн`
      });
    } else {
      const fMediaId = freezeMediaMap.get(pc.freezeTs);
      projectClips.push({
        id: clipId,
        kind: 'av',
        trackId: 'v1',
        mediaId: fMediaId,
        start: pc.start,
        inPoint: 0,
        outPoint: pc.duration,
        volume: 0,
        opacity: 1,
        isFreeze: true,
        freezeTs: pc.freezeTs,
        label: `[#${pc.segmentId + 1}] Кадр барих`
      });
    }
  }

  // A1 Clips: Mongolian Narration
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    projectClips.push({
      id: `aclip_${i}_${Math.random().toString(36).slice(2, 6)}`,
      kind: 'av',
      trackId: 'a1',
      mediaId: voiceMediaMap.get(c.id),
      start: c.voiceStart,
      inPoint: 0,
      outPoint: c.voiceDuration,
      volume: 1,
      opacity: 1,
      label: c.mongolianText.slice(0, 40)
    });
  }

  // OV1 Clips: Subtitles
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    projectClips.push({
      id: `sclip_${i}_${Math.random().toString(36).slice(2, 6)}`,
      kind: 'text',
      trackId: 'ov1',
      start: c.voiceStart,
      inPoint: 0,
      outPoint: c.voiceDuration,
      x: 0.5,
      y: 0.83,
      opacity: 1,
      style: {
        text: c.mongolianText,
        color: '#FFFFFF',
        background: '',
        fontSize: Math.round(height * 0.034), // Proportional font size (~36px on 1080p)
        bold: true,
        shadow: true
      }
    });
  }

  const projectDoc = {
    format: 'cutline-project',
    version: 1,
    name: `${baseName} · Монгол Recap`,
    settings: { width, height, fps },
    media: mediaList,
    tracks: tracksList,
    clips: projectClips
  };

  const validatedDoc = validateProject(projectDoc);
  atomicWrite(projectFilePath, validatedDoc);
  await ensureProjectCover(projectId, validatedDoc, projectDir);

  // Generate SRT file alongside project
  const srtPath = path.join(path.dirname(outPath), `${baseName}_mongol.srt`);
  const srtContent = chunks.map((c, idx) => {
    return `${idx + 1}\n${toSrtTimestamp(c.voiceStart)} --> ${toSrtTimestamp(c.voiceEnd)}\n${c.mongolianText}\n`;
  }).join('\n');
  fs.writeFileSync(srtPath, srtContent, 'utf8');

  // --- STAGE 8: Final MP4 Export ---
  let exportedVideoPath = null;
  if (spec.exportMp4 !== false) {
    onProgress?.({ stage: 'export', pct: 0, message: '🚀 Эцсийн Монгол видеог экспортлож байна (Hardware GPU)...' });

    // Prepare specs for ffmpeg exportTimeline
    const exportClips = plannedClips.map((pc) => {
      if (pc.kind === 'motion') {
        return {
          src: sourcePath,
          inPoint: pc.inPoint,
          outPoint: pc.outPoint,
          start: pc.start,
          kind: 'video',
          hasAudio: false,
          volume: 0,
          opacity: 1
        };
      } else {
        const imgPath = freezeMap.get(pc.freezeTs);
        return {
          src: imgPath,
          inPoint: 0,
          outPoint: pc.duration,
          start: pc.start,
          kind: 'image',
          hasAudio: false,
          volume: 0,
          opacity: 1
        };
      }
    });

    const exportAudio = chunks.map((c) => ({
      src: c.voiceAudioFile,
      inPoint: 0,
      outPoint: c.voiceDuration,
      start: c.voiceStart,
      volume: 1
    }));

    // Perform timeline export
    exportedVideoPath = await ff.exportTimeline({
      clips: exportClips,
      audio: exportAudio,
      overlays: [], // Plain clean video; user can toggle subtitles or burn in
      width,
      height,
      fps,
      duration: totalTimelineDuration,
      codec: spec.codec || 'hevc',
      outPath
    }, (p) => {
      onProgress?.({ stage: 'export', ...p });
    });
  }

  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  onProgress?.({
    stage: 'complete',
    message: '🎉 Монгол recap амжилттай бэлэн боллоо!',
    elapsedSeconds
  });

  return {
    ok: true,
    projectId,
    projectPath: projectFilePath,
    videoPath: exportedVideoPath || outPath,
    srtPath,
    duration: totalTimelineDuration,
    stats: fitStats,
    chunkCount: chunks.length,
    elapsedSeconds
  };
}

module.exports = {
  runRecapDubPipeline,
  chunkTranscript,
  toSrtTimestamp
};
