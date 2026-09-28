const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchScript } = require('../electron/script-caption-match');
test('preserves script punctuation and uses speech anchors across pauses', () => {
 const script = ['Сайн байна уу!', 'Тэр гэртээ ирлээ.'];
 const result = matchScript(script, [{ text: 'сайн байна уу', start: 2, end: 5 }, { text: 'тэр гэртээ ирлээ', start: 9, end: 12 }], 15);
 assert.deepEqual(result.map(r => r.text), script);
 assert.equal(result[0].start, 2); assert.equal(result[0].end, 5); assert.equal(result[1].start, 9);
});
test('wrong or missing narration fails instead of stretching the script across the audio', () => {
 assert.throws(() => matchScript(['Тэр гэртээ ирлээ.'], [{ text: 'Өөр өгүүлэмж ярьж байна', start: 0, end: 5 }], 5), /Өгүүлбэр 1/);
 assert.throws(() => matchScript(['Сайн байна уу!', 'Тэр гэртээ ирлээ.'], [{ text: 'сайн байна уу', start: 0, end: 3 }], 10), /Өгүүлбэр 2/);
});
test('repeated sentences retain their chronological occurrences', () => {
 const r = matchScript(['Сайн уу.', 'Сайн уу.'], [{ text: 'сайн уу сайн уу', start: 0, end: 4 }], 4);
 assert.equal(r[0].end, 2); assert.equal(r[1].start, 2);
});
