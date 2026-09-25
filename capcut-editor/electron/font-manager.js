'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SYSTEM_FONTS = [
  { id: 'sys_impact', name: 'Impact', family: 'Impact', category: 'system' },
  { id: 'sys_bahnschrift', name: 'Bahnschrift', family: 'Bahnschrift', category: 'system' },
  { id: 'sys_segoe_ui', name: 'Segoe UI', family: 'Segoe UI', category: 'system' },
  { id: 'sys_arial', name: 'Arial', family: 'Arial', category: 'system' },
  { id: 'sys_arial_black', name: 'Arial Black', family: 'Arial Black', category: 'system' },
  { id: 'sys_calibri', name: 'Calibri', family: 'Calibri', category: 'system' },
  { id: 'sys_comic_sans', name: 'Comic Sans MS', family: 'Comic Sans MS', category: 'system' },
  { id: 'sys_georgia', name: 'Georgia', family: 'Georgia', category: 'system' },
  { id: 'sys_times', name: 'Times New Roman', family: 'Times New Roman', category: 'system' },
  { id: 'sys_trebuchet', name: 'Trebuchet MS', family: 'Trebuchet MS', category: 'system' },
  { id: 'sys_verdana', name: 'Verdana', family: 'Verdana', category: 'system' }
];

function getCustomFontsDir(app) {
  const dir = path.join(app.getPath('userData'), 'custom_fonts');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function scanCapCutFonts() {
  const capcutApps = path.join(process.env.LOCALAPPDATA || '', 'CapCut', 'Apps');
  const list = [];
  const seen = new Set();

  function addFont(fullPath) {
    const ext = path.extname(fullPath).toLowerCase();
    if (ext !== '.ttf' && ext !== '.otf' && ext !== '.woff2') return;
    const base = path.basename(fullPath, ext);
    if (seen.has(base.toLowerCase())) return;
    seen.add(base.toLowerCase());

    let family = base;
    if (base.startsWith('CapCutSansText-')) {
      family = 'CapCut Sans ' + base.replace('CapCutSansText-', '');
    } else if (base.startsWith('CapCutSans-')) {
      family = 'CapCut Sans ' + base.replace('CapCutSans-', '');
    } else if (base.startsWith('SourceSerif4')) {
      family = 'Source Serif 4 Bold Italic';
    } else if (base === 'en' || base === 'ja' || base === 'ko' || base === 'th' || base.startsWith('zh-') || base === 'seguiemj') {
      return;
    } else {
      family = base.replace(/[-_]/g, ' ');
    }

    list.push({
      id: 'capcut_' + base.toLowerCase(),
      name: family,
      family: family,
      fileName: path.basename(fullPath),
      path: fullPath,
      category: 'capcut'
    });
  }

  // 1. Scan CapCut Apps directory (latest versions first)
  if (fs.existsSync(capcutApps)) {
    try {
      const versions = fs.readdirSync(capcutApps)
        .filter((v) => {
          try {
            return fs.statSync(path.join(capcutApps, v)).isDirectory();
          } catch (e) {
            return false;
          }
        })
        .sort()
        .reverse();

      for (const v of versions) {
        const fontDir = path.join(capcutApps, v, 'Resources', 'Font', 'SystemFont');
        if (fs.existsSync(fontDir)) {
          for (const f of fs.readdirSync(fontDir)) {
            addFont(path.join(fontDir, f));
          }
        }
      }
    } catch (e) {
      console.warn('[font-manager] failed scanning CapCut Apps:', e);
    }
  }

  // 2. Scan User Data directory if present
  const userDataFont = path.join(process.env.LOCALAPPDATA || '', 'CapCut', 'User Data', 'Resources', 'Font', 'SystemFont');
  if (fs.existsSync(userDataFont)) {
    try {
      for (const f of fs.readdirSync(userDataFont)) {
        addFont(path.join(userDataFont, f));
      }
    } catch (e) {}
  }

  return list;
}

function scanCustomFonts(app) {
  const dir = getCustomFontsDir(app);
  const list = [];
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (ext === '.ttf' || ext === '.otf' || ext === '.woff2') {
        const base = path.basename(f, ext);
        const family = base.replace(/[-_]/g, ' ');
        list.push({
          id: 'custom_' + base.toLowerCase(),
          name: family,
          family: family,
          fileName: f,
          path: path.join(dir, f),
          category: 'custom'
        });
      }
    }
  } catch (e) {
    console.warn('[font-manager] failed scanning custom fonts:', e);
  }
  return list;
}

function getAvailableFonts(app) {
  const capcut = scanCapCutFonts();
  const custom = scanCustomFonts(app);
  return {
    capcut,
    system: SYSTEM_FONTS,
    custom,
    all: [...capcut, ...custom, ...SYSTEM_FONTS]
  };
}

async function importCustomFonts(app, dialog, win) {
  const res = await dialog.showOpenDialog(win, {
    title: 'Фонт оруулах (TTF, OTF, WOFF2)',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Фонтын файлууд (*.ttf, *.otf, *.woff2)', extensions: ['ttf', 'otf', 'woff2'] },
      { name: 'Бүх файлууд', extensions: ['*'] }
    ]
  });

  if (res.canceled || !res.filePaths.length) {
    return { canceled: true, fonts: getAvailableFonts(app) };
  }

  const dir = getCustomFontsDir(app);
  const imported = [];

  for (const srcPath of res.filePaths) {
    try {
      const fileName = path.basename(srcPath);
      const destPath = path.join(dir, fileName);
      if (srcPath !== destPath) {
        fs.copyFileSync(srcPath, destPath);
      }
      imported.push(fileName);
    } catch (err) {
      console.error('[font-manager] failed copying font:', srcPath, err);
    }
  }

  return {
    canceled: false,
    imported,
    fonts: getAvailableFonts(app)
  };
}

module.exports = {
  getAvailableFonts,
  importCustomFonts
};
