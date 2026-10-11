const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { reconcileRecognitionWords } = require('../electron/caption-timing');

function loadAlign(transcribe = async () => ({})) {
  const context = { module: { exports: {} }, console, require: name => ({
    'node:fs': { existsSync: () => true },
    './ffmpeg': { probe: async () => ({ duration: 20, hasAudio: true }) },
    './srt-parser': {},
    './whisper': { status: () => ({ available: true, models: [{ id: 'base', installed: true }] }), transcribe },
    './caption-timing': { reconcileRecognitionWords },
    './mongolian-text-fixer': { polishMongolianCaptionsWithAI: async segments => segments },
    './script-caption-match': require('../electron/script-caption-match')
  }[name] || require(name)) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../electron/audio-script-align'), 'utf8'), context);
  return context.module.exports;
}

const transcript = words => words.map(w => w.word).join(' ');
const captionText = captions => captions.map(c => c.text).join(' ');
const bounded = (words, duration) => words.every(w => Number.isFinite(w.start) && Number.isFinite(w.end)
  && w.start >= 0 && w.end > w.start && w.end <= duration);

test('partial word timestamps cannot discard complete recognized segments', async () => {
  const result = {
    segments: [{ start: 0, end: 3, text: 'First recognized sentence.' }, { start: 12, end: 18, text: 'Second recognized sentence.' }],
    words: [{ start: 0, end: 0.3, word: 'First' }]
  };
  const out = await loadAlign(async () => result).alignAudioWithScript({ audioPath: 'audio.mp3' });
  assert.equal(captionText(out.segments), 'First recognized sentence. Second recognized sentence.');
  assert.ok(out.segments.some(c => c.start === 12));
  assert.ok(out.segments.every(c => c.end <= 20));
});

test('zero-duration words recover between real neighboring anchors', () => {
  const words = reconcileRecognitionWords({
    segments: [{ start: 2, end: 6, text: 'First middle last.' }],
    words: [{ word: 'First', start: 2, end: 3 }, { word: 'middle', start: 3, end: 3 }, { word: 'last.', start: 5, end: 6 }]
  }, 10);
  assert.equal(transcript(words), 'First middle last.');
  assert.deepEqual(words.map(w => [w.start, w.end]), [[2, 3], [3, 5], [5, 6]]);
  assert.equal(words[1].timingSource, 'segment');
  assert.ok(bounded(words, 10));
});

test('all collapsed words recover inside the recognized segment only', () => {
  const words = reconcileRecognitionWords({
    segments: [{ start: 4, end: 8, text: 'Сайн байна уу.' }],
    words: ['Сайн', 'байна', 'уу.'].map(word => ({ word, start: 4, end: 4 }))
  }, 20);
  assert.equal(transcript(words), 'Сайн байна уу.');
  assert.equal(words[0].start, 4);
  assert.equal(words.at(-1).end, 8);
  assert.ok(bounded(words, 20));
});

test('missing word timing uses recognized segment text and respects media bounds', () => {
  const words = reconcileRecognitionWords({ segments: [{ start: -3, end: 12, text: 'Actual recognized speech.' }] }, 10);
  assert.equal(transcript(words), 'Actual recognized speech.');
  assert.equal(words[0].start, 0);
  assert.equal(words.at(-1).end, 10);
  assert.ok(bounded(words, 10));
});

test('complete reliable word timing remains unchanged and carries original segment indices', () => {
  const words = reconcileRecognitionWords({
    segments: [{ start: 8, end: 10, text: 'Later.' }, { start: 1, end: 4, text: 'First sentence.' }],
    words: [{ word: 'First', start: 1, end: 2 }, { word: 'sentence.', start: 2.5, end: 4 }, { word: 'Later.', start: 8, end: 10 }]
  }, 10);
  assert.deepEqual(words.map(w => [w.word, w.start, w.end, w.segmentIndex]), [
    ['First', 1, 2, 1], ['sentence.', 2.5, 4, 1], ['Later.', 8, 10, 0]
  ]);
});

test('long recognized words keep their speech timing in generated captions', () => {
  const captions = loadAlign().buildCapcutCaptionsFromWords([{ word: 'Уртүг.', start: 2, end: 7 }], 10);
  assert.equal(captions.length, 1);
  assert.equal(captions[0].start, 2);
  assert.equal(captions[0].end, 7.2);
});

test('word-only responses stay bounded and repeated spoken words are retained', () => {
  const words = reconcileRecognitionWords({ words: [
    { word: 'Үгүй', start: -1, end: 0.1 }, { word: 'үгүй.', start: 0.1, end: 0.2 },
    { word: 'Төгсгөл.', start: 9, end: 12 }, { word: 'Outside.', start: 12, end: 13 }
  ] }, 10);
  assert.equal(transcript(words), 'Үгүй үгүй. Төгсгөл.');
  assert.ok(bounded(words, 10));
});

test('empty recognition does not synthesize captions across audio', () => {
  assert.deepEqual(reconcileRecognitionWords({}, 20), []);
  assert.equal(loadAlign().buildCaptionsFromRecognition({}, 20).length, 0);
});

test('script captions forward a requested fresh recognition', async () => {
  let requested;
  await loadAlign(async (_path, options) => {
    requested = options;
    return { segments: [{ start: 1, end: 3, text: 'Сайн уу.' }] };
  }).alignAudioWithScript({ audioPath: 'audio.mp3', scriptText: 'Сайн уу.', mode: 'script_captions', forceFresh: true });
  assert.equal(requested.forceFresh, true);
});
