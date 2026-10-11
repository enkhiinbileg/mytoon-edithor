'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const wave = require('./helpers/pcm-wave.cjs');

function load(decode) {
  const files = new Map(), samples = new Map(), calls = [];
  const context = { module: { exports: {} }, console, process, Buffer, __dirname: 'isolated',
    require: name => ({
      electron: { app: { getPath: () => 'isolated' } },
      'node:fs': { mkdirSync() {}, existsSync: () => true, statSync: () => ({ size: 100, mtimeMs: 1 }),
        readFileSync: file => files.get(file), writeFileSync: (file, value) => files.set(file, value), unlinkSync: file => files.delete(file) },
      'node:child_process': {
        execFile: (_bin, args, _options, callback) => {
          const duration = Number(args[args.indexOf('-t') + 1]) || 27;
          const start = args.includes('-ss') ? Number(args[args.indexOf('-ss') + 1]) : 0;
          const file = args.at(-1); files.set(file, wave(duration)); samples.set(file, { start, duration });
          callback(null, '', '');
        },
        spawn: (_bin, args) => {
          const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
          const sample = samples.get(args[args.indexOf('-f') + 1]);
          calls.push(sample);
          process.nextTick(() => {
            const transcription = decode(sample, calls.length).map(s => ({
              offsets: { from: s.start * 1000, to: s.end * 1000 }, text: s.text
            }));
            files.set(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription, result: { language: 'mn' } }));
            proc.emit('close', 0);
          });
          return proc;
        }
      },
      './ffmpeg': { FFMPEG: 'test-ffmpeg', probe: async () => ({ duration: 200, hasAudio: true }) },
      './recognition-quality': require('../electron/recognition-quality'),
      './whisper-chunks': require('../electron/whisper-chunks')
    }[name] || require(name))
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../electron/whisper'), 'utf8'), context);
  return { transcribe: context.module.exports.transcribe, calls };
}

test('local recognition retries uncovered speech and retains absolute offsets without rewriting words', async () => {
  const { transcribe, calls } = load((sample, attempt) => [{ start: 0, end: attempt === 1 ? 17 : sample.duration,
    text: Array.from({ length: Math.floor((attempt === 1 ? 17 : sample.duration) * 2) }, (_, i) => `үг${i}`).join(' ') }]);
  const controller = new AbortController();
  const retries = [];
  const result = await transcribe('source.wav', { model: 'base', language: 'mn', start: 100, duration: 27,
    quality: true, forceFresh: true, signal: controller.signal, onProgress: p => retries.push(p) });
  assert.equal(calls.length, 5);
  assert.equal(result.words[0].start, 100);
  assert.ok(Math.abs(result.words.at(-1).end - 127) < 0.001);
  assert.ok(result.words.length >= 50);
  assert.ok(result.segments.every(s => s.start >= 100 && s.end <= 127));
  assert.ok(retries.some(p => p.message?.includes('дахин шалгаж')));
  assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0);
});

test('local persistent timing failures do not return successful incomplete subtitles', async () => {
  const { transcribe, calls } = load(() => [{ start: 0, end: 30, text: 'Хэл дээрх хэл дээрх хэл дээрх.' }]);
  await assert.rejects(transcribe('source.wav', { model: 'base', language: 'mn', start: 1350,
    duration: 27, quality: true, forceFresh: true }), /22:30–22:34.*найдвартай танигдсангүй/);
  assert.equal(calls.length, 3);
});
