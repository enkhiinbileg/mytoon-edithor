import { useCallback, useEffect, useRef, useState } from 'react';
import TitleBar from './components/TitleBar';
import Rail, { type RailTab } from './components/Rail';
import MediaPanel from './components/MediaPanel';
import TextPanel from './components/TextPanel';
import StickerPanel from './components/StickerPanel';
import LookPanel from './components/LookPanel';
import DubPanel from './components/DubPanel';
import Preview from './components/Preview';
import Inspector from './components/Inspector';
import Timeline from './components/Timeline';
import ExportDialog, { type ExportOptions } from './components/ExportDialog';
import ProjectsModal from './components/ProjectsModal';
import ScriptStudioModal from './components/ScriptStudioModal';
import AudioScriptModal from './components/AudioScriptModal';
import HomeScreen from './components/HomeScreen';
import { saveProject, openProject, restoreProject, startProjectAutosave, flushDraft, deleteProject } from './project';
import { importPaths } from './importMedia';
import { buildOverlays } from './overlayRaster';
import { effectById, filterById, transitionById } from './looks';
import { useEditor, getVideoTrackLevel } from './store';
import { clipDuration, clipEnd, type ExportAudioSpec, type ExportClipSpec } from './types';

export default function App() {
  const [viewMode, setViewMode] = useState<'home' | 'editor'>('home');
  const [tab, setTab] = useState<RailTab>('media');
  const [dubOpened,setDubOpened] = useState(false);
  useEffect(()=>{if(tab==='dub')setDubOpened(true);},[tab]);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<'all' | 'selected'>('all');
  const [exportFormat, setExportFormat] = useState<'mp4' | 'mp3'>('mp4');
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [scriptStudioOpen, setScriptStudioOpen] = useState(false);
  const [audioScriptOpen, setAudioScriptOpen] = useState(false);

  useEffect(() => {
    const handleOpenStudio = () => setScriptStudioOpen(true);
    const handleOpenAudioScript = () => setAudioScriptOpen(true);
    window.addEventListener('open-script-studio', handleOpenStudio);
    window.addEventListener('open-audio-script', handleOpenAudioScript);
    return () => {
      window.removeEventListener('open-script-studio', handleOpenStudio);
      window.removeEventListener('open-audio-script', handleOpenAudioScript);
    };
  }, []);
  const [timelineHeight, setTimelineHeight] = useState(32);
  const initialized = useRef(false);
  const closeReady = useRef(false);
  const perform = (job: Promise<unknown>) => { void job.catch(e => setNotice(e.message || String(e))); };
  const onSave = (saveAs = false) => perform(saveProject(saveAs).then(ok => { if(ok) setNotice('Project saved.'); }));
  const onOpen = () => { if (!useEditor.getState().dirty || window.confirm('Open another project? Unsaved changes in this project will be replaced.')) perform(openProject()); };
  const onNew = () => { if (!useEditor.getState().dirty || window.confirm('Create a new project? Unsaved changes in this project will be replaced.')) {useEditor.getState().newProject(); perform(flushDraft());} };
  const onClose = () => {
    const s = useEditor.getState();
    const job = (s.currentProjectId && s.clips.length === 0 && s.media.length === 0)
      ? deleteProject(s.currentProjectId)
      : flushDraft();
    perform(job.then(() => { closeReady.current = true; return window.api.close(); }));
  };
  const onGoHome = () => {
    const s = useEditor.getState();
    const job = async () => {
      // Discard empty draft if user created project and did nothing
      if (s.currentProjectId && s.clips.length === 0 && s.media.length === 0) {
        try { await deleteProject(s.currentProjectId); } catch {}
        useEditor.setState({ currentProjectId: null });
      } else {
        await flushDraft();
      }
      setViewMode('home');
    };
    perform(job());
  };

  const exportPct = useEditor((s) => s.exportPct);
  const exportError = useEditor((s) => s.exportError);
  const setExportPct = useEditor((s) => s.setExportPct);
  const setExportError = useEditor((s) => s.setExportError);
  const playerExpanded = useEditor((s) => s.playerExpanded);

  useEffect(() => {
    return window.api.onExportProgress((p: any) => {
      const num = typeof p === 'number' ? p : (p && typeof p.pct === 'number' ? p.pct : null);
      if (num != null) setExportPct(num);
    });
  }, [setExportPct]);
  useEffect(() => startProjectAutosave(setNotice), []);
  useEffect(() => {
    const beforeClose = (e: BeforeUnloadEvent) => {
      if (closeReady.current) return;
      e.preventDefault(); e.returnValue = '';
      const s = useEditor.getState();
      const job = (s.currentProjectId && s.clips.length === 0 && s.media.length === 0)
        ? deleteProject(s.currentProjectId)
        : flushDraft();
      void job.then(() => { closeReady.current = true; void window.api.close(); }).catch(e => setNotice(e.message));
    };
    window.addEventListener('beforeunload', beforeClose);
    return () => window.removeEventListener('beforeunload', beforeClose);
  }, []);

  // Files handed to the app on the command line land on the timeline directly.
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    (async () => {
      const paths = await window.api.initialMedia();
      if (!paths.length) { await restoreProject(); return; }
      await restoreProject();
      const items = await importPaths(paths);
      for (const it of items) useEditor.getState().addMediaToTimeline(it.id);
      setViewMode('editor');
    })().catch(e => setNotice(e.message));
  }, []);

  /* ------------------------------ export ------------------------------ */
  const runExport = useCallback(async (options: ExportOptions) => {
    try {
      const s = useEditor.getState();
      const isSelectedOnly = options.scope === 'selected';

      const targetClipIds = isSelectedOnly
        ? (s.selectedClipIds?.length ? s.selectedClipIds : (s.selectedClipId ? [s.selectedClipId] : []))
        : null;

      const activeClips = isSelectedOnly
        ? s.clips.filter((c) => targetClipIds!.includes(c.id))
        : s.clips;

      if (!activeClips.length) {
        setExportError(isSelectedOnly ? 'Экспортлох клип сонгогдоогүй байна. Timeline дээр клипүүдээ сонгоно уу.' : 'Nothing on the timeline to export.');
        return;
      }

      // Normalized start time: if exporting selected clips, shift earliest clip to t=0
      const minStart = isSelectedOnly ? Math.min(...activeClips.map((c) => c.start)) : 0;
      const maxEnd = isSelectedOnly
        ? Math.max(...activeClips.map((c) => clipEnd(c)))
        : s.duration();
      const exportDuration = Math.max(0.1, maxEnd - minStart);

      const videoTrackIds = s.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id);
      const audioTrackIds = s.tracks.filter((t) => t.kind === 'audio' && !t.muted).map((t) => t.id);
      const overlayTrackIds = s.tracks.filter((t) => t.kind === 'overlay' && !t.hidden).map((t) => t.id);

      const videoClips = activeClips
        .filter((c) => c.kind === 'av' && videoTrackIds.includes(c.trackId))
        .sort((a, b) => a.start - b.start);

      const { width, height, fps } = options;

      const clips: ExportClipSpec[] = [];
      for (const c of videoClips) {
        const m = s.media.find((mm) => mm.id === c.mediaId);
        if (!m) continue;
        const d = clipDuration(c);
        clips.push({
          src: m.path,
          trackId: c.trackId,
          layer: getVideoTrackLevel(c.trackId, s.tracks),
          kind: m.kind === 'image' ? 'image' : 'video',
          opacity: c.opacity ?? 1,
          start: Math.max(0, c.start - minStart),
          inPoint: c.inPoint,
          outPoint: c.outPoint,
          hasAudio: m.hasAudio,
          volume: s.tracks.find((t) => t.id === c.trackId)?.muted ? 0 : c.volume ?? 1,
          filterFf: filterById(c.filterId).ff,
          effectFf: effectById(c.effectId).ff(d, width, height, fps),
          transition: transitionById(c.transitionId).xfade,
          transitionDuration: c.transitionDuration ?? 0.6,
          scale: c.scale,
          fitMode: c.fitMode,
          x: c.x,
          y: c.y,
          rotation: c.rotation,
          keyframes: c.keyframes
        });
      }

      const audio: ExportAudioSpec[] = activeClips
        .filter((c) => c.kind === 'av' && audioTrackIds.includes(c.trackId))
        .map((c) => {
          const m = s.media.find((mm) => mm.id === c.mediaId);
          return m
            ? {
                src: m.path,
                inPoint: c.inPoint,
                outPoint: c.outPoint,
                start: Math.max(0, c.start - minStart),
                volume: c.volume ?? 1
              }
            : null;
        })
        .filter(Boolean) as ExportAudioSpec[];

      const shiftedOverlayClips = activeClips
        .filter((c) => overlayTrackIds.includes(c.trackId))
        .map((c) => ({
          ...c,
          start: Math.max(0, c.start - minStart)
        }));

      const isMp3 = options.format === 'mp3' || options.format === 'wav' || options.format === 'aac' || options.exportVideo === false;
      setExportError(null);
      setExportPct(0);
      const overlays = isMp3 ? [] : await buildOverlays(shiftedOverlayClips, width, height, {
        signal: options.signal, onProgress: options.onPreparationProgress
      });
      options.signal?.throwIfAborted();
      const defaultExt = options.format === 'mov' ? '.mov' : (options.format === 'mp3' ? '.mp3' : (options.format === 'wav' ? '.wav' : (options.format === 'aac' ? '.aac' : '.mp4')));
      const outPath = options.outPath || await window.api.saveExportDialog(
        options.name.replace(/[<>:"/\\|?*]/g, '_') + defaultExt
      );
      if (!outPath) { setExportPct(null); return { ok: false, error: 'Canceled' }; }

      setExportError(null);
      setExportPct(0);
      options.signal?.throwIfAborted();

      const res = await window.api.runExport({
        clips,
        audio,
        overlays,
        width,
        height,
        fps,
        outPath,
        duration: exportDuration,
        quality: options.quality,
        format: options.format,
        audioBitrate: options.audioBitrate,
        codec: options.codec,
        bitrateMode: options.bitrateMode,
        customBitrate: options.customBitrate,
        exportVideo: options.exportVideo
      });

      setExportPct(null);
      if (options.signal?.aborted) return { ok: false, error: 'Canceled' };
      if (res.ok) {
        setDoneMsg(`Exported to ${res.path}`);
        setTimeout(() => setDoneMsg(null), 6000);
      } else {
        setExportError(res.error ?? 'Export failed');
      }
      return res;
    } catch (e) {
      setExportPct(null);
      if (options.signal?.aborted) return { ok: false, error: 'Canceled' };
      const errMsg = e instanceof Error ? e.message : String(e);
      setExportError(errMsg);
      return { ok: false, error: errMsg };
    }
  }, [setExportPct, setExportError]);

  const openExportDialog = useCallback((scope: 'all' | 'selected' = 'all', format: 'mp4' | 'mp3' = 'mp4') => {
    setExportScope(scope);
    setExportFormat(format);
    setExportOpen(true);
  }, []);

  const quickExportSelected = useCallback(async (format: 'mp4' | 'mp3' = 'mp4') => {
    const s = useEditor.getState();
    const targetIds = s.selectedClipIds?.length ? s.selectedClipIds : (s.selectedClipId ? [s.selectedClipId] : []);
    if (!targetIds.length) {
      setNotice('Экспортлох клип сонгогдоогүй байна. Клипээ сонгоод дахин оролдоно уу.');
      setTimeout(() => setNotice(null), 4000);
      return;
    }
    const baseName = `${s.projectName || 'Video'}_selection`;
    await runExport({
      name: baseName,
      width: s.projectSettings.width,
      height: s.projectSettings.height,
      fps: s.projectSettings.fps,
      quality: 'standard',
      scope: 'selected',
      format,
      audioBitrate: '192k'
    });
  }, [runExport]);

  /* ---------------------------- shortcuts ----------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const isKey = (k: string, code: string) => e.key.toLowerCase() === k.toLowerCase() || e.code === code;

      if ((e.ctrlKey || e.metaKey) && isKey('s', 'KeyS')) {e.preventDefault(); onSave(e.shiftKey); return;}
      if ((e.ctrlKey || e.metaKey) && isKey('o', 'KeyO')) {e.preventDefault(); onOpen(); return;}
      if ((e.ctrlKey || e.metaKey) && isKey('n', 'KeyN')) {e.preventDefault(); onNew(); return;}
      if ((e.ctrlKey || e.metaKey) && isKey('p', 'KeyP')) {e.preventDefault(); setProjectsOpen(true); return;}
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const s = useEditor.getState();
      if (document.querySelector('[role="dialog"]')) return;
      if (e.ctrlKey || e.metaKey) {
        if (isKey('a', 'KeyA')) {
          e.preventDefault();
          const lockedTrackIds = new Set(s.tracks.filter(t => t.locked).map(t => t.id));
          const unlockedClipIds = s.clips.filter(c => !lockedTrackIds.has(c.trackId)).map(c => c.id);
          s.selectClips(unlockedClipIds);
          return;
        }
        if (isKey('z', 'KeyZ')) {e.preventDefault(); e.shiftKey ? s.redo() : s.undo(); return;}
        if (isKey('y', 'KeyY')) {e.preventDefault(); s.redo(); return;}
        if (isKey('d', 'KeyD') && s.selectedClipId) {e.preventDefault(); s.duplicateClip(s.selectedClipId); return;}
        if (isKey('b', 'KeyB')) {
          e.preventDefault();
          // Ctrl+Shift+B: Split all tracks; Ctrl+B: Split target/selected clip
          s.splitAtPlayhead(e.shiftKey);
          return;
        }
        if (isKey('e', 'KeyE') && s.clips.length) {e.preventDefault(); openExportDialog('all'); return;}
        if (e.key === '=' || e.key === '+' || e.code === 'Equal') {e.preventDefault(); s.setZoom(Math.min(500, s.zoom * 1.35)); return;}
        if (e.key === '-' || e.key === '_' || e.code === 'Minus') {e.preventDefault(); s.setZoom(Math.max(0.0001, s.zoom / 1.35)); return;}
        return;
      }

      // CapCut shortcut: Shift + Z = Fit to Timeline
      if (e.shiftKey && isKey('z', 'KeyZ')) {
        e.preventDefault();
        const dur = s.duration();
        if (dur > 0) {
          const el = document.querySelector('.tl-scroll');
          const clientW = el?.clientWidth || 1200;
          const targetW = Math.max(350, clientW * 0.78);
          s.setZoom(Math.max(0.0002, Math.min(200, targetW / dur)));
        }
        return;
      }

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        s.setPlaying(!s.isPlaying);
        return;
      }

      // CapCut & standard video editor shortcuts: B or S = Split at playhead
      if (isKey('s', 'KeyS') || isKey('b', 'KeyB')) {
        e.preventDefault();
        s.splitAtPlayhead();
        return;
      }

      if (isKey('f', 'KeyF')) {
        e.preventDefault();
        s.freezeAtPlayhead();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace' || e.code === 'Delete' || e.code === 'Backspace') {
        e.preventDefault();
        s.deleteSelected();
        return;
      }

      if (e.key === 'ArrowLeft' || e.code === 'ArrowLeft') {
        s.setPlaying(false);
        s.setPlayhead(s.playhead - (e.shiftKey ? 1 : 1 / s.projectSettings.fps));
        return;
      }
      if (e.key === 'ArrowRight' || e.code === 'ArrowRight') {
        s.setPlaying(false);
        s.setPlayhead(s.playhead + (e.shiftKey ? 1 : 1 / s.projectSettings.fps));
        return;
      }
      if (e.key === 'Home' || e.code === 'Home') {
        s.setPlayhead(0);
        return;
      }
      if (e.key === '=' || e.key === '+' || e.code === 'Equal') {
        s.setZoom(Math.min(500, s.zoom * 1.4));
        return;
      }
      if (e.key === '-' || e.key === '_' || e.code === 'Minus') {
        s.setZoom(Math.max(0.0001, s.zoom / 1.4));
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openExportDialog]);

  const panel =
    tab === 'media' ? <MediaPanel />
    : tab === 'audio' ? <MediaPanel audioOnly />
    : tab === 'text' ? <TextPanel />
    : tab === 'stickers' ? <StickerPanel />
    : tab === 'effects' ? <LookPanel mode="effects" />
    : tab === 'transitions' ? <LookPanel mode="transitions" />
    : tab === 'dub' ? null
    : <LookPanel mode="filters" />;

  if (viewMode === 'home') {
    return (
      <>
        <HomeScreen onEnterEditor={() => setViewMode('editor')} />
        {notice && (
          <div className="toast" role="status" onClick={() => setNotice(null)}>
            {notice}
            <button className="notice-close" aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="app" style={{gridTemplateRows:`44px minmax(140px, 1fr) 7px minmax(140px, ${timelineHeight}%)`}}>
      <TitleBar
        onExport={() => openExportDialog('all')}
        onSave={onSave}
        onOpen={onOpen}
        onNew={onNew}
        onClose={onClose}
        onOpenProjects={() => setProjectsOpen(true)}
        onGoHome={onGoHome}
      />

      <div className={'midrow' + (playerExpanded ? ' player-expanded' : '')}>
        <div className="library"><Rail active={tab} onChange={setTab} /><div className="library-content">{panel}{(dubOpened||tab==='dub')&&<div className="dub-persistent" style={{display:tab==='dub'?'flex':'none'}}><DubPanel /></div>}</div></div>
        <Preview />
        <Inspector />
      </div>

      <div className="timeline-resizer" role="separator" aria-label="Resize timeline" aria-orientation="horizontal" tabIndex={0}
        onKeyDown={e=>{
          if (e.key === 'ArrowUp') setTimelineHeight(h => Math.min(78, h + 3));
          if (e.key === 'ArrowDown') setTimelineHeight(h => Math.max(16, h - 3));
        }}
        onPointerDown={e => {
          e.preventDefault();
          const winH = window.innerHeight || 800;
          const maxTimelinePx = Math.max(140, winH - 44 - 7 - 140);
          const maxPct = Math.min(78, (maxTimelinePx / winH) * 100);
          const minPct = Math.max(16, (140 / winH) * 100);

          const move = (event: PointerEvent) => {
            const rawPct = ((winH - event.clientY) / winH) * 100;
            setTimelineHeight(Math.max(minPct, Math.min(maxPct, rawPct)));
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      />
      <Timeline
        onRequestExport={(scope, format) => openExportDialog(scope, format)}
        onQuickExportSelected={quickExportSelected}
      />
      {projectsOpen && <ProjectsModal onClose={() => setProjectsOpen(false)} />}
      {exportOpen && (
        <ExportDialog
          initialScope={exportScope}
          initialFormat={exportFormat}
          onClose={() => setExportOpen(false)}
          onExport={runExport}
        />
      )}
      {scriptStudioOpen && (
        <ScriptStudioModal
          isOpen={scriptStudioOpen}
          onClose={() => setScriptStudioOpen(false)}
          onSuccessNotice={(msg) => {
            setNotice(msg);
            setTimeout(() => setNotice(null), 6000);
          }}
        />
      )}
      {audioScriptOpen && (
        <AudioScriptModal
          isOpen={audioScriptOpen}
          onClose={() => setAudioScriptOpen(false)}
          onSuccessNotice={(msg) => {
            setNotice(msg);
            setTimeout(() => setNotice(null), 6000);
          }}
        />
      )}
      {notice && <div className="toast" role="status" onClick={()=>setNotice(null)}>{notice}<button className="notice-close" aria-label="Dismiss message" onClick={()=>setNotice(null)}>×</button></div>}

      {!exportOpen && exportPct !== null && (
        <div className="toast">
          Exporting… {typeof exportPct === 'number' ? exportPct : (exportPct as any)?.pct ?? 0}%
          <div className="bar"><i style={{ width: `${typeof exportPct === 'number' ? exportPct : (exportPct as any)?.pct ?? 0}%` }} /></div>
        </div>
      )}
      {exportError && (
        <div className="toast error" onClick={() => setExportError(null)}>
          <b>Export failed</b>
          <div style={{ marginTop: 6, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>
            {exportError}
          </div>
        </div>
      )}
      {doneMsg && (
        <div className="toast" onClick={() => setDoneMsg(null)}>
          {doneMsg}
        </div>
      )}
    </div>
  );
}
