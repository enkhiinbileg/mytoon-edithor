'use strict';
/**
 * Freeze-frame self-healing.
 *
 * Freeze frames used to live in %TEMP%\capcut-editor-freeze, which Windows
 * cleans up periodically. When that happens every freeze clip renders black.
 * On project load we:
 *   1. Copy any still-existing legacy temp freeze into the persistent folder.
 *   2. For missing files, recover the exact source timestamp (the file name is
 *      sha1(`${videoPath}-${timestamp}`)) and re-extract the frame from the
 *      original video.
 *   3. Point the media item at the persistent file.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const ff = require('./ffmpeg');

const FREEZE_NAME = /^freeze_([0-9a-f]{16})\.jpg$/i;

function pathToMediaUrl(filePath) {
  return 'media://local/' + filePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}

const hash = (videoPath, ts) => crypto.createHash('sha1').update(`${videoPath}-${ts}`).digest('hex').slice(0, 16);

function recoverTimestamp(target, videoPaths, candidates, approxSec) {
  for (const v of videoPaths) {
    for (const ts of candidates) if (hash(v, ts) === target) return { videoPath: v, ts, exact: true };
  }
  if (Number.isFinite(approxSec)) {
    for (const v of videoPaths) {
      const lo = Math.max(0, Math.round((approxSec - 2) * 1000));
      const hi = Math.round((approxSec + 120) * 1000);
      for (let ms = lo; ms <= hi; ms++) {
        const ts = ms / 1000;
        if (hash(v, ts) === target) return { videoPath: v, ts, exact: true };
      }
    }
    // Last resort: approximate second from the media name.
    if (videoPaths[0]) return { videoPath: videoPaths[0], ts: approxSec, exact: false };
  }
  return null;
}

function extractFrame(videoPath, ts, outPath) {
  return new Promise((resolve) => {
    execFile(ff.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, ts)), '-i', videoPath,
      '-frames:v', '1', '-q:v', '2', '-y', outPath], { windowsHide: true, timeout: 20000 },
      () => resolve(fs.existsSync(outPath) && fs.statSync(outPath).size > 0));
  });
}

/** Mutates `data.media` in place. Returns { fixed, failed }. */
async function healFreezeMedia(data, freezeDir, onLog = () => {}) {
  const media = Array.isArray(data?.media) ? data.media : [];
  const broken = media.filter((m) => m && m.kind === 'image' && typeof m.path === 'string'
    && FREEZE_NAME.test(path.basename(m.path))
    && (path.dirname(path.resolve(m.path)) !== path.resolve(freezeDir) || !fs.existsSync(m.path)));
  if (!broken.length) return { fixed: 0, failed: 0 };

  fs.mkdirSync(freezeDir, { recursive: true });
  const videos = media.filter((m) => m.kind === 'video' && m.path && fs.existsSync(m.path));
  const videoPaths = videos.map((m) => m.path);
  const videoIds = new Set(videos.map((m) => m.id));
  const cand = new Set();
  for (const c of data.clips || []) {
    if (!videoIds.has(c.mediaId)) continue;
    for (const v of [c.inPoint, c.outPoint]) {
      if (Number.isFinite(v)) { cand.add(v); cand.add(Math.round(v * 1000) / 1000); }
    }
  }
  const candidates = [...cand];

  let fixed = 0, failed = 0;
  const queue = broken.slice();
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      const base = path.basename(m.path);
      const dest = path.join(freezeDir, base);
      let ok = fs.existsSync(dest);
      if (!ok && fs.existsSync(m.path)) {
        try { fs.copyFileSync(m.path, dest); ok = true; } catch {}
      }
      if (!ok && videoPaths.length) {
        const target = base.match(FREEZE_NAME)[1].toLowerCase();
        const approx = parseFloat((String(m.name || '').match(/@\s*([\d.]+)s/) || [])[1]);
        const found = recoverTimestamp(target, videoPaths, candidates, approx);
        if (found) {
          ok = await extractFrame(found.videoPath, found.ts, dest);
          if (ok && !found.exact) onLog(`[FreezeHeal] ${m.name}: approximate timestamp ${found.ts}s used`);
        }
      }
      if (ok) {
        m.path = dest;
        m.thumbs = [pathToMediaUrl(dest)];
        fixed++;
      } else {
        failed++;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  onLog(`[FreezeHeal] fixed ${fixed}, failed ${failed}`);
  return { fixed, failed };
}

module.exports = { healFreezeMedia };
