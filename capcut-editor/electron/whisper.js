'use strict';
const { app } = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const ff = require('./ffmpeg');
const { planRecognitionChunks, stitchRecognitionChunks } = require('./whisper-chunks');
const { recognizeWithRecovery } = require('./recognition-quality');

/**
 * Local speech-to-text via whisper.cpp.
 *
 * Shotcut ships `whisper-cli.exe`, so the binary is usually already on disk;
 * only the model weights need downloading, and that happens once.
 */

const MODEL_HOST = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

function getGroqKeys() {
  const keys = [];
  if (process.env.GROQ_API_KEY) {
    keys.push(...process.env.GROQ_API_KEY.split(/[\r\n,;]+/).map(k => k.trim()).filter(Boolean));
  }
  const candidates = [
    path.join(__dirname, '..', 'groq_key.txt'),
    path.join(__dirname, 'groq_key.txt'),
    path.join(process.cwd(), 'groq_key.txt'),
    process.execPath ? path.join(path.dirname(process.execPath), 'groq_key.txt') : '',
    path.join(app?.getPath ? app.getPath('userData') : '', 'groq_key.txt'),
    'C:\\Users\\Gavl\\Desktop\\my project\\VIDEO EDITHOR\\capcut-editor\\groq_key.txt'
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      try {
        const content = fs.readFileSync(c, 'utf8');
        const lines = content.split(/[\r\n,;]+/).map(k => k.trim()).filter(Boolean);
        keys.push(...lines);
      } catch {}
    }
  }
  return Array.from(new Set(keys));
}

function getGroqKey() {
  const keys = getGroqKeys();
  return keys[0] || '';
}

function saveGroqKeys(keysInput) {
  const lines = (Array.isArray(keysInput) ? keysInput : String(keysInput || '').split(/[\r\n,;]+/))
    .map(k => k.trim())
    .filter(Boolean);
  const uniqueKeys = Array.from(new Set(lines));
  const fileContent = uniqueKeys.join('\n') + (uniqueKeys.length ? '\n' : '');

  const targets = [
    path.join(__dirname, '..', 'groq_key.txt'),
    path.join(__dirname, 'groq_key.txt'),
    path.join(process.cwd(), 'groq_key.txt'),
    process.execPath ? path.join(path.dirname(process.execPath), 'groq_key.txt') : '',
    path.join(app?.getPath ? app.getPath('userData') : '', 'groq_key.txt'),
    'C:\\Users\\Gavl\\Desktop\\my project\\VIDEO EDITHOR\\capcut-editor\\groq_key.txt'
  ];

  let written = 0;
  for (const t of targets) {
    if (t) {
      try {
        const dir = path.dirname(t);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(t, fileContent, 'utf8');
        written++;
      } catch {}
    }
  }

  return { ok: true, count: uniqueKeys.length, keys: uniqueKeys };
}

const MODELS = [
  { id: 'groq-whisper-large-v3', label: '⚡ Groq Cloud (5 сек · Large v3)', mb: 0, note: 'Ultra-fast Cloud AI (Хамгийн хурдан)' },
  { id: 'tiny', label: 'Tiny', mb: 75, note: 'Fastest, roughest' },
  { id: 'base', label: 'Base', mb: 142, note: 'Good starting point' },
  { id: 'small', label: 'Small', mb: 466, note: 'Noticeably better' },
  { id: 'medium', label: 'Medium', mb: 1500, note: 'Strong accuracy' },
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', mb: 1600, note: 'Best, still fast' }
];

function binary() {
  const fromEnv = process.env.WHISPER_CLI_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const candidates = [
    path.join(process.resourcesPath || '', 'recap-tools', 'whisper', 'whisper-cli.exe'),
    path.join(__dirname, '..', 'runtime-tools', 'whisper', 'whisper-cli.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Shotcut', 'whisper-cli.exe'),
    path.join(process.env.ProgramFiles || '', 'Shotcut', 'whisper-cli.exe')
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

function modelDir() {
  const base = app?.getPath ? app.getPath('userData') : path.join(os.tmpdir(), 'capcut-editor-whisper');
  const dir = path.join(base, 'whisper-models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const modelPath = (id) => {
  if (id.startsWith('groq')) return 'cloud';
  if (!MODELS.some(m=>m.id===id)) throw new Error('Unknown Whisper model.');
  const bundled = [path.join(process.resourcesPath || '', 'recap-tools', `ggml-${id}.bin`),path.join(__dirname, '..', 'runtime-tools', `ggml-${id}.bin`)];
  return bundled.find(p=>fs.existsSync(p)) || path.join(modelDir(), `ggml-${id}.bin`);
};

/** What the UI needs to decide whether transcription is available. */
function status() {
  const bin = binary();
  return {
    available: true,
    binary: bin,
    models: MODELS.map((m) => ({
      ...m,
      installed: m.id.startsWith('groq') ? Boolean(getGroqKey()) : (Boolean(bin) && fs.existsSync(modelPath(m.id)))
    }))
  };
}

async function downloadModel(id, onProgress) {
  if (id.startsWith('groq')) {
    onProgress?.(100);
    return 'cloud';
  }
  const model = MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);

  const dest = modelPath(id);
  if (fs.existsSync(dest)) return dest;

  const url = `${MODEL_HOST}/ggml-${id}.bin`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Model download failed (HTTP ${res.status}).`);

  const total = Number(res.headers.get('content-length')) || model.mb * 1024 * 1024;
  let received = 0;
  let lastPct = -1;

  // Download to a temp name so an interrupted transfer can't be mistaken for a
  // complete model on the next run.
  const tmp = dest + '.part';
  const source = Readable.fromWeb(res.body);
  source.on('data', (buf) => {
    received += buf.length;
    const pct = Math.min(99, Math.round((received / total) * 100));
    if (pct !== lastPct) {
      lastPct = pct;
      onProgress?.(pct);
    }
  });

  try {
    await pipeline(source, fs.createWriteStream(tmp));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw new Error(`Model download failed: ${err.message}`);
  }

  fs.renameSync(tmp, dest);
  onProgress?.(100);
  return dest;
}

/** whisper.cpp needs 16 kHz mono PCM. */
function extractAudio(videoPath, { start = 0, duration, signal } = {}) {
  const out = path.join(os.tmpdir(), `capcut-stt-${process.pid}-${require('node:crypto').randomBytes(6).toString('hex')}.wav`);
  return new Promise((resolve, reject) => {
    const args = ['-y'];
    if (start > 0) {
      args.push('-ss', String(start), '-i', videoPath);
    } else {
      args.push('-i', videoPath);
    }
    if (duration) args.push('-t', String(duration));
    args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out);

    execFile(
      ff.FFMPEG,
      args,
      { maxBuffer: 1024 * 1024 * 16, windowsHide: true, signal },
      (err, _stdout, stderr) => {
        if (err) { try {fs.unlinkSync(out);} catch {} reject(new Error(stderr || err.message)); }
        else resolve(out);
      }
    );
  });
}

async function transcribeWithGroq(mediaPath, { language = 'mn', onProgress, signal, start = 0, duration, apiKey, prompt, forceFresh = false } = {}) {
  const keys = apiKey ? [apiKey] : getGroqKeys();
  if (!keys.length) throw new Error('Groq API түлхүүр олдсонгүй. Тохиргоондоо Groq түлхүүрээ оруулна уу.');

  const probe = await ff.probe(mediaPath).catch(() => null);
  if (probe && !probe.hasAudio) {
    return { segments: [], words: [], language: 'unknown', text: '', duration: probe.duration || 0 };
  }

  const totalDuration = duration || (probe?.duration ? Math.max(0, probe.duration - start) : 0);
  const lang = (language === 'auto' || !language) ? 'mn' : language;
  const userPrompt = prompt ? String(prompt).trim().slice(0, 400) : '';

  const chunks = planRecognitionChunks(start, totalDuration);
  const numChunks = chunks.length;

  const allSegments = [];
  const allWords = [];
  const recognizedChunks = [];
  let currentKeyIndex = 0;

  const cacheDir = path.join(path.dirname(modelDir()), 'caption-recognition-cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
  const sourceStat = fs.existsSync(mediaPath) ? fs.statSync(mediaPath) : { size: 0, mtimeMs: 0 };

  async function recognizeChunk(chunk, fileBuffer) {
    const chunkStart = chunk.start, chunkDur = chunk.duration;
    const chunkCacheKey = require('node:crypto').createHash('sha256').update(JSON.stringify({
      v: 'groq-v7-quality-pcm',
      file: path.resolve(mediaPath),
      size: sourceStat.size,
      mtime: sourceStat.mtimeMs,
      chunkStart,
      chunkDur,
      lang,
      userPrompt
    })).digest('hex');
    const chunkCacheFile = path.join(cacheDir, `groq-chunk-${chunkCacheKey}.json`);

    let data = null;
    if (!forceFresh && fs.existsSync(chunkCacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(chunkCacheFile, 'utf8'));
        if (cached && (Array.isArray(cached.words) || Array.isArray(cached.segments))) {
          data = cached;
        }
      } catch {}
    }

    if (!data) {
      let lastErrText = '';
      let success = false;

      const maxChunkAttempts = Math.max(4, keys.length * 3);
      for (let attempt = 0; attempt < maxChunkAttempts; attempt++) {
        signal?.throwIfAborted();
        const activeKey = keys[(currentKeyIndex + attempt) % keys.length];
        const form = new FormData();
        form.append('file', new Blob([fileBuffer]), 'speech.wav');
        form.append('model', 'whisper-large-v3');
        form.append('response_format', 'verbose_json');
        form.append('language', lang);
        form.append('timestamp_granularities[]', 'word');
        form.append('timestamp_granularities[]', 'segment');
        form.append('temperature', '0');
        if (userPrompt) {
          form.append('prompt', userPrompt);
        }

        const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${activeKey}` },
          body: form,
          signal
        });

        if (res.ok) {
          data = await res.json();
          currentKeyIndex = (currentKeyIndex + attempt) % keys.length;
          success = true;
          try { fs.writeFileSync(chunkCacheFile, JSON.stringify(data)); } catch {}
          break;
        }

        lastErrText = await res.text();
        if (res.status !== 429) {
          throw new Error(`Groq API алдаа (${res.status}): ${lastErrText}`);
        }

        // If all keys tested and wait time is <= 240s, do a friendly countdown wait and retry
        if ((attempt + 1) % keys.length === 0) {
          const waitMatch = /try again in\s+(?:(\d+)\s*m(?:in)?)?\s*([\d.]+)\s*s/i.exec(lastErrText);
          const waitSec = waitMatch ? Math.ceil(Number(waitMatch[1] || 0) * 60 + Number(waitMatch[2] || 0)) : 0;
          if (waitSec > 0 && waitSec <= 240 && attempt + 1 < maxChunkAttempts) {
            for (let s = waitSec + 1; s > 0; s--) {
              signal?.throwIfAborted();
              onProgress?.({
                stage: 'transcribe',
                message: `⚡ Groq Cloud: Эрх сэргэхийг түр хүлээж байна (${s} сек)...`
              });
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        }
      }

      if (!success || !data) {
        let waitMsg = '';
        const waitMatch = /try again in ([^.]+)/i.exec(lastErrText);
        if (waitMatch) {
          waitMsg = ` (${waitMatch[1]} хүлээх шаардлагатай)`;
        }
        throw new Error(`Groq үнэгүй эрхийн хязгаар (цагт 7,200 сек буюу 2 цагийн яриа) түр хүрсэн байна${waitMsg}. Хэдэн минут хүлээгээд дахин дарна уу эсвэл groq_key.txt-д нэмэлт үнэгүй түлхүүр оруулна уу (console.groq.com/keys).`);
      }
    }
    return data;
  }

  for (let i = 0; i < numChunks; i++) {
    signal?.throwIfAborted();
    const chunk = chunks[i];
    onProgress?.({ stage: 'transcribe', pct: Math.round(((i + 0.1) / numChunks) * 95),
      message: `⚡ Groq Cloud: ${i + 1}/${numChunks} хэсгийг таньж байна...` });
    const words = await recognizeWithRecovery(chunk, {
      signal,
      readAudio: async part => {
        const wav = await extractAudio(mediaPath, { start: part.start, duration: part.duration, signal });
        try { return fs.readFileSync(wav); } finally { try { fs.unlinkSync(wav); } catch {} }
      },
      recognize: recognizeChunk,
      onRetry: part => onProgress?.({ stage: 'transcribe',
        message: `⚡ ${Math.floor(part.start / 60)}:${String(Math.floor(part.start % 60)).padStart(2, '0')} хэсгийн үг, цаг зөрүүтэй байна. Богино хэсгээр дахин таньж байна...` })
    });
    recognizedChunks.push({ chunk, words });
  }

  // Resolve adjacent observations jointly: timestamp jitter can put the same
  // word on opposite sides of a boundary in two responses.
  const stitchedWords = stitchRecognitionChunks(recognizedChunks);
  allWords.push(...stitchedWords.map(({ word, start: wordStart, end, timingSource }) => ({
    word, start: Math.round(wordStart * 1000) / 1000,
    end: Math.round(end * 1000) / 1000, ...(timingSource ? { timingSource } : {})
  })));
  // Segment text must use the same retained words as the word transcript,
  // otherwise context text would be restored twice by segment fallback.
  const groups = new Map();
  for (const word of stitchedWords) {
    const key = `${word.chunkIndex}:${word.segmentIndex ?? -1}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(word);
  }
  for (const group of groups.values()) {
    const sStart = group[0].start;
    const sEnd = group[group.length - 1].end;
    allSegments.push({ id: allSegments.length, start: sStart, end: sEnd,
      duration: sEnd - sStart, text: group.map(word => word.word).join(' ') });
  }

  allSegments.sort((a, b) => a.start - b.start);

  onProgress?.({ stage: 'transcribe', pct: 100, message: '⚡ Groq танилт амжилттай дууслаа!' });
  return { segments: allSegments, words: allWords, language: lang };
}

/**
 * Transcribe a media file into { id, start, end, text } segments.
 * `language` is a two-letter code, or 'auto' to detect.
 */
async function transcribe(mediaPath, { model = 'groq-whisper-large-v3', language = 'auto', onProgress, start = 0, duration, signal, threads, quality = false, apiKey, prompt, forceFresh = false, _skipQualityValidation = false } = {}) {
  if (model.startsWith('groq')) {
    return transcribeWithGroq(mediaPath, { language, onProgress, signal, start, duration, apiKey, prompt, forceFresh });
  }

  const bin = binary();
  if (!bin) {
    throw new Error(
      'whisper-cli was not found. Install Shotcut (which bundles it) or set WHISPER_CLI_PATH.'
    );
  }
  const weights = modelPath(model);
  if (!fs.existsSync(weights)) throw new Error(`Model "${model}" is not downloaded yet.`);
  // Reuse recognition when only caption layout or script matching changes.
  const sourceStat = fs.statSync(mediaPath), weightStat = fs.statSync(weights);
  const cacheKey = require('node:crypto').createHash('sha256').update(JSON.stringify({ version: 2, checked: !_skipQualityValidation,
    file: path.resolve(mediaPath), size: sourceStat.size, modified: sourceStat.mtimeMs,
    weights, weightSize: weightStat.size, weightModified: weightStat.mtimeMs, language, start, duration, quality })).digest('hex');
  const cacheDir = path.join(path.dirname(modelDir()), 'caption-recognition-cache');
  const cacheFile = path.join(cacheDir, cacheKey + '.json');
  if (quality && !forceFresh) {
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (saved.segments?.length && saved.segments.every(s => typeof s.text === 'string' && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)) {
        signal?.throwIfAborted();
        onProgress?.({ stage: 'transcribe', pct: 100, message: 'Хадгалсан ярианы танилтыг ашиглаж байна...' });
        return saved;
      }
    } catch (error) { if (signal?.aborted) throw error; }
  }

  const probe = await ff.probe(mediaPath).catch(() => null);
  if (probe && !probe.hasAudio) {
    return { segments: [], language: 'unknown', text: '', duration: probe.duration || 0 };
  }

  onProgress?.({ stage: 'audio', pct: 0 });
  const wav = await extractAudio(mediaPath, { start, duration, signal });
  const outBase = wav.replace(/\.wav$/, '');

  try {
    await new Promise((resolve, reject) => {
      const args = [
        '-m', weights,
        '-f', wav,
        '-l', language,
        '-t', String(threads || Math.max(4, Math.min(12, os.cpus().length))),
        '-bs', quality ? '5' : '1',
        '-bo', quality ? '5' : '1',
        '-pp',      // print progress percentage
        '--output-json',
        '-of', outBase
      ];
      const proc = spawn(bin, args, { windowsHide: true, signal });
      const killTree = () => {
          try {
            if (proc?.pid) {
              execFile('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true }, () => {});
            }
          } catch {}
      };
      signal?.addEventListener('abort', killTree, { once: true });
      let stderr = '';

      // whisper.cpp reports progress on stderr as "[00:01:23.000 --> ...]" and "progress = 45%".
      const handleData = (b) => {
        const text = b.toString();
        stderr += text;

        let pct = null;
        const pM = /progress\s*=\s*(\d+)%/i.exec(text);
        if (pM) pct = parseInt(pM[1], 10);

        let secs = null;
        const mM = /\[(\d{2}):(\d{2}):(\d{2})/.exec(text);
        if (mM) {
          secs = Number(mM[1]) * 3600 + Number(mM[2]) * 60 + Number(mM[3]);
        }

        const lines = text.split('\n');
        let currentText = '';
        for (const line of lines) {
          if (line.includes('-->')) {
            const clean = line.replace(/\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]/g, '').trim();
            if (clean && clean.length > 2) currentText = clean;
          }
        }

        if (secs !== null || pct !== null || currentText) {
          onProgress?.({ stage: 'transcribe', seconds: secs, pct, currentText });
        }
      };

      proc.stderr.on('data', handleData);
      proc.stdout.on('data', handleData);
      proc.on('error', error => { signal?.removeEventListener('abort', killTree); reject(error); });
      proc.on('close', (code) => {
        signal?.removeEventListener('abort', killTree);
        code === 0
          ? resolve()
          : reject(new Error(stderr.split('\n').slice(-10).join('\n') || `whisper exited ${code}`))
      });
    });

    const jsonPath = `${outBase}.json`;
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const segments = (data.transcription || [])
      .map((t, i) => ({
        id: i,
        start: start + (t.offsets?.from ?? 0) / 1000,
        end: start + (t.offsets?.to ?? 0) / 1000,
        text: (t.text || '').trim()
      }))
      .filter((s) => s.text && s.end > s.start);

    try { fs.unlinkSync(jsonPath); } catch { /* best effort */ }
    let result = { segments, language: data.result?.language ?? language };
    if (quality && !_skipQualityValidation) {
      const originalWave = fs.readFileSync(wav);
      const { readWaveActivity } = require('./recognition-quality');
      const actualDuration = readWaveActivity(originalWave).duration;
      const initialChunk = { start, duration: actualDuration };
      const relativeResult = value => ({ ...value, segments: value.segments.map(s => ({ ...s, start: s.start - start, end: s.end - start })) });
      const checkedWords = await recognizeWithRecovery(initialChunk, {
        signal,
        readAudio: async part => {
          if (part === initialChunk) return originalWave;
          const sample = await extractAudio(mediaPath, { start: part.start, duration: part.duration, signal });
          try { return fs.readFileSync(sample); } finally { try { fs.unlinkSync(sample); } catch {} }
        },
        recognize: async part => {
          if (part === initialChunk) return relativeResult(result);
          const retry = await transcribe(mediaPath, { model, language, threads, signal,
            start: part.start, duration: part.duration, quality: true, forceFresh: true, _skipQualityValidation: true });
          return { ...retry, segments: retry.segments.map(s => ({ ...s, start: s.start - part.start, end: s.end - part.start })) };
        },
        onRetry: part => onProgress?.({ stage: 'transcribe',
          message: `${Math.floor(part.start / 60)}:${String(Math.floor(part.start % 60)).padStart(2, '0')} хэсгийн танилтыг богино хэсгүүдээр дахин шалгаж байна...` })
      });
      const words = checkedWords.map(w => ({ ...w, start: start + w.start, end: start + w.end }));
      const groups = new Map();
      for (const word of words) {
        const key = word.segmentIndex ?? -1;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(word);
      }
      result = { ...result, words, segments: [...groups.values()].map((group, id) => ({ id,
        start: group[0].start, end: group[group.length - 1].end, text: group.map(w => w.word).join(' ') })) };
    }
    if (quality && result.segments.length && !signal?.aborted) {
      try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch {}
    }
    return result;
  } finally {
    try { fs.unlinkSync(wav); } catch { /* best effort */ }
    try { fs.unlinkSync(`${outBase}.json`); } catch { /* best effort */ }
  }
}

module.exports = { status, downloadModel, transcribe, MODELS, getGroqKeys, saveGroqKeys };
