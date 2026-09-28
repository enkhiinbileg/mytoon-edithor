'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { responseError, classifyError } = require('../electron/elevenlabs-errors');

function loadPool(speak, count = 2, status = 'ready') {
 const updates = [], calls = [];
 let clock = 0;
 class TestDate extends Date { static now() { return clock += 30000; } }
 const context = { module: { exports: {} }, process, AbortController, AbortSignal, Date: TestDate, setTimeout: fn => setTimeout(fn, 0),
  fetch: async () => ({ ok: true, json: async () => ({ user_id: 'test-user', subscription: { character_count: 1000, character_limit: 10000 } }) }),
  require: name => ({
   './settings': { getKeyPoolPublic: () => [], getKeyPoolDecrypted: () => Array.from({ length: count }, (_, i) => ({ id: `key${i}`, apiKey: `test-${i}`, label: `Key ${i}`, enabled: true, status })),
    updateKeyPoolQuota: (...args) => updates.push(args) },
   './tts': { speakWithTimestamps: async (_provider, options) => { calls.push(options); return speak(options, calls.length); } },
   './ffmpeg': { probe: async () => ({ duration: 1 }) },
   './elevenlabs-errors': { classifyError },
   './tts-part-cache': require('../electron/tts-part-cache'),
   'node:fs': { existsSync: () => true },
  }[name] || require(name)) };
 vm.runInNewContext(fs.readFileSync(require.resolve('../electron/elevenlabs-pool'), 'utf8'), context);
 return { pool: context.module.exports, updates, calls };
}

test('TTS request preserves the actual provider error without making a network call', async () => {
 const original = global.fetch;
 global.fetch = async () => ({ ok: false, status: 401, headers: { get: () => null },
  json: async () => ({ detail: { status: 'missing_permissions', message: 'Text to speech permission is missing' } }) });
 try {
  await assert.rejects(require('../electron/tts-elevenlabs').listVoices({ apiKey: 'test-only' }), error => {
   assert.equal(error.status, 401); assert.equal(error.code, 'missing_permissions');
   assert.equal(classifyError(error), 'terminal'); assert.match(error.message, /permission is missing/); return true;
  });
 } finally { global.fetch = original; }
});

test('401/402 preserve service reason and only quota_exceeded means insufficient credits', () => {
 for (const [status, code, kind] of [[401, 'missing_permissions', 'terminal'], [401, 'detected_unusual_activity', 'terminal'],
  [402, 'payment_required', 'terminal'], [401, 'invalid_api_key', 'terminal'], [401, 'quota_exceeded', 'quota'],
  [429, 'too_many_concurrent_requests', 'rate']]) {
  const error = responseError(status, { detail: { status: code, message: 'Provider detail retained' } }, '3');
  assert.equal(error.code, code); assert.equal(classifyError(error), kind);
  assert.match(error.message, /Provider detail retained/); assert.equal(error.retryAfterMs, 3000);
 }
 assert.equal(classifyError(responseError(401, null, null)), 'terminal');
});

test('permission, voice restrictions and abuse blocks stop without marking credits exhausted or rotating keys', async () => {
 for (const [status, code] of [[401, 'missing_permissions'], [402, 'payment_required'], [401, 'detected_unusual_activity']]) {
  const { pool, updates, calls } = loadPool(async () => { throw responseError(status, { detail: { status: code, message: 'Real cause' } }); });
  await assert.rejects(pool.dispatchPoolTTS({ chunks: ['Монгол текст'], outDir: '/test' }), /Real cause/);
  assert.equal(updates.length, 1); assert.equal(updates[0][1], null);
  assert.equal(updates[0][2], code === 'detected_unusual_activity' ? 'blocked' : 'error');
  assert.equal(calls.length, 1);
 }
});

test('actual insufficient quota fails over and preserves chunk order', async () => {
 const { pool, updates } = loadPool(async options => {
  if (options.apiKey === 'test-0') throw responseError(401, { detail: { status: 'quota_exceeded', message: 'Insufficient credits for this request' } });
  return { duration: 1, sentences: [] };
 });
 const result = await pool.dispatchPoolTTS({ chunks: ['Нэг.', 'Хоёр.'], outDir: '/test' });
 assert.deepEqual(Array.from(result, r => r.pIdx), [0, 1]);
 assert.ok(updates.some(args => args[0] === 'key0' && args[2] === 'insufficient'));
 assert.ok(!updates.some(args => args[2] === 'exhausted'), 'A rejected chunk does not prove a zero balance');
});

test('persistent rate limits have a finite retry budget and never erase credits', async () => {
 const { pool, updates, calls } = loadPool(async () => { throw responseError(429, { detail: { status: 'rate_limit_exceeded', message: 'Wait' } }, '1'); }, 1);
 await assert.rejects(pool.dispatchPoolTTS({ chunks: ['Текст'], outDir: '/test' }), /олон удаа/);
 assert.equal(calls.length, 4); assert.equal(updates.length, 0);
});

test('fatal error aborts in-flight tasks and drains runners before returning', async () => {
 let aborted = false;
 const { pool, calls } = loadPool(async options => {
  if (options.apiKey === 'test-0') throw responseError(401, { detail: { status: 'missing_permissions', message: 'No TTS permission' } });
  return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); }, { once: true }));
 });
 await assert.rejects(pool.dispatchPoolTTS({ chunks: ['Нэг', 'Хоёр', 'Гурав'], outDir: '/test' }), /No TTS permission/);
 assert.equal(calls.length, 2); assert.equal(aborted, true);
});

test('refreshing a positive balance does not falsely clear an API block', async () => {
 const { pool, updates } = loadPool(async () => ({}), 1, 'blocked');
 await pool.refreshAllQuotas();
 assert.equal(updates[0][1].remaining, 9000); assert.equal(updates[0][2], 'blocked');
});

test('a partial failure resumes only missing audio, in order, across a new dispatcher', async () => {
 const path = require('node:path');
 const root = path.resolve(__dirname, '../.test-output'); fs.mkdirSync(root, { recursive: true });
 const outDir = fs.mkdtempSync(path.join(root, 'tts-resume-'));
 const chunks = ['Эхний хэсэг.', 'Хоёр дахь хэсэг.'];
 const first = loadPool(async options => {
  if (options.text === chunks[1]) throw responseError(401, { detail: { status: 'quota_exceeded', message: 'Only 309 credits remain' } });
  fs.writeFileSync(options.file, 'fake-audio-for-test'); return { duration: 1, sentences: [] };
 }, 1);
 await assert.rejects(first.pool.dispatchPoolTTS({ chunks, outDir, resume: true }), error => {
  assert.match(error.message, /309/); assert.match(error.message, /1\/2 хэсэг хадгалагдсан/); return true;
 });
 const second = loadPool(async options => {
  fs.writeFileSync(options.file, 'second-fake-audio'); return { duration: 1, sentences: [] };
 }, 1);
 const results = await second.pool.dispatchPoolTTS({ chunks, outDir, resume: true });
 assert.equal(second.calls.length, 1); assert.equal(second.calls[0].text, chunks[1]);
 assert.deepEqual(Array.from(results, r => r.pIdx), [0, 1]);
 assert.equal(results[0].partSentences[0].text, chunks[0]);
 const third = loadPool(async () => { throw new Error('Must not synthesize cached audio'); }, 1);
 await third.pool.dispatchPoolTTS({ chunks, outDir, resume: true });
 assert.equal(third.calls.length, 0);
});

test('changed voice/settings/text and corrupt audio cannot reuse an old cache entry', async () => {
 const path = require('node:path');
 const root = path.resolve(__dirname, '../.test-output'); fs.mkdirSync(root, { recursive: true });
 const outDir = fs.mkdtempSync(path.join(root, 'tts-cache-'));
 const { createPartCache } = require('../electron/tts-part-cache');
 const options = { voiceId: 'voice', modelId: 'model', speed: 1, stability: .5, similarity: .75 };
 const cache = createPartCache(outDir, options), audio = path.join(outDir, 'audio.mp3');
 fs.writeFileSync(audio, 'valid-test-bytes');
 await cache.write('Текст', { partAudioFile: audio, partDuration: 2, partSentences: [] });
 assert.ok(await cache.read('Текст'));
 for (const change of [{ voiceId: 'other' }, { modelId: 'other' }, { speed: 1.1 }, { stability: .7 }, { similarity: .8 }]) {
  assert.equal(await createPartCache(outDir, { ...options, ...change }).read('Текст'), null);
 }
 assert.equal(await cache.read('Өөр текст'), null);
 fs.writeFileSync(audio, 'corrupt'); assert.equal(await cache.read('Текст'), null);
});
