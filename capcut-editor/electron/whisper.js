'use strict';
const { app } = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const ff = require('./ffmpeg');

/**
 * Local speech-to-text via whisper.cpp.
 *
 * Shotcut ships `whisper-cli.exe`, so the binary is usually already on disk;
 * only the model weights need downloading, and that happens once.
 */

const MODEL_HOST = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

const MODELS = [
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
  if (!MODELS.some(m=>m.id===id)) throw new Error('Unknown Whisper model.');
  const bundled = [path.join(process.resourcesPath || '', 'recap-tools', `ggml-${id}.bin`),path.join(__dirname, '..', 'runtime-tools', `ggml-${id}.bin`)];
  return bundled.find(p=>fs.existsSync(p)) || path.join(modelDir(), `ggml-${id}.bin`);
};

/** What the UI needs to decide whether transcription is available. */
function status() {
  const bin = binary();
  return {
    available: Boolean(bin),
    binary: bin,
    models: MODELS.map((m) => ({ ...m, installed: fs.existsSync(modelPath(m.id)) }))
  };
}

async function downloadModel(id, onProgress) {
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
    execFile(
      ff.FFMPEG,
      ['-y', '-ss', String(start), '-i', videoPath, ...(duration ? ['-t', String(duration)] : []), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out],
      { maxBuffer: 1024 * 1024 * 16, windowsHide: true, signal },
      (err, _stdout, stderr) => {
        if (err) { try {fs.unlinkSync(out);} catch {} reject(new Error(stderr || err.message)); }
        else resolve(out);
      }
    );
  });
}

/**
 * Transcribe a media file into { id, start, end, text } segments.
 * `language` is a two-letter code, or 'auto' to detect.
 */
async function transcribe(mediaPath, { model = 'base', language = 'auto', onProgress, start = 0, duration, signal, threads } = {}) {
  const bin = binary();
  if (!bin) {
    throw new Error(
      'whisper-cli was not found. Install Shotcut (which bundles it) or set WHISPER_CLI_PATH.'
    );
  }
  const weights = modelPath(model);
  if (!fs.existsSync(weights)) throw new Error(`Model "${model}" is not downloaded yet.`);

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
        '-bs', '1', // 3x speedup via greedy decoding
        '-bo', '1',
        '-pp',      // print progress percentage
        '--output-json',
        '-of', outBase
      ];
      const proc = spawn(bin, args, { windowsHide: true, signal });
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
      proc.on('error', reject);
      proc.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(stderr.split('\n').slice(-10).join('\n') || `whisper exited ${code}`))
      );
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
    return { segments, language: data.result?.language ?? language };
  } finally {
    try { fs.unlinkSync(wav); } catch { /* best effort */ }
  }
}

module.exports = { status, downloadModel, transcribe, MODELS };
