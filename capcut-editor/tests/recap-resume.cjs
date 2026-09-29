'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { geminiAlign } = require('../electron/recap-alignment');
const { createRecapGemini } = require('../electron/recap-gemini');
const reply = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const models = { models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] };

test('large prompts wait for a full token window with visible countdown', async () => {
  let clock = 0;
  const calls = [], updates = [];
  const client = await createRecapGemini({ apiKey: 'test', now: () => clock, wait: async ms => { assert.ok(ms <= 5000); clock += ms; }, progress: p => updates.push(p.message), fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return reply(models);
    calls.push(clock);
    return reply({ usageMetadata: { promptTokenCount: 125000 } });
  } });
  await client.generate('x'.repeat(378219));
  await client.generate('x'.repeat(378219));
  assert.deepEqual(calls, [0, 65000]);
  assert.ok(updates.some(p => p.includes('65 секунд')));
  assert.ok(updates.some(p => p.includes('5 секунд')));
});

test('server token count corrects conservative estimate for subsequent batches', async () => {
  let clock = 0;
  const calls = [];
  const client = await createRecapGemini({ apiKey: 'test', now: () => clock, wait: async ms => { clock += ms; }, fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return reply(models);
    calls.push(clock); return reply({ usageMetadata: { promptTokenCount: 50000 } });
  } });
  await client.generate('x'.repeat(378219)); await client.generate('x'.repeat(378219)); await client.generate('x'.repeat(378219));
  assert.deepEqual(calls, [0, 0, 65000]);
});

test('37 long-SRT batches stay under the reported 250k rolling minute quota', async () => {
  let clock = 0;
  const calls = [];
  const client = await createRecapGemini({ apiKey: 'test', now: () => clock, wait: async ms => { clock += ms; }, fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return reply(models);
    calls.push(clock);
    const inWindow = calls.filter(time => clock-time < 60000).length;
    assert.ok(inWindow * 126073 <= 250000, 'exceeded rolling token quota');
    return reply({ usageMetadata: { promptTokenCount: 126073 } });
  } });
  for (let i = 0; i < 37; i++) await client.generate('x'.repeat(378219));
  assert.equal(calls.length, 37);
  assert.equal(clock, 36 * 65000);
});

test('TPM 429 waits through reset and retries same model beyond old three-attempt cap', async () => {
  let clock = 0, posts = 0;
  const times = [];
  const client = await createRecapGemini({ apiKey: 'test', now: () => clock, wait: async ms => { clock += ms; }, fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return reply(models);
    times.push(clock);
    if (++posts < 4) return reply({ error: { message: 'Quota exceeded for metric: generate_content_free_tier_input_token_count, limit: 250000, model: gemini-3.8-flash Please retry in 18.804s.' } }, 429);
    return reply({ success: true });
  } });
  assert.deepEqual(await client.generate('test'), { success: true });
  assert.deepEqual(times, [0, 65000, 130000, 195000]);
});

test('interrupt, restart and input changes reuse only validated matching batches', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = { checkpointDir: root, apiKey: 'secret-fixture', videoDuration: 20, englishSrt: [{ id: 1, start: 0, end: 5, text: 'Hello.' }], captions: Array.from({ length: 65 }, (_, i) => ({ id: `c${i}`, start: i, inPoint: 0, outPoint: 1, style: { text: 'Сайн байна уу.' } })) };
  let fail = true;
  const posts = [];
  const fetchImpl = async (_url, options) => {
    if (options.method === 'GET') return reply(models);
    const prompt = JSON.parse(options.body).contents[0].parts[0].text;
    const batch = JSON.parse(prompt.split('\nMongolian: ')[1]);
    posts.push(batch[0].id);
    if (fail && batch[0].id === 32) return reply({ error: { message: 'Interrupted fixture' } }, 403);
    return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify({ matches: batch.map(c => ({ id: c.id, startId: 1, endId: 1, confidence: 0.9 })) }) }] } }] });
  };
  await assert.rejects(geminiAlign(spec, null, fetchImpl), /403/);
  fail = false;
  const result = await geminiAlign(spec, null, fetchImpl);
  assert.equal(result.alignments.length, 65);
  assert.deepEqual(posts, [0, 32, 32, 64]);
  // A fully completed job needs no API calls, including model discovery.
  await geminiAlign(spec, null, async () => assert.fail('cached run contacted API'));
  const files = fs.readdirSync(root, { recursive: true }).filter(n => n.endsWith('.json'));
  for (const file of files) assert.ok(!fs.readFileSync(path.join(root, file), 'utf8').includes('secret-fixture'));
  spec.captions[0].style.text = 'Өөр текст';
  posts.length = 0;
  await geminiAlign(spec, null, fetchImpl);
  assert.deepEqual(posts, [0, 32, 64]);
});

test('corrupt checkpoint safely recomputes batch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-checkpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createCheckpoint } = require('../electron/recap-checkpoint');
  const cache = createCheckpoint(root, { source: 'a' });
  cache.write('prompt', 'valid');
  assert.equal(cache.read('prompt'), 'valid');
  const file = fs.readdirSync(root, { recursive: true }).find(n => n.endsWith('.json'));
  fs.writeFileSync(path.join(root, file), '{"text":"corrupt","checksum":"wrong"}');
  assert.equal(cache.read('prompt'), null);
});
