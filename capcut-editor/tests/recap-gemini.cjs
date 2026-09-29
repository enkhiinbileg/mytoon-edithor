'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRecapGemini } = require('../electron/recap-gemini');
const { geminiAlign } = require('../electron/recap-alignment');
const entry = name => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] });
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });

test('discovers paginated text models, skips stale default and special-purpose models, reuses working model', async () => {
  const calls = [];
  const client = await createRecapGemini({ apiKey: 'secret-test', model: 'gemini-retired-flash', fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers['x-goog-api-key'], 'secret-test');
    assert.ok(!url.includes('secret-test'));
    if (options.method === 'GET') return response(url.includes('pageToken=next')
      ? { models: [entry('gemini-99-flash'), entry('gemini-98-flash')] }
      : { models: [entry('gemini-100-flash-image'), entry('gemini-100-flash-tts'), { name: 'models/gemini-100-flash', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next' });
    if (url.includes('gemini-99-flash:')) return response({ error: { message: 'Model no longer available' } }, 404);
    assert.ok(url.includes('gemini-98-flash:'));
    return response({ success: true });
  } });
  assert.deepEqual(await client.generate('batch 1'), { success: true });
  assert.deepEqual(await client.generate('batch 2'), { success: true });
  assert.equal(calls.filter(url => url.includes('gemini-99-flash:')).length, 1);
  assert.equal(calls.filter(url => url.includes('gemini-98-flash:')).length, 2);
  assert.ok(!calls.some(url => url.includes('retired')));
});

test('honors selected model including models/ prefix and older versions', async () => {
  const client = await createRecapGemini({ apiKey: 'key', model: ' models/gemini-2.5-flash ', fetchImpl: async (url, options) => {
    if (options.method === 'GET') return response({ models: [entry('gemini-99-flash'), entry('gemini-2.5-flash')] });
    assert.ok(url.includes('/gemini-2.5-flash:'));
    return response({ ok: true });
  } });
  await client.generate('test');
});

test('bulk Auto-Cut prefers the latest discovered stable Flash Lite over regular Flash', async () => {
  const posts = [];
  const client = await createRecapGemini({ apiKey: 'key', fetchImpl: async (url, options) => {
    if (options.method === 'GET') return response({ models: [
      'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-3.6-flash',
      'gemini-2.5-flash-tts', 'gemini-3.5-flash', 'gemini-3.7-flash',
      'gemini-3.5-flash-lite', 'gemini-99-flash-lite-preview'
    ].map(entry) });
    posts.push(url);
    assert.ok(url.includes('/gemini-3.5-flash-lite:'));
    return response({ success: true });
  } });
  await client.generate('first batch'); await client.generate('next batch');
  assert.equal(posts.length, 2);
});

test('an explicit regular Flash choice is honored even when Lite is available', async () => {
  const client = await createRecapGemini({ apiKey: 'key', model: 'gemini-3.8-flash', fetchImpl: async (url, options) => {
    if (options.method === 'GET') return response({ models: [entry('gemini-3.8-flash'), entry('gemini-3.5-flash-lite')] });
    assert.ok(url.includes('/gemini-3.8-flash:'));
    return response({ success: true });
  } });
  await client.generate('test');
});

test('unavailable latest Lite falls back to discovered older Lite before regular Flash', async () => {
  const posts = [];
  const client = await createRecapGemini({ apiKey: 'key', fetchImpl: async (url, options) => {
    if (options.method === 'GET') return response({ models: [entry('gemini-3.8-flash'), entry('gemini-3.1-flash-lite'), entry('gemini-3.5-flash-lite')] });
    posts.push(url);
    if (url.includes('/gemini-3.5-flash-lite:')) return response({}, 404);
    assert.ok(url.includes('/gemini-3.1-flash-lite:'));
    return response({ success: true });
  } });
  await client.generate('test');
  assert.equal(posts.length, 2);
});

for (const status of [400, 403, 429, 503]) test(`HTTP ${status} preserves details and never changes model`, async () => {
  let posts = 0, waited = 0;
  const client = await createRecapGemini({ apiKey: 'test-secret', wait: async ms => { waited += ms; }, fetchImpl: async (url, options) => {
    if (options.method === 'GET') return response({ models: [entry('gemini-99-flash'), entry('gemini-98-flash')] });
    posts++;
    assert.ok(url.includes('gemini-99-flash:'));
    return response({ error: { message: 'Specific reason test-secret' } }, status);
  } });
  await assert.rejects(client.generate('test'), error => {
    assert.match(error.message, new RegExp(`HTTP ${status}`));
    assert.match(error.message, /Specific reason \[redacted\]/);
    return true;
  });
  assert.equal(posts, status >= 429 ? 3 : 1);
  assert.equal(waited, status === 429 ? 90000 : status === 503 ? 4500 : 0);
});

test('all discovered models returning 404 reports actual server detail', async () => {
  const client = await createRecapGemini({ apiKey: 'key', fetchImpl: async (_url, options) => options.method === 'GET'
    ? response({ models: [entry('gemini-99-flash')] })
    : response({ error: { message: 'Unavailable for this project' } }, 404) });
  await assert.rejects(client.generate('test'), /HTTP 404.*Unavailable for this project/);
});

test('large alignment discovers once and stops requesting a missing model after first batch', async () => {
  let lists = 0, missing = 0, posts = 0;
  const captions = Array.from({ length: 129 }, (_, i) => ({ id: `c${i}`, start: i, inPoint: 0, outPoint: 1, style: { text: 'Сайн байна уу.' } }));
  const result = await geminiAlign({ captions, englishSrt: [{ id: 1, start: 0, end: 2, text: 'Hello.' }], videoDuration: 5, apiKey: 'key' }, null, async (url, options) => {
    if (options.method === 'GET') { lists++; return response({ models: [entry('gemini-99-flash'), entry('gemini-98-flash')] }); }
    if (url.includes('gemini-99-flash:')) { missing++; return response({}, 404); }
    posts++;
    const prompt = JSON.parse(options.body).contents[0].parts[0].text;
    const batch = JSON.parse(prompt.split('\nMongolian: ')[1]);
    return response({ candidates: [{ content: { parts: [{ text: JSON.stringify({ matches: batch.map(c => ({ id: c.id, startId: 1, endId: 1, confidence: 0.95 })) }) }] } }] });
  });
  assert.equal(result.alignments.length, 129);
  assert.equal(lists, 1); assert.equal(missing, 1); assert.equal(posts, 5);
  assert.deepEqual(result.alignments.map(c => c.captionId), captions.map(c => c.id));
});

test('numbered stable text Flash sorts ahead of omni, aliases and previews', async () => {
  const client = await createRecapGemini({ apiKey: 'key', fetchImpl: async (url, options) => {
    if (options.method === 'GET') return response({ models: ['gemini-omni-1.1-flash', 'gemini-flash-latest', 'gemini-99-flash-preview', 'gemini-3.8-flash', 'gemini-3.6-flash'].map(entry) });
    assert.ok(url.includes('/gemini-3.8-flash:'));
    return response({ success: true });
  } });
  await client.generate('test');
});

for (const structured of [false, true]) test(`zero model quota falls back without sleeping (${structured ? 'structured' : 'message'})`, async () => {
  const posts = [], waits = [];
  const client = await createRecapGemini({ apiKey: 'key', wait: async ms => waits.push(ms), fetchImpl: async (url, options) => {
    if (options.method === 'GET') return response({ models: [entry('gemini-99-flash'), entry('gemini-98-flash')] });
    posts.push(url);
    if (url.includes('gemini-99-flash:')) return response({ error: structured
      ? { message: 'Quota exhausted', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaValue: '0', quotaDimensions: { model: 'gemini-99-flash' } }] }, { retryDelay: '22.772s' }] }
      : { message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-99-flash. Please retry in 22.772s.' }
    }, 429);
    return response({ success: true });
  } });
  await client.generate('one'); await client.generate('two');
  assert.equal(posts.filter(url => url.includes('gemini-99-flash:')).length, 1);
  assert.equal(posts.filter(url => url.includes('gemini-98-flash:')).length, 2);
  assert.deepEqual(waits, []);
});

for (const source of ['detail', 'header', 'message']) test(`temporary 429 honors ${source} retry delay on same model`, async () => {
  let posts = 0;
  const waits = [];
  const client = await createRecapGemini({ apiKey: 'key', wait: async ms => waits.push(ms), fetchImpl: async (url, options) => {
    if (options.method === 'GET') return response({ models: [entry('gemini-99-flash'), entry('gemini-98-flash')] });
    assert.ok(url.includes('gemini-99-flash:'));
    if (++posts === 1) {
      const res = response({ error: { message: source === 'message' ? 'Please retry in 45.25s.' : 'RPM exceeded', details: source === 'detail' ? [{ retryDelay: '45.25s' }] : [] } }, 429);
      if (source === 'header') res.headers = new Headers({ 'retry-after': '45.25' });
      return res;
    }
    return response({ success: true });
  } });
  await client.generate('test');
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 45250); assert.ok(waits.every(ms => ms <= 5000)); assert.equal(posts, 2);
});

test('all zero quotas show actionable error without trying forever or hiding behind 404', async () => {
  let posts = 0;
  const client = await createRecapGemini({ apiKey: 'key', wait: async () => assert.fail('must not wait'), fetchImpl: async (url, options) => {
    if (options.method === 'GET') return response({ models: [entry('gemini-99-flash'), entry('gemini-98-flash')] });
    posts++;
    return url.includes('gemini-99-flash:') ? response({ error: { message: 'limit: 0, model: gemini-99-flash' } }, 429) : response({}, 404);
  } });
  await assert.rejects(client.generate('test'), /HTTP 429.*quota 0.*AI Studio/);
  assert.equal(posts, 2);
});

test('daily nonzero quota exhaustion stops without retries or model switching', async () => {
  let posts = 0;
  const client = await createRecapGemini({ apiKey: 'key', wait: async () => assert.fail('must not wait'), fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return response({ models: [entry('gemini-99-flash'), entry('gemini-98-flash')] });
    posts++;
    return response({ error: { message: 'Quota exhausted', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20', quotaDimensions: { model: 'gemini-99-flash' } }] }, { retryDelay: '22s' }] } }, 429);
  } });
  await assert.rejects(client.generate('test'), /өдрийн quota/);
  assert.equal(posts, 1);
});

test('long server cooldown fails instead of retrying too early', async () => {
  let posts = 0;
  const client = await createRecapGemini({ apiKey: 'key', wait: async () => assert.fail('must not wait'), fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return response({ models: [entry('gemini-99-flash')] });
    posts++;
    return response({ error: { message: 'Please retry in 300s.' } }, 429);
  } });
  await assert.rejects(client.generate('test'), /300s/); assert.equal(posts, 1);
});
