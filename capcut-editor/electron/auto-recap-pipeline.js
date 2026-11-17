'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

let corePromise = null;
function loadAlignCore() {
  if (!corePromise) corePromise = import('./script-align-core.mjs');
  return corePromise;
}

const DEFAULT_VOICE_ID = 'TX3LPaxmHKxFdv7VOQHJ';
const DEFAULT_ELEVEN_MODEL = 'eleven_v4';
const DEFAULT_WHISPER_MODEL = 'groq-whisper-large-v3';
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

const STEP_ORDER = ['voice', 'whisper', 'fix', 'autocut', 'export'];

function getUserDataDir(app) {
  try {
    if (app?.getPath) return app.getPath('userData');
    const electron = require('electron');
    if (electron.app?.getPath) return electron.app.getPath('userData');
  } catch {}
  return path.join(os.tmpdir(), 'cutline-auto-pipeline');
}

function getDefaultExportDir(app) {
  try {
    if (app?.getPath) return path.join(app.getPath('videos'), 'Cutline Exports');
    const electron = require('electron');
    if (electron.app?.getPath) return path.join(electron.app.getPath('videos'), 'Cutline Exports');
  } catch {}
  return path.join(os.homedir(), 'Videos', 'Cutline Exports');
}

function getJobsRootDir(app) {
  return path.join(getUserDataDir(app), 'auto-pipeline-jobs');
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } finally {
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {}
  return null;
}

function makeAbortError(message = 'Хэрэглэгч зогсоолоо.') {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

function checkAborted(signal) {
  if (signal?.aborted) throw makeAbortError();
}

function detectSrtSliceFromVideoName(videoPath) {
  if (!videoPath) return '';
  const m = path.basename(videoPath).match(/\[(\d{1,2})-(\d{2})-(\d{2})_/);
  if (!m) return '';
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}`;
}

function redactSecrets(text, secrets = []) {
  let out = String(text || '');
  for (const s of secrets) {
    if (s && typeof s === 'string' && s.length > 6) {
      out = out.split(s).join('[redacted]');
    }
  }
  return out;
}

function makeUniqueFilePath(dir, baseName, ext) {
  const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
  const safeBase = String(baseName || 'auto_recap')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || 'auto_recap';
  fs.mkdirSync(dir, { recursive: true });
  let candidate = path.join(dir, `${safeBase}${cleanExt}`);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${safeBase}_${n}${cleanExt}`);
    n++;
  }
  return candidate;
}

function evenDim(n, fallback) {
  const v = Math.round(Number(n) || fallback);
  const clamped = Math.max(16, Math.min(7680, v));
  return clamped % 2 === 0 ? clamped : Math.max(16, clamped - 1);
}

function resolveExportDimensions(spec = {}, videoProbe = {}) {
  if (Number.isInteger(spec.width) && Number.isInteger(spec.height) && spec.width >= 16 && spec.height >= 16) {
    return { width: evenDim(spec.width, 1920), height: evenDim(spec.height, 1080) };
  }
  const resMap = { '480P': 480, '720P': 720, '1080P': 1080, '2K': 1440, '4K': 2160 };
  const targetShort = resMap[String(spec.resolution || '1080P').toUpperCase()] || 1080;

  let srcW = Number(videoProbe.width) > 0 ? Number(videoProbe.width) : 1920;
  let srcH = Number(videoProbe.height) > 0 ? Number(videoProbe.height) : 1080;
  const aspectMode = String(spec.aspect || 'auto');
  if (aspectMode === '16:9') {
    srcW = 16;
    srcH = 9;
  } else if (aspectMode === '9:16') {
    srcW = 9;
    srcH = 16;
  }

  const ratio = srcW / srcH;
  if (ratio >= 1) {
    const height = evenDim(targetShort, 1080);
    const width = evenDim(height * ratio, 1920);
    return { width, height };
  }
  const width = evenDim(targetShort, 1080);
  const height = evenDim(width / ratio, 1920);
  return { width, height };
}

/**
 * Guarantee caption clips are strictly monotonic, non-overlapping, non-empty,
 * and inside [0, voiceDuration] so recap-auto-cut.resolveInputs always succeeds.
 */
function sanitizePipelineCaptions(clips, voiceDuration) {
  const totalDur = Math.max(0.1, Number(voiceDuration) || 0);
  const nonEmpty = (Array.isArray(clips) ? clips : [])
    .filter((c) => c && typeof (c.style?.text ?? c.text) === 'string' && String(c.style?.text ?? c.text).trim().length > 0)
    .map((c, idx) => {
      const start = Math.max(0, Number(c.start) || 0);
      const inPt = Math.max(0, Number(c.inPoint) || 0);
      const rawDur = Math.max(0.05, (Number(c.outPoint) || inPt + 0.5) - inPt);
      const text = String(c.style?.text ?? c.text).trim();
      return {
        ...c,
        id: typeof c.id === 'string' && c.id ? c.id : `cap_${idx + 1}`,
        kind: 'text',
        trackId: c.trackId || 'o1',
        start,
        inPoint: 0,
        outPoint: rawDur,
        style: { ...(c.style || {}), text }
      };
    })
    .sort((a, b) => a.start - b.start);

  if (!nonEmpty.length) {
    throw new Error('Зассан хадмал хоосон байна. Скрипт болон яриа таних үр дүнг шалгана уу.');
  }

  const sanitized = [];
  for (let i = 0; i < nonEmpty.length; i++) {
    const cur = nonEmpty[i];
    let start = cur.start;
    let dur = Math.max(0.05, cur.outPoint - cur.inPoint);

    if (sanitized.length > 0) {
      const prev = sanitized[sanitized.length - 1];
      const prevEnd = prev.start + (prev.outPoint - prev.inPoint);
      const minStart = Math.max(prevEnd, prev.start + 0.01);
      if (start < minStart) {
        start = minStart;
      }
    }

    if (start >= totalDur - 0.04) {
      // Compress slightly backward within previous gap or merge into previous caption
      if (sanitized.length > 0) {
        const prev = sanitized[sanitized.length - 1];
        prev.style.text = `${prev.style.text} ${cur.style.text}`.trim();
        prev.outPoint = Math.min(totalDur - prev.start, Math.max(prev.outPoint, totalDur - prev.start));
      }
      continue;
    }

    const nextOrig = nonEmpty[i + 1];
    const hardCap = nextOrig ? Math.min(totalDur, Math.max(start + 0.05, nextOrig.start)) : totalDur;
    let end = Math.min(totalDur, start + dur, hardCap);
    if (end - start < 0.05) {
      end = Math.min(totalDur, start + 0.05);
    }
    if (end <= start) continue;

    sanitized.push({
      ...cur,
      start: Math.round(start * 1000) / 1000,
      inPoint: 0,
      outPoint: Math.round((end - start) * 1000) / 1000
    });
  }

  if (!sanitized.length) {
    throw new Error('Хадмалын хугацаа voice-ийн урттай таарахгүй байна.');
  }

  return sanitized;
}

function buildDraftTimelineProject({
  videoPath,
  videoProbe,
  voiceAudioPath,
  voiceDuration,
  captionClips,
  projectName
}) {
  const videoMediaId = 'media_source_video';
  const voiceMediaId = 'media_voice_master';
  const vDur = Math.max(0.1, Number(videoProbe.duration) || 0.1);
  const vW = Number(videoProbe.width) > 0 ? Number(videoProbe.width) : 1920;
  const vH = Number(videoProbe.height) > 0 ? Number(videoProbe.height) : 1080;
  const vFps = Number(videoProbe.fps) > 0 ? Number(videoProbe.fps) : 30;

  const videoMediaItem = {
    id: videoMediaId,
    path: videoPath,
    name: path.basename(videoPath),
    kind: 'video',
    duration: vDur,
    width: vW,
    height: vH,
    fps: vFps,
    hasAudio: Boolean(videoProbe.hasAudio),
    thumbs: []
  };

  const voiceMediaItem = {
    id: voiceMediaId,
    path: voiceAudioPath,
    name: path.basename(voiceAudioPath),
    kind: 'audio',
    duration: voiceDuration,
    width: 0,
    height: 0,
    fps: 0,
    hasAudio: true,
    thumbs: []
  };

  const voiceClip = {
    id: 'clip_voice_master',
    kind: 'av',
    mediaId: voiceMediaId,
    trackId: 'a1',
    start: 0,
    inPoint: 0,
    outPoint: voiceDuration,
    volume: 1,
    label: 'Монгол Voice'
  };

  const baseVideoClip = {
    id: 'clip_source_placeholder',
    kind: 'av',
    mediaId: videoMediaId,
    trackId: 'v1',
    start: 0,
    inPoint: 0,
    outPoint: Math.min(vDur, voiceDuration),
    volume: 0,
    opacity: 1
  };

  const projectData = {
    format: 'cutline-project',
    version: 1,
    name: projectName || path.basename(videoPath, path.extname(videoPath)),
    media: [videoMediaItem, voiceMediaItem],
    tracks: [
      { id: 'v1', name: 'Video 1', kind: 'video', hidden: false, muted: false, locked: false },
      { id: 'a1', name: 'Audio 1', kind: 'audio', hidden: false, muted: false, locked: false },
      { id: 'o1', name: 'Overlay', kind: 'overlay', hidden: false, muted: false, locked: false }
    ],
    clips: [baseVideoClip, voiceClip],
    settings: { width: evenDim(vW, 1920), height: evenDim(vH, 1080), fps: vFps }
  };

  return {
    projectData,
    captions: captionClips,
    videoMediaId,
    videoMediaItem,
    voiceMediaItem,
    voiceClip
  };
}

/**
 * Strip all subtitle clips so final project and export are clean without captions.
 */
function sanitizeClipForValidation(c) {
  const clean = {
    id: c.id,
    kind: c.kind,
    trackId: c.trackId,
    start: c.start,
    inPoint: c.inPoint,
    outPoint: c.outPoint
  };
  for (const key of ['mediaId', 'sticker', 'filterId', 'effectId', 'transitionId', 'fitMode', 'label', 'englishText', 'mongolianText', 'aiReason']) {
    if (typeof c[key] === 'string') clean[key] = c[key];
  }
  for (const key of ['x', 'y', 'scale', 'rotation', 'volume', 'opacity', 'transitionDuration', 'matchedSrtId', 'sourceStart', 'sourceEnd', 'freezeTs', 'aiConfidence']) {
    if (typeof c[key] === 'number' && Number.isFinite(c[key])) clean[key] = c[key];
  }
  for (const key of ['isFreeze', 'aiVerified']) {
    if (c[key] !== undefined) clean[key] = Boolean(c[key]);
  }
  return clean;
}

function buildCleanProjectAndExportSpec({
  cleanVideoClips,
  newMedia = [],
  videoMediaItem,
  voiceMediaItem,
  voiceClip,
  projectName,
  outPath,
  exportOptions = {},
  width,
  height,
  fps,
  voiceDuration
}) {
  const safeVideoClips = cleanVideoClips
    .filter((c) => c && c.kind === 'av')
    .map(sanitizeClipForValidation);

  const safeNewMedia = (Array.isArray(newMedia) ? newMedia : []).map((m) => ({
    id: m.id,
    path: m.path,
    name: m.name,
    kind: m.kind,
    duration: Number(m.duration) || 86400,
    width: evenDim(m.width || width, width),
    height: evenDim(m.height || height, height),
    fps: Number(m.fps) || fps,
    hasAudio: Boolean(m.hasAudio),
    thumbs: Array.isArray(m.thumbs) ? m.thumbs : []
  }));

  const cleanProject = {
    format: 'cutline-project',
    version: 1,
    name: String(projectName || 'Auto Recap').slice(0, 200),
    media: [videoMediaItem, voiceMediaItem, ...safeNewMedia],
    tracks: [
      { id: 'v1', name: 'Video 1', kind: 'video', hidden: false, muted: false, locked: false },
      { id: 'a1', name: 'Audio 1', kind: 'audio', hidden: false, muted: false, locked: false },
      { id: 'o1', name: 'Overlay', kind: 'overlay', hidden: false, muted: false, locked: false }
    ],
    clips: [...safeVideoClips, sanitizeClipForValidation(voiceClip)],
    settings: {
      width: evenDim(width, 1920),
      height: evenDim(height, 1080),
      fps: Math.max(1, Math.min(120, Number(fps) || 30))
    }
  };

  if (cleanProject.clips.some((c) => c.kind === 'text')) {
    throw new Error('Дотоод алдаа: цэвэр төсөлд түр хадмал үлдсэн байна.');
  }

  const mediaById = new Map(cleanProject.media.map((m) => [m.id, m]));
  const exportClips = safeVideoClips
    .sort((a, b) => a.start - b.start)
    .map((c) => {
      const m = mediaById.get(c.mediaId);
      if (!m) throw new Error(`Экспортод медиа олдсонгүй (${c.mediaId}).`);
      return {
        src: m.path,
        trackId: c.trackId,
        layer: 0,
        kind: m.kind === 'image' ? 'image' : 'video',
        opacity: c.opacity ?? 1,
        start: c.start,
        inPoint: c.inPoint,
        outPoint: c.outPoint,
        hasAudio: false,
        volume: 0,
        filterFf: 'none',
        effectFf: 'none',
        transition: 'none',
        transitionDuration: 0.6,
        scale: c.scale ?? 1,
        fitMode: c.fitMode || 'contain',
        x: c.x ?? 0.5,
        y: c.y ?? 0.5,
        rotation: c.rotation ?? 0,
        keyframes: []
      };
    });

  const exportAudio = [{
    src: voiceMediaItem.path,
    inPoint: voiceClip.inPoint,
    outPoint: voiceClip.outPoint,
    start: voiceClip.start,
    volume: voiceClip.volume ?? 1
  }];

  const format = ['mp4', 'mov'].includes(exportOptions.format) ? exportOptions.format : 'mp4';
  const codec = ['h264', 'hevc', 'av1'].includes(exportOptions.codec) ? exportOptions.codec : 'hevc';
  const bitrateOption = ['lower', 'recommended', 'higher', 'custom'].includes(exportOptions.bitrateOption)
    ? exportOptions.bitrateOption
    : undefined;
  const bitrateType = exportOptions.bitrateType === 'cbr' ? 'cbr' : 'vbr';
  const bitrateMode = exportOptions.bitrateMode || (bitrateOption === 'custom' ? bitrateType : bitrateOption) || 'recommended';
  const customBitrate = (bitrateOption === 'custom' || (Number(exportOptions.customBitrate) > 0 && !bitrateOption))
    ? Math.max(200, Math.min(100000, Number(exportOptions.customBitrate) || 1000))
    : undefined;
  const quality = ['draft', 'standard', 'high'].includes(exportOptions.quality)
    ? exportOptions.quality
    : (bitrateOption === 'higher' ? 'high' : bitrateOption === 'lower' ? 'draft' : 'standard');
  const audioBitrate = ['128k', '192k', '320k'].includes(exportOptions.audioBitrate) ? exportOptions.audioBitrate : '192k';

  const exportSpec = {
    clips: exportClips,
    audio: exportAudio,
    overlays: [],
    width: cleanProject.settings.width,
    height: cleanProject.settings.height,
    fps: cleanProject.settings.fps,
    duration: voiceDuration,
    format,
    codec,
    quality,
    audioBitrate,
    bitrateMode,
    customBitrate,
    bitrateType,
    outPath
  };

  return { cleanProject, exportSpec };
}

function getDefaultDeps(app) {
  return {
    ff: require('./ffmpeg'),
    settings: require('./settings'),
    srtParser: require('./srt-parser'),
    scriptStudio: require('./script-studio'),
    whisper: require('./whisper'),
    audioScriptAlign: require('./audio-script-align'),
    recapAutoCut: require('./recap-auto-cut'),
    projectStore: require('./project-store'),
    app
  };
}

/**
 * Validate inputs, keys, Whisper model, and output folders before spending paid credits.
 */
async function preflightAutoPipeline(spec = {}, depsOverride = {}) {
  const d = { ...getDefaultDeps(depsOverride.app), ...depsOverride };
  const checks = [];
  const warnings = [];
  const core = await loadAlignCore();

  try {
    const rawScript = String(spec.scriptText || '').trim();
    if (!rawScript) {
      checks.push({ id: 'script', label: 'Монгол скрипт', ok: false, detail: 'Скрипт текст хоосон байна.' });
      throw new Error('Монгол скрипт текстээ оруулна уу.');
    }
    const { text: cleanScript } = core.clearTagsFromScript(rawScript);
    const tagCount = core.countTagsInScript(rawScript);
    checks.push({
      id: 'script',
      label: 'Монгол скрипт',
      ok: true,
      detail: `${rawScript.length.toLocaleString()} тэмдэгт (${tagCount} audio tag, цэвэр текст ${cleanScript.length.toLocaleString()})`
    });

    if (!spec.videoPath || !fs.existsSync(spec.videoPath)) {
      checks.push({ id: 'video', label: 'Эх видео', ok: false, detail: 'Видео файл сонгоогүй эсвэл олдсонгүй.' });
      throw new Error('Эх видео файл олдсонгүй.');
    }
    const videoProbe = await d.ff.probe(spec.videoPath);
    if (!videoProbe.hasVideo || !(videoProbe.duration > 0)) {
      checks.push({ id: 'video', label: 'Эх видео', ok: false, detail: 'Хүчинтэй дүрсний зам (video stream) алга.' });
      throw new Error('Эх видео файл буруу эсвэл дүрсгүй байна.');
    }
    checks.push({
      id: 'video',
      label: 'Эх видео',
      ok: true,
      detail: `${path.basename(spec.videoPath)} (${videoProbe.width}×${videoProbe.height}, ${Math.round(videoProbe.duration)} сек)`
    });

    if (!spec.srtPath || !fs.existsSync(spec.srtPath)) {
      checks.push({ id: 'srt', label: 'Англи SRT', ok: false, detail: 'SRT файл сонгоогүй эсвэл олдсонгүй.' });
      throw new Error('Англи SRT хадмал файл олдсонгүй.');
    }
    const rawSrt = d.srtParser.parseSrtFile(spec.srtPath);
    if (!rawSrt.length) {
      checks.push({ id: 'srt', label: 'Англи SRT', ok: false, detail: 'SRT файл хоосон байна.' });
      throw new Error('Англи SRT файл хоосон эсвэл буруу форматтай байна.');
    }
    const autoDetectedSrtStart = detectSrtSliceFromVideoName(spec.videoPath);
    const effectiveSrtStart = String(spec.srtStartTime || '').trim() || autoDetectedSrtStart;
    let slicedCount = rawSrt.length;
    if (effectiveSrtStart) {
      const sliced = d.srtParser.sliceAndShiftSrt(rawSrt, effectiveSrtStart, spec.srtEndTime || null);
      slicedCount = sliced.entries.length;
      if (!slicedCount) {
        checks.push({ id: 'srt', label: 'Англи SRT', ok: false, detail: `${effectiveSrtStart}-аас хойш SRT мөр олдсонгүй.` });
        throw new Error(`SRT огтлолтын цагаас (${effectiveSrtStart}) хойш мөр олдсонгүй.`);
      }
    }
    checks.push({
      id: 'srt',
      label: 'Англи SRT',
      ok: true,
      detail: effectiveSrtStart
        ? `${slicedCount}/${rawSrt.length} мөр (${effectiveSrtStart}-аас эхэлнэ)`
        : `${rawSrt.length} мөр`
    });

    // ElevenLabs pool/key check (exclude disabled/blocked/error and deduplicate same userId account)
    const poolKeys = d.settings.getKeyPoolDecrypted ? d.settings.getKeyPoolDecrypted() : [];
    const activePoolKeys = poolKeys.filter((k) => k.enabled !== false && k.status !== 'blocked' && k.status !== 'error' && (k.quota?.remaining ?? 10000) > 0);
    const seenPoolUsers = new Set();
    let poolRemaining = 0;
    for (const k of activePoolKeys) {
      const rem = k.quota?.remaining ?? 10000;
      const uid = k.quota?.userId;
      if (uid) {
        if (seenPoolUsers.has(uid)) continue;
        seenPoolUsers.add(uid);
      }
      poolRemaining += rem;
    }
    const singleElevenKey = spec.elevenLabsApiKey || d.settings.secret?.('elevenLabsApiKey') || process.env.ELEVENLABS_API_KEY || '';
    if (!poolKeys.length && !singleElevenKey) {
      checks.push({ id: 'elevenlabs', label: 'ElevenLabs API', ok: false, detail: 'Түлхүүрийн санд идэвхтэй түлхүүр алга.' });
      throw new Error('ElevenLabs API түлхүүр бүртгэгдээгүй байна.');
    }
    if (poolKeys.length > 0 && poolRemaining < rawScript.length) {
      warnings.push(`ElevenLabs үлдэгдэл (${poolRemaining.toLocaleString()}) нь скриптийн уртаас (${rawScript.length.toLocaleString()}) бага байж магадгүй.`);
    }
    checks.push({
      id: 'elevenlabs',
      label: 'ElevenLabs API',
      ok: true,
      detail: poolKeys.length > 0
        ? `${activePoolKeys.length} түлхүүр идэвхтэй (~${poolRemaining.toLocaleString()} кредит)`
        : 'Нэгдсэн түлхүүр бэлэн'
    });

    // Whisper model check
    const whisperModel = spec.whisperModel || DEFAULT_WHISPER_MODEL;
    const wStatus = d.whisper.status ? d.whisper.status() : { available: false, models: [] };
    const matchedWhisper = wStatus.models?.find((m) => m.id === whisperModel && m.installed);
    if (!matchedWhisper) {
      checks.push({
        id: 'whisper',
        label: 'Whisper загвар',
        ok: false,
        detail: `${whisperModel} бэлэн биш (Groq Cloud түлхүүр эсвэл offline загвараа шалгана уу).`
      });
      throw new Error(`Сонгосон яриа таних загвар (${whisperModel}) бэлэн биш байна. API түлхүүрээ шалгана уу.`);
    }
    checks.push({ id: 'whisper', label: 'Whisper загвар', ok: true, detail: matchedWhisper.label || whisperModel });

    // Gemini API key check
    const geminiKey = spec.geminiApiKey || d.settings.secret?.('geminiApiKey') || process.env.GEMINI_API_KEY || '';
    if (!geminiKey) {
      checks.push({ id: 'gemini', label: 'Gemini API', ok: false, detail: 'SRT Auto-Sync хийхэд Gemini API түлхүүр шаардлагатай.' });
      throw new Error('Gemini API түлхүүр бүртгэгдээгүй байна. API түлхүүр хэсгээс оруулна уу.');
    }
    checks.push({ id: 'gemini', label: 'Gemini API', ok: true, detail: 'Түлхүүр бэлэн' });

    // Export directory & dimensions
    const targetExportDir = spec.exportDir ? path.resolve(spec.exportDir) : getDefaultExportDir(d.app);
    fs.mkdirSync(targetExportDir, { recursive: true });
    const dims = resolveExportDimensions(spec.exportOptions || spec, videoProbe);
    checks.push({
      id: 'export',
      label: 'Экспорт байршил',
      ok: true,
      detail: `${dims.width}×${dims.height}, ${targetExportDir}`
    });

    return {
      ok: true,
      checks,
      warnings,
      estimate: {
        scriptChars: rawScript.length,
        cleanScriptChars: cleanScript.length,
        audioTagCount: tagCount,
        srtEntries: rawSrt.length,
        slicedSrtEntries: slicedCount,
        autoDetectedSrtStart,
        poolTotalRemaining: poolRemaining,
        targetWidth: dims.width,
        targetHeight: dims.height,
        videoDuration: videoProbe.duration
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      checks,
      warnings
    };
  }
}

/**
 * Execute or resume the 5-stage fully automated workflow.
 */
async function executePipelineInternal({ jobId, jobDir, manifest, spec, options = {} }) {
  const { onProgress, signal, app, deps = {} } = options;
  const d = { ...getDefaultDeps(app), ...deps };
  const core = await loadAlignCore();

  const secretsToRedact = [
    spec.geminiApiKey,
    spec.elevenLabsApiKey,
    d.settings.secret?.('geminiApiKey'),
    d.settings.secret?.('elevenLabsApiKey'),
    d.settings.secret?.('groqApiKey'),
    ...(d.settings.getKeyPoolDecrypted?.() || []).map((k) => k.apiKey)
  ].filter(Boolean);

  const manifestFile = path.join(jobDir, 'manifest.json');
  const saveManifest = () => {
    manifest.updatedAt = Date.now();
    atomicWriteJson(manifestFile, manifest);
  };

  const emit = (payload) => {
    const safeMsg = redactSecrets(payload.message || '', secretsToRedact);
    onProgress?.({
      jobId,
      ...payload,
      message: safeMsg
    });
  };

  const stageDone = (key) => manifest.completedStages?.includes(key);

  try {
    checkAborted(signal);

    // Stage 0: Validation (fast re-check / probe)
    const pf = await preflightAutoPipeline(spec, d);
    if (!pf.ok) {
      throw new Error(pf.error || 'Урьдчилсан шалгалт амжилтгүй.');
    }
    const videoProbe = await d.ff.probe(spec.videoPath);
    const projectBaseName = (spec.outputName && String(spec.outputName).trim())
      ? String(spec.outputName).trim()
      : `${path.basename(spec.videoPath, path.extname(spec.videoPath))}_auto`;

    // ---------------- STAGE 1: ElevenLabs Voice ----------------
    if (!stageDone('voice')) {
      checkAborted(signal);
      emit({
        stepIndex: 1,
        stepKey: 'voice',
        pct: 5,
        overallPct: 2,
        message: '🎙️ 1/5: ElevenLabs дээр Монгол дуу хоолой үүсгэж эхэллээ...'
      });

      let scriptForTts = String(spec.scriptText || '').trim();
      if (spec.autoTagScript) {
        const tagged = core.autoTagMongolianScript(scriptForTts, {
          intensity: spec.tagIntensity === 'dramatic' ? 'dramatic' : 'balanced',
          clearExisting: false
        });
        scriptForTts = tagged.text;
      }

      const voiceWorkDir = path.join(jobDir, 'voice-parts');
      const ttsRes = await d.scriptStudio.buildScriptRecap({
        scriptText: scriptForTts,
        voiceId: spec.voiceId || DEFAULT_VOICE_ID,
        modelId: spec.elevenModelId || DEFAULT_ELEVEN_MODEL,
        stability: spec.stability ?? 0.5,
        similarity: spec.similarity ?? 0.75,
        speed: spec.speed ?? 1.0,
        chunkSize: spec.chunkSize || 9000,
        audioOnly: true,
        outDir: voiceWorkDir,
        elevenLabsApiKey: spec.elevenLabsApiKey,
        signal
      }, (p) => {
        const partPct = (p.partIndex && p.totalParts)
          ? Math.round((p.partIndex / p.totalParts) * 100)
          : 40;
        emit({
          stepIndex: 1,
          stepKey: 'voice',
          pct: partPct,
          overallPct: Math.round(partPct * 0.25),
          message: p.message || '🎙️ ElevenLabs дуу уншиж байна...'
        });
      });

      if (!ttsRes?.ok || !ttsRes.audioPath || !fs.existsSync(ttsRes.audioPath)) {
        throw new Error(ttsRes?.error || 'ElevenLabs дуу хоолой үүсгэж чадсангүй.');
      }

      const voiceProbe = await d.ff.probe(ttsRes.audioPath);
      manifest.artifacts.voiceAudioPath = ttsRes.audioPath;
      manifest.artifacts.voiceDuration = voiceProbe.duration || ttsRes.voiceDuration;
      manifest.completedStages.push('voice');
      saveManifest();
    }

    emit({
      stepIndex: 1,
      stepKey: 'voice',
      pct: 100,
      overallPct: 25,
      voiceDuration: manifest.artifacts.voiceDuration,
      message: `✅ 1/5: Дуу хоолой бэлэн (${Math.round(manifest.artifacts.voiceDuration)} сек)`
    });

    // ---------------- STAGE 2: Voice -> Subtitle (Groq Cloud Large v3 + 2 lines) ----------------
    if (!stageDone('whisper')) {
      checkAborted(signal);
      const whisperModel = spec.whisperModel || DEFAULT_WHISPER_MODEL;
      emit({
        stepIndex: 2,
        stepKey: 'whisper',
        pct: 10,
        overallPct: 28,
        message: `⚡ 2/5: Үүссэн дуунаас ${whisperModel} загвараар хадмал үүсгэж байна...`
      });

      const alignRes = await d.audioScriptAlign.alignAudioWithScript({
        audioPath: manifest.artifacts.voiceAudioPath,
        scriptText: '',
        useWhisper: true,
        whisperModel,
        forceFresh: Boolean(spec.forceFreshWhisper),
        signal
      }, (p) => {
        const wPct = typeof p.pct === 'number' ? p.pct : 50;
        emit({
          stepIndex: 2,
          stepKey: 'whisper',
          pct: wPct,
          overallPct: 25 + Math.round(wPct * 0.20),
          message: p.message || '⚡ Хадмал таньж байна...'
        });
      });

      if (!alignRes?.ok || !Array.isArray(alignRes.segments) || !alignRes.segments.length) {
        throw new Error(alignRes?.error || 'Аудионоос яриа танигдаж хадмал үүссэнгүй.');
      }

      const useCompact = spec.compactCaptions !== false;
      const rawSegs = useCompact
        ? core.layoutCaptions(alignRes.segments)
        : alignRes.segments.map((s) => ({ ...s, duration: Math.max(0.1, (s.duration ?? (s.end - s.start))) }));

      const draftCaptions = rawSegs.map((seg, idx) => ({
        id: `auto_cap_${idx + 1}`,
        kind: 'text',
        trackId: 'o1',
        start: Math.max(0, Number(seg.start) || 0),
        inPoint: 0,
        outPoint: Math.max(0.05, Number(seg.duration) || ((Number(seg.end) || 0) - (Number(seg.start) || 0)) || 0.5),
        style: {
          text: String(seg.text || '').trim(),
          color: '#FFFFFF',
          background: '',
          fontSize: 36,
          bold: false,
          shadow: true
        }
      }));

      manifest.artifacts.draftCaptions = draftCaptions;
      manifest.artifacts.whisperMethod = alignRes.method || whisperModel;
      manifest.completedStages.push('whisper');
      saveManifest();
    }

    emit({
      stepIndex: 2,
      stepKey: 'whisper',
      pct: 100,
      overallPct: 45,
      message: `✅ 2/5: ${manifest.artifacts.draftCaptions.length} түр хадмал үүслээ`
    });

    // ---------------- STAGE 3: Script -> Fix Subtitles ----------------
    if (!stageDone('fix')) {
      checkAborted(signal);
      emit({
        stepIndex: 3,
        stepKey: 'fix',
        pct: 20,
        overallPct: 47,
        message: '📝 3/5: ElevenLabs скриптээр хадмалын үг үсгийг цэвэрлэн засаж байна...'
      });

      const { text: cleanScript } = core.clearTagsFromScript(spec.scriptText);
      const aligned = core.alignScriptToClips(cleanScript, manifest.artifacts.draftCaptions, { mode: 'full' });
      const reflowed = core.reflowSentenceBoundaries(aligned.updatedClips);
      const fixedCaptions = sanitizePipelineCaptions(
        reflowed.updatedClips,
        manifest.artifacts.voiceDuration
      );

      manifest.artifacts.fixedCaptions = fixedCaptions;
      manifest.artifacts.fixReport = {
        beforeCount: manifest.artifacts.draftCaptions.length,
        afterCount: fixedCaptions.length,
        reflowedCount: reflowed.fixedCount,
        message: aligned.message
      };
      manifest.completedStages.push('fix');
      saveManifest();
    }

    emit({
      stepIndex: 3,
      stepKey: 'fix',
      pct: 100,
      overallPct: 52,
      message: `✅ 3/5: ${manifest.artifacts.fixedCaptions.length} хадмал скриптээр засагдлаа`
    });

    // ---------------- STAGE 4: SRT Auto-Sync & Video Cut ----------------
    const {
      projectData,
      captions,
      videoMediaId,
      videoMediaItem,
      voiceMediaItem,
      voiceClip
    } = buildDraftTimelineProject({
      videoPath: spec.videoPath,
      videoProbe,
      voiceAudioPath: manifest.artifacts.voiceAudioPath,
      voiceDuration: manifest.artifacts.voiceDuration,
      captionClips: manifest.artifacts.fixedCaptions,
      projectName: projectBaseName
    });

    if (!stageDone('autocut')) {
      checkAborted(signal);
      emit({
        stepIndex: 4,
        stepKey: 'autocut',
        pct: 10,
        overallPct: 55,
        message: '🎬 4/5: Англи SRT-тэй тулгаж эх видеог автоматаар эвлүүлж байна...'
      });

      const saveToLib = spec.saveProjectToLibrary !== false;
      const freezeDir = saveToLib
        ? path.join(getUserDataDir(app), 'recap-freeze')
        : path.join(jobDir, 'recap-freeze');
      const cpDir = path.join(jobDir, 'recap-checkpoints');
      const geminiKey = spec.geminiApiKey || d.settings.secret?.('geminiApiKey') || process.env.GEMINI_API_KEY || '';

      const cutRes = await d.recapAutoCut.autoCutByEnglishSrt({
        srtPath: spec.srtPath,
        srtStartTime: spec.srtStartTime || detectSrtSliceFromVideoName(spec.videoPath) || undefined,
        srtEndTime: spec.srtEndTime || undefined,
        captions,
        projectData,
        videoMediaId,
        geminiApiKey: geminiKey,
        model: spec.geminiModel || DEFAULT_GEMINI_MODEL,
        checkpointDir: cpDir,
        outputDir: freezeDir
      }, (p) => {
        emit({
          stepIndex: 4,
          stepKey: 'autocut',
          pct: 55,
          overallPct: 64,
          message: p.message || '🎬 Эх дүрс тааруулж байна...'
        });
      });

      if (!cutRes?.ok || !Array.isArray(cutRes.videoClips) || !cutRes.videoClips.length) {
        throw new Error(cutRes?.error || 'SRT Auto-Cut амжилтгүй боллоо.');
      }

      manifest.artifacts.cutResult = {
        videoClips: cutRes.videoClips,
        newMedia: cutRes.newMedia || [],
        motionCount: cutRes.motionCount,
        freezeCount: cutRes.freezeCount,
        englishScenesCount: cutRes.englishScenesCount,
        report: cutRes.report
      };
      manifest.completedStages.push('autocut');
      saveManifest();
    }

    emit({
      stepIndex: 4,
      stepKey: 'autocut',
      pct: 100,
      overallPct: 75,
      message: `✅ 4/5: ${manifest.artifacts.cutResult.videoClips.length} клип угсрагдлаа (${manifest.artifacts.cutResult.motionCount} motion, ${manifest.artifacts.cutResult.freezeCount} freeze)`
    });

    // ---------------- STAGE 5: Delete Temp Subtitles, Save Project & Auto-Export ----------------
    checkAborted(signal);
    emit({
      stepIndex: 5,
      stepKey: 'export',
      pct: 5,
      overallPct: 77,
      message: '🧹 5/5: Түр хадмалыг устгаж, цэвэр видеог экспортолж байна...'
    });

    const exportOpts = spec.exportOptions || {};
    const { width, height } = resolveExportDimensions(exportOpts, videoProbe);
    const fps = Math.max(1, Math.min(120, Number(exportOpts.fps) || Math.round(videoProbe.fps) || 30));
    const format = ['mp4', 'mov'].includes(exportOpts.format) ? exportOpts.format : 'mp4';

    let finalOutPath = spec.outPath ? path.resolve(spec.outPath) : '';
    if (!finalOutPath) {
      const targetDir = spec.exportDir ? path.resolve(spec.exportDir) : getDefaultExportDir(app);
      finalOutPath = makeUniqueFilePath(targetDir, projectBaseName, format);
    } else {
      fs.mkdirSync(path.dirname(finalOutPath), { recursive: true });
    }

    const { cleanProject, exportSpec } = buildCleanProjectAndExportSpec({
      cleanVideoClips: manifest.artifacts.cutResult.videoClips,
      newMedia: manifest.artifacts.cutResult.newMedia,
      videoMediaItem,
      voiceMediaItem,
      voiceClip,
      projectName: projectBaseName,
      outPath: finalOutPath,
      exportOptions: exportOpts,
      width,
      height,
      fps,
      voiceDuration: manifest.artifacts.voiceDuration
    });

    let savedProject = null;
    if (spec.saveProjectToLibrary !== false && d.projectStore?.saveLibraryProject) {
      savedProject = await d.projectStore.saveLibraryProject(app || d.app, cleanProject, {
        id: manifest.artifacts.savedProjectId || undefined,
        setActive: Boolean(spec.openProjectAfterExport)
      });
      manifest.artifacts.savedProjectId = savedProject.id;
      manifest.artifacts.savedProjectPath = savedProject.filePath;
    }

    const cleanProjectSidecar = path.join(jobDir, 'clean_project.cutline');
    atomicWriteJson(cleanProjectSidecar, cleanProject);
    manifest.artifacts.cleanProjectSidecar = cleanProjectSidecar;
    saveManifest();

    let abortListener = null;
    if (signal) {
      abortListener = () => {
        try { d.ff.cancelExport?.(); } catch {}
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }

    let exportedPath;
    try {
      checkAborted(signal);
      exportedPath = await d.ff.exportTimeline(exportSpec, (p) => {
        const expPct = typeof p?.pct === 'number' ? p.pct : 0;
        const spdText = p?.speed ? ` · ${p.speed}` : '';
        const etaText = (typeof p?.remainingSec === 'number') ? ` · үлдсэн ~${p.remainingSec}с` : '';
        emit({
          stepIndex: 5,
          stepKey: 'export',
          pct: expPct,
          overallPct: 75 + Math.round(expPct * 0.25),
          message: `🎬 5/5: Экспортлож байна (${expPct}%${spdText}${etaText})...`
        });
      });
    } finally {
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    }

    const verifiedOut = exportedPath || finalOutPath;
    if (!fs.existsSync(verifiedOut) || fs.statSync(verifiedOut).size <= 0) {
      throw new Error('Экспортын видео файл үүссэнгүй эсвэл хоосон байна.');
    }
    const outProbe = await d.ff.probe(verifiedOut);
    if (!outProbe.hasVideo || !outProbe.hasAudio || !(outProbe.duration > 0)) {
      throw new Error('Экспортолсон видео дүрс эсвэл дууны зам дутуу байна.');
    }

    manifest.status = 'completed';
    manifest.artifacts.outPath = verifiedOut;
    manifest.artifacts.outProbe = outProbe;
    manifest.completedStages.push('export');
    saveManifest();

    emit({
      stepIndex: 5,
      stepKey: 'export',
      pct: 100,
      overallPct: 100,
      message: `✨ Бүрэн авто эвлүүлэг ба экспорт амжилттай дууслаа! (${Math.round(outProbe.duration)} сек)`
    });

    return {
      ok: true,
      jobId,
      outPath: verifiedOut,
      voiceAudioPath: manifest.artifacts.voiceAudioPath,
      cleanProject,
      savedProjectId: savedProject?.id || null,
      savedProjectPath: savedProject?.filePath || cleanProjectSidecar,
      report: {
        voiceDuration: manifest.artifacts.voiceDuration,
        draftCaptionCount: manifest.artifacts.draftCaptions.length,
        fixedCaptionCount: manifest.artifacts.fixedCaptions.length,
        finalTextClipCount: cleanProject.clips.filter((c) => c.kind === 'text').length,
        videoClipCount: manifest.artifacts.cutResult.videoClips.length,
        motionCount: manifest.artifacts.cutResult.motionCount,
        freezeCount: manifest.artifacts.cutResult.freezeCount,
        exportDuration: outProbe.duration,
        width: outProbe.width || width,
        height: outProbe.height || height
      }
    };
  } catch (err) {
    const isCanceled = Boolean(signal?.aborted);
    manifest.status = isCanceled ? 'canceled' : 'failed';
    manifest.error = redactSecrets(err.message || String(err), secretsToRedact);
    saveManifest();
    return {
      ok: false,
      canceled: isCanceled,
      jobId,
      error: manifest.error,
      completedStages: manifest.completedStages
    };
  }
}

async function runAutoPipeline(spec = {}, options = {}) {
  const jobId = options.jobId || `job_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const jobDir = path.join(getJobsRootDir(options.app || options.deps?.app), jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const manifest = {
    jobId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'running',
    completedStages: [],
    spec: {
      ...spec,
      // Persist non-secret spec fields cleanly; never persist inline API keys
      geminiApiKey: undefined,
      elevenLabsApiKey: undefined
    },
    artifacts: {}
  };
  atomicWriteJson(path.join(jobDir, 'manifest.json'), manifest);

  return executePipelineInternal({ jobId, jobDir, manifest, spec, options });
}

async function resumeAutoPipeline(jobId, specOverrides = {}, options = {}) {
  const jobDir = path.join(getJobsRootDir(options.app || options.deps?.app), String(jobId || ''));
  const manifest = readJsonSafe(path.join(jobDir, 'manifest.json'));
  if (!manifest) {
    throw new Error(`Сэргээх ажил олдсонгүй (${jobId}).`);
  }
  const mergedSpec = { ...manifest.spec, ...specOverrides };
  manifest.status = 'running';
  manifest.error = null;
  atomicWriteJson(path.join(jobDir, 'manifest.json'), manifest);

  return executePipelineInternal({ jobId, jobDir, manifest, spec: mergedSpec, options });
}

function listAutoPipelineJobs(app) {
  const root = getJobsRootDir(app);
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  const jobs = [];
  for (const e of entries) {
    const m = readJsonSafe(path.join(root, e.name, 'manifest.json'));
    if (!m) continue;
    jobs.push({
      jobId: m.jobId || e.name,
      createdAt: m.createdAt || 0,
      updatedAt: m.updatedAt || 0,
      status: m.status || 'unknown',
      completedStages: Array.isArray(m.completedStages) ? m.completedStages : [],
      error: m.error || null,
      videoPath: m.spec?.videoPath || '',
      srtPath: m.spec?.srtPath || '',
      outputName: m.spec?.outputName || '',
      outPath: m.artifacts?.outPath || '',
      savedProjectId: m.artifacts?.savedProjectId || null,
      scriptPreview: String(m.spec?.scriptText || '').slice(0, 80)
    });
  }
  jobs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return jobs.slice(0, 20);
}

module.exports = {
  STEP_ORDER,
  detectSrtSliceFromVideoName,
  resolveExportDimensions,
  sanitizePipelineCaptions,
  buildDraftTimelineProject,
  buildCleanProjectAndExportSpec,
  preflightAutoPipeline,
  runAutoPipeline,
  resumeAutoPipeline,
  listAutoPipelineJobs
};
