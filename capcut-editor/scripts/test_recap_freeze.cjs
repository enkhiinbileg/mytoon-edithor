'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { FFMPEG } = require('../electron/ffmpeg');
const { materializeFreezeFrames } = require('../electron/recap-freeze');
const exec = promisify(execFile);

async function ff(args) {
  return exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    windowsHide: true, timeout: 60000, encoding: 'buffer', maxBuffer: 1024 * 1024,
  });
}

async function generate(filePath, first = 'red', second = 'blue') {
  await ff(['-f', 'lavfi', '-i', `color=c=${first}:s=64x48:r=10:d=1`,
    '-f', 'lavfi', '-i', `color=c=${second}:s=64x48:r=10:d=1`,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-g', '50', '-pix_fmt', 'yuv420p', filePath]);
}

async function pixel(imagePath) {
  const { stdout } = await ff(['-i', imagePath, '-frames:v', '1', '-vf', 'scale=1:1',
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  assert.equal(stdout.length, 3);
  return [...stdout];
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cutline-freeze-test-'));
  try {
    const sourcePath = path.join(directory, 'source.mp4');
    const outputDir = path.join(directory, 'persistent-project-assets');
    await generate(sourcePath);
    const video = { path: sourcePath, duration: 2, width: 64, height: 48, fps: 10 };
    const request = { video, outputDir, timestamps: [0.2, 1.2, 1.2] };
    const events = [];
    const [frames, simultaneous] = await Promise.all([
      materializeFreezeFrames(request, (event) => events.push(event)),
      materializeFreezeFrames(request),
    ]);
    assert.equal(frames.size, 2, 'Duplicate timestamps should materialize only once.');
    assert.deepEqual(frames, simultaneous, 'Concurrent callers should share the same cache.');
    assert.equal(events.length, 2);
    assert.equal(events.at(-1).completed, 2);
    const red = await pixel(frames.get(0.2));
    const blue = await pixel(frames.get(1.2));
    assert.ok(red[0] > 200 && red[1] < 30 && red[2] < 30, `Expected red, got ${red}`);
    assert.ok(blue[2] > 200 && blue[0] < 30 && blue[1] < 30, `Expected blue, got ${blue}`);
    const lastFrame = await materializeFreezeFrames({ video, outputDir, timestamps: [1.9] });
    assert.ok((await pixel(lastFrame.get(1.9)))[2] > 200, 'The last real frame should be extractable.');
    const before = await fs.stat(frames.get(1.2));
    assert.deepEqual(await materializeFreezeFrames(request), frames);
    assert.equal((await fs.stat(frames.get(1.2))).mtimeMs, before.mtimeMs, 'Valid cache hits must not rewrite images.');

    // A corrupted existing image must be replaced, never returned as a hit.
    await fs.writeFile(frames.get(1.2), Buffer.from('not a PNG'));
    const repaired = await materializeFreezeFrames(request);
    assert.ok((await pixel(repaired.get(1.2)))[2] > 200);

    // Replacing a file at the same path must not reuse the previous video's cache.
    await generate(sourcePath, 'green', 'yellow');
    const later = new Date(Date.now() + 5000);
    await fs.utimes(sourcePath, later, later);
    const replaced = await materializeFreezeFrames(request);
    assert.notEqual(replaced.get(1.2), frames.get(1.2));
    const yellow = await pixel(replaced.get(1.2));
    assert.ok(yellow[0] > 200 && yellow[1] > 200 && yellow[2] < 30);

    await assert.rejects(materializeFreezeFrames({ ...request, outputDir: 'relative' }), /persistent, absolute/);
    await assert.rejects(materializeFreezeFrames({ ...request, timestamps: [-0.1] }), /outside/);
    await assert.rejects(materializeFreezeFrames({ ...request, timestamps: [2] }), /outside/);
    await assert.rejects(materializeFreezeFrames({ ...request, timestamps: [NaN] }), /outside/);
    await assert.rejects(materializeFreezeFrames({ ...request, video: { ...video, path: path.join(directory, 'missing.mp4') } }), /ENOENT/);
    const corruptPath = path.join(directory, 'broken.mp4');
    await fs.writeFile(corruptPath, 'broken video');
    await assert.rejects(materializeFreezeFrames({ ...request, video: { ...video, path: corruptPath } }), /FFmpeg/);
    // Even if one timestamp succeeds, any missing requested frame rejects the whole job.
    await assert.rejects(materializeFreezeFrames({ ...request,
      video: { ...video, duration: 10 }, timestamps: [0.2, 8] }), /No decodable video frame/);
    assert.ok((await fs.readdir(outputDir)).every((name) => !name.includes('.partial.')), 'Failed jobs must clean temporary files.');
    console.log('PASS: real frame identity, exact seeking, deduplication, shared concurrency, persistent cache, cache repair, source replacement, invalid sources/timestamps, and all-or-error output.');
  } finally {
    // This directory is created solely for this test and never accepts user paths.
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
