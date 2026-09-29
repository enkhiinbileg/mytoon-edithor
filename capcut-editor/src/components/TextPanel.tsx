import { useState, useMemo, useRef, useEffect } from 'react';
import { useEditor } from '../store';
import { TEXT_PRESETS } from '../looks';
import { useFonts } from '../fontManager';
import { flushDraft } from '../project';
import type { Clip, RecapCutReport } from '../types';
import { clipDuration } from '../types';
import { layoutCaptions } from '../captionLayout';
import { alignScriptToClips } from '../alignScriptToClips';

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

  const [activeTab, setActiveTab] = useState<'captions' | 'recap' | 'presets'>('captions');
  const [searchQuery, setSearchQuery] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState('');
  const [captionScript, setCaptionScript] = useState('');
  const [captionModels, setCaptionModels] = useState<{id:string;label:string;mb:number;installed:boolean}[]>([]);
  const [captionModel, setCaptionModel] = useState('groq-whisper-large-v3');
  const [modelDownloading, setModelDownloading] = useState(false);
  const [modelProgress, setModelProgress] = useState(0);
  const [compactCaptions, setCompactCaptions] = useState(true);
  const [showScriptFixModal, setShowScriptFixModal] = useState(false);
  const [scriptFixText, setScriptFixText] = useState('');
  const [fixToast, setFixToast] = useState('');

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

    const fixed = alignScriptToClips(text, captionClips);
    const fixedMap = new Map(fixed.map(c => [c.id, c.style?.text || '']));

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

    setShowScriptFixModal(false);
    setFixToast(`✅ ${fixed.length} хадмалын үгийг скриптээр амжилттай заслаа!`);
    setTimeout(() => setFixToast(''), 4000);
  };
  useEffect(() => {
    window.api.whisperStatus().then(status => {
      setCaptionModels(status.models);
      const groq = status.models.find(m => m.id.startsWith('groq') && m.installed);
      const best = groq || [...status.models].reverse().find(m => m.installed);
      if (best) setCaptionModel(best.id);
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
    autoCutBusy.current = true;
    setAutoCutting(true);
    setAutoCutStatus('🔍 Англи SRT файлыг задалж байна...');
    setAutoCutSuccess('');
    setAutoCutReport(null);
    setAutoCutError('');
    let unsub: (() => void) | undefined;
    const original = useEditor.getState();
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
        captions: captionClips,
        projectData: projectDoc,
        requestId
      });

      if (!res.ok) throw new Error(res.error || 'Дүрс тайралт амжилтгүй боллоо.');
      if (!res.videoClips.length || !res.report || (res.report.coveredCaptionCount ?? res.report.matchedCaptionCount) !== captionClips.length || Math.abs(res.report.durationError) > 0.000001) throw new Error('Тааруулалтын эцсийн шалгалт амжилтгүй.');
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
    const startingClips = useEditor.getState().clips;
    const unsubscribe = window.api.onVoiceAlignProgress(p => {
      setGenStatus(`${typeof p.pct === 'number' ? Math.round(p.pct) + '% · ' : ''}${p.message || 'Яриаг таньж байна...'}`);
    });
    setGenerating(true);
    setGenStatus('🎙️ Аудиог уншиж байна...');

    try {
      // 1. Locate audio from timeline or media pool
      const aTrack = tracks.find((t) => t.kind === 'audio');
      const aClip = aTrack ? clips.find((c) => c.trackId === aTrack.id && c.kind === 'av') : null;
      let targetMedia = aClip?.mediaId ? media.find((m) => m.id === aClip.mediaId) : null;
      if (!targetMedia) {
        targetMedia = media.find((m) => m.kind === 'audio' || m.hasAudio) || media[0];
      }

      const audioPath = targetMedia?.path || '';

      // 2. Call backend alignment engine
      if (!audioPath) throw new Error('Эхлээд аудио файл оруулна уу.');
      setGenStatus('🎙️ Монгол яриаг таньж хадмал үүсгэж байна...');
      const res = await window.api.alignAudioScript({
        audioPath,
        whisperModel: captionModel,
        scriptText: captionScript.trim(),
        srtPath: '',
        minSilence: 0.22,
        noise: '-30dB',
        useWhisper: true,
        mode: captionScript.trim() ? 'script_captions' : 'auto'
      });

      if (!res || !res.ok || !res.segments || res.segments.length === 0) {
        throw new Error(res?.error || 'Хадмал үүсгэж чадсангүй.');
      }

      setGenStatus(`✨ ${res.segments.length} хадмалыг таймлайн дээр өрж байна...`);
      if (useEditor.getState().clips !== startingClips) throw new Error('Ажиллах хооронд таймлайн өөрчлөгдсөн тул хадмалыг сольсонгүй. Дахин үүсгэхэд хадгалсан танилтыг ашиглана.');

      // 3. Ensure overlay track exists
      let ovTrack = tracks.find((t) => t.kind === 'overlay');
      if (!ovTrack) {
        addTrack('overlay');
        ovTrack = useEditor.getState().tracks.find((t) => t.kind === 'overlay')!;
      }

      // 4. Create CapCut-styled subtitle clips
      const visibleSegments = (compactCaptions ? layoutCaptions(res.segments) : res.segments).map(seg => {
        if (!aClip) return seg;
        const start = Math.max(seg.start, aClip.inPoint);
        const end = Math.min(seg.start + seg.duration, aClip.outPoint);
        return { ...seg, start: aClip.start + start - aClip.inPoint, duration: end - start };
      }).filter(seg => seg.duration > 0);
      if (!visibleSegments.length) throw new Error('Сонгосон аудионы хэсэгт яриа танигдсангүй.');
      const newSubtitleClips: Clip[] = visibleSegments.map((seg) => ({
        id: Math.random().toString(36).slice(2, 10),
        kind: 'text',
        trackId: ovTrack.id,
        start: seg.start,
        inPoint: 0,
        outPoint: seg.duration,
        style: {
          text: seg.text,
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

      // 5. Replace existing text clips or append
      const otherClips = useEditor.getState().clips.filter((c) => c.kind !== 'text');
      useEditor.setState({ clips: [...otherClips, ...newSubtitleClips] });
      void flushDraft();

      setActiveTab('captions');
    } catch (err: any) {
      console.error(err);
      alert('Алдаа: ' + (err.message || String(err)));
    } finally {
      unsubscribe?.();
      setGenerating(false);
      setGenStatus('');
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

  return (
    <section className="panel" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Standard Header */}
      <div className="panel-head" style={{ height: 49, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px' }}>
        <span className="panel-title" style={{ fontWeight: 700, fontSize: 13, color: '#e4e4e7' }}>
          Text & Auto Captions
        </span>
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

      {/* Panel Body */}
      <div className="panel-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
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
              {captionModels.map(m => <option key={m.id} value={m.id}>{m.label} · {m.installed ? (m.id.startsWith('groq') ? '⚡ Бэлэн (Cloud)' : 'Суусан') : `${m.mb} MB татах`}</option>)}
            </select>
            {captionModels.some(m => m.id === captionModel && !m.installed && !m.id.startsWith('groq')) && <button className="btn" disabled={generating || modelDownloading} onClick={installCaptionModel}>{modelDownloading ? `Татаж байна ${modelProgress}%` : 'Сонгосон загварыг татах'}</button>}
            <label style={{ display: 'block', marginTop: 8 }}><input type="checkbox" checked={compactCaptions} disabled={generating} onChange={e => setCompactCaptions(e.target.checked)} /> Богино хадмал · 2 мөр</label>
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
          {generating && <button className="btn" onClick={() => window.api.cancelCaptionAlignment()}>Хадмал үүсгэхийг цуцлах</button>}
        </div>

        {/* Tab Switcher */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, background: '#141418', padding: 4, borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
          <button
            type="button"
            className={`btn ${activeTab === 'captions' ? 'primary' : 'ghost'}`}
            style={{ fontSize: 10, padding: '6px 2px', fontWeight: 700, borderRadius: 6, textAlign: 'center' }}
            onClick={() => setActiveTab('captions')}
          >
            💬 Captions ({captionClips.length})
          </button>
          <button
            type="button"
            className={`btn ${activeTab === 'recap' ? 'primary' : 'ghost'}`}
            style={{ fontSize: 10, padding: '6px 2px', fontWeight: 700, borderRadius: 6, textAlign: 'center' }}
            onClick={() => setActiveTab('recap')}
          >
            🎬 Video Sync ({videoClips.length > 1 ? videoClips.length : 'Auto'})
          </button>
          <button
            type="button"
            className={`btn ${activeTab === 'presets' ? 'primary' : 'ghost'}`}
            style={{ fontSize: 10, padding: '6px 2px', fontWeight: 700, borderRadius: 6, textAlign: 'center' }}
            onClick={() => setActiveTab('presets')}
          >
            🔤 Text/Fonts
          </button>
        </div>

        {activeTab === 'captions' ? (
          captionClips.length === 0 ? (
            /* Empty State */
            <div style={{ textAlign: 'center', padding: '30px 16px', background: '#16161a', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>💬</div>
              <div style={{ fontWeight: 700, color: '#f4f4f5', fontSize: 13, marginBottom: 4 }}>
                Таймлайн дээр одоогоор хадмал алга
              </div>
              <div style={{ fontSize: 11, color: '#a1a1aa', lineHeight: 1.5, marginBottom: 14 }}>
                Дээрх <strong>"1 товшилтоор хадмал үүсгэх"</strong> товчийг дарж CapCut хадмал шууд үүсгэнэ үү.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Quick Actions & Style Bar */}
              <div style={{ background: '#1c1c22', padding: 10, borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>⚡ БҮХ ХАДМАЛД ХЭВ ЗАГВАР ХЭРЭГЛЭХ</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
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
                      <span>✨</span> Скриптээр засах
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
          )
        ) : activeTab === 'recap' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Bilingual Recap Auto-Cut Box */}
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
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#a1a1aa' }}>🎞️ Дүрсний зам (v1):</span>
                  <span style={{ color: videoClips.length > 1 ? '#38bdf8' : '#e4e4e7', fontWeight: 600 }}>
                    {`${videoClips.length} clip`}
                  </span>
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

              <button
                type="button"
                className="btn primary"
                disabled={autoCutting || generating || !srtPath || captionClips.length === 0 || tracks.find(t => t.id === 'v1')?.locked}
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
        ) : (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
              Text Presets
            </div>
            <div className="preset-grid" style={{ marginBottom: 18 }}>
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
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>⚡</span> CapCut Fonts
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
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
                <div style={{ fontSize: 11, fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>📁</span> Миний Оруулсан Фонтууд
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
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
      </div>

      {showScriptFixModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#1c1c24', border: '1px solid #3f3f46', borderRadius: 12, padding: 22, width: 560, maxWidth: '92vw', color: '#f4f4f5', boxShadow: '0 25px 50px rgba(0,0,0,0.6)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>✨</span> Хадмалыг Скриптээр алдаагүй засах
              </div>
              <button className="btn ghost" style={{ fontSize: 16, padding: '2px 8px' }} onClick={() => setShowScriptFixModal(false)}>✕</button>
            </div>
            <p style={{ fontSize: 12, color: '#a1a1aa', margin: '0 0 12px', lineHeight: 1.5 }}>
              Таймлайн дээрх хадмалын аудиотой таарсан <strong>миллисекундын цагийг хэвээр хадгалж</strong>, үг үсгийн бүх алдааг таны Монгол скриптийн зөв үгсээр автоматаар сольно.
            </p>
            <textarea
              value={scriptFixText}
              onChange={e => setScriptFixText(e.target.value)}
              placeholder="Зөв бичсэн Монгол зохиол/скриптээ энд хуулж тавина уу..."
              rows={8}
              style={{ width: '100%', boxSizing: 'border-box', background: '#111115', border: '1px solid #52525b', borderRadius: 8, padding: 12, color: '#fff', fontSize: 12, lineHeight: 1.6, resize: 'vertical', marginBottom: 14 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn ghost" onClick={() => setShowScriptFixModal(false)}>Цуцлах</button>
              <button
                className="btn primary"
                style={{ background: '#10b981', color: '#fff', fontWeight: 700, padding: '8px 16px', borderRadius: 6 }}
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
