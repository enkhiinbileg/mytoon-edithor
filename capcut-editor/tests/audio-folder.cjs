const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { scanAudioFolder, mergeAudioFolder } = require('../electron/voice-recovery');
test('folder merge uses numeric filename order and decodes mixed formats with quoted paths', async () => {
 const root = path.resolve('.test-output'); await fs.mkdir(root, { recursive: true });
 const dir = await fs.mkdtemp(path.join(root, "folder's-audio-"));
 const ff = require('../electron/ffmpeg');
 for (const [name, rate, freq] of [['part10.mp3', '44100', '1000'], ['part2.wav', '48000', '600'], ['part1.mp3', '22050', '300']]) {
  await ff.run(ff.FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=0.4`, '-ar', rate, path.join(dir, name)]);
 }
 await fs.writeFile(path.join(dir, 'ignore.txt'), 'not audio');
 const scan = await scanAudioFolder(dir);
 assert.deepEqual(scan.parts.map(p => p.name), ['part1.mp3', 'part2.wav', 'part10.mp3']);
 await assert.rejects(mergeAudioFolder({ dir, token: scan.token, output: path.join(dir, 'part1.mp3') }, ff), /Эх аудио/);
 const output = path.join(dir, 'combined.mp3');
 const result = await mergeAudioFolder({ dir, token: scan.token, output }, ff);
 assert.equal(result.count, 3); assert.ok(result.duration > 1.1 && result.duration < 1.5);
 await assert.rejects(mergeAudioFolder({ dir, token: scan.token, output }, ff), /өөрчлөгдсөн/);
});
