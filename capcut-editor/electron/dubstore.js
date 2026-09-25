'use strict';
const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Persistence for dub work.
 *
 * Transcribing and translating a long video costs real time and real credits,
 * so the segments are kept on disk rather than only in component state: an app
 * restart, a crash, or simply coming back tomorrow must not throw the work
 * away. Voicing is a separate step precisely because it is the expensive one.
 */

const autosavePath = () => path.join(app.getPath('userData'), 'dub-session.json');

function save(file, payload) {
  const body = {
    version: 1,
    savedAt: new Date().toISOString(),
    ...payload
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 1));
  return file;
}

function load(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.segments)) throw new Error('That file has no transcript segments.');
  return data;
}

/** Silent, automatic checkpoint after every change. */
function autosave(payload) {
  try {
    save(autosavePath(), payload);
    return true;
  } catch {
    return false;
  }
}

function restore() {
  try {
    return load(autosavePath());
  } catch {
    return null;
  }
}

async function saveAs(win, payload, defaultName = 'dub.json') {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save transcript and translation',
    defaultPath: defaultName,
    filters: [{ name: 'Dub session', extensions: ['json'] }]
  });
  if (res.canceled || !res.filePath) return null;
  return save(res.filePath, payload);
}

async function openFrom(win) {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open transcript and translation',
    properties: ['openFile'],
    filters: [{ name: 'Dub session', extensions: ['json'] }]
  });
  if (res.canceled) return null;
  return load(res.filePaths[0]);
}

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

function srtStamp(seconds) {
  const ms = Math.round((seconds % 1) * 1000);
  return `${pad(seconds / 3600)}:${pad((seconds % 3600) / 60)}:${pad(seconds % 60)},${pad(ms, 3)}`;
}

/** Write the translated lines as SRT, for use outside this app. */
async function exportSrt(win, segments, defaultName = 'translated.srt') {
  const res = await dialog.showSaveDialog(win, {
    title: 'Export translated subtitles',
    defaultPath: defaultName,
    filters: [{ name: 'SubRip', extensions: ['srt'] }]
  });
  if (res.canceled || !res.filePath) return null;

  const body = segments
    .filter((s) => (s.translated || '').trim())
    .map((s, i) =>
      `${i + 1}\n${srtStamp(s.start)} --> ${srtStamp(s.end)}\n${s.translated.trim()}\n`
    )
    .join('\n');

  fs.writeFileSync(res.filePath, body, 'utf8');
  return res.filePath;
}

module.exports = { autosave, restore, saveAs, openFrom, exportSrt };
