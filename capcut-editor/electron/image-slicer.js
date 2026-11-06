'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const ff = require('./ffmpeg');

const SUPPORTED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

/**
 * Natural sort comparator for filenames (handles numbers like page_1 before page_2 before page_10).
 */
function naturalSort(a, b) {
  const nameA = path.basename(a);
  const nameB = path.basename(b);
  return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Scan a path. If directory, recursively collects all supported images in natural sort order.
 * If file, returns [file] if supported.
 */
function collectImagePaths(inputPath) {
  if (!fs.existsSync(inputPath)) return [];
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) {
    const ext = path.extname(inputPath).toLowerCase();
    return SUPPORTED_EXTS.has(ext) ? [inputPath] : [];
  }
  if (!stat.isDirectory()) return [];

  const results = [];
  const entries = fs.readdirSync(inputPath, { withFileTypes: true });
  entries.sort((a, b) => naturalSort(a.name, b.name));

  for (const entry of entries) {
    const full = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectImagePaths(full));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTS.has(ext)) {
        results.push(full);
      }
    }
  }
  return results;
}

/**
 * Determine if an image is a true vertical webtoon scroll strip.
 * Strict check: height >= 2500 and aspect ratio (H / W) >= 2.2
 */
async function isWebtoonStrip(imagePath) {
  try {
    const info = await ff.probe(imagePath);
    if (!info || !info.width || !info.height) return false;
    const ratio = info.height / info.width;
    return info.height >= 2500 && ratio >= 2.2;
  } catch {
    return false;
  }
}

/**
 * Detect horizontal gutters (blank white or dark margins) between panels.
 * NEVER blindly splits through panels or characters!
 */
async function detectGutters(imagePath, { sampleWidth = 32, minGapLines = 35 } = {}) {
  const probe = await ff.probe(imagePath);
  const origW = probe.width || 800;
  const origH = probe.height || 1000;

  // Real manhwa panels are at least 350px tall
  const minPanelHeight = Math.max(350, Math.round(origW * 0.45));

  if (origH < 2200) {
    return [{ y: 0, h: origH }];
  }

  const args = [
    '-v', 'error',
    '-i', imagePath,
    '-vf', `scale=${sampleWidth}:${origH}`,
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    'pipe:1'
  ];

  return new Promise((resolve) => {
    const proc = execFile(ff.FFMPEG, args, {
      encoding: 'buffer',
      maxBuffer: sampleWidth * origH + 1024 * 1024
    }, (err, stdout) => {
      if (err || !stdout || stdout.length < sampleWidth * origH) {
        // Safe fallback: NEVER cut blindly! Return whole image intact.
        resolve([{ y: 0, h: origH }]);
        return;
      }

      const isBlank = new Uint8Array(origH);
      for (let y = 0; y < origH; y++) {
        let sum = 0;
        let min = 255;
        let max = 0;
        const offset = y * sampleWidth;
        for (let x = 0; x < sampleWidth; x++) {
          const val = stdout[offset + x];
          sum += val;
          if (val < min) min = val;
          if (val > max) max = val;
        }
        const mean = sum / sampleWidth;
        const diff = max - min;
        // Gutter line: near-uniform row with low variation
        // White gutter: mean > 240, diff <= 12
        // Dark gutter: mean < 18, diff <= 12
        if ((mean > 240 && diff <= 12) || (mean < 18 && diff <= 12)) {
          isBlank[y] = 1;
        }
      }

      // Group contiguous blank bands
      const gutters = [];
      let inGap = false;
      let gapStart = 0;

      for (let y = 0; y < origH; y++) {
        if (isBlank[y] === 1) {
          if (!inGap) {
            inGap = true;
            gapStart = y;
          }
        } else {
          if (inGap) {
            inGap = false;
            const gapLen = y - gapStart;
            if (gapLen >= minGapLines) {
              gutters.push({ start: gapStart, end: y, center: Math.round(gapStart + gapLen / 2) });
            }
          }
        }
      }
      if (inGap && origH - gapStart >= minGapLines) {
        gutters.push({ start: gapStart, end: origH, center: Math.round(gapStart + (origH - gapStart) / 2) });
      }

      if (gutters.length === 0) {
        // No clear gutter: DO NOT CUT!
        resolve([{ y: 0, h: origH }]);
        return;
      }

      // Cut exactly at the center of the gutter margin
      const cuts = [];
      let lastCutY = 0;

      for (const g of gutters) {
        // Ignore margin if it's right at the very top (header padding)
        if (g.start <= 100) {
          lastCutY = g.end;
          continue;
        }
        const cutY = g.center;
        const panelHeight = cutY - lastCutY;
        if (panelHeight >= minPanelHeight) {
          cuts.push({ y: lastCutY, h: panelHeight });
          lastCutY = cutY;
        }
      }
      if (origH - lastCutY >= minPanelHeight) {
        cuts.push({ y: lastCutY, h: origH - lastCutY });
      }

      // If cuts were found, return them whole. NEVER arbitrarily subdivide tall panels!
      resolve(cuts.length > 0 ? cuts : [{ y: 0, h: origH }]);
    });

    proc.on('error', () => {
      resolve([{ y: 0, h: origH }]);
    });
  });
}

/**
 * Slice a webtoon strip into individual panel image files.
 */
async function sliceWebtoonStrip(imagePath, outputDir, onProgress) {
  fs.mkdirSync(outputDir, { recursive: true });
  const probe = await ff.probe(imagePath);
  const origW = probe.width || 800;
  const origH = probe.height || 1000;

  const panels = await detectGutters(imagePath);
  if (!panels || panels.length <= 1) {
    return [{
      path: imagePath,
      width: origW,
      height: origH,
      isSliced: false,
      originalPath: imagePath,
      panelIndex: 0
    }];
  }

  const baseName = path.basename(imagePath, path.extname(imagePath));
  const results = [];

  for (let idx = 0; idx < panels.length; idx++) {
    const { y, h } = panels[idx];
    const outName = `${baseName}_p${String(idx + 1).padStart(3, '0')}.jpg`;
    const outPath = path.join(outputDir, outName);

    onProgress?.(`Кадр ялгаж байна: ${baseName} (${idx + 1}/${panels.length})`);

    await new Promise((resolve, reject) => {
      execFile(ff.FFMPEG, [
        '-v', 'error',
        '-y',
        '-i', imagePath,
        '-vf', `crop=w=${origW}:h=${h}:x=0:y=${y}`,
        '-q:v', '2',
        outPath
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Check generated file size: Discard anything under 15KB (blank whitespace)
    try {
      const stat = fs.statSync(outPath);
      if (stat.size < 15000) {
        fs.unlinkSync(outPath);
        continue;
      }
    } catch {}

    results.push({
      path: outPath,
      width: origW,
      height: h,
      isSliced: true,
      originalPath: imagePath,
      panelIndex: idx
    });
  }

  if (results.length === 0) {
    results.push({
      path: imagePath,
      width: origW,
      height: origH,
      isSliced: false,
      originalPath: imagePath,
      panelIndex: 0
    });
  }

  return results;
}

/**
 * Process an entire collection of input paths (folders, strips, or regular panel images).
 * Strictly sorts all images in natural numeric order (page_1, page_2 ... page_10).
 *
 * @param {string[]|string} inputs - File or folder paths
 * @param {object} options
 * @param {string} [options.sliceMode='none'] - 'none' preserves original images 100% whole; 'smart' slices true gutters only
 * @param {Function} [options.onProgress]
 */
async function prepareImageCollection(inputs, { cacheDir, sliceMode = 'none', onProgress } = {}) {
  const targetDir = cacheDir || path.join(os.tmpdir(), `mytoon-panels-${Date.now()}`);
  fs.mkdirSync(targetDir, { recursive: true });

  const rawPaths = [];
  for (const item of (Array.isArray(inputs) ? inputs : [inputs])) {
    rawPaths.push(...collectImagePaths(item));
  }

  // STRICT natural sort so page_1 comes before page_2, and page_2 comes before page_10!
  const uniquePaths = Array.from(new Set(rawPaths));
  uniquePaths.sort(naturalSort);

  const collection = [];

  for (let i = 0; i < uniquePaths.length; i++) {
    const p = uniquePaths[i];
    const fileName = path.basename(p);
    onProgress?.(`Зургийг бэлтгэж байна (${i + 1}/${uniquePaths.length}): ${fileName}`);

    // If sliceMode is 'none', NEVER slice! Use full image directly.
    if (sliceMode !== 'smart') {
      let probe = { width: 1280, height: 720 };
      try { probe = await ff.probe(p); } catch {}
      collection.push({
        path: p,
        width: probe.width || 1280,
        height: probe.height || 720,
        isSliced: false,
        originalPath: p,
        panelIndex: 0
      });
      continue;
    }

    // Only when sliceMode is explicitly 'smart', check for long vertical strips
    const isStrip = await isWebtoonStrip(p);
    if (isStrip) {
      const sliced = await sliceWebtoonStrip(p, targetDir, onProgress);
      collection.push(...sliced);
    } else {
      let probe = { width: 1280, height: 720 };
      try { probe = await ff.probe(p); } catch {}
      collection.push({
        path: p,
        width: probe.width || 1280,
        height: probe.height || 720,
        isSliced: false,
        originalPath: p,
        panelIndex: 0
      });
    }
  }

  return {
    cacheDir: targetDir,
    panels: collection.map((item, idx) => ({
      ...item,
      id: `img_${String(idx).padStart(4, '0')}_${Math.random().toString(36).slice(2, 6)}`,
      name: path.basename(item.path)
    }))
  };
}

module.exports = {
  naturalSort,
  collectImagePaths,
  isWebtoonStrip,
  detectGutters,
  sliceWebtoonStrip,
  prepareImageCollection
};
