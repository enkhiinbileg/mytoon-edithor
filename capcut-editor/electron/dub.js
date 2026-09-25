'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const ff = require('./ffmpeg');
const tts = require('./tts');
const work = require('./recap-work');

/**
 * Turn translated segments into timed audio clips.
 *
 * The hard part is not the speech, it's the fit: a Mongolian line rarely takes
 * exactly as long to say as the English it replaces. Each line gets a slot that
 * runs from its own start to wherever the next line begins, and is nudged with
 * `atempo` to fit — within a bounded range, because past roughly 1.4x speech
 * stops sounding like a person.
 */

const MIN_TEMPO = 0.85;

function probeDuration(file, signal) {
  return new Promise((resolve, reject) => {
    execFile(
      ff.FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { windowsHide: true, signal },
      (err, stdout) => (err ? reject(err) : resolve(parseFloat(stdout.trim()) || 0))
    );
  });
}

function applyTempo(input, output, tempo, signal) {
  return new Promise((resolve, reject) => {
    execFile(
      ff.FFMPEG,
      ['-y', '-i', input, '-filter:a', `atempo=${tempo.toFixed(4)}`, '-c:a', 'libmp3lame', '-q:a', '4', output],
      { maxBuffer: 1024 * 1024 * 16, windowsHide: true, signal },
      (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(output))
    );
  });
}

/** Total characters that will be billed by the TTS provider. */
function characterCount(segments) {
  return segments.reduce((n, s) => n + (s.translated || '').length, 0);
}

/**
 * Synthesise every translated segment and fit it to its slot.
 * Returns [{ id, file, start, duration, tempo, overflow, text }].
 */
async function synthesize(segments, opts = {}, onProgress) {
  const { providerId = 'elevenlabs', apiKey, region, voiceId, modelId,
    stability = 0.5, similarity = 0.75, maxTempo = 1.35, tailSeconds = 2,
    signal, concurrency = 2, mediaDuration = Infinity } = opts;
  if (!apiKey) throw new Error('No API key configured for the selected voice provider.');
  if (!voiceId) throw new Error('No voice selected.');
  if (!Number.isFinite(maxTempo) || maxTempo < 1 || maxTempo > 2) throw new Error('Invalid maximum voice speed.');
  const spoken = segments.filter(s => (s.translated || '').trim()).sort((a,b) => a.start-b.start);
  if (!spoken.length) throw new Error('Nothing to synthesise — no translated text.');
  for (const s of spoken) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start || s.start >= mediaDuration)
      throw new Error('Invalid transcript timing.');
  }
  const dir = path.join(tts.outDir(), 'cache-v2');
  fs.mkdirSync(dir, { recursive: true });
  const run = opts.limiter || work.limiter(concurrency, signal);
  let done = 0, cached = 0;
  const clips = await work.map(spoken, Math.max(1, Math.min(20, concurrency)), (seg, i) => run(async () => {
    work.check(signal);
    const speech = { providerId, region, voiceId, modelId, stability, similarity,
      text: seg.translated.trim(), previousText: spoken[i-1]?.translated || opts.previousText || '',
      nextText: spoken[i+1]?.translated || opts.nextText || '' };
    const key = work.hash({ ...speech, segmentId: seg.id });
    const raw = path.join(dir, key + '.mp3');
    const meta = path.join(dir, key + '.json');
    let saved = work.read(meta);
    if (!saved || !fs.existsSync(raw) || fs.statSync(raw).size !== saved.bytes) {
      // Charge reservation happens synchronously before any network request.
      opts.reserveCharacters?.(speech.text.length);
      const temporary = raw + '.' + crypto.randomBytes(4).toString('hex') + '.part';
      try {
        for (let attempt = 0; ; attempt++) {
          work.check(signal);
          try { await tts.speak(providerId, { ...speech, apiKey, file: temporary, signal }); break; }
          catch (err) {
            // Retry only an explicit rejection, never an ambiguous billed request.
            if (err.status !== 429 || attempt >= 3) throw err;
            const ms = Math.min(60000, err.retryAfterMs || 2000 * 2 ** attempt);
            onProgress?.({ done, total: spoken.length, waiting: ms / 1000 });
            await require('node:timers/promises').setTimeout(ms, undefined, { signal });
          }
        }
        const duration = await probeDuration(temporary, signal);
        if (!(duration > 0)) throw new Error('Voice service returned invalid audio.');
        fs.renameSync(temporary, raw);
        saved = { duration, bytes: fs.statSync(raw).size };
        work.write(meta, saved);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    } else cached++;
    work.check(signal);
    const next = spoken[i+1];
    const slotEnd = Math.min(mediaDuration, next ? next.start : (opts.slotEnd ?? seg.end + tailSeconds));
    const slot = slotEnd - seg.start;
    if (!(slot > 0)) throw new Error('Overlapping transcript starts.');
    const tempo = saved.duration > slot ? Math.min(saved.duration / slot, maxTempo) : 1;
    let file = raw;
    let duration = saved.duration;
    if (tempo > 1.001) {
      const fitted = path.join(dir, key + '-fit-' + tempo.toFixed(4) + '.mp3');
      if (!fs.existsSync(fitted)) {
        const temp = fitted + '.' + crypto.randomBytes(4).toString('hex') + '.mp3';
        try { await applyTempo(raw, temp, tempo, signal); fs.renameSync(temp, fitted); }
        finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      }
      file = fitted;
      duration = await probeDuration(file, signal);
    }
    onProgress?.({ done: ++done, total: spoken.length, id: seg.id, cached });
    return { id: seg.id, file, start: seg.start, duration, tempo,
      overflow: Math.max(0, duration - slot), text: speech.text };
  }), signal);
  return { jobId: work.hash(clips).slice(0, 12), dir, clips, cached };
}

module.exports = { synthesize, characterCount };
