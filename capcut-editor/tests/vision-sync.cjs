const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ff = require('../electron/ffmpeg');
const visionSync = require('../electron/vision-sync');

const dir = path.resolve(__dirname, '../.test-output/vision-sync-' + Date.now());
fs.mkdirSync(dir, { recursive: true });

const testVideo = path.join(dir, 'test-comic.mp4');
execFileSync(
  ff.FFMPEG,
  [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=duration=10:size=320x180:rate=10',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    testVideo
  ],
  { windowsHide: true }
);

(async () => {
  console.log('Testing keyframe extraction...');
  const keyframes = await visionSync.extractKeyframes(testVideo, {
    startOffset: 0,
    searchDuration: 10,
    targetFrames: 5
  });

  assert.ok(keyframes.length >= 2, `Expected at least 2 keyframes, got ${keyframes.length}`);
  assert.ok(keyframes[0].base64.length > 50, 'Keyframe contains valid base64 data');
  assert.ok(Number.isFinite(keyframes[0].timestamp), 'Keyframe timestamp is valid');
  console.log(`✓ Extracted ${keyframes.length} keyframes successfully.`);

  // Test error on missing API key
  await assert.rejects(
    () => visionSync.matchWithGeminiVision({ speechSegments: [{ id: 0, start: 0, end: 3 }], keyframes, apiKey: '' }),
    /Gemini API key is required/
  );
  console.log('✓ API key validation passed.');

  console.log('ALL VISION SYNC TESTS PASSED!');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
