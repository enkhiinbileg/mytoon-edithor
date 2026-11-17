'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const safeProc = require('./safe-image-processor');

function resolveScriptPath() {
  const candidates = [
    path.join(__dirname, 'safe_analyzer.py'),
    path.join(__dirname, 'safe-recap', 'safe_analyzer.py'),
    path.join(process.resourcesPath || '', 'safe-recap', 'safe_analyzer.py'),
    path.resolve(path.dirname(process.execPath || ''), '..', '..', 'electron', 'safe-recap', 'safe_analyzer.py')
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return path.join(__dirname, 'safe_analyzer.py');
}

function findPythonExecutable(app) {
  const candidates = [
    path.join(__dirname, '..', '..', '.venv-safe-recap', 'Scripts', 'python.exe'),
    path.join(__dirname, '..', '..', '.venv-safe-recap', 'bin', 'python'),
    path.resolve(path.dirname(process.execPath || ''), '..', '..', '.venv-safe-recap', 'Scripts', 'python.exe'),
    app?.getPath ? path.join(app.getPath('userData'), 'safe-recap-venv', 'Scripts', 'python.exe') : '',
    process.env.SAFE_RECAP_PYTHON || '',
    'python'
  ].filter(Boolean);

  for (const c of candidates) {
    if (c === 'python' || fs.existsSync(c)) return c;
  }
  return 'python';
}

async function checkEnvironment(app) {
  const pythonPath = findPythonExecutable(app);
  const scriptPath = resolveScriptPath();
  return new Promise((resolve) => {
    execFile(
      pythonPath,
      [scriptPath, '--mode', 'env'],
      { windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            pythonPath,
            hasImgutils: false,
            hasOnnxGpu: false,
            hasOpencv: false,
            error: stderr || err.message
          });
          return;
        }
        try {
          const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
          const last = JSON.parse(lines[lines.length - 1] || '{}');
          resolve({
            ok: Boolean(last.hasImgutils),
            pythonPath,
            hasImgutils: Boolean(last.hasImgutils),
            hasOnnxGpu: Boolean(last.hasOnnxGpu),
            hasOpencv: Boolean(last.hasOpencv),
            providers: last.providers || [],
            error: last.error
          });
        } catch (parseErr) {
          resolve({
            ok: false,
            pythonPath,
            hasImgutils: false,
            hasOnnxGpu: false,
            hasOpencv: false,
            error: parseErr.message
          });
        }
      }
    );
  });
}

function runCmdStream(bin, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd, windowsHide: true });
    let errBuf = '';
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) onLine?.(line);
      }
    });
    proc.stderr.on('data', (chunk) => {
      errBuf = (errBuf + chunk.toString()).slice(-6000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (buf.trim()) onLine?.(buf);
      if (code === 0) resolve();
      else reject(new Error(errBuf || `Exited with code ${code}`));
    });
  });
}

async function setupEnvironment(app, onProgress) {
  const projectVenvDir = path.join(__dirname, '..', '..', '.venv-safe-recap');
  const venvDir = fs.existsSync(path.join(__dirname, '..', '..', 'package.json'))
    ? projectVenvDir
    : path.join(app.getPath('userData'), 'safe-recap-venv');

  const pyExe = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');

  if (!fs.existsSync(pyExe)) {
    onProgress?.('Тусгаарлагдсан Python орчин үүсгэж байна...', 10);
    await runCmdStream('python', ['-m', 'venv', venvDir], path.dirname(venvDir));
  }

  const envBefore = await checkEnvironment(app);
  if (!envBefore.hasImgutils || !envBefore.hasOpencv) {
    onProgress?.('Локал ONNX +18 болон царай таних сан суулгаж байна...', 35);
    await runCmdStream(
      pyExe,
      ['-m', 'pip', 'install', '--upgrade', 'dghs-imgutils', 'onnxruntime', 'opencv-python-headless', 'pillow'],
      venvDir,
      (line) => {
        if (line.includes('Downloading') || line.includes('Installing')) {
          onProgress?.(line.slice(0, 80), 55);
        }
      }
    );
  }

  onProgress?.('ONNX моделуудыг бэлдэж байна (анх удаа хэсэг хүлээнэ)...', 80);
  const scriptPath = resolveScriptPath();
  await new Promise((resolve, reject) => {
    execFile(pyExe, [scriptPath, '--mode', 'warmup'], { windowsHide: true, timeout: 180000 }, (err, _out, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });

  onProgress?.('Локал шүүгч бэлэн боллоо!', 100);
  return checkEnvironment(app);
}

async function analyzePanels({
  app,
  panels,
  cacheDir,
  strictness = 'balanced',
  defaultCensorMode = 'blur',
  onProgress
}) {
  if (!Array.isArray(panels) || !panels.length) {
    return [];
  }

  const pyExe = findPythonExecutable(app);
  const env = await checkEnvironment(app);
  if (!env.hasImgutils) {
    throw new Error('Локал ONNX шүүгч суугаагүй байна. "Суулгах / Шалгах" товч дарна уу.');
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const manifestPath = path.join(os.tmpdir(), `safe_manifest_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`);
  const resultPath = path.join(os.tmpdir(), `safe_result_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`);

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      panels: panels.map((p) => ({ id: p.id, path: p.path, width: p.width, height: p.height })),
      strictness,
      defaultCensorMode,
      cacheDir
    }),
    'utf8'
  );

  const scriptPath = resolveScriptPath();
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(
        pyExe,
        [scriptPath, '--mode', 'analyze', '--input', manifestPath, '--output', resultPath],
        { windowsHide: true, env: { ...process.env, ORT_LOG_SEVERITY_LEVEL: '3', PYTHONIOENCODING: 'utf-8' } }
      );

      let buf = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'progress') {
              onProgress?.(msg.message || 'Шалгаж байна...', msg.percent || 0);
            }
          } catch {}
        }
      });

      proc.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-6000);
      });

      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `Analyzer exited with code ${code}`));
      });
    });

    const rawOut = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const byId = new Map((rawOut.results || []).map((r) => [r.id, r]));

    const thumbDir = path.join(cacheDir, 'sanitized-thumbs');
    const renderDir = path.join(cacheDir, 'sanitized-render');

    const enriched = [];
    for (let i = 0; i < panels.length; i++) {
      const p = panels[i];
      const r = byId.get(p.id) || {};
      const next = {
        ...p,
        safetyStatus: r.safetyStatus || 'safe',
        nsfwScore: Number(r.nsfwScore || 0),
        explicitScore: Number(r.explicitScore || 0),
        suggestiveScore: Number(r.suggestiveScore || 0),
        faceBoxes: Array.isArray(r.faceBoxes) ? r.faceBoxes : [],
        nsfwBoxes: Array.isArray(r.nsfwBoxes) ? r.nsfwBoxes : [],
        cropRect: r.cropRect || null,
        censorBoxes: Array.isArray(r.censorBoxes) ? r.censorBoxes : [],
        recheckSafe: r.recheckSafe !== false,
        needsReview: Boolean(r.needsReview),
        safetyReason: r.safetyReason || ''
      };

      if (next.safetyStatus !== 'excluded') {
        onProgress?.(
          `Цэвэр хувилбар бэлдэж байна (${i + 1}/${panels.length})...`,
          Math.round(80 + ((i + 1) / panels.length) * 20)
        );
        try {
          const thumb = await safeProc.materializeSanitizedImage({
            imagePath: next.path,
            origW: next.width,
            origH: next.height,
            cropRect: next.cropRect,
            censorBoxes: next.censorBoxes,
            outDir: thumbDir,
            maxWidth: 480,
            quality: 3
          });
          next.sanitizedThumbPath = thumb.path;

          if (next.cropRect || (next.censorBoxes && next.censorBoxes.length > 0)) {
            const full = await safeProc.materializeSanitizedImage({
              imagePath: next.path,
              origW: next.width,
              origH: next.height,
              cropRect: next.cropRect,
              censorBoxes: next.censorBoxes,
              outDir: renderDir,
              maxWidth: 0,
              quality: 2
            });
            next.sanitizedRenderPath = full.path;
            next.sanitizedWidth = full.width;
            next.sanitizedHeight = full.height;
          } else {
            next.sanitizedRenderPath = next.path;
            next.sanitizedWidth = next.width;
            next.sanitizedHeight = next.height;
          }
        } catch {}
      }

      enriched.push(next);
    }

    return enriched;
  } finally {
    try { if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath); } catch {}
    try { if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath); } catch {}
  }
}

async function recheckSingleImage({ app, imagePath, strictness = 'balanced' }) {
  const pyExe = findPythonExecutable(app);
  const scriptPath = resolveScriptPath();
  return new Promise((resolve) => {
    execFile(
      pyExe,
      [scriptPath, '--mode', 'recheck', '--image', imagePath, '--strictness', strictness],
      {
        windowsHide: true,
        timeout: 45000,
        env: { ...process.env, ORT_LOG_SEVERITY_LEVEL: '3', PYTHONIOENCODING: 'utf-8' }
      },
      (err, stdout) => {
        if (err) {
          resolve({ safe: true, nsfwScore: 0, error: err.message });
          return;
        }
        try {
          const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
          resolve(JSON.parse(lines[lines.length - 1] || '{}'));
        } catch {
          resolve({ safe: true, nsfwScore: 0 });
        }
      }
    );
  });
}

async function materializePlan({ plan, cacheDir, onProgress }) {
  const renderDir = path.join(cacheDir, 'sanitized-render');
  const thumbDir = path.join(cacheDir, 'sanitized-thumbs');
  const out = [];

  for (let i = 0; i < plan.length; i++) {
    const row = plan[i];
    if (row.safetyStatus === 'excluded') continue;

    onProgress?.(`Гаралтын цэвэр зураг бэлдэж байна (${i + 1}/${plan.length})...`, Math.round(((i + 1) / plan.length) * 100));

    const needsMaterialize = Boolean(row.cropRect || (row.censorBoxes && row.censorBoxes.length > 0));
    if (!needsMaterialize) {
      out.push({
        ...row,
        sanitizedPath: row.imagePath
      });
      continue;
    }

    const mat = await safeProc.materializeSanitizedImage({
      imagePath: row.imagePath,
      origW: row.imageWidth,
      origH: row.imageHeight,
      cropRect: row.cropRect,
      censorBoxes: row.censorBoxes,
      outDir: renderDir,
      maxWidth: 0,
      quality: 2
    });

    await safeProc.materializeSanitizedImage({
      imagePath: row.imagePath,
      origW: row.imageWidth,
      origH: row.imageHeight,
      cropRect: row.cropRect,
      censorBoxes: row.censorBoxes,
      outDir: thumbDir,
      maxWidth: 480,
      quality: 3
    }).catch(() => {});

    out.push({
      ...row,
      sanitizedPath: mat.path,
      imageWidth: mat.width,
      imageHeight: mat.height
    });
  }

  return out;
}

module.exports = {
  checkEnvironment,
  setupEnvironment,
  analyzePanels,
  recheckSingleImage,
  materializePlan
};
