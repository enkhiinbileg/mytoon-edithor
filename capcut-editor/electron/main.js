'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
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

const isDev = process.argv.includes('--dev');
// An isolated profile keeps integration tests away from the editor's real drafts and keys.
if (process.env.CUTLINE_TEST_DIR) app.setPath('userData', process.env.CUTLINE_TEST_DIR);

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

  win = new BrowserWindow({
    width: Math.min(1600, awW),
    height: Math.min(950, awH),
    minWidth: 960,
    minHeight: 600,
    show: true,
    frame: false,                 // custom CapCut-style title bar
    backgroundColor: '#111114',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

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
    const tr = translate.provider(spec.translation.providerId);
    const translationKey = tr.keyField ? settings.secret(tr.keyField) : undefined;
    const voice = voiceCredentials(spec.voice.providerId);
    if (tr.needsKey && !translationKey) throw new Error('Save the translation API key first.');
    if (!voice.apiKey || !spec.voice.voiceId) throw new Error('Save the voice API key and choose a voice first.');
    const result = await dialog.showSaveDialog(win, { title: 'Save Mongolian recap', defaultPath: 'mongolian-recap.mp4', filters: [{name:'MP4 video',extensions:['mp4']},{name:'MKV video',extensions:['mkv']}] });
    if (result.canceled || !result.filePath) return { ok:false,canceled:true };
    spec = { ...spec, outPath: result.filePath };
    let acquisitionSeconds = 0;
    if (spec.url) {
      const t = Date.now();
      emit({stage:'download'});
      const downloaded = await recapDownload.download(spec.url,spec.sourceLanguage,controller.signal,emit);
      spec.source = downloaded.source;
      spec.segments = undefined; // Never apply another video's restored transcript to a URL.
      if (downloaded.subtitle) {
        const rows = subtitles.parseSubtitleFile(downloaded.subtitle);
        // Rolling or overlapping captions need transcription instead.
        if (rows.length && rows.every((s,i)=>!i || s.start>=rows[i-1].end)) spec.segments = rows;
      }
      acquisitionSeconds = (Date.now()-t)/1000;
    }
    require('./recap-work').check(controller.signal);
    const output = await fastRecap.run(spec,{ translation:translationKey,voice },controller.signal,emit);
    output.acquisitionSeconds = acquisitionSeconds;
    output.totalElapsedSeconds = (Date.now()-started)/1000;
    output.targetMet = output.status === 'complete' && output.totalElapsedSeconds <= 600;
    require('./recap-work').write(output.reportPath, output);
    return { ok:true, ...output };
  } catch (err) {
    return { ok:false,error:String(err.message||err),reportPath:err.reportPath };
  } finally { recapController = null; }
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
    return {
      ok: true,
      path: filePath,
      name: path.basename(filePath),
      duration: probeInfo.duration || 0,
      hasAudio: probeInfo.hasAudio
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('audio:alignScript', async (_e, spec) => {
  try {
    return await audioScriptAlign.alignAudioWithScript(spec, (p) => win?.webContents.send('voice-align:progress', p));
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
ipcMain.handle('recap:autoCutBySrt', async (_e, spec) => {
  try {
    return await recapAutoCut.autoCutByEnglishSrt(spec, (p) => win?.webContents.send('recap-cut:progress', p));
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
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

ipcMain.handle('script:buildRecap', async (_e, spec) => {
  try {
    return await scriptStudio.buildScriptRecap(spec, (p) => win?.webContents.send('script:progress', p));
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
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
