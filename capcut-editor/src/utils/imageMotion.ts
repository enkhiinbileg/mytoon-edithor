import { useEditor } from '../store';
import { importPaths } from '../importMedia';
import type { Clip, ImagePlanRow, Track, ImagePanelItem } from '../types';

const uid = () => Math.random().toString(36).slice(2, 10);

export interface InstantPlanOptions {
  subtitles: { id: string; start: number; end: number; text: string }[];
  panels: ImagePanelItem[];
  audioDuration: number;
  aspect?: '16:9' | '9:16';
  distribution?: 'spread' | 'sequential';
  motionPreset?: 'variety' | 'action' | 'scroll' | 'static';
}

/**
 * Creates an instantaneous continuous story plan mapping panels to subtitles in 0ms!
 * Zero black frames, gap-free, smooth Ken Burns keyframes.
 */
export function createInstantImagePlan({
  subtitles,
  panels,
  audioDuration,
  aspect = '16:9',
  distribution = 'spread',
  motionPreset = 'variety'
}: InstantPlanOptions): ImagePlanRow[] {
  if (!panels || !panels.length || !subtitles || !subtitles.length) return [];

  const panelCount = panels.length;
  const sortedSubs = [...subtitles]
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start);

  const subCount = sortedSubs.length;
  const plan: ImagePlanRow[] = [];

  for (let i = 0; i < subCount; i++) {
    const sub = sortedSubs[i];
    let pIdx = 0;
    if (distribution === 'spread') {
      pIdx = Math.min(panelCount - 1, Math.floor(i * (panelCount / subCount)));
    } else {
      pIdx = Math.min(panelCount - 1, i);
    }
    const panel = panels[pIdx] || panels[0];

    // Gapless continuous timing:
    // First clip starts at 0.0s; subsequent clips start exactly where previous ended
    const clipStart = i === 0 ? 0 : plan[i - 1].end;
    let clipEnd: number;
    if (i < subCount - 1) {
      clipEnd = Math.max(clipStart + 0.2, sortedSubs[i + 1].start);
    } else {
      clipEnd = Math.max(clipStart + 0.2, sub.end, audioDuration || sub.end);
    }
    const duration = Math.max(0.2, clipEnd - clipStart);

    // Motion selection
    let motion: ImagePlanRow['motion'] = 'zoom_in';
    if (motionPreset === 'action') motion = 'zoom_in';
    else if (motionPreset === 'scroll') motion = 'pan_down';
    else if (motionPreset === 'static') motion = 'static';
    else {
      // 'variety'
      const varietyList: ImagePlanRow['motion'][] = ['zoom_in', 'pan_down', 'zoom_out'];
      motion = varietyList[i % varietyList.length];
    }

    // Keyframes
    let kfs = [{ id: uid(), time: 0, scale: 1.0, x: 0.5, y: 0.5 }];
    if (motion === 'zoom_in') {
      kfs = [
        { id: uid(), time: 0, scale: 1.0, x: 0.5, y: 0.5 },
        { id: uid(), time: duration, scale: 1.18, x: 0.5, y: 0.5 }
      ];
    } else if (motion === 'zoom_out') {
      kfs = [
        { id: uid(), time: 0, scale: 1.18, x: 0.5, y: 0.5 },
        { id: uid(), time: duration, scale: 1.0, x: 0.5, y: 0.5 }
      ];
    } else if (motion === 'pan_down') {
      kfs = [
        { id: uid(), time: 0, scale: 1.12, x: 0.5, y: 0.38 },
        { id: uid(), time: duration, scale: 1.12, x: 0.5, y: 0.62 }
      ];
    }

    plan.push({
      id: uid(),
      subtitleId: sub.id,
      start: clipStart,
      end: clipEnd,
      duration,
      text: sub.text || '',
      panelId: panel.id,
      imagePath: panel.path,
      imageWidth: panel.width,
      imageHeight: panel.height,
      imageName: panel.name,
      motion,
      aspect,
      confidence: 1.0,
      keyframes: kfs
    });
  }

  return plan;
}

export interface ApplyImagePlanOptions {
  audioPath?: string;
  audioDuration?: number;
  plan: ImagePlanRow[];
  aspectRatio: '16:9' | '9:16';
  fitMode?: 'contain' | 'cover';
  addCaptions?: boolean;
}

/**
 * Applies the generated Image plan directly to the CapCut timeline.
 * Intelligently preserves existing audio and captions already placed on the timeline!
 */
export async function applyImagePlanToTimeline({
  audioPath,
  audioDuration,
  plan,
  aspectRatio,
  fitMode = 'contain',
  addCaptions = false
}: ApplyImagePlanOptions): Promise<boolean> {
  const store = useEditor.getState();

  // 1. Configure project aspect ratio resolution if needed
  const width = aspectRatio === '9:16' ? 1080 : 1920;
  const height = aspectRatio === '9:16' ? 1920 : 1080;
  store.setProjectSettings({
    width,
    height,
    fps: 30
  });

  // 2. Import unique Image Media
  const uniqueImagePaths = Array.from(new Set(plan.map((r) => r.imagePath)));
  const existingMediaByPath = new Map(store.media.map((m) => [m.path, m]));
  const missingPaths = uniqueImagePaths.filter((p) => !existingMediaByPath.has(p));

  if (missingPaths.length > 0) {
    const newlyImported = await importPaths(missingPaths);
    for (const m of newlyImported) {
      existingMediaByPath.set(m.path, m);
    }
  }

  // 3. Resolve Tracks
  const curTracks = useEditor.getState().tracks;
  let vTrack = curTracks.find((t) => t.kind === 'video') || store.ensureLayerTrack('video', true);
  let aTrack = curTracks.find((t) => t.kind === 'audio') || store.ensureLayerTrack('audio', true);
  let oTrack = curTracks.find((t) => t.kind === 'overlay') || store.ensureLayerTrack('overlay', true);

  const videoTrackId = vTrack.id;
  const audioTrackId = aTrack.id;
  const overlayTrackId = oTrack.id;

  // 4. Preserve existing non-video clips (keep existing audio and existing captions if present)
  const existingClips = store.clips;
  const existingAudioClips = existingClips.filter((c) => c.trackId === audioTrackId || c.kind === 'av' && curTracks.find((t) => t.id === c.trackId)?.kind === 'audio');
  const existingCaptionClips = existingClips.filter((c) => c.kind === 'text');
  
  // Other clips that are not on the target video track
  const otherClips = existingClips.filter((c) => c.trackId !== videoTrackId);

  const newClips: Clip[] = [...otherClips];

  // 5. If timeline didn't have audio, and audioPath was provided, import and add it
  if (existingAudioClips.length === 0 && audioPath) {
    let audioMedia = store.media.find((m) => m.path === audioPath);
    if (!audioMedia) {
      const imported = await importPaths([audioPath]);
      audioMedia = imported[0];
    }
    if (audioMedia) {
      newClips.push({
        id: uid(),
        kind: 'av',
        trackId: audioTrackId,
        start: 0,
        inPoint: 0,
        outPoint: audioDuration || audioMedia.duration || (plan[plan.length - 1]?.end ?? 10),
        mediaId: audioMedia.id,
        volume: 1.0,
        label: audioMedia.name || 'Voice Audio'
      });
    }
  }

  // 6. Add Image Clips onto the Video track
  for (const row of plan) {
    const media = existingMediaByPath.get(row.imagePath) || store.media.find((m) => m.path === row.imagePath);
    if (!media) continue;

    const clipDuration = Math.max(0.1, row.duration);

    // Video/Image Clip
    newClips.push({
      id: uid(),
      kind: 'av',
      trackId: videoTrackId,
      start: row.start,
      inPoint: 0,
      outPoint: clipDuration,
      mediaId: media.id,
      label: row.imageName || media.name,
      scale: 1.0,
      fitMode: fitMode || 'contain',
      keyframes: row.keyframes && row.keyframes.length > 0 ? row.keyframes : undefined
    });

    // If addCaptions is requested AND timeline had NO existing captions, generate them
    if (addCaptions && existingCaptionClips.length === 0 && row.text && row.text.trim()) {
      newClips.push({
        id: uid(),
        kind: 'text',
        trackId: overlayTrackId,
        start: row.start,
        inPoint: 0,
        outPoint: clipDuration,
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

  // Update timeline with matched clips
  useEditor.setState({
    clips: newClips,
    selectedClipId: newClips.find((c) => c.trackId === videoTrackId)?.id || newClips[0]?.id || null,
    selectedClipIds: [],
    playhead: 0,
    isPlaying: false
  });

  return true;
}
