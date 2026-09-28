'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ff = require('../electron/ffmpeg');
const dir = path.resolve(__dirname, '../.test-output/export-gpu');
fs.mkdirSync(dir, { recursive: true });
const run = args => execFileSync(ff.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
const source = path.join(dir, 'source.mp4'), voice = path.join(dir, 'voice.wav');
run(['-f', 'lavfi', '-i', 'color=red:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=30:d=1',
 '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', voice]);
const clip = { src: source, kind: 'video', start: 0, inPoint: .5, outPoint: 1.5, volume: 0, hasAudio: false };
const audio = [{ src: voice, start: .25, inPoint: 0, outPoint: .5, volume: .6 }];
const render = async (name, clips, duration) => {
 const outPath = path.join(dir, `${name}.mp4`);
 await ff.exportTimeline({ clips, audio, width: 320, height: 180, fps: 30, duration, codec: 'hevc', customBitrate: 1000, outPath });
 return outPath;
};
(async () => {
 for (const [name, clips] of [['single', [clip]], ['sequence', [
  { ...clip, inPoint: 0, outPoint: .5 }, { ...clip, start: .5, inPoint: 1, outPoint: 1.5 }]]]) {
  const file = await render(name, clips, 1);
  const frames = run(['-i', file, '-an', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
  assert.equal(frames.length, 90);
  for (let n = 0; n < 30; n++) assert.ok(frames[n * 3 + (n < 15 ? 0 : 2)] > 180, `${name}: source timing at frame ${n}`);
  const pcm = run(['-i', file, '-vn', '-ar', '8000', '-ac', '1', '-f', 's16le', 'pipe:1']);
  const peak = (a, b) => { let value = 0; for (let n = a * 8000; n < b * 8000; n++) value = Math.max(value, Math.abs(pcm.readInt16LE(n * 2))); return value; };
  assert.ok(peak(.05, .15) < 10, 'Voice starts at the requested timeline offset');
  assert.ok(peak(.35, .55) > 500, 'Voice survives the final mux');
  assert.ok(peak(.85, .95) < 10, 'Voice ends at the requested timeline offset');
 }
 const filtered = await render('effect', [{ ...clip, effectFf: 'negate' }], 1);
 const rgb = run(['-i', filtered, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
 assert.ok(rgb[0] < 80 && rgb[1] > 150 && rgb[2] > 150, 'Effects cannot take the unfiltered GPU path');
 console.log('PASS: GPU single/sequence frame timing, delayed voice mixing, and effect fallback.');
})().catch(e => { console.error(e); process.exitCode = 1; });
