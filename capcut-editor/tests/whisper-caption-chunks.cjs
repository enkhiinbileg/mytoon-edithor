const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planRecognitionChunks, ownChunkWords, stitchRecognitionChunks } = require('../electron/whisper-chunks');

test('short decoding windows include context and cover nonzero source offsets', () => {
  const chunks = planRecognitionChunks(10, 51);
  assert.deepEqual(chunks, [
    { start: 10, duration: 26, coreStart: 10, coreEnd: 35 },
    { start: 34, duration: 27, coreStart: 35, coreEnd: 60 },
    { start: 59, duration: 2, coreStart: 60, coreEnd: 61 }
  ]);
  assert.ok(chunks.every(c => c.duration < 30));
});

test('boundary words belong to one core while genuine repetitions survive', () => {
  const [left, right] = planRecognitionChunks(0, 50);
  const leftWords = ownChunkWords([
    { word: 'Үгийн', start: 24.6, end: 25.4 }
  ], left);
  const rightWords = ownChunkWords([
    { word: 'Үгийн', start: 0.6, end: 1.4 },
    { word: 'тийм', start: 2, end: 2.08 },
    { word: 'тийм', start: 2.1, end: 2.18 }
  ], right);
  assert.equal(leftWords.length, 0);
  assert.deepEqual(rightWords.map(w => w.word), ['Үгийн', 'тийм', 'тийм']);
  assert.equal(rightWords[0].start, 24.6);
});

test('empty or unknown duration still makes a single decoding request', () => {
  assert.equal(planRecognitionChunks(0, 0).length, 1);
  assert.equal(planRecognitionChunks(0, undefined)[0].duration, undefined);
  assert.equal(planRecognitionChunks(0, 25).length, 1);
});

test('joint boundary ownership retains a word rejected by both independent midpoint filters', () => {
  const [left, right] = planRecognitionChunks(0, 50);
  const leftWords = [{ word: 'Зааг.', start: 24.7, end: 25.5, segmentIndex: 3 }];
  const rightWords = [{ word: 'Зааг.', start: 0.4, end: 1.4, segmentIndex: 0 }];
  assert.equal(ownChunkWords(leftWords, left).length + ownChunkWords(rightWords, right).length, 0);
  const result = stitchRecognitionChunks([{ chunk: left, words: leftWords }, { chunk: right, words: rightWords }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].word, 'Зааг.');
  assert.ok(Number.isInteger(result[0].chunkIndex));
  assert.ok(Number.isInteger(result[0].segmentIndex));
});

test('joint boundary ownership removes duplicate observations kept by both midpoint filters', () => {
  const [left, right] = planRecognitionChunks(0, 50);
  const leftWords = [{ word: 'Зааг.', start: 24.4, end: 25.4 }];
  const rightWords = [{ word: 'Зааг.', start: 0.7, end: 1.5 }];
  assert.equal(ownChunkWords(leftWords, left).length + ownChunkWords(rightWords, right).length, 2);
  assert.equal(stitchRecognitionChunks([{ chunk: left, words: leftWords }, { chunk: right, words: rightWords }]).length, 1);
});

test('one-to-one overlap matching preserves repeated words within each source response', () => {
  const [left, right] = planRecognitionChunks(0, 50);
  const result = stitchRecognitionChunks([
    { chunk: left, words: [{ word: 'тийм', start: 24.82, end: 24.96 }, { word: 'тийм', start: 25.02, end: 25.16 }] },
    { chunk: right, words: [{ word: 'тийм', start: 0.84, end: 0.98 }, { word: 'тийм', start: 1.04, end: 1.18 }] }
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(w => w.word), ['тийм', 'тийм']);
});

test('equal text at separate acoustic times remains two spoken words', () => {
  const [left, right] = planRecognitionChunks(0, 50);
  const result = stitchRecognitionChunks([
    { chunk: left, words: [{ word: 'тийм', start: 24.8, end: 24.9 }] },
    { chunk: right, words: [{ word: 'тийм', start: 1.02, end: 1.12 }] }
  ]);
  assert.equal(result.length, 2);
});

test('context-only recognition fills a boundary omission without adding alternate spellings', () => {
  const [left, right] = planRecognitionChunks(0, 50);
  const result = stitchRecognitionChunks([
    { chunk: left, words: [{ word: 'Нөхөгдсөн', start: 25.2, end: 25.5 }, { word: 'үг', start: 25.6, end: 25.9 }] },
    { chunk: right, words: [{ word: 'үг.', start: 1.6, end: 1.9 }] }
  ]);
  assert.deepEqual(result.map(w => w.word), ['Нөхөгдсөн', 'үг.']);
});

test('stitched words use absolute source offsets and stay within the requested media span', () => {
  const [chunk] = planRecognitionChunks(10, 5);
  const result = stitchRecognitionChunks([{ chunk, words: [
    { word: 'Эхлэл.', start: -1, end: 1, segmentIndex: 0 },
    { word: 'Төгсгөл.', start: 4, end: 8, segmentIndex: 1 },
    { word: 'Outside.', start: 8, end: 9 },
    { word: 'Invalid.', start: NaN, end: 3 }
  ] }]);
  assert.deepEqual(result.map(w => [w.word, w.start, w.end]), [['Эхлэл.', 10, 11], ['Төгсгөл.', 14, 15]]);
});

test('Groq integration retains segment-only speech, repetitions and source offsets without network', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const fixtures = [
    { words: [{ word: 'Эхлэл.', start: 0, end: 0.5 }, { word: 'Зааг.', start: 24.6, end: 25.4 }],
      segments: [{ text: 'Эхлэл.', start: 0, end: 0.5 }, { text: 'Зааг.', start: 24.6, end: 25.4 }] },
    { words: [{ word: 'Зааг.', start: 0.6, end: 1.4 }, { word: 'тийм', start: 2, end: 2.08 }, { word: 'тийм', start: 2.1, end: 2.18 }],
      segments: [{ text: 'Зааг.', start: 0.6, end: 1.4 }, { text: 'тийм тийм', start: 2, end: 2.18 }, { text: 'Дутуу үг.', start: 10, end: 11 }] },
    { words: [], segments: [{ text: 'Төгсгөл.', start: 1.2, end: 1.8 }] }
  ];
  const files = new Map();
  const wave = require('./helpers/pcm-wave.cjs');
  const ffArgs = [];
  let requests = 0;
  const context = { module: { exports: {} }, console, process, FormData, Blob, Buffer,
    require: name => ({
      electron: { app: { getPath: () => '/isolated-caption-test' } },
      'node:fs': { mkdirSync() {}, existsSync: file => file === 'source.mp3' || files.has(file),
        statSync: () => ({ size: 1000, mtimeMs: 1 }),
        readFileSync: file => files.get(file) || Buffer.from('test audio'),
        writeFileSync: (file, value) => files.set(file, value), unlinkSync: file => files.delete(file) },
      'node:child_process': { execFile: (_bin, args, _options, callback) => {
        const active = [[[0, 0.5], [24.6, 25.4]], [[0.6, 1.4], [2, 2.18], [10, 11]], [[1.2, 1.8]]][ffArgs.length];
        ffArgs.push(args);
        files.set(args[args.length - 1], wave(Number(args[args.indexOf('-t') + 1]), active));
        callback(null, '', '');
      } },
      './ffmpeg': { FFMPEG: 'test-ffmpeg', probe: async () => ({ duration: 100, hasAudio: true }) },
      './recognition-quality': require('../electron/recognition-quality'),
      './whisper-chunks': require('../electron/whisper-chunks')
    }[name] || require(name)),
    fetch: async (_url, spec) => {
      assert.equal(spec.body.get('model'), 'whisper-large-v3');
      assert.equal(spec.body.get('prompt'), null, 'Generic language prompts can seed hallucinations');
      assert.equal(spec.body.get('file').name, 'speech.wav');
      return { ok: true, json: async () => fixtures[requests++] };
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../electron/whisper'), 'utf8'), context);
  const result = await context.module.exports.transcribe('source.mp3', {
    model: 'groq-whisper-large-v3', start: 10, duration: 51, apiKey: 'test-placeholder', forceFresh: true
  });
  assert.equal(requests, 3);
  assert.deepEqual(ffArgs.map(args => Number(args[args.indexOf('-t') + 1])), [26, 27, 2]);
  assert.deepEqual(Array.from(result.words, w => w.word), ['Эхлэл.', 'Зааг.', 'тийм', 'тийм', 'Дутуу', 'үг.', 'Төгсгөл.']);
  assert.equal(result.words[1].start, 34.6);
  assert.ok(result.words.every(w => w.start >= 10 && w.end <= 61 && w.end > w.start));
  assert.equal(result.segments.map(s => s.text).join(' '), result.words.map(w => w.word).join(' '));
});
