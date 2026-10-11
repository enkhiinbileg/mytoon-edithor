const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const ff = require('../electron/ffmpeg');

test('subtitle audio render retains source trims and absolute positions for audio and video', async () => {
  const output = path.resolve('.test-output/caption-render');
  fs.mkdirSync(output, { recursive: true });
  const source = path.join(output, 'synthetic.wav');
  await execFile(ff.FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', source], { windowsHide: true });
  for (const video of [false, true]) {
    const sound = start => ({ src: source, start, inPoint: start === 1 ? 2 : 0,
      outPoint: start === 1 ? 4 : 1, volume: 1, kind: 'av', hasAudio: true });
    const outPath = path.join(output, video ? 'video.mp3' : 'audio.mp3');
    await ff.exportTimeline({ clips: video ? [sound(1), sound(4)] : [],
      audio: video ? [] : [sound(1), sound(4)], duration: 6, format: 'mp3', outPath });
    const info = await ff.probe(outPath);
    assert.ok(Math.abs(info.duration - 6) < 0.1);
    const speech = await ff.detectSpeechSegments(outPath, { minSilence: 0.2, noise: '-40dB' });
    assert.equal(speech.length, 2);
    for (const [index, [start, end]] of [[1, 3], [4, 5]].entries()) {
      assert.ok(Math.abs(speech[index].start - start) < 0.1, JSON.stringify(speech));
      assert.ok(Math.abs(speech[index].end - end) < 0.1, JSON.stringify(speech));
    }
  }
});
