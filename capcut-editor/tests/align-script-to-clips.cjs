'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const source = fs.readFileSync(require.resolve('../src/alignScriptToClips.ts'), 'utf8');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
const { alignScriptToClips } = context.exports;
const clip = (id, text, start) => ({ id, style: { text, fontSize: 36 }, start, inPoint: 0, outPoint: 4 });
const texts = result => Array.from(result.updatedClips, c => c.style.text);

test('script correction does not accumulate lag after 29 minutes when captions exceed six words', () => {
  const clips = Array.from({ length: 480 }, (_, i) => clip(String(i),
    Array.from({ length: i < 348 ? 6 : 9 }, (_, j) => `үг${i}x${j}`).join(' '), i * 5));
  const result = alignScriptToClips(clips.map(c => c.style.text).join(' '), clips, { mode: 'full' });
  assert.deepEqual(texts(result), clips.map(c => c.style.text));
  assert.deepEqual(Array.from(result.updatedClips, c => [c.start, c.inPoint, c.outPoint]), clips.map(c => [c.start, c.inPoint, c.outPoint]));
});

test('missing words between anchors in one caption never cross a later time boundary', () => {
  const words = ['Эхлэл', ...Array.from({ length: 13 }, (_, i) => `засвар${i}`), 'Төгсгөл.'];
  const script = words.join(' ') + ' Дараагийн өгүүлбэр.';
  const clips = [clip('a', 'Эхлэл буруу Төгсгөл.', 1740), clip('b', 'Дараагийн өгүүлбэр.', 1745)];
  const result = alignScriptToClips(script, clips, { mode: 'full' });
  assert.deepEqual(texts(result), [words.join(' '), 'Дараагийн өгүүлбэр.']);
});

test('script words at the end are never dropped to satisfy a display word limit', () => {
  const text = 'Энэ бол хамгийн сүүлчийн урт өгүүлбэр бөгөөд үг бүр нь хадгалагдана.';
  assert.deepEqual(texts(alignScriptToClips(text, [clip('last', text, 2395)], { mode: 'full' })), [text]);
});

test('correction keeps spoken words in their original slots instead of reflowing sentence endings', () => {
  const clips = [clip('a', 'Тэр гэртээ', 1740), clip('b', 'ирлээ. Дараагийн өдөр.', 1745)];
  const result = alignScriptToClips('Тэр гэртээ ирлээ. Дараагийн өдөр.', clips, { mode: 'full' });
  assert.deepEqual(texts(result), clips.map(c => c.style.text));
});

test('a selected correction cannot move words into an untouched neighboring caption', () => {
  const clips = [clip('a', 'Тэр гэртээ', 1735), clip('b', 'ирлээ. Өнөөдөр сайхан өдөр.', 1740), clip('c', 'Дараагийн өгүүлбэр.', 1745)];
  const result = alignScriptToClips(clips[1].style.text, clips, { mode: 'selected', selectedClipId: 'b' });
  assert.deepEqual(texts(result), clips.map(c => c.style.text));
});

test('unassigned ASR text is not copied back into the corrected script', () => {
  const clips = [clip('a', 'Эхлэл байна', 0), clip('noise', 'танигчийн хийсвэр өгүүлбэр', 5), clip('b', 'Сүүлчийн хэсэг.', 10)];
  const result = alignScriptToClips('Эхлэл байна Сүүлчийн хэсэг.', clips, { mode: 'full' });
  assert.equal(texts(result).join(' ').replace(/\s+/g, ' '), 'Эхлэл байна Сүүлчийн хэсэг.');
});

test('unrelated script fails without distributing arbitrary words over the entire timeline', () => {
  const clips = [clip('a', 'Ногоон мод', 0), clip('b', 'Өндөр уул.', 5)];
  assert.throws(() => alignScriptToClips('Спортын тэмцээнд түрүүлэв.', clips, { mode: 'full' }), /таарахгүй/);
});
