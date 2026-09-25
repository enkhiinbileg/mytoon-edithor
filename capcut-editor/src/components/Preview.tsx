import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icons';
import { useEditor, getVideoTrackLevel } from '../store';
import { clipEnd, clipDuration, type Clip, type MediaItem } from '../types';
import { effectById, filterById } from '../looks';
import { rasterizeOverlay, REF_H } from '../overlayRaster';
import { formatTime } from '../util';
import { interpolateClipKeyframes } from '../keyframes';

function useSyncMedia(ref: React.RefObject<HTMLMediaElement | null>, clip: Clip, playing: boolean, time: number, volume = 0) {
  const seekingRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const lastClipIdRef = useRef<string>(clip.id);

  // When clip changes, immediately clear any pending seeks from the previous clip
  if (lastClipIdRef.current !== clip.id) {
    lastClipIdRef.current = clip.id;
    seekingRef.current = false;
    pendingSeekRef.current = null;
  }

  const isFreeze = Boolean(clip.isFreeze);
  const offset = isFreeze
    ? (clip.freezeTs != null ? clip.freezeTs : clip.inPoint)
    : clip.inPoint + Math.max(0, time - clip.start);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Safety: if element is not seeking, clear seekingRef
    if (!element.seeking && seekingRef.current) {
      seekingRef.current = false;
    }

    // If already seeking, coalesce rapid scrubbing into pendingSeekRef to prevent decoder thrashing
    if (seekingRef.current || element.seeking) {
      pendingSeekRef.current = offset;
      return;
    }

    const drift = Math.abs(element.currentTime - offset);
    const threshold = playing ? 0.4 : 0.02;

    if (element.readyState >= 1 && drift > threshold) {
      seekingRef.current = true;
      try {
        element.currentTime = Math.max(0.000001, offset);
      } catch {
        seekingRef.current = false;
      }
    }

    element.volume = Math.min(1, Math.max(0, volume));
    if (playing && !isFreeze) {
      if (element.paused && !seekingRef.current && !element.seeking && element.readyState >= 2) {
        void element.play().catch(() => {});
      }
    } else {
      if (!element.paused) {
        element.pause();
      }
    }
  }, [clip.id, clip.inPoint, clip.start, time, playing, volume, ref, offset, isFreeze]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const onSeeked = () => {
      seekingRef.current = false;
      if (pendingSeekRef.current !== null) {
        const next = pendingSeekRef.current;
        pendingSeekRef.current = null;
        const drift = Math.abs(element.currentTime - next);
        if (drift > (playing ? 0.25 : 0.02)) {
          seekingRef.current = true;
          try {
            element.currentTime = Math.max(0.000001, next);
          } catch {
            seekingRef.current = false;
          }
          return;
        }
      }

      // Seek has completed at accurate time; now safe to resume playback without jumping to t=0
      if (playing && !isFreeze && element.paused) {
        const currentTarget = offset;
        const curDrift = Math.abs(element.currentTime - currentTarget);
        if (curDrift <= 0.35) {
          void element.play().catch(() => {});
        }
      }
    };

    const onMediaReady = () => {
      const currentTarget = offset;
      const curDrift = Math.abs(element.currentTime - currentTarget);
      if (curDrift > (playing ? 0.25 : 0.02)) {
        seekingRef.current = true;
        try {
          element.currentTime = Math.max(0.000001, currentTarget);
        } catch {
          seekingRef.current = false;
        }
      }
    };

    element.addEventListener('seeked', onSeeked);
    element.addEventListener('loadedmetadata', onMediaReady);
    element.addEventListener('loadeddata', onMediaReady);
    element.addEventListener('canplay', onMediaReady);
    return () => {
      element.removeEventListener('seeked', onSeeked);
      element.removeEventListener('loadedmetadata', onMediaReady);
      element.removeEventListener('loadeddata', onMediaReady);
      element.removeEventListener('canplay', onMediaReady);
    };
  }, [clip.id, clip.inPoint, clip.start, time, playing, ref]);
}

function VideoLayer({
  clip,
  media,
  time,
  playing,
  transitionStyle,
  isHeld = false
}: {
  clip: Clip;
  media: MediaItem;
  time: number;
  playing: boolean;
  transitionStyle?: React.CSSProperties;
  isHeld?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const isImage = media.kind === 'image';
  const [isReady, setIsReady] = useState(isImage);

  useSyncMedia(ref, clip, isHeld ? false : playing, time);

  // Monitor when video has genuinely decoded its target frame at clip.inPoint
  useEffect(() => {
    if (isImage) {
      setIsReady(true);
      return;
    }
    const el = ref.current;
    if (!el) return;

    const checkReady = () => {
      const targetOffset = clip.inPoint + Math.max(0, time - clip.start);
      const isAtTarget = Math.abs(el.currentTime - targetOffset) <= 0.35;
      if (el.readyState >= 2 && isAtTarget && !el.seeking) {
        setIsReady(true);
      }
    };

    checkReady();
    el.addEventListener('seeked', checkReady);
    el.addEventListener('loadeddata', checkReady);
    el.addEventListener('canplay', checkReady);
    el.addEventListener('timeupdate', checkReady);
    return () => {
      el.removeEventListener('seeked', checkReady);
      el.removeEventListener('loadeddata', checkReady);
      el.removeEventListener('canplay', checkReady);
      el.removeEventListener('timeupdate', checkReady);
    };
  }, [clip.id, clip.inPoint, clip.start, isImage, time]);

  const tf = interpolateClipKeyframes(clip, time);
  const effect = effectById(clip.effectId);
  const scale = tf.scale;
  const fitMode = clip.fitMode ?? 'contain';
  const posX = (tf.x - 0.5) * 100;
  const posY = (tf.y - 0.5) * 100;
  const rotation = tf.rotation;

  const style: React.CSSProperties = {
    filter: filterById(clip.filterId).css || undefined,
    animation: effect.css || undefined,
    animationPlayState: 'paused',
    animationDelay: '-' + Math.max(0, time - clip.start) + 's',
    ['--cc-dur' as string]: clipDuration(clip) + 's',
    objectFit: fitMode,
    transform: `translate(${posX}%, ${posY}%) rotate(${rotation}deg) scale(${scale}) translateZ(0)`
  };
  if (clip.effectId === 'fadeOut') {
    style.animation = undefined;
    style.opacity = Math.min(1, Math.max(0, (clipEnd(clip) - time) / 0.6));
  }

  return (
    <div
      className={'video-layer' + (isHeld ? ' held-layer' : '')}
      style={{
        opacity: isReady ? tf.opacity : 0,
        visibility: isReady ? 'visible' : 'hidden',
        transition: isImage ? undefined : 'opacity 0.06s ease',
        ...transitionStyle
      }}
    >
      {isImage ? (
        <img
          src={window.api.toMediaUrl(media.path)}
          alt=""
          style={style}
          onPointerDown={(e) => {
            if (isHeld) return;
            e.stopPropagation();
            useEditor.getState().select(clip.id);
          }}
        />
      ) : (
        <video
          ref={ref}
          src={window.api.toMediaUrl(media.path)}
          muted
          preload="auto"
          playsInline
          style={style}
          onPointerDown={(e) => {
            if (isHeld) return;
            e.stopPropagation();
            useEditor.getState().select(clip.id);
          }}
        />
      )}
    </div>
  );
}

function AudioLayer({
  clip,
  media,
  time,
  playing,
  volume,
  registerMaster
}: {
  clip: Clip;
  media: MediaItem;
  time: number;
  playing: boolean;
  volume: number;
  registerMaster?: (el: HTMLAudioElement | null, clip: Clip) => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  useSyncMedia(ref, clip, playing, time, volume);

  useEffect(() => {
    const el = ref.current;
    if (el && registerMaster) {
      registerMaster(el, clip);
      return () => {
        registerMaster(null, clip);
      };
    }
  }, [clip, registerMaster]);

  return <audio ref={ref} src={window.api.toMediaUrl(media.path)} preload="auto" />;
}

function Overlay({clip, scale, selected, onDrag, time}: {clip: Clip; scale: number; selected: boolean; onDrag: (e: React.PointerEvent, c: Clip) => void; time: number}) {
  const [fontRev, setFontRev] = useState(0);
  useEffect(() => {
    const onFontUpdate = () => setFontRev((r) => r + 1);
    window.addEventListener('cutline:fonts-updated', onFontUpdate);
    return () => window.removeEventListener('cutline:fonts-updated', onFontUpdate);
  }, []);

  const raster = useMemo(() => rasterizeOverlay(clip, 1), [clip.style, clip.sticker, fontRev]);
  if (!raster) return null;
  const tf = interpolateClipKeyframes(clip, time);
  return (
    <img
      className={'overlay-item' + (selected ? ' selected' : '')}
      src={raster.dataUrl}
      draggable={false}
      alt={clip.style?.text || ''}
      style={{
        left: tf.x * 100 + '%',
        top: tf.y * 100 + '%',
        width: raster.w * scale * tf.scale,
        height: raster.h * scale * tf.scale,
        transform: `translate(-50%, -50%) rotate(${tf.rotation}deg)`,
        opacity: tf.opacity
      }}
      onPointerDown={(e) => onDrag(e, clip)}
    />
  );
}

function VideoTransformBox({
  clip,
  media,
  stageWidth,
  stageHeight,
  projectWidth,
  projectHeight,
  playhead,
  innerRef,
  isLocked
}: {
  clip: Clip;
  media: MediaItem;
  stageWidth: number;
  stageHeight: number;
  projectWidth: number;
  projectHeight: number;
  playhead: number;
  innerRef: React.RefObject<HTMLDivElement | null>;
  isLocked: boolean;
}) {
  const tf = interpolateClipKeyframes(clip, playhead);
  const mediaW = media.width || projectWidth;
  const mediaH = media.height || projectHeight;
  const mediaRatio = mediaW / mediaH;
  const stageRatio = projectWidth / projectHeight;

  const fitMode = clip.fitMode ?? 'contain';
  let baseW = stageWidth;
  let baseH = stageHeight;

  if (fitMode === 'contain') {
    if (mediaRatio > stageRatio) {
      baseW = stageWidth;
      baseH = stageWidth / mediaRatio;
    } else {
      baseH = stageHeight;
      baseW = stageHeight * mediaRatio;
    }
  } else {
    // cover
    if (mediaRatio > stageRatio) {
      baseH = stageHeight;
      baseW = stageHeight * mediaRatio;
    } else {
      baseW = stageWidth;
      baseH = stageWidth / mediaRatio;
    }
  }

  const boxW = baseW * tf.scale;
  const boxH = baseH * tf.scale;
  const cx = tf.x * stageWidth;
  const cy = tf.y * stageHeight;
  const rot = tf.rotation;

  const [activeAction, setActiveAction] = useState<'move' | 'scale' | 'rotate' | null>(null);
  const [liveInfo, setLiveInfo] = useState<string>('');

  const handleMoveDown = (e: React.PointerEvent) => {
    if (isLocked) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const s = useEditor.getState();
    s.select(clip.id);
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect) return;

    s.beginGesture();
    setActiveAction('move');

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const initX = tf.x;
    const initY = tf.y;
    const hasKf = Boolean(clip.keyframes && clip.keyframes.length > 0);
    const relTime = Math.max(0, Math.min(clipDuration(clip), s.playhead - clip.start));

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startClientX;
      const dy = ev.clientY - startClientY;
      let newX = initX + dx / stageWidth;
      let newY = initY + dy / stageHeight;

      if (Math.abs(newX - 0.5) < 0.012) newX = 0.5;
      if (Math.abs(newY - 0.5) < 0.012) newY = 0.5;

      newX = Math.max(-0.5, Math.min(1.5, Math.round(newX * 1000) / 1000));
      newY = Math.max(-0.5, Math.min(1.5, Math.round(newY * 1000) / 1000));

      setLiveInfo(`X: ${Math.round((newX - 0.5) * 200)}% · Y: ${Math.round((newY - 0.5) * 200)}%`);

      if (hasKf) {
        useEditor.getState().addKeyframe(clip.id, relTime, { x: newX, y: newY });
      } else {
        useEditor.getState().updateClip(clip.id, { x: newX, y: newY });
      }
    };

    const onUp = () => {
      useEditor.getState().endGesture();
      setActiveAction(null);
      setLiveInfo('');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleScaleDown = (e: React.PointerEvent) => {
    if (isLocked) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const s = useEditor.getState();
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect) return;

    s.beginGesture();
    setActiveAction('scale');

    const centerScreenX = rect.left + cx;
    const centerScreenY = rect.top + cy;

    const startDist = Math.hypot(e.clientX - centerScreenX, e.clientY - centerScreenY);
    const safeStartDist = Math.max(startDist, 10);
    const initScale = tf.scale;
    const hasKf = Boolean(clip.keyframes && clip.keyframes.length > 0);
    const relTime = Math.max(0, Math.min(clipDuration(clip), s.playhead - clip.start));

    const onMove = (ev: PointerEvent) => {
      const currentDist = Math.hypot(ev.clientX - centerScreenX, ev.clientY - centerScreenY);
      const ratio = currentDist / safeStartDist;
      let newScale = Math.max(0.05, Math.min(5.0, Math.round(initScale * ratio * 100) / 100));

      if (Math.abs(newScale - 1.0) < 0.02) {
        newScale = 1.0;
      }

      setLiveInfo(`${Math.round(newScale * 100)}%`);

      if (hasKf) {
        useEditor.getState().addKeyframe(clip.id, relTime, { scale: newScale });
      } else {
        useEditor.getState().updateClip(clip.id, { scale: newScale });
      }
    };

    const onUp = () => {
      useEditor.getState().endGesture();
      setActiveAction(null);
      setLiveInfo('');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleRotateDown = (e: React.PointerEvent) => {
    if (isLocked) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const s = useEditor.getState();
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect) return;

    s.beginGesture();
    setActiveAction('rotate');

    const centerScreenX = rect.left + cx;
    const centerScreenY = rect.top + cy;

    const startAngle = Math.atan2(e.clientY - centerScreenY, e.clientX - centerScreenX);
    const initRotation = tf.rotation;
    const hasKf = Boolean(clip.keyframes && clip.keyframes.length > 0);
    const relTime = Math.max(0, Math.min(clipDuration(clip), s.playhead - clip.start));

    const onMove = (ev: PointerEvent) => {
      const curAngle = Math.atan2(ev.clientY - centerScreenY, ev.clientX - centerScreenX);
      let deltaDeg = (curAngle - startAngle) * (180 / Math.PI);
      let newRot = Math.round(initRotation + deltaDeg);

      if (ev.shiftKey) {
        newRot = Math.round(newRot / 15) * 15;
      } else {
        const snapPoints = [0, 90, 180, -90, -180, 270, 360];
        for (const sp of snapPoints) {
          if (Math.abs(newRot - sp) <= 2) {
            newRot = sp;
            break;
          }
        }
      }

      while (newRot > 180) newRot -= 360;
      while (newRot < -180) newRot += 360;

      setLiveInfo(`${newRot}°`);

      if (hasKf) {
        useEditor.getState().addKeyframe(clip.id, relTime, { rotation: newRot });
      } else {
        useEditor.getState().updateClip(clip.id, { rotation: newRot });
      }
    };

    const onUp = () => {
      useEditor.getState().endGesture();
      setActiveAction(null);
      setLiveInfo('');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const badgeText = liveInfo || `${Math.round(tf.scale * 100)}%`;
  const isRotating = activeAction === 'rotate';

  return (
    <div
      className="video-transform-box"
      style={{
        left: `${cx}px`,
        top: `${cy}px`,
        width: `${Math.max(16, boxW)}px`,
        height: `${Math.max(16, boxH)}px`,
        transform: `translate(-50%, -50%) rotate(${rot}deg)`,
        transformOrigin: 'center center'
      }}
    >
      <div
        className="transform-drag-surface"
        onPointerDown={handleMoveDown}
        title={isLocked ? 'Түгжигдсэн зам' : 'Чирч зөөх (Move)'}
      />

      {!isLocked && (
        <>
          <div
            className="transform-handle handle-nw"
            onPointerDown={handleScaleDown}
            title="Хэмжээ өөрчлөх (Resize / Scale)"
          />
          <div
            className="transform-handle handle-ne"
            onPointerDown={handleScaleDown}
            title="Хэмжээ өөрчлөх (Resize / Scale)"
          />
          <div
            className="transform-handle handle-se"
            onPointerDown={handleScaleDown}
            title="Хэмжээ өөрчлөх (Resize / Scale)"
          />
          <div
            className="transform-handle handle-sw"
            onPointerDown={handleScaleDown}
            title="Хэмжээ өөрчлөх (Resize / Scale)"
          />

          <div className="transform-rot-stem" />
          <div
            className="transform-rot-handle"
            onPointerDown={handleRotateDown}
            title="Эргүүлэх (Rotate - Shift дарвал 15° алхамаар)"
          />
        </>
      )}

      <div
        className="transform-badge"
        style={{
          top: isRotating ? '-60px' : undefined,
          bottom: !isRotating ? '-32px' : undefined
        }}
      >
        {isLocked ? 'Түгжигдсэн 🔒' : badgeText}
      </div>
    </div>
  );
}

export default function Preview() {
  const clips = useEditor((s) => s.clips);
  const tracks = useEditor((s) => s.tracks);
  const media = useEditor((s) => s.media);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.isPlaying);
  const settings = useEditor((s) => s.projectSettings);
  const selected = useEditor((s) => s.selectedClipId);
  const duration = useEditor((s) => s.duration());
  const playerExpanded = useEditor((s) => s.playerExpanded);
  const togglePlayerExpanded = useEditor((s) => s.togglePlayerExpanded);

  const stageRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLElement>(null);

  const [baseSize, setBaseSize] = useState({ w: 0, h: 0 });
  const [zoomMode, setZoomMode] = useState<'fit' | number>('fit');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const [previewError, setPreviewError] = useState('');

  const ratio = settings.width / settings.height;

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const resize = () => {
      const w = Math.min(Math.max(0, el.clientWidth - 36), Math.max(0, el.clientHeight - 32) * ratio);
      setBaseSize({ w, h: w / ratio });
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    return () => ro.disconnect();
  }, [ratio, playerExpanded]);

  // If fit, use baseSize. If numeric zoom, scale relative to 100% (settings.width/height)
  const currentSize = useMemo(() => {
    if (zoomMode === 'fit') {
      return baseSize;
    }
    const w = Math.max(160, Math.round(settings.width * zoomMode));
    const h = Math.max(90, Math.round(settings.height * zoomMode));
    return { w, h };
  }, [zoomMode, baseSize, settings.width, settings.height]);

  const masterMediaRef = useRef<{ element: HTMLAudioElement; clip: Clip } | null>(null);

  const registerMaster = useCallback((el: HTMLAudioElement | null, clip: Clip) => {
    if (el) {
      if (!masterMediaRef.current || clip.type === 'audio') {
        masterMediaRef.current = { element: el, clip };
      }
    } else {
      if (masterMediaRef.current?.clip.id === clip.id) {
        masterMediaRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0, last = performance.now();
    const tick = (now: number) => {
      const s = useEditor.getState();
      const master = masterMediaRef.current;

      let next: number;
      if (
        master &&
        master.element &&
        !master.element.seeking &&
        master.element.readyState >= 2 &&
        !master.element.paused
      ) {
        // Master Audio Clock: Playhead is strictly locked to audio hardware output (0ms lag)
        const masterTime = master.clip.start + (master.element.currentTime - master.clip.inPoint);
        if (Number.isFinite(masterTime) && masterTime >= 0) {
          next = masterTime;
        } else {
          next = s.playhead + (now - last) / 1000;
        }
      } else {
        next = s.playhead + (now - last) / 1000;
      }
      last = now;

      if (next >= s.duration()) {
        s.setPlayhead(s.duration());
        s.setPlaying(false);
        return;
      }
      s.setPlayhead(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const active = clips.filter((c) => playhead >= c.start - 0.005 && playhead < clipEnd(c) + 0.005);
  const layers = tracks
    .filter((t) => t.kind === 'video' && !t.hidden)
    .sort((a, b) => getVideoTrackLevel(a.id, tracks) - getVideoTrackLevel(b.id, tracks))
    .flatMap((t) => {
      const trackClips = clips
        .filter((c) => c.kind === 'av' && c.trackId === t.id)
        .sort((a, b) => a.start - b.start);

      // Find clip at playhead with generous boundary tolerance (0.008s) to prevent 1-frame floating-point voids
      let activeClip = trackClips.find((c) => playhead >= c.start - 0.008 && playhead < clipEnd(c) + 0.008);

      // If playhead fell into a sub-frame gap between adjacent clips (< 0.1s), bridge it to the closest clip
      if (!activeClip) {
        activeClip = trackClips.find((c, i) => {
          const next = trackClips[i + 1];
          return next && playhead >= clipEnd(c) && playhead < next.start && (next.start - clipEnd(c)) < 0.1;
        });
      }
      if (!activeClip) return [];

      const m = media.find((item) => item.id === activeClip.mediaId);
      if (!m) return [];

      const activeIdx = trackClips.indexOf(activeClip);
      const prevClip = activeIdx > 0 ? trackClips[activeIdx - 1] : null;
      const pm = prevClip ? media.find((item) => item.id === prevClip.mediaId) : null;
      const nextClip = activeIdx >= 0 && activeIdx < trackClips.length - 1 ? trackClips[activeIdx + 1] : null;
      const nm = nextClip ? media.find((item) => item.id === nextClip.mediaId) : null;

      // Single persistent player per track & media file:
      // When clips belong to the same video file (as in cuts, splits, auto-sync),
      // the key is IDENTICAL. React NEVER unmounts the video element!
      const baseKey = `${t.id}-${m.path}`;
      const trackLevel = getVideoTrackLevel(t.id, tracks);

      const base = {
        key: baseKey,
        clip: activeClip,
        media: m,
        time: playhead,
        playing,
        transitionStyle: { zIndex: trackLevel } as React.CSSProperties,
        isHeld: false
      };

      const result = [base];

      if (prevClip && pm && Math.abs(clipEnd(prevClip) - activeClip.start) < 0.15) {
        const hasTransition = prevClip.transitionId && prevClip.transitionId !== 'none';
        const isDifferentMedia = pm.path !== m.path;
        const isJumpCut = Math.abs(prevClip.outPoint - activeClip.inPoint) > 0.05;

        if (hasTransition) {
          const td = Math.min(prevClip.transitionDuration || 0.6, clipDuration(prevClip) * 0.9, clipDuration(activeClip) * 0.9);
          if (td >= 0.04 && playhead < activeClip.start + td) {
            const p = Math.max(0, (playhead - activeClip.start) / td);
            const before: React.CSSProperties = { zIndex: 1 };
            const after: React.CSSProperties = { zIndex: 2 };
            switch (prevClip.transitionId) {
              case 'wipeleft': after.clipPath = `inset(0 0 0 ${(1 - p) * 100}%)`; break;
              case 'wiperight': after.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`; break;
              case 'slideup': after.transform = `translateY(${(1 - p) * 100}%)`; before.transform = `translateY(${-p * 100}%)`; break;
              case 'slidedown': after.transform = `translateY(${-(1 - p) * 100}%)`; before.transform = `translateY(${p * 100}%)`; break;
              case 'circleopen': after.clipPath = `circle(${p * 72}% at 50% 50%)`; break;
              case 'fadeblack': before.opacity = Math.max(0, 1 - p * 2); after.opacity = Math.max(0, p * 2 - 1); break;
              default: after.opacity = p;
            }
            base.transitionStyle = after;
            result.unshift({
              key: `${t.id}-${pm.path}-transition-${prevClip.id}`,
              clip: prevClip,
              media: pm,
              time: clipEnd(prevClip) - 1 / settings.fps,
              playing: false,
              transitionStyle: before,
              isHeld: true
            });
          }
        } else if ((isDifferentMedia || isJumpCut) && playhead >= activeClip.start && playhead < activeClip.start + 0.45) {
          // Hold outgoing frame underneath active clip during cuts / transitions between freeze frame and video
          // to prevent black frame while video element decodes.
          result.unshift({
            key: `${t.id}-${pm.path}-held-${prevClip.id}`,
            clip: prevClip,
            media: pm,
            time: clipEnd(prevClip) - 1 / settings.fps,
            playing: false,
            transitionStyle: { zIndex: 1 },
            isHeld: true
          });
        }
      }

      // Preload upcoming media to eliminate decode/mount delay when transitioning to next clip
      if (nextClip && nm && nm.path !== m.path && playhead >= nextClip.start - 2.5 && playhead < nextClip.start) {
        result.push({
          key: `${t.id}-${nm.path}`,
          clip: nextClip,
          media: nm,
          time: nextClip.start,
          playing: false,
          transitionStyle: {
            zIndex: 0,
            opacity: 0,
            pointerEvents: 'none',
            position: 'absolute',
            inset: 0
          } as React.CSSProperties,
          isHeld: true
        });
      }

      return result;
    });

  const overlays = tracks.filter((t) => t.kind === 'overlay' && !t.hidden).flatMap((t) => active.filter((c) => c.trackId === t.id));
  const audio = active.filter((c) => c.kind === 'av' && tracks.some((t) => t.id === c.trackId && !t.muted && (t.kind === 'audio' || (t.kind === 'video' && !t.hidden))));

  const seek = (time: number) => {
    useEditor.getState().setPlaying(false);
    useEditor.getState().setPlayhead(time);
  };

  const toggle = () => {
    const s = useEditor.getState();
    if (!s.duration()) return;
    if (s.playhead >= s.duration()) s.setPlayhead(0);
    s.setPlaying(!s.isPlaying);
  };

  const drag = (e: React.PointerEvent, c: Clip) => {
    e.stopPropagation();
    const s = useEditor.getState();
    s.select(c.id);
    if (tracks.find((t) => t.id === c.trackId)?.locked) return;
    const box = innerRef.current?.getBoundingClientRect();
    if (!box) return;
    s.beginGesture();
    const x = e.clientX, y = e.clientY;
    const initialTf = interpolateClipKeyframes(c, s.playhead);
    const initialX = initialTf.x;
    const initialY = initialTf.y;
    const hasKf = Boolean(c.keyframes && c.keyframes.length > 0);
    const relTime = Math.max(0, Math.min(clipDuration(c), s.playhead - c.start));

    const move = (ev: PointerEvent) => {
      const newX = Math.min(1, Math.max(0, initialX + (ev.clientX - x) / box.width));
      const newY = Math.min(1, Math.max(0, initialY + (ev.clientY - y) / box.height));
      if (hasKf) {
        useEditor.getState().addKeyframe(c.id, relTime, { x: newX, y: newY });
      } else {
        useEditor.getState().updateClip(c.id, { x: newX, y: newY });
      }
    };
    const up = () => {
      useEditor.getState().endGesture();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const selectedClip = useMemo(() => clips.find((c) => c.id === selected), [clips, selected]);
  const selectedMedia = useMemo(() => {
    if (!selectedClip || selectedClip.kind !== 'av') return null;
    return media.find((m) => m.id === selectedClip.mediaId) ?? null;
  }, [selectedClip, media]);
  const isSelectedActive = selectedClip
    ? playhead >= selectedClip.start - 0.01 && playhead < clipEnd(selectedClip) + 0.01
    : false;
  const isSelectedTrackLocked = selectedClip
    ? Boolean(tracks.find((t) => t.id === selectedClip.trackId)?.locked)
    : false;

  const handleStagePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    const target = e.target as HTMLElement;
    if (target.closest('.video-transform-box') || target.closest('.overlay-item')) return;
    useEditor.getState().select(null);
    if (zoomMode !== 'fit') {
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  };

  const handleStagePointerMove = (e: React.PointerEvent) => {
    if (!isPanning) return;
    setPan({
      x: panStartRef.current.panX + (e.clientX - panStartRef.current.x),
      y: panStartRef.current.panY + (e.clientY - panStartRef.current.y)
    });
  };

  const handleStagePointerUp = (e: React.PointerEvent) => {
    if (isPanning) {
      setIsPanning(false);
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    setZoomMode((prev) => {
      const fitRatio = baseSize.w > 0 && settings.width > 0 ? (baseSize.w / settings.width) : 0.2;
      const current = prev === 'fit' ? fitRatio : prev;
      const next = Math.min(3.5, Math.max(0.15, current * factor));
      if (Math.abs(next - fitRatio) / fitRatio < 0.05) return 'fit';
      return Math.round(next * 100) / 100;
    });
  };

  return (
    <section className="preview" ref={previewRef}>
      <div className="player-head">
        <span>Player</span>
        <div className="player-head-right">
          <button
            className={'expand-btn' + (playerExpanded ? ' active' : '')}
            onClick={togglePlayerExpanded}
            title={playerExpanded ? 'Хэвийн харагдац руу буцах (3 багана)' : 'Тоглуулагчийг дэлгэц дүүрэн тэлэх (Хажуугийн самбаруудыг нуух)'}
          >
            <Icon name={playerExpanded ? 'collapse' : 'expand'} />
            <span>{playerExpanded ? 'Хураах' : 'Тэлэх'}</span>
          </button>
          <span className="player-quality">{settings.height}p <span>·</span> {settings.fps} fps</span>
        </div>
      </div>

      <div
        className={'stage' + (zoomMode !== 'fit' ? ' can-pan' : '') + (isPanning ? ' panning' : '')}
        ref={stageRef}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={handleStagePointerUp}
        onWheel={handleWheel}
        onDoubleClick={() => { setZoomMode('fit'); setPan({ x: 0, y: 0 }); }}
      >
        <div
          className="stage-viewport"
          style={{
            transform: zoomMode === 'fit' ? 'none' : `translate(${pan.x}px, ${pan.y}px)`,
            transition: isPanning ? 'none' : 'transform 0.05s ease-out'
          }}
        >
          <div
            className="stage-inner"
            ref={innerRef}
            style={{ width: currentSize.w, height: currentSize.h, aspectRatio: ratio }}
            onClick={(e) => {
              if (e.target === innerRef.current) {
                useEditor.getState().select(null);
              }
            }}
          >
            {layers.map(({ key, ...layer }) => <VideoLayer key={key} {...layer} />)}
            {!clips.length && (
              <div className="stage-empty"><Icon name="media" /><span>Your video preview</span></div>
            )}
            {overlays.map((c) => (
              <Overlay
                key={c.id}
                clip={c}
                scale={currentSize.h / REF_H}
                selected={selected === c.id}
                onDrag={drag}
                time={playhead}
              />
            ))}
            {selectedClip && selectedMedia && isSelectedActive && (
              <VideoTransformBox
                clip={selectedClip}
                media={selectedMedia}
                stageWidth={currentSize.w}
                stageHeight={currentSize.h}
                projectWidth={settings.width}
                projectHeight={settings.height}
                playhead={playhead}
                innerRef={innerRef}
                isLocked={isSelectedTrackLocked}
              />
            )}
          </div>
        </div>
      </div>

      {audio.map((c) => {
        const m = media.find((m) => m.id === c.mediaId);
        return m?.hasAudio ? (
          <AudioLayer
            key={c.id}
            clip={c}
            media={m}
            time={playhead}
            playing={playing}
            volume={c.volume ?? 1}
            registerMaster={registerMaster}
          />
        ) : null;
      })}

      {previewError && <div className="preview-error" onClick={() => setPreviewError('')}>{previewError}</div>}

      <div className="transport">
        <div className="time-readout"><b>{formatTime(playhead, true)}</b><span> / {formatTime(duration, true)}</span></div>

        <div className="transport-center">
          <button className="icon-btn" title="Previous frame" onClick={() => seek(Math.max(0, playhead - 1 / settings.fps))}><Icon name="skipBack" /></button>
          <button className="icon-btn play" title={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={!duration} onClick={toggle}><Icon name={playing ? 'pause' : 'play'} filled={!playing} /></button>
          <button className="icon-btn" title="Next frame" onClick={() => seek(Math.min(duration, playhead + 1 / settings.fps))}><Icon name="skipFwd" /></button>
        </div>

        <div className="player-display">
          <select
            aria-label="Preview zoom level"
            className="zoom-select"
            value={typeof zoomMode === 'number' ? String(zoomMode) : 'fit'}
            onChange={(e) => {
              const val = e.target.value;
              if (val === 'fit') {
                setZoomMode('fit');
                setPan({ x: 0, y: 0 });
              } else {
                setZoomMode(Number(val));
              }
            }}
            title="Тоглуулагч томруулах (Preview Zoom)"
          >
            <option value="fit">Fit (Авто)</option>
            <option value="0.5">50%</option>
            <option value="0.75">75%</option>
            <option value="1">100% (HD 1:1)</option>
            <option value="1.5">150%</option>
            <option value="2">200% (2x)</option>
            {typeof zoomMode === 'number' && ![0.5, 0.75, 1, 1.5, 2].includes(zoomMode) && (
              <option value={zoomMode}>{Math.round(zoomMode * 100)}%</option>
            )}
          </select>

          <select
            aria-label="Canvas aspect ratio"
            value={settings.width + ':' + settings.height}
            onChange={(e) => {
              const [width, height] = e.target.value.split(':').map(Number);
              useEditor.getState().setProjectSettings({ width, height });
            }}
            title="Дэлгэцийн харьцаа (Aspect Ratio)"
          >
            <option value="1920:1080">16:9 (YouTube)</option>
            <option value="1080:1920">9:16 (Shorts/TikTok)</option>
            <option value="1080:1080">1:1 (Дөрвөлжин)</option>
            <option value="1440:1080">4:3 (Сонгодог)</option>
            {!['1920:1080', '1080:1920', '1080:1080', '1440:1080'].includes(settings.width + ':' + settings.height) && (
              <option value={settings.width + ':' + settings.height}>Custom</option>
            )}
          </select>

          <button
            className="icon-btn"
            title="Бүтэн дэлгэцээр үзэх (Fullscreen)"
            onClick={() => {
              const p = document.fullscreenElement ? document.exitFullscreen() : previewRef.current?.requestFullscreen();
              void p?.catch((e) => setPreviewError(e.message));
            }}
          >
            <Icon name="fit" />
          </button>
        </div>
      </div>
    </section>
  );
}

