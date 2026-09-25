'use strict';
const fs = require('node:fs');
const path = require('node:path');

function validateProject(data) {
  const fail = () => { throw new Error('This is not a valid Cutline project (version 1).'); };
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  if (!data || data.format !== 'cutline-project' || data.version !== 1 || typeof data.name !== 'string') fail();
  if (![data.media, data.tracks, data.clips].every(Array.isArray)) fail();
  if (data.media.length > 10000 || data.clips.length > 100000 || data.tracks.length > 200) fail();
  for (const collection of [data.media, data.tracks, data.clips]) {
    if (collection.some(x => !x || typeof x.id !== 'string') || new Set(collection.map(x => x.id)).size !== collection.length) fail();
  }
  const settings = data.settings;
  if (!settings || ![settings.width, settings.height].every(n => Number.isInteger(n) && n >= 16 && n <= 7680 && n % 2 === 0) || !finite(settings.fps) || settings.fps < 1 || settings.fps > 120) fail();
  const media = data.media.map(m => {
    if (typeof m.path !== 'string' || typeof m.name !== 'string' || !['video', 'audio', 'image', 'unknown'].includes(m.kind) || ![m.duration,m.width,m.height,m.fps].every(finite) || m.duration < 0 || !Array.isArray(m.thumbs) || !m.thumbs.every(t => typeof t === 'string')) fail();
    return {id:m.id,path:m.path,name:m.name,kind:m.kind,duration:m.duration,width:m.width,height:m.height,fps:m.fps,hasAudio:!!m.hasAudio,thumbs:m.thumbs};
  });
  const tracks = data.tracks.map(t => {
    if (!['video','audio','overlay'].includes(t.kind) || typeof t.name !== 'string') fail();
    return {id:t.id,kind:t.kind,name:t.name,hidden:!!t.hidden,muted:!!t.muted,locked:!!t.locked};
  });
  const clips = data.clips.map(c => {
    if (!['av','text','sticker'].includes(c.kind) || !tracks.some(t => t.id === c.trackId) || ![c.start,c.inPoint,c.outPoint].every(finite) || c.start < 0 || c.inPoint < 0 || c.outPoint <= c.inPoint) fail();
    if (c.kind === 'av' && !media.some(m => m.id === c.mediaId)) fail();
    const result = {id:c.id,kind:c.kind,trackId:c.trackId,start:c.start,inPoint:c.inPoint,outPoint:c.outPoint};
    for (const key of ['mediaId','sticker','filterId','effectId','transitionId','fitMode','label','englishText','mongolianText','aiReason']) {
      if (c[key] !== undefined) { if (typeof c[key] !== 'string') fail(); result[key] = c[key]; }
    }
    for (const key of ['x','y','scale','rotation','volume','opacity','transitionDuration','matchedSrtId','sourceStart','sourceEnd','freezeTs','aiConfidence']) {
      if (c[key] !== undefined) { if (!finite(c[key])) fail(); result[key] = c[key]; }
    }
    for (const key of ['isFreeze','aiVerified']) {
      if (c[key] !== undefined) { result[key] = !!c[key]; }
    }
    if (Array.isArray(c.keyframes)) {
      result.keyframes = c.keyframes.map(kf => {
        if (!kf || typeof kf.id !== 'string' || !finite(kf.time) || kf.time < 0) fail();
        const item = { id: kf.id, time: kf.time };
        for (const k of ['scale', 'x', 'y', 'rotation', 'opacity']) {
          if (kf[k] !== undefined) {
            if (!finite(kf[k])) fail();
            item[k] = kf[k];
          }
        }
        return item;
      });
    }
    if (c.style) {
      const s = c.style;
      if (![s.text,s.color,s.background].every(x => typeof x === 'string') || !finite(s.fontSize) || s.fontSize < 1 || s.fontSize > 2000) fail();
      result.style = {text:s.text,color:s.color,background:s.background,fontSize:s.fontSize,bold:!!s.bold,shadow:!!s.shadow};
    }
    if (c.kind !== 'av' && !result.style) fail();
    return result;
  });
  return {format:'cutline-project',version:1,name:data.name.slice(0,200),media,tracks,clips,settings:{width:settings.width,height:settings.height,fps:settings.fps}};
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(data, null, 2)); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function pathToMediaUrl(filePath) {
  if (!filePath) return '';
  return 'media://local/' + filePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}

async function ensureProjectCover(projectId, projectData, projectsDirectory) {
  const coverFile = path.join(projectsDirectory, `${projectId}.cover.jpg`);
  if (fs.existsSync(coverFile)) {
    return pathToMediaUrl(coverFile);
  }

  const mediaList = Array.isArray(projectData?.media) ? projectData.media : [];
  const firstVisual = mediaList.find(m => m.kind === 'video' || m.kind === 'image') || mediaList[0];
  if (!firstVisual || !firstVisual.path || !fs.existsSync(firstVisual.path)) {
    return '';
  }

  if (firstVisual.kind === 'image') {
    return pathToMediaUrl(firstVisual.path);
  }

  // It's a video: extract a high-res 1080p frame at 2s (or 10% of duration)
  try {
    const { run, FFMPEG } = require('./ffmpeg');
    const timeToSeek = Math.min(2, Math.max(0, (firstVisual.duration || 0) * 0.1));
    await run(FFMPEG, [
      '-hwaccel', 'auto',
      '-y',
      '-ss', String(timeToSeek),
      '-i', firstVisual.path,
      '-frames:v', '1',
      '-vf', 'scale=1080:-2',
      '-q:v', '2',
      coverFile
    ]);
    if (fs.existsSync(coverFile)) {
      return pathToMediaUrl(coverFile);
    }
  } catch (err) {
    console.warn(`[ProjectStore] Failed to generate 1080p cover for ${projectId}:`, err.message);
  }

  return '';
}

function registerProjectHandlers({ipcMain,dialog,app,getWindow}) {
  const draft = () => path.join(app.getPath('userData'), 'editor-draft.json');
  const projectsDir = () => path.join(app.getPath('userData'), 'projects');
  const metaPath = () => path.join(projectsDir(), 'projects.json');
  const activePath = () => path.join(app.getPath('userData'), 'active-project.json');

  function getProjectsList() {
    try {
      const p = metaPath();
      if (fs.existsSync(p)) {
        const list = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(list)) return list;
      }
    } catch {}
    return [];
  }

  function saveProjectsList(list) {
    atomicWrite(metaPath(), list);
  }

  // Auto-migrate from single draft file if library is empty
  function ensureInitialProject() {
    fs.mkdirSync(projectsDir(), { recursive: true });
    let list = getProjectsList();
    if (list.length === 0) {
      // Check if legacy draft exists with content
      let draftData = null;
      try {
        if (fs.existsSync(draft())) {
          const raw = JSON.parse(fs.readFileSync(draft(), 'utf8'));
          if (raw?.data && raw.data.clips?.length) {
            draftData = validateProject(raw.data);
          }
        }
      } catch {}

      if (!draftData) {
        return [];
      }

      const initId = 'proj_' + Date.now().toString(36);
      const initName = draftData.name || 'Миний төсөл 1';
      const filePath = path.join(projectsDir(), `${initId}.cutline`);
      atomicWrite(filePath, draftData);

      const meta = {
        id: initId,
        name: initName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        duration: draftData.clips.reduce((max, c) => Math.max(max, c.start + c.outPoint - c.inPoint), 0),
        clipCount: draftData.clips.length,
        cover: draftData.media?.[0]?.thumbs?.[0] || ''
      };
      list = [meta];
      saveProjectsList(list);
      atomicWrite(activePath(), { id: initId });
    }
    return list;
  }

  const protect = fn => async (...args) => { try { return await fn(...args); } catch(e) { return {ok:false,error:e.message}; } };

  // --- CapCut-style Project Library IPC Handlers ---

  ipcMain.handle('projects:list', protect(async () => {
    ensureInitialProject();
    const list = getProjectsList();

    // Verify file existence AND prune empty abandoned projects (0 clips and 0 media)
    const valid = [];
    let listChanged = false;

    for (const item of list) {
      const p = path.join(projectsDir(), `${item.id}.cutline`);
      if (!fs.existsSync(p)) {
        listChanged = true;
        continue;
      }

      // If project has 0 clips and 0 duration, check if it is completely empty
      if (item.clipCount === 0 && (!item.duration || item.duration === 0)) {
        try {
          const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
          if ((!raw.clips || raw.clips.length === 0) && (!raw.media || raw.media.length === 0)) {
            // Delete abandoned empty project from disk and skip it!
            try { fs.unlinkSync(p); } catch {}
            const coverPath = path.join(projectsDir(), `${item.id}.cover.jpg`);
            try { if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath); } catch {}
            listChanged = true;
            continue;
          }
        } catch {}
      }

      // Ensure crisp high-res 1080p cover
      const coverPath = path.join(projectsDir(), `${item.id}.cover.jpg`);
      if (fs.existsSync(coverPath)) {
        const highResUrl = pathToMediaUrl(coverPath);
        if (item.cover !== highResUrl) {
          item.cover = highResUrl;
          listChanged = true;
        }
      } else {
        // If cover is missing or pointing to legacy low-res temp thumbnail, extract 1080p cover
        try {
          const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
          const generatedCover = await ensureProjectCover(item.id, raw, projectsDir());
          if (generatedCover && item.cover !== generatedCover) {
            item.cover = generatedCover;
            listChanged = true;
          }
        } catch {}
      }

      valid.push(item);
    }

    if (listChanged || valid.length !== list.length) {
      saveProjectsList(valid);
    }
    const enriched = valid.map(item => {
      const p = path.join(projectsDir(), `${item.id}.cutline`);
      let size = 0;
      try { size = fs.statSync(p).size; } catch {}
      return { ...item, filePath: p, size };
    });
    return { ok: true, projects: enriched.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) };
  }));

  ipcMain.handle('projects:showInFolder', protect(async (_e, id) => {
    if (!id) throw new Error('Missing project ID');
    const p = path.join(projectsDir(), `${id}.cutline`);
    if (fs.existsSync(p)) {
      const { shell } = require('electron');
      shell.showItemInFolder(p);
      return { ok: true };
    }
    return { ok: false, error: 'File not found' };
  }));

  ipcMain.handle('projects:get', protect(async (_e, id) => {
    console.log('[ProjectStore] projects:get requested for id:', id);
    if (!id) throw new Error('Missing project ID');
    const p = path.join(projectsDir(), `${id}.cutline`);
    if (!fs.existsSync(p)) throw new Error('Project not found on disk');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    console.log('[ProjectStore] Read raw project clips:', raw.clips?.length);
    const data = validateProject(raw);
    console.log('[ProjectStore] Validated project clips:', data.clips?.length);
    atomicWrite(activePath(), { id });
    return { ok: true, id, data };
  }));

  ipcMain.handle('projects:create', protect(async (_e, customName) => {
    ensureInitialProject();
    const id = 'proj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const name = (customName && typeof customName === 'string' && customName.trim())
      ? customName.trim().slice(0, 100)
      : 'Шинэ төсөл ' + new Date().toLocaleDateString('mn-MN');

    const doc = {
      format: 'cutline-project',
      version: 1,
      name,
      media: [],
      tracks: [
        { id: 'v1', name: 'Video 1', kind: 'video', hidden: false, muted: false, locked: false },
        { id: 'a1', name: 'Audio 1', kind: 'audio', hidden: false, muted: false, locked: false },
        { id: 'o1', name: 'Overlay', kind: 'overlay', hidden: false, muted: false, locked: false }
      ],
      clips: [],
      settings: { width: 1920, height: 1080, fps: 30 }
    };

    const filePath = path.join(projectsDir(), `${id}.cutline`);
    atomicWrite(filePath, doc);

    const meta = {
      id,
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      duration: 0,
      clipCount: 0,
      cover: ''
    };

    const list = getProjectsList();
    list.unshift(meta);
    saveProjectsList(list);
    atomicWrite(activePath(), { id });

    return { ok: true, id, data: doc, meta };
  }));

  ipcMain.handle('projects:autosave', protect(async (_e, id, payload, metaPatch = {}) => {
    console.log('[ProjectStore] projects:autosave called for id:', id, 'payload clips:', payload?.clips?.length);
    if (!id) throw new Error('Missing project ID');
    const data = validateProject(payload);
    const filePath = path.join(projectsDir(), `${id}.cutline`);
    atomicWrite(filePath, data);

    const list = getProjectsList();
    const idx = list.findIndex(p => p.id === id);
    const dur = typeof metaPatch.duration === 'number' ? metaPatch.duration : data.clips.reduce((max, c) => Math.max(max, c.start + c.outPoint - c.inPoint), 0);

    // Ensure high-res cover file
    const coverPath = path.join(projectsDir(), `${id}.cover.jpg`);
    let cover = '';
    if (fs.existsSync(coverPath)) {
      cover = pathToMediaUrl(coverPath);
    } else {
      cover = await ensureProjectCover(id, data, projectsDir());
    }
    if (!cover) {
      cover = metaPatch.cover || (idx >= 0 ? list[idx].cover : '') || (data.media?.[0]?.thumbs?.[0] || '');
    }

    const updatedMeta = {
      id,
      name: data.name,
      createdAt: idx >= 0 ? list[idx].createdAt : Date.now(),
      updatedAt: Date.now(),
      duration: dur,
      clipCount: data.clips.length,
      cover
    };

    if (idx >= 0) {
      list[idx] = updatedMeta;
    } else {
      list.unshift(updatedMeta);
    }
    saveProjectsList(list);
    atomicWrite(activePath(), { id });

    // Also update editor-draft.json for backward-compatibility
    atomicWrite(draft(), { data, path: filePath });

    return { ok: true };
  }));

  ipcMain.handle('projects:duplicate', protect(async (_e, id) => {
    if (!id) throw new Error('Missing project ID');
    const origPath = path.join(projectsDir(), `${id}.cutline`);
    if (!fs.existsSync(origPath)) throw new Error('Original project not found');

    const origData = validateProject(JSON.parse(fs.readFileSync(origPath, 'utf8')));
    const newId = 'proj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const newName = `${origData.name} (Хуулбар)`.slice(0, 100);

    const newDoc = { ...origData, name: newName };
    const newPath = path.join(projectsDir(), `${newId}.cutline`);
    atomicWrite(newPath, newDoc);

    const list = getProjectsList();
    const origMeta = list.find(p => p.id === id);

    // Duplicate cover file if present
    const origCover = path.join(projectsDir(), `${id}.cover.jpg`);
    const newCover = path.join(projectsDir(), `${newId}.cover.jpg`);
    let coverUrl = origMeta?.cover || '';
    if (fs.existsSync(origCover)) {
      try {
        fs.copyFileSync(origCover, newCover);
        coverUrl = pathToMediaUrl(newCover);
      } catch {}
    }

    const newMeta = {
      id: newId,
      name: newName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      duration: origMeta?.duration || 0,
      clipCount: origDocClipsCount(newDoc),
      cover: coverUrl
    };
    list.unshift(newMeta);
    saveProjectsList(list);

    return { ok: true, id: newId, meta: newMeta };
  }));

  function origDocClipsCount(doc) {
    return Array.isArray(doc.clips) ? doc.clips.length : 0;
  }

  ipcMain.handle('projects:rename', protect(async (_e, id, newName) => {
    if (!id || !newName || typeof newName !== 'string') throw new Error('Invalid rename params');
    const trimmed = newName.trim().slice(0, 100);
    const filePath = path.join(projectsDir(), `${id}.cutline`);
    if (fs.existsSync(filePath)) {
      const data = validateProject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
      data.name = trimmed;
      atomicWrite(filePath, data);
    }

    const list = getProjectsList();
    const item = list.find(p => p.id === id);
    if (item) {
      item.name = trimmed;
      item.updatedAt = Date.now();
      saveProjectsList(list);
    }
    return { ok: true, name: trimmed };
  }));

  ipcMain.handle('projects:delete', protect(async (_e, id) => {
    if (!id) throw new Error('Missing project ID');
    const filePath = path.join(projectsDir(), `${id}.cutline`);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    const coverPath = path.join(projectsDir(), `${id}.cover.jpg`);
    if (fs.existsSync(coverPath)) {
      try { fs.unlinkSync(coverPath); } catch {}
    }

    let list = getProjectsList();
    list = list.filter(p => p.id !== id);
    saveProjectsList(list);

    // If active was deleted, clear or set next active
    try {
      if (fs.existsSync(activePath())) {
        const act = JSON.parse(fs.readFileSync(activePath(), 'utf8'));
        if (act?.id === id) {
          if (list.length > 0) {
            atomicWrite(activePath(), { id: list[0].id });
          } else {
            fs.unlinkSync(activePath());
          }
        }
      }
    } catch {}

    return { ok: true };
  }));

  ipcMain.handle('projects:getActiveId', protect(async () => {
    ensureInitialProject();
    try {
      if (fs.existsSync(activePath())) {
        const act = JSON.parse(fs.readFileSync(activePath(), 'utf8'));
        if (act?.id) return { ok: true, id: act.id };
      }
    } catch {}
    const list = getProjectsList();
    return { ok: true, id: list[0]?.id || null };
  }));

  // --- Legacy / File-based project handlers ---

  ipcMain.handle('project:save', protect(async (_e, payload, file, saveAs) => {
    const data = validateProject(payload);
    if (!file || saveAs) {
      const res = await dialog.showSaveDialog(getWindow(), {title:'Save project',defaultPath:file || `${data.name.replace(/[<>:"/\\|?*]/g,'_')}.cutline`,filters:[{name:'Cutline project',extensions:['cutline']}]});
      if (res.canceled || !res.filePath) return {ok:false,canceled:true};
      file = res.filePath;
    }
    if (path.extname(file).toLowerCase() !== '.cutline') file += '.cutline';
    atomicWrite(file, data);
    return {ok:true,path:file};
  }));
  ipcMain.handle('project:open', protect(async () => {
    const res = await dialog.showOpenDialog(getWindow(), {title:'Open project',properties:['openFile'],filters:[{name:'Cutline project',extensions:['cutline']}]});
    if (res.canceled || !res.filePaths.length) return {ok:false,canceled:true};
    const file = res.filePaths[0];
    if (fs.statSync(file).size > 50 * 1024 * 1024) throw new Error('Project file is too large.');
    return {ok:true,path:file,data:validateProject(JSON.parse(fs.readFileSync(file,'utf8')))};
  }));
  ipcMain.handle('project:openPath', protect(async (_e, file) => {
    if (!file || !fs.existsSync(file)) return {ok:false, error:'Project file not found.'};
    if (fs.statSync(file).size > 50 * 1024 * 1024) throw new Error('Project file is too large.');
    return {ok:true,path:file,data:validateProject(JSON.parse(fs.readFileSync(file,'utf8')))};
  }));
  ipcMain.handle('project:autosave', protect((_e,data,file) => {
    atomicWrite(draft(), {data:validateProject(data),path:typeof file === 'string' ? file : null});
    return {ok:true};
  }));
  ipcMain.handle('project:restore', () => {
    try {
      const saved = JSON.parse(fs.readFileSync(draft(),'utf8')), data=validateProject(saved.data);
      let dirty = true;
      try { if(saved.path)dirty=JSON.stringify(validateProject(JSON.parse(fs.readFileSync(saved.path,'utf8'))))!==JSON.stringify(data); } catch {}
      return {data,path:saved.path,dirty};
    }
    catch { return null; }
  });
}
module.exports = {validateProject,atomicWrite,registerProjectHandlers};
