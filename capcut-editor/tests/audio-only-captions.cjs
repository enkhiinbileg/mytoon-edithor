const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function load(transcribe, installed = true) {
 const context = { module: { exports: {} }, console, require: name => ({
  'node:fs': { existsSync: () => true },
  './ffmpeg': { probe: async () => ({ duration: 10, hasAudio: true }), detectSpeechSegments: () => { throw new Error('No silence fallback allowed'); } },
  './srt-parser': {},
  './whisper': { status: () => ({ available: true, models: [{ id: 'base', installed }] }), transcribe }
 }[name] || require(name)) };
 vm.runInNewContext(fs.readFileSync(require.resolve('../electron/audio-script-align'), 'utf8'), context);
 return context.module.exports.alignAudioWithScript;
}
test('empty script transcribes Mongolian speech and bounds timestamps', async () => {
 const align = load(async (_path, options) => {
  assert.equal(options.language, 'mn');
  assert.equal(options.quality, true);
  return { segments: [{ start: -1, end: 3, text: ' Сайн байна уу. ' }, { start: 8, end: 12, text: 'Төгсгөл.' }] };
 });
 const result = await align({ audioPath: 'audio.mp3', scriptText: '', useWhisper: true });
 assert.equal(result.segments[0].text, 'Сайн байна уу.');
 assert.equal(result.segments[0].start, 0); assert.equal(result.segments[1].duration, 2);
});
test('missing model, failed recognition and empty recognition never produce fake captions', async () => {
 await assert.rejects(load(async () => ({}), false)({ audioPath: 'audio.mp3' }), /Whisper/);
 await assert.rejects(load(async () => { throw new Error('Should not select base silently'); })({ audioPath: 'audio.mp3', whisperModel: 'large-v3-turbo' }), /Whisper/);
 await assert.rejects(load(async () => { throw new Error('Recognition failed'); })({ audioPath: 'audio.mp3' }), /Recognition failed/);
 await assert.rejects(load(async () => ({ segments: [] }))({ audioPath: 'audio.mp3' }), /яриа танигдсангүй/);
});
