'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const wave = require('./helpers/pcm-wave.cjs');
const { readWaveActivity, assessRecognition, recognizeWithRecovery } = require('../electron/recognition-quality');

function spoken(duration, offset = 0) {
  return { words: Array.from({ length: Math.floor(duration * 2) }, (_, i) => ({
    word: `үг${offset + i}`, start: i / 2, end: i / 2 + 0.4
  })) };
}

const screenshotResponse = {
  words: ['Тэрээлгээд', 'хэл', 'байдлээр', 'хэл', 'байдлээр.'].map((word, i) => ({
    word, start: i === 0 ? 26.72 : 27.42 + i * 0.02, end: 27.44 + i * 0.02
  })),
  segments: [{ start: 0, end: 27, text: 'Тэрээлгээд хэл байдлээр хэл байдлээр.', no_speech_prob: 0.000658 }]
};

test('27-second screenshot failure is rejected before segment text can be stretched', () => {
  const issues = assessRecognition(screenshotResponse, readWaveActivity(wave(27)));
  assert.ok(issues.includes('invalid word timestamps'));
  assert.ok(issues.includes('too little text for active audio'));
});

test('silence never reaches the external recognizer or produces hallucinated words', async () => {
  const result = await recognizeWithRecovery({ start: 2402, duration: 27 }, {
    readAudio: async () => wave(27, []), recognize: () => assert.fail('Silence must not be uploaded')
  });
  assert.deepEqual(result, []);
});

test('short speech surrounded by silence stays intact without false sparse-text rejection', async () => {
  const words = [{ word: 'Сайн', start: 20, end: 20.5 }, { word: 'байна', start: 20.5, end: 21 }, { word: 'уу.', start: 21, end: 21.5 }];
  const result = await recognizeWithRecovery({ start: 0, duration: 27 }, {
    readAudio: async () => wave(27, [[20, 21.5]]), recognize: async () => ({ words }), onRetry: () => assert.fail('Valid sparse speech')
  });
  assert.deepEqual(result.map(w => w.word), words.map(w => w.word));
  assert.equal(result[0].start, 20);
});

test('retry repairs the screenshot failure with real recognition words and bounded timings', async () => {
  const calls = [], retries = [];
  const chunk = { start: 1349, duration: 27, coreStart: 1350, coreEnd: 1375 };
  const result = await recognizeWithRecovery(chunk, {
    readAudio: async c => wave(c.duration),
    recognize: async c => { calls.push(c); return calls.length === 1 ? screenshotResponse : spoken(c.duration, Math.floor(c.start * 2)); },
    onRetry: c => retries.push(c)
  });
  assert.equal(calls.length, 5);
  assert.equal(retries.length, 1);
  assert.ok(calls.slice(1).every(c => c.duration <= 8.7));
  assert.ok(result.length >= 50);
  assert.ok(result.every(w => w.start >= 0 && w.end <= 27 && w.end > w.start));
  assert.ok(result.every(w => !w.word.includes('байдлээр')));
});

test('persistent failures have a bounded retry count and identify the failing absolute time', async () => {
  let requests = 0;
  await assert.rejects(recognizeWithRecovery({ start: 1350, duration: 27 }, {
    readAudio: async c => wave(c.duration), recognize: async () => { requests++; return screenshotResponse; }
  }), /22:30–22:34.*найдвартай танигдсангүй/);
  assert.equal(requests, 3);
});

test('cancellation during retry stops additional requests and cannot return a partial transcript', async () => {
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(recognizeWithRecovery({ start: 0, duration: 27 }, {
    signal: controller.signal, readAudio: async c => wave(c.duration),
    recognize: async () => { requests++; return screenshotResponse; }, onRetry: () => controller.abort()
  }), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('missing words can still be recovered from valid segment text', async () => {
  const result = await recognizeWithRecovery({ start: 0, duration: 5 }, {
    readAudio: async () => wave(5), recognize: async () => ({
      words: [{ word: 'Сайн', start: 0, end: 0.5 }],
      segments: [{ text: 'Сайн байна уу. Өнөөдөр сайхан өдөр байна.', start: 0, end: 5 }]
    }), onRetry: () => assert.fail('Segment fallback remains supported')
  });
  assert.equal(result.map(w => w.word).join(' '), 'Сайн байна уу. Өнөөдөр сайхан өдөр байна.');
});

test('an empty response cannot silently erase a short audible utterance', async () => {
  await assert.rejects(recognizeWithRecovery({ start: 20, duration: 2 }, {
    readAudio: async () => wave(2), recognize: async () => ({ words: [], segments: [] })
  }), /0:20–0:22.*найдвартай танигдсангүй/);
});

test('active gaps and long repetitive hallucinations are retried; short genuine repetition survives', () => {
  const active = readWaveActivity(wave(15));
  assert.ok(assessRecognition({ words: [...spoken(5).words, { word: 'Төгсгөл.', start: 14, end: 15 }] }, active).includes('active audio missing from transcript'));
  assert.ok(assessRecognition({ segments: [{ start: 0, end: 15, text: 'Хэл дээрх хэл дээрх хэл дээрх.' }] }, active).includes('repetitive transcript'));
  assert.deepEqual(assessRecognition({ words: [{ word: 'тийм', start: 0, end: 0.4 }, { word: 'тийм', start: 0.5, end: 0.9 }] }, readWaveActivity(wave(1))), []);
});

test('PCM parser handles metadata chunks and rejects compressed/malformed audio', () => {
  const raw = wave(2, [[1, 2]]);
  const metadata = Buffer.from('JUNK\u0004\u0000\u0000\u0000abcd', 'ascii');
  const extended = Buffer.concat([raw.subarray(0, 36), metadata, raw.subarray(36)]);
  extended.writeUInt32LE(extended.length - 8, 4);
  assert.equal(readWaveActivity(extended).activeSeconds, 1);
  assert.equal(readWaveActivity(extended).duration, 2);
  assert.throws(() => readWaveActivity(Buffer.from('bad')), /PCM WAV/);
});
