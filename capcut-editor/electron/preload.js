'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  saveProject: (data, path, saveAs) => ipcRenderer.invoke('project:save', data, path, saveAs),
  openProject: () => ipcRenderer.invoke('project:open'),
  openProjectPath: (path) => ipcRenderer.invoke('project:openPath', path),
  autosaveProject: (data, path) => ipcRenderer.invoke('project:autosave', data, path),
  restoreProject: () => ipcRenderer.invoke('project:restore'),

  // CapCut Project Library
  listProjects: () => ipcRenderer.invoke('projects:list'),
  openProjectById: (id) => ipcRenderer.invoke('projects:get', id),
  createProject: (name) => ipcRenderer.invoke('projects:create', name),
  autosaveProjectById: (id, payload, metaPatch) => ipcRenderer.invoke('projects:autosave', id, payload, metaPatch),
  duplicateProject: (id) => ipcRenderer.invoke('projects:duplicate', id),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),
  renameProjectById: (id, name) => ipcRenderer.invoke('projects:rename', id, name),
  showProjectInFolder: (id) => ipcRenderer.invoke('projects:showInFolder', id),
  getActiveProjectId: () => ipcRenderer.invoke('projects:getActiveId'),
  initialMedia: () => ipcRenderer.invoke('app:initialMedia'),
  openMedia: () => ipcRenderer.invoke('dialog:openMedia'),
  probe: (filePath) => ipcRenderer.invoke('media:probe', filePath),
  thumbnails: (filePath, duration, count) =>
    ipcRenderer.invoke('media:thumbnails', filePath, duration, count),
  waveform: (filePath) => ipcRenderer.invoke('media:waveform', filePath),
  clipThumbnails: (filePath, timestamps) =>
    ipcRenderer.invoke('media:clipThumbnails', { filePath, timestamps }),
  sceneDetect: (filePath, threshold) =>
    ipcRenderer.invoke('media:sceneDetect', { filePath, threshold }),

  saveExportDialog: (defaultName) => ipcRenderer.invoke('dialog:saveExport', defaultName),
  runExport: (spec) => ipcRenderer.invoke('export:run', spec),
  detectEncoders: () => ipcRenderer.invoke('export:detectEncoders'),
  selectExportFolder: (defaultDir) => ipcRenderer.invoke('export:selectFolder', defaultDir),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  openExportPath: (filePath) => ipcRenderer.invoke('export:openPath', filePath),
  getDefaultExportDir: () => ipcRenderer.invoke('export:getDefaultDir'),
  onExportProgress: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('export:progress', handler);
    return () => ipcRenderer.removeListener('export:progress', handler);
  },
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  copyFile: (source, target) => ipcRenderer.invoke('file:copy', { source, target }),

  // --- settings (secrets are write-only: reads return booleans) ---
  readSettings: () => ipcRenderer.invoke('settings:read'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),

  prepareVoiceEdit: spec => ipcRenderer.invoke('voice-edit:prepare',spec),
  renderVoiceEdit: spec => ipcRenderer.invoke('voice-edit:render',spec),
  syncTimelineVoice: spec => ipcRenderer.invoke('voice-edit:sync',spec),
  openSrtFile: () => ipcRenderer.invoke('dialog:openSrt'),
  openTxtFile: () => ipcRenderer.invoke('dialog:openTxt'),
  openAudioFileDialog: () => ipcRenderer.invoke('dialog:openAudioFile'),
  alignAudioScript: (spec) => ipcRenderer.invoke('audio:alignScript', spec),
  onVoiceAlignProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('voice-align:progress', h);
    return () => ipcRenderer.removeListener('voice-align:progress', h);
  },
  syncTimelineSrt: spec => ipcRenderer.invoke('srt:sync', spec),
  autoCutBySrt: (spec) => ipcRenderer.invoke('recap:autoCutBySrt', spec),
  onRecapCutProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('recap-cut:progress', h);
    return () => ipcRenderer.removeListener('recap-cut:progress', h);
  },
  buildScriptRecap: spec => ipcRenderer.invoke('script:buildRecap', spec),
  onScriptStudioProgress: cb => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('script:progress', h);
    return () => ipcRenderer.removeListener('script:progress', h);
  },

  // ElevenLabs Key Pool management
  getElevenKeyPool: () => ipcRenderer.invoke('eleven:getPool'),
  addElevenKey: (key, label) => ipcRenderer.invoke('eleven:addKey', { key, label }),
  removeElevenKey: (keyId) => ipcRenderer.invoke('eleven:removeKey', keyId),
  toggleElevenKey: (keyId, enabled) => ipcRenderer.invoke('eleven:toggleKey', { keyId, enabled }),
  refreshElevenQuotas: () => ipcRenderer.invoke('eleven:refreshQuotas'),
  cancelVoiceEdit: () => ipcRenderer.invoke('voice-edit:cancel'),
  onVoiceEditProgress: cb => {
    const h=(_e,p)=>cb(p);ipcRenderer.on('voice-edit:progress',h);
    return ()=>ipcRenderer.removeListener('voice-edit:progress',h);
  },
  recapStatus: () => ipcRenderer.invoke('recap:status'),
  setupRecapDownloader: () => ipcRenderer.invoke('recap:setup'),
  runFastRecap: (spec) => ipcRenderer.invoke('recap:run', spec),
  cancelFastRecap: () => ipcRenderer.invoke('recap:cancel'),
  onRecapProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('recap:progress', h);
    return () => ipcRenderer.removeListener('recap:progress', h);
  },

  // --- auto-dub pipeline ---
  whisperStatus: () => ipcRenderer.invoke('whisper:status'),
  downloadWhisperModel: (model) => ipcRenderer.invoke('whisper:download', model),
  onWhisperProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('whisper:progress', h);
    return () => ipcRenderer.removeListener('whisper:progress', h);
  },

  transcribe: (spec) => ipcRenderer.invoke('dub:transcribe', spec),
  openSubtitles: () => ipcRenderer.invoke('dub:openSubtitles'),
  autosaveDub: (payload) => ipcRenderer.invoke('dub:autosave', payload),
  restoreDub: () => ipcRenderer.invoke('dub:restore'),
  saveDubAs: (payload) => ipcRenderer.invoke('dub:saveAs', payload),
  openDubFrom: () => ipcRenderer.invoke('dub:openFrom'),
  exportDubSrt: (segments) => ipcRenderer.invoke('dub:exportSrt', segments),

  translateProviders: () => ipcRenderer.invoke('translate:providers'),
  translateModels: (providerId) => ipcRenderer.invoke('translate:models', providerId),
  translateSegments: (spec) => ipcRenderer.invoke('dub:translate', spec),
  synthesizeDub: (spec) => ipcRenderer.invoke('dub:synthesize', spec),
  onDubProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('dub:progress', h);
    return () => ipcRenderer.removeListener('dub:progress', h);
  },

  voiceProviders: () => ipcRenderer.invoke('tts:providers'),
  listVoices: (providerId) => ipcRenderer.invoke('tts:voices', providerId),
  listTtsModels: (providerId) => ipcRenderer.invoke('tts:models', providerId),
  voiceQuota: (providerId) => ipcRenderer.invoke('tts:quota', providerId),

  extractFreezeFrame: (spec) => ipcRenderer.invoke('freeze-frame:extract', spec),

  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  close: () => ipcRenderer.invoke('window:close'),

  // Fonts
  getAvailableFonts: () => ipcRenderer.invoke('fonts:getAvailable'),
  importCustomFonts: () => ipcRenderer.invoke('fonts:importCustom'),

  // Absolute path -> URL the renderer can put in <video>/<img>.
  // `media` is registered as a *standard* scheme, and Chromium rejects standard
  // URLs with an empty authority, so a dummy host is required. Each segment is
  // encoded so "C:" is never parsed as host:port.
  toMediaUrl: (filePath) =>
    'media://local/' +
    filePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
});
