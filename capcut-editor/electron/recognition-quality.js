'use strict';
const { reconcileRecognitionWords } = require('./caption-timing');
const { planRecognitionChunks, stitchRecognitionChunks } = require('./whisper-chunks');

// Energy is used to find silence and obvious timing/coverage failures. It is
// not a speech detector or a guarantee that recognized words are correct.
function readWaveActivity(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Speech recognition requires PCM WAV audio.');
  }
  let sampleRate, channels, bits, format, data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const begin = offset + 8, end = Math.min(buffer.length, begin + size);
    if (id === 'fmt ' && end - begin >= 16) {
      format = buffer.readUInt16LE(begin);
      channels = buffer.readUInt16LE(begin + 2);
      sampleRate = buffer.readUInt32LE(begin + 4);
      bits = buffer.readUInt16LE(begin + 14);
    } else if (id === 'data') data = buffer.subarray(begin, end);
    offset = begin + size + (size % 2);
  }
  if (format !== 1 || channels !== 1 || bits !== 16 || !sampleRate || !data) {
    throw new Error('Speech recognition requires 16-bit mono PCM WAV audio.');
  }
  const samples = Math.floor(data.length / 2), step = Math.round(sampleRate * 0.1);
  const ranges = [];
  for (let start = 0; start < samples; start += step) {
    const end = Math.min(samples, start + step);
    let power = 0;
    for (let i = start; i < end; i++) power += (data.readInt16LE(i * 2) / 32768) ** 2;
    // Conservative -60 dB floor: quiet speech must not be discarded as silence.
    if (power / (end - start) > 1e-6) {
      const previous = ranges[ranges.length - 1];
      if (previous && Math.abs(previous.end - start / sampleRate) < 0.001) previous.end = end / sampleRate;
      else ranges.push({ start: start / sampleRate, end: end / sampleRate });
    }
  }
  return { duration: samples / sampleRate, ranges,
    activeSeconds: ranges.reduce((sum, r) => sum + r.end - r.start, 0) };
}

function activeBetween(activity, start, end) {
  return activity.ranges.reduce((sum, r) => sum + Math.max(0, Math.min(end, r.end) - Math.max(start, r.start)), 0);
}

function assessRecognition(result, activity) {
  const duration = activity.duration;
  const words = (result?.words || []).filter(w => String(w.word || '').trim());
  const segments = (result?.segments || []).filter(s => String(s.text || '').trim());
  const text = segments.length ? segments.map(s => s.text).join(' ') : words.map(w => w.word).join(' ');
  const tokens = text.match(/[\p{L}\p{N}]+/gu) || [];
  const issues = [];
  const likelyNoSpeech = segments.length > 0 && segments.every(s => s.no_speech_prob > 0.6);
  if (!likelyNoSpeech && !tokens.length && activity.activeSeconds >= 0.5) {
    issues.push('empty transcript for active audio');
  }
  if (words.some(w => !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end < w.start || w.start < -0.5 || w.end > duration + 0.5)) {
    issues.push('invalid word timestamps');
  }
  if (segments.some(s => !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start || s.end > duration + 0.5)) {
    issues.push('invalid segment timestamps');
  }
  if (!likelyNoSpeech && activity.activeSeconds >= 4 && tokens.length < activity.activeSeconds * 0.45) {
    issues.push('too little text for active audio');
  }
  if (words.some(w => w.end - w.start > 4 && activeBetween(activity, w.start, w.end) > 3)) {
    issues.push('word stretched across active audio');
  }
  // Use segment coverage when word timing is missing/partial; the reconciliation
  // layer can recover that text. Never retry merely because words were omitted.
  const wordTokens = words.map(w => w.word).join(' ').match(/[\p{L}\p{N}]+/gu) || [];
  const spans = (segments.length && wordTokens.length < tokens.length ? segments : words.length ? words : segments)
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end)).slice().sort((a, b) => a.start - b.start);
  let end = 0;
  for (const span of [...spans, { start: duration, end: duration }]) {
    if (!likelyNoSpeech && span.start - end >= 4 && activeBetween(activity, end, span.start) >= 3) {
      issues.push('active audio missing from transcript');
      break;
    }
    end = Math.max(end, span.end);
  }
  const normalized = tokens.map(t => t.toLocaleLowerCase('mn'));
  if (activity.activeSeconds >= 6) {
    for (let width = 1; width <= 4; width++) {
      for (let i = 0; i + width * 3 <= normalized.length; i++) {
        if (normalized.slice(i, i + width).join(' ') === normalized.slice(i + width, i + width * 2).join(' ') &&
            normalized.slice(i, i + width).join(' ') === normalized.slice(i + width * 2, i + width * 3).join(' ') &&
            width * 3 >= normalized.length * 0.6) {
          issues.push('repetitive transcript');
          return issues;
        }
      }
    }
  }
  return issues;
}

function timeLabel(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function recognizeWithRecovery(chunk, options, depth = 0) {
  const { readAudio, recognize, signal, onRetry } = options;
  signal?.throwIfAborted();
  const buffer = await readAudio(chunk);
  signal?.throwIfAborted();
  const activity = readWaveActivity(buffer);
  if (!activity.ranges.length) return [];
  const result = await recognize(chunk, buffer);
  signal?.throwIfAborted();
  const issues = assessRecognition(result, activity);
  if (!issues.length) return reconcileRecognitionWords(result, activity.duration);
  if (depth >= 2 || activity.duration <= 4) {
    throw new Error(`${timeLabel(chunk.start)}–${timeLabel(chunk.start + activity.duration)} хэсгийн яриа найдвартай танигдсангүй. Богино хэсгээр дахин шалгасан ч үг эсвэл цаг нь зөрүүтэй байна. Хадмалыг өөрчлөөгүй.`);
  }
  onRetry?.(chunk, issues);
  const children = planRecognitionChunks(chunk.start, activity.duration, depth === 0 ? 8 : 4, 0.35);
  const recovered = [];
  for (const child of children) {
    signal?.throwIfAborted();
    recovered.push({ chunk: child, words: await recognizeWithRecovery(child, options, depth + 1) });
  }
  return stitchRecognitionChunks(recovered).map(w => ({ ...w,
    start: w.start - chunk.start, end: w.end - chunk.start,
    segmentIndex: `${w.chunkIndex}:${w.segmentIndex ?? -1}` }));
}

module.exports = { readWaveActivity, assessRecognition, recognizeWithRecovery };
