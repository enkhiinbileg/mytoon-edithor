'use strict';

const fs = require('node:fs');
const path = require('node:path');
const safeSlicer = require('./safe-slicer');
const safetyAnalyzer = require('./safety-analyzer');
const safeProc = require('./safe-image-processor');
const safeMatcher = require('./safe-matcher');
const sessionStore = require('./safe-session-store');
const safeVoice = require('./safe-voice-pipeline');
const srtParser = require('../srt-parser');
const scriptStudio = require('../script-studio');

function registerSafeRecapIpc({ ipcMain, app, dialog, getWin, settings, ff }) {
  const sendProgress = (stage, message, percent) => {
    try {
      getWin()?.webContents.send('safe-recap:progress', { stage, message, percent });
    } catch {}
  };

  ipcMain.handle('safe-recap:checkEnv', async () => {
    try {
      return await safetyAnalyzer.checkEnvironment(app);
    } catch (err) {
      return { ok: false, pythonPath: null, hasImgutils: false, hasOnnxGpu: false, hasOpencv: false, error: err.message };
    }
  });

  ipcMain.handle('safe-recap:setupEnv', async () => {
    try {
      return await safetyAnalyzer.setupEnvironment(app, (msg, pct) => sendProgress('setup', msg, pct));
    } catch (err) {
      return { ok: false, pythonPath: null, hasImgutils: false, hasOnnxGpu: false, hasOpencv: false, error: err.message };
    }
  });

  ipcMain.handle('safe-recap:pickScriptFile', async () => {
    const res = await dialog.showOpenDialog(getWin(), {
      title: 'Скрипт текст файл сонгох (.txt)',
      filters: [{ name: 'Text Files (*.txt, *.md)', extensions: ['txt', 'md'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: true, canceled: true };
    const p = res.filePaths[0];
    const text = fs.readFileSync(p, 'utf8');
    return { ok: true, path: p, name: path.basename(p), text };
  });

  ipcMain.handle('safe-recap:openSrtAndParse', async () => {
    const res = await dialog.showOpenDialog(getWin(), {
      title: 'Хадмал сонгох (.srt)',
      filters: [{ name: 'Subtitles (*.srt, *.vtt)', extensions: ['srt', 'vtt'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: true, canceled: true };
    const p = res.filePaths[0];
    const raw = fs.readFileSync(p, 'utf8');
    const entries = srtParser.parseSrt(raw);
    const sentences = srtParser.reconstructSentences ? srtParser.reconstructSentences(entries) : entries;
    const beats = (sentences.length ? sentences : entries).map((e, idx) => ({
      id: `srt_${idx + 1}`,
      start: e.start,
      end: e.end,
      text: e.text
    }));
    return { ok: true, path: p, name: path.basename(p), beats };
  });

  ipcMain.handle('safe-recap:pickAudioFile', async () => {
    const res = await dialog.showOpenDialog(getWin(), {
      title: 'Бэлэн дуу файл сонгох',
      filters: [{ name: 'Audio (*.mp3, *.wav, *.m4a, *.aac)', extensions: ['mp3', 'wav', 'm4a', 'aac'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: true, canceled: true };
    const p = res.filePaths[0];
    let duration = 0;
    try {
      const info = await ff.probe(p);
      duration = info.duration || 0;
    } catch {}
    return { ok: true, path: p, name: path.basename(p), duration };
  });

  ipcMain.handle('safe-recap:preparePanels', async (_e, { paths, sliceMode = 'smart', sessionId = 'default' }) => {
    try {
      const cacheDir = path.join(sessionStore.getCacheDir(app, sessionId), 'sliced-panels');
      const res = await safeSlicer.prepareSafePanels(paths, {
        cacheDir,
        sliceMode,
        onProgress: (msg, pct) => sendProgress('slicing', msg, pct)
      });
      return { ok: true, panels: res.panels, cacheDir: res.cacheDir };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('safe-recap:analyzePanels', async (_e, { panels, sessionId = 'default', strictness = 'balanced', defaultCensorMode = 'blur' }) => {
    try {
      const cacheDir = sessionStore.getCacheDir(app, sessionId);
      const enriched = await safetyAnalyzer.analyzePanels({
        app,
        panels,
        cacheDir,
        strictness,
        defaultCensorMode,
        onProgress: (msg, pct) => sendProgress('safety', msg, pct)
      });
      return { ok: true, panels: enriched };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('safe-recap:previewEdit', async (_e, { sessionId = 'default', panel, cropRect, censorBoxes, recheck = true, materializeFull = false, strictness = 'balanced' }) => {
    try {
      const cacheDir = sessionStore.getCacheDir(app, sessionId);
      const thumbDir = path.join(cacheDir, 'sanitized-thumbs');
      const renderDir = path.join(cacheDir, 'sanitized-render');

      const preview = await safeProc.materializeSanitizedImage({
        imagePath: panel.path,
        origW: panel.width,
        origH: panel.height,
        cropRect,
        censorBoxes,
        outDir: thumbDir,
        maxWidth: 480,
        quality: 3
      });

      let full = null;
      if (materializeFull) {
        full = await safeProc.materializeSanitizedImage({
          imagePath: panel.path,
          origW: panel.width,
          origH: panel.height,
          cropRect,
          censorBoxes,
          outDir: renderDir,
          maxWidth: 0,
          quality: 2
        });
      }

      let recheckRes = null;
      if (recheck) {
        recheckRes = await safetyAnalyzer.recheckSingleImage({
          app,
          imagePath: preview.path,
          strictness
        });
      }

      return {
        ok: true,
        previewPath: preview.path,
        renderPath: full?.path || undefined,
        renderWidth: full?.width || panel.width,
        renderHeight: full?.height || panel.height,
        recheck: recheckRes
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('safe-recap:splitScriptToBeats', async (_e, { scriptText, wordsPerSec = 2.3 }) => {
    try {
      const beats = safeMatcher.splitTextToEstimatedBeats(scriptText, wordsPerSec);
      const duration = beats.length ? beats[beats.length - 1].end : 0;
      return { ok: true, beats, duration };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('safe-recap:getWhisperStatus', async () => {
    try {
      return { ok: true, ...safeVoice.getAvailableWhisperModels() };
    } catch (err) {
      return { ok: false, available: false, models: [], error: err.message };
    }
  });

  ipcMain.handle('safe-recap:generateVoiceFromScript', async (_e, spec) => {
    try {
      return await safeVoice.buildVoiceAndFixedSubtitles({
        app,
        sessionId: spec.sessionId || 'default',
        scriptText: spec.scriptText,
        voiceId: spec.voiceId,
        modelId: spec.modelId || 'eleven_v4',
        stability: spec.stability ?? 0.5,
        similarity: spec.similarity ?? 0.75,
        speed: spec.speed ?? 1.0,
        autoTagScript: Boolean(spec.autoTagScript),
        whisperModel: spec.whisperModel || '',
        onProgress: (stage, msg, pct) => sendProgress(stage, msg, pct)
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('safe-recap:fixSubtitlesWithScript', async (_e, spec) => {
    try {
      return await safeVoice.fixSubtitlesWithScript({
        scriptText: spec.scriptText,
        draftBeats: spec.draftBeats,
        audioDuration: spec.audioDuration || 0
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('safe-recap:align', async (_e, spec) => {
    try {
      const cacheDir = sessionStore.getCacheDir(app, spec.sessionId || 'default');
      const geminiKey = settings.secret('geminiApiKey') || process.env.GEMINI_API_KEY || '';
      const res = await safeMatcher.alignSafeImagesToBeats({
        beats: spec.beats,
        panels: spec.panels,
        apiKey: geminiKey,
        model: spec.model || 'gemini-2.5-flash',
        audioDuration: spec.audioDuration || 0,
        aspectRatio: spec.aspectRatio || '16:9',
        cacheDir,
        useAi: spec.useAi !== false,
        onProgress: (msg, pct) => sendProgress('matching', msg, pct)
      });
      return { ok: true, plan: res.plan, blockedPanelIds: res.blockedPanelIds };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('safe-recap:materializePlan', async (_e, { sessionId = 'default', plan }) => {
    try {
      const cacheDir = sessionStore.getCacheDir(app, sessionId);
      const updated = await safetyAnalyzer.materializePlan({
        plan,
        cacheDir,
        onProgress: (msg, pct) => sendProgress('materialize', msg, pct)
      });
      return { ok: true, plan: updated };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('safe-recap:saveSession', async (_e, session) => {
    try {
      return sessionStore.saveSession(app, session);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('safe-recap:loadSession', async (_e, sessionId) => {
    try {
      const session = sessionStore.loadSession(app, sessionId);
      return { ok: true, session };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('safe-recap:listSessions', async () => {
    try {
      return { ok: true, sessions: sessionStore.listSessions(app) };
    } catch (err) {
      return { ok: false, sessions: [], error: err.message };
    }
  });

  ipcMain.handle('safe-recap:deleteSession', async (_e, sessionId) => {
    try {
      return sessionStore.deleteSession(app, sessionId);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

module.exports = {
  registerSafeRecapIpc
};
