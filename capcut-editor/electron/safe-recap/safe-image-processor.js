'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const ff = require('../ffmpeg');

function clamp01(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeCropRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = clamp01(rect.x, 0);
  const y = clamp01(rect.y, 0);
  const w = Math.max(0.05, Math.min(1 - x, clamp01(rect.w, 1)));
  const h = Math.max(0.05, Math.min(1 - y, clamp01(rect.h, 1)));
  if (x <= 0.002 && y <= 0.002 && w >= 0.996 && h >= 0.996) return null;
  return { x, y, w, h };
}

function normalizeCensorBoxes(boxes) {
  if (!Array.isArray(boxes)) return [];
  return boxes
    .filter((b) => b && typeof b === 'object')
    .map((b, idx) => {
      const x = clamp01(b.x, 0);
      const y = clamp01(b.y, 0);
      const w = Math.max(0.02, Math.min(1 - x, clamp01(b.w, 0.1)));
      const h = Math.max(0.02, Math.min(1 - y, clamp01(b.h, 0.1)));
      const mode = ['blur', 'mosaic', 'bar', 'glow'].includes(b.mode) ? b.mode : 'blur';
      const strength = Number.isFinite(Number(b.strength)) ? Math.max(4, Math.min(40, Number(b.strength))) : 22;
      return { id: b.id || `cb_${idx}`, x, y, w, h, mode, strength };
    });
}

function buildCacheKey({ imagePath, cropRect, censorBoxes, maxWidth = 0 }) {
  let statSig = 'missing';
  try {
    const st = fs.statSync(imagePath);
    statSig = `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {}
  return crypto
    .createHash('sha1')
    .update(JSON.stringify({ imagePath, statSig, cropRect, censorBoxes, maxWidth }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Builds an FFmpeg filtergraph (and outputs final pixel dimensions) that:
 * 1. Applies localized censor boxes (blur/mosaic/bar/glow) in original coordinates.
 * 2. Crops to safe cropRect (if present).
 * 3. Scales down to maxWidth (for lightweight Gemini/preview thumbnails) when requested.
 */
function buildSanitizeFilter({ origW, origH, cropRect, censorBoxes, maxWidth = 0 }) {
  const safeW = Math.max(16, Number(origW) || 1080);
  const safeH = Math.max(16, Number(origH) || 1440);
  const normCrop = normalizeCropRect(cropRect);
  const normBoxes = normalizeCensorBoxes(censorBoxes);

  const steps = [];
  let curLabel = '0:v';
  let stepIdx = 0;

  // Step 1: Apply localized censor masks in original image space
  for (const box of normBoxes) {
    const px = Math.max(0, Math.min(safeW - 4, Math.round(box.x * safeW)));
    const py = Math.max(0, Math.min(safeH - 4, Math.round(box.y * safeH)));
    const pw = Math.max(4, Math.min(safeW - px, Math.round(box.w * safeW)));
    const ph = Math.max(4, Math.min(safeH - py, Math.round(box.h * safeH)));

    const nextLabel = `c_${stepIdx++}`;
    if (box.mode === 'bar') {
      steps.push(`[${curLabel}]drawbox=x=${px}:y=${py}:w=${pw}:h=${ph}:color=black@0.98:t=fill[${nextLabel}]`);
      curLabel = nextLabel;
      continue;
    }

    const baseLbl = `b_${stepIdx}`;
    const srcLbl = `s_${stepIdx}`;
    const maskLbl = `m_${stepIdx}`;
    steps.push(`[${curLabel}]split=2[${baseLbl}][${srcLbl}]`);

    if (box.mode === 'mosaic') {
      const cellSize = Math.max(8, Math.round((box.strength || 22) * 0.85));
      const mw = Math.max(3, Math.round(pw / cellSize));
      const mh = Math.max(3, Math.round(ph / cellSize));
      steps.push(
        `[${srcLbl}]crop=w=${pw}:h=${ph}:x=${px}:y=${py},scale=${mw}:${mh}:flags=neighbor,scale=${pw}:${ph}:flags=neighbor[${maskLbl}]`
      );
    } else if (box.mode === 'glow') {
      const maxRad = Math.max(1, Math.floor((Math.min(pw, ph) - 1) / 2));
      const rad = Math.min(maxRad, Math.max(2, Math.round(box.strength || 22)));
      steps.push(
        `[${srcLbl}]crop=w=${pw}:h=${ph}:x=${px}:y=${py},boxblur=luma_radius=${rad}:luma_power=2,eq=brightness=0.52:contrast=0.52[${maskLbl}]`
      );
    } else {
      // 'blur'
      const maxRad = Math.max(1, Math.floor((Math.min(pw, ph) - 1) / 2));
      const rad = Math.min(maxRad, Math.max(2, Math.round(box.strength || 22)));
      steps.push(`[${srcLbl}]crop=w=${pw}:h=${ph}:x=${px}:y=${py},boxblur=luma_radius=${rad}:luma_power=2[${maskLbl}]`);
    }

    steps.push(`[${baseLbl}][${maskLbl}]overlay=x=${px}:y=${py}[${nextLabel}]`);
    curLabel = nextLabel;
  }

  // Step 2: Apply safe CropRect
  let outW = safeW;
  let outH = safeH;
  if (normCrop) {
    const cx = Math.max(0, Math.min(safeW - 4, Math.round(normCrop.x * safeW)));
    const cy = Math.max(0, Math.min(safeH - 4, Math.round(normCrop.y * safeH)));
    let cw = Math.max(4, Math.min(safeW - cx, Math.round(normCrop.w * safeW)));
    let ch = Math.max(4, Math.min(safeH - cy, Math.round(normCrop.h * safeH)));
    // Keep even dimensions for H.264/yuv420p compatibility
    cw = Math.max(4, cw - (cw % 2));
    ch = Math.max(4, ch - (ch % 2));
    const nextLabel = `crop_${stepIdx++}`;
    steps.push(`[${curLabel}]crop=w=${cw}:h=${ch}:x=${cx}:y=${cy}[${nextLabel}]`);
    curLabel = nextLabel;
    outW = cw;
    outH = ch;
  }

  // Step 3: Optional resize for thumbnails
  if (maxWidth > 0 && outW > maxWidth) {
    const nextLabel = `sc_${stepIdx++}`;
    steps.push(`[${curLabel}]scale=w='min(${maxWidth},iw)':h=-2[${nextLabel}]`);
    curLabel = nextLabel;
    outH = Math.max(4, Math.round((outH * maxWidth) / outW));
    outH = outH - (outH % 2);
    outW = maxWidth;
  }

  return {
    filterGraph: steps.length ? steps.join(';') : null,
    finalLabel: curLabel,
    outW,
    outH,
    hasTransforms: Boolean(normCrop || normBoxes.length > 0 || (maxWidth > 0 && safeW > maxWidth))
  };
}

/**
 * Materializes a sanitized image (full-res for Timeline/Export or compact thumb for UI/Gemini)
 * without ever modifying the original webtoon file.
 */
async function materializeSanitizedImage({
  imagePath,
  origW,
  origH,
  cropRect = null,
  censorBoxes = [],
  outDir,
  maxWidth = 0,
  quality = 2
}) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error(`Зураг олдсонгүй: ${imagePath}`);
  }

  let w = Number(origW) || 0;
  let h = Number(origH) || 0;
  if (!w || !h) {
    try {
      const info = await ff.probe(imagePath);
      w = info.width || 1080;
      h = info.height || 1440;
    } catch {
      w = 1080;
      h = 1440;
    }
  }

  const normCrop = normalizeCropRect(cropRect);
  const normBoxes = normalizeCensorBoxes(censorBoxes);

  // If no crop, no censor boxes, and full resolution requested, original path is already safe!
  if (!normCrop && normBoxes.length === 0 && maxWidth <= 0) {
    return { path: imagePath, width: w, height: h, modified: false };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const key = buildCacheKey({ imagePath, cropRect: normCrop, censorBoxes: normBoxes, maxWidth });
  const prefix = maxWidth > 0 ? 'thumb' : 'safe';
  const outPath = path.join(outDir, `${prefix}_${key}.jpg`);

  const plan = buildSanitizeFilter({
    origW: w,
    origH: h,
    cropRect: normCrop,
    censorBoxes: normBoxes,
    maxWidth
  });

  if (fs.existsSync(outPath)) {
    try {
      const st = fs.statSync(outPath);
      if (st.size > 500) {
        return { path: outPath, width: plan.outW, height: plan.outH, modified: true };
      }
    } catch {}
  }

  const args = ['-v', 'error', '-y', '-i', imagePath];
  if (plan.filterGraph) {
    args.push('-filter_complex', plan.filterGraph, '-map', `[${plan.finalLabel}]`);
  }
  args.push('-frames:v', '1', '-q:v', String(quality), outPath);

  await new Promise((resolve, reject) => {
    execFile(ff.FFMPEG, args, { windowsHide: true, timeout: 30000 }, (err, _out, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });

  return { path: outPath, width: plan.outW, height: plan.outH, modified: true };
}

module.exports = {
  normalizeCropRect,
  normalizeCensorBoxes,
  buildSanitizeFilter,
  materializeSanitizedImage
};
