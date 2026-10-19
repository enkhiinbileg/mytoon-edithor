'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, screen, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const ff = require('./ffmpeg');
const settings = require('./settings');
const whisper = require('./whisper');
const subtitles = require('./subtitles');
const translate = require('./translate');
const tts = require('./tts');
const dub = require('./dub');
const dubstore = require('./dubstore');
const fontManager = require('./font-manager');

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2'
};
const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

app.setName('Cutline');
if (process.platform === 'win32') {
  app.setAppUserModelId('Cutline.VideoEditor');
}

const isDev = process.argv.includes('--dev');
// An isolated profile keeps integration tests away from the editor's real drafts and keys.
if (process.env.CUTLINE_TEST_DIR) app.setPath('userData', process.env.CUTLINE_TEST_DIR);

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// Mirror main-process console output into userData/logs/main.log for diagnosing hangs.
(() => {
  let logFile = null;
  const target = () => {
    if (logFile) return logFile;
    try {
      const dir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, 'main.log');
    } catch { return null; }
    return logFile;
  };
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      try {
        const f = target();
        if (!f) return;
        const line = args.map(a => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        fs.appendFileSync(f, `[${new Date().toISOString()}] [${level}] ${line}\n`);
      } catch {}
    };
  }
})();

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// Safe hardware-accelerated rendering without crashing Windows GPU compositor
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

// `stream: true` is what makes <video> byte-range seeking work over this scheme.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
]);

let win = null;
require('./project-store').registerProjectHandlers({ipcMain,dialog,app,getWindow:() => win});

function createWindow() {
  // Never open larger than the display: the editor lays out in four columns and
  // the right-hand inspector ends up off-screen if the window overflows.
  const { width: awW, height: awH } = screen.getPrimaryDisplay().workAreaSize;
  const iconPath = [
    path.join(__dirname, 'icon.ico'),
    path.join(__dirname, '..', 'icon.ico'),
    path.join(__dirname, '..', 'dist', 'icon.ico'),
    path.join(__dirname, '..', 'public', 'icon.ico'),
    path.join(__dirname, 'logo.png')
  ].find((p) => fs.existsSync(p));

  const iconImg = iconPath ? nativeImage.createFromPath(iconPath) : null;

  win = new BrowserWindow({
    title: 'Cutline — Video Editor',
    width: Math.min(1600, awW),
    height: Math.min(950, awH),
    minWidth: 960,
    minHeight: 600,
    show: true,
    frame: false,                 // custom CapCut-style title bar
    backgroundColor: '#111114',
    ...(iconImg && !iconImg.isEmpty() ? { icon: iconImg } : (iconPath ? { icon: iconPath } : {})),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (iconImg && !iconImg.isEmpty()) {
    try { win.setIcon(iconImg); } catch {}
  } else if (iconPath) {
    try { win.setIcon(iconPath); } catch {}
  }

  win.show();
  win.focus();
  win.once('ready-to-show', () => { win.show(); win.focus(); });

  win.webContents.on('console-message', (_e, _level, message, line, sourceId) => {
    console.log(`[renderer] ${message}  (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[did-fail-load] ${code} ${desc} ${url}`);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[CRASH] Renderer process gone:', details);
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) {
      try {
        dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Cutline - Дэлгэц сэргээх',
          message: `Дэлгэцийн процесс түр саатлаа (${details.reason || 'Memory'}). Програмыг дахин сэргээж байна...`,
          buttons: ['Сэргээх']
        }).then(() => {
          if (win && !win.isDestroyed()) win.reload();
        });
      } catch {
        if (win && !win.isDestroyed()) win.reload();
      }
    }
  });

  win.webContents.on('unresponsive', () => {
    console.warn('[WARNING] Renderer unresponsive');
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html')).catch(err => {
      console.error('[loadFile FAILED]', err);
    });
  }

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // media:///C:/path/to/file -> file on disk
  // media://local/C%3A/path/to/file -> file on disk.
  // Served by hand rather than through net.fetch(file://) because <video> needs
  // an explicit Content-Type and real byte-range replies in order to seek.
  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = decodeURIComponent(url.pathname).replace(/^\//, '');
      const stat = await fs.promises.stat(filePath);
      const type = mimeFor(filePath);
      const range = request.headers.get('range');

      const m = range && /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${stat.size}` }
          });
        }
        return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes'
          }
        });
      }

      return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(stat.size),
          'Accept-Ranges': 'bytes'
        }
      });
    } catch (err) {
      console.error('[media protocol] FAILED', request.url, String(err));
      return new Response('not found', { status: 404 });
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------- IPC ---------------------------------- */

// Files passed on the command line ("open with", or a dev convenience).
ipcMain.handle('app:initialMedia', () => {
  const fs = require('node:fs');
  const args = process.argv.slice(isDev ? 2 : 1);
  return args.filter((a) => !a.startsWith('-') && a !== '.' && fs.existsSync(a) && fs.statSync(a).isFile());
});

ipcMain.handle('dialog:openMedia', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import media',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mp3', 'wav', 'aac', 'm4a', 'flac', 'jpg', 'jpeg', 'png'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('media:probe', async (_e, filePath) => ff.probe(filePath));

ipcMain.handle('media:thumbnails', async (_e, filePath, duration, count) =>
  ff.thumbnails(filePath, duration, count)
);

ipcMain.handle('media:waveform', async (_e, filePath) => ff.extractWaveform(filePath));

ipcMain.handle('media:clipThumbnails', async (_e, { filePath, timestamps }) => {
  try {
    const paths = await ff.framesAtTimestamps(filePath, timestamps);
    return { ok: true, paths: paths.map((p) => p || '') };
  } catch (err) {
    return { ok: false, error: String(err.message || err), paths: [] };
  }
});

ipcMain.handle('media:getCachedThumbnails', async (_e, filePath) => {
  try {
    return await ff.getCachedFrames(filePath);
  } catch {
    return [];
  }
});

ipcMain.handle('media:sceneDetect', async (_e, { filePath, threshold }) => {
  try {
    const cuts = await ff.detectSceneCuts(filePath, threshold || 0.35);
    return { ok: true, cuts };
  } catch (err) {
    return { ok: false, error: String(err.message || err), cuts: [] };
  }
});

ipcMain.handle('dialog:saveExport', async (_e, defaultName) => {
  const isMp3 = String(defaultName || '').toLowerCase().endsWith('.mp3');
  const filters = isMp3
    ? [
        { name: 'MP3 audio (*.mp3)', extensions: ['mp3'] },
        { name: 'MP4 video (*.mp4)', extensions: ['mp4'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ]
    : [
        { name: 'MP4 video (*.mp4)', extensions: ['mp4'] },
        { name: 'MP3 audio (*.mp3)', extensions: ['mp3'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ];

  const res = await dialog.showSaveDialog(win, {
    title: isMp3 ? 'Export MP3 audio' : 'Export video',
    defaultPath: defaultName || (isMp3 ? 'export.mp3' : 'export.mp4'),
    filters
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('export:run', async (_e, spec) => {
  try {
    const out = await ff.exportTimeline(spec, (pct) => {
      win?.webContents.send('export:progress', pct);
    });
    return { ok: true, path: out };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('export:detectEncoders', async () => {
  try {
    return await ff.detectHardwareEncoders();
  } catch {
    return { h264: 'libx264', hevc: 'libx265', av1: 'libaom-av1' };
  }
});

ipcMain.handle('export:selectFolder', async (_e, defaultDir) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Экспортлох хавтас сонгох',
    defaultPath: defaultDir || app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('export:cancel', () => {
  return ff.cancelExport();
});

ipcMain.handle('export:openPath', async (_e, filePath) => {
  if (filePath) shell.openPath(filePath);
});

ipcMain.handle('export:getDefaultDir', () => {
  return app.getPath('downloads');
});

ipcMain.handle('shell:showItem', async (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (url && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

ipcMain.handle('file:copy', async (_e, { source, target }) => {
  try {
    fs.copyFileSync(source, target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

/* ------------------------- settings & auto-dub ------------------------ */

// Secrets never cross this boundary: the renderer sees booleans, and the main
// process reads the real values straight from the encrypted store.
ipcMain.handle('settings:read', () => settings.readPublic());
ipcMain.handle('settings:update', (_e, patch) => settings.update(patch));

ipcMain.handle('whisper:status', () => whisper.status());
ipcMain.handle('whisper:getGroqKeys', () => whisper.getGroqKeys());
ipcMain.handle('whisper:saveGroqKeys', (_e, text) => whisper.saveGroqKeys(text));
ipcMain.handle('whisper:download', (_e, model) =>
  whisper.downloadModel(model, (pct) => win?.webContents.send('whisper:progress', { model, pct }))
);

ipcMain.handle('dub:transcribe', async (_e, { mediaPath, model, language }) => {
  try {
    const out = await whisper.transcribe(mediaPath, {
      model,
      language,
      onProgress: (p) => win?.webContents.send('dub:progress', { stage: 'transcribe', ...p })
    });
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('dub:openSubtitles', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open subtitles',
    properties: ['openFile'],
    filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }]
  });
  if (res.canceled) return { ok: false, canceled: true };
  try {
    return { ok: true, segments: subtitles.parseSubtitleFile(res.filePaths[0]) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Transcript and translations survive restarts; voicing stays a separate step.
ipcMain.handle('dub:autosave', (_e, payload) => dubstore.autosave(payload));
ipcMain.handle('dub:restore', () => dubstore.restore());

ipcMain.handle('dub:saveAs', async (_e, payload) => {
  try {
    return { ok: true, path: await dubstore.saveAs(win, payload) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('dub:openFrom', async () => {
  try {
    const data = await dubstore.openFrom(win);
    return data ? { ok: true, data } : { ok: false, canceled: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('dub:exportSrt', async (_e, segments) => {
  try {
    return { ok: true, path: await dubstore.exportSrt(win, segments) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('translate:providers', () => translate.describe());
ipcMain.handle('translate:models', async (_e, providerId) => {
  try {
    const p = translate.provider(providerId);
    const apiKey = p.keyField ? settings.secret(p.keyField) : undefined;
    return { ok: true, models: await translate.listModels(providerId, apiKey) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('dub:translate', async (_e, { segments, language, providerId = 'claude', model }) => {
  try {
    const p = translate.provider(providerId);
    const out = await translate.translateSegments(segments, {
      providerId,
      model,
      apiKey: p.keyField ? settings.secret(p.keyField) : undefined,
      language,
      onProgress: (pr) => win?.webContents.send('dub:progress', { stage: 'translate', ...pr })
    });
    return { ok: true, segments: out };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('tts:providers', () => tts.describe());

function voiceCredentials(providerId) {
  const p = tts.provider(providerId);
  return {
    apiKey: settings.secret(p.keyField),
    region: p.needsRegion ? settings.readPublic().azureRegion || '' : undefined
  };
}

ipcMain.handle('tts:voices', async (_e, providerId) => {
  try {
    return { ok: true, voices: await tts.listVoices(providerId, voiceCredentials(providerId)) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('tts:models', async (_e, providerId) => {
  try {
    return { ok: true, models: await tts.listModels(providerId, voiceCredentials(providerId)) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('tts:quota', async (_e, providerId) => {
  try {
    return { ok: true, quota: await tts.quota(providerId, voiceCredentials(providerId)) };
  } catch {
    return { ok: true, quota: null };
  }
});

ipcMain.handle('dub:synthesize', async (_e, { segments, options }) => {
  try {
    if (recapController) throw new Error('Wait for the fast recap or stop it first.');
    const creds = voiceCredentials(options.providerId);
    const out = await dub.synthesize(
      segments,
      { ...options, ...creds },
      (p) => win?.webContents.send('dub:progress', { stage: 'speak', ...p })
    );
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Only one fast job may run: cache writes and character reservations have one owner.
const fastRecap = require('./fast-recap');
const recapDubPipeline = require('./recap-dub-pipeline');
const recapDownload = require('./recap-download');
let recapController = null;
app.on('before-quit',()=>recapController?.abort());
ipcMain.handle('recap:status', () => ({ downloader: Boolean(recapDownload.binary()), running: Boolean(recapController) }));
ipcMain.handle('recap:setup', async () => {
  try { return { ok: true, ...await recapDownload.install() }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('recap:cancel', () => { recapController?.abort(); return true; });
ipcMain.handle('recap:run', async (_e, spec) => {
  if (recapController || voiceController) return { ok: false, error: 'A recap is already running.' };
  const controller = new AbortController();
  recapController = controller;
  const started = Date.now();
  const emit = p => win?.webContents.send('recap:progress', { ...p, elapsedSeconds: (Date.now()-started)/1000 });
  try {
    const tr = translate.provider(spec.translation?.providerId || 'groq');
    const translationKey = tr.keyField ? settings.secret(tr.keyField) : undefined;
    const voice = voiceCredentials(spec.voice?.providerId || 'elevenlabs');
    if (tr.needsKey && !translationKey) throw new Error('Save the translation API key first.');
    if (!voice.apiKey && !settings.secret('elevenLabsApiKey') && !process.env.ELEVENLABS_API_KEY) {
      throw new Error('Save the ElevenLabs voice API key in API keys first.');
    }
    const defaultName = spec.source ? path.basename(spec.source, path.extname(spec.source)) + '_mongol.mp4' : 'mongolian-recap.mp4';
    const result = await dialog.showSaveDialog(win, { title: 'Save Mongolian recap', defaultPath: defaultName, filters: [{name:'MP4 video',extensions:['mp4']},{name:'MKV video',extensions:['mkv']}] });
    if (result.canceled || !result.filePath) return { ok:false,canceled:true };
    spec = { ...spec, outPath: result.filePath };
    let acquisitionSeconds = 0;
    if (spec.url) {
      const t = Date.now();
      emit({stage:'download'});
      const downloaded = await recapDownload.download(spec.url,spec.sourceLanguage,controller.signal,emit);
      spec.source = downloaded.source;
      spec.segments = undefined;
      if (downloaded.subtitle) {
        const rows = subtitles.parseSubtitleFile(downloaded.subtitle);
        if (rows.length && rows.every((s,i)=>!i || s.start>=rows[i-1].end)) spec.segments = rows;
      }
      acquisitionSeconds = (Date.now()-t)/1000;
    }

    const output = await recapDubPipeline.runRecapDubPipeline({
      source: spec.source,
      outPath: spec.outPath,
      segments: spec.segments,
      whisperModel: spec.whisperModel || 'groq-whisper-large-v3',
      sourceLanguage: spec.sourceLanguage || 'en',
      targetLanguage: spec.language || 'Mongolian',
      translationProvider: spec.translation?.providerId || 'groq',
      translationModel: spec.translation?.model,
      voiceId: spec.voice?.voiceId,
      modelId: spec.voice?.modelId,
      glossary: spec.glossary,
      concurrency: spec.concurrency || 2
    }, emit, controller.signal);

    const totalElapsedSeconds = (Date.now() - started) / 1000;
    return {
      ok: true,
      status: 'complete',
      path: output.videoPath,
      projectPath: output.projectPath,
      projectId: output.projectId,
      srtPath: output.srtPath,
      duration: output.duration,
      stats: output.stats,
      chunkCount: output.chunkCount,
      totalElapsedSeconds,
      targetMet: totalElapsedSeconds <= 600,
      issues: []
    };
  } catch (err) {
    return { ok:false,error:String(err.message||err),reportPath:err.reportPath };
  } finally { recapController = null; }
});

ipcMain.handle('recap:startDubPipeline', async (_e, spec) => {
  if (recapController || voiceController) return { ok: false, error: 'A recap is already running.' };
  const controller = new AbortController();
  recapController = controller;
  const started = Date.now();
  const emit = p => win?.webContents.send('recap:progress', { ...p, elapsedSeconds: (Date.now()-started)/1000 });
  try {
    const output = await recapDubPipeline.runRecapDubPipeline(spec, emit, controller.signal);
    return { ok: true, ...output };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    recapController = null;
  }
});

const voiceEdit = require('./voice-edit');
let voiceController = null;
const voiceProjects = new Map();
app.on('before-quit',()=>voiceController?.abort());
ipcMain.handle('voice-edit:cancel',()=>{voiceController?.abort();return true;});
ipcMain.handle('voice-edit:prepare',async(_e,spec)=>{
  if(voiceController||recapController)return {ok:false,error:'Wait for the current job or stop it first.'};
  voiceController=new AbortController();
  try {
    const provider=translate.provider(spec.translation.providerId);
    const key=provider.keyField?settings.secret(provider.keyField):undefined;
    if(provider.needsKey&&!key)throw new Error('Save the matching provider API key in API keys first. ElevenLabs is not needed for a supplied voice.');
    const project=await voiceEdit.prepare(spec,key,voiceController.signal,p=>win?.webContents.send('voice-edit:progress',p));
    const jobId=require('./recap-work').hash({dir:project.dir});
    voiceProjects.set(jobId,project);
    return {ok:true,jobId,...project};
  }catch(err){return {ok:false,error:String(err.message||err)};}
  finally{voiceController=null;}
});
ipcMain.handle('voice-edit:render',async(_e,{jobId,plan})=>{
  if(voiceController||recapController)return {ok:false,error:'Wait for the current job or stop it first.'};
  const project=voiceProjects.get(jobId);
  if(!project)return {ok:false,error:'Prepare this video and voice again to restore their cached alignment.'};
  voiceController=new AbortController();
  try {
    const selected=await dialog.showSaveDialog(win,{title:'Save video matched to your voice',defaultPath:'voice-edited.mp4',filters:[{name:'MP4',extensions:['mp4']}]});
    if(selected.canceled||!selected.filePath)return {ok:false,canceled:true};
    const output=await voiceEdit.render(project,plan,selected.filePath,voiceController.signal,p=>win?.webContents.send('voice-edit:progress',p));
    return {ok:true,...output};
  }catch(err){return {ok:false,error:String(err.message||err)};}
  finally{voiceController=null;}
});

ipcMain.handle('voice-edit:sync', async (_e, spec) => {
  try {
    return await voiceEdit.syncTimelineVoice(spec, (p) => win?.webContents.send('voice-edit:progress', p));
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('freeze-frame:extract', async (_e, { videoPath, timestamp }) => {
  try {
    return await ff.extractFreezeFrame(videoPath, timestamp);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

const srtSync = require('./srt-sync');
const srtParser = require('./srt-parser');

ipcMain.handle('dialog:openSrt', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Англи SRT хадмал файл сонгох',
    filters: [
      { name: 'SubRip Subtitles (*.srt)', extensions: ['srt'] },
      { name: 'All Files (*.*)', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const filePath = res.filePaths[0];
  try {
    const entries = srtParser.parseSrtFile(filePath);
    return { ok: true, path: filePath, name: path.basename(filePath), entriesCount: entries.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dialog:openTxt', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Монгол скрипт (.txt) файл сонгох',
    filters: [
      { name: 'Text Documents (*.txt)', extensions: ['txt'] },
      { name: 'All Files (*.*)', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const filePath = res.filePaths[0];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return { ok: true, path: filePath, name: path.basename(filePath), text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const audioScriptAlign = require('./audio-script-align');

ipcMain.handle('dialog:openAudioFile', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Аудио файл сонгох',
    filters: [
      { name: 'Audio Files (*.mp3, *.wav, *.m4a, *.aac, *.flac, *.ogg)', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] },
      { name: 'All Files (*.*)', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const filePath = res.filePaths[0];
  try {
    const probeInfo = await ff.probe(filePath);
    const stat = await fs.promises.stat(filePath);
    return {
      ok: true,
      path: filePath,
      name: path.basename(filePath),
      duration: probeInfo.duration || 0,
      hasAudio: probeInfo.hasAudio,
      size: stat.size
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dialog:openMultipleAudioFiles', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Аудио файлууд сонгох (Ctrl/Shift дарж олноор сонгож болно)',
    filters: [
      { name: 'Audio Files (*.mp3, *.wav, *.m4a, *.aac, *.flac, *.ogg)', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] },
      { name: 'All Files (*.*)', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled || !res.filePaths?.length) return [];
  const results = [];
  for (const filePath of res.filePaths) {
    try {
      const probeInfo = await ff.probe(filePath);
      const stat = await fs.promises.stat(filePath);
      results.push({
        ok: true,
        path: filePath,
        name: path.basename(filePath),
        duration: probeInfo.duration || 0,
        hasAudio: probeInfo.hasAudio,
        size: stat.size
      });
    } catch (err) {
      results.push({ ok: false, path: filePath, name: path.basename(filePath), error: err.message });
    }
  }
  return results;
});

ipcMain.handle('dialog:saveAudioFile', async (_e, defaultName) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Нэгтгэсэн аудиог хадгалах байршил',
    defaultPath: path.join(app.getPath('downloads'), defaultName || `merged_voice_${Date.now()}.mp3`),
    filters: [
      { name: 'MP3 Audio (*.mp3)', extensions: ['mp3'] },
      { name: 'All Files (*.*)', extensions: ['*'] }
    ]
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
});

ipcMain.handle('audio:mergeFiles', async (_e, { filePaths, outputPath }) => {
  if (!Array.isArray(filePaths) || filePaths.length < 2) {
    return { ok: false, error: 'Нэгтгэхийн тулд дор хаяж 2 аудио файл сонгоно уу.' };
  }
  for (const fp of filePaths) {
    if (!fs.existsSync(fp)) {
      return { ok: false, error: `Файл олдсонгүй: ${path.basename(fp)}` };
    }
  }
  const defaultDir = app.getPath('downloads');
  const targetOut = outputPath || path.join(defaultDir, `merged_voice_${Date.now()}.mp3`);
  
  try {
    let totalEstDuration = 0;
    const filesInfo = [];
    for (const fp of filePaths) {
      const probe = await ff.probe(fp);
      if (!probe.hasAudio) {
        return { ok: false, error: `Аудио биш эсвэл гэмтсэн файл байна: ${path.basename(fp)}` };
      }
      totalEstDuration += probe.duration || 0;
      filesInfo.push({ path: fp, name: path.basename(fp), duration: probe.duration || 0 });
    }

    await ff.concatAudioFiles(filePaths, targetOut);
    
    const outProbe = await ff.probe(targetOut);
    const stat = await fs.promises.stat(targetOut);
    return {
      ok: true,
      outputPath: targetOut,
      name: path.basename(targetOut),
      duration: outProbe.duration || totalEstDuration,
      size: stat.size,
      filesCount: filePaths.length,
      filesInfo
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

let captionController = null;
ipcMain.handle('audio:cancelAlign', () => { captionController?.abort(); return true; });
ipcMain.handle('audio:alignScript', async (_e, spec) => {
  if (captionController) return { ok: false, error: 'Хадмал үүсгэх ажил ажиллаж байна.' };
  captionController = new AbortController();
  try {
    return await audioScriptAlign.alignAudioWithScript({ ...spec, signal: captionController.signal }, (p) => win?.webContents.send('voice-align:progress', p));
  } catch (err) {
    return { ok: false, error: captionController.signal.aborted ? 'Хадмал үүсгэхийг цуцаллаа.' : String(err.message || err) };
  } finally { captionController = null; }
});

ipcMain.handle('captions:aiFixSpelling', async (_e, lines = []) => {
  try {
    const mnFixer = require('./mongolian-text-fixer');
    const segments = (Array.isArray(lines) ? lines : []).map((text, id) => ({ id, text: String(text || '') }));
    const polished = await mnFixer.polishMongolianCaptionsWithAI(segments);
    return { ok: true, corrected: polished.map((p) => p.text) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('audio:renderTimelineSpeech', async (_e, { clips = [], audio = [], duration }) => {
  try {
    audio = audio.filter(c => (c.volume ?? 1) > 0.001 && c.outPoint > c.inPoint);
    clips = clips.filter(c => c.hasAudio && c.kind !== 'image' && (c.volume ?? 1) > 0.001 && c.outPoint > c.inPoint);
    const audibleEnd = Math.max(0, ...[...audio, ...clips].map(c => c.start + c.outPoint - c.inPoint));
    if (!(audibleEnd > 0)) throw new Error('Таймлайн дээр таних ярианы дуу алга.');
    duration = duration > 0 ? Math.min(duration, audibleEnd) : audibleEnd;
    const outPath = path.join(os.tmpdir(), `capcut-timeline-speech-${process.pid}-${Date.now()}.wav`);
    await ff.exportTimeline({
      clips,
      audio,
      duration,
      format: 'wav',
      audioSampleRate: 16000,
      audioChannels: 1,
      outPath
    });

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 500) {
      return { ok: true, audioPath: outPath, duration, isTemp: true };
    }
    throw new Error('Timeline audio export failed');
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('srt:sync', async (_e, spec) => {
  try {
    return await srtSync.syncTimelineWithSrt(spec, (p) => win?.webContents.send('voice-edit:progress', p));
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

const recapAutoCut = require('./recap-auto-cut');
const activeRecapCuts = new Set();
ipcMain.handle('recap:autoCutBySrt', async (_e, spec) => {
  const senderId = _e.sender.id;
  if (activeRecapCuts.has(senderId)) return { ok: false, error: 'Auto-Cut ажиллаж байна. Дуусахыг хүлээнэ үү.' };
  activeRecapCuts.add(senderId);
  let apiKey = '';
  const redact = value => {
    const message = String(value || '');
    return apiKey ? message.split(apiKey).join('[redacted]') : message;
  };
  try {
    if (!spec || typeof spec.srtPath !== 'string' || !spec.srtPath.trim()) {
      throw new Error('Эх видеоны Англи SRT файлыг сонгоно уу.');
    }
    apiKey = settings.secret('geminiApiKey');
    return await recapAutoCut.autoCutByEnglishSrt({
      srtPath: spec.srtPath,
      captions: spec.captions,
      projectData: spec.projectData,
      videoMediaId: spec.videoMediaId,
      geminiApiKey: apiKey,
      model: spec.model,
      checkpointDir: path.join(app.getPath('userData'), 'recap-checkpoints'),
      outputDir: path.join(app.getPath('userData'), 'recap-freeze')
    }, (p) => {
      if (!_e.sender.isDestroyed()) _e.sender.send('recap-cut:progress', {
        stage: p.stage,
        message: redact(p.message),
        requestId: spec.requestId
      });
    });
  } catch (err) {
    return { ok: false, error: redact(err.message || err) };
  } finally {
    activeRecapCuts.delete(senderId);
  }
});

const scriptStudio = require('./script-studio');
const elevenPool = require('./elevenlabs-pool');

ipcMain.handle('eleven:getPool', () => settings.getKeyPoolPublic());
ipcMain.handle('eleven:addKey', async (_e, { key, label }) => {
  try {
    const pool = await elevenPool.verifyAndAddKey(key, label);
    return { ok: true, pool };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
ipcMain.handle('eleven:removeKey', (_e, keyId) => {
  try {
    const pool = settings.removeKeyFromPool(keyId);
    return { ok: true, pool };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
ipcMain.handle('eleven:toggleKey', (_e, { keyId, enabled }) => {
  try {
    const pool = settings.toggleKeyInPool(keyId, enabled);
    return { ok: true, pool };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
ipcMain.handle('eleven:refreshQuotas', async () => {
  try {
    const pool = await elevenPool.refreshAllQuotas();
    return { ok: true, pool };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

const activeScriptJobs = new Set();
ipcMain.handle('script:buildRecap', async (_e, spec) => {
  const sender = _e.sender;
  const startedAt = Date.now();
  console.log('[script:buildRecap] start', { chars: String(spec?.scriptText || '').length, model: spec?.modelId, chunkSize: spec?.chunkSize, audioOnly: !!spec?.audioOnly });
  const sendProgress = (p) => {
    if (p?.message) console.log('[script:progress]', p.message);
    try {
      if (sender && !sender.isDestroyed()) sender.send('script:progress', p);
    } catch {}
  };
  // A heartbeat keeps the event loop + this closure alive for the whole job.
  const heartbeat = setInterval(() => {
    console.log(`[script:buildRecap] still running ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }, 30000);
  const job = (async () => {
    try {
      const res = await scriptStudio.buildScriptRecap(spec, sendProgress);
      console.log('[script:buildRecap] done', { ok: res?.ok, audioPath: res?.audioPath, secs: Math.round((Date.now() - startedAt) / 1000) });
      return res;
    } catch (err) {
      console.error('[script:buildRecap error]', err);
      return { ok: false, error: String(err?.message || err) };
    }
  })();
  activeScriptJobs.add(job);
  try {
    return await job;
  } finally {
    clearInterval(heartbeat);
    activeScriptJobs.delete(job);
  }
});

function getScriptAudioRecoveryDir() {
  const dl = path.join(app.getPath('downloads'), 'Cutline Audio');
  if (fs.existsSync(dl)) return dl;
  const ud = path.join(app.getPath('userData'), 'script-studio-audio');
  if (fs.existsSync(ud)) return ud;
  fs.mkdirSync(dl, { recursive: true });
  return dl;
}

ipcMain.handle('script:scanRecovery', async () => {
  try {
    return { ok: true, ...await require('./voice-recovery').scanLatestParts(getScriptAudioRecoveryDir()) };
  } catch (error) { return { ok: false, error: error.message }; }
});
let recoveringVoice = false;
let selectedAudioFolder = null;
ipcMain.handle('script:pickAudioFolder', async () => {
  try {
    const picked = await dialog.showOpenDialog(win, { title: 'Нэгтгэх аудионы хавтас', defaultPath: path.join(app.getPath('downloads'), 'Cutline Audio'), properties: ['openDirectory'] });
    if (picked.canceled) return { ok: true, canceled: true };
    selectedAudioFolder = await require('./voice-recovery').scanAudioFolder(picked.filePaths[0]);
    return { ok: true, ...selectedAudioFolder };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('script:mergeAudioFolder', async (_e, token) => {
  if (recoveringVoice) return { ok: false, error: 'Аудио нэгтгэж байна. Түр хүлээнэ үү.' };
  recoveringVoice = true;
  try {
    const scan = selectedAudioFolder;
    if (!scan || scan.token !== token) throw new Error('Хавтсаа дахин сонгоно уу.');
    const defaultOut = path.join(app.getPath('downloads'), `merged-audio-${Date.now()}.mp3`);
    const saved = await dialog.showSaveDialog(win, { title: 'Нэгтгэсэн аудио хадгалах', defaultPath: defaultOut, filters: [{ name: 'MP3', extensions: ['mp3'] }] });
    if (saved.canceled || !saved.filePath) return { ok: true, canceled: true };
    return { ok: true, ...await require('./voice-recovery').mergeAudioFolder({ dir: scan.dir, token, output: saved.filePath }, ff) };
  } catch (error) { return { ok: false, error: error.message }; }
  finally { recoveringVoice = false; }
});
ipcMain.handle('script:mergeRecovery', async (_e, spec) => {
  if (recoveringVoice) return { ok: false, error: 'Аудио нэгтгэж байна. Түр хүлээнэ үү.' };
  recoveringVoice = true;
  try {
    const rDir = getScriptAudioRecoveryDir();
    const result = await require('./voice-recovery').mergeLatestParts({
      dir: rDir,
      outDir: app.getPath('downloads'),
      token: spec?.token,
      allowGaps: spec?.allowGaps === true
    }, ff);
    return { ok: true, ...result };
  } catch (error) { return { ok: false, error: error.message }; }
  finally { recoveringVoice = false; }
});

ipcMain.handle('fonts:getAvailable', () => fontManager.getAvailableFonts(app));
ipcMain.handle('fonts:importCustom', () => fontManager.importCustomFonts(app, dialog, win));

ipcMain.handle('window:minimize', () => win?.minimize());
ipcMain.handle('window:toggleMaximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('window:close', () => win?.close());
