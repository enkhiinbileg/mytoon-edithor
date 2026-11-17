'use strict';

const fs = require('node:fs');
const path = require('node:path');

function getSessionsDir(app) {
  const dir = path.join(app.getPath('userData'), 'safe-recap-sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getCacheDir(app, sessionId = 'default') {
  const safeId = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(app.getPath('userData'), 'safe-recap-cache', safeId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function deriveSessionName(session) {
  const explicit = String(session.name || '').trim();
  if (explicit && explicit !== 'Вебтүүн Safe Recap') return explicit.slice(0, 80);

  const firstScriptLine = String(session.scriptText || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\[[^\]]+\]/g, '').trim())
    .find(Boolean);
  if (firstScriptLine) {
    return firstScriptLine.slice(0, 48) + (firstScriptLine.length > 48 ? '…' : '');
  }

  if (Array.isArray(session.rawPickedPaths) && session.rawPickedPaths[0]) {
    return path.basename(session.rawPickedPaths[0]);
  }
  if (session.audioName) return session.audioName.replace(/\.[^.]+$/, '');
  return 'Вебтүүн Safe Recap';
}

function inferCompletedStages(session) {
  const set = new Set(Array.isArray(session.completedStages) ? session.completedStages : []);
  if (Array.isArray(session.panels) && session.panels.length > 0) set.add('panels');
  if (Array.isArray(session.panels) && session.panels.some((p) => p.safetyStatus && p.safetyStatus !== 'unchecked')) {
    set.add('safety');
  }
  if (session.audioPath) set.add('voice');
  if (Array.isArray(session.draftSubtitles) && session.draftSubtitles.length > 0) set.add('whisper');
  if (session.subtitleMethod && /script/i.test(session.subtitleMethod)) set.add('fix');
  if (Array.isArray(session.plan) && session.plan.length > 0) set.add('align');
  return Array.from(set);
}

function saveSession(app, session) {
  if (!session || !session.id) throw new Error('Session ID шаардлагатай.');
  const safeId = String(session.id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(getSessionsDir(app), `${safeId}.json`);
  const payload = {
    ...session,
    id: safeId,
    name: deriveSessionName(session),
    completedStages: inferCompletedStages(session),
    updatedAt: Date.now()
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
  return { ok: true, id: safeId, path: filePath, name: payload.name, updatedAt: payload.updatedAt };
}

function loadSession(app, sessionId) {
  const safeId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(getSessionsDir(app), `${safeId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listSessions(app) {
  const dir = getSessionsDir(app);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const items = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const panels = Array.isArray(data.panels) ? data.panels : [];
      const safeCount = panels.filter((p) => p.safetyStatus === 'safe').length;
      const reviewCount = panels.filter((p) => p.safetyStatus === 'cropped' || p.safetyStatus === 'blurred').length;
      const excludedCount = panels.filter((p) => p.safetyStatus === 'excluded').length;
      const cleanScript = String(data.scriptText || '').replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();

      items.push({
        id: data.id || f.replace(/\.json$/, ''),
        name: data.name || 'Нэргүй Safe Recap',
        updatedAt: data.updatedAt || 0,
        panelCount: panels.length,
        safeCount,
        reviewCount,
        excludedCount,
        beatCount: Array.isArray(data.subtitles) ? data.subtitles.length : 0,
        planCount: Array.isArray(data.plan) ? data.plan.length : 0,
        inputMode: data.inputMode || 'script',
        completedStages: inferCompletedStages(data),
        audioPath: data.audioPath || '',
        audioDuration: Number(data.audioDuration || 0),
        subtitleMethod: data.subtitleMethod || '',
        scriptPreview: cleanScript.slice(0, 110)
      });
    } catch {}
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

function deleteSession(app, sessionId) {
  const safeId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(getSessionsDir(app), `${safeId}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const cacheDir = path.join(app.getPath('userData'), 'safe-recap-cache', safeId);
  if (fs.existsSync(cacheDir)) {
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch {}
  }
  return { ok: true };
}

module.exports = {
  getSessionsDir,
  getCacheDir,
  saveSession,
  loadSession,
  listSessions,
  deleteSession
};
