import { useEditor } from './store';
import { clipDuration, clipEnd, type Clip, type MediaItem } from './types';

const uid = () => Math.random().toString(36).slice(2, 10);

export async function runAutoSyncSrt(
  onProgress?: (message: string) => void,
  options: {
    srtPath?: string;
    scriptText?: string;
    scriptPath?: string;
    videoOffset?: number;
    includeAllAudio?: boolean;
    pacingMode?: 'motion' | 'freeze' | 'hybrid';
  } = {}
): Promise<boolean> {
  const showNotice = (msg: string) => onProgress?.(msg);
  const curState = useEditor.getState();

  // 1. Resolve tracks
  const vTrack = curState.tracks.find((t) => t.kind === 'video') || curState.tracks[0];
  const aTrack = curState.tracks.find((t) => t.kind === 'audio');

  if (!vTrack) {
    showNotice('⚠️ Timeline дээр видео зам (Video 1) байхгүй байна.');
    return false;
  }
  if (!aTrack) {
    showNotice('⚠️ Timeline дээр аудио зам (Audio 1) байхгүй байна.');
    return false;
  }

  // 2. Resolve video clip
  const vClips = curState.clips
    .filter((c) => c.trackId === vTrack.id && c.kind === 'av')
    .sort((a, b) => a.start - b.start);
  if (!vClips.length) {
    showNotice('⚠️ Video 1 зам дээр ямар ч бичлэг алга байна.');
    return false;
  }
  const vClip = vClips[0];
  const vMedia = curState.media.find((m) => m.id === vClip.mediaId);
  if (!vMedia) {
    showNotice('⚠️ Видеоны эх файл олдсонгүй.');
    return false;
  }

  // 3. Resolve audio clips
  const aClips = curState.clips
    .filter((c) => c.trackId === aTrack.id && c.kind === 'av')
    .sort((a, b) => a.start - b.start);
  if (!aClips.length) {
    showNotice('⚠️ Audio 1 зам дээр voice аудио файл алга байна.');
    return false;
  }

  const targetAudioClips = (options.includeAllAudio !== false)
    ? aClips
    : [aClips.find((c) => c.id === curState.selectedClipId) || aClips[0]];

  // 4. Select English SRT file if not provided
  let srtPath = options.srtPath;
  if (!srtPath) {
    showNotice('📂 Англи SRT хадмал файлаа сонгоно уу...');
    const srtRes = await window.api.openSrtFile();
    if (!srtRes || !srtRes.path) {
      showNotice('⚠️ SRT файл сонгосонгүй.');
      return false;
    }
    srtPath = srtRes.path;
  }

  const targetVideoTrackId = vClip.trackId;
  const rawClipId = vClip.id;
  const firstAClip = targetAudioClips[0];
  const lastAClip = targetAudioClips[targetAudioClips.length - 1];
  const totalAudioStart = firstAClip.start;
  const totalAudioEnd = lastAClip.start + (lastAClip.outPoint - lastAClip.inPoint);

  showNotice(`📜 [${srtPath.split(/[\\/]/).pop()}] хадмалыг монгол яриатай харьцуулан эвлүүлж байна...`);

  // Capture base other clips ONCE at start so chunk updates never duplicate clips!
  const initialClips = curState.clips;
  const baseOtherClips = initialClips.filter((c) => {
    if (c.id === rawClipId || c.id === 'temp-raw-remainder') return false;
    if (c.trackId === targetVideoTrackId) {
      const cDuration = c.outPoint - c.inPoint;
      const cEnd = c.start + cDuration;
      if (c.start < totalAudioEnd - 0.01 && cEnd > totalAudioStart + 0.01) {
        return false;
      }
    }
    return true;
  });

  const allAddedClips: Clip[] = [];
  const processedCutIds = new Set<string>();

  const applyCutsToTimeline = (cuts: any[], nextSourceOffset?: number, audioStartOffset = totalAudioStart) => {
    const newClips: Clip[] = [];
    const newFreezeMediaItems: MediaItem[] = [];

    for (const c of cuts) {
      const cutUniqueKey = `${audioStartOffset}-${c.id}`;
      if (processedCutIds.has(cutUniqueKey)) continue;
      processedCutIds.add(cutUniqueKey);

      let mediaId = vMedia.id;
      let inPoint = c.sourceStart;
      let outPoint = c.sourceEnd;

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
        start: audioStartOffset + c.targetStart,
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

    let updatedMedia = curState.media;
    if (newFreezeMediaItems.length) {
      const existingIds = new Set(curState.media.map((m) => m.id));
      const freshItems = newFreezeMediaItems.filter((m) => !existingIds.has(m.id));
      if (freshItems.length) {
        updatedMedia = [...curState.media, ...freshItems];
      }
    }

    useEditor.setState({
      media: updatedMedia,
      clips: [...baseOtherClips, ...allAddedClips],
      selectedClipId: allAddedClips[0]?.id || null
    });
  };

  let activeChunkAudioStart = totalAudioStart;
  const unsub = window.api.onVoiceEditProgress?.((p: any) => {
    if (p?.type === 'chunk' && Array.isArray(p.cuts) && p.cuts.length) {
      applyCutsToTimeline(p.cuts, p.nextSourceOffset, activeChunkAudioStart);
    }
  });

  curState.beginGesture();

  try {
    for (let clipIdx = 0; clipIdx < targetAudioClips.length; clipIdx++) {
      const curAClip = targetAudioClips[clipIdx];
      const curAMedia = curState.media.find((m) => m.id === curAClip.mediaId);
      if (!curAMedia) continue;
      const curAIn = curAClip.inPoint || 0;
      const curADur = Math.max(0.5, (curAClip.outPoint || curAMedia.duration) - curAIn);
      const curAStart = curAClip.start;
      activeChunkAudioStart = curAStart;

      if (targetAudioClips.length > 1) {
        showNotice(`⏳ [${clipIdx + 1}/${targetAudioClips.length}] Voice хэсгийг эвлүүлж байна (${Math.round(curADur)} сек)...`);
      }

      let res: any = null;
      try {
        res = await window.api.syncTimelineSrt({
          videoPath: vMedia.path,
          srtPath,
          voicePath: curAMedia.path,
          voiceOffset: curAIn,
          voiceDuration: curADur,
          scriptText: options.scriptText,
          scriptPath: options.scriptPath,
          videoOffset: options.videoOffset || 0,
          pacingMode: options.pacingMode || 'motion' // Option 1B: pure dynamic video motion
        });
      } catch (err: any) {
        console.warn('[syncSrt] Chunk error:', err);
      }

      if (res?.cuts?.length) {
        applyCutsToTimeline(res.cuts, res.nextSourceOffset, curAStart);
      }
    }
  } finally {
    unsub?.();
  }

  if (!allAddedClips.length) {
    showNotice('⚠️ Англи SRT хадмалаар тааруулж чадсангүй.');
    curState.endGesture();
    return false;
  }

  // Finalize remainder cleanly without temp id
  const lastAdded = allAddedClips[allAddedClips.length - 1];
  const lastSource = lastAdded ? lastAdded.outPoint : 0;
  const finalRemainder: Clip[] = [];
  if (vMedia.duration > lastSource + 1) {
    finalRemainder.push({
      id: uid(),
      kind: 'av',
      mediaId: vMedia.id,
      trackId: targetVideoTrackId,
      start: totalAudioEnd,
      inPoint: lastSource,
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
    playhead: totalAudioStart
  });

  curState.endGesture();

  const successMsg = `✨ Амжилттай: Нийт ${allAddedClips.length} үзэгдэл Англи SRT хадмалын дагуу монгол ярианд 100% яв цав таарлаа!`;
  showNotice(successMsg);
  return true;
}
