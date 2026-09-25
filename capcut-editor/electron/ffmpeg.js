'use strict';
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Resolve the ffmpeg/ffprobe binaries. Shotcut ships working Windows builds, so
// reuse those when present instead of making the user install ffmpeg separately.
function resolveBinary(name) {
  const envVar = process.env[name.toUpperCase() + '_PATH'];
  if (envVar && fs.existsSync(envVar)) return envVar;

  const candidates = [
    path.join(process.resourcesPath || '', 'recap-tools', `${name}.exe`),
    path.join(__dirname, '..', 'runtime-tools', `${name}.exe`),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Shotcut', `${name}.exe`),
    path.join(process.env.ProgramFiles || '', 'Shotcut', `${name}.exe`)
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return name; // fall back to PATH
}

const FFMPEG = resolveBinary('ffmpeg');
const FFPROBE = resolveBinary('ffprobe');

const THUMB_DIR = path.join(os.tmpdir(), 'capcut-editor-thumbs');
const OVERLAY_DIR = path.join(os.tmpdir(), 'capcut-editor-overlays');
fs.mkdirSync(THUMB_DIR, { recursive: true });
fs.mkdirSync(OVERLAY_DIR, { recursive: true });

let activeExportProcess = null;

function cancelExport() {
  if (activeExportProcess) {
    try {
      activeExportProcess.kill();
    } catch {}
    activeExportProcess = null;
    return true;
  }
  return false;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

/** Read duration / dimensions / stream layout of a media file. */
async function probe(filePath) {
  const out = await run(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ]);
  const data = JSON.parse(out);
  const video = (data.streams || []).find((s) => s.codec_type === 'video');
  const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
  const duration = parseFloat(data.format?.duration ?? '0') || 0;

  let fps = 30;
  if (video?.r_frame_rate && video.r_frame_rate.includes('/')) {
    const [n, d] = video.r_frame_rate.split('/').map(Number);
    if (d) fps = n / d;
  }

  return {
    duration,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    kind: video ? 'video' : audio ? 'audio' : 'unknown'
  };
}

/**
 * Extract evenly spaced thumbnails used for the timeline filmstrip and the
 * media-panel poster. Returns absolute paths.
 */
async function thumbnails(filePath, duration, count = 24) {
  // Hash the whole path: truncating an encoding of it collides for files that
  // share a long directory prefix, which made clips reuse each other's frames.
  const id = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  const dir = path.join(THUMB_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  // Instant Single Poster Frame Mode (for instant import < 0.2s like CapCut)
  if (count <= 1) {
    const out = path.join(dir, 't0.jpg');
    if (fs.existsSync(out)) {
      try {
        if (fs.statSync(out).size > 1000) return [out];
      } catch {}
    }
    try {
      await run(FFMPEG, [
        '-hwaccel', 'auto',
        '-y', '-ss', '0.5', '-i', filePath,
        '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '3', out
      ]);
      if (fs.existsSync(out)) return [out];
    } catch {}
    return [];
  }

  // Capped at 16 coarse background thumbnails (Timeline uses dynamic on-demand frames anyway)
  const n = Math.max(1, Math.min(count, 16));
  const paths = [];

  for (let i = 0; i < n; i++) {
    const t = n <= 1 ? 0 : (duration * i) / (n - 1);
    const out = path.join(dir, `t${i}.jpg`);
    paths.push(out);
    if (fs.existsSync(out)) {
      continue;
    }
    try {
      const scale = i === 0 ? 'scale=480:-2' : 'scale=320:-2';
      await run(FFMPEG, [
        '-hwaccel', 'auto',
        '-y', '-ss', String(t.toFixed(2)), '-i', filePath,
        '-frames:v', '1', '-vf', scale, '-q:v', '3', out
      ]);
    } catch {
      // A seek past the end or a broken frame should not abort the whole strip.
    }
  }
  return paths.filter((p) => fs.existsSync(p));
}

/**
 * Extract fine-grained audio waveform peak data (default 100 peaks per second).
 * Returns { ok: boolean, duration: number, pointsPerSecond: number, peaks: number[] }
 */
async function extractWaveform(filePath, pointsPerSecond = 100) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: 'File not found', duration: 0, pointsPerSecond, peaks: [] };
  }

  const id = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  const cacheFile = path.join(THUMB_DIR, `wave_${id}_v3_${pointsPerSecond}.json`);

  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && Array.isArray(cached.peaks)) {
        return cached;
      }
    } catch {}
  }

  return new Promise((resolve) => {
    const sampleRate = 8000;
    const samplesPerPeak = Math.max(8, Math.round(sampleRate / pointsPerSecond));

    const proc = spawn(FFMPEG, [
      '-v', 'error',
      '-threads', '4',
      '-i', filePath,
      '-vn',
      '-map', '0:a:0?',
      '-ac', '1',
      '-filter:a', `aresample=${sampleRate}`,
      '-c:a', 'pcm_s16le',
      '-f', 's16le',
      '-'
    ]);

    const peaks = [];
    let currentPeak = 0;
    let sampleCounter = 0;
    let leftover = null;

    proc.stdout.on('data', (chunk) => {
      let buf = chunk;
      if (leftover) {
        buf = Buffer.concat([leftover, chunk]);
        leftover = null;
      }
      const len = buf.length - (buf.length % 2);
      if (len < buf.length) {
        leftover = buf.subarray(len);
      }
      for (let i = 0; i < len; i += 2) {
        const val = Math.abs(buf.readInt16LE(i));
        if (val > currentPeak) currentPeak = val;
        sampleCounter++;
        if (sampleCounter >= samplesPerPeak) {
          let peak = 0;
          if (currentPeak > 40) { // above -58 dB noise floor
            const linearNorm = currentPeak / 32768;
            peak = Math.min(100, Math.max(1, Math.round(Math.pow(linearNorm, 0.5) * 100)));
          }
          peaks.push(peak);
          currentPeak = 0;
          sampleCounter = 0;
        }
      }
    });

    proc.on('error', (err) => {
      console.error('Waveform extraction failed:', err);
      resolve({ ok: false, error: String(err), duration: 0, pointsPerSecond, peaks: [] });
    });

    proc.on('close', () => {
      if (sampleCounter > 0) {
        let peak = 0;
        if (currentPeak > 40) {
          const linearNorm = currentPeak / 32768;
          peak = Math.min(100, Math.max(1, Math.round(Math.pow(linearNorm, 0.5) * 100)));
        }
        peaks.push(peak);
      }
      const duration = peaks.length / pointsPerSecond;
      const result = { ok: true, duration, pointsPerSecond, peaks };

      try {
        fs.writeFile(cacheFile, JSON.stringify(result), () => {});
      } catch {}

      resolve(result);
    });
  });
}

// In-flight extraction deduplicator: prevents duplicate FFmpeg processes for the same frame key
const inFlightFrames = new Map();

async function extractSingleFrame(filePath, dir, id, safeT) {
  const key = Math.round(safeT * 10);
  const cacheKey = `${id}_${key}`;
  const out = path.join(dir, `f_${key}.jpg`);

  if (fs.existsSync(out)) {
    try {
      if (fs.statSync(out).size > 400) return out;
    } catch {}
  }

  if (inFlightFrames.has(cacheKey)) {
    return inFlightFrames.get(cacheKey);
  }

  const task = (async () => {
    try {
      await run(FFMPEG, [
        '-hwaccel', 'auto',
        '-threads', '2',
        '-y', '-ss', safeT.toFixed(2), '-i', filePath,
        '-an', '-sn', '-dn',
        '-frames:v', '1', '-vf', 'scale=160:-2:flags=fast_bilinear', '-q:v', '4', out
      ]);
      return fs.existsSync(out) ? out : null;
    } catch {
      return null;
    } finally {
      inFlightFrames.delete(cacheKey);
    }
  })();

  inFlightFrames.set(cacheKey, task);
  return task;
}

/**
 * Extract exact, high-resolution thumbnail frames for a list of timestamps.
 * Caches each frame by quantized timestamp key on disk and in memory.
 * Never drops or cancels batches requested by earlier clips.
 */
async function framesAtTimestamps(filePath, timestamps) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return [];
  const id = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  const dir = path.join(THUMB_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const results = new Array(timestamps.length);
  let curIndex = 0;
  // Concurrency limit of 4 workers keeps extraction snappy while leaving CPU plenty responsive
  const limit = 4;

  const worker = async () => {
    while (curIndex < timestamps.length) {
      const idx = curIndex++;
      const safeT = Math.max(0, Number(timestamps[idx]) || 0);
      results[idx] = await extractSingleFrame(filePath, dir, id, safeT);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, timestamps.length) }, worker));
  return results;
}

/** Persist a rasterised overlay (data: URL from the renderer) to a temp PNG. */
function writeOverlayPng(dataUrl, index) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const file = path.join(OVERLAY_DIR, `ov_${process.pid}_${index}.png`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

const fx = (n) => Number(n).toFixed(3);

function buildKeyframeExpr(kfs, prop, defaultVal) {
  if (!kfs || kfs.length === 0) return fx(defaultVal);
  const sorted = kfs.filter(k => typeof k[prop] === 'number' && !isNaN(k[prop])).sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return fx(defaultVal);
  if (sorted.length === 1) return fx(sorted[0][prop]);
  let expr = fx(sorted[sorted.length - 1][prop]);
  for (let j = sorted.length - 2; j >= 0; j--) {
    const k0 = sorted[j];
    const k1 = sorted[j + 1];
    const dt = k1.time - k0.time;
    if (dt <= 0.001) {
      expr = 'if(lte(t,' + fx(k0.time) + '),' + fx(k0[prop]) + ',' + expr + ')';
    } else {
      const p = 'min(1,max(0,(t-' + fx(k0.time) + ')/' + fx(dt) + '))';
      const ease = '(' + p + '*' + p + '*(3-2*' + p + '))';
      const segVal = '(' + fx(k0[prop]) + '+(' + fx(k1[prop] - k0[prop]) + ')*' + ease + ')';
      expr = 'if(lte(t,' + fx(k1.time) + '),' + segVal + ',' + expr + ')';
    }
  }
  return expr;
}

/**
 * Detect and cache best hardware or software video encoder.
 */
const encoderCache = new Map();
async function getBestVideoEncoder(codec = 'hevc') {
  const norm = String(codec).toLowerCase();
  if (encoderCache.has(norm)) return encoderCache.get(norm);

  let candidates;
  if (norm === 'rle') {
    candidates = ['qtrle'];
  } else if (norm.startsWith('hevc')) {
    candidates = ['hevc_qsv', 'hevc_nvenc', 'hevc_amf', 'libx265'];
  } else if (norm === 'av1') {
    candidates = ['av1_qsv', 'av1_nvenc', 'libsvtav1', 'libaom-av1'];
  } else {
    candidates = ['h264_qsv', 'h264_nvenc', 'h264_amf', 'libx264'];
  }

  for (const cand of candidates) {
    const works = await new Promise((res) => {
      const p = spawn(FFMPEG, [
        '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x360:rate=30',
        '-c:v', cand, '-frames:v', '1', '-f', 'null', '-'
      ], { windowsHide: true });
      p.on('close', (code) => res(code === 0));
      p.on('error', () => res(false));
    });
    if (works) {
      encoderCache.set(norm, cand);
      return cand;
    }
  }

  const fallback = norm === 'rle' ? 'qtrle' : (norm.startsWith('hevc') ? 'libx265' : (norm === 'av1' ? 'libaom-av1' : 'libx264'));
  encoderCache.set(norm, fallback);
  return fallback;
}

async function detectHardwareEncoders() {
  const [h264, hevc, av1] = await Promise.all([
    getBestVideoEncoder('h264'),
    getBestVideoEncoder('hevc'),
    getBestVideoEncoder('av1')
  ]);
  return { h264, hevc, av1 };
}

/**
 * Merge contiguous video or audio clips from the same source file without transitions.
 * Eliminates Windows 32KB command line limits and overlay memory crashes for multi-hundred clip projects.
 */
function mergeContiguousClips(clips) {
  if (!Array.isArray(clips) || clips.length <= 1) return clips ? [...clips] : [];
  const merged = [];
  let cur = null;

  for (const c of clips) {
    if (!cur) {
      cur = { ...c };
      continue;
    }

    const sameSrc = cur.src === c.src;
    const sameTrack = (cur.trackId ?? cur.layer ?? 0) === (c.trackId ?? c.layer ?? 0);
    const contiguousTime = Math.abs((cur.start + (cur.outPoint - cur.inPoint)) - c.start) < 0.008;
    const contiguousSource = Math.abs(cur.outPoint - c.inPoint) < 0.008;
    const noTransition = (!cur.transition || cur.transition === 'none') && (!c.transition || c.transition === 'none');
    const noFilter = (!cur.filterFf || cur.filterFf === 'none') && (!c.filterFf || c.filterFf === 'none');
    const noEffect = (!cur.effectFf || cur.effectFf === 'none') && (!c.effectFf || c.effectFf === 'none');
    const sameTransform = (cur.scale ?? 1) === (c.scale ?? 1) &&
      (cur.rotation ?? 0) === (c.rotation ?? 0) &&
      (cur.opacity ?? 1) === (c.opacity ?? 1) &&
      (cur.x ?? 0.5) === (c.x ?? 0.5) &&
      (cur.y ?? 0.5) === (c.y ?? 0.5) &&
      (cur.fitMode ?? 'contain') === (c.fitMode ?? 'contain') &&
      (!cur.keyframes || cur.keyframes.length === 0) &&
      (!c.keyframes || c.keyframes.length === 0);
    const sameAudio = (cur.volume ?? 1) === (c.volume ?? 1) && !!cur.hasAudio === !!c.hasAudio;

    if (sameSrc && sameTrack && contiguousTime && contiguousSource && noTransition && noFilter && noEffect && sameTransform && sameAudio) {
      cur.outPoint = c.outPoint;
    } else {
      merged.push(cur);
      cur = { ...c };
    }
  }

  if (cur) merged.push(cur);
  return merged;
}

/** Render absolute timeline positions, including gaps, stacked tracks, and CapCut export specifications. */
async function exportTimeline(spec, onProgress) {
  const {clips = [], audio = [], overlays = [], width, height, fps, outPath} = spec;
  const isMp3 = spec.format === 'mp3' || String(outPath).toLowerCase().endsWith('.mp3');
  const duration = (typeof spec.duration === 'number' && spec.duration > 0)
    ? spec.duration
    : Math.max(0, ...clips.map(c=>c.start+c.outPoint-c.inPoint), ...audio.map(c=>c.start+c.outPoint-c.inPoint), ...overlays.map(o=>o.end));
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw new Error('Timeline duration must be between 0 and 24 hours.');

  const startTime = Date.now();
  let lastPct = -1;

  if (isMp3) {
    const args = ['-y'];
    const graph = [];
    const tempFiles = [];
    let index = 0;

    // Base quiet audio track for the entire duration
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    const baseAudio = index++;
    graph.push('[' + baseAudio + ':a]atrim=duration=' + duration + ',asetpts=PTS-STARTPTS[quiet]');
    const sounds = ['[quiet]'];

    const mergedAudio = mergeContiguousClips(audio);

    // Extract audio from video clips only if they have audio and are not muted
    const mergedVideoClips = mergeContiguousClips(clips);
    mergedVideoClips.forEach((c, i) => {
      if (c.hasAudio && c.kind !== 'image' && (c.volume ?? 1) > 0.001) {
        const d = c.outPoint - c.inPoint;
        if (d > 0) {
          args.push('-ss', String(c.inPoint), '-t', String(d), '-i', c.src);
          const input = index++;
          const delay = Math.round(c.start * 1000);
          graph.push(
            '[' + input + ':a]atrim=duration=' + d +
            ',asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=' +
            fx(c.volume ?? 1) + ',adelay=' + delay + ':all=1[sound' + i + ']'
          );
          sounds.push('[sound' + i + ']');
        }
      }
    });

    // Audio clips (voiceover, BGM, sfx)
    mergedAudio.forEach((a, k) => {
      const d = a.outPoint - a.inPoint;
      if (d > 0) {
        args.push('-ss', String(a.inPoint), '-t', String(d), '-i', a.src);
        const input = index++;
        const delay = Math.round(a.start * 1000);
        graph.push(
          '[' + input + ':a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=' +
          fx(a.volume ?? 1) + ',adelay=' + delay + ':all=1[extra' + k + ']'
        );
        sounds.push('[extra' + k + ']');
      }
    });

    const isWav = spec.format === 'wav';
    const isAac = spec.format === 'aac';
    const bitrate = spec.audioBitrate || (spec.quality === 'high' ? '320k' : spec.quality === 'draft' ? '128k' : '192k');
    graph.push(sounds.join('') + 'amix=inputs=' + sounds.length + ':normalize=0:duration=first,atrim=duration=' + fx(duration) + '[aout]');

    args.push('-filter_complex', graph.join(';'), '-map', '[aout]', '-t', String(duration));
    if (isWav) {
      args.push('-c:a', 'pcm_s16le');
    } else if (isAac) {
      args.push('-c:a', 'aac', '-b:a', bitrate);
    } else {
      args.push('-c:a', 'libmp3lame', '-b:a', bitrate);
    }
    args.push('-progress', 'pipe:1', '-nostats', outPath);

    return new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG, args, { windowsHide: true });
      activeExportProcess = proc;
      let stderr = '', progress = '';
      const cleanup = () => {
        activeExportProcess = null;
        for (const file of tempFiles) { try { fs.unlinkSync(file); } catch {} }
      };
      proc.stdout.on('data', b => {
        progress += b.toString();
        const lines = progress.split('\n'); progress = lines.pop() || '';
        for (const line of lines) {
          const mTime = /^out_time_us=(\d+)/.exec(line);
          const mSpeed = /^speed=\s*([\d\.]+)x/.exec(line);
          if (mTime) {
            const curSec = +mTime[1] / 1e6;
            const pct = Math.min(99, Math.round(curSec / duration * 100));
            const spd = mSpeed ? parseFloat(mSpeed[1]) : (pct > 0 ? curSec / Math.max(1, (Date.now() - startTime) / 1000) : 1);
            const remSec = spd > 0 ? Math.max(0, Math.round((duration - curSec) / spd)) : null;
            if (pct !== lastPct) {
              lastPct = pct;
              onProgress?.({ pct, speed: spd ? `${spd.toFixed(1)}x` : undefined, remainingSec: remSec });
            }
          }
        }
      });
      proc.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-12000); });
      proc.on('error', e => { cleanup(); reject(e); });
      proc.on('close', code => {
        cleanup();
        if (code === 0) { onProgress?.({ pct: 100 }); resolve(outPath); }
        else reject(new Error(stderr.split('\n').slice(-16).join('\n') || 'Audio export failed.'));
      });
    });
  }

  if (![width,height].every(v=>Number.isInteger(v)&&v>=16&&v<=7680&&v%2===0) || !(fps>=1&&fps<=120)) throw new Error('Invalid export dimensions or frame rate.');

  // Pre-merge contiguous clips to prevent ENAMETOOLONG & massive overlay graphs
  const mergedClips = mergeContiguousClips(clips);
  const mergedAudio = mergeContiguousClips(audio);

  const chosenCodec = spec.codec || 'hevc';
  const encoder = await getBestVideoEncoder(chosenCodec);
  const isHwEncoder = encoder.includes('qsv') || encoder.includes('nvenc') || encoder.includes('amf');

  const args = ['-y','-filter_complex_threads','0'];
  const graph = [];
  const tempFiles = [];
  let index = 0;

  const sorted = mergedClips.map((c,i)=>({...c,_original:i})).sort((a,b)=>(a.layer||0)-(b.layer||0)||a.start-b.start||a._original-b._original);

  const isSingleFullScreen = sorted.length === 1 && overlays.length === 0 &&
    (sorted[0].opacity ?? 1) === 1 && (!sorted[0].keyframes || sorted[0].keyframes.length === 0) &&
    (sorted[0].scale ?? 1) === 1 && (sorted[0].rotation ?? 0) === 0 &&
    (sorted[0].x ?? 0.5) === 0.5 && (sorted[0].y ?? 0.5) === 0.5 &&
    sorted[0].start === 0;

  const BLACK_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const blackPngPath = path.join(OVERLAY_DIR, 'black_1x1.png');
  if (!fs.existsSync(blackPngPath)) {
    try { fs.writeFileSync(blackPngPath, Buffer.from(BLACK_PNG_BASE64, 'base64')); } catch {}
  }
  tempFiles.push(blackPngPath);

  // Concat Demuxer is eligible for any standard cut sequence or any large project (>50 clips) to prevent Windows ENAMETOOLONG
  const isConcatDemuxerEligible = sorted.length > 1 && (
    sorted.length > 50 ||
    sorted.every((c) => (c.opacity ?? 1) === 1 &&
      (!c.keyframes || c.keyframes.length === 0) &&
      (c.scale ?? 1) === 1 && (c.rotation ?? 0) === 0 &&
      (c.x ?? 0.5) === 0.5 && (c.y ?? 0.5) === 0.5 &&
      (!c.transition || c.transition === 'none') &&
      (!c.filterFf || c.filterFf === 'none') &&
      (!c.effectFf || c.effectFf === 'none')
    )
  );

  const needsBlackCanvas = !isSingleFullScreen && !isConcatDemuxerEligible;

  if (needsBlackCanvas) {
    args.push('-f','lavfi','-i','color=c=black:s='+width+'x'+height+':r='+fps+':d='+duration);
    const baseVideo = index++;
    graph.push('['+baseVideo+':v]settb=AVTB,format=yuv420p[base]');
  }

  args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
  const baseAudio = index++;
  graph.push('['+baseAudio+':a]atrim=duration='+duration+',asetpts=PTS-STARTPTS[quiet]');
  const sounds = ['[quiet]'];

  let vCurrent = '[base]';

  try {
    if (isConcatDemuxerEligible) {
      const manifestFile = path.join(OVERLAY_DIR, 'concat_' + process.pid + '_' + crypto.randomBytes(6).toString('hex') + '.txt');
      tempFiles.push(manifestFile);
      const lines = ['ffconcat version 1.0'];

      // Build a gap-filled, overlap-resolved continuous stream of clips from 0 to duration
      let currentTime = 0;
      for (let i = 0; i < sorted.length; i++) {
        const c = sorted[i];

        // 1. Fill any gap before clip with black canvas
        if (c.start > currentTime + 0.03) {
          const gap = c.start - currentTime;
          lines.push(`file '${blackPngPath.replace(/\\/g, '/')}'`);
          lines.push(`duration ${gap.toFixed(3)}`);
          currentTime = c.start;
        }

        // 2. Determine actual duration of this clip, cleanly resolving any slight overlap with next clip
        const origDur = Math.max(0.04, c.outPoint - c.inPoint);
        const nextStart = (i + 1 < sorted.length) ? sorted[i + 1].start : duration;
        let actualDur = origDur;
        if (nextStart < c.start + origDur - 0.01) {
          actualDur = Math.max(0.04, nextStart - c.start);
        }

        if (c.kind === 'image') {
          lines.push(`file '${c.src.replace(/\\/g, '/')}'`);
          lines.push(`duration ${actualDur.toFixed(3)}`);
        } else {
          lines.push(`file '${c.src.replace(/\\/g, '/')}'`);
          lines.push(`inpoint ${c.inPoint.toFixed(3)}`);
          lines.push(`outpoint ${(c.inPoint + actualDur).toFixed(3)}`);
        }
        currentTime = c.start + actualDur;
      }

      // 3. Trailing gap to end of duration if needed
      if (currentTime < duration - 0.03) {
        const gap = duration - currentTime;
        lines.push(`file '${blackPngPath.replace(/\\/g, '/')}'`);
        lines.push(`duration ${gap.toFixed(3)}`);
      }

      fs.writeFileSync(manifestFile, lines.join('\n'));

      if (isHwEncoder) {
        args.push('-hwaccel', 'd3d11va');
      }
      args.push('-f', 'concat', '-safe', '0', '-i', manifestFile);
      const concatInput = index++;
      const baseFit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
      graph.push(`[${concatInput}:v]${baseFit},setsar=1,fps=${fps},settb=AVTB,format=yuv420p[vconcat]`);
      vCurrent = '[vconcat]';

      if (sorted.some((c) => c.hasAudio && c.kind !== 'image' && (c.volume ?? 1) > 0.001)) {
        graph.push(`[${concatInput}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${fx(sorted[0].volume ?? 1)}[sound_concat]`);
        sounds.push('[sound_concat]');
      }
    } else if (isSingleFullScreen) {
      const c = sorted[0];
      const d = c.outPoint - c.inPoint;
      if (c.kind === 'image') args.push('-loop', '1', '-framerate', String(fps), '-t', String(d), '-i', c.src);
      else {
        if (isHwEncoder) args.push('-hwaccel', 'd3d11va');
        args.push('-ss', String(c.inPoint), '-t', String(d), '-i', c.src);
      }
      const input = index++;
      const baseFit = (c.fitMode === 'cover')
        ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
        : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
      graph.push(`[${input}:v]${baseFit},setsar=1,fps=${fps},settb=AVTB,format=yuv420p[clip0]`);
      vCurrent = '[clip0]';

      if (c.hasAudio && c.kind !== 'image') {
        graph.push(`[${input}:a]atrim=duration=${d},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${fx(c.volume ?? 1)}[sound0]`);
        sounds.push('[sound0]');
      }
    } else {
      sorted.forEach((c,i)=>{
        const d=c.outPoint-c.inPoint;
        if (!(d>0) || !(c.start>=0)) throw new Error('Invalid clip timing.');
        if(c.kind==='image') args.push('-loop','1','-framerate',String(fps),'-t',String(d),'-i',c.src);
        else {
          if (isHwEncoder) args.push('-hwaccel', 'd3d11va');
          args.push('-ss',String(c.inPoint),'-t',String(d),'-i',c.src);
        }
        const input=index++;
        const hasKfs = Array.isArray(c.keyframes) && c.keyframes.length > 0;
        const scaleFactor = (typeof c.scale === 'number' && c.scale > 0) ? c.scale : 1;
        const baseFit = (c.fitMode === 'cover')
          ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
          : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;

        const filters = ['setpts=PTS-STARTPTS', baseFit];

        if (hasKfs) {
          const scaleExpr = buildKeyframeExpr(c.keyframes, 'scale', scaleFactor);
          filters.push(`scale=w='2*trunc((${width}*(${scaleExpr}))/2)':h='2*trunc((${height}*(${scaleExpr}))/2)':eval=frame`);
          const rotExpr = buildKeyframeExpr(c.keyframes, 'rotation', c.rotation || 0);
          filters.push(`rotate='PI/180*(${rotExpr})':c=none`);
        } else {
          if (scaleFactor !== 1) {
            filters.push(`scale=${Math.round(width * scaleFactor)}:${Math.round(height * scaleFactor)}:force_original_aspect_ratio=decrease`);
          }
          if (c.rotation) {
            filters.push(`rotate=${(c.rotation * Math.PI / 180).toFixed(4)}:c=none`);
          }
        }

        filters.push('setsar=1','fps='+fps,'settb=AVTB');
        if(c.filterFf)filters.push(c.filterFf);
        if(c.effectFf)filters.push(c.effectFf);
        filters.push('trim=duration='+d,'setpts=PTS-STARTPTS','format=yuv420p');
        graph.push('['+input+':v]'+filters.join(',')+'[clip'+i+']');
        if(c.hasAudio && c.kind!=='image') {
          const delay=Math.round(c.start*1000);
          graph.push('['+input+':a]atrim=duration='+d+',asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume='+fx(c.volume??1)+',adelay='+delay+':all=1[sound'+i+']');
          sounds.push('[sound'+i+']');
        }
      });

      let groupIndex=0;
      for(let i=0;i<sorted.length;) {
        const first=sorted[i], groupStart=first.start;
        let chain='[clip'+i+']', end=first.start+first.outPoint-first.inPoint, last=i;
        while(last+1<sorted.length) {
          const previous=sorted[last], next=sorted[last+1];
          const sameTrack=(previous.trackId??previous.layer??0)===(next.trackId??next.layer??0);
          if(!previous.transition||!sameTrack||Math.abs(next.start-end)>0.002|| (previous.opacity??1)!==1 || (next.opacity??1)!==1)break;
          const td=Math.min(previous.transitionDuration||0.6,(previous.outPoint-previous.inPoint)*0.9,(next.outPoint-next.inPoint)*0.9);
          if(td<0.04)break;
          const held='held'+last, joined='joined'+last;
          graph.push(chain+'tpad=stop_mode=clone:stop_duration='+fx(td)+'['+held+']');
          graph.push('['+held+'][clip'+(last+1)+']xfade=transition='+previous.transition+':duration='+fx(td)+':offset='+fx(end-groupStart)+'['+joined+']');
          chain='['+joined+']';end=next.start+next.outPoint-next.inPoint;last++;
        }
        const timed='timed'+groupIndex, out='layer'+groupIndex;
        const hasOpacityKf = Array.isArray(first.keyframes) && first.keyframes.some(k => typeof k.opacity === 'number');
        if (hasOpacityKf) {
          const opExpr = buildKeyframeExpr(first.keyframes, 'opacity', first.opacity ?? 1);
          graph.push(chain+`format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*min(1,max(0,${opExpr}))',setpts=PTS-STARTPTS+`+fx(groupStart)+'/TB['+timed+']');
        } else {
          graph.push(chain+'format=rgba,colorchannelmixer=aa='+fx(first.opacity??1)+',setpts=PTS-STARTPTS+'+fx(groupStart)+'/TB['+timed+']');
        }

        const hasPosKf = Array.isArray(first.keyframes) && first.keyframes.some(k => typeof k.x === 'number' || typeof k.y === 'number');
        let overlayX = '(main_w-overlay_w)/2';
        let overlayY = '(main_h-overlay_h)/2';
        if (hasPosKf) {
          const xRelExpr = buildKeyframeExpr(first.keyframes, 'x', first.x ?? 0.5);
          const yRelExpr = buildKeyframeExpr(first.keyframes, 'y', first.y ?? 0.5);
          overlayX = `((main_w-overlay_w)/2+(${width}*((${xRelExpr})-0.5)))`;
          overlayY = `((main_h-overlay_h)/2+(${height}*((${yRelExpr})-0.5)))`;
        } else {
          const xOff = Math.round(((first.x ?? 0.5) - 0.5) * width);
          const yOff = Math.round(((first.y ?? 0.5) - 0.5) * height);
          if (xOff !== 0) overlayX = `((main_w-overlay_w)/2+${xOff})`;
          if (yOff !== 0) overlayY = `((main_h-overlay_h)/2+${yOff})`;
        }

        graph.push(vCurrent+'['+timed+`]overlay=x='${overlayX}':y='${overlayY}':eval=frame:eof_action=pass:repeatlast=0:enable='gte(t,`+fx(groupStart)+')*lt(t,'+fx(end)+')\'['+out+']');
        vCurrent='['+out+']';groupIndex++;i=last+1;
      }
    }

    overlays.forEach((o,k)=>{
      const file=path.join(OVERLAY_DIR,'ov_'+process.pid+'_'+crypto.randomBytes(6).toString('hex')+'.png');
      tempFiles.push(file);
      fs.writeFileSync(file,Buffer.from(o.dataUrl.replace(/^data:image\/png;base64,/,''),'base64'));
      args.push('-loop','1','-framerate',String(fps),'-t',String(duration),'-i',file);
      const input=index++;
      graph.push('['+input+':v]format=rgba,colorchannelmixer=aa='+fx(o.opacity??1)+'[overlay'+k+']');
      graph.push(vCurrent+'[overlay'+k+']overlay=x='+Math.round(o.x)+':y='+Math.round(o.y)+':eof_action=pass:enable=\'gte(t,'+fx(o.start)+')*lt(t,'+fx(o.end)+')\'[text'+k+']');
      vCurrent='[text'+k+']';
    });

    mergedAudio.forEach((a,k)=>{
      args.push('-ss',String(a.inPoint),'-t',String(a.outPoint-a.inPoint),'-i',a.src);
      const input=index++,delay=Math.round(a.start*1000);
      graph.push('['+input+':a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume='+fx(a.volume??1)+',adelay='+delay+':all=1[extra'+k+']');
      sounds.push('[extra'+k+']');
    });

    graph.push(vCurrent+'format=yuv420p[vout]');
    graph.push(sounds.join('')+'amix=inputs='+sounds.length+':normalize=0:duration=first,atrim=duration='+fx(duration)+'[aout]');

    // Calculate resolution-proportional bitrate
    const basePixels = (width || 1920) * (height || 1080) * (fps || 30);
    const standardBitrate = Math.round((basePixels / (1920 * 1080 * 30)) * 8000); // 8000 kbps for 1080p30
    let targetBitrate = standardBitrate;
    if (spec.customBitrate && Number(spec.customBitrate) > 0) {
      targetBitrate = Number(spec.customBitrate);
    } else if (spec.bitrateMode === 'higher' || spec.quality === 'high') {
      targetBitrate = Math.round(standardBitrate * 1.5);
    } else if (spec.bitrateMode === 'lower' || spec.quality === 'draft') {
      targetBitrate = Math.round(standardBitrate * 0.5);
    }

    const isCbr = spec.bitrateMode === 'cbr';

    args.push('-filter_complex', graph.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', String(duration));
    args.push('-c:v', encoder);

    if (encoder.includes('qsv')) {
      const qsvPreset = spec.quality === 'high' ? 'faster' : 'veryfast';
      args.push('-preset', qsvPreset, '-async_depth', '8');
      if (isCbr) {
        args.push('-b:v', `${targetBitrate}k`, '-maxrate', `${targetBitrate}k`, '-bufsize', `${targetBitrate * 2}k`);
      } else {
        args.push('-b:v', `${targetBitrate}k`, '-maxrate', `${Math.round(targetBitrate * 1.5)}k`, '-bufsize', `${targetBitrate * 2}k`);
      }
    } else if (encoder.includes('nvenc')) {
      const nvPreset = spec.quality === 'high' ? 'p4' : 'p2';
      args.push('-preset', nvPreset);
      if (isCbr) {
        args.push('-b:v', `${targetBitrate}k`, '-cbr', '1', '-bufsize', `${targetBitrate * 2}k`);
      } else {
        args.push('-b:v', `${targetBitrate}k`, '-maxrate', `${Math.round(targetBitrate * 1.5)}k`, '-bufsize', `${targetBitrate * 2}k`);
      }
    } else {
      // libx264 / libx265 / libaom-av1 / qtrle
      if (encoder === 'qtrle') {
        // QuickTime Animation (RLE)
      } else {
        const preset = spec.quality === 'draft' ? 'ultrafast' : (spec.quality === 'high' ? 'fast' : 'veryfast');
        args.push('-preset', preset);
        if (isCbr) {
          args.push('-b:v', `${targetBitrate}k`, '-minrate', `${targetBitrate}k`, '-maxrate', `${targetBitrate}k`, '-bufsize', `${targetBitrate * 2}k`);
        } else if (spec.customBitrate) {
          args.push('-b:v', `${targetBitrate}k`, '-maxrate', `${Math.round(targetBitrate * 1.5)}k`, '-bufsize', `${targetBitrate * 2}k`);
        } else {
          const crf = chosenCodec.startsWith('hevc') ? '24' : '20';
          args.push('-crf', crf);
        }
      }
    }

    const isMov = spec.format === 'mov' || chosenCodec === 'rle';
    if (chosenCodec === 'rle') {
      args.push('-pix_fmt', 'argb');
    } else if (chosenCodec === 'hevc_422') {
      args.push('-pix_fmt', 'yuv422p');
    } else {
      args.push('-pix_fmt', 'yuv420p');
    }
    args.push('-c:a', 'aac', '-b:a', spec.audioBitrate || '192k');
    if (!isMov) {
      args.push('-movflags', '+faststart');
    }
    args.push('-progress', 'pipe:1', '-nostats', outPath);

    return new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG, args, { windowsHide: true });
      activeExportProcess = proc;
      let stderr = '', progress = '';
      proc.stdout.on('data', b => {
        progress += b.toString();
        const lines = progress.split('\n'); progress = lines.pop() || '';
        for (const line of lines) {
          const mTime = /^out_time_us=(\d+)/.exec(line);
          const mSpeed = /^speed=\s*([\d\.]+)x/.exec(line);
          const mFps = /^fps=\s*([\d\.]+)/.exec(line);
          if (mTime) {
            const curSec = +mTime[1] / 1e6;
            const pct = Math.min(99, Math.round(curSec / duration * 100));
            const spd = mSpeed ? parseFloat(mSpeed[1]) : (pct > 0 ? curSec / Math.max(1, (Date.now() - startTime) / 1000) : 1);
            const remSec = spd > 0 ? Math.max(0, Math.round((duration - curSec) / spd)) : null;
            if (pct !== lastPct) {
              lastPct = pct;
              onProgress?.({
                pct,
                speed: spd ? `${spd.toFixed(1)}x` : undefined,
                fps: mFps ? Math.round(parseFloat(mFps[1])) : undefined,
                remainingSec: remSec
              });
            }
          }
        }
      });
      proc.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-12000); });
      const cleanup = () => {
        activeExportProcess = null;
        for (const file of tempFiles) { try { fs.unlinkSync(file); } catch {} }
      };
      proc.on('error', e => { cleanup(); reject(e); });
      proc.on('close', code => {
        cleanup();
        if (code === 0) {
          onProgress?.({ pct: 100 });
          resolve(outPath);
        } else {
          reject(new Error(stderr.split('\n').slice(-16).join('\n') || 'Export failed.'));
        }
      });
    });
  } catch (e) {
    for (const file of tempFiles) { try { fs.unlinkSync(file); } catch {} }
    throw e;
  }
}

/** Detect speech intervals separated by pauses using silencedetect. Instant and offline. */
async function detectSpeechSegments(filePath, { startOffset = 0, duration = null, minSilence = 0.25, noise = '-30dB' } = {}) {
  const info = await probe(filePath).catch(() => ({ hasAudio: false, duration: 0 }));
  const fileDuration = info.duration || 0;
  if (!info.hasAudio || fileDuration <= 0) return [];

  const effDuration = (typeof duration === 'number' && duration > 0)
    ? Math.min(duration, Math.max(0, fileDuration - startOffset))
    : Math.max(0, fileDuration - startOffset);
  if (effDuration <= 0) return [];

  return new Promise((resolve) => {
    const args = ['-hide_banner', '-nostats'];
    if (startOffset > 0) {
      args.push('-ss', String(startOffset));
    }
    if (effDuration > 0) {
      args.push('-t', String(effDuration));
    }
    // -vn -sn -dn ensures FFmpeg does not waste time decoding video or subtitles
    args.push(
      '-vn', '-sn', '-dn',
      '-i', filePath,
      '-af', `silencedetect=noise=${noise}:d=${minSilence}`,
      '-f', 'null',
      '-'
    );

    execFile(
      FFMPEG,
      args,
      { windowsHide: true, maxBuffer: 1024 * 1024 * 16, timeout: 180000 },
      (_err, _stdout, stderr = '') => {
        const silences = [];
        let curStart = null;
        for (const line of stderr.split('\n')) {
          const sM = /silence_start:\s*([0-9.]+)/.exec(line);
          if (sM) curStart = parseFloat(sM[1]);
          const eM = /silence_end:\s*([0-9.]+)/.exec(line);
          if (eM) {
            const end = parseFloat(eM[1]);
            const start = curStart !== null ? curStart : Math.max(0, end - minSilence);
            silences.push({ start, end });
            curStart = null;
          }
        }
        const speech = [];
        let pos = 0;
        for (const sil of silences) {
          if (sil.start > pos + 0.15) {
            speech.push({ start: pos, end: sil.start });
          }
          pos = sil.end;
        }
        if (pos < effDuration - 0.15) {
          speech.push({ start: pos, end: effDuration });
        }
        if (!speech.length && effDuration > 0) {
          speech.push({ start: 0, end: effDuration });
        }
        resolve(speech);
      }
    );
  });
}

/**
 * Detect scene changes / cut timestamps in a video file using FFmpeg's scene detection filter.
 * Returns an array of timestamps (in seconds) where scene transitions occurred.
 */
function detectSceneCuts(filePath, threshold = 0.35, options = {}) {
  let startOffset = 0;
  let duration = null;
  if (typeof options === 'number') {
    startOffset = options;
    duration = arguments[3] || null;
  } else if (options && typeof options === 'object') {
    startOffset = options.startOffset || 0;
    duration = options.duration || null;
  }

  return new Promise((resolve) => {
    const args = ['-hide_banner', '-nostats'];
    if (startOffset > 0) {
      args.push('-ss', String(startOffset));
    }
    const cappedDur = duration ? Math.min(25, duration) : 20;
    args.push('-t', String(cappedDur));
    args.push(
      '-i', filePath,
      '-vf', `scale=160:-2,select='gt(scene,${threshold})',showinfo`,
      '-f', 'null',
      '-'
    );
    const proc = spawn(FFMPEG, args, { windowsHide: true });

    const timestamps = [];
    let finished = false;
    const safeResolve = (res) => {
      if (finished) return;
      finished = true;
      try { clearTimeout(timer); } catch {}
      try { proc.kill(); } catch {}
      resolve(res);
    };

    const timer = setTimeout(() => {
      safeResolve(timestamps);
    }, 2500);

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      const regex = /pts_time:\s*([\d.]+)/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const rawT = parseFloat(match[1]);
        if (!isNaN(rawT) && rawT > 0.3) {
          const t = startOffset + rawT;
          if (!timestamps.length || (t - timestamps[timestamps.length - 1]) >= 0.5) {
            timestamps.push(Number(t.toFixed(3)));
          }
        }
      }
    });

    proc.on('close', () => safeResolve(timestamps));
    proc.on('error', () => safeResolve([]));
  });
}

const FREEZE_DIR = path.join(os.tmpdir(), 'capcut-editor-freeze');
fs.mkdirSync(FREEZE_DIR, { recursive: true });

/** Extract a single high-quality frame for CapCut Freeze feature */
async function extractFreezeFrame(videoPath, timestamp) {
  const hash = crypto.createHash('sha1').update(`${videoPath}-${timestamp}`).digest('hex').slice(0, 16);
  const outPath = path.join(FREEZE_DIR, `freeze_${hash}.jpg`);

  if (!fs.existsSync(outPath)) {
    await new Promise((resolve, reject) => {
      execFile(
        FFMPEG,
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-ss', String(Math.max(0, timestamp)),
          '-i', videoPath,
          '-frames:v', '1',
          '-q:v', '2',
          '-y',
          outPath
        ],
        { windowsHide: true },
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  return { ok: true, imagePath: outPath };
}

/**
 * Extract multiple freeze frames in parallel with caching for ultra-fast speed.
 * keyframeCache: array of { timestamp, base64 } or { timestamp, filePath }
 */
async function extractFreezeFrameBatch(videoPath, timestamps, keyframeCache = []) {
  const results = new Map(); // timestamp -> outPath
  const toExtract = [];

  for (const ts of timestamps) {
    const cleanTs = Math.max(0, Math.round(ts * 1000) / 1000);
    const hash = crypto.createHash('sha1').update(`${videoPath}-${cleanTs}`).digest('hex').slice(0, 16);
    const outPath = path.join(FREEZE_DIR, `freeze_${hash}.jpg`);

    // 1. Already exists on disk
    if (fs.existsSync(outPath)) {
      results.set(ts, outPath);
      continue;
    }

    // 2. Check if a keyframe in keyframeCache is within 0.45s
    const matchedKf = keyframeCache.find((kf) => Math.abs(kf.timestamp - cleanTs) <= 0.45);
    if (matchedKf && (matchedKf.base64 || matchedKf.filePath)) {
      try {
        if (matchedKf.filePath && fs.existsSync(matchedKf.filePath)) {
          fs.copyFileSync(matchedKf.filePath, outPath);
          results.set(ts, outPath);
          continue;
        } else if (matchedKf.base64) {
          fs.writeFileSync(outPath, Buffer.from(matchedKf.base64, 'base64'));
          results.set(ts, outPath);
          continue;
        }
      } catch {}
    }

    toExtract.push({ ts: cleanTs, origTs: ts, outPath });
  }

  // 3. Extract remaining in parallel batches of 2 workers (lightweight, zero lag)
  const concurrency = 2;
  for (let i = 0; i < toExtract.length; i += concurrency) {
    const batch = toExtract.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async ({ ts, origTs, outPath }) => {
        try {
          await new Promise((resolve, reject) => {
            execFile(
              FFMPEG,
              [
                '-hide_banner',
                '-loglevel', 'error',
                '-threads', '1',
                '-ss', String(ts),
                '-i', videoPath,
                '-an', '-sn',
                '-frames:v', '1',
                '-q:v', '3',
                '-y',
                outPath
              ],
              { windowsHide: true, timeout: 8000 },
              (err) => (err ? reject(err) : resolve())
            );
          });
          if (fs.existsSync(outPath)) {
            results.set(origTs, outPath);
          }
        } catch (err) {
          console.warn(`[FreezeBatch] Error extracting at ${ts}s:`, err.message);
        }
      })
    );
  }

  return results;
}

async function concatAudioFiles(files, outPath) {
  if (!files || files.length === 0) {
    throw new Error('No audio files to concatenate');
  }
  if (files.length === 1) {
    fs.copyFileSync(files[0], outPath);
    return outPath;
  }
  const manifestPath = path.join(path.dirname(outPath), `concat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`);
  const lines = files.map((f) => `file '${f.replace(/\\/g, '/')}'`);
  fs.writeFileSync(manifestPath, lines.join('\n'));
  try {
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', manifestPath,
      '-c', 'copy',
      outPath
    ]);
  } catch (err) {
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', manifestPath,
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      outPath
    ]);
  } finally {
    try { fs.unlinkSync(manifestPath); } catch {}
  }
  return outPath;
}

module.exports = { run, probe, thumbnails, framesAtTimestamps, extractWaveform, exportTimeline, cancelExport, detectHardwareEncoders, getBestVideoEncoder, detectSpeechSegments, detectSceneCuts, extractFreezeFrame, extractFreezeFrameBatch, concatAudioFiles, FFMPEG, FFPROBE };


