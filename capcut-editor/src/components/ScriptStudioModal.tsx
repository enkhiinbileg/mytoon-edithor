import React, { useEffect, useState, useMemo } from 'react';
import { useEditor } from '../store';
import { importPaths } from '../importMedia';
import type { Clip, MediaItem, Voice, ElevenKeyItem } from '../types';

const uid = () => Math.random().toString(36).slice(2, 10);

const MAX_SCRIPT_CHARS = 10000;
const CHUNK_SIZE = 2200;
const DEFAULT_VOICE_ID = 'TX3LPaxmHKxFdv7VOQHJ'; // Liam (Premade - Free API compatible)

/**
 * Intelligently splits script into chunks of <= maxChars (2200 characters)
 * keeping complete sentences, clauses and natural pauses intact.
 */
function splitScriptIntoChunks(text: string, maxChars = 2200): string[] {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const rawSentences = trimmed
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let currentChunk = '';

  for (const sentence of rawSentences) {
    if (sentence.length > maxChars) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      const clauses = sentence.split(/(?<=[,;:\n])\s+/).filter(Boolean);
      for (const clause of clauses) {
        if (clause.length > maxChars) {
          const words = clause.split(/\s+/);
          for (const word of words) {
            if ((currentChunk + ' ' + word).length > maxChars) {
              if (currentChunk.trim()) chunks.push(currentChunk.trim());
              currentChunk = word;
            } else {
              currentChunk = currentChunk ? currentChunk + ' ' + word : word;
            }
          }
        } else if ((currentChunk + ' ' + clause).length > maxChars) {
          if (currentChunk.trim()) chunks.push(currentChunk.trim());
          currentChunk = clause;
        } else {
          currentChunk = currentChunk ? currentChunk + ' ' + clause : clause;
        }
      }
      continue;
    }

    if ((currentChunk + ' ' + sentence).length > maxChars) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = sentence;
    } else {
      currentChunk = currentChunk ? currentChunk + ' ' + sentence : sentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccessNotice?: (msg: string) => void;
}

export default function ScriptStudioModal({ isOpen, onClose, onSuccessNotice }: Props) {
  const [scriptText, setScriptText] = useState('');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>(DEFAULT_VOICE_ID);
  const [modelId, setModelId] = useState<string>('eleven_v3');
  const [speed, setSpeed] = useState<number>(1.0);
  const [stability, setStability] = useState<number>(0.5);
  const [similarity, setSimilarity] = useState<number>(0.75);

  // Multi-API Key Pool & Credit tracking
  const [keyPool, setKeyPool] = useState<ElevenKeyItem[]>([]);
  const [poolDrawerOpen, setPoolDrawerOpen] = useState<boolean>(false);
  const [newKeyInput, setNewKeyInput] = useState<string>('');
  const [newKeyLabel, setNewKeyLabel] = useState<string>('');
  const [addingKey, setAddingKey] = useState<boolean>(false);
  const [refreshingPool, setRefreshingPool] = useState<boolean>(false);
  const [hasApiKey, setHasApiKey] = useState<boolean>(false);

  // Studio Mode: 'voice_only' (Default - purely generate voiceover) vs 'sync_video' (Rule 1 video sync)
  const [studioMode, setStudioMode] = useState<'voice_only' | 'sync_video'>('voice_only');

  // Video & Rule 1 settings
  const [videoPath, setVideoPath] = useState<string>('');
  const [sourceOffset, setSourceOffset] = useState<number>(0);
  const [mode, setMode] = useState<'hybrid' | 'freeze' | 'cut'>('hybrid');
  const [useVision, setUseVision] = useState<boolean>(false);
  const [panelPacing, setPanelPacing] = useState<'auto' | number>('auto');

  const [busy, setBusy] = useState<boolean>(false);
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [progressPct, setProgressPct] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string>('');

  const { media, tracks, clips, ensureTrack, addMedia } = useEditor();

  // Escape key handler to close modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, busy, onClose]);

  // Load API key pool and voices on open
  useEffect(() => {
    if (!isOpen) return;

    window.api.getElevenKeyPool().then((pool) => {
      if (Array.isArray(pool)) {
        setKeyPool(pool);
        if (pool.length > 0) {
          setHasApiKey(true);
          loadVoices();
        } else {
          setPoolDrawerOpen(true);
        }
      }
    });

    // Auto-detect target video from timeline or media pool
    const vTrack = tracks.find((t) => t.kind === 'video');
    const vClip = vTrack ? clips.find((c) => c.trackId === vTrack.id && c.kind === 'av') : null;
    if (vClip) {
      const vMedia = media.find((m) => m.id === vClip.mediaId);
      if (vMedia?.path) {
        setVideoPath(vMedia.path);
        setSourceOffset(Math.round(vClip.inPoint || 0));
        return;
      }
    }

    const firstVideo = media.find((m) => m.kind === 'video');
    if (firstVideo?.path) {
      setVideoPath(firstVideo.path);
    }
  }, [isOpen, tracks, clips, media]);

  const loadVoices = async () => {
    try {
      const vRes = await window.api.listVoices('elevenlabs');
      if (vRes.ok && vRes.voices && vRes.voices.length > 0) {
        const sorted = [...vRes.voices].sort((a, b) => {
          if (a.id === DEFAULT_VOICE_ID) return -1;
          if (b.id === DEFAULT_VOICE_ID) return 1;
          return a.name.localeCompare(b.name);
        });
        setVoices(sorted);
        const hasDefault = sorted.some((v) => v.id === DEFAULT_VOICE_ID);
        if (hasDefault) {
          setSelectedVoiceId(DEFAULT_VOICE_ID);
        } else if (!selectedVoiceId) {
          setSelectedVoiceId(DEFAULT_VOICE_ID);
        }
      }
    } catch (e) {
      console.warn('Failed to load ElevenLabs voices:', e);
    }
  };

  const handleAddPoolKey = async () => {
    if (!newKeyInput.trim()) return;
    setAddingKey(true);
    setErrorMsg('');
    try {
      const res = await window.api.addElevenKey(newKeyInput.trim(), newKeyLabel.trim() || undefined);
      if (res.ok && res.pool) {
        setKeyPool(res.pool);
        setNewKeyInput('');
        setNewKeyLabel('');
        setHasApiKey(true);
        await loadVoices();
      } else {
        setErrorMsg(res.error || 'Түлхүүр нэмэхэд алдаа гарлаа.');
      }
    } catch (err: any) {
      setErrorMsg(`API түлхүүр нэмэхэд алдаа: ${err?.message || err}`);
    } finally {
      setAddingKey(false);
    }
  };

  const handleRemovePoolKey = async (keyId: string) => {
    if (!window.confirm('Энэ түлхүүрийг сангаас устгах уу?')) return;
    try {
      const res = await window.api.removeElevenKey(keyId);
      if (res.ok && res.pool) {
        setKeyPool(res.pool);
        if (res.pool.length === 0) setHasApiKey(false);
      }
    } catch (err: any) {
      setErrorMsg(`Устгахад алдаа: ${err?.message || err}`);
    }
  };

  const handleTogglePoolKey = async (keyId: string, enabled: boolean) => {
    try {
      const res = await window.api.toggleElevenKey(keyId, enabled);
      if (res.ok && res.pool) setKeyPool(res.pool);
    } catch (err: any) {
      console.warn(err);
    }
  };

  const handleRefreshPoolQuotas = async () => {
    setRefreshingPool(true);
    try {
      const res = await window.api.refreshElevenQuotas();
      if (res.ok && res.pool) setKeyPool(res.pool);
    } catch (err: any) {
      console.warn(err);
    } finally {
      setRefreshingPool(false);
    }
  };

  const handlePickVideo = async () => {
    try {
      const files = await window.api.openMedia();
      if (files && files[0]) {
        const added = await importPaths([files[0]]);
        if (added && added[0]?.path) {
          setVideoPath(added[0].path);
        }
      }
    } catch (err) {
      console.warn('Pick video error:', err);
    }
  };

  // Script metrics and chunk computation across Multi-Key Pool
  const metrics = useMemo(() => {
    const text = scriptText.trim();
    const charCount = text.length;

    const activeKeys = keyPool.filter((k) => k.enabled);
    const activeKeyCount = activeKeys.length;

    // Deduplicate quota if multiple keys belong to the exact same ElevenLabs account (same userId)
    const seenUsers = new Set<string>();
    let totalRemaining = 0;
    let totalLimit = 0;
    let duplicateAccountsCount = 0;

    for (const k of activeKeys) {
      const uId = k.quota?.userId;
      if (uId) {
        if (seenUsers.has(uId)) {
          duplicateAccountsCount++;
          continue; // Prevent double-counting characters for the same account
        }
        seenUsers.add(uId);
      }
      totalRemaining += (k.quota?.remaining ?? 10000);
      totalLimit += (k.quota?.limit ?? 10000);
    }

    const maxCapacity = Math.max(10000, totalRemaining);

    const exceedsCapacity = activeKeyCount > 0 && charCount > maxCapacity;
    const exceeds10k = charCount > maxCapacity;

    const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const estDurationSec = wordCount > 0 ? Math.round(wordCount / 3.2) : 0;
    const estMins = Math.floor(estDurationSec / 60);
    const estSecs = estDurationSec % 60;
    const estDurationFormatted = `${estMins > 0 ? `${estMins}м ` : ''}${estSecs}с`;

    const sentenceList = text.split(/(?<=[.!?\n])\s+/).filter(Boolean);
    const sentenceCount = sentenceList.length;

    // Sliced chunks (each <= 2200 chars for ElevenLabs safe delivery)
    const chunks = text ? splitScriptIntoChunks(text, CHUNK_SIZE) : [];

    return {
      charCount,
      exceeds10k,
      exceedsCapacity,
      wordCount,
      estDurationFormatted,
      sentenceCount,
      chunks,
      activeKeyCount,
      totalRemaining,
      totalLimit,
      maxCapacity,
      duplicateAccountsCount
    };
  }, [scriptText, keyPool]);

  // Trim to nearest sentence boundary before pool capacity limit
  const handleTrimTo10k = () => {
    const limit = metrics.maxCapacity || 10000;
    if (scriptText.length <= limit) return;
    const sub = scriptText.slice(0, limit);
    const lastPunct = Math.max(
      sub.lastIndexOf('.'),
      sub.lastIndexOf('!'),
      sub.lastIndexOf('?'),
      sub.lastIndexOf('\n')
    );
    const cutIndex = lastPunct > (limit * 0.85) ? lastPunct + 1 : limit;
    const head = scriptText.slice(0, cutIndex).trim();
    const tail = scriptText.slice(cutIndex).trim();
    setScriptText(head);
    if (tail && navigator.clipboard) {
      navigator.clipboard.writeText(tail).catch(() => {});
      alert(`Эхний ${head.length.toLocaleString()} тэмдэгтийг сонголоо. Үлдсэн ${tail.length.toLocaleString()} тэмдэгтийг Clipboard-д хуулсан тул дараагийн ээлжинд шууд Paste хийнэ үү.`);
    }
  };

  const handleRun = async (forceVoiceOnly?: boolean) => {
    const isVoiceOnly = forceVoiceOnly !== undefined ? forceVoiceOnly : (studioMode === 'voice_only');

    if (!scriptText.trim()) {
      setErrorMsg('Монгол скрипт текстээ оруулна уу.');
      return;
    }
    const activeKeys = keyPool.filter((k) => k.enabled);
    if (activeKeys.length === 0 && !hasApiKey) {
      setErrorMsg('ElevenLabs API түлхүүр бүртгэгдээгүй байна. "Түлхүүрийн сан" (API Key Pool) дээр дарж түлхүүр нэмнэ үү.');
      setPoolDrawerOpen(true);
      return;
    }
    if (metrics.exceedsCapacity) {
      setErrorMsg(`Скриптийн урт (${metrics.charCount.toLocaleString()} тэмдэгт) таны идэвхтэй түлхүүрүүдийн нийт үлдсэн багтаамжаас (${metrics.totalRemaining.toLocaleString()}) давсан байна. Нэмэлт түлхүүр оруулах эсвэл "Багтаамжид тааруулж таслах" товчийг дарна уу.`);
      return;
    }
    if (!isVoiceOnly && !videoPath) {
      setErrorMsg('Манхва эх видеогоо сонгоно уу.');
      return;
    }
    if (!selectedVoiceId && voices.length > 0) {
      setSelectedVoiceId(voices[0].id);
    }

    setBusy(true);
    setErrorMsg('');
    setProgressPct(5);
    setProgressMsg(
      isVoiceOnly
        ? `🎙️ ElevenLabs Pool: ${metrics.activeKeyCount || 1} түлхүүрээр ${metrics.chunks.length} хэсэг дуу хоолойг зэрэгцүүлэн үүсгэж байна...`
        : `🎙️ ElevenLabs Pool: ${metrics.activeKeyCount || 1} түлхүүрээр ${metrics.chunks.length} хэсгийг зэрэгцүүлэн боловсруулж байна...`
    );

    let unsub: (() => void) | null = null;
    try {
      unsub = window.api.onScriptStudioProgress?.((p: any) => {
        if (p?.message) setProgressMsg(p.message);
        if (p?.stage === 'tts' || p?.stage === 'pool-chunk-done' || p?.stage === 'pool-chunk-start') {
          if (p.totalParts && p.partIndex !== undefined) {
            const pct = Math.round(10 + ((p.partIndex) / p.totalParts) * 35);
            setProgressPct(pct);
          } else {
            setProgressPct(25);
          }
        } else if (p?.stage === 'chunk-start' || p?.stage === 'chunk') {
          const totalChunks = p.totalChunks || 1;
          const chunkIdx = p.chunkIndex || 0;
          const pct = Math.round(45 + ((chunkIdx + 1) / totalChunks) * 50);
          setProgressPct(pct);
        } else if (p?.stage === 'done') {
          setProgressPct(100);
        }
      });

      const res = await window.api.buildScriptRecap({
        scriptText: scriptText.trim(),
        voiceId: selectedVoiceId || voices[0]?.id || '',
        modelId,
        stability,
        similarity,
        speed,
        videoPath: isVoiceOnly ? undefined : videoPath,
        sourceOffset: Number(sourceOffset) || 0,
        mode: isVoiceOnly ? 'audio_only' : mode,
        audioOnly: isVoiceOnly,
        useVision: isVoiceOnly ? false : useVision,
        panelPacing
      });

      if (!res.ok || !res.audioPath) {
        throw new Error(res.error || 'Скрипт студи алдаа заалаа.');
      }

      // Add generated audio file to media store and Audio 1 track
      const audioMediaItems = await importPaths([res.audioPath]);
      const masterAudioMedia = audioMediaItems[0];

      if (masterAudioMedia) {
        const aTrack = ensureTrack('audio');
        const audioClipDuration = res.voiceDuration || masterAudioMedia.duration || 10;
        const newAudioClip: Clip = {
          id: uid(),
          kind: 'av',
          mediaId: masterAudioMedia.id,
          trackId: aTrack.id,
          start: 0,
          inPoint: 0,
          outPoint: audioClipDuration,
          volume: 1,
          opacity: 1,
          filterId: 'none',
          effectId: 'none',
          transitionId: 'none'
        };

        const currentState = useEditor.getState();

        if (isVoiceOnly) {
          // Voice-Only: Keep all video and other clips on timeline untouched!
          const otherClips = currentState.clips.filter((c) => c.trackId !== aTrack.id);
          useEditor.setState({
            clips: [...otherClips, newAudioClip],
            selectedClipId: newAudioClip.id
          });

          useEditor.getState().setPlayhead(0);
          loadVoices();
          handleRefreshPoolQuotas();

          onSuccessNotice?.(`✨ AI Хоолой: ${metrics.chunks.length} хэсэг бүхий ${Math.round(audioClipDuration)}с дуу хоолой Timeline-ийн Audio зам болон Медиа санд амжилттай суулаа!`);
          onClose();
          return;
        }

        // Voice + Video Sync Mode:
        const vTrack = ensureTrack('video');
        const targetVideoClips: Clip[] = [];
        const cuts = res.cuts || [];
        const baseMedia = media.find((m) => m.path === videoPath);

        for (const cut of cuts) {
          let mediaIdToUse = '';

          if (cut.freeze && cut.freezeImagePath) {
            const freezeMediaId = `freeze-${uid()}`;
            const freezeMedia: MediaItem = {
              id: freezeMediaId,
              name: cut.text ? cut.text.slice(0, 32) : `Кадр ${cut.id + 1}`,
              path: cut.freezeImagePath,
              kind: 'image',
              duration: 3600,
              width: 1920,
              height: 1080,
              fps: 30,
              hasAudio: false,
              thumbs: [window.api.toMediaUrl ? window.api.toMediaUrl(cut.freezeImagePath) : cut.freezeImagePath],
              isInternal: true
            };
            addMedia(freezeMedia);
            mediaIdToUse = freezeMediaId;
          } else if (baseMedia) {
            mediaIdToUse = baseMedia.id;
          }

          if (mediaIdToUse) {
            targetVideoClips.push({
              id: uid(),
              kind: 'av',
              mediaId: mediaIdToUse,
              trackId: vTrack.id,
              start: cut.targetStart,
              inPoint: cut.freeze ? 0 : cut.sourceStart,
              outPoint: cut.freeze ? cut.duration : (cut.sourceStart + cut.duration),
              volume: 0,
              opacity: 1,
              filterId: 'none',
              effectId: 'none',
              transitionId: 'none'
            });
          }
        }

        // Mount to timeline
        const otherClips = currentState.clips.filter((c) => c.trackId !== vTrack.id && c.trackId !== aTrack.id);
        useEditor.setState({
          clips: [...otherClips, newAudioClip, ...targetVideoClips],
          selectedClipId: targetVideoClips[0]?.id || null
        });

        useEditor.getState().setPlayhead(0);
        loadVoices();
        handleRefreshPoolQuotas();

        onSuccessNotice?.(`✨ AI Скрипт Студи: ${metrics.chunks.length} хэсэгт таслагдсан ${cuts.length} үзэгдэл ${Math.round(audioClipDuration)}с хоолойтойгоор timeline дээр амжилттай суулаа!`);
        onClose();
      }
    } catch (err: any) {
      setErrorMsg(String(err?.message || err));
    } finally {
      unsub?.();
      setBusy(false);
    }
  };

  const handleSaveMp3Directly = async () => {
    if (!scriptText.trim()) {
      setErrorMsg('Монгол скрипт текстээ оруулна уу.');
      return;
    }
    const activeKeys = keyPool.filter((k) => k.enabled);
    if (activeKeys.length === 0 && !hasApiKey) {
      setErrorMsg('ElevenLabs API түлхүүр бүртгэгдээгүй байна. "Түлхүүрийн сан" (API Key Pool) дээр дарж түлхүүр нэмнэ үү.');
      setPoolDrawerOpen(true);
      return;
    }

    const savePath = await window.api.saveExportDialog('script_voice_' + Date.now() + '.mp3');
    if (!savePath) return;

    setBusy(true);
    setErrorMsg('');
    setProgressPct(10);
    setProgressMsg('🎙️ ElevenLabs: Дуу хоолойг үүсгэж, MP3 файлаар хадгалж байна...');

    let unsub: (() => void) | null = null;
    try {
      unsub = window.api.onScriptStudioProgress?.((p: any) => {
        if (p?.message) setProgressMsg(p.message);
        if (p?.stage === 'tts' || p?.stage === 'pool-chunk-done' || p?.stage === 'pool-chunk-start') {
          if (p.totalParts && p.partIndex !== undefined) {
            const pct = Math.round(10 + ((p.partIndex) / p.totalParts) * 80);
            setProgressPct(pct);
          }
        }
      });

      const res = await window.api.buildScriptRecap({
        scriptText: scriptText.trim(),
        voiceId: selectedVoiceId || voices[0]?.id || '',
        modelId,
        stability,
        similarity,
        speed,
        audioOnly: true,
        mode: 'audio_only'
      });

      if (!res.ok || !res.audioPath) {
        throw new Error(res.error || 'Хоолой үүсгэхэд алдаа гарлаа.');
      }

      if (window.api.copyFile) {
        await window.api.copyFile(res.audioPath, savePath);
      }
      await importPaths([res.audioPath]);
      loadVoices();
      handleRefreshPoolQuotas();

      onSuccessNotice?.(`💾 MP3 файл амжилттай хадгалагдаж, Медиа санд орлоо: ${savePath}`);
      onClose();
    } catch (err: any) {
      setErrorMsg(String(err?.message || err));
    } finally {
      unsub?.();
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  const charPct = Math.min(100, Math.round((metrics.charCount / Math.max(1, metrics.maxCapacity)) * 100));
  const barColor = metrics.exceedsCapacity ? '#ef4444' : metrics.charCount > (metrics.maxCapacity * 0.8) ? '#f59e0b' : '#10b981';

  return (
    <div
      className="modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.78)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 99999,
        padding: 16
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="modal-card"
        style={{
          width: 780,
          maxWidth: '95vw',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#15161c',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: 12,
          boxShadow: '0 25px 70px rgba(0,0,0,0.85), 0 0 1px 1px rgba(255,255,255,0.08)',
          overflow: 'hidden'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'linear-gradient(180deg, rgba(99, 102, 241, 0.14) 0%, rgba(21, 22, 28, 0.6) 100%)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 17,
                boxShadow: '0 4px 14px rgba(99, 102, 241, 0.45)'
              }}
            >
              🎙️
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, letterSpacing: -0.2, color: '#fff' }}>
                  AI Скрипт Студи (Multi-Key Pool)
                </h2>
                <span
                  style={{
                    fontSize: 10,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: studioMode === 'voice_only' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(0, 196, 140, 0.2)',
                    color: '#34d399',
                    fontWeight: 650,
                    letterSpacing: 0.2
                  }}
                >
                  {studioMode === 'voice_only' ? '🎙️ Зөвхөн дуу хоолой (Voice Only)' : '🎬 Rule 1: Зөв дараалал'}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: 'rgba(99, 102, 241, 0.2)',
                    color: '#a5b4fc',
                    fontWeight: 600
                  }}
                >
                  {metrics.activeKeyCount > 0 ? `Багтаамж: ${metrics.maxCapacity.toLocaleString()} тэмдэгт` : 'Түлхүүр оруулна уу'}
                </span>
              </div>
              <span style={{ fontSize: 11, color: '#8e929d' }}>
                {studioMode === 'voice_only'
                  ? 'Монгол тайлбар ➔ Multi-Key зэрэгцээ уншилт ➔ Студи чанартай хоолойг Timeline Audio замд оруулах'
                  : 'Монгол тайлбар ➔ Multi-Key зэрэгцээ хуваарилалт ➔ ElevenLabs v3 хоолой ➔ Видеог зөв дарааллаар нь тааруулах'}
              </span>
            </div>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            disabled={busy}
            style={{
              fontSize: 20,
              width: 32,
              height: 32,
              borderRadius: 6,
              color: '#8e929d',
              background: 'rgba(255,255,255,0.04)'
            }}
            title="Хаах (Esc)"
          >
            ×
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* ElevenLabs Key Pool Dashboard */}
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              background: metrics.exceedsCapacity ? 'rgba(239, 68, 68, 0.12)' : 'rgba(99, 102, 241, 0.09)',
              border: `1px solid ${metrics.exceedsCapacity ? 'rgba(239, 68, 68, 0.35)' : 'rgba(99, 102, 241, 0.25)'}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 8
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ fontSize: 18 }}>🔑</span>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <strong style={{ color: '#fff', fontSize: 13 }}>ElevenLabs Multi-Key Pool:</strong>
                    <span
                      style={{
                        padding: '1px 7px',
                        borderRadius: 10,
                        background: metrics.activeKeyCount > 0 ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                        color: metrics.activeKeyCount > 0 ? '#34d399' : '#f87171',
                        fontSize: 10,
                        fontWeight: 700
                      }}
                    >
                      {metrics.activeKeyCount > 0 ? `🟢 ${metrics.activeKeyCount} Түлхүүр Идэвхтэй` : '🔴 Түлхүүргүй'}
                    </span>
                    <span
                      style={{
                        padding: '1px 7px',
                        borderRadius: 10,
                        background: 'rgba(99, 102, 241, 0.2)',
                        color: '#a5b4fc',
                        fontSize: 10,
                        fontWeight: 600
                      }}
                    >
                      ⚡ Зэрэгцээ хуваарилалт (Parallel)
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#a1a1aa', marginTop: 2 }}>
                    Нийт үлдсэн багтаамж:{' '}
                    <strong style={{ color: metrics.exceedsCapacity ? '#f87171' : '#34d399' }}>
                      {metrics.totalRemaining.toLocaleString()}
                    </strong>{' '}
                    / {metrics.totalLimit.toLocaleString()} кредит{' '}
                    {metrics.activeKeyCount > 1 && `(${metrics.activeKeyCount}x хурдтай зэрэг уншина)`}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={handleRefreshPoolQuotas}
                  disabled={refreshingPool || busy}
                  style={{
                    fontSize: 11,
                    padding: '4px 9px',
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 6,
                    color: '#ddd'
                  }}
                  title="Бүх түлхүүрийн кредитийг дахин шалгах"
                >
                  {refreshingPool ? 'Шалгаж байна...' : '🔄 Кредит шинэчлэх'}
                </button>

                <button
                  type="button"
                  className="btn"
                  onClick={() => setPoolDrawerOpen((v) => !v)}
                  style={{
                    fontSize: 11,
                    padding: '4px 10px',
                    background: poolDrawerOpen ? '#4f46e5' : 'rgba(99, 102, 241, 0.25)',
                    border: '1px solid rgba(99, 102, 241, 0.4)',
                    borderRadius: 6,
                    color: '#fff',
                    fontWeight: 600
                  }}
                >
                  {poolDrawerOpen ? '▲ Сан хураах' : `▼ Түлхүүрийн сан (${keyPool.length})`}
                </button>
              </div>
            </div>

            {/* Key Pool Management Drawer */}
            {poolDrawerOpen && (
              <div
                style={{
                  marginTop: 6,
                  padding: '12px',
                  borderRadius: 8,
                  background: '#13141a',
                  border: '1px solid rgba(255,255,255,0.1)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#e4e4e7' }}>
                    📋 Бүртгэлтэй ElevenLabs API Түлхүүрүүд:
                  </span>
                  <span style={{ fontSize: 10, color: '#9ca3af' }}>
                    *Олон түлхүүр оруулснаар 10,000+ тэмдэгттэй урт скриптийг зэрэгцүүлэн тасалдалгүй уншина
                  </span>
                </div>

                {/* Duplicate Account Alert Banner */}
                {metrics.duplicateAccountsCount > 0 && (
                  <div
                    style={{
                      padding: '7px 10px',
                      borderRadius: 6,
                      background: 'rgba(234, 179, 8, 0.12)',
                      border: '1px solid rgba(234, 179, 8, 0.35)',
                      fontSize: 10,
                      color: '#fde047',
                      lineHeight: 1.4
                    }}
                  >
                    ⚠️ <b>Анхаар:</b> Таны түлхүүрүүдийн дунд нэг данснаас гаргасан <b>{metrics.duplicateAccountsCount} давхардсан түлхүүр</b> байна. Тэд дундаа 1 квот хуваалцдаг тул нийт багтаамжийг хуурамчаар үржүүлэлгүй, бодит хэмжээгээр нь тооцож харуулав.
                  </div>
                )}

                {/* Key Cards List */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
                  {keyPool.length === 0 ? (
                    <div style={{ fontSize: 11, color: '#71717a', padding: '8px 0', textAlign: 'center' }}>
                      Одоогоор түлхүүр бүртгэгдээгүй байна. Доорх талбарт API түлхүүрээ оруулна уу.
                    </div>
                  ) : (
                    keyPool.map((k, idx) => {
                      const rem = k.quota?.remaining ?? 10000;
                      const lim = k.quota?.limit ?? 10000;
                      const pct = Math.min(100, Math.round((rem / Math.max(1, lim)) * 100));
                      const isExhausted = k.status === 'exhausted' || rem <= 0;
                      const duplicateKey = k.quota?.userId
                        ? keyPool.find((other) => other.id !== k.id && other.quota?.userId === k.quota?.userId)
                        : null;

                      return (
                        <div
                          key={k.id || idx}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 6,
                            background: k.enabled ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.01)',
                            border: `1px solid ${k.enabled ? (isExhausted ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255,255,255,0.08)') : 'rgba(255,255,255,0.04)'}`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            opacity: k.enabled ? 1 : 0.5,
                            gap: 10
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                            <input
                              type="checkbox"
                              checked={k.enabled}
                              onChange={(e) => handleTogglePoolKey(k.id, e.target.checked)}
                              title={k.enabled ? 'Идэвхтэй байна (уншилтад оролцоно)' : 'Идэвхгүй болгосон'}
                              style={{ cursor: 'pointer' }}
                            />
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 12, fontWeight: 650, color: '#fff' }}>{k.label}</span>
                                <code style={{ fontSize: 10, color: '#a1a1aa', background: 'rgba(0,0,0,0.3)', padding: '1px 4px', borderRadius: 3 }}>
                                   {k.maskedKey}
                                </code>
                                {duplicateKey && (
                                  <span
                                    style={{
                                      fontSize: 9,
                                      padding: '1px 5px',
                                      borderRadius: 6,
                                      background: 'rgba(234, 179, 8, 0.2)',
                                      color: '#facc15',
                                      border: '1px solid rgba(234, 179, 8, 0.4)',
                                      cursor: 'help'
                                    }}
                                    title={`Энэ түлхүүр нь '${duplicateKey.label}'-тэй яг адилхан дансных байна (квот нь дундаа хуваалцана).`}
                                  >
                                    ⚠️ Ижил данс ({duplicateKey.label})
                                  </span>
                                )}
                                {isExhausted ? (
                                  <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6, background: 'rgba(239,68,68,0.2)', color: '#f87171' }}>
                                    🔴 Кредит дууссан
                                  </span>
                                ) : (
                                  <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6, background: 'rgba(16,185,129,0.2)', color: '#34d399' }}>
                                    🟢 Бэлэн
                                  </span>
                                )}
                              </div>
                              <span style={{ fontSize: 10, color: isExhausted ? '#f87171' : '#a1a1aa', marginTop: 1 }}>
                                Үлдсэн: {rem.toLocaleString()} / {lim.toLocaleString()} кредит ({pct}%)
                              </span>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleRemovePoolKey(k.id)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: '#71717a',
                              cursor: 'pointer',
                              padding: 4,
                              fontSize: 12,
                              borderRadius: 4
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
                            onMouseLeave={(e) => (e.currentTarget.style.color = '#71717a')}
                            title="Устгах"
                          >
                            🗑️
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Add New Key Form */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>+ Шинэ ElevenLabs API түлхүүр нэмэх:</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      placeholder="Нэр (ж: Түлхүүр #2)"
                      value={newKeyLabel}
                      onChange={(e) => setNewKeyLabel(e.target.value)}
                      style={{
                        width: 140,
                        padding: '6px 8px',
                        fontSize: 12,
                        borderRadius: 6,
                        background: '#101116',
                        border: '1px solid #3f3f46',
                        color: '#fff',
                        outline: 'none'
                      }}
                    />
                    <input
                      type="password"
                      placeholder="xi-... (ElevenLabs API Key)"
                      value={newKeyInput}
                      onChange={(e) => setNewKeyInput(e.target.value)}
                      style={{
                        flex: 1,
                        padding: '6px 10px',
                        fontSize: 12,
                        borderRadius: 6,
                        background: '#101116',
                        border: '1px solid #3f3f46',
                        color: '#fff',
                        outline: 'none'
                      }}
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={handleAddPoolKey}
                      disabled={addingKey || !newKeyInput.trim()}
                      style={{
                        padding: '6px 14px',
                        fontSize: 12,
                        background: '#10b981',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      {addingKey ? 'Шалгаж байна...' : '+ Нэмэх & Шалгах'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Studio Working Mode Selector */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
              padding: 4,
              background: 'rgba(255, 255, 255, 0.04)',
              borderRadius: 8,
              border: '1px solid rgba(255, 255, 255, 0.08)'
            }}
          >
            <button
              type="button"
              onClick={() => setStudioMode('voice_only')}
              style={{
                padding: '9px 12px',
                borderRadius: 6,
                background: studioMode === 'voice_only'
                  ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(5, 150, 105, 0.35) 100%)'
                  : 'transparent',
                border: studioMode === 'voice_only' ? '1.5px solid #10b981' : '1px solid transparent',
                color: studioMode === 'voice_only' ? '#fff' : '#a1a1aa',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                boxShadow: studioMode === 'voice_only' ? '0 2px 10px rgba(16, 185, 129, 0.35)' : 'none'
              }}
            >
              <span style={{ fontSize: 16 }}>🎙️</span>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: studioMode === 'voice_only' ? '#34d399' : '#fff' }}>
                  Зөвхөн дуу хоолой үүсгэх (Voice Only)
                </div>
                <div style={{ fontSize: 10, color: studioMode === 'voice_only' ? '#a7f3d0' : '#71717a' }}>
                  Видео шаардахгүй · Студи хоолойг шууд авах
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setStudioMode('sync_video')}
              style={{
                padding: '9px 12px',
                borderRadius: 6,
                background: studioMode === 'sync_video'
                  ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.25) 0%, rgba(79, 70, 229, 0.35) 100%)'
                  : 'transparent',
                border: studioMode === 'sync_video' ? '1.5px solid #6366f1' : '1px solid transparent',
                color: studioMode === 'sync_video' ? '#fff' : '#a1a1aa',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                boxShadow: studioMode === 'sync_video' ? '0 2px 10px rgba(99, 102, 241, 0.35)' : 'none'
              }}
            >
              <span style={{ fontSize: 16 }}>🎬</span>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: studioMode === 'sync_video' ? '#a5b4fc' : '#fff' }}>
                  Хоолой + Дүрсэнд тааруулах (Sync Video)
                </div>
                <div style={{ fontSize: 10, color: studioMode === 'sync_video' ? '#c7d2fe' : '#71717a' }}>
                  Rule 1: Хронологи дараалал · Freeze & Cut
                </div>
              </div>
            </button>
          </div>

          {/* Script Textarea Input with Multi-Key Pool Capacity Enforcement */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ fontSize: 12, fontWeight: 650, color: '#e4e4e7' }}>
                {studioMode === 'voice_only' ? '🎙️ Монгол Скрипт / Дуу хоолойн текст:' : '🎬 Монгол Скрипт / Recap тайлбар текст:'}
              </label>

              {/* Character Metrics Header Badges */}
              <div style={{ display: 'flex', gap: 6, fontSize: 11, alignItems: 'center' }}>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 12,
                    background: metrics.exceedsCapacity ? 'rgba(239, 68, 68, 0.25)' : 'rgba(255, 255, 255, 0.08)',
                    color: metrics.exceedsCapacity ? '#f87171' : metrics.charCount > (metrics.maxCapacity * 0.8) ? '#fbbf24' : '#e4e4e7',
                    fontWeight: 650,
                    border: `1px solid ${metrics.exceedsCapacity ? '#ef4444' : 'rgba(255,255,255,0.1)'}`
                  }}
                >
                  📝 {metrics.charCount.toLocaleString()} / {metrics.maxCapacity.toLocaleString()} тэмдэгт
                </span>

                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 12,
                    background: metrics.chunks.length > 1 ? 'rgba(99, 102, 241, 0.2)' : 'rgba(255,255,255,0.06)',
                    color: metrics.chunks.length > 1 ? '#a5b4fc' : '#aaa',
                    border: metrics.chunks.length > 1 ? '1px solid rgba(99, 102, 241, 0.4)' : '1px solid rgba(255,255,255,0.08)'
                  }}
                  title="Хэсэг бүрийг Multi-Key Pool ашиглан зэрэгцүүлэн боловсруулна"
                >
                  ✂️ {metrics.chunks.length > 0 ? `${metrics.chunks.length} хэсэгт зэрэг хуваарилагдана` : '1 хэсэг'}
                </span>

                {studioMode === 'sync_video' && (
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: 12,
                      background: 'rgba(255,255,255,0.06)',
                      color: '#ddd'
                    }}
                  >
                    🎬 ~{metrics.sentenceCount} үзэгдэл
                  </span>
                )}

                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 12,
                    background: 'rgba(16, 185, 129, 0.15)',
                    color: '#34d399'
                  }}
                >
                  ⏱️ ~{metrics.estDurationFormatted}
                </span>
              </div>
            </div>

            {/* Textarea */}
            <textarea
              rows={7}
              value={scriptText}
              disabled={busy}
              onChange={(e) => setScriptText(e.target.value)}
              placeholder={
                studioMode === 'voice_only'
                  ? `Монгол тайлбар / зохиолын текстээ энд шууд Paste хийж оруулна уу... Таны ${metrics.activeKeyCount || 1} API түлхүүрээр зэрэгцүүлэн уншиж, цэвэр дуу хоолой үүсгэнэ.`
                  : 'Монгол recap тайлбар зохиолоо энд шууд Paste хийж оруулна уу... Multi-Key Pool систем нь текстийг автоматаар өгүүлбэрийн төгсгөлөөр таслан таны бүртгэлтэй түлхүүрүүд рүү зэрэгцүүлэн илгээнэ.'
              }
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                fontSize: 13,
                lineHeight: 1.55,
                borderRadius: 8,
                background: '#101116',
                border: metrics.exceedsCapacity
                  ? '2px solid #ef4444'
                  : '1px solid rgba(255,255,255,0.12)',
                color: '#fff',
                fontFamily: 'inherit',
                resize: 'vertical',
                minHeight: 130,
                outline: 'none'
              }}
            />

            {/* Character Limit Progress Bar */}
            <div style={{ height: 4, width: '100%', background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${charPct}%`,
                  height: '100%',
                  background: barColor,
                  transition: 'width 0.2s ease, background-color 0.2s ease'
                }}
              />
            </div>

            {/* Chunks breakdown badges (Showing user how it's sliced) */}
            {metrics.chunks.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 2, fontSize: 11, color: '#a1a1aa' }}>
                <span style={{ fontWeight: 600, color: '#e4e4e7' }}>
                  ✂️ Түлхүүрүүд рүү зэрэгцүүлэн илгээх {metrics.chunks.length} хэсэг (тус бүр ≤ 2,200 тэмдэгт):
                </span>
                {metrics.chunks.map((ch, idx) => (
                  <span
                    key={idx}
                    style={{
                      padding: '2px 7px',
                      borderRadius: 4,
                      background: 'rgba(99, 102, 241, 0.15)',
                      border: '1px solid rgba(99, 102, 241, 0.3)',
                      color: '#c7d2fe',
                      fontSize: 10,
                      fontWeight: 500
                    }}
                  >
                    Хэсэг {idx + 1}: {ch.length.toLocaleString()} тэмдэгт
                  </span>
                ))}
              </div>
            )}

            {/* Capacity limit warning and instant 1-click trim button */}
            {metrics.exceedsCapacity && (
              <div
                style={{
                  marginTop: 6,
                  padding: '9px 12px',
                  borderRadius: 6,
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12
                }}
              >
                <div style={{ fontSize: 11, color: '#fca5a5', lineHeight: 1.45 }}>
                  <strong>⚠️ Түлхүүрүүдийн багтаамж хэтэрсэн байна:</strong> Таны скрипт {metrics.charCount.toLocaleString()} тэмдэгттэй ({ (metrics.charCount - metrics.maxCapacity).toLocaleString() } тэмдэгтээр илүү) байна. Түлхүүрийн сан дээрээ дахин түлхүүр нэмэх эсвэл доорх товчоор багтаамжид тааруулж тасна уу.
                </div>
                <button
                  type="button"
                  onClick={handleTrimTo10k}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 5,
                    background: '#ef4444',
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 650,
                    border: 'none',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    boxShadow: '0 2px 8px rgba(239, 68, 68, 0.4)'
                  }}
                  title="Түлхүүрүүдийн нийт багтаамжаар өгүүлбэрийн төгсгөлөөр тасалж, үлдсэнийг нь санах ойд хуулна"
                >
                  ✂️ Багтаамжид тааруулж таслах
                </button>
              </div>
            )}
          </div>

          {/* Model & Voice Configuration Grid (Always available for both Voice-Only and Video Sync) */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 12,
              padding: 12,
              borderRadius: 8,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)'
            }}
          >
            {/* Model Selector */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#aaa' }}>
                ElevenLabs Модель:
              </label>
              <select
                value={modelId}
                disabled={busy}
                onChange={(e) => setModelId(e.target.value)}
                style={{
                  padding: '7px 10px',
                  borderRadius: 6,
                  background: '#191a22',
                  border: '1px solid rgba(255,255,255,0.14)',
                  color: '#fff',
                  fontSize: 12
                }}
              >
                <option value="eleven_v3">🌟 Eleven v3 (ҮНДСЭН · 70+ хэл, амьд сэтгэл хөдлөл, жүжиглэлт)</option>
                <option value="eleven_multilingual_v2">🎙️ Multilingual v2 (Баталгаат хувилбар)</option>
                <option value="eleven_flash_v2_5">Flash v2.5 (Хурдан хувилбар)</option>
                <option value="eleven_turbo_v2_5">Turbo v2.5 (Хямд тариф)</option>
              </select>
              <span style={{ fontSize: 10, color: '#71717a' }}>
                {modelId === 'eleven_v3'
                  ? '✓ Eleven v3 нь өгүүлбэрийн утгыг шууд мэдэрч жүжиглэлттэй, амьд ярина (Зэрэгцээ Parallel боловсруулалттай).'
                  : modelId === 'eleven_multilingual_v2'
                  ? '✓ Multilingual v2 нь туршигдсан баталгаат чанартай.'
                  : 'Хурдан хувилбар.'}
              </span>
            </div>

            {/* Voice Selector */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#aaa' }}>
                Хоолой (Voice):
              </label>
              <select
                value={selectedVoiceId}
                disabled={busy}
                onChange={(e) => setSelectedVoiceId(e.target.value)}
                style={{
                  padding: '7px 10px',
                  borderRadius: 6,
                  background: '#191a22',
                  border: '1px solid rgba(255,255,255,0.14)',
                  color: '#fff',
                  fontSize: 12
                }}
              >
                {!voices.some((v) => v.id === DEFAULT_VOICE_ID) && (
                  <option value={DEFAULT_VOICE_ID}>
                    ⭐ [Үндсэн хоолой] Liam (Premade · Free API)
                  </option>
                )}
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id === DEFAULT_VOICE_ID ? `⭐ [Үндсэн хоолой] ${v.name}` : v.name} {v.description ? `(${v.description})` : ''}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 10, color: '#71717a' }}>
                Та ElevenLabs дээр clone хийсэн дурын монгол хоолойгоо сонгож болно.
              </span>
            </div>
          </div>

          {/* Conditional Mode Panels: Voice-Only vs Video Sync */}
          {studioMode === 'voice_only' ? (
            /* Voice-Only Mode Card */
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.12) 0%, rgba(6, 78, 59, 0.16) 100%)',
                border: '1px solid rgba(16, 185, 129, 0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 8,
                    background: '#10b981',
                    color: '#000',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 20,
                    fontWeight: 800,
                    flexShrink: 0
                  }}
                >
                  🎙️
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#34d399' }}>
                    Зөвхөн дуу хоолой үүсгэх горим идэвхтэй (Voice Only)
                  </div>
                  <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 3, lineHeight: 1.45 }}>
                    Таны оруулсан текстийг бүртгэлтэй {metrics.activeKeyCount} түлхүүрээр зэрэгцүүлэн уншуулж, 100% цэвэр студи дууг <strong>Timeline-ийн Audio зам</strong> болон <strong>Медиа санд</strong> автоматаар байршуулна. Видео бичлэг сонгох шаардлагагүй.
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={handleSaveMp3Directly}
                disabled={busy || !scriptText.trim() || !hasApiKey || metrics.exceedsCapacity}
                style={{
                  padding: '8px 14px',
                  borderRadius: 6,
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.45)',
                  color: '#34d399',
                  fontSize: 11,
                  fontWeight: 650,
                  cursor: (busy || !scriptText.trim()) ? 'default' : 'pointer',
                  whiteSpace: 'nowrap',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6
                }}
                title="Үүсгэсэн дуу хоолойг шууд компьютер дээрээ MP3 файл болгон хадгалах"
              >
                <span>💾</span>
                <span>Шууд MP3 татах...</span>
              </button>
            </div>
          ) : (
            /* Voice + Video Sync Panels */
            <>
              {/* Rule 1 Engine: Video Matching Mode */}
              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 8,
                  background: 'rgba(0, 196, 140, 0.08)',
                  border: '1px solid rgba(0, 196, 140, 0.25)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#00c48c', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>🎯 Rule 1: Видеог зөв дарааллаар нь тааруулах</span>
                  </div>
                  <span style={{ fontSize: 11, color: '#8e929d' }}>
                    (Хэзээ ч хойшоо үсрэхгүй, 100% хронологийн дарааллаар)
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {/* Primary Recommended Option: Dynamic Hybrid */}
                  <button
                    type="button"
                    onClick={() => setMode('hybrid')}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 8,
                      background: mode === 'hybrid' ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.22) 0%, rgba(0, 196, 140, 0.22) 100%)' : 'rgba(255,255,255,0.04)',
                      border: `1.5px solid ${mode === 'hybrid' ? '#00c48c' : 'rgba(255,255,255,0.1)'}`,
                      color: mode === 'hybrid' ? '#fff' : '#aaa',
                      textAlign: 'left',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 12,
                      boxShadow: mode === 'hybrid' ? '0 4px 16px rgba(0, 196, 140, 0.18)' : 'none'
                    }}
                  >
                    <div style={{ fontSize: 22, marginTop: 2 }}>✨</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: mode === 'hybrid' ? '#34d399' : '#fff' }}>
                          Ухаалаг Холимог (Hybrid Pro Director)
                        </span>
                        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: '#00c48c', color: '#000', fontWeight: 800 }}>
                          САНАЛ БОЛГОХ · ДЭЛХИЙН ТҮВШИН
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, lineHeight: 1.45 }}>
                        🎬 <strong>Хөдөлгөөнтэй үед нь тасалж (Cut)</strong> тоглуулаад, ❄️ <strong>өгүүлбэр үргэлжлэх үед төгсгөл дээр нь царцаан (Freeze)</strong> барьж, өгүүлбэр дуусмагц дараагийн үзэгдэл рүү тасална (100% Voice Sync).
                      </div>
                    </div>
                  </button>

                  {/* Secondary Options: Dedicated Freeze or Cut */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => setMode('freeze')}
                      style={{
                        padding: '8px 12px',
                        borderRadius: 6,
                        background: mode === 'freeze' ? 'rgba(0, 196, 140, 0.2)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${mode === 'freeze' ? '#00c48c' : 'rgba(255,255,255,0.08)'}`,
                        color: mode === 'freeze' ? '#fff' : '#888',
                        textAlign: 'left',
                        cursor: 'pointer'
                      }}
                    >
                      <div style={{ fontSize: 11, fontWeight: 650 }}>❄️ Дан Царцаах (Full Freeze)</div>
                      <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>Зураг бүрийг бүтэн өгүүлбэрийн хугацаанд царцаана.</div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setMode('cut')}
                      style={{
                        padding: '8px 12px',
                        borderRadius: 6,
                        background: mode === 'cut' ? 'rgba(0, 196, 140, 0.2)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${mode === 'cut' ? '#00c48c' : 'rgba(255,255,255,0.08)'}`,
                        color: mode === 'cut' ? '#fff' : '#888',
                        textAlign: 'left',
                        cursor: 'pointer'
                      }}
                    >
                      <div style={{ fontSize: 11, fontWeight: 650 }}>🎬 Дан Таслах (Full Motion Cut)</div>
                      <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>Царцаахгүйгээр зөвхөн хөдөлгөөнт видеог тасалж урагшлуулна.</div>
                    </button>
                  </div>
                </div>

                {/* Pacing & Vision option */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4, fontSize: 11, color: '#8e929d' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>Зургийн шилжилт:</span>
                    <select
                      value={panelPacing}
                      disabled={busy}
                      onChange={(e) => setPanelPacing(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
                      style={{
                        padding: '3px 8px',
                        borderRadius: 4,
                        background: '#191a22',
                        border: '1px solid rgba(255,255,255,0.12)',
                        color: '#fff',
                        fontSize: 11
                      }}
                    >
                      <option value="auto">Автомат үзэгдэл танилт</option>
                      <option value={2.0}>2.0 секунд тутамд</option>
                      <option value={2.5}>2.5 секунд тутамд</option>
                      <option value={3.0}>3.0 секунд тутамд</option>
                      <option value={3.5}>3.5 секунд тутамд</option>
                    </select>
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#8e929d' }}>
                    <input
                      type="checkbox"
                      checked={useVision}
                      disabled={busy}
                      onChange={(e) => setUseVision(e.target.checked)}
                    />
                    <span>Gemini Vision ашиглах (Дараалал алдагдсан үед)</span>
                  </label>
                </div>
              </div>

              {/* Source Video Selection */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: 12,
                  borderRadius: 8,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.06)'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#aaa' }}>
                    Эх видео (Манхва бичлэг):
                  </label>
                  <button
                    type="button"
                    className="btn"
                    onClick={handlePickVideo}
                    disabled={busy}
                    style={{
                      padding: '3px 10px',
                      fontSize: 11,
                      background: 'rgba(255,255,255,0.08)',
                      color: '#ddd',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 4
                    }}
                  >
                    📁 Өөр файл сонгох...
                  </button>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input
                    type="text"
                    readOnly
                    value={videoPath || 'Видео сонгогдоогүй байна'}
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      fontSize: 12,
                      borderRadius: 6,
                      background: '#101116',
                      border: '1px solid rgba(255,255,255,0.1)',
                      color: videoPath ? '#e4e4e7' : '#71717a'
                    }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 11, color: '#888' }}>Эхлэх секунд:</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={sourceOffset}
                      disabled={busy}
                      onChange={(e) => setSourceOffset(Math.max(0, Number(e.target.value) || 0))}
                      style={{
                        width: 70,
                        padding: '6px 8px',
                        fontSize: 12,
                        borderRadius: 6,
                        background: '#101116',
                        border: '1px solid rgba(255,255,255,0.1)',
                        color: '#fff',
                        textAlign: 'center'
                      }}
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Progress / Status Display during generation */}
          {busy && (
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 8,
                background: 'rgba(99, 102, 241, 0.1)',
                border: '1px solid rgba(99, 102, 241, 0.3)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 650, color: '#a5b4fc' }}>
                <span>{progressMsg || 'Боловсруулж байна...'}</span>
                <span>{progressPct}%</span>
              </div>
              <div
                style={{
                  width: '100%',
                  height: 6,
                  borderRadius: 3,
                  background: 'rgba(255,255,255,0.1)',
                  overflow: 'hidden'
                }}
              >
                <div
                  style={{
                    width: `${progressPct}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, #6366f1 0%, #00c48c 100%)',
                    transition: 'width 0.3s ease'
                  }}
                />
              </div>
            </div>
          )}

          {/* Error Message Display */}
          {errorMsg && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 6,
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                color: '#f87171',
                fontSize: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 8
              }}
            >
              <div>⚠️ {errorMsg}</div>
              {(errorMsg.includes('402') || errorMsg.includes('library voices')) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedVoiceId(DEFAULT_VOICE_ID);
                      setErrorMsg('');
                    }}
                    style={{
                      padding: '5px 12px',
                      borderRadius: 4,
                      background: '#10b981',
                      color: '#000',
                      fontWeight: 700,
                      fontSize: 11,
                      border: 'none',
                      cursor: 'pointer'
                    }}
                  >
                    🎙️ Үндсэн Liam (Free API дэмждэг) хоолой руу шилжих
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer Actions */}
        <div
          style={{
            padding: '14px 20px',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            background: '#101116',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div style={{ fontSize: 11, color: '#71717a' }}>
            ⚡ {metrics.maxCapacity.toLocaleString()} тэмдэгт хүртэл ({metrics.activeKeyCount} түлхүүрээр зэрэг уншина)
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={busy}
              style={{ padding: '7px 16px', fontSize: 12 }}
            >
              Болих
            </button>

            {studioMode === 'voice_only' ? (
              <button
                type="button"
                className="btn"
                disabled={busy || !scriptText.trim() || !hasApiKey || metrics.exceedsCapacity}
                onClick={() => handleRun(true)}
                style={{
                  padding: '8px 24px',
                  fontSize: 13,
                  fontWeight: 700,
                  background: (busy || metrics.exceedsCapacity || !scriptText.trim())
                    ? '#3f3f46'
                    : 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  boxShadow: (busy || metrics.exceedsCapacity || !scriptText.trim()) ? 'none' : '0 4px 14px rgba(16, 185, 129, 0.45)',
                  cursor: (busy || metrics.exceedsCapacity || !scriptText.trim()) ? 'default' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8
                }}
              >
                <span>{busy ? '⏳' : '🎙️'}</span>
                <span>
                  {busy
                    ? 'Хоолойг үүсгэж байна...'
                    : `Зөвхөн хоолой үүсгэх (${metrics.chunks.length} хэсэг)`}
                </span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !scriptText.trim() || !hasApiKey || metrics.exceedsCapacity}
                  onClick={() => handleRun(true)}
                  style={{
                    padding: '8px 14px',
                    fontSize: 12,
                    fontWeight: 650,
                    background: 'rgba(16, 185, 129, 0.15)',
                    border: '1px solid rgba(16, 185, 129, 0.4)',
                    color: '#34d399',
                    borderRadius: 6,
                    cursor: (busy || !scriptText.trim()) ? 'default' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6
                  }}
                  title="Эх видеонд тааруулахгүйгээр зөвхөн дуу хоолойг Timeline-д оруулах"
                >
                  <span>🎙️</span>
                  <span>Зөвхөн хоолой</span>
                </button>

                <button
                  type="button"
                  className="btn"
                  disabled={busy || !scriptText.trim() || !videoPath || !hasApiKey || metrics.exceedsCapacity}
                  onClick={() => handleRun(false)}
                  style={{
                    padding: '8px 22px',
                    fontSize: 13,
                    fontWeight: 650,
                    background: (busy || metrics.exceedsCapacity || !videoPath || !scriptText.trim())
                      ? '#3f3f46'
                      : 'linear-gradient(135deg, #6366f1 0%, #00c48c 100%)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    boxShadow: (busy || metrics.exceedsCapacity || !videoPath) ? 'none' : '0 4px 14px rgba(0, 196, 140, 0.4)',
                    cursor: (busy || metrics.exceedsCapacity || !videoPath) ? 'default' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8
                  }}
                >
                  <span>{busy ? '⏳' : '🚀'}</span>
                  <span>
                    {busy
                      ? 'Боловсруулж байна...'
                      : `Хоолой үүсгэж, Дүрсэнд тааруулах (${metrics.chunks.length} хэсэг)`}
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
