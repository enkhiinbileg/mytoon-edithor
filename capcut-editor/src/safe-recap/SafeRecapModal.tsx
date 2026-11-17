import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../store';
import type { SafeRecapBgState, Voice } from '../types';
import SafeCropEditorModal from './SafeCropEditorModal';
import { applySafePlanToTimeline, buildSafeKeyframes, createInstantSafePlan } from './safeMotion';
import type {
  SafeBeat,
  SafeCensorMode,
  SafeEnvStatus,
  SafeMotionType,
  SafePanelItem,
  SafePlanRow,
  SafeRecapSession,
  SafeSessionSummary,
  SafeStrictness,
  SafeWhisperModel
} from './types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onMinimize?: () => void;
  onBackgroundStateChange?: (state: SafeRecapBgState) => void;
  onSuccessNotice?: (msg: string) => void;
}

const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;

function formatRelTime(ts: number): string {
  if (!ts) return '';
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'Дөнгөж сая';
  if (diffMin < 60) return `${diffMin} мин өмнө`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} цагийн өмнө`;
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const STAGE_LABELS: Record<string, string> = {
  panels: 'Зураг',
  safety: '+18 Шүүлт',
  voice: 'Дуу',
  whisper: 'Whisper',
  fix: 'Скрипт засвар',
  align: 'AI Уялдаа',
  timeline: 'Timeline'
};

const STATUS_BADGE: Record<SafePanelItem['safetyStatus'], { label: string; bg: string; fg: string; icon: string }> = {
  safe: { label: 'Аюулгүй', bg: 'rgba(16,185,129,0.18)', fg: '#34d399', icon: '🟢' },
  cropped: { label: 'Царай Crop', bg: 'rgba(245,158,11,0.2)', fg: '#fbbf24', icon: '🟡' },
  blurred: { label: 'Blur/Mask', bg: 'rgba(245,158,11,0.2)', fg: '#fbbf24', icon: '🟡' },
  excluded: { label: 'Хасагдсан (+18)', bg: 'rgba(239,68,68,0.2)', fg: '#f87171', icon: '🔴' },
  unchecked: { label: 'Шалгаагүй', bg: 'rgba(113,113,122,0.2)', fg: '#a1a1aa', icon: '⚪' }
};

export default function SafeRecapModal({
  isOpen,
  onClose,
  onMinimize,
  onBackgroundStateChange,
  onSuccessNotice
}: Props) {
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const initializedRef = useRef(false);
  const [sessionId, setSessionId] = useState<string>(() => `sr_${Date.now()}`);
  const [sessionName, setSessionName] = useState<string>('Вебтүүн Safe Recap');
  const [savedSessions, setSavedSessions] = useState<SafeSessionSummary[]>([]);
  const [completedStages, setCompletedStages] = useState<string[]>([]);

  // Environment & Whisper status
  const [envStatus, setEnvStatus] = useState<SafeEnvStatus | null>(null);
  const [whisperModels, setWhisperModels] = useState<SafeWhisperModel[]>([]);
  const [whisperModel, setWhisperModel] = useState<string>('groq-whisper-large-v3');
  const [autoTagScript, setAutoTagScript] = useState<boolean>(false);

  // Inputs
  const [inputMode, setInputMode] = useState<'script' | 'audio_srt'>('script');
  const [scriptText, setScriptText] = useState<string>('');
  const [audioPath, setAudioPath] = useState<string>('');
  const [audioName, setAudioName] = useState<string>('');
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [subFileName, setSubFileName] = useState<string>('');
  const [subtitleMethod, setSubtitleMethod] = useState<string>('');
  const [draftBeats, setDraftBeats] = useState<SafeBeat[]>([]);
  const [beats, setBeats] = useState<SafeBeat[]>([]);

  // TTS controls
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('TX3LPaxmHKxFdv7VOQHJ');
  const [ttsModelId, setTtsModelId] = useState<string>('eleven_v4');

  // Panels & Safety Settings
  const [rawPickedPaths, setRawPickedPaths] = useState<string[]>([]);
  const [panels, setPanels] = useState<SafePanelItem[]>([]);
  const [sliceMode, setSliceMode] = useState<'smart' | 'none'>('smart');
  const [censorMode, setCensorMode] = useState<SafeCensorMode>('blur');
  const [strictness, setStrictness] = useState<SafeStrictness>('balanced');

  // Storyboard Settings & Plan
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16'>('16:9');
  const [fitMode, setFitMode] = useState<'contain' | 'cover'>('contain');
  const [includeCaptions, setIncludeCaptions] = useState<boolean>(true);
  const [plan, setPlan] = useState<SafePlanRow[]>([]);

  // Review UI filters & modals
  const [activeTab, setActiveTab] = useState<'storyboard' | 'excluded' | 'history'>('storyboard');
  const [statusFilter, setStatusFilter] = useState<'all' | 'safe' | 'review'>('all');
  const [editingPanel, setEditingPanel] = useState<SafePanelItem | null>(null);
  const [pickingRowId, setPickingRowId] = useState<string | null>(null);

  // Progress & Status
  const [busy, setBusy] = useState<boolean>(false);
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');

  // Audio playback per beat
  const [playingRowId, setPlayingRowId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const refreshHistory = async () => {
    const sr = window.api.safeRecap;
    if (!sr) return;
    try {
      const res = await sr.listSessions();
      if (res.ok && res.sessions) setSavedSessions(res.sessions);
    } catch {}
  };

  const persistSession = async (overrides: Partial<SafeRecapSession> = {}, addStages: string[] = []) => {
    const sr = window.api.safeRecap;
    if (!sr) return;
    const nextStages = Array.from(new Set([...(overrides.completedStages || completedStages), ...addStages]));
    if (addStages.length) setCompletedStages(nextStages);

    const payload: SafeRecapSession = {
      id: overrides.id ?? sessionId,
      name: overrides.name ?? sessionName,
      updatedAt: Date.now(),
      inputMode: overrides.inputMode ?? inputMode,
      scriptText: overrides.scriptText ?? scriptText,
      audioPath: overrides.audioPath ?? audioPath,
      audioName: overrides.audioName ?? audioName,
      audioDuration: overrides.audioDuration ?? audioDuration,
      subFileName: overrides.subFileName ?? subFileName,
      subtitles: overrides.subtitles ?? beats,
      draftSubtitles: overrides.draftSubtitles ?? draftBeats,
      subtitleMethod: overrides.subtitleMethod ?? subtitleMethod,
      whisperModel: overrides.whisperModel ?? whisperModel,
      autoTagScript: overrides.autoTagScript ?? autoTagScript,
      rawPickedPaths: overrides.rawPickedPaths ?? rawPickedPaths,
      sliceMode: overrides.sliceMode ?? sliceMode,
      censorMode: overrides.censorMode ?? censorMode,
      strictness: overrides.strictness ?? strictness,
      aspectRatio: overrides.aspectRatio ?? aspectRatio,
      fitMode: overrides.fitMode ?? fitMode,
      includeCaptions: overrides.includeCaptions ?? includeCaptions,
      completedStages: nextStages,
      panels: overrides.panels ?? panels,
      plan: overrides.plan ?? plan
    };

    try {
      const res = await sr.saveSession(payload);
      if (res?.ok && res.name) setSessionName(res.name);
      await refreshHistory();
    } catch {}
  };

  // Keep SafeRecap progress listener alive even when minimized to background
  useEffect(() => {
    const sr = window.api.safeRecap;
    if (!sr) return;
    const unsub = sr.onProgress((p) => {
      if (p.message) setStatusMsg(p.message);
      if (typeof p.percent === 'number') setProgressPct(p.percent);
    });
    return () => {
      unsub();
      audioRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      audioRef.current?.pause();
      setPlayingRowId(null);
      return;
    }
    const sr = window.api.safeRecap;
    if (!sr) return;

    sr.checkEnv().then(setEnvStatus).catch(() => {});
    refreshHistory();

    if (!initializedRef.current) {
      initializedRef.current = true;
      sr.getWhisperStatus?.()
        .then((wRes) => {
          if (wRes?.ok && Array.isArray(wRes.models)) {
            setWhisperModels(wRes.models);
            const installed = wRes.models.filter((m) => m.installed);
            const def = installed.find((m) => m.id === 'groq-whisper-large-v3') || installed[0];
            if (def) setWhisperModel(def.id);
          }
        })
        .catch(() => {});

      window.api
        .listVoices?.('elevenlabs')
        .then((vRes) => {
          if (vRes?.ok && vRes.voices?.length) setVoices(vRes.voices);
        })
        .catch(() => {});
    }

    // Auto-detect existing Timeline audio/subtitles only if current session has none yet
    const store = useEditor.getState();
    if (!audioPath && !panels.length && !scriptText) {
      const aTrack = store.tracks.find((t) => t.kind === 'audio');
      const aClips = aTrack ? store.clips.filter((c) => c.trackId === aTrack.id && c.kind === 'av') : [];
      if (aClips.length > 0) {
        const media = store.media.find((m) => m.id === aClips[0].mediaId);
        if (media) {
          setAudioPath(media.path);
          setAudioName(media.name);
          setAudioDuration(aClips.reduce((acc, c) => Math.max(acc, c.start + (c.outPoint - c.inPoint)), 0));
        }
      }
    }
    if (beats.length === 0 && !panels.length && !scriptText) {
      const textClips = store.clips
        .filter((c) => c.kind === 'text' && c.style?.text?.trim())
        .sort((a, b) => a.start - b.start);
      if (textClips.length > 0) {
        setBeats(
          textClips.map((c, idx) => ({
            id: `tl_${idx + 1}`,
            start: c.start,
            end: c.start + Math.max(0.25, c.outPoint - c.inPoint),
            text: c.style!.text.trim()
          }))
        );
        setSubFileName(`Timeline (${textClips.length} мөр)`);
      }
    }
  }, [isOpen]);

  useEffect(() => {
    onBackgroundStateChange?.({
      busy,
      progressPct,
      statusMsg,
      errorMsg,
      sessionName,
      panelCount: panels.length,
      planCount: plan.length
    });
  }, [onBackgroundStateChange, busy, progressPct, statusMsg, errorMsg, sessionName, panels.length, plan.length]);

  const counts = useMemo(() => {
    let safe = 0;
    let review = 0;
    let excluded = 0;
    for (const p of panels) {
      if (p.safetyStatus === 'safe') safe++;
      else if (p.safetyStatus === 'cropped' || p.safetyStatus === 'blurred') review++;
      else if (p.safetyStatus === 'excluded') excluded++;
    }
    return { total: panels.length, safe, review, excluded };
  }, [panels]);

  const filteredPlan = useMemo(() => {
    if (statusFilter === 'safe') return plan.filter((r) => r.safetyStatus === 'safe');
    if (statusFilter === 'review')
      return plan.filter((r) => r.safetyStatus === 'cropped' || r.safetyStatus === 'blurred' || r.needsReview || r.isFallback);
    return plan;
  }, [plan, statusFilter]);

  const safeAvailablePanels = useMemo(() => panels.filter((p) => p.safetyStatus !== 'excluded'), [panels]);
  const excludedPanels = useMemo(() => panels.filter((p) => p.safetyStatus === 'excluded'), [panels]);

  const sr = window.api.safeRecap;

  const handleStartNewSession = () => {
    audioRef.current?.pause();
    setPlayingRowId(null);
    setSessionId(`sr_${Date.now()}`);
    setSessionName('Вебтүүн Safe Recap');
    setCompletedStages([]);
    setScriptText('');
    setAudioPath('');
    setAudioName('');
    setAudioDuration(0);
    setSubFileName('');
    setSubtitleMethod('');
    setDraftBeats([]);
    setBeats([]);
    setRawPickedPaths([]);
    setPanels([]);
    setPlan([]);
    setActiveTab('storyboard');
    setStatusMsg('Шинэ ажлын талбар үүслээ.');
    setErrorMsg('');
  };

  const handleSetupEnv = async () => {
    if (!sr) return;
    setBusy(true);
    setErrorMsg('');
    setProgressPct(5);
    setStatusMsg('Локал шүүлтийн сан суулгаж байна...');
    try {
      const res = await sr.setupEnv();
      setEnvStatus(res);
      if (res.ok) {
        setStatusMsg('✓ Локал ONNX шүүгч бэлэн боллоо!');
        if (!isOpenRef.current) onSuccessNotice?.('🛡️ Safe +18: Локал ONNX шүүгч бэлэн боллоо!');
      } else {
        setErrorMsg(res.error || 'Суулгалтад алдаа гарлаа.');
        if (!isOpenRef.current) onSuccessNotice?.(`⚠️ Safe +18 алдаа: ${res.error || 'Суулгалтад алдаа гарлаа.'}`);
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      setErrorMsg(msg);
      if (!isOpenRef.current) onSuccessNotice?.(`⚠️ Safe +18 алдаа: ${msg}`);
    } finally {
      setBusy(false);
      setProgressPct(null);
    }
  };

  const handlePickImages = async (mode: 'files' | 'folder') => {
    if (!sr) return;
    setBusy(true);
    setErrorMsg('');
    try {
      const picked = await window.api.openImagesOrFolder(mode);
      if (!picked?.length) return;
      setRawPickedPaths(picked);
      setStatusMsg('Вебтүүн кадруудыг бэлдэж байна...');
      const res = await sr.preparePanels({ paths: picked, sliceMode, sessionId });
      if (res.ok && res.panels) {
        setPanels(res.panels);
        setStatusMsg(`✓ Нийт ${res.panels.length} кадр бэлдлээ. Одоо "1. Локал +18 Шүүлт" дарна уу.`);
        await persistSession({ rawPickedPaths: picked, panels: res.panels }, ['panels']);
      } else {
        setErrorMsg(res.error || 'Зураг уншиж чадсангүй.');
      }
    } catch (e: any) {
      setErrorMsg(e?.message || String(e));
    } finally {
      setBusy(false);
      setProgressPct(null);
    }
  };

  const handleRunSafetyScan = async () => {
    if (!sr || !panels.length) return;
    setBusy(true);
    setErrorMsg('');
    setProgressPct(5);
    try {
      const res = await sr.analyzePanels({
        panels,
        sessionId,
        strictness,
        defaultCensorMode: censorMode
      });
      if (res.ok && res.panels) {
        setPanels(res.panels);
        const sCount = res.panels.filter((p) => p.safetyStatus === 'safe').length;
        const mCount = res.panels.filter((p) => p.safetyStatus === 'cropped' || p.safetyStatus === 'blurred').length;
        const xCount = res.panels.filter((p) => p.safetyStatus === 'excluded').length;
        const summary = `✓ Шүүлт дууслаа: 🟢 ${sCount} аюулгүй · 🟡 ${mCount} тайрсан/blur · 🔴 ${xCount} хассан`;
        setStatusMsg(summary);

        let nextPlan = plan;
        if (beats.length > 0 && res.panels.some((p) => p.safetyStatus !== 'excluded')) {
          nextPlan = createInstantSafePlan({
            beats,
            panels: res.panels,
            audioDuration,
            aspect: aspectRatio
          });
          setPlan(nextPlan);
        }
        await persistSession({ panels: res.panels, plan: nextPlan }, ['safety']);
        if (!isOpenRef.current) onSuccessNotice?.(`🛡️ Safe +18 ${summary}`);
      } else {
        const msg = res.error || 'Локал шүүлт амжилтгүй боллоо.';
        setErrorMsg(msg);
        if (!isOpenRef.current) onSuccessNotice?.(`⚠️ Safe +18 алдаа: ${msg}`);
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      setErrorMsg(msg);
      if (!isOpenRef.current) onSuccessNotice?.(`⚠️ Safe +18 алдаа: ${msg}`);
    } finally {
      setBusy(false);
      setProgressPct(null);
    }
  };

  const handleImportScriptTxt = async () => {
    if (!sr) return;
    const res = await sr.pickScriptFile();
    if (res.ok && !res.canceled && res.text) {
      const nextName = res.name?.replace(/\.[^.]+$/, '') || sessionName;
      setScriptText(res.text);
      setSessionName(nextName);
      await persistSession({ scriptText: res.text, name: nextName });
    }
  };

  const handleSplitScriptToBeats = async () => {
    if (!sr || !scriptText.trim()) return;
    const res = await sr.splitScriptToBeats({ scriptText });
    if (res.ok && res.beats) {
      setBeats(res.beats);
      setSubtitleMethod('script-estimate');
      setSubFileName(`Текст скрипт (${res.beats.length} өгүүлбэр · урьдчилсан хугацаа)`);
      let nextPlan = plan;
      if (safeAvailablePanels.length > 0) {
        nextPlan = createInstantSafePlan({ beats: res.beats, panels, audioDuration: res.duration || 0, aspect: aspectRatio });
        setPlan(nextPlan);
      }
      setStatusMsg(`✓ Скриптийг ${res.beats.length} өгүүлбэр болгон хуваалаа.`);
      await persistSession({ subtitles: res.beats, subtitleMethod: 'script-estimate', subFileName: `Текст скрипт (${res.beats.length} мөр)`, plan: nextPlan });
    }
  };

  const handleGenerateVoiceAndSubtitles = async () => {
    if (!sr || !scriptText.trim()) return;
    setBusy(true);
    setErrorMsg('');
    setProgressPct(5);
    try {
      const res = await sr.generateVoiceFromScript({
        sessionId,
        scriptText,
        voiceId: selectedVoiceId,
        modelId: ttsModelId,
        autoTagScript,
        whisperModel
      });
      if (res.ok && res.audioPath && res.beats) {
        const aName = res.audioPath.split(/[\\/]/).pop() || 'voice.mp3';
        const dur = res.duration || 0;
        const dBeats = res.draftBeats || [];
        const method = res.subtitleMethod || 'whisper+script-fix';
        const sName = `Whisper + Скрипт засвар (${res.beats.length} мөр)`;

        setAudioPath(res.audioPath);
        setAudioName(aName);
        setAudioDuration(dur);
        setDraftBeats(dBeats);
        setBeats(res.beats);
        setSubtitleMethod(method);
        setSubFileName(sName);

        let nextPlan = plan;
        if (safeAvailablePanels.length > 0) {
          nextPlan = createInstantSafePlan({ beats: res.beats, panels, audioDuration: dur, aspect: aspectRatio });
          setPlan(nextPlan);
        }

        const warnNote = res.whisperWarning ? ` (${res.whisperWarning})` : '';
        const summary = `✓ Дуу (${clock(dur)}) → ${method} → ${res.beats.length} цэвэр хадмал бэлэн боллоо!${warnNote}`;
        setStatusMsg(summary);

        const stages = ['voice', ...(dBeats.length ? ['whisper'] : []), ...(method.includes('script-fix') ? ['fix'] : [])];
        await persistSession(
          {
            audioPath: res.audioPath,
            audioName: aName,
            audioDuration: dur,
            draftSubtitles: dBeats,
            subtitles: res.beats,
            subtitleMethod: method,
            subFileName: sName,
            plan: nextPlan
          },
          stages
        );
        if (!isOpenRef.current) onSuccessNotice?.(`🛡️ Safe +18: ${summary}`);
      } else {
        const msg = res.error || 'Дуу ба хадмал үүсгэж чадсангүй.';
        setErrorMsg(msg);
        if (!isOpenRef.current) onSuccessNotice?.(`⚠️ Safe +18 алдаа: ${msg}`);
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      setErrorMsg(msg);
      if (!isOpenRef.current) onSuccessNotice?.(`⚠️ Safe +18 алдаа: ${msg}`);
    } finally {
      setBusy(false);
      setProgressPct(null);
    }
  };

  const handleFixSubtitlesWithScript = async () => {
    if (!sr || !scriptText.trim() || !(draftBeats.length || beats.length)) return;
    setBusy(true);
    setErrorMsg('');
    try {
      const sourceDraft = draftBeats.length ? draftBeats : beats;
      const res = await sr.fixSubtitlesWithScript({
        scriptText,
        draftBeats: sourceDraft,
        audioDuration
      });
      if (res.ok && res.beats) {
        const method = `${subtitleMethod ? subtitleMethod.replace(/\+script-fix$/, '') : 'srt'}+script-fix`;
        const sName = `Скриптээр зассан (${res.beats.length} мөр)`;
        setBeats(res.beats);
        setSubtitleMethod(method);
        setSubFileName(sName);

        let nextPlan = plan;
        if (safeAvailablePanels.length > 0) {
          nextPlan = createInstantSafePlan({ beats: res.beats, panels, audioDuration, aspect: aspectRatio });
          setPlan(nextPlan);
        }
        setStatusMsg(`✓ ${res.message || 'Хадмалыг скриптээр заслаа'} (${res.beats.length} мөр).`);
        await persistSession({ subtitles: res.beats, subtitleMethod: method, subFileName: sName, plan: nextPlan }, ['fix']);
      } else {
        setErrorMsg(res.error || 'Хадмал засахад алдаа гарлаа.');
      }
    } catch (e: any) {
      setErrorMsg(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const handlePickAudio = async () => {
    if (!sr) return;
    const res = await sr.pickAudioFile();
    if (res.ok && !res.canceled && res.path) {
      setAudioPath(res.path);
      setAudioName(res.name || '');
      setAudioDuration(res.duration || 0);
      await persistSession({ audioPath: res.path, audioName: res.name || '', audioDuration: res.duration || 0 }, ['voice']);
    }
  };

  const handlePickSrt = async () => {
    if (!sr) return;
    const res = await sr.openSrtAndParse();
    if (res.ok && !res.canceled && res.beats) {
      setDraftBeats(res.beats);
      setBeats(res.beats);
      setSubtitleMethod('srt');
      setSubFileName(res.name || `${res.beats.length} мөр`);
      let nextPlan = plan;
      if (safeAvailablePanels.length > 0) {
        nextPlan = createInstantSafePlan({ beats: res.beats, panels, audioDuration, aspect: aspectRatio });
        setPlan(nextPlan);
      }
      await persistSession({ draftSubtitles: res.beats, subtitles: res.beats, subtitleMethod: 'srt', subFileName: res.name || '', plan: nextPlan });
    }
  };

  const handleRunAiAlign = async () => {
    if (!sr) return;
    setErrorMsg('');

    let activeBeats = beats;
    if (!activeBeats.length && scriptText.trim()) {
      const sp = await sr.splitScriptToBeats({ scriptText });
      if (sp.ok && sp.beats?.length) {
        activeBeats = sp.beats;
        setBeats(sp.beats);
      }
    }
    if (!activeBeats.length) {
      setErrorMsg('Эхлээд скриптээс Дуу+Хадмал үүсгэх эсвэл SRT хадмал оруулна уу.');
      return;
    }
    if (!safeAvailablePanels.length) {
      setErrorMsg('Эхлээд зургуудаа оруулж Локал +18 Шүүлт хийнэ үү.');
      return;
    }

    setBusy(true);
    setProgressPct(5);
    try {
      const res = await sr.align({
        sessionId,
        beats: activeBeats,
        panels,
        audioDuration,
        aspectRatio,
        useAi: true
      });
      if (res.ok && res.plan) {
        setPlan(res.plan);
        setActiveTab('storyboard');
        let nextPanels = panels;
        const blockedCount = res.blockedPanelIds?.length || 0;
        if (blockedCount > 0) {
          nextPanels = panels.map((p) =>
            res.blockedPanelIds!.includes(p.id)
              ? { ...p, safetyStatus: 'excluded', safetyReason: 'Cloud safety шүүлтүүрээр хассан' }
              : p
          );
          setPanels(nextPanels);
        }
        const summary = `✓ Зассан хадмалтай зургуудыг таарууллаа (${res.plan.length} мөр)${blockedCount ? ` · ${blockedCount} сэжигтэй кадр нэмэлтээр хасагдлаа` : ''}.`;
        setStatusMsg(summary);
        await persistSession({ panels: nextPanels, plan: res.plan, subtitles: activeBeats }, ['align']);
        if (!isOpenRef.current) onSuccessNotice?.(`🛡️ Safe +18: ${summary}`);
      } else {
        const msg = res.error || 'AI тааруулалтад алдаа гарлаа.';
        setErrorMsg(msg);
        if (!isOpenRef.current) onSuccessNotice?.(`⚠️ Safe +18 алдаа: ${msg}`);
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      setErrorMsg(msg);
      if (!isOpenRef.current) onSuccessNotice?.(`⚠️ Safe +18 алдаа: ${msg}`);
    } finally {
      setBusy(false);
      setProgressPct(null);
    }
  };

  const handleSaveEditedPanel = async (updated: SafePanelItem) => {
    const nextPanels = panels.map((p) => (p.id === updated.id ? updated : p));
    const nextPlan = plan.map((row) =>
      row.panelId === updated.id
        ? {
            ...row,
            sanitizedPath: updated.sanitizedRenderPath || updated.sanitizedThumbPath || row.imagePath,
            imageWidth: updated.sanitizedWidth || updated.width,
            imageHeight: updated.sanitizedHeight || updated.height,
            safetyStatus: updated.safetyStatus,
            cropRect: updated.cropRect || null,
            censorBoxes: updated.censorBoxes || [],
            needsReview: updated.needsReview,
            safetyReason: updated.safetyReason
          }
        : row
    );
    setPanels(nextPanels);
    setPlan(nextPlan);
    await persistSession({ panels: nextPanels, plan: nextPlan });
  };

  const handleReplaceRowPanel = async (rowId: string, panel: SafePanelItem) => {
    const nextPlan = plan.map((r) =>
      r.id === rowId
        ? {
            ...r,
            panelId: panel.id,
            imagePath: panel.path,
            sanitizedPath: panel.sanitizedRenderPath || panel.sanitizedThumbPath || panel.path,
            imageWidth: panel.sanitizedWidth || panel.width,
            imageHeight: panel.sanitizedHeight || panel.height,
            imageName: panel.name,
            safetyStatus: panel.safetyStatus,
            cropRect: panel.cropRect || null,
            censorBoxes: panel.censorBoxes || [],
            needsReview: false,
            isFallback: false,
            safetyReason: panel.safetyReason
          }
        : r
    );
    setPlan(nextPlan);
    setPickingRowId(null);
    await persistSession({ plan: nextPlan });
  };

  const handleChangeRowMotion = (rowId: string, motion: SafeMotionType) => {
    setPlan((prev) =>
      prev.map((r) =>
        r.id === rowId
          ? {
              ...r,
              motion,
              keyframes: buildSafeKeyframes(motion, r.duration, r.safetyStatus === 'cropped')
            }
          : r
      )
    );
  };

  const handlePlayBeat = (row: SafePlanRow) => {
    if (!audioPath) return;
    if (playingRowId === row.id) {
      audioRef.current?.pause();
      setPlayingRowId(null);
      return;
    }
    if (!audioRef.current || audioRef.current.dataset.src !== audioPath) {
      audioRef.current?.pause();
      const a = new Audio(window.api.toMediaUrl(audioPath));
      a.dataset.src = audioPath;
      audioRef.current = a;
    }
    const a = audioRef.current;
    a.currentTime = row.start;
    a.play().catch(() => {});
    setPlayingRowId(row.id);
    const check = () => {
      if (a.currentTime >= row.end || a.paused) {
        a.pause();
        setPlayingRowId(null);
        a.removeEventListener('timeupdate', check);
      }
    };
    a.addEventListener('timeupdate', check);
  };

  const handleManualSave = async () => {
    await persistSession();
    setStatusMsg('✓ Түүхэд хадгаллаа.');
  };

  const handleLoadSession = async (id: string) => {
    if (!sr || !id) return;
    const res = await sr.loadSession(id);
    const s = res.session;
    if (!s) return;
    audioRef.current?.pause();
    setPlayingRowId(null);
    setSessionId(s.id);
    setSessionName(s.name || 'Safe Recap');
    setCompletedStages(s.completedStages || []);
    setInputMode(s.inputMode || 'script');
    setScriptText(s.scriptText || '');
    setAudioPath(s.audioPath || '');
    setAudioName(s.audioName || '');
    setAudioDuration(s.audioDuration || 0);
    setSubFileName(s.subFileName || '');
    setSubtitleMethod(s.subtitleMethod || '');
    setDraftBeats(s.draftSubtitles || []);
    setBeats(s.subtitles || []);
    if (s.whisperModel) setWhisperModel(s.whisperModel);
    if (typeof s.autoTagScript === 'boolean') setAutoTagScript(s.autoTagScript);
    setRawPickedPaths(s.rawPickedPaths || []);
    setSliceMode(s.sliceMode || 'smart');
    setCensorMode(s.censorMode || 'blur');
    setStrictness(s.strictness || 'balanced');
    setAspectRatio(s.aspectRatio || '16:9');
    setFitMode(s.fitMode || 'contain');
    setIncludeCaptions(s.includeCaptions !== false);
    setPanels(s.panels || []);
    setPlan(s.plan || []);
    setActiveTab('storyboard');
    setStatusMsg(`✓ "${s.name}" ажлыг түүхээс сэргээлээ.`);
    setErrorMsg('');
  };

  const handleDeleteSession = async (id: string) => {
    if (!sr) return;
    await sr.deleteSession(id);
    await refreshHistory();
    setStatusMsg('✓ Түүхээс устгалаа.');
  };

  const handleApplyToTimeline = async () => {
    if (!sr || !plan.length) return;
    const unreviewed = plan.filter((r) => r.safetyStatus === 'excluded').length;
    if (unreviewed === plan.length) {
      setErrorMsg('Бүх мөрийн зураг хасагдсан байна.');
      return;
    }

    setBusy(true);
    setErrorMsg('');
    try {
      setStatusMsg('Аюулгүй Crop/Blur зургуудыг бэлдэж байна...');
      const mat = await sr.materializePlan({ sessionId, plan });
      if (!mat.ok || !mat.plan) {
        setErrorMsg(mat.error || 'Зураг бэлдэхэд алдаа гарлаа.');
        return;
      }
      setPlan(mat.plan);
      await persistSession({ plan: mat.plan }, ['timeline']);
      await applySafePlanToTimeline({
        audioPath: audioPath || undefined,
        audioDuration: audioDuration || undefined,
        plan: mat.plan,
        aspectRatio,
        fitMode,
        addCaptions: includeCaptions
      });
      onSuccessNotice?.(`🛡️ ${mat.plan.length} аюулгүй кадр Timeline дээр буулаа!`);
      setBusy(false);
      setProgressPct(null);
      onClose();
    } catch (e: any) {
      setErrorMsg(e?.message || String(e));
    } finally {
      setBusy(false);
      setProgressPct(null);
    }
  };

  const reviewCount = plan.filter((r) => r.safetyStatus === 'cropped' || r.safetyStatus === 'blurred' || r.needsReview).length;

  return (
    <div
      role={isOpen ? 'dialog' : undefined}
      aria-modal={isOpen ? 'true' : undefined}
      aria-hidden={!isOpen || undefined}
      aria-label={isOpen ? 'Safe +18 Webtoon Recap Studio' : undefined}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.88)',
        backdropFilter: 'blur(10px)',
        zIndex: 9998,
        display: isOpen ? 'flex' : 'none',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12
      }}
    >
      <div
        style={{
          width: '97vw',
          maxWidth: 1440,
          height: '94vh',
          backgroundColor: '#111115',
          border: '1px solid #272730',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 25px 60px rgba(0,0,0,0.85)'
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '10px 18px',
            borderBottom: '1px solid #272730',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'linear-gradient(90deg, rgba(16,185,129,0.16) 0%, rgba(99,102,241,0.14) 100%)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22 }}>🛡️</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: '#f4f4f5', display: 'flex', alignItems: 'center', gap: 8 }}>
                Safe +18 Webtoon Recap Studio
                <span
                  style={{
                    fontSize: 10,
                    padding: '2px 8px',
                    borderRadius: 10,
                    fontWeight: 700,
                    background: envStatus?.ok ? 'rgba(16,185,129,0.22)' : 'rgba(245,158,11,0.22)',
                    color: envStatus?.ok ? '#34d399' : '#fbbf24'
                  }}
                >
                  {envStatus?.ok ? '✓ Локал ONNX Бэлэн' : '⚠️ Локал ONNX Шалгах'}
                </span>
              </div>
              <div style={{ fontSize: 11, color: '#a1a1aa' }}>
                Скрипт → Дуу → Whisper → Скриптээр хадмал засах → +18 Шүүлт (Crop/Blur) → Зураг уялдаа · Авто хадгалалттай
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              onBlur={() => persistSession()}
              title="Ажлын нэр"
              style={{
                width: 170,
                background: '#1a1a22',
                color: '#f4f4f5',
                border: '1px solid #333340',
                borderRadius: 6,
                padding: '4px 8px',
                fontSize: 11
              }}
            />

            <button
              type="button"
              onClick={handleStartNewSession}
              style={{
                padding: '5px 10px',
                borderRadius: 6,
                fontSize: 11,
                cursor: 'pointer',
                border: '1px solid #3f3f46',
                background: '#1e1e26',
                color: '#e4e4e7'
              }}
              title="Шинэ хоосон ажил эхлүүлэх"
            >
              ➕ Шинэ ажил
            </button>

            {!envStatus?.ok && (
              <button
                type="button"
                disabled={busy}
                onClick={handleSetupEnv}
                style={{
                  padding: '5px 10px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  border: '1px solid #f59e0b',
                  background: 'rgba(245,158,11,0.2)',
                  color: '#fcd34d'
                }}
              >
                ⚙️ Локал шүүгч бэлтгэх
              </button>
            )}

            <button
              type="button"
              onClick={handleManualSave}
              style={{
                padding: '5px 10px',
                borderRadius: 6,
                fontSize: 11,
                cursor: 'pointer',
                border: '1px solid rgba(16,185,129,0.45)',
                background: 'rgba(16,185,129,0.14)',
                color: '#6ee7b7'
              }}
            >
              💾 Түүхэд хадгалах
            </button>

            {onMinimize && (
              <button
                type="button"
                onClick={onMinimize}
                title="Цонхыг хурааж ард ажиллуулах (шүүлт болон дуу боловсруулалт үргэлжилнэ)"
                style={{
                  padding: '5px 10px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  border: '1px solid rgba(56,189,248,0.4)',
                  background: 'rgba(56,189,248,0.16)',
                  color: '#7dd3fc'
                }}
              >
                🗕 Ард ажиллуулах
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                if (busy && onMinimize) onMinimize();
                else onClose();
              }}
              title={busy ? 'Ажил ард үргэлжилнэ (Цонхыг хураана)' : 'Хаах'}
              style={{ background: 'none', border: 'none', color: '#a1a1aa', fontSize: 20, cursor: 'pointer', padding: 4 }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Settings Bar */}
        <div
          style={{
            padding: '8px 18px',
            backgroundColor: '#17171d',
            borderBottom: '1px solid #272730',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 10
          }}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => handlePickImages('folder')}
            style={{
              padding: '5px 11px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
              border: 'none',
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              color: '#fff'
            }}
          >
            📁 Зургийн хавтас сонгох
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => handlePickImages('files')}
            style={{
              padding: '5px 10px',
              borderRadius: 6,
              fontSize: 11,
              cursor: 'pointer',
              border: '1px solid #3f3f46',
              background: '#22222b',
              color: '#e4e4e7'
            }}
          >
            🖼️ Зурагнууд
          </button>

          <select
            value={sliceMode}
            onChange={(e) => setSliceMode(e.target.value as any)}
            style={{ background: '#22222b', color: '#e4e4e7', border: '1px solid #3f3f46', borderRadius: 6, padding: '4px 8px', fontSize: 11 }}
          >
            <option value="smart">✂️ Урт туузыг кадраар зүсэх</option>
            <option value="none">🖼️ Бүтэн зургаар</option>
          </select>

          <select
            value={strictness}
            onChange={(e) => setStrictness(e.target.value as SafeStrictness)}
            style={{ background: '#22222b', color: '#e4e4e7', border: '1px solid #3f3f46', borderRadius: 6, padding: '4px 8px', fontSize: 11 }}
            title="Шүүлтийн хатуу байдал"
          >
            <option value="lenient">Шүүлт: Зөөлөн</option>
            <option value="balanced">Шүүлт: Тэнцвэртэй</option>
            <option value="strict">Шүүлт: Хатуу (YouTube Safe)</option>
          </select>

          <select
            value={censorMode}
            onChange={(e) => setCensorMode(e.target.value as SafeCensorMode)}
            style={{ background: '#22222b', color: '#e4e4e7', border: '1px solid #3f3f46', borderRadius: 6, padding: '4px 8px', fontSize: 11 }}
            title="Анхдагч Censor хэлбэр"
          >
            <option value="blur">Цензур: Blur</option>
            <option value="mosaic">Цензур: Mosaic</option>
            <option value="glow">Цензур: Glow (Гэрэл)</option>
            <option value="bar">Цензур: Bar (Хар)</option>
          </select>

          <div style={{ display: 'flex', gap: 4 }}>
            {(['16:9', '9:16'] as const).map((ar) => (
              <button
                key={ar}
                type="button"
                onClick={() => setAspectRatio(ar)}
                style={{
                  padding: '4px 8px',
                  borderRadius: 5,
                  fontSize: 11,
                  fontWeight: aspectRatio === ar ? 700 : 400,
                  cursor: 'pointer',
                  border: aspectRatio === ar ? '1px solid #10b981' : '1px solid #333',
                  background: aspectRatio === ar ? 'rgba(16,185,129,0.2)' : '#22222b',
                  color: aspectRatio === ar ? '#34d399' : '#a1a1aa'
                }}
              >
                {ar}
              </button>
            ))}
          </div>

          <select
            value={fitMode}
            onChange={(e) => setFitMode(e.target.value as any)}
            style={{ background: '#22222b', color: '#e4e4e7', border: '1px solid #3f3f46', borderRadius: 6, padding: '4px 8px', fontSize: 11 }}
          >
            <option value="contain">Fit: Бүтнээр багтаах</option>
            <option value="cover">Fit: Дэлгэц дүүргэх</option>
          </select>

          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#cbd5e1' }}>
            <input type="checkbox" checked={includeCaptions} onChange={(e) => setIncludeCaptions(e.target.checked)} />
            Хадмал бичих
          </label>
        </div>

        {/* Body: Left (Script/Audio) + Right (Safety, Storyboard, History) */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Left Input Column */}
          <div
            style={{
              width: 356,
              borderRight: '1px solid #272730',
              backgroundColor: '#14141a',
              display: 'flex',
              flexDirection: 'column',
              padding: 12,
              gap: 9,
              overflowY: 'auto'
            }}
          >
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={() => setInputMode('script')}
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  border: inputMode === 'script' ? '1px solid #6366f1' : '1px solid #2e2e38',
                  background: inputMode === 'script' ? 'rgba(99,102,241,0.22)' : '#1d1d24',
                  color: inputMode === 'script' ? '#c7d2fe' : '#a1a1aa'
                }}
              >
                📝 Текст скрипт
              </button>
              <button
                type="button"
                onClick={() => setInputMode('audio_srt')}
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  border: inputMode === 'audio_srt' ? '1px solid #6366f1' : '1px solid #2e2e38',
                  background: inputMode === 'audio_srt' ? 'rgba(99,102,241,0.22)' : '#1d1d24',
                  color: inputMode === 'audio_srt' ? '#c7d2fe' : '#a1a1aa'
                }}
              >
                🎧 Бэлэн Аудио + SRT
              </button>
            </div>

            {inputMode === 'script' ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 600 }}>Эх Монгол скрипт:</span>
                  <button
                    type="button"
                    onClick={handleImportScriptTxt}
                    style={{
                      background: '#23232c',
                      color: '#cbd5e1',
                      border: '1px solid #3f3f46',
                      borderRadius: 5,
                      padding: '3px 8px',
                      fontSize: 10,
                      cursor: 'pointer'
                    }}
                  >
                    📄 .txt оруулах
                  </button>
                </div>
                <textarea
                  value={scriptText}
                  onChange={(e) => setScriptText(e.target.value)}
                  onBlur={() => {
                    if (scriptText.trim()) persistSession({ scriptText });
                  }}
                  placeholder="Вебтүүний Монгол тайлбар/скриптээ энд хуулна уу..."
                  style={{
                    minHeight: 155,
                    resize: 'vertical',
                    background: '#0d0d12',
                    color: '#f4f4f5',
                    border: '1px solid #2e2e38',
                    borderRadius: 8,
                    padding: 10,
                    fontSize: 12,
                    lineHeight: 1.5
                  }}
                />

                {/* TTS + Whisper + Script-Fix settings */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {voices.length > 0 && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select
                        value={selectedVoiceId}
                        onChange={(e) => setSelectedVoiceId(e.target.value)}
                        style={{
                          flex: 1,
                          background: '#1c1c24',
                          color: '#e4e4e7',
                          border: '1px solid #333340',
                          borderRadius: 6,
                          padding: '4px 6px',
                          fontSize: 11
                        }}
                      >
                        {voices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                      <select
                        value={ttsModelId}
                        onChange={(e) => setTtsModelId(e.target.value)}
                        style={{
                          width: 112,
                          background: '#1c1c24',
                          color: '#e4e4e7',
                          border: '1px solid #333340',
                          borderRadius: 6,
                          padding: '4px 6px',
                          fontSize: 11
                        }}
                      >
                        <option value="eleven_v4">Eleven v4</option>
                        <option value="eleven_v4_turbo">v4 Turbo (0.5x)</option>
                        <option value="eleven_flash_v2_5">Flash v2.5</option>
                      </select>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select
                      value={whisperModel}
                      onChange={(e) => setWhisperModel(e.target.value)}
                      style={{
                        flex: 1,
                        background: '#1c1c24',
                        color: '#e4e4e7',
                        border: '1px solid #333340',
                        borderRadius: 6,
                        padding: '4px 6px',
                        fontSize: 11
                      }}
                      title="Дуунаас хадмал таних Whisper загвар"
                    >
                      {(whisperModels.length
                        ? whisperModels
                        : [{ id: 'groq-whisper-large-v3', label: '⚡ Groq Cloud (Large v3)', installed: true }]
                      ).map((wm) => (
                        <option key={wm.id} value={wm.id}>
                          {wm.installed ? `✓ ${wm.label}` : `${wm.label} (суугаагүй)`}
                        </option>
                      ))}
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#cbd5e1', whiteSpace: 'nowrap' }}>
                      <input type="checkbox" checked={autoTagScript} onChange={(e) => setAutoTagScript(e.target.checked)} />
                      ✨ Таг
                    </label>
                  </div>

                  <button
                    type="button"
                    disabled={busy || !scriptText.trim()}
                    onClick={handleGenerateVoiceAndSubtitles}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 7,
                      fontSize: 11.5,
                      fontWeight: 800,
                      cursor: scriptText.trim() ? 'pointer' : 'not-allowed',
                      border: '1px solid rgba(168,85,247,0.55)',
                      background: 'linear-gradient(135deg, rgba(168,85,247,0.28) 0%, rgba(99,102,241,0.25) 100%)',
                      color: '#f3e8ff'
                    }}
                  >
                    🎙️ Дуу + Whisper Хадмал + Скриптээр засах
                  </button>

                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      disabled={busy || !scriptText.trim()}
                      onClick={handleSplitScriptToBeats}
                      style={{
                        flex: 1,
                        padding: '6px 8px',
                        borderRadius: 6,
                        fontSize: 10.5,
                        fontWeight: 600,
                        cursor: 'pointer',
                        border: '1px solid #3f3f46',
                        background: '#20202a',
                        color: '#d4d4d8'
                      }}
                      title="TTS кредит үрэлгүйгээр өгүүлбэрээр урьдчилан шалгах"
                    >
                      ✂️ Үнэгүй хуваах
                    </button>
                    <button
                      type="button"
                      disabled={busy || !scriptText.trim() || !(draftBeats.length || beats.length)}
                      onClick={handleFixSubtitlesWithScript}
                      style={{
                        flex: 1,
                        padding: '6px 8px',
                        borderRadius: 6,
                        fontSize: 10.5,
                        fontWeight: 600,
                        cursor: scriptText.trim() && (draftBeats.length || beats.length) ? 'pointer' : 'not-allowed',
                        border: '1px solid #3f3f46',
                        background: '#20202a',
                        color: '#93c5fd'
                      }}
                      title="Одоогийн хадмалыг эх скриптээрээ дахин цэвэрлэн засах"
                    >
                      📝 Скриптээр засах
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button
                  type="button"
                  onClick={handlePickAudio}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: '1px solid #3f3f46',
                    background: '#22222c',
                    color: '#e4e4e7'
                  }}
                >
                  🔊 Аудио файл сонгох (.mp3/.wav)
                </button>
                <div style={{ fontSize: 11, color: audioPath ? '#34d399' : '#71717a' }}>
                  {audioPath ? `✓ ${audioName} (${clock(audioDuration)})` : 'Аудио сонгоогүй'}
                </div>

                <button
                  type="button"
                  onClick={handlePickSrt}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: '1px solid #3f3f46',
                    background: '#22222c',
                    color: '#e4e4e7'
                  }}
                >
                  💬 SRT хадмал сонгох (.srt)
                </button>
                <div style={{ fontSize: 11, color: beats.length ? '#34d399' : '#71717a' }}>
                  {beats.length ? `✓ ${subFileName || `${beats.length} мөр`}` : 'Хадмал сонгоогүй'}
                </div>

                <textarea
                  value={scriptText}
                  onChange={(e) => setScriptText(e.target.value)}
                  placeholder="(Сонголтоор) SRT үг үсгийг засах эх скрипт энд хуулж болно..."
                  style={{
                    minHeight: 85,
                    resize: 'vertical',
                    background: '#0d0d12',
                    color: '#f4f4f5',
                    border: '1px solid #2e2e38',
                    borderRadius: 6,
                    padding: 8,
                    fontSize: 11
                  }}
                />
                {scriptText.trim() && beats.length > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleFixSubtitlesWithScript}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                      border: '1px solid #3b82f6',
                      background: 'rgba(59,130,246,0.18)',
                      color: '#93c5fd'
                    }}
                  >
                    📝 SRT-г эх скриптээрээ засах
                  </button>
                )}
              </div>
            )}

            {/* Current Voice & Subtitle Status Card */}
            {(audioPath || beats.length > 0) && (
              <div
                style={{
                  backgroundColor: '#191922',
                  border: '1px solid #2a2a38',
                  borderRadius: 7,
                  padding: '7px 9px',
                  fontSize: 10.5,
                  color: '#cbd5e1',
                  lineHeight: 1.5
                }}
              >
                {audioPath && (
                  <div style={{ color: '#34d399' }}>
                    🔊 Дуу: <b>{audioName}</b> ({clock(audioDuration)})
                  </div>
                )}
                {beats.length > 0 && (
                  <div>
                    💬 Хадмал: <b>{beats.length} мөр</b>{' '}
                    <span style={{ color: subtitleMethod.includes('script-fix') ? '#6ee7b7' : '#a1a1aa' }}>
                      ({subtitleMethod || subFileName})
                    </span>
                  </div>
                )}
              </div>
            )}

            <hr style={{ borderColor: '#272730', width: '100%', margin: '2px 0' }} />

            {/* Action Steps */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <button
                type="button"
                disabled={busy || !panels.length}
                onClick={handleRunSafetyScan}
                style={{
                  padding: '9px 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: panels.length ? 'pointer' : 'not-allowed',
                  border: 'none',
                  background: panels.length ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)' : '#272730',
                  color: panels.length ? '#000' : '#71717a'
                }}
              >
                🛡️ 1. Локал +18 Шүүлт ({panels.length} кадр)
              </button>

              <button
                type="button"
                disabled={busy || !safeAvailablePanels.length || (!beats.length && !scriptText.trim())}
                onClick={handleRunAiAlign}
                style={{
                  padding: '9px 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: safeAvailablePanels.length ? 'pointer' : 'not-allowed',
                  border: 'none',
                  background: safeAvailablePanels.length ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : '#272730',
                  color: safeAvailablePanels.length ? '#fff' : '#71717a'
                }}
              >
                🤖 2. Хадмал + Цэвэр зураг тааруулах
              </button>
            </div>

            {panels.length > 0 && (
              <div
                style={{
                  backgroundColor: '#1b1b22',
                  border: '1px solid #2b2b36',
                  borderRadius: 8,
                  padding: 9,
                  fontSize: 11,
                  lineHeight: 1.55,
                  color: '#d4d4d8'
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 3 }}>Шүүлтийн хураангуй</div>
                <div>Нийт кадр: <b>{counts.total}</b></div>
                <div style={{ color: '#34d399' }}>🟢 Аюулгүй: <b>{counts.safe}</b></div>
                <div style={{ color: '#fbbf24' }}>🟡 Тайрсан / Blur: <b>{counts.review}</b></div>
                <div style={{ color: '#f87171' }}>🔴 Хассан (+18): <b>{counts.excluded}</b></div>
              </div>
            )}
          </div>

          {/* Right Review, Excluded & History Column */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, backgroundColor: '#101014' }}>
            {/* Tabs */}
            <div
              style={{
                padding: '8px 14px',
                borderBottom: '1px solid #25252e',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: '#15151b'
              }}
            >
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('storyboard');
                    setStatusFilter('all');
                  }}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: activeTab === 'storyboard' && statusFilter === 'all' ? '1px solid #818cf8' : '1px solid #30303b',
                    background: activeTab === 'storyboard' && statusFilter === 'all' ? 'rgba(99,102,241,0.22)' : '#1e1e26',
                    color: '#e4e4e7'
                  }}
                >
                  🎬 Storyboard ({plan.length})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('storyboard');
                    setStatusFilter('review');
                  }}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: activeTab === 'storyboard' && statusFilter === 'review' ? '1px solid #f59e0b' : '1px solid #30303b',
                    background: activeTab === 'storyboard' && statusFilter === 'review' ? 'rgba(245,158,11,0.22)' : '#1e1e26',
                    color: '#fcd34d'
                  }}
                >
                  🟡 Шалгах ({reviewCount})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('excluded')}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: activeTab === 'excluded' ? '1px solid #ef4444' : '1px solid #30303b',
                    background: activeTab === 'excluded' ? 'rgba(239,68,68,0.2)' : '#1e1e26',
                    color: '#fca5a5'
                  }}
                >
                  🔴 Хасагдсан ({excludedPanels.length})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    refreshHistory();
                    setActiveTab('history');
                  }}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    border: activeTab === 'history' ? '1px solid #a855f7' : '1px solid #30303b',
                    background: activeTab === 'history' ? 'rgba(168,85,247,0.22)' : '#1e1e26',
                    color: activeTab === 'history' ? '#e9d5ff' : '#cbd5e1'
                  }}
                >
                  🕒 Түүх ({savedSessions.length})
                </button>
              </div>

              <div style={{ fontSize: 11, color: '#a1a1aa' }}>
                {beats.length > 0 && `Нийт хугацаа: ${clock(plan[plan.length - 1]?.end || audioDuration || 0)}`}
              </div>
            </div>

            {/* Progress / Alert Bar */}
            {(statusMsg || errorMsg || progressPct !== null) && (
              <div style={{ padding: '6px 14px', borderBottom: '1px solid #22222a', backgroundColor: '#14141a' }}>
                {errorMsg && <div style={{ fontSize: 12, color: '#f87171', fontWeight: 600 }}>⚠️ {errorMsg}</div>}
                {statusMsg && !errorMsg && <div style={{ fontSize: 12, color: '#34d399' }}>{statusMsg}</div>}
                {progressPct !== null && (
                  <div style={{ height: 4, background: '#272730', borderRadius: 2, marginTop: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.max(4, progressPct)}%`, height: '100%', background: '#10b981', transition: 'width 0.2s' }} />
                  </div>
                )}
              </div>
            )}

            {/* Main List Area */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {activeTab === 'history' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#f4f4f5' }}>
                      Өмнө хийсэн Safe +18 ажлууд (Автоматаар хадгалагддаг)
                    </div>
                    <button
                      type="button"
                      onClick={refreshHistory}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 6,
                        fontSize: 11,
                        cursor: 'pointer',
                        border: '1px solid #383846',
                        background: '#1e1e26',
                        color: '#cbd5e1'
                      }}
                    >
                      ↻ Шинэчлэх
                    </button>
                  </div>

                  {savedSessions.length === 0 ? (
                    <div style={{ color: '#71717a', fontSize: 13, textAlign: 'center', marginTop: 40 }}>
                      Одоогоор хадгалагдсан түүх алга. Зураг эсвэл скрипт оруулаад эхлүүлэхэд автоматаар хадгалагдана.
                    </div>
                  ) : (
                    savedSessions.map((item) => (
                      <div
                        key={item.id}
                        style={{
                          backgroundColor: item.id === sessionId ? '#1c1d2b' : '#17171f',
                          border: item.id === sessionId ? '1px solid #6366f1' : '1px solid #282834',
                          borderRadius: 10,
                          padding: 12,
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 12
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: '#f4f4f5' }}>{item.name}</span>
                            {item.id === sessionId && (
                              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(99,102,241,0.25)', color: '#c7d2fe' }}>
                                Одоо нээлттэй
                              </span>
                            )}
                            <span style={{ fontSize: 11, color: '#a1a1aa' }}>{formatRelTime(item.updatedAt)}</span>
                          </div>

                          {item.scriptPreview && (
                            <div style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {item.scriptPreview}
                            </div>
                          )}

                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 10.5 }}>
                            <span style={{ color: '#d4d4d8' }}>
                              Зураг: <b>{item.panelCount}</b> (🟢{item.safeCount} · 🟡{item.reviewCount} · 🔴{item.excludedCount})
                            </span>
                            {item.beatCount > 0 && <span style={{ color: '#93c5fd' }}>· Хадмал: {item.beatCount}</span>}
                            {item.audioDuration ? <span style={{ color: '#34d399' }}>· Дуу: {clock(item.audioDuration)}</span> : null}
                            {(item.completedStages || []).map((st) => (
                              <span
                                key={st}
                                style={{
                                  padding: '1px 6px',
                                  borderRadius: 4,
                                  background: 'rgba(16,185,129,0.14)',
                                  color: '#6ee7b7',
                                  fontWeight: 600
                                }}
                              >
                                ✓ {STAGE_LABELS[st] || st}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <button
                            type="button"
                            onClick={() => handleLoadSession(item.id)}
                            style={{
                              padding: '6px 12px',
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 700,
                              cursor: 'pointer',
                              border: 'none',
                              background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
                              color: '#fff'
                            }}
                          >
                            📂 Үргэлжлүүлэх
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteSession(item.id)}
                            style={{
                              padding: '6px 10px',
                              borderRadius: 6,
                              fontSize: 11,
                              cursor: 'pointer',
                              border: '1px solid rgba(239,68,68,0.45)',
                              background: 'rgba(239,68,68,0.14)',
                              color: '#fca5a5'
                            }}
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : activeTab === 'excluded' ? (
                excludedPanels.length === 0 ? (
                  <div style={{ color: '#71717a', fontSize: 13, textAlign: 'center', marginTop: 40 }}>
                    Хасагдсан +18 кадр байхгүй байна.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
                    {excludedPanels.map((p) => (
                      <div
                        key={p.id}
                        style={{
                          backgroundColor: '#181820',
                          border: '1px solid rgba(239,68,68,0.4)',
                          borderRadius: 8,
                          padding: 10,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6
                        }}
                      >
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#fca5a5' }}>🔴 {p.name}</div>
                        <div style={{ fontSize: 11, color: '#a1a1aa' }}>
                          NSFW: {Math.round((p.nsfwScore || 0) * 100)}% · {p.safetyReason}
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                          <button
                            type="button"
                            onClick={() => setEditingPanel(p)}
                            style={{
                              flex: 1,
                              padding: '5px 8px',
                              borderRadius: 5,
                              fontSize: 11,
                              fontWeight: 700,
                              cursor: 'pointer',
                              border: '1px solid #f59e0b',
                              background: 'rgba(245,158,11,0.18)',
                              color: '#fcd34d'
                            }}
                          >
                            ✂️ Crop/Blur-ээр аврах
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : filteredPlan.length === 0 ? (
                <div style={{ color: '#71717a', fontSize: 13, textAlign: 'center', marginTop: 50, lineHeight: 1.8 }}>
                  1. Зүүн дээрээс вебтүүний зургууд ба скриптээ оруулаад <b>&quot;🎙️ Дуу + Whisper Хадмал + Скриптээр засах&quot;</b> дарна уу.
                  <br />
                  2. <b>&quot;🛡️ 1. Локал +18 Шүүлт&quot;</b> дарж царайг Crop / эмзэг хэсгийг Blur хийлгэнэ.
                  <br />
                  3. <b>&quot;🤖 2. Хадмал + Цэвэр зураг тааруулах&quot;</b> дарж зассан хадмалыг цэвэр кадруудтай уялдуулна.
                </div>
              ) : (
                filteredPlan.map((row, idx) => {
                  const matchedPanel = panels.find((p) => p.id === row.panelId);
                  const badge = STATUS_BADGE[row.safetyStatus] || STATUS_BADGE.unchecked;
                  const thumbSrc = window.api.toMediaUrl(
                    matchedPanel?.sanitizedThumbPath || row.sanitizedPath || row.imagePath
                  );

                  return (
                    <div
                      key={row.id}
                      style={{
                        backgroundColor: '#17171f',
                        border:
                          row.safetyStatus === 'cropped' || row.safetyStatus === 'blurred'
                            ? '1px solid rgba(245,158,11,0.45)'
                            : '1px solid #262632',
                        borderRadius: 10,
                        padding: 10,
                        display: 'flex',
                        gap: 12,
                        alignItems: 'center'
                      }}
                    >
                      <div
                        onClick={() => matchedPanel && setEditingPanel(matchedPanel)}
                        style={{
                          width: 124,
                          height: 88,
                          backgroundColor: '#0b0b0f',
                          borderRadius: 6,
                          overflow: 'hidden',
                          flexShrink: 0,
                          cursor: 'pointer',
                          position: 'relative',
                          border: '1px solid #30303b'
                        }}
                        title="Дарж Crop / Blur засах"
                      >
                        <img
                          src={thumbSrc}
                          alt={row.imageName}
                          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                        />
                        <span
                          style={{
                            position: 'absolute',
                            bottom: 3,
                            left: 3,
                            fontSize: 9,
                            padding: '1px 5px',
                            borderRadius: 4,
                            background: 'rgba(0,0,0,0.75)',
                            color: badge.fg,
                            fontWeight: 700
                          }}
                        >
                          {badge.icon} {badge.label}
                        </span>
                      </div>

                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, fontWeight: 800, color: '#93c5fd' }}>
                            #{idx + 1} · {clock(row.start)} → {clock(row.end)} ({row.duration.toFixed(1)}с)
                          </span>
                          {row.isFallback && (
                            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(99,102,241,0.2)', color: '#c7d2fe' }}>
                              🔄 Орлуулсан кадр
                            </span>
                          )}
                          {(row.aiReason || row.safetyReason) && (
                            <span style={{ fontSize: 11, color: '#a1a1aa' }}>
                              {row.aiReason || row.safetyReason}
                            </span>
                          )}
                        </div>

                        <input
                          value={row.text}
                          onChange={(e) => {
                            const val = e.target.value;
                            setPlan((prev) => prev.map((r) => (r.id === row.id ? { ...r, text: val } : r)));
                          }}
                          onBlur={() => persistSession()}
                          style={{
                            width: '100%',
                            background: '#0f0f15',
                            color: '#f4f4f5',
                            border: '1px solid #2b2b36',
                            borderRadius: 6,
                            padding: '6px 8px',
                            fontSize: 12
                          }}
                        />

                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <select
                            value={row.motion}
                            onChange={(e) => handleChangeRowMotion(row.id, e.target.value as SafeMotionType)}
                            style={{
                              background: '#21212a',
                              color: '#d4d4d8',
                              border: '1px solid #383846',
                              borderRadius: 5,
                              padding: '3px 7px',
                              fontSize: 11
                            }}
                          >
                            <option value="zoom_in">🔍 Zoom In</option>
                            <option value="zoom_out">🔎 Zoom Out</option>
                            <option value="pan_down">⬇️ Pan Down</option>
                            <option value="pan_up">⬆️ Pan Up</option>
                            <option value="static">🛑 Static</option>
                          </select>

                          {audioPath && (
                            <button
                              type="button"
                              onClick={() => handlePlayBeat(row)}
                              style={{
                                padding: '3px 8px',
                                borderRadius: 5,
                                fontSize: 11,
                                cursor: 'pointer',
                                border: '1px solid #383846',
                                background: playingRowId === row.id ? '#6366f1' : '#21212a',
                                color: '#e4e4e7'
                              }}
                            >
                              {playingRowId === row.id ? '⏹️ Зогсоох' : '🔊 Сонсох'}
                            </button>
                          )}

                          {matchedPanel && (
                            <button
                              type="button"
                              onClick={() => setEditingPanel(matchedPanel)}
                              style={{
                                padding: '3px 8px',
                                borderRadius: 5,
                                fontSize: 11,
                                fontWeight: 700,
                                cursor: 'pointer',
                                border: '1px solid rgba(245,158,11,0.5)',
                                background: 'rgba(245,158,11,0.16)',
                                color: '#fcd34d'
                              }}
                            >
                              ✂️ Crop / Blur засах
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => setPickingRowId(pickingRowId === row.id ? null : row.id)}
                            style={{
                              padding: '3px 8px',
                              borderRadius: 5,
                              fontSize: 11,
                              cursor: 'pointer',
                              border: '1px solid #383846',
                              background: '#21212a',
                              color: '#cbd5e1'
                            }}
                          >
                            🔄 Кадр солих
                          </button>
                        </div>

                        {pickingRowId === row.id && (
                          <div
                            style={{
                              marginTop: 6,
                              padding: 8,
                              background: '#0d0d12',
                              border: '1px solid #333342',
                              borderRadius: 8,
                              display: 'flex',
                              gap: 8,
                              overflowX: 'auto'
                            }}
                          >
                            {safeAvailablePanels.map((sp) => (
                              <div
                                key={sp.id}
                                onClick={() => handleReplaceRowPanel(row.id, sp)}
                                style={{
                                  width: 74,
                                  flexShrink: 0,
                                  cursor: 'pointer',
                                  border: sp.id === row.panelId ? '2px solid #10b981' : '1px solid #2e2e38',
                                  borderRadius: 5,
                                  overflow: 'hidden',
                                  background: '#000'
                                }}
                              >
                                <img
                                  src={window.api.toMediaUrl(sp.sanitizedThumbPath || sp.path)}
                                  alt={sp.name}
                                  style={{ width: 74, height: 64, objectFit: 'contain', display: 'block' }}
                                />
                                <div style={{ fontSize: 9, color: '#a1a1aa', padding: 2, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {sp.name}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '10px 18px',
            borderTop: '1px solid #272730',
            backgroundColor: '#16161c',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div style={{ fontSize: 11, color: '#a1a1aa' }}>
            Timeline руу буулгахад зөвхөн Crop/Blur хийгдсэн цэвэр зургууд л орно (бүх шат Түүх хэсэгт хадгалагдана).
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {onMinimize && (
              <button
                type="button"
                onClick={onMinimize}
                style={{
                  padding: '8px 14px',
                  borderRadius: 7,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  border: '1px solid rgba(56,189,248,0.4)',
                  background: 'rgba(56,189,248,0.14)',
                  color: '#7dd3fc'
                }}
              >
                🗕 Ард үлдээж өөр ажил хийх
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (busy && onMinimize) onMinimize();
                else onClose();
              }}
              style={{
                padding: '8px 16px',
                borderRadius: 7,
                fontSize: 12,
                cursor: 'pointer',
                border: '1px solid #3f3f46',
                background: '#23232c',
                color: '#e4e4e7'
              }}
            >
              {busy ? 'Ард хураах' : 'Хаах'}
            </button>
            <button
              type="button"
              disabled={busy || !plan.length}
              onClick={handleApplyToTimeline}
              style={{
                padding: '8px 18px',
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 800,
                cursor: plan.length ? 'pointer' : 'not-allowed',
                border: 'none',
                background: plan.length ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : '#272730',
                color: plan.length ? '#fff' : '#71717a'
              }}
            >
              🎬 Timeline руу буулгах ({plan.length} кадр)
            </button>
          </div>
        </div>
      </div>

      {editingPanel && (
        <SafeCropEditorModal
          panel={editingPanel}
          sessionId={sessionId}
          defaultCensorMode={censorMode}
          onClose={() => setEditingPanel(null)}
          onSave={handleSaveEditedPanel}
        />
      )}
    </div>
  );
}
