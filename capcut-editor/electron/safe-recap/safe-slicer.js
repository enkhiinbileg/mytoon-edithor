'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const ff = require('../ffmpeg');

const SUPPORTED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

function naturalSort(a, b) {
  return path.basename(a).localeCompare(path.basename(b), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

function collectImagePaths(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) return [];
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) {
    return SUPPORTED_EXTS.has(path.extname(inputPath).toLowerCase()) ? [inputPath] : [];
  }
  if (!stat.isDirectory()) return [];

  const results = [];
  const entries = fs.readdirSync(inputPath, { withFileTypes: true });
  entries.sort((a, b) => naturalSort(a.name, b.name));

  for (const entry of entries) {
    const full = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectImagePaths(full));
    } else if (entry.isFile() && SUPPORTED_EXTS.has(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

async function detectGutters(imagePath, { sampleWidth = 32, minGapLines = 35 } = {}) {
  const probe = await ff.probe(imagePath);
  const origW = probe.width || 800;
  const origH = probe.height || 1000;
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
    const proc = execFile(
      ff.FFMPEG,
      args,
      { encoding: 'buffer', maxBuffer: sampleWidth * origH + 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout || stdout.length < sampleWidth * origH) {
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
          if ((mean > 240 && diff <= 12) || (mean < 18 && diff <= 12)) {
            isBlank[y] = 1;
          }
        }

        const gutters = [];
        let inGap = false;
        let gapStart = 0;

        for (let y = 0; y < origH; y++) {
          if (isBlank[y] === 1) {
            if (!inGap) {
              inGap = true;
              gapStart = y;
            }
          } else if (inGap) {
            inGap = false;
            const gapLen = y - gapStart;
            if (gapLen >= minGapLines) {
              gutters.push({ start: gapStart, end: y, center: Math.round(gapStart + gapLen / 2) });
            }
          }
        }
        if (inGap && origH - gapStart >= minGapLines) {
          gutters.push({ start: gapStart, end: origH, center: Math.round(gapStart + (origH - gapStart) / 2) });
        }

        if (!gutters.length) {
          resolve([{ y: 0, h: origH }]);
          return;
        }

        const cuts = [];
        let lastCutY = 0;
        for (const g of gutters) {
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
        resolve(cuts.length > 0 ? cuts : [{ y: 0, h: origH }]);
      }
    );
    proc.on('error', () => resolve([{ y: 0, h: origH }]));
  });
}

async function sliceStripIfNeeded(imagePath, outputDir, onProgress) {
  const probe = await ff.probe(imagePath);
  const origW = probe.width || 800;
  const origH = probe.height || 1000;
  const ratio = origH / Math.max(1, origW);

  if (!(origH >= 2500 && ratio >= 2.2)) {
    return [{
      path: imagePath,
      width: origW,
      height: origH,
      isSliced: false,
      originalPath: imagePath,
      panelIndex: 0
    }];
  }

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

  fs.mkdirSync(outputDir, { recursive: true });
  const baseName = path.basename(imagePath, path.extname(imagePath));
  const pathHash = crypto.createHash('md5').update(imagePath).digest('hex').slice(0, 6);
  const results = [];

  for (let idx = 0; idx < panels.length; idx++) {
    const { y, h } = panels[idx];
    const outName = `${baseName}_${pathHash}_p${String(idx + 1).padStart(3, '0')}.jpg`;
    const outPath = path.join(outputDir, outName);

    onProgress?.(`Кадр ялгаж байна: ${baseName} (${idx + 1}/${panels.length})`);

    if (!fs.existsSync(outPath)) {
      await new Promise((resolve, reject) => {
        execFile(
          ff.FFMPEG,
          ['-v', 'error', '-y', '-i', imagePath, '-vf', `crop=w=${origW}:h=${h}:x=0:y=${y}`, '-q:v', '2', outPath],
          { windowsHide: true },
          (err) => (err ? reject(err) : resolve())
        );
      });
    }

    try {
      const stat = fs.statSync(outPath);
      if (stat.size < 12000) {
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

  return results.length > 0
    ? results
    : [{ path: imagePath, width: origW, height: origH, isSliced: false, originalPath: imagePath, panelIndex: 0 }];
}

async function prepareSafePanels(inputs, { cacheDir, sliceMode = 'smart', onProgress } = {}) {
  const targetDir = cacheDir || path.join(os.tmpdir(), `cutline-safe-panels-${Date.now()}`);
  fs.mkdirSync(targetDir, { recursive: true });

  const rawPaths = [];
  for (const item of Array.isArray(inputs) ? inputs : [inputs]) {
    rawPaths.push(...collectImagePaths(item));
  }
  const uniquePaths = Array.from(new Set(rawPaths)).sort(naturalSort);
  const collection = [];

  for (let i = 0; i < uniquePaths.length; i++) {
    const p = uniquePaths[i];
    onProgress?.(`Зураг бэлдэж байна (${i + 1}/${uniquePaths.length}): ${path.basename(p)}`, Math.round((i / Math.max(1, uniquePaths.length)) * 100));

    if (sliceMode === 'smart') {
      try {
        const sliced = await sliceStripIfNeeded(p, targetDir, onProgress);
        collection.push(...sliced);
        continue;
      } catch {}
    }

    let info = { width: 1080, height: 1440 };
    try {
      info = await ff.probe(p);
    } catch {}
    collection.push({
      path: p,
      width: info.width || 1080,
      height: info.height || 1440,
      isSliced: false,
      originalPath: p,
      panelIndex: 0
    });
  }

  return {
    cacheDir: targetDir,
    panels: collection.map((item, idx) => ({
      ...item,
      id: `sp_${String(idx).padStart(4, '0')}_${crypto.createHash('md5').update(item.path).digest('hex').slice(0, 6)}`,
      name: path.basename(item.path),
      safetyStatus: 'unchecked',
      nsfwScore: 0,
      faceBoxes: [],
      nsfwBoxes: [],
      cropRect: null,
      censorBoxes: [],
      needsReview: false
    }))
  };
}

module.exports = {
  naturalSort,
  collectImagePaths,
  prepareSafePanels
};
