'use strict';

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { prepareOverlaySequence } = require('./recap-overlay-sequence');

// Only this shape can be flattened without changing layer/effect/audio semantics.
function isSimpleMutedSequence(clips) {
  if (!Array.isArray(clips) || clips.length < 2) return false;
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  const track = ordered[0].trackId ?? ordered[0].layer ?? 0;
  let end = 0;
  return ordered.every((clip) => {
    const duration = clip.outPoint - clip.inPoint;
    const valid = Number.isFinite(clip.start) && clip.start >= 0
      && Number.isFinite(clip.inPoint) && clip.inPoint >= 0
      && Number.isFinite(duration) && duration > 0 && clip.start >= end - 1e-6
      && (clip.trackId ?? clip.layer ?? 0) === track
      && (clip.layer ?? 0) === (ordered[0].layer ?? 0)
      && (clip.opacity ?? 1) === 1 && (!clip.keyframes || clip.keyframes.length === 0)
      && (clip.scale ?? 1) === 1 && (clip.rotation ?? 0) === 0
      && (clip.x ?? 0.5) === 0.5 && (clip.y ?? 0.5) === 0.5
      && (!clip.transition || clip.transition === 'none')
      && (!clip.filterFf || clip.filterFf === 'none')
      && (!clip.effectFf || clip.effectFf === 'none')
      && (clip.kind === 'image' || !clip.hasAudio || (clip.volume ?? 1) <= 0.001);
    end = clip.start + duration;
    return valid;
  });
}

function run(ffmpeg, args, onProcess, onTime) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpeg, args, { windowsHide: true });
    onProcess?.(process);
    let stderr = '';
    let pending = '';
    process.stdout.on('data', data => {
      pending += data.toString();
      const lines = pending.split('\n'); pending = lines.pop() || '';
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match) onTime?.(Number(match[1]) / 1e6);
      }
    });
    // A bad decoder must eventually stop; normal long batches still get 30 min.
    const timeout = setTimeout(() => process.kill(), 30 * 60 * 1000);
    process.stderr.on('data', (data) => { stderr = (stderr + data).slice(-8000); });
    process.on('error', (error) => { clearTimeout(timeout); reject(error); });
    process.on('close', (code) => {
      clearTimeout(timeout);
      onProcess?.(null);
      if (code === 0) resolve();
      else reject(new Error(`Sequence preparation failed or was cancelled: ${stderr || code}`));
    });
  });
}

function frameCount(ffprobe, filePath) {
  return new Promise((resolve, reject) => {
    // Our MP4 muxer records the number of encoded samples. Reading that table
    // avoids decoding the entire movie a second time just to count frames.
    execFile(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_frames', '-of', 'json', filePath],
    { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(Number(JSON.parse(stdout).streams?.[0]?.nb_frames)); }
      catch (parseError) { reject(parseError); }
    });
  });
}

/**
 * Normalize at most eight inputs at a time, then expose identical H.264 streams
 * to the concat demuxer. Mixing image packets and source-video packets directly
 * is invalid. Each boundary is rounded on the absolute output frame grid so
 * hundreds of fractional-duration cuts cannot accumulate independent rounding.
 */
async function normalizeSimpleSequence({ clips, width, height, fps, duration,
  workDir, ffmpeg, ffprobe, onProcess, onProgress, encodeArgs, overlays = [] }) {
  if (!isSimpleMutedSequence(clips)) throw new Error('Only simple muted sequences can use bounded normalization.');
  const totalFrames = Math.ceil(duration * fps - 1e-7);
  const segments = [];
  let cursor = 0;
  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    if (clip.start >= duration) break;
    const startFrame = Math.min(totalFrames, Math.round(clip.start * fps));
    const clipEnd = Math.min(duration, clip.start + clip.outPoint - clip.inPoint);
    const endFrame = clipEnd >= duration - 1e-7 ? totalFrames : Math.round(clipEnd * fps);
    if (startFrame > cursor) segments.push({ frames: startFrame - cursor });
    if (endFrame > startFrame) {
      segments.push({ clip, frames: endFrame - startFrame,
        sourceDuration: clipEnd - clip.start });
    }
    cursor = Math.max(cursor, endFrame);
  }
  if (cursor < totalFrames) segments.push({ frames: totalFrames - cursor });
  if (!segments.length) throw new Error('Sequence contains no output frames.');

  await fs.mkdir(workDir, { recursive: true });
  const lines = ['ffconcat version 1.0'];
  let completedFrames = 0;
  const startedAt = Date.now();
  const report = frames => {
    const completed = Math.min(totalFrames, frames);
    const speed = completed / fps / Math.max(.001, (Date.now() - startedAt) / 1000);
    onProgress?.({ stage: encodeArgs ? 'encode-video' : 'prepare-video', completedFrames: completed, totalFrames,
      pct: Math.floor(completed / totalFrames * (encodeArgs ? 95 : 49)),
      speed: `${speed.toFixed(1)}x`, fps: Math.round(speed * fps) });
  };
  for (let offset = 0; offset < segments.length; offset += 8) {
    const chunk = segments.slice(offset, offset + 8);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex_threads', '1'];
    const filters = [];
    let expected = 0;
    chunk.forEach(({ clip, frames, sourceDuration }, index) => {
      const seconds = frames / fps;
      expected += frames;
      if (!clip) {
        args.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${seconds}`);
      } else if (clip.kind === 'image') {
        // Decode and resize a held frame once; reuse it in the filter graph.
        args.push('-threads', '1', '-i', clip.src);
      } else {
        args.push('-threads', '1', '-ss', String(clip.inPoint), '-t', String(sourceDuration), '-i', clip.src);
      }
      const fit = clip?.fitMode === 'cover'
        ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
        : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
      if (clip?.kind === 'image') {
        filters.push(`[${index}:v]${fit},setsar=1,format=yuv420p,loop=loop=-1:size=1:start=0,` +
          `settb=1/${fps},setpts=N,fps=${fps},trim=end_frame=${frames},setpts=N/(${fps}*TB)[v${index}]`);
        return;
      }
      // A maximum one-frame pad only resolves decode/CFR boundary quantization.
      filters.push(`[${index}:v]setpts=PTS-STARTPTS,${fit},setsar=1,fps=${fps},` +
        `tpad=stop_mode=clone:stop_duration=${1 / fps},trim=end_frame=${frames},` +
        `setpts=N/(${fps}*TB),format=yuv420p[v${index}]`);
    });
    filters.push(chunk.map((_, index) => `[v${index}]`).join('') + `concat=n=${chunk.length}:v=1:a=0[sequence]`);
    let outputLabel = '[sequence]';
    // Snap captions on the global frame grid BEFORE subtracting the batch start.
    // This preserves subtitle boundaries across fractional clip cuts.
    const localOverlays = overlays.map(o => ({ ...o,
      start: Math.max(0, (Math.ceil(o.start * fps - 1e-7) - completedFrames) / fps),
      end: Math.min(expected / fps, (Math.ceil(o.end * fps - 1e-7) - completedFrames) / fps),
    })).filter(o => o.end > o.start && o.start < expected / fps);
    if (localOverlays.length) {
      const manifest = prepareOverlaySequence({ overlays: localOverlays, width, height, fps,
        duration: expected / fps, workDir: path.join(workDir, `captions-${offset}`) });
      args.push('-threads', '1', '-f', 'concat', '-safe', '0', '-i', manifest);
      filters.push(`[${chunk.length}:v]format=rgba,fps=${fps},settb=AVTB[captions]`);
      filters.push(`[sequence]fps=${fps},settb=AVTB[base]`);
      filters.push('[base][captions]overlay=x=0:y=0:eof_action=pass:repeatlast=0[vout]');
      outputLabel = '[vout]';
    }
    const output = path.join(workDir, `chunk-${Math.floor(offset / 8)}.mp4`);
    // Eight inputs keep the graph/command bounded; the bundled FFmpeg omits the
    // older filter_complex_script option, so use its supported inline syntax.
    args.push('-filter_complex', filters.join(';'), '-map', outputLabel, '-an',
      ...(encodeArgs || ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', '-threads', '2']),
      '-frames:v', String(expected), '-r', String(fps), '-progress', 'pipe:1', '-nostats', output);
    await run(ffmpeg, args, onProcess, seconds => report(completedFrames + Math.min(expected, Math.floor(seconds * fps))));
    const actual = await frameCount(ffprobe, output);
    if (actual !== expected) throw new Error(`Prepared sequence lost frames: expected ${expected}, got ${actual}.`);
    // Only normalized streams share this manifest, never source files or images.
    lines.push(`file '${output.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${(expected / fps).toFixed(12)}`);
    completedFrames += expected;
    report(completedFrames);
  }
  const manifest = path.join(workDir, 'sequence.ffconcat');
  await fs.writeFile(manifest, lines.join('\n'));
  return { manifest, totalFrames };
}

module.exports = { isSimpleMutedSequence, normalizeSimpleSequence };
