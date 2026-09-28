import { create } from 'zustand';
import type { Clip, MediaItem, TextStyle, Track } from './types';
import { clipDuration, clipEnd } from './types';
import type { TextPreset } from './looks';
import type { ProjectDocument, ProjectSettings } from './project-types';
import { addOrUpdateKeyframe, removeKeyframe } from './keyframes';

const uid = () => Math.random().toString(36).slice(2, 10);

/** Snap threshold in pixels, converted to seconds using the current zoom. */
const SNAP_PX = 8;

const DEFAULT_OVERLAY_SECONDS = 4;

interface EditorState {
  projectName: string;
  projectPath: string | null;
  currentProjectId: string | null;
  projectSettings: ProjectSettings;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undo(): void;
  redo(): void;
  beginGesture(): void;
  endGesture(): void;
  duplicateClip(id: string): void;
  snapshotProject(): ProjectDocument;
  applyRecapCut(newMedia: MediaItem[], videoClips: Clip[]): void;
  loadProject(data: ProjectDocument, path?: string | null, projectId?: string | null): void;
  setCurrentProjectId(id: string | null): void;
  newProject(): void;
  markSaved(path: string, data: ProjectDocument): void;
  renameProject(name: string): void;
  setProjectSettings(patch: Partial<ProjectSettings>): void;
  media: MediaItem[];
  tracks: Track[];
  clips: Clip[];

  playhead: number;
  zoom: number; // pixels per second
  isPlaying: boolean;
  selectedClipId: string | null;
  selectedClipIds: string[];
  snapping: boolean;
  autoRipple: boolean;

  exportPct: number | null;
  exportError: string | null;

  addMedia(item: MediaItem): void;
  addMediaBatch(items: MediaItem[]): void;
  updateMediaThumbs(id: string, thumbs: string[]): void;
  addMediaToTimeline(mediaId: string, trackId?: string, at?: number): void;
  addTextClip(preset: TextPreset): void;
  addStickerClip(emoji: string): void;

  moveClip(id: string, start: number, trackId?: string): void;
  commitMoveClip(id: string, targetTrackId?: string, origTrackId?: string): void;
  ensureLayerTrack(kind: 'video' | 'audio', forceNew?: boolean): Track;
  trackHeightMode: 'compact' | 'normal' | 'large';
  setTrackHeightMode(mode: 'compact' | 'normal' | 'large'): void;
  setTrackHeight(trackId: string, height: number): void;
  deleteTrack(trackId: string): void;
  moveClipToLayer(clipId: string, targetLevel: number): void;
  moveClips(ids: string[], deltaSeconds: number): void;
  trimClip(id: string, edge: 'in' | 'out', deltaSeconds: number): void;
  splitAtPlayhead(splitAll?: boolean): void;
  freezeAtPlayhead(): Promise<boolean>;
  splitClipAtTimestamps(clipId: string, timestamps: number[]): void;
  deleteClip(id: string): void;
  deleteSelected(): void;
  closeGaps(trackId?: string): void;
  updateClip(id: string, patch: Partial<Clip>): void;
  updateClipStyle(id: string, patch: Partial<TextStyle>): void;
  addKeyframe(clipId: string, time: number, values?: Partial<Clip>): void;
  removeKeyframe(clipId: string, keyframeId: string): void;

  select(id: string | null): void;
  selectClips(ids: string[]): void;
  toggleSelectClip(id: string): void;
  setPlayhead(t: number): void;
  setZoom(z: number): void;
  setPlaying(p: boolean): void;
  toggleSnapping(): void;
  toggleAutoRipple(): void;
  playerExpanded: boolean;
  togglePlayerExpanded(): void;

  addTrack(kind: 'video' | 'audio' | 'overlay'): void;
  createTrack(kind: 'video' | 'audio' | 'overlay', name: string): Track;
  addClip(clip: Omit<Clip, 'id'>): string;
  toggleTrackFlag(id: string, flag: 'muted' | 'hidden' | 'locked'): void;

  setExportPct(p: number | null): void;
  setExportError(e: string | null): void;

  duration(): number;
  mediaOf(clip: Clip): MediaItem | undefined;
  snapTime(t: number, ignoreClipId?: string): number;
  ensureTrack(kind: 'video' | 'audio' | 'overlay'): Track;
}

export function sortTracksCapCut(tracks: Track[]): Track[] {
  const overlays = tracks.filter(t => t.kind === 'overlay');
  const videos = tracks.filter(t => t.kind === 'video');
  const audios = tracks.filter(t => t.kind === 'audio');

  // Video tracks: highest level on top (Video 3, Video 2, Video 1)
  videos.sort((a, b) => {
    const numA = parseInt(a.name.match(/\d+/)?.[0] || '1', 10);
    const numB = parseInt(b.name.match(/\d+/)?.[0] || '1', 10);
    return numB - numA; // Descending: Video 2 sits ABOVE Video 1
  });

  // Audio tracks: lowest number on top (Audio 1, Audio 2)
  audios.sort((a, b) => {
    const numA = parseInt(a.name.match(/\d+/)?.[0] || '1', 10);
    const numB = parseInt(b.name.match(/\d+/)?.[0] || '1', 10);
    return numA - numB; // Ascending: Audio 1 sits ABOVE Audio 2
  });

  return [...overlays, ...videos, ...audios];
}

export const TRACK_HEIGHT_PRESETS: Record<'compact' | 'normal' | 'large', Record<'video' | 'audio' | 'overlay', number>> = {
  compact: { video: 36, audio: 32, overlay: 30 },
  normal: { video: 58, audio: 46, overlay: 40 },
  large: { video: 88, audio: 70, overlay: 50 }
};

export function getTrackHeight(track: Track, mode: 'compact' | 'normal' | 'large' = 'normal'): number {
  if (track.height && track.height > 20) return track.height;
  const presets = TRACK_HEIGHT_PRESETS[mode] || TRACK_HEIGHT_PRESETS.normal;
  return presets[track.kind] || 50;
}

export function getVideoTrackLevel(trackId: string, tracks: Track[]): number {
  const track = tracks.find(t => t.id === trackId);
  if (!track || track.kind !== 'video') return 0;
  const match = track.name.match(/Video\s*(\d+)/i);
  if (match) return parseInt(match[1], 10);
  const videoTracks = tracks.filter(t => t.kind === 'video');
  const idx = videoTracks.findIndex(t => t.id === trackId);
  if (idx === -1) return 1;
  return videoTracks.length - idx;
}

export function isMainVideoTrack(trackId: string, tracks: Track[]): boolean {
  const videoTracks = tracks.filter(t => t.kind === 'video');
  if (videoTracks.length === 0) return false;
  const v1 = videoTracks.find(t => t.name.trim().toLowerCase() === 'video 1');
  if (v1) return v1.id === trackId;
  return videoTracks[videoTracks.length - 1].id === trackId;
}

const defaultTracks: Track[] = sortTracksCapCut([
  { id: 'ov1', kind: 'overlay', name: 'Overlay', muted: false, hidden: false, locked: false },
  { id: 'v1', kind: 'video', name: 'Video 1', muted: false, hidden: false, locked: false },
  { id: 'a1', kind: 'audio', name: 'Audio 1', muted: false, hidden: false, locked: false }
]);

type Snapshot = Pick<EditorState, 'media' | 'tracks' | 'clips' | 'projectName' | 'projectSettings' | 'selectedClipId'>;
const snapshot = (s: EditorState): Snapshot => ({ media: s.media, tracks: s.tracks, clips: s.clips, projectName: s.projectName, projectSettings: s.projectSettings, selectedClipId: s.selectedClipId });
const sameItems = (a: unknown[], b: unknown[]) => a === b || (a.length === b.length && a.every((item,i)=>item===b[i]));
const changed = (a: Snapshot, b: Snapshot) => !sameItems(a.media,b.media) || !sameItems(a.tracks,b.tracks) || !sameItems(a.clips,b.clips) || a.projectName !== b.projectName || a.projectSettings !== b.projectSettings;

function applyRippleDelete(
  allClips: Clip[],
  idsToDelete: string[],
  lockedTrackIds: Set<string>,
  autoRipple: boolean,
  tracks: Track[] = []
): Clip[] {
  const clipsToDelete = allClips.filter((c) => idsToDelete.includes(c.id) && !lockedTrackIds.has(c.trackId));
  const remainingClips = allClips.filter((c) => !idsToDelete.includes(c.id) || lockedTrackIds.has(c.trackId));

  if (!autoRipple || clipsToDelete.length === 0) {
    return remainingClips;
  }

  const deletedByTrack = new Map<string, Clip[]>();
  for (const c of clipsToDelete) {
    const list = deletedByTrack.get(c.trackId) || [];
    list.push(c);
    deletedByTrack.set(c.trackId, list);
  }

  return remainingClips.map((clip) => {
    if (lockedTrackIds.has(clip.trackId)) return clip;
    // In CapCut, ripple shift only applies to the Main Video Track and Audio tracks!
    if (tracks.length > 0) {
      const isMain = isMainVideoTrack(clip.trackId, tracks);
      const trackKind = tracks.find(t => t.id === clip.trackId)?.kind;
      if (!isMain && trackKind !== 'audio') return clip;
    }
    const deletedOnThisTrack = deletedByTrack.get(clip.trackId);
    if (!deletedOnThisTrack || deletedOnThisTrack.length === 0) return clip;

    let totalShift = 0;
    for (const d of deletedOnThisTrack) {
      if (d.start <= clip.start) {
        totalShift += clipDuration(d);
      }
    }

    if (totalShift <= 0) return clip;
    return {
      ...clip,
      start: Math.max(0, clip.start - totalShift)
    };
  });
}

export const useEditor = create<EditorState>((rawSet, get) => {
  let past: Snapshot[] = [];
  let future: Snapshot[] = [];
  let gesture: Snapshot | null = null;
  const set = (patch: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)) => {
    const prev = get();
    const update = typeof patch === 'function' ? patch(prev) : patch;
    const next = { ...prev, ...update };
    if (changed(snapshot(prev), snapshot(next))) {
      if (!gesture) past = [...past.slice(-99), snapshot(prev)];
      future = [];
      rawSet({ ...update, dirty: true, canUndo: true, canRedo: false });
    } else rawSet(update);
  };
  return ({
  projectName: 'Untitled project', projectPath: null,
  projectSettings: { width: 1920, height: 1080, fps: 30 },
  dirty: false, canUndo: false, canRedo: false,
  beginGesture: () => { if (!gesture) gesture = snapshot(get()); },
  endGesture: () => {
    if (gesture && changed(gesture, snapshot(get()))) past = [...past.slice(-99), gesture];
    gesture = null;
    rawSet({ canUndo: past.length > 0 });
  },
  undo: () => {
    get().endGesture();
    const prev = past.pop(); if (!prev) return;
    future.push(snapshot(get()));
    rawSet({ ...prev, isPlaying: false, dirty: true, canUndo: past.length > 0, canRedo: true });
  },
  redo: () => {
    const next = future.pop(); if (!next) return;
    past.push(snapshot(get()));
    rawSet({ ...next, isPlaying: false, dirty: true, canUndo: true, canRedo: future.length > 0 });
  },
  renameProject: (name) => set({ projectName: name.trim() || 'Untitled project' }),
  setProjectSettings: (patch) => set(s => ({ projectSettings: { ...s.projectSettings, ...patch } })),
  snapshotProject: () => {
    const s = get();
    return { format: 'cutline-project', version: 1, name: s.projectName, media: s.media, tracks: s.tracks, clips: s.clips, settings: s.projectSettings };
  },
  applyRecapCut: (newMedia, videoClips) => {
    const s = get();
    if (s.tracks.find(t => t.id === 'v1')?.locked) throw new Error('V1 дүрсний зам түгжээтэй байна.');
    const mediaById = new Map(s.media.map(m => [m.id, m]));
    for (const m of newMedia) mediaById.set(m.id, m);
    set({
      media: [...mediaById.values()],
      clips: [...s.clips.filter(c => c.trackId !== 'v1'), ...videoClips],
      selectedClipId: null,
      selectedClipIds: [],
      isPlaying: false
    });
  },
  currentProjectId: null,
  setCurrentProjectId: (id: string | null) => rawSet({ currentProjectId: id }),
  loadProject: (data, path = null, projectId = null) => {
    past = []; future = []; gesture = null;
    const sortedTracks = sortTracksCapCut(data.tracks && data.tracks.length ? data.tracks : defaultTracks);
    rawSet({ media: data.media, tracks: sortedTracks, clips: data.clips, projectName: data.name, projectPath: path,
      currentProjectId: projectId !== undefined && projectId !== null ? projectId : get().currentProjectId,
      projectSettings: data.settings, playhead: 0, selectedClipId: null, selectedClipIds: [], isPlaying: false, dirty: false, canUndo: false, canRedo: false });
  },
  newProject: () => get().loadProject({format: 'cutline-project', version: 1, name: 'Untitled project', media: [], tracks: defaultTracks.map(t => ({...t})), clips: [], settings: {width:1920,height:1080,fps:30}}, null, null),
  markSaved: (path, data) => rawSet({ projectPath: path, dirty: JSON.stringify(get().snapshotProject()) !== JSON.stringify(data) }),
  duplicateClip: (id) => {
    const s = get(), clip = s.clips.find(c => c.id === id);
    if (!clip || s.tracks.find(t => t.id === clip.trackId)?.locked) return;
    const copy = { ...clip, id: uid(), start: clipEnd(clip), style: clip.style ? { ...clip.style } : undefined };
    set({ clips: [...s.clips, copy], selectedClipId: copy.id, selectedClipIds: [copy.id] });
  },
  media: [],
  tracks: defaultTracks,
  clips: [],

  playhead: 0,
  zoom: 60,
  isPlaying: false,
  selectedClipId: null,
  selectedClipIds: [],
  snapping: true,
  autoRipple: true,
  trackHeightMode: 'normal',
  setTrackHeightMode: (mode) => set({ trackHeightMode: mode }),
  setTrackHeight: (trackId, height) =>
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, height: Math.max(26, Math.min(200, height)) } : t))
    })),
  deleteTrack: (trackId) => {
    const s = get();
    const target = s.tracks.find((t) => t.id === trackId);
    if (!target) return;
    if (isMainVideoTrack(trackId, s.tracks)) return;
    const sameKind = s.tracks.filter((t) => t.kind === target.kind);
    if (sameKind.length <= 1) return;
    if (s.clips.some((c) => c.trackId === trackId)) return;
    set({ tracks: s.tracks.filter((t) => t.id !== trackId) });
  },
  moveClipToLayer: (clipId, targetLevel) => {
    const s = get();
    const clip = s.clips.find((c) => c.id === clipId);
    if (!clip || clip.kind !== 'av') return;
    const curTrack = s.tracks.find((t) => t.id === clip.trackId);
    if (!curTrack || curTrack.kind !== 'video') return;

    let targetTrack = s.tracks.find((t) => t.kind === 'video' && getVideoTrackLevel(t.id, s.tracks) === targetLevel);
    if (!targetTrack) {
      targetTrack = get().ensureLayerTrack('video', true);
    }
    if (targetTrack && !targetTrack.locked) {
      set({
        clips: s.clips.map((c) => (c.id === clipId ? { ...c, trackId: targetTrack!.id } : c))
      });
    }
  },
  playerExpanded: false,
  togglePlayerExpanded: () => set((s) => ({ playerExpanded: !s.playerExpanded })),

  exportPct: null,
  exportError: null,

  addMedia: (item) => set((s) => ({ media: [...s.media, item] })),
  addMediaBatch: (items) => set((s) => ({ media: [...s.media, ...items] })),
  updateMediaThumbs: (id, thumbs) =>
    set((s) => ({
      media: s.media.map((m) => (m.id === id ? { ...m, thumbs } : m))
    })),

  ensureTrack: (kind) => {
    const s = get();
    if (kind === 'video') {
      const main = s.tracks.find((t) => isMainVideoTrack(t.id, s.tracks) && !t.locked);
      if (main) return main;
      const anyV = s.tracks.find((t) => t.kind === 'video' && !t.locked);
      if (anyV) return anyV;
    } else if (kind === 'audio') {
      const a1 = s.tracks.find((t) => t.kind === 'audio' && !t.locked);
      if (a1) return a1;
    } else {
      const ov = s.tracks.find((t) => t.kind === 'overlay' && !t.locked);
      if (ov) return ov;
    }
    const track: Track = {
      id: uid(),
      kind,
      name: kind === 'video' ? 'Video 1' : kind === 'audio' ? 'Audio 1' : 'Overlay',
      muted: false,
      hidden: false,
      locked: false
    };
    set((s) => ({ tracks: sortTracksCapCut([...s.tracks, track]) }));
    return track;
  },

  addMediaToTimeline: (mediaId, trackId, at) => {
    const s = get();
    const m = s.media.find((x) => x.id === mediaId);
    if (!m) return;

    const kind: 'video' | 'audio' = m.kind === 'audio' ? 'audio' : 'video';
    if (trackId && !s.tracks.some(t => t.id === trackId && t.kind === kind && !t.locked)) return;
    const track =
      s.tracks.find((t) => t.id === trackId && t.kind === kind) ?? s.ensureTrack(kind);

    // Append after the last clip already on that track.
    const onTrack = get().clips.filter((c) => c.trackId === track.id);
    if (track.locked) return;
    const start = at !== undefined ? Math.max(0, at) : onTrack.length ? Math.max(...onTrack.map(clipEnd)) : 0;

    // If adding first visual media to an empty project, auto-match project dimensions and set comfortable timeline zoom
    const patchSettings = (s.clips.length === 0 && m.width > 0 && m.height > 0) ? {
      projectSettings: {
        width: m.width % 2 === 0 ? m.width : m.width - 1,
        height: m.height % 2 === 0 ? m.height : m.height - 1,
        fps: m.fps ? Math.round(m.fps) : s.projectSettings.fps
      }
    } : {};

    const patchZoom = (s.clips.length === 0 && m.duration > 15) ? {
      zoom: Math.max(0.005, Math.min(60, 850 / m.duration))
    } : {};

    const clip: Clip = {
      id: uid(),
      kind: 'av',
      mediaId,
      trackId: track.id,
      start,
      inPoint: 0,
      outPoint: m.duration || 5,
      filterId: 'none',
      effectId: 'none',
      transitionId: 'none',
      transitionDuration: 0.6,
      scale: 1,
      fitMode: 'contain',
      volume: 1,
      opacity: 1
    };
    set((st) => ({ ...patchSettings, ...patchZoom, clips: [...st.clips, clip], selectedClipId: clip.id, selectedClipIds: [clip.id] }));
  },

  addTextClip: (preset) => {
    const track = get().ensureTrack('overlay');
    const start = get().playhead;
    const clip: Clip = {
      id: uid(),
      kind: 'text',
      trackId: track.id,
      start,
      inPoint: 0,
      outPoint: DEFAULT_OVERLAY_SECONDS,
      style: {
        text: preset.text,
        fontSize: preset.fontSize,
        color: preset.color,
        bold: preset.bold,
        shadow: preset.shadow,
        background: preset.background,
        fontFamily: preset.fontFamily || ''
      },
      x: 0.5,
      y: 0.5,
      opacity: 1,
      effectId: 'none',
      filterId: 'none',
      transitionId: 'none',
      transitionDuration: 0.6
    };
    set((s) => ({ clips: [...s.clips, clip], selectedClipId: clip.id }));
  },

  addStickerClip: (emoji) => {
    const track = get().ensureTrack('overlay');
    const clip: Clip = {
      id: uid(),
      kind: 'sticker',
      trackId: track.id,
      start: get().playhead,
      inPoint: 0,
      outPoint: DEFAULT_OVERLAY_SECONDS,
      sticker: emoji,
      style: {
        text: emoji,
        fontSize: 140,
        color: '#ffffff',
        bold: false,
        shadow: false,
        background: ''
      },
      x: 0.5,
      y: 0.5,
      opacity: 1,
      effectId: 'none',
      filterId: 'none',
      transitionId: 'none',
      transitionDuration: 0.6
    };
    set((s) => ({ clips: [...s.clips, clip], selectedClipId: clip.id }));
  },

  ensureLayerTrack: (kind: 'video' | 'audio', forceNew = false) => {
    const s = get();
    const tracksOfKind = s.tracks.filter((t) => t.kind === kind);
    if (!forceNew) {
      // If there is an existing empty unlocked non-main layer, reuse it
      const emptyTrack = tracksOfKind.find(
        (t) => !t.locked && !s.clips.some((c) => c.trackId === t.id) && !isMainVideoTrack(t.id, s.tracks)
      );
      if (emptyTrack) return emptyTrack;
    }
    let maxNum = 1;
    for (const t of tracksOfKind) {
      const m = t.name.match(/\d+/);
      if (m) {
        const val = parseInt(m[0], 10);
        if (val > maxNum) maxNum = val;
      }
    }
    const nextNum = maxNum + 1;
    const label = kind === 'video' ? 'Video' : 'Audio';
    const newTrack: Track = {
      id: uid(),
      kind,
      name: `${label} ${nextNum}`,
      muted: false,
      hidden: false,
      locked: false
    };
    const newTracks = sortTracksCapCut([...s.tracks, newTrack]);
    set({ tracks: newTracks });
    return newTrack;
  },

  moveClip: (id, start, trackId) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === id && !s.tracks.find(t => t.id === c.trackId)?.locked && !s.tracks.find(t => t.id === trackId)?.locked ? { ...c, start: Math.max(0, start), trackId: trackId ?? c.trackId } : c
      )
    })),

  commitMoveClip: (id: string, targetTrackId?: string, origTrackId?: string) => {
    const s = get();
    const clip = s.clips.find(c => c.id === id);
    if (!clip) return;

    const trackId = targetTrackId || clip.trackId;
    const track = s.tracks.find(t => t.id === trackId);
    if (!track || track.locked) return;

    const dur = clipDuration(clip);
    const isMain = isMainVideoTrack(trackId, s.tracks);

    // If moved from another track, close gaps on source track if source track was Main Track
    if (origTrackId && origTrackId !== trackId && s.autoRipple && isMainVideoTrack(origTrackId, s.tracks)) {
      setTimeout(() => get().closeGaps(origTrackId), 0);
    }

    // Magnetic Swap / Reorder when autoRipple is active ONLY on the MAIN VIDEO TRACK:
    if (s.autoRipple && isMain) {
      const otherClips = s.clips
        .filter(c => c.trackId === trackId && c.id !== id)
        .sort((a, b) => a.start - b.start);

      if (otherClips.length > 0) {
        const targetMid = clip.start + dur / 2;
        let insertIdx = 0;
        for (const other of otherClips) {
          const otherMid = other.start + clipDuration(other) / 2;
          if (targetMid > otherMid) {
            insertIdx++;
          }
        }

        const reordered = [...otherClips];
        reordered.splice(insertIdx, 0, { ...clip, trackId });

        let cursor = 0;
        const updatedMap = new Map<string, number>();
        for (const c of reordered) {
          updatedMap.set(c.id, cursor);
          cursor += clipDuration(c);
        }

        set({
          clips: s.clips.map(c => {
            if (updatedMap.has(c.id)) {
              return { ...c, start: updatedMap.get(c.id)!, trackId };
            }
            return c;
          })
        });
        return;
      }
    }

    // For secondary video tracks, audio tracks, and overlay tracks:
    // The clip keeps its exact dropped start time (free positioning without collapsing pauses):
    if ((!isMain && track.kind === 'video') || track.kind === 'audio' || track.kind === 'overlay') {
      set({
        clips: s.clips.map(c => c.id === id ? { ...c, trackId, start: Math.max(0, clip.start) } : c)
      });
      return;
    }

    // When autoRipple is OFF on Main Track, check for collision:
    const otherClips = s.clips.filter(c => c.trackId === trackId && c.id !== id);
    const hasCollision = otherClips.some(other => {
      const otherEnd = clipEnd(other);
      const clipEnding = clip.start + dur;
      return Math.max(clip.start, other.start) < Math.min(clipEnding, otherEnd) - 0.05;
    });

    if (hasCollision && track.kind === 'video') {
      // Auto-Layer: Promote overlapping clip to upper layer track (Video 2+)
      const layerTrack = s.ensureLayerTrack('video');
      set({
        clips: s.clips.map(c => c.id === id ? { ...c, trackId: layerTrack.id, start: clip.start } : c)
      });
    }
  },

  moveClips: (ids, delta) =>
    set((s) => {
      const lockedTrackIds = new Set(s.tracks.filter((t) => t.locked).map((t) => t.id));
      const targetClips = s.clips.filter((c) => ids.includes(c.id) && !lockedTrackIds.has(c.trackId));
      if (!targetClips.length) return {};
      const minStart = Math.min(...targetClips.map((c) => c.start));
      const safeDelta = minStart + delta < 0 ? -minStart : delta;
      return {
        clips: s.clips.map((c) =>
          ids.includes(c.id) && !lockedTrackIds.has(c.trackId)
            ? { ...c, start: Math.max(0, c.start + safeDelta) }
            : c
        )
      };
    }),

  trimClip: (id, edge, delta) =>
    set((s) => {
      const targetClip = s.clips.find((c) => c.id === id);
      if (!targetClip || s.tracks.find(t => t.id === targetClip.trackId)?.locked) return {};

      const m = targetClip.mediaId ? s.media.find((x) => x.id === targetClip.mediaId) : undefined;
      // Generated clips and still images have no source limit, so they can be stretched freely.
      const srcMax = (targetClip.kind === 'av' && m?.kind !== 'image') ? (m?.duration ?? targetClip.outPoint) : Number.POSITIVE_INFINITY;
      const MIN = 0.1;

      if (edge === 'in') {
        const nextIn = Math.min(Math.max(Math.max(0, targetClip.inPoint - targetClip.start), targetClip.inPoint + delta), targetClip.outPoint - MIN);
        const inDelta = nextIn - targetClip.inPoint;
        if (Math.abs(inDelta) < 0.000001) return {};

        const shouldRipple = s.autoRipple && isMainVideoTrack(targetClip.trackId, s.tracks);
        if (shouldRipple) {
          // In CapCut Ripple Trim: Trimming head reduces clip duration by inDelta,
          // keeps clip anchored at its start position and slides all subsequent clips left!
          const durationDelta = -inDelta;
          return {
            clips: s.clips.map((c) => {
              if (c.id === id) {
                return { ...c, inPoint: nextIn };
              }
              if (c.trackId === targetClip.trackId && c.start > targetClip.start + 0.001) {
                return { ...c, start: Math.max(0, c.start + durationDelta) };
              }
              return c;
            })
          };
        } else {
          return {
            clips: s.clips.map((c) => (c.id === id ? { ...c, inPoint: nextIn, start: Math.max(0, c.start + inDelta) } : c))
          };
        }
      } else {
        const nextOut = Math.max(Math.min(srcMax, targetClip.outPoint + delta), targetClip.inPoint + MIN);
        const outDelta = nextOut - targetClip.outPoint;
        if (Math.abs(outDelta) < 0.000001) return {};

        const shouldRipple = s.autoRipple && isMainVideoTrack(targetClip.trackId, s.tracks);
        if (shouldRipple) {
          // With Auto Ripple: Trimming tail adjusts duration by outDelta,
          // dynamically pulling or pushing all subsequent clips on this track!
          return {
            clips: s.clips.map((c) => {
              if (c.id === id) {
                return { ...c, outPoint: nextOut };
              }
              if (c.trackId === targetClip.trackId && c.start > targetClip.start + 0.001) {
                return { ...c, start: Math.max(0, c.start + outDelta) };
              }
              return c;
            })
          };
        } else {
          return {
            clips: s.clips.map((c) => (c.id === id ? { ...c, outPoint: nextOut } : c))
          };
        }
      }
    }),

  splitAtPlayhead: (splitAll = false) => {
    const { clips, playhead, selectedClipId, selectedClipIds, tracks } = get();
    const lockedTrackIds = new Set(tracks.filter(t => t.locked).map(t => t.id));

    // Determine target selection
    const targetSelection = (selectedClipIds && selectedClipIds.length > 0)
      ? selectedClipIds
      : (selectedClipId ? [selectedClipId] : []);

    // 1. Check if any selected clip is directly under the playhead (and not on a locked track)
    const selectedHits = clips.filter(c =>
      targetSelection.includes(c.id) &&
      !lockedTrackIds.has(c.trackId) &&
      playhead > c.start + 0.02 &&
      playhead < clipEnd(c) - 0.02
    );

    let hitsToSplit: Clip[] = [];

    if (!splitAll && selectedHits.length > 0) {
      // User has selected clip(s) under the playhead: split exactly the selected clip(s)!
      // (Guarantees that selecting the Voice/Audio clip splits ONLY the voice clip!)
      hitsToSplit = selectedHits;
    } else {
      // Either splitAll is true, OR no selected clip is under the playhead:
      // Find all unlocked clips under the playhead
      const clipsUnderPlayhead = clips.filter(c =>
        !lockedTrackIds.has(c.trackId) &&
        playhead > c.start + 0.02 &&
        playhead < clipEnd(c) - 0.02
      );

      if (clipsUnderPlayhead.length === 0) return;

      if (splitAll) {
        hitsToSplit = clipsUnderPlayhead;
      } else {
        // If there are video clips under playhead, prioritize video;
        // if playhead is on a gap in video or only audio exists under playhead, split audio/available clip!
        const videoHit = clipsUnderPlayhead.find(c => {
          const tr = tracks.find(t => t.id === c.trackId);
          return tr && tr.kind === 'video';
        });
        hitsToSplit = videoHit ? [videoHit] : [clipsUnderPlayhead[0]];
      }
    }

    if (hitsToSplit.length === 0) return;

    const newClips = [...clips];
    const newSelectedIds: string[] = [];

    for (const hit of hitsToSplit) {
      const offset = playhead - hit.start;
      const left: Clip = { ...hit, outPoint: hit.inPoint + offset };
      const right: Clip = {
        ...hit,
        id: uid(),
        start: playhead,
        inPoint: hit.inPoint + offset
      };

      const idx = newClips.findIndex(c => c.id === hit.id);
      if (idx !== -1) {
        newClips.splice(idx, 1, left, right);
        newSelectedIds.push(right.id);
      }
    }

    set({
      clips: newClips,
      selectedClipId: newSelectedIds[0] || null,
      selectedClipIds: newSelectedIds
    });
  },

  freezeAtPlayhead: async () => {
    const { clips, playhead, selectedClipId, tracks, media } = get();
    const videoTrackIds = new Set(tracks.filter(t => t.kind === 'video' && !t.locked).map(t => t.id));

    // 1. Find the video clip under playhead (prioritize selected clip if under playhead)
    const hit = clips.find((c) =>
      videoTrackIds.has(c.trackId) &&
      (!selectedClipId || c.id === selectedClipId) &&
      playhead >= c.start &&
      playhead <= clipEnd(c)
    ) || clips.find((c) =>
      videoTrackIds.has(c.trackId) &&
      playhead >= c.start &&
      playhead <= clipEnd(c)
    );

    if (!hit) return false;
    const hitMedia = media.find((m) => m.id === hit.mediaId);
    if (!hitMedia || hitMedia.kind === 'audio') return false;

    // Calculate source time for the freeze frame
    const sourceTime = hit.kind === 'av' && hitMedia.kind === 'video'
      ? hit.inPoint + Math.max(0, playhead - hit.start)
      : 0;

    let freezeImagePath = '';
    if (hitMedia.kind === 'image') {
      freezeImagePath = hitMedia.path;
    } else {
      // Extract freeze frame via backend
      const res = await window.api.extractFreezeFrame({
        videoPath: hitMedia.path,
        timestamp: sourceTime
      });

      if (!res?.ok || !res.imagePath) return false;
      freezeImagePath = res.imagePath;
    }

    // Register freeze image media
    const freezeMediaId = `freeze-${uid()}`;
    const freezeMedia: MediaItem = {
      id: freezeMediaId,
      name: `Freeze @ ${Math.floor(sourceTime)}s`,
      path: freezeImagePath,
      kind: 'image',
      duration: 3600, // Stretchable to any length!
      width: hitMedia.width || 1920,
      height: hitMedia.height || 1080,
      fps: hitMedia.fps || 30,
      hasAudio: false,
      thumbs: [window.api.toMediaUrl ? window.api.toMediaUrl(freezeImagePath) : freezeImagePath],
      isInternal: true
    };

    const freezeDuration = 3.0; // Standard 3.0s in CapCut
    const offset = Math.max(0, playhead - hit.start);

    const left: Clip = {
      ...hit,
      outPoint: Math.min(hit.outPoint, hit.inPoint + offset)
    };

    const freezeClip: Clip = {
      id: uid(),
      kind: 'av',
      mediaId: freezeMediaId,
      trackId: hit.trackId,
      start: playhead,
      inPoint: 0,
      outPoint: freezeDuration,
      filterId: hit.filterId,
      effectId: hit.effectId,
      transitionId: 'none',
      transitionDuration: 0.6,
      scale: hit.scale ?? 1,
      fitMode: hit.fitMode ?? 'contain',
      x: hit.x ?? 0.5,
      y: hit.y ?? 0.5,
      volume: 0,
      opacity: hit.opacity ?? 1
    };

    const right: Clip = {
      ...hit,
      id: uid(),
      start: playhead + freezeDuration,
      inPoint: hit.inPoint + offset
    };

    // Ripple shift clips on this track
    const otherClips = get().clips.filter((c) => c.id !== hit.id).map((c) => {
      if (c.trackId === hit.trackId && c.start >= hit.start + offset - 0.01) {
        return { ...c, start: c.start + freezeDuration };
      }
      return c;
    });

    const newClips: Clip[] = [];
    if (offset > 0.05) newClips.push(left);
    newClips.push(freezeClip);
    if (hit.outPoint - (hit.inPoint + offset) > 0.05) newClips.push(right);

    get().beginGesture();
    useEditor.setState((st) => ({
      media: [...st.media, freezeMedia],
      clips: [...otherClips, ...newClips],
      selectedClipId: freezeClip.id,
      selectedClipIds: [freezeClip.id],
      playhead: playhead + 0.01
    }));
    get().endGesture();
    return true;
  },

  splitClipAtTimestamps: (clipId, timestamps) => {
    const { clips, tracks } = get();
    const hit = clips.find((c) => c.id === clipId);
    if (!hit) return;
    if (tracks.find((t) => t.id === hit.trackId)?.locked) return;

    const cuts = timestamps
      .filter((t) => t > hit.inPoint + 0.2 && t < hit.outPoint - 0.2)
      .sort((a, b) => a - b);
    if (cuts.length === 0) return;

    const segments: Clip[] = [];
    let curIn = hit.inPoint;
    let curStart = hit.start;

    for (let i = 0; i < cuts.length; i++) {
      const cut = cuts[i];
      const dur = cut - curIn;
      segments.push({
        ...hit,
        id: i === 0 ? hit.id : uid(),
        inPoint: curIn,
        outPoint: cut,
        start: curStart
      });
      curStart += dur;
      curIn = cut;
    }

    segments.push({
      ...hit,
      id: uid(),
      inPoint: curIn,
      outPoint: hit.outPoint,
      start: curStart
    });

    set({
      clips: [...clips.filter((c) => c.id !== hit.id), ...segments],
      selectedClipId: segments[0].id,
      selectedClipIds: segments.map((s) => s.id)
    });
  },

  deleteClip: (id) =>
    set((s) => {
      const idsToDelete = s.selectedClipIds?.includes(id) ? s.selectedClipIds : [id];
      const lockedTrackIds = new Set(s.tracks.filter(t => t.locked).map(t => t.id));
      const targetClips = s.clips.filter((c) => idsToDelete.includes(c.id) && !lockedTrackIds.has(c.trackId));
      if (!targetClips.length) return {};

      const nextClips = applyRippleDelete(s.clips, idsToDelete, lockedTrackIds, s.autoRipple, s.tracks);

      let newPlayhead = s.playhead;
      const hitDeleted = targetClips.find(c => s.playhead >= c.start && s.playhead <= clipEnd(c));
      if (hitDeleted) {
        newPlayhead = hitDeleted.start;
      }

      return {
        clips: nextClips,
        selectedClipId: idsToDelete.includes(s.selectedClipId || '') ? null : s.selectedClipId,
        selectedClipIds: (s.selectedClipIds || []).filter(cid => !idsToDelete.includes(cid)),
        playhead: newPlayhead
      };
    }),

  deleteSelected: () =>
    set((s) => {
      const idsToDelete = s.selectedClipIds?.length
        ? s.selectedClipIds
        : s.selectedClipId
        ? [s.selectedClipId]
        : [];
      if (!idsToDelete.length) return {};
      const lockedTrackIds = new Set(s.tracks.filter(t => t.locked).map(t => t.id));
      const targetClips = s.clips.filter((c) => idsToDelete.includes(c.id) && !lockedTrackIds.has(c.trackId));
      if (!targetClips.length) return {};

      const nextClips = applyRippleDelete(s.clips, idsToDelete, lockedTrackIds, s.autoRipple, s.tracks);

      let newPlayhead = s.playhead;
      const hitDeleted = targetClips.find(c => s.playhead >= c.start && s.playhead <= clipEnd(c));
      if (hitDeleted) {
        newPlayhead = hitDeleted.start;
      }

      return {
        clips: nextClips,
        selectedClipId: null,
        selectedClipIds: [],
        playhead: newPlayhead
      };
    }),

  closeGaps: (trackId) =>
    set((s) => {
      const lockedTrackIds = new Set(s.tracks.filter(t => t.locked).map(t => t.id));
      const targetTracks = trackId
        ? s.tracks.filter(t => t.id === trackId && !lockedTrackIds.has(t.id))
        : s.tracks.filter(t => isMainVideoTrack(t.id, s.tracks) && !lockedTrackIds.has(t.id));

      if (!targetTracks.length) return {};

      let updatedClips = [...s.clips];

      for (const t of targetTracks) {
        const trackClips = updatedClips
          .filter(c => c.trackId === t.id)
          .sort((a, b) => a.start - b.start);

        if (!trackClips.length) continue;

        let curTime = 0;
        const trackClipsMap = new Map<string, number>();

        for (const c of trackClips) {
          const dur = clipDuration(c);
          trackClipsMap.set(c.id, curTime);
          curTime += dur;
        }

        updatedClips = updatedClips.map(c => {
          if (trackClipsMap.has(c.id)) {
            return { ...c, start: trackClipsMap.get(c.id)! };
          }
          return c;
        });
      }

      return { clips: updatedClips };
    }),

  updateClip: (id, patch) =>
    set((s) => ({ clips: s.clips.map((c) => (c.id === id && !s.tracks.find(t => t.id === c.trackId)?.locked ? { ...c, ...patch } : c)) })),

  updateClipStyle: (id, patch) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === id && c.style && !s.tracks.find(t => t.id === c.trackId)?.locked ? { ...c, style: { ...c.style, ...patch } } : c
      )
    })),

  addKeyframe: (clipId, time, values) =>
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== clipId || s.tracks.find(t => t.id === c.trackId)?.locked) return c;
        const keyframes = addOrUpdateKeyframe(c, time, values || {});
        return { ...c, keyframes };
      })
    })),

  removeKeyframe: (clipId, keyframeId) =>
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== clipId || s.tracks.find(t => t.id === c.trackId)?.locked) return c;
        const keyframes = removeKeyframe(c, keyframeId);
        return { ...c, keyframes };
      })
    })),

  select: (id) => set({ selectedClipId: id, selectedClipIds: id ? [id] : [] }),
  selectClips: (ids) => set({ selectedClipIds: ids, selectedClipId: ids[0] || null }),
  toggleSelectClip: (id) =>
    set((s) => {
      const cur = s.selectedClipIds || (s.selectedClipId ? [s.selectedClipId] : []);
      const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
      return { selectedClipIds: next, selectedClipId: next[0] || null };
    }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setZoom: (z) => set({ zoom: Math.min(500, Math.max(0.0001, z)) }),
  setPlaying: (p) => set({ isPlaying: p }),
  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
  toggleAutoRipple: () => set((s) => ({ autoRipple: !s.autoRipple })),

  addTrack: (kind) =>
    set((s) => {
      const n = s.tracks.filter((t) => t.kind === kind).length + 1;
      const label = kind === 'video' ? 'Video' : kind === 'audio' ? 'Audio' : 'Overlay';
      const newTrack: Track = { id: uid(), kind, name: `${label} ${n}`, muted: false, hidden: false, locked: false };
      return {
        tracks: sortTracksCapCut([...s.tracks, newTrack])
      };
    }),

  /** Always makes a new track, unlike ensureTrack which reuses one. */
  createTrack: (kind, name) => {
    const track: Track = { id: uid(), kind, name, muted: false, hidden: false, locked: false };
    set((s) => ({ tracks: sortTracksCapCut([...s.tracks, track]) }));
    return track;
  },

  addClip: (clip) => {
    const id = uid();
    set((s) => ({ clips: [...s.clips, { ...clip, id }] }));
    return id;
  },

  toggleTrackFlag: (id, flag) =>
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, [flag]: !t[flag] } : t))
    })),

  setExportPct: (p) => set({ exportPct: p }),
  setExportError: (e) => set({ exportError: e }),

  duration: () => {
    const { clips } = get();
    return clips.length ? Math.max(...clips.map(clipEnd)) : 0;
  },

  mediaOf: (clip) => get().media.find((m) => m.id === clip.mediaId),

  /** Snap a timeline position to clip edges and the playhead. */
  snapTime: (t, ignoreClipId) => {
    const s = get();
    if (!s.snapping) return t;
    const tol = Math.min(15, SNAP_PX / s.zoom);

    const targets: number[] = [0, s.playhead];
    for (const c of s.clips) {
      if (c.id === ignoreClipId) continue;
      targets.push(c.start, clipEnd(c));
    }
    let best = t;
    let bestDist = tol;
    for (const target of targets) {
      const d = Math.abs(target - t);
      if (d < bestDist) { bestDist = d; best = target; }
    }
    return best;
  }
}); });

// Dev affordance: lets the running app be driven from a console for testing.
if (import.meta.env.DEV) {
  (window as unknown as { __editor?: typeof useEditor }).__editor = useEditor;
}

export { clipDuration, clipEnd };
