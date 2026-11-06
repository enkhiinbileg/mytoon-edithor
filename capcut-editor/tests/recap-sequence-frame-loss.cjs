'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ff = require('../electron/ffmpeg');

const dir = path.resolve(__dirname, '../.test-output/recap-sequence-frame-loss');
fs.mkdirSync(dir, { recursive: true });
const run = args => execFileSync(ff.FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], {
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024
});

(async () => {
  const fps = 30, width = 320, height = 180;
  const red = path.join(dir, 'red.mp4');
  const blue = path.join(dir, 'blue.mp4');
  const greenImg = path.join(dir, 'green.png');
  const captionImg = path.join(dir, 'caption.png');

  run(['-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=60:d=1.0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red]);
  run(['-y', '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=60:d=1.0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue]);
  run(['-y', '-f', 'lavfi', '-i', 'color=yellow:s=320x180', '-vf', 'format=rgba', '-frames:v', '1', greenImg]);
  run(['-y', '-f', 'lavfi', '-i', 'color=green:s=320x180', '-vf', 'format=rgba', '-frames:v', '1', captionImg]);
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(captionImg).toString('base64');

  // Case 1: Intentional 1-frame black gap + 1-frame video clip + 1-frame image clip + overlays
  {
    const duration = 1.0; // 30 frames
    const clips = [
      { src: red, kind: 'video', trackId: 'v1', start: 0, inPoint: 0, outPoint: 5 / 30, volume: 0, hasAudio: false },
      // 1-frame black gap at frame 5 (start moves from 5/30 to 6/30)
      { src: blue, kind: 'video', trackId: 'v1', start: 6 / 30, inPoint: 0, outPoint: 1 / 30, volume: 0, hasAudio: false }, // 1-frame video clip
      { src: greenImg, kind: 'image', trackId: 'v1', start: 7 / 30, inPoint: 0, outPoint: 1 / 30, volume: 0, hasAudio: false }, // 1-frame image clip
      // Clip extending past actual video stream duration (1.0s video, outPoint=1.15s)
      { src: red, kind: 'video', trackId: 'v1', start: 8 / 30, inPoint: 0.416667, outPoint: 1.15, volume: 0, hasAudio: false }
    ];
    const overlays = [
      { dataUrl, start: 0.1, end: 0.35, x: 0, y: 0, w: width, h: height, opacity: 1 }
    ];
    for (const [label, ov] of [['with-overlays', overlays], ['no-overlays', []]]) {
      const outPath = path.join(dir, `one-frame-segments-${label}.mp4`);
      await ff.exportTimeline({
        clips,
        overlays: ov,
        width,
        height,
        fps,
        duration,
        outPath,
        codec: 'hevc',
        quality: 'draft'
      });
      const raw = run(['-i', outPath, '-an', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
      assert.equal(raw.length / 3, 30, `Expected exactly 30 frames (${label}), got ${raw.length / 3}`);
    }
  }

  // Case 2: IEEE-754 floating-point half-frame boundary between abutting clips (e.g. 0.714 + (422.096 - 413.36) vs 9.45 -> 0.45s shifted)
  // 0.014 + (422.096 - 421.66) = 0.44999999999998863 -> *30 = 13.49999999999966 (rounds to 13)
  // Next clip starts at 0.45 -> *30 = 13.5 (rounds to 14) -> previously inserted a spurious 1-frame black flash AND dropped a frame!
  {
    const c1Dur = 422.096 - 421.66; // 0.43600000000003547 or similar float boundary
    // Exact reproduction of 377.714 + (422.096 - 413.36) = 386.44999999999993 vs 386.45, scaled down by subtracting 377.7 (11331 frames):
    // Wait: 0.014 + (0.496 - 0.06) = 0.44999999999999996! 0.44999999999999996 * 30 = 13.499999999999998 -> Math.round = 13!
    // While 0.45 * 30 = 13.5 -> Math.round = 14!
    const start1 = 0.014;
    const in1 = 0.06;
    const out1 = 0.496 - 1e-15;
    assert.equal(Math.round((start1 + out1 - in1) * 30), 13);
    assert.equal(Math.round(0.45 * 30), 14);

    const clips = [
      { src: red, kind: 'video', trackId: 'v1', start: 0, inPoint: 0, outPoint: 0.014, volume: 0, hasAudio: false },
      { src: red, kind: 'video', trackId: 'v1', start: start1, inPoint: in1, outPoint: out1, volume: 0, hasAudio: false },
      { src: blue, kind: 'video', trackId: 'v1', start: 0.45, inPoint: 0, outPoint: 0.55, volume: 0, hasAudio: false }
    ];
    const outPath = path.join(dir, 'half-frame-contiguous.mp4');
    await ff.exportTimeline({
      clips,
      overlays: [],
      width,
      height,
      fps,
      duration: 1.0,
      outPath,
      codec: 'h264',
      quality: 'draft'
    });
    const raw = run(['-i', outPath, '-an', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    assert.equal(raw.length / 3, 30);
    // Verify NO black flash frame exists anywhere in the 30 frames (every frame is either red or blue)!
    for (let n = 0; n < 30; n++) {
      const r = raw[n * 3], g = raw[n * 3 + 1], b = raw[n * 3 + 2];
      assert.ok(r > 150 || b > 150, `Unexpected black flash at frame ${n}: [${r}, ${g}, ${b}]`);
    }
  }

  console.log('PASS: 1-frame gaps/clips, video-EOF padding, and half-frame contiguous cuts preserve exact frame counts with zero black flashes.');
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
