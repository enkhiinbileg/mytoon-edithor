import { useEditor } from './store';
import type { Clip, MediaItem } from './types';

const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * 1-Click Seamless Voice Sync:
 * Automatically matches the silent video footage on Video 1 track
 * to the speech narration on Audio 1 track without any intrusive modal dialogs.
 */
export async function runAutoSyncVoice(
  showNotice: (msg: string) => void,
  options: { forceVision?: boolean } = {}
): Promise<boolean> {
  const state = useEditor.getState();

  // 1. Identify or ensure video and audio tracks
  let vTrack = state.tracks.find((t) => t.kind === 'video');
  let aTrack = state.tracks.find((t) => t.kind === 'audio');

  if (!vTrack) {
    vTrack = state.ensureTrack('video');
  }
  if (!aTrack) {
    aTrack = state.ensureTrack('audio');
  }

  // 2. Identify target video and audio clips intelligently
  const curPlayhead = state.playhead;
  const videoClips = state.clips.filter((c) => c.trackId === vTrack!.id && c.kind === 'av').sort((a, b) => a.start - b.start);
  const audioClips = state.clips.filter((c) => c.trackId === aTrack!.id && c.kind === 'av').sort((a, b) => a.start - b.start);

  // If a clip is selected on a video or audio track, prioritize it
  let vClip = state.selectedClipId ? videoClips.find((c) => c.id === state.selectedClipId) : null;
  let aClip = state.selectedClipId ? audioClips.find((c) => c.id === state.selectedClipId) : null;

  // Next priority: clip under current playhead position
  if (!vClip) {
    vClip = videoClips.find((c) => curPlayhead >= c.start && curPlayhead < (c.start + c.outPoint - c.inPoint));
  }
  if (!aClip) {
    aClip = audioClips.find((c) => curPlayhead >= c.start && curPlayhead < (c.start + c.outPoint - c.inPoint));
  }

  // Next priority: first clip chronologically
  if (!vClip && videoClips.length > 0) vClip = videoClips[0];
  if (!aClip && audioClips.length > 0) aClip = audioClips[0];

  // 3. Smart fallback: if timeline has no clip yet, but files are imported in media panel
  if (!vClip) {
    const vMediaItem = state.media.find((m) => m.kind === 'video');
    if (vMediaItem) {
      state.addMediaToTimeline(vMediaItem.id, vTrack.id, 0);
      vClip = useEditor.getState().clips.find((c) => c.mediaId === vMediaItem.id && c.trackId === vTrack!.id);
    }
  }

  if (!aClip) {
    const aMediaItem = state.media.find((m) => m.kind === 'audio');
    if (aMediaItem) {
      state.addMediaToTimeline(aMediaItem.id, aTrack.id, 0);
      aClip = useEditor.getState().clips.find((c) => c.mediaId === aMediaItem.id && c.trackId === aTrack!.id);
    }
  }

  if (!vClip && !aClip) {
    showNotice('⚠️ Эхлээд Video 1 болон Audio 1 зам дээр бичлэг, voice-оо чирч тавина уу.');
    return false;
  }
  if (!vClip) {
    showNotice('⚠️ Video 1 зам дээр бичлэгээ оруулна уу.');
    return false;
  }
  if (!aClip) {
    showNotice('⚠️ Audio 1 зам дээр voice-оо оруулна уу.');
    return false;
  }

  const curState = useEditor.getState();
  const vMedia = curState.media.find((m) => m.id === vClip!.mediaId);
  const aMedia = curState.media.find((m) => m.id === aClip!.mediaId);

  if (!vMedia?.path || !aMedia?.path) {
    showNotice('⚠️ Сонгосон файлуудын байршил олдсонгүй.');
    return false;
  }

  const sourceOffset = vClip.inPoint || 0;
  const aInPoint = aClip.inPoint || 0;
  const aDuration = Math.max(0.5, (aClip.outPoint || aMedia.duration) - aInPoint);
  const aStart = aClip.start;
  const targetVideoTrackId = vClip.trackId;
  const rawClipId = vClip.id;

  // IMPORTANT: Capture base other clips ONCE at start so chunk updates never exponentially duplicate clips!
  // Any clips on targetVideoTrackId that overlap with [aStart, aStart + aDuration] are replaced.
  const initialClips = curState.clips;
  const baseOtherClips = initialClips.filter((c) => {
    if (c.id === rawClipId || c.id === 'temp-raw-remainder') return false;
    if (c.trackId === targetVideoTrackId) {
      const cDuration = c.outPoint - c.inPoint;
      const cEnd = c.start + cDuration;
      if (c.start < aStart + aDuration - 0.01 && cEnd > aStart + 0.01) {
        return false;
      }
    }
    return true;
  });

  const allAddedClips: Clip[] = [];
  const processedCutIds = new Set<number>();

  // Helper to convert cuts into timeline clips and update timeline in real-time
  const applyCutsToTimeline = (cuts: any[], nextSourceOffset?: number) => {
    const newClips: Clip[] = [];
    const newFreezeMediaItems: MediaItem[] = [];

    for (const c of cuts) {
      if (processedCutIds.has(c.id)) continue;
      processedCutIds.add(c.id);

      let mediaId = vMedia.id;
      let inPoint = c.sourceStart;
      let outPoint = c.sourceStart + (c.targetEnd - c.targetStart);

      if (c.freeze && c.freezeImagePath) {
        const freezeMediaId = `freeze-${uid()}`;
        const freezeMedia: MediaItem = {
          id: freezeMediaId,
          name: c.text ? c.text.slice(0, 32) : (c.reason ? c.reason.slice(0, 32) : `Freeze @ ${Math.floor(c.sourceStart)}s`),
          path: c.freezeImagePath,
          kind: 'image',
          duration: 3600,
          width: vMedia.width || 1920,
          height: vMedia.height || 1080,
          fps: vMedia.fps || 30,
          hasAudio: false,
          thumbs: [window.api.toMediaUrl ? window.api.toMediaUrl(c.freezeImagePath) : c.freezeImagePath],
          isInternal: true
        };
        newFreezeMediaItems.push(freezeMedia);
        mediaId = freezeMediaId;
        inPoint = 0;
        outPoint = c.duration;
      }

      newClips.push({
        id: uid(),
        kind: 'av',
        mediaId,
        trackId: targetVideoTrackId,
        start: aStart + c.targetStart,
        inPoint,
        outPoint,
        label: c.reason || c.text || undefined,
        filterId: 'none',
        effectId: 'none',
        transitionId: 'none',
        volume: 0,
        opacity: 1
      });
    }

    if (!newClips.length) return;
    allAddedClips.push(...newClips);

    const editor = useEditor.getState();
    const updatedMedia = newFreezeMediaItems.length > 0 ? [...editor.media, ...newFreezeMediaItems] : editor.media;

    // Build temporary remaining footage if not all audio is covered yet
    const lastCut = cuts[cuts.length - 1];
    const coveredDuration = lastCut ? lastCut.targetEnd : 0;
    const remainingClips: Clip[] = [];
    const nextSource = nextSourceOffset ?? (sourceOffset + coveredDuration);

    if (vMedia.duration > nextSource + 1 && coveredDuration < aDuration) {
      remainingClips.push({
        id: 'temp-raw-remainder',
        kind: 'av',
        mediaId: vMedia.id,
        trackId: targetVideoTrackId,
        start: aStart + coveredDuration,
        inPoint: nextSource,
        outPoint: vMedia.duration,
        filterId: 'none',
        effectId: 'none',
        transitionId: 'none',
        volume: 0,
        opacity: 1
      });
    }

    useEditor.setState({
      media: updatedMedia,
      clips: [...baseOtherClips, ...allAddedClips, ...remainingClips],
      selectedClipId: allAddedClips[0]?.id || null
    });
  };

  // Subscribe to progressive chunk stream!
  const unsub = window.api.onVoiceEditProgress?.((p: any) => {
    if (p?.type === 'chunk' && Array.isArray(p.cuts) && p.cuts.length) {
      applyCutsToTimeline(p.cuts, p.nextSourceOffset);
    }
  });

  curState.beginGesture();

  let res: any = null;
  try {
    res = await window.api.syncTimelineVoice({
      videoPath: vMedia.path,
      voicePath: aMedia.path,
      sourceOffset,
      voiceOffset: aInPoint,
      voiceDuration: aDuration,
      style: 'dynamic',
      method: 'auto',
      mode: 'hybrid',
      useVision: options.forceVision === true
    });
  } finally {
    unsub?.();
  }

  if (!res?.ok || (!res.cuts?.length && !allAddedClips.length)) {
    showNotice(res?.error ? `⚠️ Алдаа: ${res.error}` : '⚠️ Дүрс болон voice-ийг тааруулж чадсангүй.');
    curState.endGesture();
    return false;
  }

  // If any cuts weren't streamed in chunks, apply them now as fallback
  if (res.cuts?.length) {
    applyCutsToTimeline(res.cuts, res.nextSourceOffset);
  }

  // Finalize remainder without the temporary id
  const nextSource = res.nextSourceOffset ?? (sourceOffset + aDuration);
  const finalRemainder: Clip[] = [];
  if (vMedia.duration > nextSource + 1) {
    finalRemainder.push({
      id: uid(),
      kind: 'av',
      mediaId: vMedia.id,
      trackId: targetVideoTrackId,
      start: aStart + aDuration,
      inPoint: nextSource,
      outPoint: vMedia.duration,
      filterId: 'none',
      effectId: 'none',
      transitionId: 'none',
      volume: 0,
      opacity: 1
    });
  }

  useEditor.setState({
    clips: [...baseOtherClips, ...allAddedClips, ...finalRemainder],
    selectedClipId: allAddedClips[0]?.id || null,
    playhead: aStart
  });

  curState.endGesture();

  const freezeCount = allAddedClips.filter((c) => {
    const m = editor.media.find((item) => item.id === c.mediaId);
    return m?.kind === 'image';
  }).length;
  const motionCount = allAddedClips.length - freezeCount;

  let successMsg = `✨ Амжилттай: Нийт ${allAddedClips.length} хэсэг (${motionCount} хөдөлгөөнт видео, ${freezeCount} царцаасан кадр) voice ярианд 100% яв цав таарлаа!`;
  if (res.visionAIUsed) {
    successMsg = `✨ Vision AI: ${allAddedClips.length} үзэгдлийг (${motionCount} хөдөлгөөн, ${freezeCount} freeze) ярианд яв цав таарууллаа!`;
  } else if (res.visionError) {
    successMsg = `⚠️ Vision AI (${res.visionError}) алдаа гарсан тул ярианы хэмнэлээр амжилттай эвлүүллээ (${motionCount} хөдөлгөөн, ${freezeCount} freeze).`;
  }
  showNotice(successMsg);
  return true;
}
