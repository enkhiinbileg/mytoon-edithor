'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkTranscript, toSrtTimestamp } = require('../electron/recap-dub-pipeline');

test('toSrtTimestamp formats timestamps accurately', () => {
  assert.equal(toSrtTimestamp(0), '00:00:00,000');
  assert.equal(toSrtTimestamp(1.234), '00:00:01,234');
  assert.equal(toSrtTimestamp(65.5), '00:01:05,500');
  assert.equal(toSrtTimestamp(3661.009), '01:01:01,009');
});

test('chunkTranscript handles empty or null segments', () => {
  assert.deepEqual(chunkTranscript([]), []);
  assert.deepEqual(chunkTranscript(null), []);
  assert.deepEqual(chunkTranscript([{ start: 0, end: 0, text: '' }]), []);
});

test('chunkTranscript groups short segments into natural chunks', () => {
  const raw = [
    { start: 0, end: 1.2, text: 'In a world' },
    { start: 1.2, end: 2.5, text: 'full of mysteries,' },
    { start: 2.6, end: 4.8, text: 'one warrior appeared.' },
    { start: 5.5, end: 7.0, text: 'His name was Gungnir.' }
  ];

  const chunks = chunkTranscript(raw, 7.5, 2.5);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].srcStart, 0);
  assert.equal(chunks[0].srcEnd, 4.8);
  assert.equal(chunks[0].text, 'In a world full of mysteries, one warrior appeared.');

  assert.equal(chunks[1].srcStart, 5.5);
  assert.equal(chunks[1].srcEnd, 7.0);
  assert.equal(chunks[1].text, 'His name was Gungnir.');
});

test('chunkTranscript respects maxDuration', () => {
  const raw = [];
  for (let i = 0; i < 20; i++) {
    raw.push({ start: i * 1.0, end: (i + 1) * 1.0, text: `Word${i}` });
  }

  const chunks = chunkTranscript(raw, 5.0, 2.0);
  for (const c of chunks) {
    assert.ok(c.srcEnd - c.srcStart <= 5.5, `Chunk duration ${c.srcEnd - c.srcStart} should be <= 5.5s`);
  }
});
