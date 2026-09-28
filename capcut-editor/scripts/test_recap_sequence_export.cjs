'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const ff = require('../electron/ffmpeg');
const { materializeFreezeFrames } = require('../electron/recap-freeze');
const { isSimpleMutedSequence } = require('../electron/recap-sequence-export');
const exec = promisify(execFile);

async function command(binary, args, encoding = 'utf8') {
  return exec(binary, args, { windowsHide: true, timeout: 120000,
    encoding, maxBuffer: 1024 * 1024 * 16 });
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cutline-sequence-test-'));
  try {
    const src = path.join(directory, 'red-blue.mp4');
    await command(ff.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
      '-c:v', 'libx264', '-g', '120', '-pix_fmt', 'yuv420p', src]);
    const frames = await materializeFreezeFrames({ video: { path: src, duration: 2 },
      timestamps: [1.2], outputDir: path.join(directory, 'project-assets') });
    const blue = frames.get(1.2);
    const outputFps = 30;
    const unit = 0.137;
    const clips = Array.from({ length: 61 }, (_, index) => ({
      src: index % 2 ? blue : src, kind: index % 2 ? 'image' : 'video',
      trackId: 'v1', start: index * unit, inPoint: index % 2 ? 0 : 0.2,
      outPoint: (index % 2 ? 0 : 0.2) + unit, volume: 0, hasAudio: false,
    }));
    assert.equal(isSimpleMutedSequence(clips), true);
    assert.equal(isSimpleMutedSequence(clips.map((clip, index) => index === 60 ? { ...clip, effectFf: 'negate' } : clip)), false, 'Large sequences must not drop effects.');
    assert.equal(isSimpleMutedSequence(clips.map((clip, index) => index === 60 ? { ...clip, layer: 1 } : clip)), false, 'Large sequences must not flatten layers.');
    assert.equal(isSimpleMutedSequence(clips.map((clip, index) => index === 60 ? { ...clip, start: 0 } : clip)), false, 'Overlaps must retain compositing.');
    assert.equal(isSimpleMutedSequence(clips.map((clip, index) => index === 60 ? { ...clip, hasAudio: true, volume: 1 } : clip)), false, 'Source audio must not be discarded.');
    const outPath = path.join(directory, 'export.mp4');
    const duration = clips.length * unit;
    const progress = [];
    await ff.exportTimeline({ clips, width: 320, height: 180, fps: outputFps, duration,
      outPath, codec: process.env.EXPORT_TEST_CODEC || 'h264', customBitrate: 1000 }, (event) => progress.push(event));
    const probe = JSON.parse((await command(ff.FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-count_frames', '-show_entries', 'stream=nb_read_frames,duration', '-of', 'json', outPath])).stdout);
    const expectedFrames = Math.ceil(duration * outputFps - 1e-7);
    assert.equal(Number(probe.streams[0].nb_read_frames), expectedFrames, 'Fractional cuts must not accumulate duration drift.');
    assert.ok(Math.abs(Number(probe.streams[0].duration) - duration) <= 1 / outputFps + 0.0001);
    const decoded = (await command(ff.FFMPEG, ['-v', 'error', '-i', outPath, '-an',
      '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], 'buffer')).stdout;
    assert.equal(decoded.length, expectedFrames * 3);
    let checked = 0;
    for (let index = 0; index < clips.length; index += 1) {
      const startFrame = Math.round(index * unit * outputFps);
      const endFrame = index + 1 === clips.length ? expectedFrames : Math.round((index + 1) * unit * outputFps);
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        const rgb = [...decoded.subarray(frame * 3, frame * 3 + 3)];
        const wanted = index % 2 ? 2 : 0;
        assert.ok(rgb[wanted] > 180 && rgb[1] < 60 && rgb[wanted === 0 ? 2 : 0] < 60,
          `Wrong scene/freeze at clip ${index}, frame ${frame}: ${rgb}`);
        checked += 1;
      }
    }
    assert.equal(checked, expectedFrames);
    assert.equal(progress.at(-1).pct, 100);
    assert.ok(progress.some((event) => event.stage === 'encode-video'));
    assert.ok(progress.some((event) => event.stage === 'mux-audio'));
    assert.ok(progress.every((event, i) => !i || event.pct >= progress[i - 1].pct), 'Progress never moves backwards.');
    console.log(`PASS: ${clips.length} mixed video/image clips, all ${expectedFrames} frame colors, frame-accurate duration, and fast-path rejection for effects/layers/overlaps/native audio.`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
