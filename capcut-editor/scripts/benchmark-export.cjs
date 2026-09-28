'use strict';
// Repeatable real-media comparison. Baseline modules are copied before editing.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'current';
if (mode === 'baseline') {
 process.env.FFMPEG_PATH ||= path.join(root, 'runtime-tools/ffmpeg.exe');
 process.env.FFPROBE_PATH ||= path.join(root, 'runtime-tools/ffprobe.exe');
}
const ff = require(mode === 'baseline' ? '../.test-output/export-baseline/ffmpeg' : '../electron/ffmpeg');
const source = process.argv[3];
if (!source || !fs.existsSync(source)) throw new Error('Pass a source video path.');
const dir = path.join(root, '.test-output/export-speed');
fs.mkdirSync(dir, { recursive: true });
const run = args => execFileSync(ff.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
(async () => {
 const png = path.join(dir, 'caption.png');
 const freeze = path.join(dir, 'freeze.png');
 run(['-f', 'lavfi', '-i', 'color=black@0:s=1920x1080,format=rgba,drawbox=x=200:y=900:w=1520:h=100:color=white@0.8:t=fill', '-frames:v', '1', png]);
 run(['-ss', '45', '-i', source, '-frames:v', '1', freeze]);
 const dataUrl = 'data:image/png;base64,' + fs.readFileSync(png).toString('base64');
 const duration = 60;
 const clips = process.argv.includes('--single') ? [{ src: source, kind: 'video', trackId: 'v1',
  start: 0, inPoint: 30, outPoint: 30 + duration, hasAudio: false, volume: 0 }] : Array.from({ length: 24 }, (_, i) => ({ src: i % 4 === 3 ? freeze : source,
  kind: i % 4 === 3 ? 'image' : 'video', trackId: 'v1', start: i * 2.5,
  inPoint: i % 4 === 3 ? 0 : i * 4, outPoint: (i % 4 === 3 ? 0 : i * 4) + 2.5,
  hasAudio: false, volume: 0 }));
 const overlays = process.argv.includes('--single') ? [] : Array.from({ length: 40 }, (_, i) => ({ dataUrl, start: i * 1.5 + .1, end: i * 1.5 + 1.3,
  x: 0, y: 0, w: 1920, h: 1080, opacity: 1 }));
 await ff.detectHardwareEncoders();
 const started = performance.now();
 const name = mode + (process.argv.includes('--single') ? '-single' : '');
 const outPath = path.join(dir, `${name}.mp4`);
 await ff.exportTimeline({ clips, overlays, width: 1920, height: 1080, fps: 30,
  duration, outPath, codec: 'hevc', customBitrate: 1000, bitrateMode: 'vbr' });
 const seconds = (performance.now() - started) / 1000;
 const probe = JSON.parse(execFileSync(ff.FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outPath]));
 const video = probe.streams.find(s => s.codec_type === 'video');
 const result = { mode, source, seconds, speed: duration / seconds, encoder: await ff.getBestVideoEncoder('hevc'),
  codec: video.codec_name, width: video.width, height: video.height, frames: video.nb_frames,
  duration: probe.format.duration, bytes: fs.statSync(outPath).size };
 fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(result, null, 2));
 console.log(JSON.stringify(result, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
