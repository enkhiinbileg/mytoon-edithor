import { useState, useMemo } from 'react';
import { useEditor } from '../store';
import { TEXT_PRESETS } from '../looks';
import { useFonts } from '../fontManager';
import { flushDraft } from '../project';
import type { Clip } from '../types';
import { clipDuration } from '../types';

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
      .filter((c) => c.trackId === 'ov1' || c.kind === 'text')
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

  // Recap Auto-Cut state
  const [srtPath, setSrtPath] = useState<string>(
    'C:/Users/Gavl/Downloads/[English (auto-generated)] When a Top Assassin Is Reborn as a Schoolboy! - Manhwa Recap [DownSub.com].srt'
  );
  const [srtFileName, setSrtFileName] = useState<string>(
    '[English (auto-generated)] When a Top Assassin Is Reborn...srt'
  );
  const [autoCutting, setAutoCutting] = useState<boolean>(false);
  const [autoCutStatus, setAutoCutStatus] = useState<string>('');
  const [autoCutSuccess, setAutoCutSuccess] = useState<string>('');
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
        setAutoCutSuccess(`Сонгогдсон: ${res.name} (${res.entriesCount} мөр хадмал)`);
      }
    } catch (err: any) {
      alert('SRT уншихад алдаа гарлаа: ' + err.message);
    }
  };

  const handleAutoCutBySrt = async () => {
    setAutoCutting(true);
    setAutoCutStatus('🔍 Англи SRT файлыг задалж байна...');
    setAutoCutSuccess('');

    try {
      const unsub = window.api.onRecapCutProgress?.((p) => {
        if (p?.message) setAutoCutStatus(p.message);
      });

      const projectDoc = useEditor.getState().snapshotProject();
      const res = await window.api.autoCutBySrt({
        srtPath,
        captions: captionClips,
        projectData: projectDoc
      });

      unsub?.();

      if (!res || !res.ok || !res.videoClips || res.videoClips.length === 0) {
        throw new Error(res?.error || 'Дүрс тайралт амжилтгүй боллоо.');
      }

      // Replace clips on v1 with the generated video clips
      const otherClips = useEditor.getState().clips.filter((c) => c.trackId !== 'v1');
      useEditor.setState({ clips: [...otherClips, ...res.videoClips] });
      await flushDraft();

      setAutoCutSuccess(`🎉 ${res.videoClips.length} үзэгдэл Монгол ярианы цагт яг таарч амжилттай тайрагдлаа!`);
    } catch (err: any) {
      console.error(err);
      alert('Алдаа: ' + (err.message || String(err)));
    } finally {
      setAutoCutting(false);
      setAutoCutStatus('');
    }
  };

  const filteredCaptions = useMemo(() => {
    if (!searchQuery.trim()) return captionClips;
    const q = searchQuery.toLowerCase();
    return captionClips.filter((c) => (c.style?.text || '').toLowerCase().includes(q));
  }, [captionClips, searchQuery]);

  // CapCut 1-Click Auto Caption Generator
  const handleOneClickAutoCaption = async () => {
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
      setGenStatus('⚡ Долгионы амьсгаа авах зайг тооцоолж байна...');
      const res = await window.api.alignAudioScript({
        audioPath,
        scriptText: '',
        srtPath: '',
        minSilence: 0.22,
        noise: '-30dB',
        useWhisper: false,
        mode: 'auto'
      });

      if (!res || !res.ok || !res.segments || res.segments.length === 0) {
        throw new Error(res?.error || 'Хадмал үүсгэж чадсангүй.');
      }

      setGenStatus(`✨ ${res.segments.length} хадмалыг таймлайн дээр өрж байна...`);

      // 3. Ensure overlay track exists
      let ovTrack = tracks.find((t) => t.kind === 'overlay');
      if (!ovTrack) {
        addTrack('overlay');
        ovTrack = useEditor.getState().tracks.find((t) => t.kind === 'overlay')!;
      }

      // 4. Create CapCut-styled subtitle clips
      const newSubtitleClips: Clip[] = res.segments.map((seg) => ({
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
      const otherClips = useEditor.getState().clips.filter((c) => c.trackId !== ovTrack.id && c.kind !== 'text');
      useEditor.setState({ clips: [...otherClips, ...newSubtitleClips] });
      void flushDraft();

      setActiveTab('captions');
    } catch (err: any) {
      console.error(err);
      alert('Алдаа: ' + (err.message || String(err)));
    } finally {
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
              : `Хоолойны долгионы амьсгаа авах зайг тооцоолж, яг CapCut шиг 1 товшилтоор хадмал үүсгэнэ.`
            }
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={generating}
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
                Монгол хадмалуудыг Англи эх үзэгдлүүдтэй өгүүлбэр бүрээр нь тулгаж, видеоны замыг яг таг цагаар нь автоматаар зүсэж өрнө.
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
                    {videoClips.length > 1 ? `${videoClips.length} үзэгдэл зүсэгдсэн` : '1 бүтэн бичлэг (Зүсэхэд бэлэн)'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#a1a1aa' }}>🇬🇧 Англи SRT:</span>
                  <span style={{ color: '#e4e4e7', fontWeight: 600, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={srtPath}>
                    {srtFileName}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                <button
                  type="button"
                  className="btn ghost"
                  style={{ flex: 1, fontSize: 11, padding: '6px 8px' }}
                  onClick={handleSelectSrt}
                >
                  📁 Өөр SRT сонгох...
                </button>
              </div>

              <button
                type="button"
                className="btn primary"
                disabled={autoCutting || captionClips.length === 0}
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
                <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(74, 222, 128, 0.1)', border: '1px solid rgba(74, 222, 128, 0.3)', borderRadius: 6, fontSize: 11, color: '#4ade80' }}>
                  {autoCutSuccess}
                </div>
              )}
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
    </section>
  );
}
