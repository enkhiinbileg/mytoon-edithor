import { useState, useMemo, useRef, useEffect } from 'react';
import { useEditor } from '../store';
import { TEXT_PRESETS, TEXT_EFFECTS, EFFECT_CATEGORIES } from '../looks';
import { useFonts } from '../fontManager';
import { flushDraft } from '../project';
import type { Clip, RecapCutReport } from '../types';
import { clipDuration } from '../types';
import { layoutCaptions } from '../captionLayout';
import { alignScriptToClips, reflowSentenceBoundaries } from '../alignScriptToClips';
import { runAutoSyncVoice } from '../syncVoice';

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.floor((secs % 1) * 10);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
}

export default function TextPanel() {
  const clips = useEditor((s) => s.clips);
  const tracks = useEditor((s) => s.tracks);
  const media = useEditor((s) => s.media);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const select = useEditor((s) => s.select);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const updateClipStyle = useEditor((s) => s.updateClipStyle);
  const addTrack = useEditor((s) => s.addTrack);
  const addTextClip = useEditor((s) => s.addTextClip);
  const toggleTrackFlag = useEditor((s) => s.toggleTrackFlag);
  const { catalog, importCustom } = useFonts();

  // Filter subtitle clips (track ov1 or kind text)
  const captionClips = useMemo(() => {
    return clips
      .filter((c) => c.kind === 'text')
      .sort((a, b) => a.start - b.start);
  }, [clips]);

  // Video cuts on v1
  const videoClips = useMemo(() => {
    return clips
      .filter((c) => c.trackId === 'v1' && c.kind === 'av')
      .sort((a, b) => a.start - b.start);
  }, [clips]);

  const [capcutSubNav, setCapcutSubNav] = useState<'add' | 'yours' | 'effects' | 'template' | 'auto' | 'sync' | 'local'>('add');
  const [effectsSearch, setEffectsSearch] = useState('');
  const [effectsCategory, setEffectsCategory] = useState<string>('Trending');
  const [customSavedPresets, setCustomSavedPresets] = useState<any[]>([]);
  const [voiceSyncing, setVoiceSyncing] = useState(false);
  const [voiceSyncNotice, setVoiceSyncNotice] = useState<string | null>(null);

  useEffect(() => {
    const handleSwitchSync = () => setCapcutSubNav('sync');
    window.addEventListener('switch-text-tab-sync', handleSwitchSync);
    window.addEventListener('open-auto-sync', handleSwitchSync);
    return () => {
      window.removeEventListener('switch-text-tab-sync', handleSwitchSync);
      window.removeEventListener('open-auto-sync', handleSwitchSync);
    };
  }, []);

  const handleRunTimelineVoiceSync = async () => {
    if (voiceSyncing) return;
    setVoiceSyncing(true);
    setVoiceSyncNotice('⏳ Voice болон дүрсийг уялдуулан тааруулж байна...');
    try {
      await runAutoSyncVoice((msg) => {
        setVoiceSyncNotice(msg);
        setTimeout(() => setVoiceSyncNotice(null), 6000);
      });
    } catch (err: any) {
      setVoiceSyncNotice('Алдаа: ' + (err.message || String(err)));
    } finally {
      setVoiceSyncing(false);
    }
  };

  useEffect(() => {
    try {
      const raw = localStorage.getItem('cutline_custom_text_presets');
      if (raw) setCustomSavedPresets(JSON.parse(raw));
    } catch {}
  }, [capcutSubNav]);

  const [searchQuery, setSearchQuery] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState('');
  const captionGeneration = useRef(0);
  const captionBusyRef = useRef(false);
  const [captionScript, setCaptionScript] = useState('');
  const [captionModels, setCaptionModels] = useState<{id:string;label:string;mb:number;installed:boolean}[]>([]);
  const [captionModel, setCaptionModel] = useState('groq-whisper-large-v3');
  const [groqKeys, setGroqKeys] = useState<string[]>([]);
  const [groqKeysInput, setGroqKeysInput] = useState<string>('');
  const [showKeyManager, setShowKeyManager] = useState<boolean>(false);
  const [keySaveMsg, setKeySaveMsg] = useState<string>('');
  const [modelDownloading, setModelDownloading] = useState(false);
  const [modelProgress, setModelProgress] = useState(0);
  const [compactCaptions, setCompactCaptions] = useState(true);
  const [showScriptFixModal, setShowScriptFixModal] = useState(false);
  const [scriptFixText, setScriptFixText] = useState('');
  const [scriptFixMode, setScriptFixMode] = useState<'auto' | 'full' | 'selected'>('auto');
  const [fixToast, setFixToast] = useState('');

  const handleSaveGroqKeys = async () => {
    try {
      const res = await window.api.saveGroqKeys?.(groqKeysInput);
      if (res && res.ok) {
        setGroqKeys(res.keys);
        setGroqKeysInput(res.keys.join('\n'));
        setKeySaveMsg(`✅ ${res.count} түлхүүр амжилттай хадгалагдлаа!`);
        setTimeout(() => setKeySaveMsg(''), 4000);
        const status = await window.api.whisperStatus();
        setCaptionModels(status.models);
      }
    } catch (err: any) {
      alert('Түлхүүр хадгалахад алдаа гарлаа: ' + (err.message || String(err)));
    }
  };

  const handleApplyScriptToCaptions = async () => {
    const text = scriptFixText.trim() || captionScript.trim();
    if (!text) {
      alert('Монгол скрипт текстээ оруулна уу.');
      return;
    }
    if (!captionClips.length) {
      alert('Таймлайн дээр засах хадмал алга байна.');
      return;
    }

    try {
      const result = alignScriptToClips(text, captionClips, {
        mode: scriptFixMode,
        selectedClipId: selectedClipId || undefined
      });
      const fixedMap = new Map(result.updatedClips.map(c => [c.id, c.style?.text || '']));

      useEditor.setState(s => ({
        clips: s.clips.map(c => {
          if (fixedMap.has(c.id) && c.style) {
            return {
              ...c,
              asrText: (c as any).asrText || c.style.text || '',
              style: { ...c.style, text: fixedMap.get(c.id)! }
            } as Clip;
          }
          return c;
        })
      }));

      const updated = useEditor.getState();
      if (updated.currentProjectId) {
        await window.api.autosaveProjectById(updated.currentProjectId, updated.snapshotProject(), { duration: updated.duration() });
      }

      setShowScriptFixModal(false);
      setFixToast(`✅ ${result.message}`);
      setTimeout(() => setFixToast(''), 5000);
    } catch (err: any) {
      alert('Скриптээр засахад алдаа гарлаа: ' + (err.message || String(err)));
    }
  };

  const handleReflowSentenceBoundaries = async () => {
    if (!captionClips.length) {
      alert('Таймлайн дээр засах хадмал алга байна.');
      return;
    }
    const { updatedClips, fixedCount } = reflowSentenceBoundaries(captionClips);
    if (fixedCount === 0) {
      setFixToast('✅ Бүх хадмалын өгүүлбэрийн төгсгөлүүд аль хэдийн зөв байна!');
      setTimeout(() => setFixToast(''), 3000);
      return;
    }

    const fixedMap = new Map(updatedClips.map(c => [c.id, c.style?.text || '']));
    useEditor.setState(s => ({
      clips: s.clips.map(c => {
        if (fixedMap.has(c.id) && c.style) {
          return {
            ...c,
            style: { ...c.style, text: fixedMap.get(c.id)! }
          };
        }
        return c;
      })
    }));

    const updated = useEditor.getState();
    if (updated.currentProjectId) {
      await window.api.autosaveProjectById(updated.currentProjectId, updated.snapshotProject(), { duration: updated.duration() });
    }

    setFixToast(`✅ ${fixedCount} хадмалын өгүүлбэрийн залгаасыг амжилттай тэгшиллээ!`);
    setTimeout(() => setFixToast(''), 5000);
  };

  const [fixingAI, setFixingAI] = useState(false);

  const handleAIFixMongolianCaptions = async () => {
    if (fixingAI) return;
    if (!captionClips.length) {
      alert('Таймлайн дээр засах хадмал алга байна.');
      return;
    }
    setFixingAI(true);
    setFixToast('⏳ Монгол хэлний дүрмийн алдааг AI-аар шалгаж байна...');
    try {
      const texts = captionClips.map(c => c.style?.text || '');
      const res = await window.api.aiFixMongolianCaptions(texts);
      if (res && res.ok && Array.isArray(res.corrected)) {
        let changedCount = 0;
        const fixedMap = new Map<string, string>();
        captionClips.forEach((c, idx) => {
          const original = c.style?.text || '';
          const corrected = res.corrected![idx] || original;
          if (corrected !== original) changedCount++;
          fixedMap.set(c.id, corrected);
        });

        useEditor.setState(s => ({
          clips: s.clips.map(c => {
            if (fixedMap.has(c.id) && c.style) {
              return {
                ...c,
                style: { ...c.style, text: fixedMap.get(c.id)! }
              };
            }
            return c;
          })
        }));

        const updated = useEditor.getState();
        if (updated.currentProjectId) {
          await window.api.autosaveProjectById(updated.currentProjectId, updated.snapshotProject(), { duration: updated.duration() });
        }

        setFixToast(`✅ Нийт ${changedCount} хадмалын алдааг засаж, цэг тэмдэг, зөв бичгийн дүрмийг сайжрууллаа!`);
        setTimeout(() => setFixToast(''), 5000);
      } else {
        setFixToast('⚠️ Алдаа: ' + (res?.error || 'Текст засахад алдаа гарлаа'));
        setTimeout(() => setFixToast(''), 5000);
      }
    } catch (err: any) {
      setFixToast('⚠️ Алдаа: ' + (err.message || String(err)));
      setTimeout(() => setFixToast(''), 5000);
    } finally {
      setFixingAI(false);
    }
  };

  useEffect(() => {
    window.api.whisperStatus().then(status => {
      setCaptionModels(status.models);
      const groq = status.models.find(m => m.id.startsWith('groq') && m.installed);
      if (groq) {
        setCaptionModel(groq.id);
      } else {
        const best = [...status.models].reverse().find(m => m.installed);
        if (best) setCaptionModel(best.id);
      }
    }).catch(() => {});

    window.api.getGroqKeys?.().then(keys => {
      if (Array.isArray(keys)) {
        setGroqKeys(keys);
        setGroqKeysInput(keys.join('\n'));
        if (keys.length > 0) {
          setCaptionModel('groq-whisper-large-v3');
        }
      }
    }).catch(() => {});
  }, []);
  const installCaptionModel = async () => {
    setModelDownloading(true); setModelProgress(0);
    const off = window.api.onWhisperProgress(p => { if (p.model === captionModel) setModelProgress(p.pct); });
    try {
      await window.api.downloadWhisperModel(captionModel);
      setCaptionModels((await window.api.whisperStatus()).models);
    } catch (error: any) { alert(error.message || String(error)); }
    finally { off(); setModelDownloading(false); }
  };

  // Recap Auto-Cut state
  const [srtPath, setSrtPath] = useState('');
  const [srtFileName, setSrtFileName] = useState('');
  const [srtStartTime, setSrtStartTime] = useState<string>('');

  useEffect(() => {
    if (srtStartTime) return;
    const vClip = videoClips[0];
    if (vClip) {
      const med = media.find((m) => m.id === vClip.mediaId);
      const nameOrPath = med?.name || med?.path || '';
      const match = nameOrPath.match(/\[(\d{1,2})-(\d{2})-(\d{2})_/);
      if (match) {
        setSrtStartTime(`${match[1].padStart(2, '0')}:${match[2]}:${match[3]}`);
      }
    }
  }, [videoClips, media]);
  const [autoCutting, setAutoCutting] = useState<boolean>(false);
  const [autoCutStatus, setAutoCutStatus] = useState<string>('');
  const [autoCutSuccess, setAutoCutSuccess] = useState<string>('');
  const [autoCutError, setAutoCutError] = useState('');
  const [autoCutReport, setAutoCutReport] = useState<RecapCutReport | null>(null);
  const autoCutBusy = useRef(false);
  const resultClips = useRef<Clip[] | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (resultClips.current && resultClips.current !== clips) {
      resultClips.current = null;
      setAutoCutReport(null);
      setAutoCutSuccess('');
    }
  }, [clips]);
  const [sceneSearch, setSceneSearch] = useState<string>('');

  const filteredScenes = useMemo(() => {
    if (!sceneSearch.trim()) return videoClips;
    const q = sceneSearch.toLowerCase();
    return videoClips.filter(
      (c) =>
        (c.label || '').toLowerCase().includes(q) ||
        (c.englishText || '').toLowerCase().includes(q) ||
        (c.mongolianText || '').toLowerCase().includes(q) ||
        String(c.matchedSrtId || '').includes(q)
    );
  }, [videoClips, sceneSearch]);

  const handleSelectSrt = async () => {
    try {
      const res = await window.api.openSrtFile();
      if (res && res.ok && res.path) {
        setSrtPath(res.path);
        setSrtFileName(res.name || 'English.srt');
        setAutoCutReport(null);
        setAutoCutError('');
        setAutoCutSuccess(`Сонгогдсон: ${res.name} (${res.entriesCount} мөр хадмал)`);
      }
    } catch (err: any) {
      alert('SRT уншихад алдаа гарлаа: ' + err.message);
    }
  };

  const handleAutoCutBySrt = async () => {
    if (autoCutBusy.current || !srtPath) return;

    // If v1 track is locked, unlock it so cut clips can be written
    const v1 = useEditor.getState().tracks.find((t) => t.id === 'v1');
    if (v1?.locked) {
      toggleTrackFlag('v1', 'locked');
    }

    // Clean any empty caption clips before auto-cut so they don't break timeline validation
    const emptyCaps = useEditor.getState().clips.filter((c) => c.kind === 'text' && !c.style?.text?.trim());
    if (emptyCaps.length > 0) {
      const emptyIds = new Set(emptyCaps.map((c) => c.id));
      useEditor.setState((s) => ({
        clips: s.clips.filter((c) => !emptyIds.has(c.id))
      }));
      await flushDraft();
    }

    autoCutBusy.current = true;
    setAutoCutting(true);
    setAutoCutStatus('🔍 Англи SRT файлыг задалж байна...');
    setAutoCutSuccess('');
    setAutoCutReport(null);
    setAutoCutError('');
    let unsub: (() => void) | undefined;
    const original = useEditor.getState();
    const validCaptions = original.clips
      .filter((c) => c.kind === 'text' && c.style?.text?.trim())
      .sort((a, b) => a.start - b.start);
    const projectDoc = original.snapshotProject();
    const fingerprint = JSON.stringify(projectDoc);
    const requestId = crypto.randomUUID();
    let applied = false;

    try {
      unsub = window.api.onRecapCutProgress?.((p) => {
        if (mounted.current && p?.requestId === requestId && p.message) setAutoCutStatus(p.message);
      });

      const res = await window.api.autoCutBySrt({
        srtPath,
        srtStartTime: srtStartTime.trim() || undefined,
        captions: validCaptions,
        projectData: projectDoc,
        requestId
      });

      if (!res.ok) throw new Error(res.error || 'Дүрс тайралт амжилтгүй боллоо.');
      if (!res.videoClips.length || !res.report || (res.report.coveredCaptionCount ?? res.report.matchedCaptionCount) !== validCaptions.length || Math.abs(res.report.durationError) > 0.000001) throw new Error('Тааруулалтын эцсийн шалгалт амжилтгүй.');
      const current = useEditor.getState();
      if (!mounted.current) return;
      if (current.currentProjectId !== original.currentProjectId || current.projectPath !== original.projectPath || JSON.stringify(current.snapshotProject()) !== fingerprint) throw new Error('Тааруулалтын явцад төсөл өөрчлөгдсөн. Шинэ timeline дээр дахин ажиллуулна уу.');
      current.applyRecapCut(res.newMedia, res.videoClips);
      applied = true;
      const updated = useEditor.getState();
      resultClips.current = updated.clips;
      if (updated.currentProjectId) {
        const saved = await window.api.autosaveProjectById(updated.currentProjectId, updated.snapshotProject(), { duration: updated.duration() });
        if (!saved.ok) throw new Error(saved.error || 'Төслийг хадгалж чадсангүй.');
      }
      await flushDraft();
      if (mounted.current && useEditor.getState().clips === updated.clips) {
        setAutoCutReport(res.report);
        setAutoCutSuccess(`${res.report.coveredCaptionCount ?? res.report.matchedCaptionCount}/${res.report.captionCount} хадмал дүрстэй боллоо. ${res.report.matchedCaptionCount} утгаар таарсан${res.report.introCaptionCount ? `, ${res.report.introCaptionCount} оршил` : ''}. ${res.motionCount} дүрс + ${res.freezeCount} царцсан зураг. Хугацааны зөрүү: ${(Math.abs(res.report.durationError) * 1000).toFixed(1)} мс.`);
      }
    } catch (err: any) {
      if (mounted.current) setAutoCutError((applied ? 'Дүрс timeline-д орсон ч хадгалалт амжилтгүй. Ctrl+S-ээр хадгалж болно. ' : '') + (err.message || String(err)));
    } finally {
      unsub?.();
      autoCutBusy.current = false;
      if (mounted.current) { setAutoCutting(false); setAutoCutStatus(''); }
    }
  };

  const filteredCaptions = useMemo(() => {
    if (!searchQuery.trim()) return captionClips;
    const q = searchQuery.toLowerCase();
    return captionClips.filter((c) => (c.style?.text || '').toLowerCase().includes(q));
  }, [captionClips, searchQuery]);

  // CapCut 1-Click Auto Caption Generator
  const handleOneClickAutoCaption = async () => {
    if (captionBusyRef.current || generating) return;
    captionBusyRef.current = true;
    const original = useEditor.getState();
    const fingerprint = JSON.stringify(original.snapshotProject());
    const request = ++captionGeneration.current;
    const isCurrentRequest = () => mounted.current && captionGeneration.current === request;
    const assertUnchangedProject = () => {
      const current = useEditor.getState();
      if (current.currentProjectId !== original.currentProjectId || current.projectPath !== original.projectPath || JSON.stringify(current.snapshotProject()) !== fingerprint) {
        throw new Error('Хадмал үүсгэх явцад төсөл өөрчлөгдсөн. Шинэ таймлайн дээр дахин үүсгэнэ үү.');
      }
    };
    const unsubscribe = window.api.onVoiceAlignProgress(p => {
      if (isCurrentRequest()) setGenStatus(`${typeof p.pct === 'number' ? Math.round(p.pct) + '% · ' : ''}${p.message || 'Яриаг таньж байна...'}`);
    });
    setGenerating(true);
    setGenStatus('🎙️ Аудиог уншиж байна...');

    try {
      // 1. Gather all timeline audio clips strictly from UNMUTED tracks
      const unmutedAudioTrackIds = new Set(original.tracks.filter((t) => t.kind === 'audio' && !t.muted).map((t) => t.id));
      const unmutedVideoTrackIds = new Set(original.tracks.filter((t) => t.kind === 'video' && !t.muted).map((t) => t.id));

      const rawAudioClips = original.clips
        .filter((c) => unmutedAudioTrackIds.has(c.trackId) && c.kind === 'av' && (c.volume ?? 1) > 0.001)
        .map((c) => {
          const m = original.media.find((x) => x.id === c.mediaId);
          return m?.path ? { ...c, src: m.path } : null;
        })
        .filter(Boolean);

      const rawVideoClips = original.clips
        .filter((c) => unmutedVideoTrackIds.has(c.trackId) && c.kind === 'av')
        .map((c) => {
          const m = original.media.find((x) => x.id === c.mediaId);
          return (m?.path && m.hasAudio && (c.volume ?? 1) > 0.001) ? { ...c, src: m.path, hasAudio: true } : null;
        })
        .filter(Boolean);

      if (!rawAudioClips.length && !rawVideoClips.length) throw new Error('Таймлайн дээр дуу нь нээлттэй бичлэг эсвэл аудио оруулна уу.');

      // Render the audible timeline so source trims, offsets and volume are retained.
      // Separate voice tracks take priority over the video's background sound.
      setGenStatus('🎙️ Таймлайны ярианы дууг бэлтгэж байна...');
      const rendered = await window.api.renderTimelineSpeech({
        clips: rawAudioClips.length ? [] : rawVideoClips as any[],
        audio: rawAudioClips as any[],
        duration: Math.max(...(rawAudioClips.length ? rawAudioClips : rawVideoClips)
          .map(c => c!.start + c!.outPoint - c!.inPoint))
      });
      if (!isCurrentRequest()) return;
      if (!rendered?.ok || !rendered.audioPath) throw new Error(rendered?.error || 'Таймлайны дууг бэлтгэж чадсангүй.');
      assertUnchangedProject();
      const audioPath = rendered.audioPath;

      // 2. Call backend CapCut alignment engine
      setGenStatus('🎙️ Монгол яриаг таньж хадмал үүсгэж байна...');
      const res = await window.api.alignAudioScript({
        audioPath,
        whisperModel: captionModel,
        scriptText: captionScript.trim(),
        srtPath: '',
        minSilence: 0.22,
        noise: '-30dB',
        useWhisper: true,
        mode: captionScript.trim() ? 'script_captions' : 'auto',
        forceFresh: false
      } as any);

      if (!isCurrentRequest()) return;
      if (res?.busy) return;
      if (!res || !res.ok || !res.segments || res.segments.length === 0) {
        throw new Error(res?.error || 'Хадмал үүсгэж чадсангүй.');
      }

      // Check before adding a track or replacing any existing captions.
      assertUnchangedProject();
      setGenStatus(`✨ ${res.segments.length} хадмалыг таймлайн дээр өрж байна...`);

      const visibleSegments = res.segments.filter((seg) => seg.duration > 0 && seg.text.trim().length > 0);
      const subtitleSegments = compactCaptions ? layoutCaptions(visibleSegments) : visibleSegments;
      if (!subtitleSegments.length) throw new Error('Яриа танигдсангүй.');

      // 3. Ensure overlay track exists
      let ovTrack = useEditor.getState().tracks.find((t) => t.kind === 'overlay');
      if (!ovTrack) {
        addTrack('overlay');
        ovTrack = useEditor.getState().tracks.find((t) => t.kind === 'overlay')!;
      }

      // 4. Create CapCut-styled subtitle clips (exact timeline timing from mixed audio)
      const newSubtitleClips: Clip[] = subtitleSegments.map((seg) => ({
        id: Math.random().toString(36).slice(2, 10),
        kind: 'text',
        trackId: ovTrack.id,
        start: Math.round(seg.start * 1000) / 1000,
        inPoint: 0,
        outPoint: Math.round(seg.duration * 1000) / 1000,
        style: {
          text: seg.text.trim(),
          fontSize: 36,
          color: '#FFFFFF',
          bold: true,
          shadow: true,
          stroke: true,
          strokeColor: '#000000',
          strokeWidth: 5,
          background: '',
          fontFamily: 'Montserrat, Arial Black, Impact, Segoe UI, sans-serif'
        },
        x: 0.5,
        y: 0.83,
        opacity: 1,
        filterId: 'none',
        effectId: 'none',
        transitionId: 'none',
        transitionDuration: 0.6
      }));

      // 5. Replace existing text clips with precision-aligned subtitle clips
      const otherClips = useEditor.getState().clips.filter((c) => c.kind !== 'text');
      useEditor.setState({ clips: [...otherClips, ...newSubtitleClips] });
      void flushDraft();

      setCapcutSubNav('auto');
    } catch (err: any) {
      if (isCurrentRequest()) {
        console.error(err);
        alert('Алдаа: ' + (err.message || String(err)));
      }
    } finally {
      captionBusyRef.current = false;
      unsubscribe?.();
      if (isCurrentRequest()) {
        setGenerating(false);
        setGenStatus('');
      }
    }
  };

  const applyGlobalStyle = (patch: Record<string, unknown>) => {
    useEditor.setState((s) => ({
      clips: s.clips.map((c) =>
        c.kind === 'text' && c.style
          ? { ...c, style: { ...c.style, ...patch, text: c.style.text } }
          : c
      )
    }));
  };

  const exportSrt = () => {
    const formatSrtTime = (t: number) => {
      const h = Math.floor(t / 3600).toString().padStart(2, '0');
      const m = Math.floor((t % 3600) / 60).toString().padStart(2, '0');
      const s = Math.floor(t % 60).toString().padStart(2, '0');
      const ms = Math.floor((t % 1) * 1000).toString().padStart(3, '0');
      return `${h}:${m}:${s},${ms}`;
    };
    let srtContent = '';
    captionClips.forEach((c, idx) => {
      const startStr = formatSrtTime(c.start);
      const endStr = formatSrtTime(c.start + c.outPoint);
      srtContent += `${idx + 1}\n${startStr} --> ${endStr}\n${c.style?.text || ''}\n\n`;
    });
    const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mongolian_recap_captions.srt';
    a.click();
  };

  const handleAddDefaultText = () => {
    const playhead = useEditor.getState().playhead;
    const track = useEditor.getState().ensureAvailableOverlayTrack(playhead, 3);
    const clipId = Math.random().toString(36).slice(2, 10);
    const newClip: Clip = {
      id: clipId,
      kind: 'text',
      trackId: track.id,
      start: playhead,
      inPoint: 0,
      outPoint: 3,
      style: {
        text: 'Default text',
        fontSize: 36,
        color: '#FFFFFF',
        bold: true,
        shadow: true,
        stroke: true,
        strokeColor: '#000000',
        strokeWidth: 5,
        background: '',
        fontFamily: ''
      },
      x: 0.5,
      y: 0.5,
      opacity: 1,
      filterId: 'none',
      effectId: 'none',
      transitionId: 'none',
      transitionDuration: 0.6
    };
    useEditor.setState((s) => ({
      clips: [...s.clips, newClip],
      selectedClipId: newClip.id,
      selectedClipIds: [newClip.id]
    }));
    void flushDraft();
  };

  const handleAddOrApplyEffect = (eff: any) => {
    const currentSelected = useEditor.getState().clips.find((c) => c.id === selectedClipId);
    if (currentSelected && currentSelected.kind === 'text') {
      updateClipStyle(currentSelected.id, { ...eff.style, effectId: eff.id });
      return;
    }
    const playhead = useEditor.getState().playhead;
    const track = useEditor.getState().ensureAvailableOverlayTrack(playhead, 3);
    const clipId = Math.random().toString(36).slice(2, 10);
    const newClip: Clip = {
      id: clipId,
      kind: 'text',
      trackId: track.id,
      start: playhead,
      inPoint: 0,
      outPoint: 3,
      style: {
        text: eff.name,
        fontSize: 48,
        ...eff.style,
        effectId: eff.id
      },
      x: 0.5,
      y: 0.5,
      opacity: 1,
      filterId: 'none',
      effectId: 'none',
      transitionId: 'none',
      transitionDuration: 0.6
    };
    useEditor.setState((s) => ({
      clips: [...s.clips, newClip],
      selectedClipId: newClip.id,
      selectedClipIds: [newClip.id]
    }));
    void flushDraft();
  };

  const handleDeleteCustomPreset = (presetId: string) => {
    try {
      const updated = customSavedPresets.filter((p) => p.id !== presetId);
      setCustomSavedPresets(updated);
      localStorage.setItem('cutline_custom_text_presets', JSON.stringify(updated));
    } catch {}
  };

  const handleImportSrt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        const blocks = text.trim().split(/\r?\n\r?\n/);
        const newClips: Clip[] = [];
        const track = useEditor.getState().ensureTrack('overlay');
        const parseSecs = (ts: string) => {
          const parts = ts.trim().replace(',', '.').split(':');
          if (parts.length === 3) {
            return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
          }
          return 0;
        };
        for (const block of blocks) {
          const lines = block.trim().split(/\r?\n/);
          if (lines.length >= 2) {
            const timeLine = lines.find((l) => l.includes('-->'));
            if (!timeLine) continue;
            const [startStr, endStr] = timeLine.split('-->');
            const start = parseSecs(startStr);
            const end = parseSecs(endStr);
            const textLines = lines.slice(lines.indexOf(timeLine) + 1).join(' ').trim();
            if (textLines && end > start) {
              newClips.push({
                id: Math.random().toString(36).slice(2, 10),
                kind: 'text',
                trackId: track.id,
                start: Math.round(start * 1000) / 1000,
                inPoint: 0,
                outPoint: Math.round((end - start) * 1000) / 1000,
                style: {
                  text: textLines,
                  fontSize: 36,
                  color: '#FFFFFF',
                  bold: true,
                  shadow: true,
                  stroke: true,
                  strokeColor: '#000000',
                  strokeWidth: 5,
                  background: '',
                  fontFamily: 'Segoe UI, sans-serif'
                },
                x: 0.5,
                y: 0.83,
                opacity: 1
              });
            }
          }
        }
        if (newClips.length > 0) {
          const others = useEditor.getState().clips.filter((c) => c.kind !== 'text');
          useEditor.setState({ clips: [...others, ...newClips] });
          void flushDraft();
          alert(`✅ ${newClips.length} хадмал амжилттай импортлогдлоо!`);
        }
      } catch (err: any) {
        alert('SRT уншихад алдаа гарлаа: ' + (err.message || String(err)));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <section className="panel cc-text-shell" style={{ height: '100%', display: 'flex', flexDirection: 'row', padding: 0 }}>
      {/* CapCut Sub-Navigation Sidebar */}
      <div className="cc-text-sidebar" style={{ width: 118, background: '#17171d', borderRight: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', padding: '10px 6px', gap: 4, flexShrink: 0 }}>
        <button
          type="button"
          className={`cc-sidebar-item ${capcutSubNav === 'add' ? 'active' : ''}`}
          onClick={() => setCapcutSubNav('add')}
        >
          <span>➕</span> Add text
        </button>
        <button
          type="button"
          className={`cc-sidebar-item ${capcutSubNav === 'yours' ? 'active' : ''}`}
          onClick={() => setCapcutSubNav('yours')}
        >
          <span>⭐</span> Yours
        </button>
        <button
          type="button"
          className={`cc-sidebar-item ${capcutSubNav === 'effects' ? 'active' : ''}`}
          onClick={() => setCapcutSubNav('effects')}
        >
          <span>🎨</span> Text effects
        </button>
        <button
          type="button"
          className={`cc-sidebar-item ${capcutSubNav === 'template' ? 'active' : ''}`}
          onClick={() => setCapcutSubNav('template')}
        >
          <span>📋</span> Text template
        </button>
        <button
          type="button"
          className={`cc-sidebar-item ${capcutSubNav === 'auto' ? 'active' : ''}`}
          onClick={() => setCapcutSubNav('auto')}
        >
          <span>🎙️</span> Auto captions
        </button>
        <button
          type="button"
          className={`cc-sidebar-item ${capcutSubNav === 'sync' ? 'active' : ''}`}
          onClick={() => setCapcutSubNav('sync')}
          style={{
            position: 'relative',
            color: capcutSubNav === 'sync' ? '#38bdf8' : undefined
          }}
          title="Дүрсийг Англи SRT эсвэл Voice ярианд автоматаар тааруулж зүсэх (Auto-Cut)"
        >
          <span>⚡</span> Auto sync
          <span style={{
            position: 'absolute',
            top: 4,
            right: 4,
            background: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
            color: '#fff',
            fontSize: 8,
            padding: '1px 4px',
            borderRadius: 3,
            fontWeight: 800
          }}>AI</span>
        </button>
        <button
          type="button"
          className={`cc-sidebar-item ${capcutSubNav === 'local' ? 'active' : ''}`}
          onClick={() => setCapcutSubNav('local')}
        >
          <span>📁</span> Local captions
        </button>
      </div>

      {/* CapCut Sub-Nav Content Area */}
      <div className="cc-text-content-area" style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* TAB 1: ADD TEXT */}
        {capcutSubNav === 'add' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#f4f4f5' }}>Add text</div>
            <div
              className="cc-default-text-card"
              onClick={handleAddDefaultText}
              title="Таймлайнд Default text нэмэх"
            >
              <div className="cc-card-preview-text">Default text</div>
              <button
                type="button"
                className="cc-card-add-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleAddDefaultText();
                }}
                title="Таймлайнд нэмэх"
              >
                +
              </button>
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>
              Quick Presets
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
              {[
                { label: 'Heading', fontSize: 60, text: 'Heading', bold: true, color: '#ffffff' },
                { label: 'Subheading', fontSize: 44, text: 'Subheading', bold: false, color: '#ffffff' },
                { label: 'Body text', fontSize: 32, text: 'Body text', bold: false, color: '#d4d4d8' },
                { label: 'Highlight', fontSize: 48, text: 'Highlight', bold: true, color: '#FFE600' }
              ].map((item, i) => (
                <div
                  key={i}
                  className="cc-default-text-card"
                  style={{ width: 'auto', height: 80 }}
                  onClick={() => addTextClip({
                    id: 'quick_' + i,
                    label: item.label,
                    text: item.text,
                    fontSize: item.fontSize,
                    color: item.color,
                    bold: item.bold,
                    shadow: true,
                    background: '',
                    fontFamily: ''
                  })}
                  title={`${item.label} нэмэх`}
                >
                  <div style={{ fontSize: 12, fontWeight: item.bold ? 700 : 500, color: item.color }}>
                    {item.label}
                  </div>
                  <button
                    type="button"
                    className="cc-card-add-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      addTextClip({
                        id: 'quick_' + i,
                        label: item.label,
                        text: item.text,
                        fontSize: item.fontSize,
                        color: item.color,
                        bold: item.bold,
                        shadow: true,
                        background: '',
                        fontFamily: ''
                      });
                    }}
                  >
                    +
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 2: YOURS */}
        {capcutSubNav === 'yours' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f4f4f5' }}>Yours (Миний хадгалсан загварууд)</div>
              <span style={{ fontSize: 11, color: '#71717a' }}>{customSavedPresets.length} загвар</span>
            </div>
            {customSavedPresets.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '36px 14px', background: '#191920', borderRadius: 8, border: '1px dashed rgba(255,255,255,0.1)' }}>
                <div style={{ fontSize: 30, marginBottom: 8 }}>⭐</div>
                <div style={{ fontWeight: 700, color: '#f4f4f5', fontSize: 12, marginBottom: 4 }}>
                  Хадгалсан загвар байхгүй байна
                </div>
                <div style={{ fontSize: 11, color: '#a1a1aa', lineHeight: 1.5, maxWidth: 280, margin: '0 auto' }}>
                  Баруун талын <strong>Inspector</strong>-оос дурын текстийн өнгө, хүрээ, фонтыг тааруулаад <strong>"Save as preset"</strong> товчоор энд хадгалаарай.
                </div>
              </div>
            ) : (
              <div className="cc-art-grid">
                {customSavedPresets.map((p) => (
                  <div
                    key={p.id}
                    className="cc-art-card"
                    onClick={() => {
                      const playhead = useEditor.getState().playhead;
                      const track = useEditor.getState().ensureAvailableOverlayTrack(playhead, 3);
                      const clipId = Math.random().toString(36).slice(2, 10);
                      const newClip: Clip = {
                        id: clipId,
                        kind: 'text',
                        trackId: track.id,
                        start: playhead,
                        inPoint: 0,
                        outPoint: 3,
                        style: {
                          text: p.name || 'Text',
                          fontSize: p.style?.fontSize || 40,
                          ...p.style
                        },
                        x: 0.5,
                        y: 0.5,
                        opacity: 1,
                        filterId: 'none',
                        effectId: 'none',
                        transitionId: 'none',
                        transitionDuration: 0.6
                      };
                      useEditor.setState((s) => ({
                        clips: [...s.clips, newClip],
                        selectedClipId: newClip.id,
                        selectedClipIds: [newClip.id]
                      }));
                      void flushDraft();
                    }}
                    title={p.name}
                  >
                    <div
                      className="cc-art-sample"
                      style={{
                        color: p.style?.color || '#fff',
                        fontFamily: p.style?.fontFamily || 'sans-serif',
                        fontWeight: p.style?.bold ? 800 : 700,
                        fontStyle: p.style?.italic ? 'italic' : 'normal',
                        textShadow: p.style?.shadow ? '0 2px 4px rgba(0,0,0,0.8)' : 'none',
                        WebkitTextStroke: p.style?.stroke ? `${p.style.strokeWidth || 3}px ${p.style.strokeColor || '#000'}` : undefined
                      }}
                    >
                      Aa
                    </div>
                    <div className="cc-art-label">{p.name}</div>
                    <button
                      type="button"
                      className="cc-card-add-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteCustomPreset(p.id);
                      }}
                      title="Устгах"
                      style={{ background: '#ef4444', color: '#fff', fontSize: 11 }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: TEXT EFFECTS */}
        {capcutSubNav === 'effects' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f4f4f5' }}>Text effects</div>
              <span style={{ fontSize: 10, color: '#00e5ff', fontWeight: 600 }}>CAPCUT ART STYLES</span>
            </div>
            <input
              type="text"
              placeholder="🔍 Үр дүнгээс хайх (Yellow, Glow, 3D...)"
              value={effectsSearch}
              onChange={(e) => setEffectsSearch(e.target.value)}
              className="insp-input"
              style={{ padding: '6px 10px', fontSize: 11, borderRadius: 6, background: '#181820', border: '1px solid rgba(255,255,255,0.08)', color: '#fff' }}
            />
            <div className="cc-cat-pills">
              {EFFECT_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`cc-pill ${effectsCategory === cat ? 'active' : ''}`}
                  onClick={() => setEffectsCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
            <div className="cc-art-grid">
              {TEXT_EFFECTS.filter((eff) => {
                if (effectsCategory === 'Trending') {
                  if (!eff.trending && eff.category !== 'Trending') return false;
                } else if (eff.category !== effectsCategory) {
                  return false;
                }
                if (effectsSearch && !eff.name.toLowerCase().includes(effectsSearch.toLowerCase())) return false;
                return true;
              }).map((eff) => (
                <div
                  key={eff.id}
                  className="cc-art-card"
                  onClick={() => handleAddOrApplyEffect(eff)}
                  title={eff.name}
                >
                  <div
                    className="cc-art-sample"
                    style={{
                      color: eff.style.color || '#fff',
                      backgroundImage: eff.previewGradient || 'none',
                      WebkitBackgroundClip: eff.previewGradient ? 'text' : undefined,
                      WebkitTextFillColor: eff.previewGradient ? 'transparent' : undefined,
                      textShadow: eff.previewShadow || (eff.style.shadow ? '0 2px 4px rgba(0,0,0,0.8)' : 'none'),
                      WebkitTextStroke: eff.previewStroke || (eff.style.stroke ? `${eff.style.strokeWidth || 3}px ${eff.style.strokeColor || '#000'}` : undefined),
                      fontFamily: eff.style.fontFamily || 'sans-serif',
                      fontWeight: eff.style.bold ? 800 : 700,
                      fontStyle: eff.style.italic ? 'italic' : 'normal'
                    }}
                  >
                    ART
                  </div>
                  <div className="cc-art-label">{eff.name}</div>
                  <button
                    type="button"
                    className="cc-card-add-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddOrApplyEffect(eff);
                    }}
                    title="Таймлайнд нэмэх / Сонгосон бичвэрт хэрэглэх"
                  >
                    +
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 4: TEXT TEMPLATE & FONTS */}
        {capcutSubNav === 'template' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#f4f4f5' }}>Text template & Fonts</div>
              <button
                type="button"
                className="btn ghost icon-btn"
                style={{ fontSize: 11, padding: '3px 8px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 4 }}
                onClick={importCustom}
                title="Өөрийн компьютероос .ttf / .otf / .woff2 фонт оруулах"
              >
                <span>➕</span> Фонт нэмэх
              </button>
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Presets
            </div>
            <div className="preset-grid" style={{ marginBottom: 12 }}>
              {TEXT_PRESETS.map((p) => (
                <button key={p.id} className="preset-card" onClick={() => addTextClip(p)} title={p.label}>
                  <div className="preset-stage">
                    <span
                      style={{
                        color: p.color,
                        fontWeight: p.bold ? 800 : 500,
                        fontFamily: p.fontFamily ? `"${p.fontFamily}", sans-serif` : 'inherit',
                        fontSize: Math.max(12, Math.min(22, p.fontSize / 4)),
                        background: p.background || 'transparent',
                        padding: p.background ? '2px 7px' : 0,
                        borderRadius: 4,
                        textShadow: p.shadow ? '0 2px 5px rgba(0,0,0,0.8)' : 'none',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {p.text}
                    </span>
                  </div>
                  <div className="preset-label">{p.label}</div>
                </button>
              ))}
            </div>

            {catalog.capcut.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>⚡</span> CapCut Fonts
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {catalog.capcut.map((f) => (
                    <button
                      key={f.id}
                      className="btn ghost"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 10px',
                        background: '#1a1a20',
                        border: '1px solid #282832',
                        borderRadius: 6,
                        textAlign: 'left',
                        cursor: 'pointer'
                      }}
                      onClick={() =>
                        addTextClip({
                          id: f.id,
                          label: f.name,
                          text: f.name,
                          fontSize: 72,
                          color: '#ffffff',
                          bold: f.name.toLowerCase().includes('bold'),
                          shadow: true,
                          background: '',
                          fontFamily: f.family
                        })
                      }
                      title="Энэ фонтоор бичвэр нэмэх"
                    >
                      <span style={{ fontFamily: `"${f.family}", sans-serif`, fontSize: 13, color: '#f3f4f6', fontWeight: 600 }}>
                        Aa {f.name}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--accent)', opacity: 0.8 }}>+ Нэмэх</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {catalog.custom.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>📁</span> Миний Оруулсан Фонтууд
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {catalog.custom.map((f) => (
                    <button
                      key={f.id}
                      className="btn ghost"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 10px',
                        background: '#1a1a20',
                        border: '1px solid #282832',
                        borderRadius: 6,
                        textAlign: 'left',
                        cursor: 'pointer'
                      }}
                      onClick={() =>
                        addTextClip({
                          id: f.id,
                          label: f.name,
                          text: f.name,
                          fontSize: 72,
                          color: '#ffffff',
                          bold: false,
                          shadow: true,
                          background: '',
                          fontFamily: f.family
                        })
                      }
                      title="Энэ фонтоор бичвэр нэмэх"
                    >
                      <span style={{ fontFamily: `"${f.family}", sans-serif`, fontSize: 13, color: '#f3f4f6' }}>
                        Aa {f.name}
                      </span>
                      <span style={{ fontSize: 10, color: '#10b981' }}>+ Нэмэх</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* TAB 5: AUTO CAPTIONS */}
        {capcutSubNav === 'auto' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* CapCut 1-Click Auto Caption Box */}
        <div style={{ background: '#1c1c22', padding: 12, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 12, color: '#f4f4f5' }}>
              <span>🎙️</span> Auto Captions (Автомат хадмал)
            </div>
            <span style={{ fontSize: 9, color: '#4ade80', background: 'rgba(74, 222, 128, 0.1)', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
              1-CLICK CAPCUT
            </span>
          </div>
          <div style={{ fontSize: 11, color: '#a1a1aa', marginBottom: 10, lineHeight: 1.4 }}>
            {captionClips.length > 0
              ? `Таймлайн дээр ${captionClips.length} хадмал амжилттай үүссэн байна.`
              : `Монгол скриптээ оруулж аудиотой тулгана. Текстгүй бол аудионоос яриаг таньж хадмал үүсгэнэ.`
            }
          </div>
          <label htmlFor="caption-script" style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>Монгол скрипт (заавал биш)</label>
          <div style={{ marginBottom: 10, fontSize: 12 }}>
            <label htmlFor="caption-model">Монгол яриа таних загвар</label>
            <select id="caption-model" value={captionModel} disabled={generating || modelDownloading} onChange={e => setCaptionModel(e.target.value)} style={{ width: '100%', marginTop: 5 }}>
              {captionModels.map(m => (
                <option key={m.id} value={m.id}>
                  {m.id.startsWith('groq')
                    ? `⚡ Groq Cloud · Large v3 · Cloud дээр хурдан таних`
                    : `${m.label} · ${m.installed ? (m.id.includes('large') ? 'Компьютерын CPU дээр (15-30 минут)' : 'Компьютерын CPU дээр') : `${m.mb} MB татах`}`}
                </option>
              ))}
            </select>
            {captionModel !== 'groq-whisper-large-v3' && groqKeys.length > 0 && (
              <div
                onClick={() => setCaptionModel('groq-whisper-large-v3')}
                style={{
                  marginTop: 6,
                  padding: '7px 10px',
                  background: 'rgba(234, 179, 8, 0.15)',
                  border: '1px solid rgba(234, 179, 8, 0.4)',
                  borderRadius: 6,
                  fontSize: 11,
                  color: '#facc15',
                  cursor: 'pointer',
                  lineHeight: 1.4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8
                }}
                title="Cloud дээр хурдан танихын тулд дарна уу"
              >
                <div>
                  ⚡ <strong>Зөвлөмж:</strong> Та компьютерт ажиллах загвар сонгосон байна. Groq түлхүүр байгаа тул <strong>"⚡ Groq Cloud"</strong> сонгож Cloud дээр хурдан таниулах боломжтой.
                </div>
                <span style={{ fontSize: 10, background: '#eab308', color: '#000', padding: '3px 7px', borderRadius: 4, fontWeight: 700, whiteSpace: 'nowrap' }}>
                  Groq сонгох ➔
                </span>
              </div>
            )}
            {captionModels.some(m => m.id === captionModel && !m.installed && !m.id.startsWith('groq')) && <button className="btn" disabled={generating || modelDownloading} onClick={installCaptionModel}>{modelDownloading ? `Татаж байна ${modelProgress}%` : 'Сонгосон загварыг татах'}</button>}
            <label style={{ display: 'block', marginTop: 8 }}><input type="checkbox" checked={compactCaptions} disabled={generating} onChange={e => setCompactCaptions(e.target.checked)} /> Богино хадмал · 2 мөр</label>
          </div>

          {/* Groq API Key Pool & Quota Manager */}
          <div style={{
            background: '#141418',
            border: '1px solid rgba(56, 189, 248, 0.25)',
            borderRadius: 6,
            padding: '8px 10px',
            marginBottom: 10
          }}>
            <div
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
              onClick={() => setShowKeyManager(!showKeyManager)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#38bdf8' }}>
                <span>🔑</span> Groq API түлхүүрүүд
                <span style={{ fontSize: 10, background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8', padding: '1px 6px', borderRadius: 4, fontWeight: 600 }}>
                  {groqKeys.length > 0 ? `${groqKeys.length} түлхүүр идэвхтэй` : 'Түлхүүр оруулна уу'}
                </span>
              </div>
              <span style={{ fontSize: 11, color: '#71717a' }}>{showKeyManager ? '▲ Хаах' : '▼ Нэмэх / Засах'}</span>
            </div>

            {showKeyManager && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 11, color: '#a1a1aa', lineHeight: 1.4 }}>
                  Нэг түлхүүр цагт 7,200 сек (2 цаг) яриа үнэгүй танина. Мөр тус бүрт 1 түлхүүр оруулбал квот дуусахгүй автоматаар ээлжилж ажиллана.
                </div>
                <textarea
                  value={groqKeysInput}
                  onChange={(e) => setGroqKeysInput(e.target.value)}
                  placeholder="gsk_...\n(Мөр бүрт 1 түлхүүр оруулаарай)"
                  rows={3}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    fontSize: 11,
                    fontFamily: 'monospace',
                    padding: '6px 8px',
                    borderRadius: 4,
                    border: '1px solid #52525b',
                    background: '#09090b',
                    color: '#e4e4e7',
                    resize: 'vertical'
                  }}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={handleSaveGroqKeys}
                    style={{ fontSize: 11, padding: '5px 12px', borderRadius: 4, fontWeight: 600 }}
                  >
                    💾 Хадгалах
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (window.api.openExternal) {
                        window.api.openExternal('https://console.groq.com/keys');
                      } else {
                        window.open('https://console.groq.com/keys', '_blank');
                      }
                    }}
                    style={{ fontSize: 11, padding: '5px 8px', borderRadius: 4, color: '#38bdf8' }}
                  >
                    🌐 Үнэгүй түлхүүр авах ↗
                  </button>
                </div>
                {keySaveMsg && (
                  <div style={{ fontSize: 11, color: '#4ade80', fontWeight: 600, marginTop: 2 }}>
                    {keySaveMsg}
                  </div>
                )}
              </div>
            )}
          </div>
          <textarea
            id="caption-script"
            value={captionScript}
            onChange={event => setCaptionScript(event.target.value)}
            disabled={generating || autoCutting}
            placeholder="Аудионд уншсан Монгол текстээ энд хуулж тавина уу..."
            rows={5}
            style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 90, padding: 10, borderRadius: 6, border: '1px solid #52525b', background: '#111115', color: '#f4f4f5', fontSize: 12, lineHeight: 1.5 }}
          />
          <div style={{ fontSize: 11, color: '#a1a1aa', margin: '6px 0 10px' }}>
            {captionScript.trim() ? `${captionScript.trim().length.toLocaleString()} тэмдэгт · Скриптийг аудиотой тулгана` : 'Текстгүй · Монгол яриа таних горим'}
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={generating || autoCutting || modelDownloading || !captionModels.some(m => m.id === captionModel && m.installed)}
            onClick={handleOneClickAutoCaption}
            style={{
              width: '100%',
              padding: '9px 12px',
              fontSize: 12,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              borderRadius: 6
            }}
          >
            {generating ? (
              <><span>⏳</span> {genStatus || 'Хадмал үүсгэж байна...'}</>
            ) : (
              <><span>✨</span> {captionClips.length > 0 ? 'Хадмалыг дахин 1 товшилтоор үүсгэх' : '1 товшилтоор хадмал үүсгэх (Generate)'}</>
            )}
          </button>
          {generating && (
            <button
              type="button"
              className="btn"
              onClick={async () => {
                captionGeneration.current++;
                try {
                  await window.api.cancelCaptionAlignment();
                } finally {
                  if (mounted.current) {
                    setGenerating(false);
                    setGenStatus('');
                  }
                }
              }}
              style={{
                width: '100%',
                marginTop: 8,
                padding: '8px 12px',
                fontSize: 12,
                fontWeight: 700,
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#f87171',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: 6,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6
              }}
            >
              <span>🛑</span>
              <span>Хадмал үүсгэхийг цуцлах (Зогсоох)</span>
            </button>
          )}
        </div>

        {/* Captions List & Management */}
        {captionClips.length === 0 ? (
          /* Empty State */
            <div style={{ textAlign: 'center', padding: '30px 16px', background: '#16161a', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>💬</div>
              <div style={{ fontWeight: 700, color: '#f4f4f5', fontSize: 13, marginBottom: 4 }}>
                Таймлайн дээр одоогоор хадмал алга
              </div>
              <div style={{ fontSize: 11, color: '#a1a1aa', lineHeight: 1.5, marginBottom: 14 }}>
                Дээрх <strong>"1 товшилтоор хадмал үүсгэх"</strong> товчийг дарж CapCut хадмал шууд үүсгэнэ үү.
              </div>
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: 11, padding: '7px 14px', color: '#38bdf8', border: '1px solid rgba(56, 189, 248, 0.3)', display: 'inline-flex', alignItems: 'center', gap: 6, margin: '0 auto' }}
                onClick={() => setCapcutSubNav('sync')}
              >
                <span>⚡</span> Дүрс зүсэх (Auto Sync) цэс рүү очих ➔
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Quick Auto Sync Banner */}
              <div
                onClick={() => setCapcutSubNav('sync')}
                style={{
                  background: 'linear-gradient(135deg, rgba(14, 165, 233, 0.14) 0%, rgba(99, 102, 241, 0.14) 100%)',
                  border: '1px solid rgba(56, 189, 248, 0.35)',
                  borderRadius: 8,
                  padding: '9px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
                title="Англи эх SRT болон Voice-оор дүрсийг өгүүлбэр бүрээр нь автоматаар тайрч өрөх"
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16 }}>⚡</span>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#38bdf8' }}>
                      Auto Sync (Дүрсийг автоматаар зүсэж өрөх)
                    </div>
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>
                      {captionClips.length} хадмал бэлэн · Англи SRT-тэй холбож дүрсийг зүсэх ➔
                    </div>
                  </div>
                </div>
                <span style={{ fontSize: 12, color: '#38bdf8', fontWeight: 800 }}>➔</span>
              </div>

              {/* Quick Actions & Style Bar */}
              <div style={{ background: '#1c1c22', padding: 10, borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>⚡ БҮХ ХАДМАЛД ХЭВ ЗАГВАР ХЭРЭГЛЭХ</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={fixingAI}
                      style={{
                        fontSize: 10,
                        padding: '2px 8px',
                        background: 'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)',
                        color: '#fff',
                        fontWeight: 700,
                        borderRadius: 4,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        border: 'none',
                        cursor: fixingAI ? 'wait' : 'pointer'
                      }}
                      onClick={handleAIFixMongolianCaptions}
                      title="Groq AI ашиглан хадмалын кирилл зөв бичих дүрэм, цэг таслал, үг үсгийн алдааг 1 секундэд автоматаар засах"
                    >
                      <span>{fixingAI ? '⏳' : '✨'}</span> {fixingAI ? 'AI засаж байна...' : 'AI Алдаа засах'}
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      style={{ fontSize: 10, padding: '2px 8px', background: '#3b82f6', color: '#fff', fontWeight: 700, borderRadius: 4, display: 'flex', alignItems: 'center', gap: 4 }}
                      onClick={() => {
                        setScriptFixText(captionScript || '');
                        setShowScriptFixModal(true);
                      }}
                      title="Таймлайн дээрх хадмалын үг үсгийн алдааг зөв Монгол скриптээр 100% засах"
                    >
                      <span>📝</span> Скриптээр засах
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ fontSize: 10, padding: '2px 8px', background: '#374151', color: '#f3f4f5', fontWeight: 600, borderRadius: 4, display: 'flex', alignItems: 'center', gap: 4 }}
                      onClick={handleReflowSentenceBoundaries}
                      title="Өмнөх өгүүлбэрийн төгсгөлийн үг дараагийн хадмал руу орсон алдааг бүх хадмалд автоматаар тэгшлэх"
                    >
                      <span>✂️</span> Өгүүлбэр тэгшлэх
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ fontSize: 10, padding: '2px 6px', color: '#10b981' }}
                      onClick={exportSrt}
                      title="Бүх хадмалыг .srt файл хэлбэрээр татаж авах"
                    >
                      📥 .SRT татах
                    </button>
                  </div>
                </div>
                {fixToast && (
                  <div style={{ background: 'rgba(16, 185, 129, 0.2)', border: '1px solid #10b981', color: '#34d399', padding: '6px 10px', borderRadius: 6, fontSize: 11, marginBottom: 6, fontWeight: 600 }}>
                    {fixToast}
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4 }}>
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ fontSize: 9, padding: '5px 2px', color: '#FFE600', fontWeight: 800, background: '#121216', border: '1px solid #333' }}
                    onClick={() => applyGlobalStyle({ color: '#FFE600', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: true, background: '' })}
                    title="Шар бичиг + 5px хар хүрээ"
                  >
                    🟡 Yellow
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ fontSize: 9, padding: '5px 2px', color: '#FFFFFF', fontWeight: 800, background: '#121216', border: '1px solid #333' }}
                    onClick={() => applyGlobalStyle({ color: '#FFFFFF', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: true, background: '' })}
                    title="Цагаан бичиг + 5px хар хүрээ"
                  >
                    ⚪ White
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ fontSize: 9, padding: '5px 2px', color: '#38bdf8', fontWeight: 800, background: '#121216', border: '1px solid #333' }}
                    onClick={() => applyGlobalStyle({ color: '#38bdf8', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: true, background: '' })}
                    title="Цэнхэр бичиг + 5px хар хүрээ"
                  >
                    🔵 Cyan
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ fontSize: 9, padding: '5px 2px', color: '#FFFFFF', fontWeight: 700, background: 'rgba(0,0,0,0.6)', border: '1px solid #444' }}
                    onClick={() => applyGlobalStyle({ color: '#FFFFFF', bold: true, stroke: false, strokeWidth: 0, shadow: true, background: 'rgba(0,0,0,0.65)' })}
                    title="Саарал тунгалаг дэвсгэртэй"
                  >
                    ⬛ Pill
                  </button>
                </div>
              </div>

              {/* Search Input */}
              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  className="insp-input"
                  placeholder="🔍 Хадмалаас үгээр хайх..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{ width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 6, background: '#16161a', border: '1px solid rgba(255,255,255,0.08)', color: '#fff', boxSizing: 'border-box' }}
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Captions List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {filteredCaptions.slice(0, 150).map((c, idx) => {
                  const isSelected = c.id === selectedClipId;
                  return (
                    <div
                      key={c.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        padding: '8px 10px',
                        background: isSelected ? 'rgba(56, 189, 248, 0.16)' : '#18181c',
                        border: isSelected ? '1px solid #38bdf8' : '1px solid rgba(255,255,255,0.06)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        transition: 'background 0.15s ease'
                      }}
                      onClick={() => {
                        setPlayhead(c.start);
                        select(c.id);
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10, color: '#888' }}>
                        <span style={{ fontWeight: 700, color: isSelected ? '#38bdf8' : '#a1a1aa' }}>
                          #{idx + 1} · {formatTime(c.start)} → {formatTime(c.start + c.outPoint)}
                        </span>
                        <span>{(c.outPoint).toFixed(2)}s</span>
                      </div>
                      <input
                        type="text"
                        value={c.style?.text || ''}
                        onChange={(e) => updateClipStyle(c.id, { text: e.target.value })}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          outline: 'none',
                          color: isSelected ? '#fff' : '#e4e4e7',
                          fontSize: 12,
                          lineHeight: 1.4,
                          width: '100%'
                        }}
                      />
                    </div>
                  );
                })}
                {filteredCaptions.length > 150 && (
                  <div style={{ textAlign: 'center', fontSize: 11, color: '#888', padding: 8 }}>
                    Нийт {filteredCaptions.length} хадмалаас эхний 150-ийг харуулав.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 6: LOCAL CAPTIONS */}
      {capcutSubNav === 'local' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* SRT Import & Export Card */}
          <div style={{ background: '#1c1c22', padding: 12, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 12, color: '#f4f4f5' }}>
                <span>📁</span> Local Captions (SRT Файл)
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#a1a1aa', lineHeight: 1.4, marginBottom: 10 }}>
              Компьютероосоо бэлэн .SRT хадмал оруулж таймлайнд нэмэх, эсвэл одоогийн хадмалуудыг .SRT болгон татаж авах.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <label className="btn ghost" style={{ flex: 1, textAlign: 'center', cursor: 'pointer', fontSize: 11, padding: '7px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <span>📂</span> .SRT оруулах
                <input type="file" accept=".srt" onChange={handleImportSrt} style={{ display: 'none' }} />
              </label>
              <button
                type="button"
                className="btn ghost"
                style={{ flex: 1, fontSize: 11, padding: '7px 8px', color: '#10b981', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                onClick={exportSrt}
                disabled={captionClips.length === 0}
              >
                <span>💾</span> .SRT татах
              </button>
            </div>
          </div>

          <div
            onClick={() => setCapcutSubNav('sync')}
            style={{
              background: 'linear-gradient(135deg, rgba(14, 165, 233, 0.12) 0%, rgba(99, 102, 241, 0.14) 100%)',
              border: '1px solid rgba(56, 189, 248, 0.3)',
              borderRadius: 8,
              padding: '11px 13px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>⚡</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8' }}>
                  Auto Sync (Дүрсийг автоматаар зүсэж өрөх)
                </div>
                <div style={{ fontSize: 10, color: '#94a3b8' }}>
                  Англи SRT эсвэл Voice аудиотой дүрсийг автоматаар уялдуулах цэс рүү шилжих
                </div>
              </div>
            </div>
            <span style={{ fontSize: 13, color: '#38bdf8', fontWeight: 800 }}>➔</span>
          </div>
        </div>
      )}

      {/* TAB 7: AUTO SYNC (VOICE SYNC & RECAP AUTO-CUT) */}
      {capcutSubNav === 'sync' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#f4f4f5', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>⚡</span> Auto Sync (Автомат тааруулалт)
            </div>
            <span style={{ fontSize: 9, color: '#38bdf8', background: 'rgba(56, 189, 248, 0.12)', border: '1px solid rgba(56, 189, 248, 0.3)', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
              AUTO CUT & SYNC
            </span>
          </div>

          {/* Card 1: 1-Click Timeline Voice Sync */}
          <div style={{ background: '#1c1c22', padding: 12, borderRadius: 8, border: '1px solid rgba(16, 185, 129, 0.3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 12, color: '#10b981' }}>
                <span>🎙️</span> 1-Click Voice Sync (Таймлайн)
              </div>
              <span style={{ fontSize: 9, color: '#10b981', background: 'rgba(16, 185, 129, 0.1)', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
                ШУУД
              </span>
            </div>
            <div style={{ fontSize: 11, color: '#a1a1aa', lineHeight: 1.4, marginBottom: 10 }}>
              Video 1 зам дээрх бичлэгийг Audio 1 зам дээрх монгол voice яриатай шууд тааруулж, хугацаа бүрээр нь автоматаар зүсэж өрнө.
            </div>
            <button
              type="button"
              className="btn primary"
              disabled={voiceSyncing}
              onClick={handleRunTimelineVoiceSync}
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: 12,
                fontWeight: 700,
                background: 'linear-gradient(135deg, #059669 0%, #10b981 100%)',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6
              }}
            >
              <span>{voiceSyncing ? '⏳' : '⚡'}</span>
              <span>{voiceSyncing ? 'Voice-д тааруулж байна...' : '1 товшилтоор Voice-д тааруулах'}</span>
            </button>
            {voiceSyncNotice && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#34d399', background: 'rgba(16, 185, 129, 0.1)', padding: '6px 8px', borderRadius: 4, border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                {voiceSyncNotice}
              </div>
            )}
          </div>

          {/* Card 2: Bilingual Recap Auto-Cut Box */}
          <div style={{ background: '#1c1c22', padding: 12, borderRadius: 8, border: '1px solid rgba(56, 189, 248, 0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 12, color: '#38bdf8' }}>
                <span>🎬</span> Англи SRT-ээр дүрс зүсэх (Auto-Cut)
              </div>
              <span style={{ fontSize: 9, color: '#38bdf8', background: 'rgba(56, 189, 248, 0.1)', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
                RECAP SYNC
              </span>
            </div>

            <div style={{ fontSize: 11, color: '#a1a1aa', lineHeight: 1.5, marginBottom: 10 }}>
              Монгол voice-ийн цагтай хадмалыг Англи эх SRT-тэй холбож, V1 дүрсийг ярианы хугацаанд өрнө. Дүрс хүрэлцэхгүй үед сүүлийн кадрыг царцааж барина.
            </div>

            {/* Status summary */}
            <div style={{ background: '#141418', padding: 8, borderRadius: 6, marginBottom: 10, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#a1a1aa' }}>🇲🇳 Монгол хадмал:</span>
                <span style={{ color: captionClips.length > 0 ? '#4ade80' : '#f87171', fontWeight: 600 }}>
                  {captionClips.length > 0 ? `${captionClips.length} хадмал бэлэн` : 'Байхгүй (Дээрээс үүсгэнэ үү)'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#a1a1aa' }}>🎞️ Дүрсний зам (v1):</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: tracks.find(t => t.id === 'v1')?.locked ? '#f87171' : (videoClips.length > 1 ? '#38bdf8' : '#e4e4e7'), fontWeight: 600 }}>
                    {`${videoClips.length} clip`}{tracks.find(t => t.id === 'v1')?.locked ? ' (🔒 Түгжээтэй)' : ''}
                  </span>
                  {tracks.find(t => t.id === 'v1')?.locked && (
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ fontSize: 10, padding: '2px 6px', background: '#374151', color: '#fca5a5', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: 4, cursor: 'pointer' }}
                      onClick={() => toggleTrackFlag('v1', 'locked')}
                      title="v1 замын түгжээг тайлах"
                    >
                      🔓 Түгжээ тайлах
                    </button>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#a1a1aa' }}>🇬🇧 Англи SRT:</span>
                <span style={{ color: '#e4e4e7', fontWeight: 600, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={srtPath}>
                  {srtFileName || 'Сонгоогүй'}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <button
                type="button"
                className="btn ghost"
                style={{ flex: 1, fontSize: 11, padding: '6px 8px' }}
                onClick={handleSelectSrt}
                disabled={autoCutting}
              >
                📁 Англи SRT сонгох...
              </button>
            </div>

            {/* SRT Start Time / Offset Input */}
            <div style={{ background: '#141418', padding: '8px 10px', borderRadius: 6, marginBottom: 10, border: '1px solid #27272a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#facc15' }}>
                  ⏱️ Үргэлжлэл видеоны эхлэх цаг (Offset):
                </span>
                <span style={{ fontSize: 10, color: '#71717a' }}>
                  Жишээ: 01:20:03
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="00:00:00 (Бүтэн бичлэг бол 0)"
                  value={srtStartTime}
                  onChange={(e) => setSrtStartTime(e.target.value)}
                  disabled={autoCutting}
                  style={{
                    flex: 1,
                    padding: '5px 8px',
                    fontSize: 11,
                    backgroundColor: '#1c1c22',
                    border: '1px solid #3f3f46',
                    borderRadius: 4,
                    color: '#fff'
                  }}
                />
                {srtStartTime && (
                  <button
                    type="button"
                    onClick={() => setSrtStartTime('')}
                    style={{ fontSize: 10, padding: '4px 6px', background: '#27272a', border: '1px solid #3f3f46', borderRadius: 4, color: '#a1a1aa', cursor: 'pointer' }}
                    title="Цэвэрлэх"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                {srtStartTime ? `✂️ Англи SRT-г ${srtStartTime} цагаас эхлүүлэн 00:00:00 болгож зүснэ.` : 'Хэрэв өмнөх ангийн дундаас тасалсан бичлэг бол эхлэх цагийг нь оруулна.'}
              </div>
            </div>

            {tracks.find(t => t.id === 'v1')?.locked && (
              <div style={{ background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: 6, padding: '6px 10px', marginBottom: 8, fontSize: 11, color: '#fca5a5', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span>🔒 Дүрсний зам (v1) түгжээтэй байна. Дарвал автоматаар түгжээг тайлж зүснэ.</span>
              </div>
            )}

            <button
              type="button"
              className="btn primary"
              disabled={autoCutting || generating || !srtPath || captionClips.length === 0}
              onClick={handleAutoCutBySrt}
              style={{
                width: '100%',
                padding: '9px 12px',
                fontSize: 12,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                borderRadius: 6
              }}
            >
              {autoCutting ? (
                <><span>⏳</span> {autoCutStatus || 'Дүрсийг зүсэж байна...'}</>
              ) : (
                <><span>✂️</span> Өгүүлбэр бүрээр дүрсийг зүсэж өрөх (Auto-Cut)</>
              )}
            </button>

            {autoCutSuccess && (
              <div role="status" style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(74, 222, 128, 0.1)', border: '1px solid rgba(74, 222, 128, 0.3)', borderRadius: 6, fontSize: 11, color: '#4ade80' }}>
                {autoCutSuccess}
              </div>
            )}
            {autoCutReport && <div style={{ marginTop: 8, fontSize: 11, color: '#a1a1aa', lineHeight: 1.5 }}>
              <div>Дүрс ба voice: {formatTime(autoCutReport.voiceStart)} – {formatTime(autoCutReport.voiceEnd)}. Буцаах: Ctrl+Z.</div>
              {autoCutReport.warnings.map((warning, i) => <div key={i} style={{ marginTop: 4, color: '#facc15' }}>{warning}</div>)}
            </div>}
            {autoCutError && <div role="alert" style={{ marginTop: 8, fontSize: 11, color: '#f87171' }}>{autoCutError}</div>}
          </div>

          {/* Scenes List */}
          {videoClips.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#e4e4e7' }}>
                  Зүсэгдсэн үзэгдлүүд ({videoClips.length})
                </span>
                <span style={{ fontSize: 10, color: '#71717a' }}>Дарахад шууд очно</span>
              </div>

              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  placeholder="Үзэгдэл хайх (#1, үгээр...)"
                  value={sceneSearch}
                  onChange={(e) => setSceneSearch(e.target.value)}
                  className="insp-input"
                  style={{ width: '100%', padding: '5px 8px', fontSize: 11, borderRadius: 6 }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 380, overflowY: 'auto', paddingRight: 2 }}>
                {filteredScenes.map((c, idx) => {
                  const isSelected = selectedClipId === c.id;
                  const sceneNum = c.matchedSrtId ?? (idx + 1);
                  return (
                    <div
                      key={c.id}
                      onClick={() => {
                        select(c.id);
                        setPlayhead(c.start);
                      }}
                      style={{
                        padding: '6px 8px',
                        background: isSelected ? 'rgba(56, 189, 248, 0.15)' : '#181920',
                        border: isSelected ? '1px solid #38bdf8' : '1px solid rgba(255,255,255,0.06)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        transition: 'all 0.12s'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: isSelected ? '#38bdf8' : '#a1a1aa' }}>
                          🎬 #{sceneNum}
                        </span>
                        <span style={{ fontSize: 9, color: '#71717a' }}>
                          {formatTime(c.start)} ({clipDuration(c).toFixed(1)}с)
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: '#f3f4f6', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.mongolianText || c.label?.replace(/^\[#\d+\]\s*/, '') || c.label || 'Үзэгдэл'}
                      </div>
                      {c.englishText && (
                        <div style={{ fontSize: 10, color: '#9ca3af', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                          "{c.englishText}"
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
      </div>

      {showScriptFixModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#1c1c24', border: '1px solid #3f3f46', borderRadius: 12, padding: 22, width: 600, maxWidth: '92vw', color: '#f4f4f5', boxShadow: '0 25px 50px rgba(0,0,0,0.6)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>✨</span> Хадмалыг Скриптээр алдаагүй засах
              </div>
              <button className="btn ghost" style={{ fontSize: 16, padding: '2px 8px' }} onClick={() => setShowScriptFixModal(false)}>✕</button>
            </div>
            <p style={{ fontSize: 12, color: '#a1a1aa', margin: '0 0 12px', lineHeight: 1.5 }}>
              Таймлайн дээрх хадмалын аудиотой таарсан <strong>миллисекундын цагийг хэвээр хадгалж</strong>, үг үсгийн бүх алдааг таны Монгол скриптийн зөв үгсээр 100% автоматаар сольно.
            </p>

            {/* Mode Selection Tabs */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <button
                type="button"
                className={`btn ${scriptFixMode === 'auto' ? 'primary' : 'ghost'}`}
                style={{ fontSize: 11, padding: '7px 10px', flex: 1, borderRadius: 6, background: scriptFixMode === 'auto' ? '#2563eb' : '#27272a', border: '1px solid ' + (scriptFixMode === 'auto' ? '#60a5fa' : '#3f3f46'), color: '#fff', fontWeight: 600 }}
                onClick={() => setScriptFixMode('auto')}
                title="Хэсэгчилсэн өгүүлбэр эсвэл бүтэн зохиол аль аль нь автоматаар таарч засагдана"
              >
                🔍 Автоматаар тааруулах
              </button>
              {selectedClipId && captionClips.some(c => c.id === selectedClipId) && (
                <button
                  type="button"
                  className={`btn ${scriptFixMode === 'selected' ? 'primary' : 'ghost'}`}
                  style={{ fontSize: 11, padding: '7px 10px', flex: 1, borderRadius: 6, background: scriptFixMode === 'selected' ? '#7c3aed' : '#27272a', border: '1px solid ' + (scriptFixMode === 'selected' ? '#a78bfa' : '#3f3f46'), color: '#fff', fontWeight: 600 }}
                  onClick={() => setScriptFixMode('selected')}
                  title={`Сонгосон #${captionClips.findIndex(c => c.id === selectedClipId) + 1}-р хадмалаас эхлэн үгсийг солих`}
                >
                  🎯 Сонгосон #{captionClips.findIndex(c => c.id === selectedClipId) + 1}-ээс
                </button>
              )}
              <button
                type="button"
                className={`btn ${scriptFixMode === 'full' ? 'primary' : 'ghost'}`}
                style={{ fontSize: 11, padding: '7px 10px', flex: 1, borderRadius: 6, background: scriptFixMode === 'full' ? '#059669' : '#27272a', border: '1px solid ' + (scriptFixMode === 'full' ? '#34d399' : '#3f3f46'), color: '#fff', fontWeight: 600 }}
                onClick={() => setScriptFixMode('full')}
                title="Бүх хадмалыг эхнээс нь дуустал зохиолын үгсээр жигд солих"
              >
                🌐 Бүх хадмалд тааруулах
              </button>
            </div>

            <textarea
              value={scriptFixText}
              onChange={e => setScriptFixText(e.target.value)}
              placeholder="Зөв бичсэн Монгол зохиол/скриптээ энд хуулж тавина уу (Хэсэгчилсэн өгүүлбэр эсвэл бүтэн зохиол аль ч болно)..."
              rows={8}
              style={{ width: '100%', boxSizing: 'border-box', background: '#111115', border: '1px solid #52525b', borderRadius: 8, padding: 12, color: '#fff', fontSize: 12, lineHeight: 1.6, resize: 'vertical', marginBottom: 10 }}
            />

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, fontSize: 11 }}>
              <div style={{ color: '#a1a1aa' }}>
                Оруулсан үг: <strong style={{ color: '#fff' }}>{(scriptFixText.match(/\S+/gu) || []).length}</strong> · Нийт хадмал: <strong style={{ color: '#fff' }}>{captionClips.length}</strong>
              </div>
              <div style={{ color: '#38bdf8', fontSize: 11, textAlign: 'right' }}>
                {scriptFixMode === 'auto' && '💡 Хэсэгхэн өгүүлбэр хуулсан ч бусад хадмал огт устахгүй'}
                {scriptFixMode === 'selected' && '💡 Сонгосон хадмалаас эхлэн үгс дараалан солигдоно'}
                {scriptFixMode === 'full' && '💡 Бүх хадмал бүтэн зохиолын үгсээр жигд засагдана'}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn ghost" onClick={() => setShowScriptFixModal(false)}>Цуцлах</button>
              <button
                className="btn primary"
                style={{ background: '#10b981', color: '#fff', fontWeight: 700, padding: '8px 18px', borderRadius: 6, fontSize: 13 }}
                onClick={handleApplyScriptToCaptions}
              >
                🚀 Алдааг 100% засаж солих
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
