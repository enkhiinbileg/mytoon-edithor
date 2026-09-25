import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icons';
import { useEditor, getTrackHeight, isMainVideoTrack, getVideoTrackLevel, TRACK_HEIGHT_PRESETS } from '../store';
import { clipDuration, clipEnd, type Clip, type Track } from '../types';
import { transitionById } from '../looks';
import { formatTime, tickStep } from '../util';
import { runAutoSyncVoice } from '../syncVoice';
import { runAutoSyncSrt } from '../syncSrt';
import VisionSettingsModal from './VisionSettingsModal';
import SrtSyncModal from './SrtSyncModal';
import AudioWaveform from './AudioWaveform';

/* ------------------------------- ruler --------------------------------- */

const Ruler = memo(function Ruler({ zoom, width }: { zoom: number; width: number }) {
  const step = tickStep(zoom);
  const count = Math.ceil(width / (step * zoom)) + 1;
  const subTicksCount = step >= 5 ? 5 : step >= 1 ? 4 : 2;
  const subStep = step / subTicksCount;
  const subStepPx = subStep * zoom;
  const showSubTicks = subStepPx >= 10;

  return (
    <div className="ruler" style={{ width }}>
      {Array.from({ length: count }, (_, i) => {
        const t = i * step;
        const x = t * zoom;
        return (
          <div key={i}>
            <div className="ruler-tick" style={{ left: x }} />
            <div className="ruler-label" style={{ left: x }}>
              {formatTime(t, step < 1)}
            </div>
            {showSubTicks &&
              Array.from({ length: subTicksCount - 1 }, (_, sIdx) => {
                const subX = x + (sIdx + 1) * subStepPx;
                if (subX >= width) return null;
                return <div key={`sub-${sIdx}`} className="ruler-subtick" style={{ left: subX }} />;
              })}
          </div>
        );
      })}
    </div>
  );
});

/* -------------------------------- clip --------------------------------- */

// Module-level in-memory frame cache so once extracted, frames never need re-fetching
const globalFrameCache = new Map<string, string>();
const mediaKeysMap = new Map<string, number[]>();

function addCachedFrame(filePath: string, key: number, url: string) {
  if (!globalFrameCache.has(`${filePath}#${key}`)) {
    globalFrameCache.set(`${filePath}#${key}`, url);
    let list = mediaKeysMap.get(filePath);
    if (!list) {
      list = [];
      mediaKeysMap.set(filePath, list);
    }
    // Binary insert sorted
    let low = 0, high = list.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (list[mid] < key) low = mid + 1;
      else high = mid;
    }
    list.splice(low, 0, key);
  }
}

// Centralized thumbnail scheduler to extract frames smoothly without dropping clips or choking FFmpeg
type PendingThumbReq = { filePath: string; timestamp: number; key: number };
const pendingThumbQueue: PendingThumbReq[] = [];
const queuedThumbKeys = new Set<string>();
let thumbQueueTimer: any = null;
let activeThumbBatches = 0;
const MAX_CONCURRENT_THUMB_BATCHES = 2;
const thumbListeners = new Set<() => void>();

function notifyThumbnailListeners() {
  for (const fn of thumbListeners) {
    try { fn(); } catch {}
  }
}

function processPendingThumbQueue() {
  thumbQueueTimer = null;
  if (activeThumbBatches >= MAX_CONCURRENT_THUMB_BATCHES || pendingThumbQueue.length === 0) return;

  const targetFile = pendingThumbQueue[0]?.filePath;
  if (!targetFile) return;

  const batch: PendingThumbReq[] = [];
  for (let i = 0; i < pendingThumbQueue.length && batch.length < 10; i++) {
    if (pendingThumbQueue[i].filePath === targetFile) {
      batch.push(pendingThumbQueue.splice(i, 1)[0]);
      i--;
    }
  }

  if (batch.length === 0) return;

  activeThumbBatches++;
  const timestamps = batch.map((b) => b.timestamp);

  window.api.clipThumbnails(targetFile, timestamps)
    .then((res) => {
      if (res.ok && Array.isArray(res.paths)) {
        let added = false;
        batch.forEach((item, idx) => {
          queuedThumbKeys.delete(`${targetFile}#${item.key}`);
          const p = res.paths[idx];
          if (p) {
            addCachedFrame(targetFile, item.key, window.api.toMediaUrl(p));
            added = true;
          }
        });
        if (added) {
          notifyThumbnailListeners();
        }
      }
    })
    .catch(() => {
      batch.forEach((item) => queuedThumbKeys.delete(`${targetFile}#${item.key}`));
    })
    .finally(() => {
      activeThumbBatches = Math.max(0, activeThumbBatches - 1);
      if (pendingThumbQueue.length > 0) {
        processPendingThumbQueue();
      }
    });
}

function requestClipThumbnail(filePath: string, timestamp: number, priority = false) {
  const safeT = Math.max(0, timestamp);
  const key = Math.round(safeT * 10);
  const cacheKey = `${filePath}#${key}`;
  if (globalFrameCache.has(cacheKey)) return;

  if (queuedThumbKeys.has(cacheKey)) {
    if (priority) {
      const idx = pendingThumbQueue.findIndex((q) => q.filePath === filePath && q.key === key);
      if (idx > 0) {
        const [item] = pendingThumbQueue.splice(idx, 1);
        pendingThumbQueue.unshift(item);
      }
    }
    return;
  }

  queuedThumbKeys.add(cacheKey);
  if (priority) {
    pendingThumbQueue.unshift({ filePath, timestamp: safeT, key });
  } else {
    pendingThumbQueue.push({ filePath, timestamp: safeT, key });
  }

  if (priority) {
    if (thumbQueueTimer) clearTimeout(thumbQueueTimer);
    thumbQueueTimer = setTimeout(processPendingThumbQueue, 10);
  } else if (!thumbQueueTimer) {
    thumbQueueTimer = setTimeout(processPendingThumbQueue, 40);
  }
}

function getNearestCachedFrame(filePath: string, targetKey: number, maxKeyDistance = 600): string | undefined {
  const direct = globalFrameCache.get(`${filePath}#${targetKey}`);
  if (direct) return direct;

  const list = mediaKeysMap.get(filePath);
  if (!list || list.length === 0) return undefined;

  let low = 0, high = list.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (list[mid] === targetKey) return globalFrameCache.get(`${filePath}#${list[mid]}`);
    if (list[mid] < targetKey) low = mid + 1;
    else high = mid - 1;
  }

  let bestKey = -1;
  let bestDist = Infinity;

  const check = (idx: number) => {
    if (idx >= 0 && idx < list.length) {
      const d = Math.abs(list[idx] - targetKey);
      if (d < bestDist && d <= maxKeyDistance) {
        bestDist = d;
        bestKey = list[idx];
      }
    }
  };

  check(low);
  check(low - 1);
  check(high);
  check(high + 1);

  if (bestKey !== -1) {
    return globalFrameCache.get(`${filePath}#${bestKey}`);
  }
  return undefined;
}

const ClipView = memo(function ClipView({
  clip,
  height,
  onPointerDown,
  onContextMenu,
  viewport
}: {
  clip: Clip;
  height: number;
  onPointerDown: (e: React.PointerEvent, clip: Clip, mode: 'move' | 'in' | 'out') => void;
  onContextMenu?: (e: React.MouseEvent, clip: Clip) => void;
  viewport: { left: number; right: number };
}) {
  const zoom = useEditor((s) => s.zoom);
  const selected = useEditor((s) => (s.selectedClipIds?.length ? s.selectedClipIds.includes(clip.id) : s.selectedClipId === clip.id));
  const media = useEditor((s) => (clip.mediaId ? s.media.find((m) => m.id === clip.mediaId) : undefined));

  const track = useEditor((s) => s.tracks.find((t) => t.id === clip.trackId));
  const dur = clipDuration(clip);
  const width = Math.max(6, dur * zoom);
  const isAudio = track?.kind === 'audio' || media?.kind === 'audio';
  const isOverlay = clip.kind === 'text' || clip.kind === 'sticker';
  const transition = transitionById(clip.transitionId);

  // Each thumbnail tile width in pixels (~56-64px like CapCut)
  const tileW = Math.max(48, Math.round((height - 8) * 1.25));
  const isNarrow = width <= tileW;

  const clipLeft = clip.start * zoom;
  const clipRight = clipLeft + width;

  // Viewport with 400px overscan buffer to prevent flicker while scrolling
  const viewLeft = Math.max(0, viewport.left - 400);
  const viewRight = viewport.right + 400;

  // Visible tile range inside this clip
  const visibleRange = useMemo(() => {
    if (isOverlay || !media || isAudio || clipRight < viewLeft || clipLeft > viewRight) {
      return { start: 0, end: -1, total: 0 };
    }
    const relStart = Math.max(0, viewLeft - clipLeft);
    const relEnd = Math.min(width, viewRight - clipLeft);
    const total = Math.ceil(width / tileW);
    const start = Math.max(0, Math.floor(relStart / tileW));
    const end = Math.min(total - 1, Math.ceil(relEnd / tileW));
    return { start, end, total };
  }, [isOverlay, media, isAudio, clipLeft, clipRight, width, viewLeft, viewRight, tileW]);

  const isPlaying = useEditor((s) => s.isPlaying);
  const [frameRevision, setFrameRevision] = useState(0);

  // Re-render when thumbnail batch updates the cache
  useEffect(() => {
    const onFrame = () => setFrameRevision((r) => r + 1);
    thumbListeners.add(onFrame);
    return () => {
      thumbListeners.delete(onFrame);
    };
  }, []);

  const isHighPriority = selected;

  // Request high-resolution frames for visible clips via the centralized queue
  useEffect(() => {
    if (!media || isAudio || isOverlay || media.kind === 'image' || isPlaying) return;
    if (clipRight < viewLeft || clipLeft > viewRight) return;

    // Always request the clip's exact inPoint frame (highest priority if active/selected)
    requestClipThumbnail(media.path, clip.inPoint, isHighPriority);

    // If clip is wide and multiple tiles fit, request tile timestamps
    if (!isNarrow && visibleRange.end >= visibleRange.start) {
      for (let i = visibleRange.start; i <= visibleRange.end; i++) {
        const midX = (i + 0.5) * tileW;
        const dt = midX / zoom;
        const t = Math.min(clip.outPoint, clip.inPoint + dt);
        requestClipThumbnail(media.path, t, isHighPriority);
      }
    }
  }, [media?.path, media?.kind, isAudio, isOverlay, isPlaying, clip.inPoint, clip.outPoint, clipLeft, clipRight, viewLeft, viewRight, isNarrow, tileW, zoom, visibleRange.start, visibleRange.end, isHighPriority]);

  // Generate visible tiles strictly positioned at pixel offset i * tileW
  const visibleTiles = useMemo(() => {
    if (isOverlay || !media || isAudio || visibleRange.end < visibleRange.start) return [];

    const isImg = media.kind === 'image';
    const imgSrc = isImg ? (window.api.toMediaUrl ? window.api.toMediaUrl(media.path) : (media.thumbs?.[0] || media.path)) : '';

    if (isNarrow) {
      let src = imgSrc;
      if (!isImg) {
        const key = Math.round(clip.inPoint * 10);
        src = getNearestCachedFrame(media.path, key, 15) || '';
        if (!src) {
          src = getNearestCachedFrame(media.path, key, 35) || '';
        }
        if (!src && media.thumbs && media.thumbs.length > 0) {
          const thumbStep = media.duration / media.thumbs.length;
          const idx = Math.min(media.thumbs.length - 1, Math.max(0, Math.floor((clip.inPoint / media.duration) * media.thumbs.length)));
          const thumbTime = (idx + 0.5) * thumbStep;
          if (Math.abs(thumbTime - clip.inPoint) <= 4.0) {
            src = media.thumbs[idx] || '';
          }
        }
      }
      return [{ index: 0, left: 0, src: src || '' }];
    }

    const list = [];
    for (let i = visibleRange.start; i <= visibleRange.end; i++) {
      let src = imgSrc;
      if (!isImg) {
        const midX = (i + 0.5) * tileW;
        const dt = midX / zoom;
        const t = Math.min(clip.outPoint, clip.inPoint + dt);
        const key = Math.round(t * 10);

        // 1. Exact or tight high-res frame from cache within 1.0 second (10 keys)
        src = getNearestCachedFrame(media.path, key, 10) || '';

        // 2. High-res frame from cache within at most 3.5s (35 keys)
        if (!src) {
          src = getNearestCachedFrame(media.path, key, 35) || '';
        }

        // 3. Fallback to clip inPoint if within 4.0s
        if (!src) {
          const inKey = Math.round(clip.inPoint * 10);
          if (Math.abs(inKey - key) <= 40) {
            src = getNearestCachedFrame(media.path, inKey, 15) || '';
          }
        }

        // 4. Coarse thumbnail fallback ONLY IF it is genuinely close to t (<= 4.0s)
        if (!src && media.thumbs && media.thumbs.length > 0) {
          const thumbStep = media.duration / media.thumbs.length;
          const idx = Math.min(media.thumbs.length - 1, Math.max(0, Math.floor((t / media.duration) * media.thumbs.length)));
          const thumbTime = (idx + 0.5) * thumbStep;
          if (Math.abs(thumbTime - t) <= 4.0) {
            src = media.thumbs[idx] || '';
          }
        }
      }

      list.push({
        index: i,
        left: i * tileW,
        src: src || ''
      });
    }
    return list;
  }, [media, isAudio, isOverlay, visibleRange, isNarrow, tileW, zoom, clip.inPoint, clip.outPoint, frameRevision]);

  const isImage = media?.kind === 'image';
  const durationText = formatTime(dur, false);
  const label = isOverlay
    ? (clip.style?.text ?? clip.sticker ?? 'text')
    : (clip.label ? `${isImage ? '❄️ ' : ''}${clip.label} · ${durationText}` : `${isImage ? '❄️ ' : ''}${media?.name ?? 'clip'} · ${durationText}`);

  return (
    <div
      className={
        'clip' +
        (isAudio ? ' audio' : '') +
        (isOverlay ? ' overlay' : '') +
        (isImage ? ' freeze-clip' : '') +
        (clip.kind === 'sticker' ? ' sticker' : '') +
        (selected ? ' selected' : '')
      }
      style={{ left: clipLeft, width }}
      onPointerDown={(e) => {
        if (e.button === 2) return;
        onPointerDown(e, clip, 'move');
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e, clip);
      }}
      title={label}
    >
      {visibleTiles.length > 0 && (
        <div className="clip-strip">
          {visibleTiles.map((t) => (
            <img
              key={t.index}
              src={t.src}
              style={{
                position: 'absolute',
                left: t.left,
                width: isNarrow ? '100%' : tileW,
                height: '100%',
                objectFit: 'cover',
                borderRight: isNarrow ? 'none' : undefined,
                visibility: t.src ? 'visible' : 'hidden'
              }}
              draggable={false}
              alt=""
            />
          ))}
        </div>
      )}
      {isAudio && (
        <AudioWaveform
          clip={clip}
          media={media}
          width={width}
          height={height}
          zoom={zoom}
          viewport={viewport}
          clipLeft={clipLeft}
        />
      )}

      {/* Sticky clip label: stays visible at the left edge of visible track viewport */}
      <div
        className="clip-label"
        style={{ left: Math.max(6, Math.min(Math.max(6, width - 80), viewport.left - clipLeft + 6)) }}
      >
        {label}
      </div>

      {transition.xfade && (
        <div className="clip-transition" title={`${transition.label} ${(clip.transitionDuration ?? 0.6).toFixed(1)}s`}>
          <Icon name="transition" style={{ width: 12, height: 12 }} />
        </div>
      )}

      {clip.keyframes && clip.keyframes.length > 0 && (
        <div className="clip-keyframes-layer">
          {clip.keyframes.map((kf) => {
            const kfX = kf.time * zoom;
            return (
              <div
                key={kf.id}
                className="keyframe-diamond"
                style={{ left: kfX }}
                title={`Keyframe: ${formatTime(clip.start + kf.time, true)}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  useEditor.getState().setPlayhead(clip.start + kf.time);
                }}
              />
            );
          })}
        </div>
      )}

      <div
        className="clip-handle in"
        onPointerDown={(e) => {
          if (e.button === 2) return;
          onPointerDown(e, clip, 'in');
        }}
      />
      <div
        className="clip-handle out"
        onPointerDown={(e) => {
          if (e.button === 2) return;
          onPointerDown(e, clip, 'out');
        }}
      />
    </div>
  );
});

/* ------------------------------ timeline ------------------------------- */

interface TimelineProps {
  onRequestExport?: (scope: 'all' | 'selected', format?: 'mp4' | 'mp3') => void;
  onQuickExportSelected?: (format?: 'mp4' | 'mp3') => void;
}

export default function Timeline({ onRequestExport, onQuickExportSelected }: TimelineProps = {}) {
  const zoom = useEditor((s) => s.zoom);
  const setZoom = useEditor((s) => s.setZoom);
  const tracks = useEditor((s) => s.tracks);
  const clips = useEditor((s) => s.clips);
  const playhead = useEditor((s) => s.playhead);
  const isPlaying = useEditor((s) => s.isPlaying);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setPlaying = useEditor((s) => s.setPlaying);
  const select = useEditor((s) => s.select);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const selectedClipIds = useEditor((s) => s.selectedClipIds);
  const snapping = useEditor((s) => s.snapping);
  const toggleSnapping = useEditor((s) => s.toggleSnapping);
  const autoRipple = useEditor((s) => s.autoRipple);
  const toggleAutoRipple = useEditor((s) => s.toggleAutoRipple);
  const closeGaps = useEditor((s) => s.closeGaps);
  const splitAtPlayhead = useEditor((s) => s.splitAtPlayhead);
  const freezeAtPlayhead = useEditor((s) => s.freezeAtPlayhead);
  const [freezing, setFreezing] = useState(false);
  const deleteClip = useEditor((s) => s.deleteClip);
  const addTrack = useEditor((s) => s.addTrack);
  const toggleTrackFlag = useEditor((s) => s.toggleTrackFlag);
  const trackHeightMode = useEditor((s) => s.trackHeightMode);
  const setTrackHeightMode = useEditor((s) => s.setTrackHeightMode);
  const setTrackHeight = useEditor((s) => s.setTrackHeight);
  const deleteTrack = useEditor((s) => s.deleteTrack);
  const duration = useEditor((s) => s.duration());
  const [autoFollow, setAutoFollow] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [visionModalOpen, setVisionModalOpen] = useState(false);
  const [srtModalOpen, setSrtModalOpen] = useState(false);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const mediaList = useEditor((s) => s.media);
  const [sceneDetecting, setSceneDetecting] = useState(false);
  const [viewport, setViewport] = useState({ left: 0, right: 2000 });
  const [dragVisual, setDragVisual] = useState<{
    clip: Clip;
    x: number;
    y: number;
    width: number;
    targetTrackId: string;
    targetStart: number;
    snapX?: number;
  } | null>(null);

  // Right-click context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    clipId: string;
  } | null>(null);

  const targetClipIds = useMemo(() => {
    return selectedClipIds?.length ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
  }, [selectedClipIds, selectedClipId]);

  const selectedClipsList = useMemo(() => {
    return clips.filter((c) => targetClipIds.includes(c.id));
  }, [clips, targetClipIds]);

  const selCount = selectedClipsList.length;
  const selMinStart = useMemo(() => {
    return selCount > 0 ? Math.min(...selectedClipsList.map((c) => c.start)) : 0;
  }, [selectedClipsList, selCount]);
  const selMaxEnd = useMemo(() => {
    return selCount > 0 ? Math.max(...selectedClipsList.map((c) => clipEnd(c))) : 0;
  }, [selectedClipsList, selCount]);
  const selDuration = Math.max(0, selMaxEnd - selMinStart);

  const handleClipContextMenu = useCallback((e: React.MouseEvent, clip: Clip) => {
    e.preventDefault();
    e.stopPropagation();

    const state = useEditor.getState();
    const currentSelected = state.selectedClipIds || [];

    // If right clicked on a clip not currently in multi-selection, select it
    if (!currentSelected.includes(clip.id)) {
      state.select(clip.id);
    }

    const menuWidth = 240;
    const menuHeight = 310;
    const x = Math.min(window.innerWidth - menuWidth - 12, Math.max(12, e.clientX));
    const y = Math.min(window.innerHeight - menuHeight - 12, Math.max(12, e.clientY));

    setContextMenu({ x, y, clipId: clip.id });
  }, []);

  const handleTracksContextMenu = useCallback((e: React.MouseEvent) => {
    const state = useEditor.getState();
    const hasSelected = (state.selectedClipIds && state.selectedClipIds.length > 0) || Boolean(state.selectedClipId);
    if (!hasSelected) return;

    e.preventDefault();
    const menuWidth = 240;
    const menuHeight = 310;
    const x = Math.min(window.innerWidth - menuWidth - 12, Math.max(12, e.clientX));
    const y = Math.min(window.innerHeight - menuHeight - 12, Math.max(12, e.clientY));

    const targetId = state.selectedClipIds?.[0] || state.selectedClipId || '';
    setContextMenu({ x, y, clipId: targetId });
  }, []);

  // Close context menu on window pointerdown or Escape key
  useEffect(() => {
    if (!contextMenu) return;
    const handleClose = () => setContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('pointerdown', handleClose);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handleClose);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const headsRef = useRef<HTMLDivElement>(null);
  const isProgrammaticScrollRef = useRef(false);
  const userInteractedRef = useRef(false);
  const interactionTimerRef = useRef<number | null>(null);
  const lastReportedScrollRef = useRef(0);
  const prevZoomRef = useRef(zoom);
  const skipCenterOnNextZoomRef = useRef(false);

  const markUserInteracted = useCallback(() => {
    userInteractedRef.current = true;
    if (interactionTimerRef.current) window.clearTimeout(interactionTimerRef.current);
    interactionTimerRef.current = window.setTimeout(() => {
      userInteractedRef.current = false;
    }, 1200);
  }, []);

  const updateViewport = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    lastReportedScrollRef.current = el.scrollLeft;
    setViewport({ left: el.scrollLeft, right: el.scrollLeft + el.clientWidth });
  }, []);

  useEffect(() => {
    updateViewport();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateViewport);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateViewport]);

  // When playback starts or resumes, bring playhead into view if offscreen
  useEffect(() => {
    if (isPlaying) {
      userInteractedRef.current = false;
      const el = scrollRef.current;
      if (el && autoFollow) {
        const playheadPx = playhead * zoom;
        if (playheadPx < el.scrollLeft || playheadPx > el.scrollLeft + el.clientWidth) {
          isProgrammaticScrollRef.current = true;
          el.scrollLeft = Math.max(0, playheadPx - el.clientWidth * 0.5);
          updateViewport();
        }
      }
    } else {
      updateViewport();
    }
  }, [isPlaying, autoFollow]);

  // CapCut Playhead Following & Playhead-Centered Zoom Engine - 60fps synchronous DOM scroll before paint
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const playheadPx = playhead * zoom;
    const clientW = el.clientWidth;
    const maxScroll = Math.max(0, el.scrollWidth - clientW);

    // 1. Playhead-Centered Zoom ("Зүүгээ голлох"):
    // Whenever zoom level changes (slider, zoom buttons, wheel, shortcuts), center the playhead needle immediately!
    if (prevZoomRef.current !== zoom) {
      prevZoomRef.current = zoom;

      if (skipCenterOnNextZoomRef.current) {
        skipCenterOnNextZoomRef.current = false;
        return;
      }

      if (maxScroll > 0) {
        const targetScroll = Math.max(0, Math.min(maxScroll, playheadPx - clientW * 0.5));
        isProgrammaticScrollRef.current = true;
        userInteractedRef.current = false;
        el.scrollLeft = targetScroll;
        lastReportedScrollRef.current = targetScroll;
        setViewport({ left: targetScroll, right: targetScroll + clientW });
      }
      return;
    }

    if (!autoFollow) return;
    if (maxScroll <= 0) return;

    if (isPlaying) {
      if (!userInteractedRef.current) {
        // CapCut behavior: When playhead reaches 50% of screen width, continuously flow the timeline
        const centerThreshold = el.scrollLeft + clientW * 0.5;
        if (playheadPx >= centerThreshold) {
          const targetScroll = Math.min(maxScroll, playheadPx - clientW * 0.5);
          if (Math.abs(el.scrollLeft - targetScroll) >= 0.5) {
            isProgrammaticScrollRef.current = true;
            el.scrollLeft = targetScroll;
          }
        } else if (playheadPx < el.scrollLeft) {
          // Playhead jumped behind current view
          const targetScroll = Math.max(0, playheadPx - clientW * 0.2);
          isProgrammaticScrollRef.current = true;
          el.scrollLeft = targetScroll;
        }
      }
    } else {
      // While paused, keep playhead in view if it steps outside
      if (!userInteractedRef.current) {
        if (playheadPx > el.scrollLeft + clientW - 30) {
          isProgrammaticScrollRef.current = true;
          el.scrollLeft = Math.min(maxScroll, playheadPx - clientW + 80);
        } else if (playheadPx < el.scrollLeft + 30) {
          isProgrammaticScrollRef.current = true;
          el.scrollLeft = Math.max(0, playheadPx - 80);
        }
      }
    }
  }, [playhead, isPlaying, zoom, autoFollow]);

  const selectedClip = clips.find((c) => c.id === selectedClipId);
  const selectedMedia = selectedClip ? mediaList.find((m) => m.id === selectedClip.mediaId) : null;
  const canSceneSplit = Boolean(selectedClip && selectedMedia && selectedMedia.kind === 'video');

  const handleSceneSplit = async () => {
    if (!selectedClip || !selectedMedia || sceneDetecting) return;
    setSceneDetecting(true);
    try {
      const res = await window.api.sceneDetect(selectedMedia.path);
      if (res.ok && res.cuts?.length) {
        useEditor.getState().splitClipAtTimestamps(selectedClip.id, res.cuts);
        setSyncNotice(`Амжилттай: ${res.cuts.length} үзэгдлээр салгалаа.`);
        setTimeout(() => setSyncNotice(null), 5000);
      } else {
        setSyncNotice('Үзэгдлийн огцом шилжилт олдсонгүй.');
        setTimeout(() => setSyncNotice(null), 4000);
      }
    } catch (err) {
      setSyncNotice('Үзэгдэл танихад алдаа гарлаа: ' + String(err));
      setTimeout(() => setSyncNotice(null), 5000);
    } finally {
      setSceneDetecting(false);
    }
  };

  const handleFreeze = async () => {
    if (freezing) return;
    setFreezing(true);
    try {
      const ok = await freezeAtPlayhead();
      if (ok) {
        setSyncNotice('❄️ Кадр царцаалаа: Одоо сунгаж (stretch) эсвэл тасалж (cut) болно.');
        setTimeout(() => setSyncNotice(null), 4000);
      } else {
        setSyncNotice('Царцаах боломжгүй: Зүүг видео клип дээр аваачна уу.');
        setTimeout(() => setSyncNotice(null), 3000);
      }
    } catch (err) {
      setSyncNotice('Царцаахад алдаа гарлаа: ' + String(err));
      setTimeout(() => setSyncNotice(null), 4000);
    } finally {
      setFreezing(false);
    }
  };

  const handleRunVisionAI = useCallback(async () => {
    if (syncing) return;
    if (!hasGeminiKey) {
      setVisionModalOpen(true);
      return;
    }
    setSyncing(true);
    setSyncNotice('👁️ Gemini Vision AI: Бичлэгийн кадруудыг voice-д тааруулж эхэлж байна...');
    try {
      await runAutoSyncVoice((msg) => {
        setSyncNotice(msg);
        setTimeout(() => setSyncNotice(null), 6000);
      }, { forceVision: true });
    } finally {
      setSyncing(false);
    }
  }, [syncing, hasGeminiKey]);

  useEffect(() => {
    window.api.readSettings().then((s) => setHasGeminiKey(Boolean(s.geminiApiKey)));
    const unsub = window.api.onVoiceEditProgress?.((p: { stage?: string; message?: string }) => {
      if (p?.message) {
        setSyncNotice(p.message);
      }
    });
    return () => {
      unsub?.();
    };
  }, []);
  const undo = useEditor(s=>s.undo), redo = useEditor(s=>s.redo);
  const canUndo = useEditor(s=>s.canUndo), canRedo = useEditor(s=>s.canRedo);
  const tracksRef = useRef<HTMLDivElement>(null);

  const viewportWidth = scrollRef.current?.clientWidth || 1200;
  // CapCut 1:1: generous right padding and extra virtual timeline so ruler and tracks extend smoothly
  const rightPaddingPx = Math.max(viewportWidth * 0.85, 800);
  const contentWidth = Math.max(duration * zoom + rightPaddingPx, viewportWidth * 1.6);

  const calcFitZoom = useMemo(() => {
    const w = Math.max(400, (scrollRef.current?.clientWidth || 1200) * 0.78);
    return Math.max(0.0005, Math.min(200, w / Math.max(1, duration)));
  }, [duration]);

  // CapCut 1:1: Allows pulling out deeply so any video duration can shrink to ~15-20% of screen width
  const minZoomLimit = Math.max(0.0001, Math.min(calcFitZoom * 0.2, 2));
  const maxZoomLimit = 500;

  /* ---- playhead-anchored zoom engine (CapCut 1:1) ---- */
  const applyAnchoredZoom = useCallback(
    (newZoom: number) => {
      const el = scrollRef.current;
      const clientW = el?.clientWidth || 1200;
      const fit = Math.max(0.0005, Math.min(200, (clientW * 0.78) / Math.max(1, duration)));
      const lowerBound = Math.max(0.0001, Math.min(fit * 0.2, 2));
      const targetZoom = Math.min(500, Math.max(lowerBound, newZoom));
      if (Math.abs(targetZoom - zoom) < 0.00001) return;
      setZoom(targetZoom);
    },
    [zoom, duration, setZoom]
  );

  const handleTimelineWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const el = scrollRef.current;
      if (!el) return;

      if (e.ctrlKey || e.metaKey || e.altKey) {
        // Ctrl/Alt/Meta + Mouse Wheel or Pinch = Smooth Zoom centered on playhead needle ("зүү")
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.2 : 0.83;
        applyAnchoredZoom(zoom * factor);
      } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        // Standard mouse wheel scrolls timeline horizontally
        e.preventDefault();
        markUserInteracted();
        el.scrollLeft += e.deltaY;
        lastReportedScrollRef.current = el.scrollLeft;
        setViewport({ left: el.scrollLeft, right: el.scrollLeft + el.clientWidth });
      }
    },
    [zoom, applyAnchoredZoom, markUserInteracted]
  );

  /* ---- scrubbing ---- */
  const scrubTo = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left + el.scrollLeft;
      setPlaying(false);
      setPlayhead(Math.max(0, x / zoom));
    },
    [zoom, setPlayhead, setPlaying]
  );

  const onRulerPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    userInteractedRef.current = false;
    scrubTo(e.clientX);
    const el = scrollRef.current;
    const move = (ev: PointerEvent) => {
      scrubTo(ev.clientX);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (ev.clientX > rect.right - 35) {
          el.scrollLeft += 12;
        } else if (ev.clientX < rect.left + 35) {
          el.scrollLeft = Math.max(0, el.scrollLeft - 12);
        }
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* ---- clip drag / trim ---- */
  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, clip: Clip, mode: 'move' | 'in' | 'out') => {
      e.stopPropagation();
      const state = useEditor.getState();
      if (state.tracks.find(t=>t.id===clip.trackId)?.locked) return;

      const isMulti = e.shiftKey || e.ctrlKey || e.metaKey;
      if (isMulti) {
        state.toggleSelectClip(clip.id);
        return;
      }

      const curSelected = state.selectedClipIds || [];
      if (!curSelected.includes(clip.id)) {
        select(clip.id);
      }

      state.beginGesture();
      if (mode !== 'move') e.preventDefault();

      const startX = e.clientX;
      const origStart = clip.start;
      const origIn = clip.inPoint;
      const origOut = clip.outPoint;
      const origTrackId = clip.trackId;
      let lastTrackId = clip.trackId;

      const srcKind = state.tracks.find((t) => t.id === clip.trackId)?.kind;
      const isGroupMove = mode === 'move' && curSelected.length > 1 && curSelected.includes(clip.id);
      let lastDeltaX = 0;

      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / zoom;

        if (mode === 'move') {
          if (isGroupMove) {
            const stepDelta = dx - lastDeltaX;
            lastDeltaX = dx;
            useEditor.getState().moveClips(curSelected, stepDelta);
          } else {
            const rawNext = Math.max(0, origStart + dx);
            let next = state.snapTime(rawNext, clip.id);

            let snapX: number | undefined = undefined;
            if (state.snapping && Math.abs(next - rawNext) > 0.0001) {
              snapX = next * zoom;
            }

            // Vertical drag switches track, routing to upper layer when dragged above video tracks
            let targetTrack = lastTrackId;
            const box = tracksRef.current?.getBoundingClientRect();
            if (box) {
              const y = ev.clientY - box.top;
              let acc = 0;
              let foundTrack: Track | null = null;
              let topVideoY = -1;
              for (const t of state.tracks) {
                const h = getTrackHeight(t, trackHeightMode);
                if (t.kind === 'video' && topVideoY === -1) {
                  topVideoY = acc;
                }
                if (y >= acc && y < acc + h) {
                  foundTrack = t;
                }
                acc += h;
              }

              if (srcKind === 'video') {
                if (topVideoY !== -1 && y < topVideoY) {
                  // Dragged above highest video track: auto-route/create upper layer track (PIP)
                  const layerTrack = useEditor.getState().ensureLayerTrack('video');
                  targetTrack = layerTrack.id;
                } else if (foundTrack && foundTrack.kind === 'video' && !foundTrack.locked) {
                  targetTrack = foundTrack.id;
                }
              } else if (srcKind === 'audio') {
                if (foundTrack && foundTrack.kind === 'audio' && !foundTrack.locked) {
                  targetTrack = foundTrack.id;
                }
              }
            }
            lastTrackId = targetTrack;
            useEditor.getState().moveClip(clip.id, next, targetTrack);

            setDragVisual({
              clip,
              x: ev.clientX,
              y: ev.clientY,
              width: (origOut - origIn) * zoom,
              targetTrackId: targetTrack,
              targetStart: next,
              snapX
            });
          }
        } else if (mode === 'in') {
          const cur = useEditor.getState().clips.find((c) => c.id === clip.id);
          if (!cur) return;
          const rawStartTime = origStart + dx;
          let targetStartTime = rawStartTime;
          let snapX: number | undefined = undefined;
          if (useEditor.getState().snapping) {
            targetStartTime = useEditor.getState().snapTime(targetStartTime, clip.id);
            if (Math.abs(targetStartTime - rawStartTime) > 0.0001) {
              snapX = targetStartTime * zoom;
            }
          }
          const effDx = targetStartTime - origStart;
          useEditor.getState().trimClip(clip.id, 'in', origIn + effDx - cur.inPoint);
          setDragVisual(snapX ? { clip, x: ev.clientX, y: ev.clientY, width: (origOut - (origIn + effDx)) * zoom, targetTrackId: clip.trackId, targetStart: targetStartTime, snapX } : null);
        } else {
          const cur = useEditor.getState().clips.find((c) => c.id === clip.id);
          if (!cur) return;
          const origDur = origOut - origIn;
          const rawEndTime = origStart + origDur + dx;
          let targetEndTime = rawEndTime;
          let snapX: number | undefined = undefined;
          if (useEditor.getState().snapping) {
            targetEndTime = useEditor.getState().snapTime(targetEndTime, clip.id);
            if (Math.abs(targetEndTime - rawEndTime) > 0.0001) {
              snapX = targetEndTime * zoom;
            }
          }
          const effDx = targetEndTime - (origStart + origDur);
          useEditor.getState().trimClip(clip.id, 'out', origOut + effDx - cur.outPoint);
          setDragVisual(snapX ? { clip, x: ev.clientX, y: ev.clientY, width: (origDur + effDx) * zoom, targetTrackId: clip.trackId, targetStart: clip.start, snapX } : null);
        }
      };

      const up = () => {
        setDragVisual(null);
        if (mode === 'move') {
          useEditor.getState().commitMoveClip(clip.id, lastTrackId, origTrackId);
        }
        useEditor.getState().endGesture();
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [zoom, select]
  );

  /* ---- drop from the media panel ---- */
  const onDrop = (e: React.DragEvent, trackId: string) => {
    e.preventDefault();
    const mediaId = e.dataTransfer.getData('text/media-id');
    const el = scrollRef.current;
    const at = el ? Math.max(0,(e.clientX-el.getBoundingClientRect().left+el.scrollLeft)/zoom) : 0;
    if (mediaId) useEditor.getState().addMediaToTimeline(mediaId, trackId, useEditor.getState().snapTime(at));
  };

  /* ---- marquee / box selection ---- */
  const onTracksPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.clip') || target.closest('.playhead') || target.closest('.ruler')) return;

    const tracksEl = tracksRef.current;
    if (!tracksEl) return;

    const rect = tracksEl.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;

    const isAdd = e.shiftKey || e.ctrlKey || e.metaKey;
    const prevSelected = isAdd ? (useEditor.getState().selectedClipIds || []) : [];

    setMarquee({ startX, startY, currentX: startX, currentY: startY });

    const move = (ev: PointerEvent) => {
      const curX = ev.clientX - rect.left;
      const curY = ev.clientY - rect.top;

      setMarquee({ startX, startY, currentX: curX, currentY: curY });

      const boxLeft = Math.min(startX, curX);
      const boxRight = Math.max(startX, curX);
      const boxTop = Math.min(startY, curY);
      const boxBottom = Math.max(startY, curY);

      if (boxRight - boxLeft > 3 || boxBottom - boxTop > 3) {
        const state = useEditor.getState();
        const intersecting = new Set<string>(prevSelected);

        let curTrackY = 0;
        for (const t of state.tracks) {
          const h = getTrackHeight(t, trackHeightMode);
          const trackTop = curTrackY;
          const trackBottom = curTrackY + h;
          curTrackY += h;

          if (t.locked) continue;

          if (trackTop < boxBottom && trackBottom > boxTop) {
            const trackClips = state.clips.filter((c) => c.trackId === t.id);
            for (const c of trackClips) {
              const clipLeft = c.start * zoom;
              const clipRight = clipLeft + Math.max(6, clipDuration(c) * zoom);
              if (clipLeft < boxRight && clipRight > boxLeft) {
                intersecting.add(c.id);
              } else if (!isAdd) {
                intersecting.delete(c.id);
              }
            }
          }
        }
        state.selectClips(Array.from(intersecting));
      }
    };

    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);

      const curX = ev.clientX - rect.left;
      const curY = ev.clientY - rect.top;
      const dist = Math.hypot(curX - startX, curY - startY);

      setMarquee(null);

      if (dist < 4 && !isAdd) {
        useEditor.getState().select(null);
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [zoom]);

  const trackIcon = (t: Track) =>
    t.kind === 'video' ? (t.hidden ? 'eyeOff' : 'eye')
    : t.kind === 'audio' ? (t.muted ? 'volumeOff' : 'volume')
    : (t.hidden ? 'eyeOff' : 'eye');

  return (
    <section className="timeline">
      <div className="tl-toolbar">
        <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}><Icon name="undo" /></button>
        <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}><Icon name="redo" /></button>
        <div className="sep" />
        <button className="icon-btn" title="Таслах / Split (Ctrl+B, B, S)" onClick={() => splitAtPlayhead()}>
          <Icon name="split" />
        </button>
        <button
          className="btn"
          title="Кадр царцаах (Freeze / F) - Одоогийн тоглуулагчийн кадрыг зураг болгон таслаад ярианд тааруулж сунгах/тайрах"
          onClick={handleFreeze}
          disabled={freezing}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 9px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 5,
            background: 'rgba(56, 189, 248, 0.12)',
            color: '#38bdf8',
            border: '1px solid rgba(56, 189, 248, 0.3)',
            cursor: freezing ? 'wait' : 'pointer'
          }}
        >
          <span>{freezing ? '❄️ Түр хүлээнэ үү...' : '❄️ Царцаах (F)'}</span>
        </button>
        <button
          className="btn"
          title="Сонгосон бичлэгийн үзэгдэл (scene cut) бүрийг автоматаар таньж салгах"
          disabled={!canSceneSplit || sceneDetecting}
          onClick={handleSceneSplit}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 8px',
            fontSize: 11,
            fontWeight: 500,
            borderRadius: 5,
            background: canSceneSplit ? 'rgba(0, 196, 140, 0.12)' : 'rgba(255, 255, 255, 0.05)',
            color: canSceneSplit ? 'var(--primary, #00c48c)' : '#777',
            border: `1px solid ${canSceneSplit ? 'var(--primary, #00c48c)' : 'rgba(255, 255, 255, 0.1)'}`,
            cursor: canSceneSplit ? 'pointer' : 'not-allowed',
            opacity: canSceneSplit ? 1 : 0.5
          }}
        >
          <Icon name="split" style={{ width: 12, height: 12 }} />
          <span>{sceneDetecting ? 'Шинжилж байна...' : '✂ Үзэгдлээр салгах'}</span>
        </button>
        <button
          className="icon-btn"
          title="Delete selected (Del / Backspace)"
          onClick={() => useEditor.getState().deleteSelected()}
          disabled={!selectedClipId && !selectedClipIds?.length}
        >
          <Icon name="trash" />
        </button>

        <div className="sep" />

        <button className="icon-btn" title="Duplicate (Ctrl+D)" disabled={!selectedClipId} onClick={()=>selectedClipId&&useEditor.getState().duplicateClip(selectedClipId)}><Icon name="duplicate" /></button>

        <button className="icon-btn" title="Add video track" onClick={() => addTrack('video')}>
          <Icon name="media" />
        </button>
        <button className="icon-btn" title="Add audio track" onClick={() => addTrack('audio')}>
          <Icon name="audio" />
        </button>
        <button className="icon-btn" title="Add overlay track" onClick={() => addTrack('overlay')}>
          <Icon name="text" />
        </button>

        <div className="sep" />

        <button
          className={'icon-btn' + (autoRipple ? ' active' : '')}
          title={autoRipple ? 'Автомат шахалт (Auto Ripple: Идэвхтэй / B) - Клип таслах, устгах, богиносгоход дүрсийг зүүн тийш автоматаар шахна' : 'Автомат шахалт (Auto Ripple: Унтраасан / B)'}
          onClick={() => {
            toggleAutoRipple();
            setSyncNotice(!autoRipple ? '🧲 Автомат шахалт (Auto Ripple): Идэвхжлээ' : '⚪ Автомат шахалт: Унтарлаа');
            setTimeout(() => setSyncNotice(null), 3000);
          }}
        >
          <Icon name="ripple" />
        </button>
        <button
          className={'icon-btn' + (snapping ? ' active' : '')}
          title="Snapping (Соронзлох)"
          onClick={toggleSnapping}
        >
          <Icon name="magnet" />
        </button>
        <button
          className={'icon-btn' + (autoFollow ? ' active' : '')}
          title={autoFollow ? 'Зүү дагах (Идэвхтэй) - CapCut шиг автоматаар урсана' : 'Зүү дагах (Унтраасан)'}
          onClick={() => setAutoFollow(!autoFollow)}
        >
          <Icon name="follow" />
        </button>
        <button
          className="icon-btn"
          title="Хоосон зайг арилгах (Бүх дүрсийг зүүн зах руу шахах)"
          onClick={() => {
            closeGaps();
            setSyncNotice('✨ Бүх хоосон зайг арилгаж зүүн зах руу шахлаа');
            setTimeout(() => setSyncNotice(null), 3000);
          }}
        >
          <Icon name="skipBack" style={{ width: 14, height: 14 }} />
        </button>

        <div className="sep" />


        <button
          className="btn"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 12px',
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 6,
            background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
            color: '#fff',
            cursor: 'pointer',
            border: 'none',
            lineHeight: 1.2,
            boxShadow: '0 2px 10px rgba(99, 102, 241, 0.35)',
            transition: 'all 0.2s ease'
          }}
          title="Монгол скрипт текстээс ElevenLabs v3 хоолой үүсгэж, манхва дүрсэнд 1 товшилтоор тааруулах"
          onClick={() => window.dispatchEvent(new CustomEvent('open-script-studio'))}
        >
          <span style={{ fontSize: 13 }}>🎙️</span>
          <span>Скрипт Студи</span>
        </button>

        <button
          className="btn"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 12px',
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 6,
            background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.18) 0%, rgba(99, 102, 241, 0.22) 100%)',
            color: '#38bdf8',
            cursor: 'pointer',
            border: '1px solid rgba(56, 189, 248, 0.4)',
            lineHeight: 1.2,
            boxShadow: '0 2px 8px rgba(56, 189, 248, 0.25)',
            transition: 'all 0.2s ease'
          }}
          title="ElevenLabs аудио болон монгол скриптийг өгүүлбэрээр нь уялдуулж таймлайн дээр яг таг өрөх"
          onClick={() => window.dispatchEvent(new CustomEvent('open-audio-script'))}
        >
          <span style={{ fontSize: 13 }}>⚡</span>
          <span>Аудио + Скрипт</span>
        </button>

        <div className="spacer" />

        <div className="zoom-row">
          <button
            className="icon-btn"
            title="Бүх бичлэгийг багтаах (Fit timeline - Shift+Z)"
            onClick={() => {
              skipCenterOnNextZoomRef.current = true;
              const el = scrollRef.current;
              const clientW = el?.clientWidth || 1200;
              const targetW = Math.max(350, clientW * 0.78);
              const fit = Math.max(0.0005, Math.min(200, targetW / Math.max(1, duration)));
              setZoom(fit);
              if (el) {
                el.scrollLeft = 0;
                setViewport({ left: 0, right: el.clientWidth });
              }
            }}
          >
            <Icon name="fit" />
          </button>
          <button
            className="icon-btn"
            title="Багасгах (Ctrl + Wheel down)"
            onClick={() => applyAnchoredZoom(zoom / 1.35)}
          >
            <Icon name="zoomOut" />
          </button>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.min(
              100,
              Math.max(
                0,
                Math.round(
                  (Math.log(Math.max(minZoomLimit, zoom) / minZoomLimit) /
                    Math.log(maxZoomLimit / minZoomLimit)) *
                    100
                )
              )
            )}
            onChange={(e) => {
              const ratio = Number(e.target.value) / 100;
              const target = minZoomLimit * Math.pow(maxZoomLimit / minZoomLimit, ratio);
              applyAnchoredZoom(target);
            }}
            title={`Zoom: ${zoom < 1 ? zoom.toFixed(3) : Math.round(zoom)} px/s`}
          />
          <button
            className="icon-btn"
            title="Томсгох (Ctrl + Wheel up)"
            onClick={() => applyAnchoredZoom(zoom * 1.35)}
          >
            <Icon name="zoomIn" />
          </button>

          {/* CapCut Track Height Selector */}
          <div className="tl-track-height-selector" style={{ display: 'flex', alignItems: 'center', gap: 2, background: '#1c1c24', padding: '2px 4px', borderRadius: 5, marginLeft: 8 }}>
            <button
              type="button"
              className={'icon-btn' + (trackHeightMode === 'compact' ? ' active' : '')}
              style={{
                fontSize: 10,
                padding: '3px 6px',
                borderRadius: 3,
                background: trackHeightMode === 'compact' ? 'var(--accent)' : 'transparent',
                color: trackHeightMode === 'compact' ? '#042f2e' : '#aaa',
                fontWeight: trackHeightMode === 'compact' ? 700 : 500
              }}
              onClick={() => setTrackHeightMode('compact')}
              title="Давхаргыг жижигрүүлэх (Compact 36px) - Бүх давхаргуудыг нэг дор харах"
            >
              ▤ Жижиг
            </button>
            <button
              type="button"
              className={'icon-btn' + (trackHeightMode === 'normal' ? ' active' : '')}
              style={{
                fontSize: 10,
                padding: '3px 6px',
                borderRadius: 3,
                background: trackHeightMode === 'normal' ? 'var(--accent)' : 'transparent',
                color: trackHeightMode === 'normal' ? '#042f2e' : '#aaa',
                fontWeight: trackHeightMode === 'normal' ? 700 : 500
              }}
              onClick={() => setTrackHeightMode('normal')}
              title="Давхаргын хэвийн өндөр (Normal 58px)"
            >
              ▦ Хэвийн
            </button>
            <button
              type="button"
              className={'icon-btn' + (trackHeightMode === 'large' ? ' active' : '')}
              style={{
                fontSize: 10,
                padding: '3px 6px',
                borderRadius: 3,
                background: trackHeightMode === 'large' ? 'var(--accent)' : 'transparent',
                color: trackHeightMode === 'large' ? '#042f2e' : '#aaa',
                fontWeight: trackHeightMode === 'large' ? 700 : 500
              }}
              onClick={() => setTrackHeightMode('large')}
              title="Давхаргыг томруулах (Large 88px) - Аудио долгион ба кадруудыг томоор харах"
            >
              ▥ Том
            </button>
          </div>
        </div>
      </div>

      <div className="tl-body">
        <div className="tl-heads">
          <div ref={headsRef}>
          <div className="tl-heads-spacer" />
          {tracks.map((t: Track) => {
            const h = getTrackHeight(t, trackHeightMode);
            const isMain = isMainVideoTrack(t.id, tracks);
            const trackClips = clips.filter((c) => c.trackId === t.id);
            const canDelete = !isMain && trackClips.length === 0 && tracks.filter((x) => x.kind === t.kind).length > 1;
            const level = t.kind === 'video' ? getVideoTrackLevel(t.id, tracks) : 0;

            return (
              <div
                key={t.id}
                className={'track-head' + (isMain ? ' main-track-head' : '')}
                style={{
                  height: h,
                  borderLeft: isMain ? '3px solid #10b981' : t.kind === 'video' ? '3px solid #3b82f6' : '3px solid transparent'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  {isMain ? (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 750,
                        background: 'rgba(16, 185, 129, 0.2)',
                        color: '#34d399',
                        border: '1px solid rgba(16, 185, 129, 0.4)',
                        padding: '1px 5px',
                        borderRadius: 3,
                        whiteSpace: 'nowrap'
                      }}
                      title="Үндсэн видео зам (Main Track - соронзон наалт идэвхтэй)"
                    >
                      ⚓ Үндсэн
                    </span>
                  ) : t.kind === 'video' ? (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 650,
                        background: '#1e293b',
                        color: '#93c5fd',
                        border: '1px solid #3b82f6',
                        padding: '1px 5px',
                        borderRadius: 3,
                        whiteSpace: 'nowrap'
                      }}
                      title={`Дээд давхарга (Layer ${level})`}
                    >
                      L{level}
                    </span>
                  ) : null}
                  <span className="name truncate" style={{ fontSize: 11, fontWeight: isMain ? 650 : 500 }}>
                    {t.name}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <button
                    className={'mini' + (t.locked ? ' on' : '')}
                    title={t.locked ? 'Түгжээ тайлах' : 'Замыг түгжих'}
                    onClick={() => toggleTrackFlag(t.id, 'locked')}
                  >
                    <Icon name={t.locked ? 'lock' : 'unlock'} style={{ width: 12, height: 12 }} />
                  </button>
                  {t.kind === 'video' && (
                    <button
                      className={'mini' + (t.muted ? ' on' : '')}
                      title={t.muted ? 'Видеоны дууг нээх' : 'Видеоны дууг хаах'}
                      onClick={() => toggleTrackFlag(t.id, 'muted')}
                    >
                      <Icon name={t.muted ? 'volumeOff' : 'volume'} style={{ width: 12, height: 12 }} />
                    </button>
                  )}
                  <button
                    className={'mini' + (t.hidden || t.muted ? ' on' : '')}
                    title={t.kind === 'audio' ? (t.muted ? 'Дууг нээх' : 'Дууг хаах') : (t.hidden ? 'Давхаргыг харуулах' : 'Давхаргыг нуух')}
                    onClick={() => toggleTrackFlag(t.id, t.kind === 'audio' ? 'muted' : 'hidden')}
                  >
                    <Icon name={trackIcon(t)} style={{ width: 13, height: 13 }} />
                  </button>
                  {canDelete && (
                    <button
                      className="mini"
                      style={{ fontSize: 13, color: '#ef4444', lineHeight: 1 }}
                      title="Хоосон давхаргыг устгах"
                      onClick={() => deleteTrack(t.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          </div>
        </div>

        <div
          className="tl-scroll"
          ref={scrollRef}
          onWheel={handleTimelineWheel}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (headsRef.current) headsRef.current.style.transform = `translateY(-${el.scrollTop}px)`;

            if (isProgrammaticScrollRef.current) {
              isProgrammaticScrollRef.current = false;
            } else {
              markUserInteracted();
            }

            const curLeft = el.scrollLeft;
            if (Math.abs(curLeft - lastReportedScrollRef.current) > 70) {
              lastReportedScrollRef.current = curLeft;
              setViewport({ left: curLeft, right: curLeft + el.clientWidth });
            }
          }}
        >
          <div className="tl-content" style={{ width: contentWidth }}>
            <div onPointerDown={onRulerPointerDown}>
              <Ruler zoom={zoom} width={contentWidth} />
            </div>

            <div
              className="tracks"
              ref={tracksRef}
              onPointerDown={onTracksPointerDown}
              onContextMenu={handleTracksContextMenu}
            >
              {tracks.map((t) => {
                const h = getTrackHeight(t, trackHeightMode);
                const trackClips = clips
                  .filter((c) => c.trackId === t.id)
                  .sort((a, b) => a.start - b.start);

                const gaps: { start: number; end: number; duration: number }[] = [];
                for (let i = 0; i < trackClips.length; i++) {
                  const prevEnd = i === 0 ? 0 : clipEnd(trackClips[i - 1]);
                  const curStart = trackClips[i].start;
                  if (curStart - prevEnd > 0.08) {
                    gaps.push({ start: prevEnd, end: curStart, duration: curStart - prevEnd });
                  }
                }

                return (
                  <div
                    key={t.id}
                    className={'track ' + t.kind + (t.locked ? ' locked-track' : '')}
                    style={{ height: h }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => onDrop(e, t.id)}
                  >
                    {dragVisual && dragVisual.targetTrackId === t.id && (
                      <div
                        className="tl-drop-slot"
                        style={{
                          left: dragVisual.targetStart * zoom,
                          width: Math.max(8, dragVisual.width)
                        }}
                      />
                    )}
                    {gaps.map((g, idx) => (
                      <div
                        key={`gap-${idx}-${g.start}`}
                        className="track-gap"
                        style={{
                          left: g.start * zoom,
                          width: Math.max(4, g.duration * zoom)
                        }}
                        title={`Хоосон зай (${g.duration.toFixed(1)}с) - Дарж зүүн тийш шахах`}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeGaps(t.id);
                        }}
                      >
                        {g.duration * zoom > 36 && (
                          <span className="gap-label">◀ {g.duration.toFixed(1)}s</span>
                        )}
                      </div>
                    ))}
                    {trackClips.map((c) => (
                      <ClipView
                        key={c.id}
                        clip={c}
                        height={h}
                        onPointerDown={onClipPointerDown}
                        onContextMenu={handleClipContextMenu}
                        viewport={viewport}
                      />
                    ))}
                  </div>
                );
              })}
              {dragVisual?.snapX != null && (
                <div
                  className="tl-snap-line"
                  style={{ left: dragVisual.snapX }}
                />
              )}
              {marquee && (
                <div
                  className="tl-marquee"
                  style={{
                    position: 'absolute',
                    left: Math.min(marquee.startX, marquee.currentX),
                    top: Math.min(marquee.startY, marquee.currentY),
                    width: Math.abs(marquee.currentX - marquee.startX),
                    height: Math.abs(marquee.currentY - marquee.startY),
                    border: '1.5px solid var(--accent, #00d6c9)',
                    background: 'rgba(0, 214, 201, 0.18)',
                    pointerEvents: 'none',
                    zIndex: 35,
                    borderRadius: 2,
                    boxShadow: '0 0 10px rgba(0, 214, 201, 0.25)'
                  }}
                />
              )}
            </div>
            {!clips.length&&<div className="tl-empty-hint">Drag media here to start your video</div>}

            <div
              className="playhead"
              style={{ left: playhead * zoom, top: 0, bottom: 0 }}
              onPointerDown={onRulerPointerDown}
              title={`Playhead: ${formatTime(playhead)}`}
            >
              <div
                className="playhead-split-btn"
                title="Таслах (Ctrl+B, B, S)"
                onPointerDown={(e) => {
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  splitAtPlayhead();
                }}
              >
                <Icon name="split" style={{ width: 11, height: 11 }} />
              </div>
            </div>
          </div>
        </div>
      </div>
      {dragVisual && (
        <div
          className="tl-ghost-clip"
          style={{
            left: dragVisual.x,
            top: dragVisual.y,
            width: Math.min(220, Math.max(70, dragVisual.width)),
            height: 38
          }}
        >
          <span className="ghost-title">
            {dragVisual.clip.name || mediaList.find((m) => m.id === dragVisual.clip.mediaId)?.name || 'Clip'} ({((dragVisual.clip.outPoint - dragVisual.clip.inPoint)).toFixed(1)}s)
          </span>
        </div>
      )}
      <footer className="tl-status"><span>{tracks.length} tracks · {clips.length} clips</span><span>Space: play / pause <i>·</i> Ctrl B / B: split <i>·</i> Ctrl S: save</span><span>{formatTime(duration)} total</span></footer>
      {syncNotice && (
        <div className="toast" role="status" onClick={() => setSyncNotice(null)}>
          {syncNotice}
          <button className="notice-close" onClick={() => setSyncNotice(null)}>×</button>
        </div>
      )}
      {visionModalOpen && (
        <VisionSettingsModal
          onClose={() => setVisionModalOpen(false)}
          onSaved={() => {
            window.api.readSettings().then((s) => setHasGeminiKey(Boolean(s.geminiApiKey)));
          }}
          onRunVision={handleRunVisionAI}
        />
      )}
      {srtModalOpen && (
        <SrtSyncModal
          isOpen={srtModalOpen}
          onClose={() => setSrtModalOpen(false)}
          onSuccessNotice={(msg) => {
            setSyncNotice(msg);
            setTimeout(() => setSyncNotice(null), 6000);
          }}
        />
      )}

      {/* Modern Right-Click Context Menu for Clips */}
      {contextMenu && (
        <div
          className="timeline-context-menu"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            minWidth: 236,
            background: '#191b22',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            borderRadius: 10,
            boxShadow: '0 12px 36px rgba(0, 0, 0, 0.85), 0 0 1px 1px rgba(255, 255, 255, 0.08)',
            zIndex: 999999,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            padding: '4px 0',
            userSelect: 'none'
          }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* Header Info */}
          <div
            style={{
              padding: '8px 14px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 11,
              color: '#9ca3af',
              background: 'rgba(255, 255, 255, 0.02)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#00c48c', fontWeight: 700 }}>🎯 Сонгосон:</span>
              <span style={{ color: '#f3f4f6', fontWeight: 600 }}>{selCount} клип</span>
            </div>
            <span style={{ color: '#34d399', fontWeight: 600 }}>{formatTime(selDuration)}</span>
          </div>

          {/* Primary Action: Export Selected Clips (MP4) */}
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              onRequestExport?.('selected', 'mp4');
            }}
            style={{
              padding: '10px 14px',
              textAlign: 'left',
              background: 'linear-gradient(135deg, rgba(0, 196, 140, 0.22) 0%, rgba(99, 102, 241, 0.22) 100%)',
              border: 'none',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: '#fff',
              transition: 'background 0.15s ease'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'linear-gradient(135deg, rgba(0, 196, 140, 0.35) 0%, rgba(99, 102, 241, 0.35) 100%)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'linear-gradient(135deg, rgba(0, 196, 140, 0.22) 0%, rgba(99, 102, 241, 0.22) 100%)';
            }}
          >
            <span style={{ fontSize: 18 }}>🎬</span>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#34d399' }}>
                Сонгосонг экспортлох (MP4)...
              </span>
              <span style={{ fontSize: 10, color: '#a5b4fc', marginTop: 1 }}>
                {selCount} клипийг тусад нь MP4 видео болгох
              </span>
            </div>
          </button>

          {/* Audio Action: Export Selected Clips as MP3 */}
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              onRequestExport?.('selected', 'mp3');
            }}
            style={{
              padding: '10px 14px',
              textAlign: 'left',
              background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.2) 0%, rgba(236, 72, 153, 0.2) 100%)',
              border: 'none',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: '#fff',
              transition: 'background 0.15s ease'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'linear-gradient(135deg, rgba(168, 85, 247, 0.35) 0%, rgba(236, 72, 153, 0.35) 100%)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'linear-gradient(135deg, rgba(168, 85, 247, 0.2) 0%, rgba(236, 72, 153, 0.2) 100%)';
            }}
          >
            <span style={{ fontSize: 18 }}>🎵</span>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#f472b6' }}>
                MP3 аудио болгон экспортлох...
              </span>
              <span style={{ fontSize: 10, color: '#e9d5ff', marginTop: 1 }}>
                Зөвхөн дуу/аудиог MP3 файл болгон хадгалах
              </span>
            </div>
          </button>

          {/* Quick Export MP4 Option */}
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              onQuickExportSelected?.('mp4');
            }}
            style={{
              padding: '8px 14px',
              fontSize: 12,
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: '#e4e4e7',
              transition: 'background 0.15s ease'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ fontSize: 14 }}>⚡</span>
            <span style={{ flex: 1 }}>Шуурхай видео (Quick MP4)</span>
            <span style={{ fontSize: 10, color: '#71717a' }}>1080p</span>
          </button>

          {/* Quick Export MP3 Option */}
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              onQuickExportSelected?.('mp3');
            }}
            style={{
              padding: '8px 14px',
              fontSize: 12,
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: '#e4e4e7',
              transition: 'background 0.15s ease'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ fontSize: 14 }}>⚡</span>
            <span style={{ flex: 1 }}>Шуурхай аудио (Quick MP3)</span>
            <span style={{ fontSize: 10, color: '#c084fc' }}>192 kbps</span>
          </button>

          <div style={{ height: 1, background: 'rgba(255, 255, 255, 0.08)', margin: '3px 0' }} />

          {/* Edit Actions */}
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              splitAtPlayhead();
            }}
            style={{
              padding: '7px 14px',
              fontSize: 12,
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: '#e4e4e7',
              transition: 'background 0.15s ease'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ fontSize: 13 }}>✂️</span>
            <span style={{ flex: 1 }}>Зүүгээр хуваах</span>
            <kbd style={{ fontSize: 10, color: '#71717a', padding: '1px 4px', background: 'rgba(255,255,255,0.06)', borderRadius: 3 }}>S</kbd>
          </button>

          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              handleFreeze();
            }}
            style={{
              padding: '7px 14px',
              fontSize: 12,
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: '#e4e4e7',
              transition: 'background 0.15s ease'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ fontSize: 13 }}>❄️</span>
            <span style={{ flex: 1 }}>Кадр царцаах (Freeze)</span>
            <kbd style={{ fontSize: 10, color: '#71717a', padding: '1px 4px', background: 'rgba(255,255,255,0.06)', borderRadius: 3 }}>F</kbd>
          </button>

          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              if (selectedClipId) {
                useEditor.getState().duplicateClip(selectedClipId);
              }
            }}
            style={{
              padding: '7px 14px',
              fontSize: 12,
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: '#e4e4e7',
              transition: 'background 0.15s ease'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ fontSize: 13 }}>📋</span>
            <span style={{ flex: 1 }}>Хувилах (Duplicate)</span>
            <kbd style={{ fontSize: 10, color: '#71717a', padding: '1px 4px', background: 'rgba(255,255,255,0.06)', borderRadius: 3 }}>Ctrl+D</kbd>
          </button>

          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              closeGaps();
            }}
            style={{
              padding: '7px 14px',
              fontSize: 12,
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: '#e4e4e7',
              transition: 'background 0.15s ease'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ fontSize: 13 }}>◀</span>
            <span style={{ flex: 1 }}>Хоосон зайг шахах</span>
          </button>

          <div style={{ height: 1, background: 'rgba(255, 255, 255, 0.08)', margin: '3px 0' }} />

          {/* Delete Selected */}
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              useEditor.getState().deleteSelected();
            }}
            style={{
              padding: '7px 14px',
              fontSize: 12,
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: '#f87171',
              transition: 'background 0.15s ease'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ fontSize: 13 }}>🗑️</span>
            <span style={{ flex: 1 }}>Сонгосонг устгах</span>
            <kbd style={{ fontSize: 10, color: '#fca5a5', padding: '1px 4px', background: 'rgba(239, 68, 68, 0.12)', borderRadius: 3 }}>Del</kbd>
          </button>
        </div>
      )}
    </section>
  );
}
