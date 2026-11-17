import { useEditor } from '../store';
import { importPaths } from '../importMedia';
import type { Clip, Keyframe } from '../types';
import type { SafeBeat, SafeMotionType, SafePanelItem, SafePlanRow } from './types';

const uid = () => Math.random().toString(36).slice(2, 10);

export function buildSafeKeyframes(motion: SafeMotionType, duration: number, isCropped = false): Keyframe[] {
  const dur = Math.max(0.2, duration);
  const panMinY = isCropped ? 0.44 : 0.38;
  const panMaxY = isCropped ? 0.56 : 0.62;
  const panScale = isCropped ? 1.08 : 1.12;

  switch (motion) {
    case 'zoom_in':
      return [
        { id: uid(), time: 0, scale: 1.0, x: 0.5, y: 0.5 },
        { id: uid(), time: dur, scale: 1.16, x: 0.5, y: 0.5 }
      ];
    case 'zoom_out':
      return [
        { id: uid(), time: 0, scale: 1.16, x: 0.5, y: 0.5 },
        { id: uid(), time: dur, scale: 1.0, x: 0.5, y: 0.5 }
      ];
    case 'pan_down':
      return [
        { id: uid(), time: 0, scale: panScale, x: 0.5, y: panMinY },
        { id: uid(), time: dur, scale: panScale, x: 0.5, y: panMaxY }
      ];
    case 'pan_up':
      return [
        { id: uid(), time: 0, scale: panScale, x: 0.5, y: panMaxY },
        { id: uid(), time: dur, scale: panScale, x: 0.5, y: panMinY }
      ];
    case 'static':
    default:
      return [{ id: uid(), time: 0, scale: 1.0, x: 0.5, y: 0.5 }];
  }
}

export function createInstantSafePlan({
  beats,
  panels,
  audioDuration = 0,
  aspect = '16:9',
  motionPreset = 'variety'
}: {
  beats: SafeBeat[];
  panels: SafePanelItem[];
  audioDuration?: number;
  aspect?: '16:9' | '9:16';
  motionPreset?: 'variety' | 'action' | 'scroll' | 'static';
}): SafePlanRow[] {
  const safePanels = panels.filter((p) => p.safetyStatus !== 'excluded');
  if (!safePanels.length || !beats.length) return [];

  const sortedBeats = [...beats]
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end))
    .sort((a, b) => a.start - b.start);

  const plan: SafePlanRow[] = [];
  for (let i = 0; i < sortedBeats.length; i++) {
    const beat = sortedBeats[i];
    const pIdx = Math.min(safePanels.length - 1, Math.floor((i * safePanels.length) / sortedBeats.length));
    const panel = safePanels[pIdx];

    const clipStart = i === 0 ? 0 : plan[i - 1].end;
    const clipEnd =
      i < sortedBeats.length - 1
        ? Math.max(clipStart + 0.25, sortedBeats[i + 1].start)
        : Math.max(clipStart + 0.25, beat.end, audioDuration || beat.end);
    const duration = Math.max(0.25, clipEnd - clipStart);

    const isTightCrop = panel.safetyStatus === 'cropped' && Boolean(panel.cropRect && panel.cropRect.h < 0.55);
    let motion: SafeMotionType = 'zoom_in';
    if (motionPreset === 'static') motion = 'static';
    else if (motionPreset === 'action') motion = 'zoom_in';
    else if (motionPreset === 'scroll') motion = isTightCrop ? 'zoom_in' : 'pan_down';
    else {
      const variety: SafeMotionType[] = isTightCrop ? ['zoom_in', 'zoom_out'] : ['zoom_in', 'pan_down', 'zoom_out'];
      motion = variety[i % variety.length];
    }

    plan.push({
      id: uid(),
      beatId: beat.id,
      start: clipStart,
      end: clipEnd,
      duration,
      text: beat.text || '',
      panelId: panel.id,
      imagePath: panel.path,
      sanitizedPath: panel.sanitizedRenderPath || panel.sanitizedThumbPath || panel.path,
      imageWidth: panel.sanitizedWidth || panel.width,
      imageHeight: panel.sanitizedHeight || panel.height,
      imageName: panel.name,
      safetyStatus: panel.safetyStatus,
      cropRect: panel.cropRect || null,
      censorBoxes: panel.censorBoxes || [],
      needsReview: panel.needsReview,
      safetyReason: panel.safetyReason,
      isFallback: false,
      motion,
      aspect,
      confidence: 1.0,
      keyframes: buildSafeKeyframes(motion, duration, panel.safetyStatus === 'cropped')
    });
  }

  return plan;
}

export async function applySafePlanToTimeline({
  audioPath,
  audioDuration,
  plan,
  aspectRatio,
  fitMode = 'contain',
  addCaptions = true
}: {
  audioPath?: string;
  audioDuration?: number;
  plan: SafePlanRow[];
  aspectRatio: '16:9' | '9:16';
  fitMode?: 'contain' | 'cover';
  addCaptions?: boolean;
}): Promise<boolean> {
  const safeRows = plan.filter((r) => r.safetyStatus !== 'excluded');
  if (!safeRows.length) {
    throw new Error('Timeline руу оруулах аюулгүй зураг байхгүй байна.');
  }

  const store = useEditor.getState();
  const width = aspectRatio === '9:16' ? 1080 : 1920;
  const height = aspectRatio === '9:16' ? 1920 : 1080;
  store.setProjectSettings({ width, height, fps: 30 });

  // Only import the sanitized output images so uncropped/uncensored pixels never enter the timeline!
  const targetPaths = safeRows.map((r) => r.sanitizedPath || r.imagePath);
  const uniquePaths = Array.from(new Set(targetPaths));
  const mediaByPath = new Map(store.media.map((m) => [m.path, m]));
  const missing = uniquePaths.filter((p) => !mediaByPath.has(p));
  if (missing.length > 0) {
    const imported = await importPaths(missing);
    for (const m of imported) {
      mediaByPath.set(m.path, m);
    }
  }

  const curTracks = useEditor.getState().tracks;
  const vTrack = curTracks.find((t) => t.kind === 'video') || store.ensureLayerTrack('video', true);
  const aTrack = curTracks.find((t) => t.kind === 'audio') || store.ensureLayerTrack('audio', true);
  const oTrack = curTracks.find((t) => t.kind === 'overlay') || store.ensureLayerTrack('overlay', true);

  const existingClips = useEditor.getState().clips;
  const existingAudioClips = existingClips.filter(
    (c) => c.trackId === aTrack.id || (c.kind === 'av' && curTracks.find((t) => t.id === c.trackId)?.kind === 'audio')
  );
  const existingCaptions = existingClips.filter((c) => c.kind === 'text');
  const otherClips = existingClips.filter((c) => c.trackId !== vTrack.id);

  const newClips: Clip[] = [...otherClips];

  if (existingAudioClips.length === 0 && audioPath) {
    let audioMedia = useEditor.getState().media.find((m) => m.path === audioPath);
    if (!audioMedia) {
      const imported = await importPaths([audioPath]);
      audioMedia = imported[0];
    }
    if (audioMedia) {
      newClips.push({
        id: uid(),
        kind: 'av',
        trackId: aTrack.id,
        start: 0,
        inPoint: 0,
        outPoint: audioDuration || audioMedia.duration || (safeRows[safeRows.length - 1]?.end ?? 10),
        mediaId: audioMedia.id,
        volume: 1.0,
        label: audioMedia.name || 'Recap Voice'
      });
    }
  }

  for (const row of safeRows) {
    const imgPath = row.sanitizedPath || row.imagePath;
    const media = mediaByPath.get(imgPath) || useEditor.getState().media.find((m) => m.path === imgPath);
    if (!media) continue;

    const clipDur = Math.max(0.15, row.duration);
    newClips.push({
      id: uid(),
      kind: 'av',
      trackId: vTrack.id,
      start: row.start,
      inPoint: 0,
      outPoint: clipDur,
      mediaId: media.id,
      label: row.imageName || media.name,
      scale: 1.0,
      fitMode,
      keyframes: row.keyframes?.length ? row.keyframes : undefined,
      aiVerified: row.safetyStatus !== 'unchecked',
      aiReason: row.safetyReason || row.aiReason
    });

    if (addCaptions && existingCaptions.length === 0 && row.text && row.text.trim()) {
      newClips.push({
        id: uid(),
        kind: 'text',
        trackId: oTrack.id,
        start: row.start,
        inPoint: 0,
        outPoint: clipDur,
        x: 0.5,
        y: aspectRatio === '9:16' ? 0.78 : 0.85,
        style: {
          text: row.text.trim(),
          fontSize: aspectRatio === '9:16' ? 42 : 38,
          color: '#ffffff',
          bold: true,
          shadow: true,
          shadowColor: 'rgba(0, 0, 0, 0.95)',
          shadowBlur: 6,
          shadowOffsetX: 2,
          shadowOffsetY: 2,
          stroke: true,
          strokeColor: '#000000',
          strokeWidth: 4,
          background: '',
          align: 'center'
        }
      });
    }
  }

  useEditor.setState({
    clips: newClips,
    selectedClipId: newClips.find((c) => c.trackId === vTrack.id)?.id || newClips[0]?.id || null,
    selectedClipIds: [],
    playhead: 0,
    isPlaying: false,
    dirty: true
  });

  return true;
}
