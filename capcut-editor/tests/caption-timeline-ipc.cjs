'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ff = require('../electron/ffmpeg');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.test-output');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'caption-real-ipc-'));
const sourceAudio = path.join(profile, 'synthetic.wav');
const sourceVideo = path.join(profile, 'synthetic.mp4');
const sampleRate = 48000, seconds = 6;
const wav = Buffer.alloc(44 + sampleRate * 2 * seconds);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
// Only source seconds 2..4 contain sound, so ignoring the inPoint produces silence.
for (let sample = sampleRate * 2; sample < sampleRate * 4; sample++) {
  wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * sample / sampleRate) * 12000), 44 + sample * 2);
}
fs.writeFileSync(sourceAudio, wav);

(async () => {
  await execFile(ff.FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=24', '-i', sourceAudio,
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourceVideo
  ], { windowsHide: true });

  const packaged = Boolean(process.env.CUTLINE_TEST_PACKAGED);
  const app = await _electron.launch({
    executablePath: path.join(root, packaged ? 'release/Cutline/Cutline.exe' : 'node_modules/electron/dist/electron.exe'),
    args: packaged ? [] : [root], cwd: root,
    env: { ...process.env, CUTLINE_TEST_DIR: profile }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.api?.renderTimelineSpeech === 'function');
    // Keep the real preload, IPC handler, temporary-file path and FFmpeg execution.
    // No speech recognition, API keys or external service is used in this test.
    for (const [kind, source] of [['audio', sourceAudio], ['video', sourceVideo]]) {
      const clip = (start, inPoint, outPoint) => ({ src: source, start, inPoint, outPoint, kind: 'av', hasAudio: true, volume: 1 });
      const sounds = [clip(1, 2, 4), clip(4, 2, 3)];
      const result = await page.evaluate(spec => window.api.renderTimelineSpeech(spec), {
        clips: kind === 'video' ? sounds : [], audio: kind === 'audio' ? sounds : [], duration: seconds
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.isTemp, true);
      assert.equal(result.duration, 5, 'No transcription of a longer muted video tail');
      assert.equal(path.extname(result.audioPath), '.wav');
      assert.ok(fs.statSync(result.audioPath).size > 500, 'IPC returns a real rendered file');
      assert.notEqual(result.audioPath, source, 'trimmed timeline is not replaced by the original source');
      const info = await ff.probe(result.audioPath);
      assert.ok(info.hasAudio);
      assert.ok(Math.abs(info.duration - 5) < 0.1, JSON.stringify(info));
      const activity = require('../electron/recognition-quality').readWaveActivity(fs.readFileSync(result.audioPath));
      assert.ok(Math.abs(activity.activeSeconds - 3) < 0.2, JSON.stringify(activity));
      const speech = await ff.detectSpeechSegments(result.audioPath, { minSilence: 0.2, noise: '-40dB' });
      assert.equal(speech.length, 2, JSON.stringify(speech));
      for (const [index, [start, end]] of [[1, 3], [4, 5]].entries()) {
        assert.ok(Math.abs(speech[index].start - start) < 0.1, JSON.stringify(speech));
        assert.ok(Math.abs(speech[index].end - end) < 0.1, JSON.stringify(speech));
      }
      console.log('PASS: ' + (packaged ? 'packaged' : 'source') + ' real ' + kind + ' IPC render preserves source trims and timeline sound positions.');
    }
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {});
    await app.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
