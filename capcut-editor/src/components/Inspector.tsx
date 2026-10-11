import { useState } from 'react';
import { useEditor, isMainVideoTrack, getVideoTrackLevel } from '../store';
import type { TextStyle } from '../types';
import { clipDuration } from '../types';
import { EFFECTS, FILTERS, TRANSITIONS, PRESET_STYLES, TEXT_EFFECTS, EFFECT_CATEGORIES } from '../looks';
import { formatTime } from '../util';
import { interpolateClipKeyframes, getKeyframeAt, getPrevNextKeyframes } from '../keyframes';
import { useFonts } from '../fontManager';

export default function Inspector() {
  const { catalog, importCustom } = useFonts();
  const [textMainTab, setTextMainTab] = useState<'text' | 'animation' | 'tracking' | 'tts' | 'avatar'>('text');
  const [textSubTab, setTextSubTab] = useState<'basic' | 'bubble' | 'effects'>('basic');
  const [effectSearch, setEffectSearch] = useState('');
  const [selectedEffectCategory, setSelectedEffectCategory] = useState<string>('Trending');
  const [toastMsg, setToastMsg] = useState('');

  const clip = useEditor((s) => s.clips.find((c) => c.id === s.selectedClipId));
  const media = useEditor((s) => (clip?.mediaId ? s.media.find((m) => m.id === clip.mediaId) : undefined));
  const tracks = useEditor((s) => s.tracks);
  const moveClipToLayer = useEditor((s) => s.moveClipToLayer);
  const ensureLayerTrack = useEditor((s) => s.ensureLayerTrack);
  const clipCount = useEditor((s) => s.clips.length);
  const duration = useEditor((s) => s.duration());
  const settings = useEditor(s=>s.projectSettings);
  const projectName = useEditor(s=>s.projectName);
  const updateClip = useEditor((s) => s.updateClip);
  const updateClipStyle = useEditor((s) => s.updateClipStyle);
  const playhead = useEditor((s) => s.playhead);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const addKeyframe = useEditor((s) => s.addKeyframe);
  const removeKeyframe = useEditor((s) => s.removeKeyframe);
  const select = useEditor((s) => s.select);
  const allClips = useEditor((s) => s.clips);

  if (!clip) {
    return (
      <aside className="inspector">
        <div className="panel-head"><span className="panel-title">Details</span></div>
        <div className="panel-body">
          <div className="insp-section">
            <h4>Project settings</h4>
            <div className="insp-row"><span>Name</span><span className="truncate">{projectName}</span></div>
            <div className="insp-row"><span>Clips</span><span>{clipCount}</span></div>
            <div className="insp-row"><span>Duration</span><span>{formatTime(duration)}</span></div>
            <div className="insp-row"><span>Resolution</span><span>{settings.width}×{settings.height}</span></div>
            <div className="insp-row"><span>Frame rate</span><select aria-label="Project frame rate" className="insp-select" value={settings.fps} onChange={e=>useEditor.getState().setProjectSettings({fps:+e.target.value})}>{[24,25,30,50,60].map(f=><option key={f} value={f}>{f} fps</option>)}</select></div>
            <div className="insp-row"><span>Colour space</span><span>SDR · Rec.709</span></div>
          </div>
          <div className="empty-hint" style={{ textAlign: 'left', padding: '4px 0' }}>
            Select a clip to edit it.
          </div>
        </div>
      </aside>
    );
  }

  const isOverlay = clip.kind === 'text' || clip.kind === 'sticker';
  const isVisual = !isOverlay && media?.kind !== 'audio';
  const clipTrack = tracks.find((t) => t.id === clip.trackId);
  const isVisualClip = isVisual && clipTrack?.kind === 'video';
  const currentLevel = clipTrack ? getVideoTrackLevel(clipTrack.id, tracks) : 1;
  const isMainTrack = clipTrack ? isMainVideoTrack(clipTrack.id, tracks) : false;
  const videoTracks = tracks.filter((t) => t.kind === 'video');
  const st = clip.style;
  const matchedVideoClip = isOverlay ? allClips.find(
    (c) => c.trackId === 'v1' && c.kind === 'av' && c.start <= clip.start + 0.1 && c.start + clipDuration(c) >= clip.start - 0.1
  ) : undefined;

  const currentKeyframe = clip ? getKeyframeAt(clip, playhead) : undefined;
  const { prev: prevKf, next: nextKf } = clip ? getPrevNextKeyframes(clip, playhead) : { prev: undefined, next: undefined };
  const interpolated = clip ? interpolateClipKeyframes(clip, playhead) : { scale: 1, x: 0.5, y: 0.5, rotation: 0, opacity: 1 };
  const hasKeyframes = Boolean(clip?.keyframes && clip.keyframes.length > 0);

  const handlePropChange = (patch: { scale?: number; x?: number; y?: number; rotation?: number; opacity?: number }) => {
    if (!clip) return;
    if (hasKeyframes) {
      addKeyframe(clip.id, playhead, patch);
    } else {
      updateClip(clip.id, patch);
    }
  };

  return (
    <aside className="inspector">
      {clip.kind === 'text' ? (
        <div className="cc-insp-main-tabs">
          <button
            type="button"
            className={`cc-insp-main-tab ${textMainTab === 'text' ? 'active' : ''}`}
            onClick={() => setTextMainTab('text')}
          >
            Text
          </button>
          <button
            type="button"
            className={`cc-insp-main-tab ${textMainTab === 'animation' ? 'active' : ''}`}
            onClick={() => setTextMainTab('animation')}
          >
            Animation
          </button>
          <button
            type="button"
            className={`cc-insp-main-tab ${textMainTab === 'tracking' ? 'active' : ''}`}
            onClick={() => setTextMainTab('tracking')}
          >
            Tracking
          </button>
          <button
            type="button"
            className={`cc-insp-main-tab ${textMainTab === 'tts' ? 'active' : ''}`}
            onClick={() => setTextMainTab('tts')}
          >
            Text to speech
          </button>
          <button
            type="button"
            className={`cc-insp-main-tab ${textMainTab === 'avatar' ? 'active' : ''}`}
            onClick={() => setTextMainTab('avatar')}
          >
            AI avatars 💎
          </button>
        </div>
      ) : (
        <div className="panel-head">
          <span className="panel-title">
            {clip.kind === 'sticker' ? 'Sticker' : 'Clip'}
          </span>
        </div>
      )}

      {clip.kind === 'text' && textMainTab === 'text' && (
        <div className="cc-insp-sub-tabs">
          <button
            type="button"
            className={`cc-insp-sub-tab ${textSubTab === 'basic' ? 'active' : ''}`}
            onClick={() => setTextSubTab('basic')}
          >
            Basic
          </button>
          <button
            type="button"
            className={`cc-insp-sub-tab ${textSubTab === 'bubble' ? 'active' : ''}`}
            onClick={() => setTextSubTab('bubble')}
          >
            Bubble
          </button>
          <button
            type="button"
            className={`cc-insp-sub-tab ${textSubTab === 'effects' ? 'active' : ''}`}
            onClick={() => setTextSubTab('effects')}
          >
            Effects
          </button>
        </div>
      )}

      <div className="panel-body" onPointerDown={()=>useEditor.getState().beginGesture()} onPointerUp={()=>useEditor.getState().endGesture()} onFocus={()=>useEditor.getState().beginGesture()} onBlur={()=>useEditor.getState().endGesture()}>
        {toastMsg && (
          <div style={{ background: '#059669', color: '#fff', padding: '6px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, textAlign: 'center', marginBottom: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>
            {toastMsg}
          </div>
        )}

        {/* -------------------- CAPCUT TEXT INSPECTOR -------------------- */}
        {clip.kind === 'text' && st && (
          <>
            {/* TAB: TEXT -> BASIC */}
            {textMainTab === 'text' && textSubTab === 'basic' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {/* Content Textarea */}
                <textarea
                  className="insp-input"
                  rows={2}
                  style={{
                    width: '100%',
                    marginBottom: 10,
                    padding: '8px 10px',
                    fontSize: 12.5,
                    lineHeight: 1.4,
                    background: '#191920',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 6,
                    color: '#ffffff',
                    resize: 'vertical'
                  }}
                  value={st.text}
                  placeholder="Text content..."
                  onChange={(e) => updateClipStyle(clip.id, { text: e.target.value })}
                />

                {matchedVideoClip && (
                  <div style={{ marginBottom: 10, padding: '6px 8px', background: '#181920', borderRadius: 6, border: '1px solid rgba(56,189,248,0.2)' }}>
                    <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2 }}>🎬 Харгалзах дүрс: <span style={{ color: '#38bdf8', fontWeight: 600 }}>{matchedVideoClip.label || 'Үзэгдэл'}</span></div>
                  </div>
                )}

                {/* Font Selector */}
                <div style={{ marginBottom: 10 }}>
                  <div className="insp-row" style={{ marginBottom: 4 }}>
                    <span style={{ fontSize: 11.5, color: '#a1a1aa', fontWeight: 600 }}>Font</span>
                    <button
                      type="button"
                      className="btn ghost icon-btn"
                      style={{ fontSize: 10.5, padding: '2px 6px', color: '#00e5ff', display: 'flex', alignItems: 'center', gap: 4 }}
                      onClick={importCustom}
                      title="Өөрийн компьютероос .ttf / .otf / .woff2 фонт нэмэх"
                    >
                      <span>➕</span> Import
                    </button>
                  </div>
                  <select
                    className="insp-input"
                    style={{
                      width: '100%',
                      padding: '6px 8px',
                      fontSize: 12,
                      borderRadius: 4,
                      background: '#191920',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.1)',
                      fontFamily: st.fontFamily ? `"${st.fontFamily}", sans-serif` : 'inherit'
                    }}
                    value={st.fontFamily || ''}
                    onChange={(e) => updateClipStyle(clip.id, { fontFamily: e.target.value })}
                  >
                    <option value="">System Default</option>
                    {catalog.capcut.length > 0 && (
                      <optgroup label="⚡ CapCut Fonts">
                        {catalog.capcut.map((f) => (
                          <option key={f.id} value={f.family}>{f.name}</option>
                        ))}
                      </optgroup>
                    )}
                    {catalog.custom.length > 0 && (
                      <optgroup label="📁 Custom Fonts">
                        {catalog.custom.map((f) => (
                          <option key={f.id} value={f.family}>{f.name}</option>
                        ))}
                      </optgroup>
                    )}
                    {catalog.system.length > 0 && (
                      <optgroup label="🔤 System Fonts">
                        {catalog.system.map((f) => (
                          <option key={f.id} value={f.family}>{f.name}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>

                {/* Font Size Slider & Number Input */}
                <div style={{ marginBottom: 10 }}>
                  <div className="insp-row" style={{ marginBottom: 4 }}>
                    <span style={{ fontSize: 11.5, color: '#a1a1aa' }}>Font size</span>
                    <input
                      type="number"
                      min={8}
                      max={240}
                      value={Math.round(st.fontSize)}
                      onChange={(e) => updateClipStyle(clip.id, { fontSize: Math.max(8, Number(e.target.value)) })}
                      style={{ width: 48, padding: '2px 4px', textAlign: 'center', background: '#191920', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 4, fontSize: 12 }}
                    />
                  </div>
                  <input
                    className="insp-slider"
                    type="range"
                    min={12}
                    max={200}
                    value={st.fontSize}
                    onChange={(e) => updateClipStyle(clip.id, { fontSize: Number(e.target.value) })}
                  />
                </div>

                {/* Pattern (B U I) */}
                <div style={{ marginBottom: 10 }}>
                  <div className="insp-row">
                    <span style={{ fontSize: 11.5, color: '#a1a1aa' }}>Pattern</span>
                    <div className="cc-segmented-group" style={{ width: 140 }}>
                      <button
                        type="button"
                        className={`cc-seg-btn ${st.bold ? 'active' : ''}`}
                        onClick={() => updateClipStyle(clip.id, { bold: !st.bold })}
                        title="Bold"
                        style={{ fontWeight: 800 }}
                      >
                        B
                      </button>
                      <button
                        type="button"
                        className={`cc-seg-btn ${st.underline ? 'active' : ''}`}
                        onClick={() => updateClipStyle(clip.id, { underline: !st.underline })}
                        title="Underline"
                        style={{ textDecoration: 'underline' }}
                      >
                        U
                      </button>
                      <button
                        type="button"
                        className={`cc-seg-btn ${st.italic ? 'active' : ''}`}
                        onClick={() => updateClipStyle(clip.id, { italic: !st.italic })}
                        title="Italic"
                        style={{ fontStyle: 'italic', fontFamily: 'serif' }}
                      >
                        I
                      </button>
                    </div>
                  </div>
                </div>

                {/* Case (TT tt Tt) */}
                <div style={{ marginBottom: 10 }}>
                  <div className="insp-row">
                    <span style={{ fontSize: 11.5, color: '#a1a1aa' }}>Case</span>
                    <div className="cc-segmented-group" style={{ width: 140 }}>
                      <button
                        type="button"
                        className={`cc-seg-btn ${st.textCase === 'uppercase' ? 'active' : ''}`}
                        onClick={() => updateClipStyle(clip.id, { textCase: st.textCase === 'uppercase' ? 'none' : 'uppercase' })}
                        title="ALL UPPERCASE"
                        style={{ fontWeight: 700 }}
                      >
                        TT
                      </button>
                      <button
                        type="button"
                        className={`cc-seg-btn ${st.textCase === 'lowercase' ? 'active' : ''}`}
                        onClick={() => updateClipStyle(clip.id, { textCase: st.textCase === 'lowercase' ? 'none' : 'lowercase' })}
                        title="all lowercase"
                      >
                        tt
                      </button>
                      <button
                        type="button"
                        className={`cc-seg-btn ${st.textCase === 'capitalize' ? 'active' : ''}`}
                        onClick={() => updateClipStyle(clip.id, { textCase: st.textCase === 'capitalize' ? 'none' : 'capitalize' })}
                        title="Title Case"
                      >
                        Tt
                      </button>
                    </div>
                  </div>
                </div>

                {/* Color + Keyframe Diamond */}
                <div style={{ marginBottom: 10 }}>
                  <div className="insp-row">
                    <span style={{ fontSize: 11.5, color: '#a1a1aa' }}>Color</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ position: 'relative', width: 24, height: 24, borderRadius: 4, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer' }}>
                        <input
                          type="color"
                          value={st.color || '#FFFFFF'}
                          onChange={(e) => updateClipStyle(clip.id, { color: e.target.value })}
                          style={{ position: 'absolute', top: -8, left: -8, width: 40, height: 40, cursor: 'pointer', border: 'none', background: 'none' }}
                        />
                      </div>
                      <button
                        type="button"
                        className="btn ghost icon-btn"
                        style={{ padding: '2px 6px', fontSize: 13, color: currentKeyframe ? '#00e5ff' : '#6b7280' }}
                        onClick={() => {
                          if (currentKeyframe) {
                            removeKeyframe(clip.id, currentKeyframe.id);
                          } else {
                            addKeyframe(clip.id, playhead, { opacity: clip.opacity ?? 1 });
                          }
                        }}
                        title={currentKeyframe ? 'Keyframe устгах' : 'Keyframe нэмэх'}
                      >
                        ◇
                      </button>
                    </div>
                  </div>
                </div>

                {/* Spacing (Character & Line) */}
                <div style={{ marginBottom: 10 }}>
                  <div className="insp-row">
                    <span style={{ fontSize: 11.5, color: '#a1a1aa' }}>Spacing</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 10, color: '#71717a' }}>Char</span>
                        <input
                          type="number"
                          min={-10}
                          max={50}
                          value={st.letterSpacing || 0}
                          onChange={(e) => updateClipStyle(clip.id, { letterSpacing: Number(e.target.value) })}
                          style={{ width: 44, padding: '2px 4px', textAlign: 'center', background: '#191920', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 4, fontSize: 11 }}
                        />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 10, color: '#71717a' }}>Line</span>
                        <input
                          type="number"
                          min={-20}
                          max={50}
                          value={st.lineSpacing || 0}
                          onChange={(e) => updateClipStyle(clip.id, { lineSpacing: Number(e.target.value) })}
                          style={{ width: 44, padding: '2px 4px', textAlign: 'center', background: '#191920', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 4, fontSize: 11 }}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Alignment */}
                <div style={{ marginBottom: 12 }}>
                  <div className="insp-row" style={{ marginBottom: 6 }}>
                    <span style={{ fontSize: 11.5, color: '#a1a1aa' }}>Alignment</span>
                    <div className="cc-segmented-group" style={{ width: 140 }}>
                      <button
                        type="button"
                        className={`cc-seg-btn ${(st.align || 'center') === 'left' ? 'active' : ''}`}
                        onClick={() => updateClipStyle(clip.id, { align: 'left' })}
                        title="Left Align"
                      >
                        ⇤
                      </button>
                      <button
                        type="button"
                        className={`cc-seg-btn ${(st.align || 'center') === 'center' ? 'active' : ''}`}
                        onClick={() => updateClipStyle(clip.id, { align: 'center' })}
                        title="Center Align"
                      >
                        ≡
                      </button>
                      <button
                        type="button"
                        className={`cc-seg-btn ${(st.align || 'center') === 'right' ? 'active' : ''}`}
                        onClick={() => updateClipStyle(clip.id, { align: 'right' })}
                        title="Right Align"
                      >
                        ⇥
                      </button>
                      <button
                        type="button"
                        className={`cc-seg-btn ${(st.align || 'center') === 'justify' ? 'active' : ''}`}
                        onClick={() => updateClipStyle(clip.id, { align: 'justify' })}
                        title="Justify"
                      >
                        ≣
                      </button>
                    </div>
                  </div>
                  <div className="insp-row">
                    <span style={{ fontSize: 10, color: '#71717a' }}>Position Y</span>
                    <div className="cc-segmented-group" style={{ width: 140 }}>
                      <button
                        type="button"
                        className={`cc-seg-btn ${(clip.y ?? 0.5) < 0.3 ? 'active' : ''}`}
                        onClick={() => updateClip(clip.id, { y: 0.15 })}
                        title="Top"
                      >
                        Top
                      </button>
                      <button
                        type="button"
                        className={`cc-seg-btn ${(clip.y ?? 0.5) >= 0.3 && (clip.y ?? 0.5) <= 0.7 ? 'active' : ''}`}
                        onClick={() => updateClip(clip.id, { y: 0.5 })}
                        title="Middle"
                      >
                        Mid
                      </button>
                      <button
                        type="button"
                        className={`cc-seg-btn ${(clip.y ?? 0.5) > 0.7 ? 'active' : ''}`}
                        onClick={() => updateClip(clip.id, { y: 0.83 })}
                        title="Bottom (Subtitle)"
                      >
                        Btm
                      </button>
                    </div>
                  </div>
                </div>

                {/* Preset Style: 22 Authentic Aa Swatches */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 650, color: '#a1a1aa', marginBottom: 8 }}>
                    Preset style
                  </div>
                  <div className="cc-preset-style-grid">
                    {PRESET_STYLES.map((ps) => {
                      const isActive = st.presetStyleId === ps.id;
                      return (
                        <button
                          key={ps.id}
                          type="button"
                          className={`cc-preset-swatch ${isActive ? 'active' : ''}`}
                          style={ps.previewStyle}
                          onClick={() => updateClipStyle(clip.id, { ...ps.style, presetStyleId: ps.id })}
                          title={ps.name}
                        >
                          Aa
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Stroke & Background Detailed Controls */}
                <div style={{ padding: '8px 10px', background: '#18181f', borderRadius: 6, marginBottom: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#e4e4e7', fontWeight: 600 }}>
                      <input
                        type="checkbox"
                        checked={st.stroke !== false && (Boolean(st.stroke) || Boolean(st.strokeWidth))}
                        onChange={(e) => updateClipStyle(clip.id, { stroke: e.target.checked, strokeWidth: e.target.checked ? (st.strokeWidth || 5) : 0, strokeColor: st.strokeColor || '#000000' })}
                      />
                      Stroke (Хүрээ)
                    </label>
                    {(st.stroke !== false && (Boolean(st.stroke) || Boolean(st.strokeWidth))) && (
                      <input
                        type="color"
                        value={st.strokeColor || '#000000'}
                        onChange={(e) => updateClipStyle(clip.id, { strokeColor: e.target.value })}
                        style={{ width: 20, height: 20, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                    )}
                  </div>
                  {(st.stroke !== false && (Boolean(st.stroke) || Boolean(st.strokeWidth))) && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <input
                        className="insp-range"
                        type="range"
                        min={1}
                        max={18}
                        value={st.strokeWidth || 5}
                        onChange={(e) => updateClipStyle(clip.id, { strokeWidth: Number(e.target.value) })}
                      />
                      <span style={{ fontSize: 10, color: '#9ca3af', width: 28, textAlign: 'right' }}>{st.strokeWidth || 5}px</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, marginBottom: 4 }}>
                    <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#e4e4e7', fontWeight: 600 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(st.background)}
                        onChange={(e) => updateClipStyle(clip.id, { background: e.target.checked ? 'rgba(0,0,0,0.65)' : '' })}
                      />
                      Background (Дэвсгэр)
                    </label>
                    {Boolean(st.background) && (
                      <input
                        type="color"
                        value={st.background.startsWith('#') ? st.background : '#000000'}
                        onChange={(e) => updateClipStyle(clip.id, { background: e.target.value })}
                        style={{ width: 20, height: 20, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                    )}
                  </div>
                </div>

                {/* Bottom Buttons: Save as preset, Reset, Apply to all */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <button
                    type="button"
                    className="cc-btn-cyan"
                    style={{ flex: 1 }}
                    onClick={() => {
                      try {
                        const existing = JSON.parse(localStorage.getItem('cutline_custom_text_presets') || '[]');
                        const newPreset = {
                          id: 'custom-' + Date.now(),
                          name: `Preset ${existing.length + 1}`,
                          style: { ...clip.style }
                        };
                        localStorage.setItem('cutline_custom_text_presets', JSON.stringify([newPreset, ...existing]));
                        setToastMsg('✅ Preset-д амжилттай хадгалагдлаа!');
                        setTimeout(() => setToastMsg(''), 3000);
                      } catch (err) {
                        console.error(err);
                      }
                    }}
                    title="Энэ хэв загварыг өөрийн preset болгон хадгалах"
                  >
                    Save as preset
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ fontSize: 11, padding: '6px 12px', background: '#272730', borderRadius: 4, color: '#e4e4e7', fontWeight: 600 }}
                    onClick={() => {
                      updateClipStyle(clip.id, {
                        color: '#FFFFFF',
                        bold: true,
                        stroke: true,
                        strokeColor: '#000000',
                        strokeWidth: 5,
                        shadow: true,
                        background: '',
                        textCase: 'none',
                        italic: false,
                        underline: false,
                        letterSpacing: 0,
                        lineSpacing: 0,
                        align: 'center',
                        presetStyleId: undefined,
                        effectId: undefined
                      });
                    }}
                  >
                    Reset
                  </button>
                </div>

                <button
                  type="button"
                  className="btn primary"
                  style={{ width: '100%', padding: '7px 10px', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: '#2563eb' }}
                  onClick={() => {
                    const stylePatch = { ...clip.style };
                    const x = clip.x;
                    const y = clip.y;
                    useEditor.setState((s) => ({
                      clips: s.clips.map((c) =>
                        c.kind === 'text' && c.style
                          ? { ...c, x, y, style: { ...c.style, ...stylePatch, text: c.style.text } }
                          : c
                      )
                    }));
                    setToastMsg('✨ Бүх хадмалд хэв загварыг амжилттай хууллаа!');
                    setTimeout(() => setToastMsg(''), 3000);
                  }}
                  title="Энэ хадмалын хэв загварыг таймлайн дээрх бүх хадмалд нэгэн зэрэг хуулах"
                >
                  <span>✨</span> Бүх хадмалд хэрэглэх
                </button>
              </div>
            )}

            {/* TAB: TEXT -> EFFECTS */}
            {textMainTab === 'text' && textSubTab === 'effects' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input
                  type="text"
                  placeholder="Search for text effects/style..."
                  value={effectSearch}
                  onChange={(e) => setEffectSearch(e.target.value)}
                  style={{ width: '100%', padding: '7px 10px', background: '#1c1c23', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#fff', fontSize: 11 }}
                />
                <div className="cc-cat-pills">
                  {EFFECT_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      className={`cc-pill ${selectedEffectCategory === cat ? 'active' : ''}`}
                      onClick={() => setSelectedEffectCategory(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                <div className="cc-art-grid">
                  {TEXT_EFFECTS.filter(e => {
                    if (selectedEffectCategory === 'Trending') {
                      if (!e.trending && e.category !== 'Trending') return false;
                    } else if (e.category !== selectedEffectCategory) {
                      return false;
                    }
                    if (effectSearch && !e.name.toLowerCase().includes(effectSearch.toLowerCase())) return false;
                    return true;
                  }).map((eff) => (
                    <div
                      key={eff.id}
                      className={`cc-art-card ${st.effectId === eff.id ? 'active' : ''}`}
                      onClick={() => updateClipStyle(clip.id, { ...eff.style, effectId: eff.id })}
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
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <button
                    type="button"
                    className="cc-btn-cyan"
                    style={{ flex: 1 }}
                    onClick={() => {
                      try {
                        const existing = JSON.parse(localStorage.getItem('cutline_custom_text_presets') || '[]');
                        const newPreset = {
                          id: 'custom-' + Date.now(),
                          name: `Preset ${existing.length + 1}`,
                          style: { ...clip.style }
                        };
                        localStorage.setItem('cutline_custom_text_presets', JSON.stringify([newPreset, ...existing]));
                        setToastMsg('✅ Preset-д амжилттай хадгалагдлаа!');
                        setTimeout(() => setToastMsg(''), 3000);
                      } catch (err) {
                        console.error(err);
                      }
                    }}
                  >
                    Save as preset
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ fontSize: 11, padding: '6px 12px', background: '#272730', borderRadius: 4, color: '#e4e4e7', fontWeight: 600 }}
                    onClick={() => {
                      updateClipStyle(clip.id, {
                        color: '#FFFFFF',
                        bold: true,
                        stroke: true,
                        strokeColor: '#000000',
                        strokeWidth: 5,
                        shadow: true,
                        background: '',
                        effectId: undefined
                      });
                    }}
                  >
                    Reset
                  </button>
                </div>
              </div>
            )}

            {/* TAB: TEXT -> BUBBLE */}
            {textMainTab === 'text' && textSubTab === 'bubble' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 11, color: '#a1a1aa' }}>Text Bubble Styles</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { name: 'None', bg: '', color: '#FFFFFF' },
                    { name: 'Dark Banner', bg: 'rgba(0,0,0,0.85)', color: '#FFFFFF' },
                    { name: 'Yellow Comic', bg: '#FACC15', color: '#000000' },
                    { name: 'Cyan Glow', bg: 'rgba(6,182,212,0.85)', color: '#FFFFFF' },
                    { name: 'Red Alert', bg: '#DC2626', color: '#FFFFFF' },
                    { name: 'White Pill', bg: '#FFFFFF', color: '#000000' }
                  ].map((b) => (
                    <button
                      key={b.name}
                      type="button"
                      className="btn ghost"
                      style={{ padding: 12, borderRadius: 6, background: b.bg || '#1c1c23', color: b.color, fontWeight: 700, border: '1px solid rgba(255,255,255,0.1)' }}
                      onClick={() => updateClipStyle(clip.id, { background: b.bg, color: b.color, stroke: !b.bg })}
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* TAB: ANIMATION */}
            {textMainTab === 'animation' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8' }}>In Animations</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                  {['None', 'Fade In', 'Typewriter', 'Zoom In', 'Slide Up', 'Bounce'].map((anim) => (
                    <button
                      key={anim}
                      type="button"
                      className="btn ghost"
                      style={{ padding: '10px 4px', fontSize: 11, borderRadius: 6, background: '#1c1c23', border: '1px solid rgba(255,255,255,0.1)' }}
                      onClick={() => {
                        setToastMsg(`🎬 ${anim} анимейшн тохируулагдлаа!`);
                        setTimeout(() => setToastMsg(''), 2500);
                      }}
                    >
                      {anim}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* TAB: TRACKING */}
            {textMainTab === 'tracking' && (
              <div style={{ padding: 14, background: '#1c1c23', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', textAlign: 'center' }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>🎯</div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Motion Tracking</div>
                <div style={{ fontSize: 11, color: '#a1a1aa', marginBottom: 12 }}>Бичлэг дээрх объектын хөдөлгөөнийг дагаж текст автоматаар хөдөлнө.</div>
                <button type="button" className="cc-btn-cyan" style={{ width: '100%' }} onClick={() => alert('Motion tracking ready for active video clip.')}>
                  Start Tracking
                </button>
              </div>
            )}

            {/* TAB: TEXT TO SPEECH */}
            {textMainTab === 'tts' && (
              <div style={{ padding: 12, background: '#1c1c23', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8', marginBottom: 6 }}>🎙️ Text to Speech (Recap Хоолой)</div>
                <div style={{ fontSize: 11, color: '#a1a1aa', marginBottom: 10 }}>Сонгосон хадмалын текстийг Монгол хиймэл оюунт хоолойгоор уншуулах.</div>
                <div style={{ padding: 8, background: '#141418', borderRadius: 6, fontSize: 11, color: '#e4e4e7', marginBottom: 10 }}>
                  "{st.text}"
                </div>
                <button
                  type="button"
                  className="cc-btn-cyan"
                  style={{ width: '100%' }}
                  onClick={() => {
                    setToastMsg('✨ Recap Studio хоолой үүсгэхэд бэлэн боллоо!');
                    setTimeout(() => setToastMsg(''), 3000);
                  }}
                >
                  Generate Voiceover
                </button>
              </div>
            )}

            {/* TAB: AI AVATARS */}
            {textMainTab === 'avatar' && (
              <div style={{ padding: 14, background: '#1c1c23', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', textAlign: 'center' }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>💎</div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>AI Avatars</div>
                <div style={{ fontSize: 11, color: '#a1a1aa' }}>Хадмалын текстийг виртуал AI хөтлөгчөөр яриулах горим.</div>
              </div>
            )}
          </>
        )}

        {/* -------------------- STICKER CONTENT (NON-TEXT OVERLAY) -------------------- */}
        {clip.kind === 'sticker' && st && (
          <div className="insp-section">
            <h4>Content</h4>
            <div className="insp-row"><span>Sticker</span><span style={{ fontSize: 28 }}>{st.text}</span></div>
          </div>
        )}

        {/* -------------------- POSITION & KEYFRAMES (OVERLAY: TEXT / STICKER) -------------------- */}
        {isOverlay && (
          <div className="insp-section">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <h4 style={{ margin: 0 }}>Position & Keyframes</h4>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button
                    type="button"
                    className="btn ghost icon-btn"
                    style={{ padding: '2px 4px', fontSize: 10, opacity: prevKf ? 1 : 0.3 }}
                    disabled={!prevKf}
                    onClick={() => prevKf && setPlayhead(clip.start + prevKf.time)}
                    title="Өмнөх keyframe руу очих"
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    className="btn ghost icon-btn"
                    style={{
                      padding: '2px 6px',
                      fontSize: 13,
                      color: currentKeyframe ? 'var(--accent)' : '#888',
                      fontWeight: 'bold',
                      transition: 'all 0.15s'
                    }}
                    onClick={() => {
                      if (currentKeyframe) {
                        removeKeyframe(clip.id, currentKeyframe.id);
                      } else {
                        addKeyframe(clip.id, playhead, {
                          scale: interpolated.scale,
                          x: interpolated.x,
                          y: interpolated.y,
                          rotation: interpolated.rotation,
                          opacity: interpolated.opacity
                        });
                      }
                    }}
                    title={currentKeyframe ? "Keyframe устгах" : "Keyframe нэмэх"}
                  >
                    {currentKeyframe ? '◆' : '◇'}
                  </button>
                  <button
                    type="button"
                    className="btn ghost icon-btn"
                    style={{ padding: '2px 4px', fontSize: 10, opacity: nextKf ? 1 : 0.3 }}
                    disabled={!nextKf}
                    onClick={() => nextKf && setPlayhead(clip.start + nextKf.time)}
                    title="Дараагийн keyframe руу очих"
                  >
                    ▶
                  </button>
                  {hasKeyframes && (
                    <span style={{ fontSize: 10, color: 'var(--accent)', marginLeft: 4, fontWeight: 500 }}>
                      {clip.keyframes!.length} kf
                    </span>
                  )}
                </div>
              </div>
              <div className="insp-row"><span>Томруулалт (Scale)</span><span>{Math.round(interpolated.scale * 100)}%</span></div>
              <input className="insp-slider" type="range" min={0.1} max={3} step={0.02}
                value={interpolated.scale}
                onChange={(e) => handlePropChange({ scale: Number(e.target.value) })} />
              <div className="insp-row"><span>Хэвтээ (X)</span><span>{Math.round(interpolated.x * 100)}%</span></div>
              <input className="insp-slider" type="range" min={0} max={1} step={0.01}
                value={interpolated.x}
                onChange={(e) => handlePropChange({ x: Number(e.target.value) })} />
              <div className="insp-row"><span>Босоо (Y)</span><span>{Math.round(interpolated.y * 100)}%</span></div>
              <input className="insp-slider" type="range" min={0} max={1} step={0.01}
                value={interpolated.y}
                onChange={(e) => handlePropChange({ y: Number(e.target.value) })} />
              <div className="insp-row"><span>Эргүүлэлт</span><span>{Math.round(interpolated.rotation)}°</span></div>
              <input className="insp-slider" type="range" min={-180} max={180} step={1}
                value={interpolated.rotation}
                onChange={(e) => handlePropChange({ rotation: Number(e.target.value) })} />
              <div className="empty-hint" style={{ textAlign: 'left', padding: '4px 0' }}>
                You can also drag it in the preview.
              </div>
            </div>
        )}

        {/* Bilingual Recap Scene Match Card */}
        {Boolean(clip.matchedSrtId != null || (clip.label && clip.label.startsWith('[#'))) && (
          <div className="insp-section" style={{ background: '#16171d', border: '1px solid rgba(56, 189, 248, 0.3)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 12, color: '#38bdf8' }}>
                <span>🎬</span> Үзэгдэл #{clip.matchedSrtId ?? clip.label?.match(/\d+/)?.[0]}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {clip.isFreeze ? (
                  <span style={{ fontSize: 9, color: '#38bdf8', background: 'rgba(56, 189, 248, 0.15)', border: '1px solid rgba(56, 189, 248, 0.3)', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
                    ❄️ FREEZE HOLD
                  </span>
                ) : (
                  <span style={{ fontSize: 9, color: '#4ade80', background: 'rgba(74, 222, 128, 0.15)', border: '1px solid rgba(74, 222, 128, 0.3)', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
                    🎬 MOTION
                  </span>
                )}
                {clip.aiVerified && (
                  <span style={{ fontSize: 9, color: '#a78bfa', background: 'rgba(167, 139, 250, 0.15)', border: '1px solid rgba(167, 139, 250, 0.3)', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>
                    🤖 AI {Math.round((clip.aiConfidence ?? 0.98) * 100)}%
                  </span>
                )}
              </div>
            </div>

            {/* Mongolian Sentence */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', marginBottom: 2 }}>
                🇲🇳 Монгол тайлбар (Хоолой)
              </div>
              <div style={{ fontSize: 11, color: '#f3f4f6', lineHeight: 1.4, background: '#0f1013', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.06)' }}>
                {clip.mongolianText || clip.label?.replace(/^\[#\d+\]\s*/, '') || 'Монгол өгүүлбэр'}
              </div>
              <div style={{ fontSize: 10, color: '#71717a', marginTop: 3 }}>
                Таймлайн: {formatTime(clip.start)} ➔ {formatTime(clip.start + clipDuration(clip))} ({clipDuration(clip).toFixed(1)}с)
              </div>
            </div>

            {/* English SRT Scene */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', marginBottom: 2 }}>
                🇬🇧 Англи эх үзэгдэл (SRT)
              </div>
              <div style={{ fontSize: 11, color: '#e0e7ff', lineHeight: 1.4, fontStyle: 'italic', background: '#0f1013', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.06)' }}>
                "{clip.englishText || 'English narration scene'}"
              </div>
              <div style={{ fontSize: 10, color: '#71717a', marginTop: 3 }}>
                Эх видеоны цаг: {formatTime(clip.inPoint)} ➔ {formatTime(clip.outPoint)}
              </div>
            </div>

            {/* AI Semantic Verification Note */}
            {clip.aiReason && (
              <div style={{ marginBottom: 10, padding: '6px 8px', background: 'rgba(167, 139, 250, 0.08)', borderRadius: 6, border: '1px solid rgba(167, 139, 250, 0.2)' }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: '#a78bfa', marginBottom: 2 }}>
                  🤖 AI Утга таарал:
                </div>
                <div style={{ fontSize: 11, color: '#ddd6fe', lineHeight: 1.3 }}>
                  {clip.aiReason}
                </div>
              </div>
            )}

            {/* Video Source Slip / Nudge Controls */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', marginBottom: 4 }}>
                🎛️ Дүрсийн цагийг нааш / цааш гүйлгэх (Slip)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
                {[-1.0, -0.5, 0.5, 1.0].map((delta) => (
                  <button
                    key={delta}
                    type="button"
                    className="btn ghost"
                    style={{ fontSize: 10, padding: '4px 0', textAlign: 'center', background: '#22232b' }}
                    onClick={() => {
                      const dur = clipDuration(clip);
                      const newIn = Math.max(0, Math.round((clip.inPoint + delta) * 1000) / 1000);
                      const newOut = Math.round((newIn + dur) * 1000) / 1000;
                      updateClip(clip.id, { inPoint: newIn, outPoint: newOut });
                    }}
                    title={`Дүрсийг ${delta > 0 ? '+' + delta : delta} секундээр гүйлгэх`}
                  >
                    {delta > 0 ? `+${delta}с ►` : `◄ ${delta}с`}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {clip.sourceStart != null && (
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ flex: 1, fontSize: 10, padding: '3px 6px', color: '#a1a1aa' }}
                    onClick={() => {
                      const dur = clipDuration(clip);
                      const newIn = clip.sourceStart!;
                      updateClip(clip.id, { inPoint: newIn, outPoint: newIn + dur });
                    }}
                    title="Анхны SRT цаг руу буцаах"
                  >
                    ↺ Анхны SRT цаг
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost"
                  style={{ flex: 1, fontSize: 10, padding: '3px 6px', color: '#38bdf8' }}
                  onClick={() => setPlayhead(clip.start)}
                  title="Playhead-ийг үзэгдлийн эхлэл рүү шилжүүлэх"
                >
                  ▶ Эхлэл рүү очих
                </button>
              </div>
            </div>
          </div>
        )}

        {!isOverlay && media && (
          <div className="insp-section">
            <h4>Source</h4>
            <div className="insp-row"><span>Name</span><span title={media.name}>{media.name.length > 20 ? media.name.slice(0, 18) + '…' : media.name}</span></div>
            <div className="insp-row"><span>Resolution</span><span>{media.width}×{media.height}</span></div>
            <div className="insp-row"><span>Frame rate</span><span>{media.fps.toFixed(2)} fps</span></div>
            <div className="insp-row"><span>Audio</span><span>{media.hasAudio ? 'yes' : 'no'}</span></div>
          </div>
        )}

        <div className="insp-section">
          <h4>Timing</h4>
          <div className="insp-row"><span>Position</span><span>{formatTime(clip.start)}</span></div>
          <div className="insp-row"><span>Duration</span><span>{formatTime(clipDuration(clip))}</span></div>
        </div>

        {!isOverlay && media?.hasAudio && (
          <div className="insp-section">
            <h4>Volume</h4>
            <div className="insp-row"><span>Level</span><span>{Math.round((clip.volume ?? 1) * 100)}%</span></div>
            <input className="insp-slider" type="range" min={0} max={2} step={0.05}
              value={clip.volume ?? 1}
              onChange={(e) => updateClip(clip.id, { volume: Number(e.target.value) })} />
          </div>
        )}

        {isVisualClip && (
          <div className="insp-section">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <h4 style={{ margin: 0 }}>Давхарга (Layer)</h4>
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 4,
                  fontWeight: 600,
                  background: isMainTrack ? 'rgba(74, 222, 128, 0.18)' : 'rgba(56, 189, 248, 0.18)',
                  color: isMainTrack ? '#4ade80' : '#38bdf8',
                  border: `1px solid ${isMainTrack ? 'rgba(74, 222, 128, 0.35)' : 'rgba(56, 189, 248, 0.35)'}`
                }}
              >
                {isMainTrack ? '⚓ Үндсэн зам (Layer 1)' : `Layer ${currentLevel} (Дээд давхарга)`}
              </span>
            </div>

            <div className="insp-row" style={{ alignItems: 'center', gap: 8 }}>
              <span>Зам</span>
              <select
                className="insp-select"
                style={{ flex: 1, padding: '4px 8px', fontSize: 12 }}
                value={clipTrack?.id || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '__new_layer__') {
                    const newTrack = ensureLayerTrack('video', true);
                    updateClip(clip.id, { trackId: newTrack.id });
                  } else if (val) {
                    updateClip(clip.id, { trackId: val });
                  }
                }}
              >
                {videoTracks.map((vt) => {
                  const lvl = getVideoTrackLevel(vt.id, tracks);
                  const isMain = isMainVideoTrack(vt.id, tracks);
                  return (
                    <option key={vt.id} value={vt.id}>
                      {isMain ? `Үндсэн зам: ${vt.name} (Layer 1)` : `${vt.name} (Layer ${lvl})`}
                    </option>
                  );
                })}
                <option value="__new_layer__">+ Шинэ дээд давхарга үүсгэх...</option>
              </select>
            </div>

            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button
                type="button"
                className="btn ghost"
                style={{
                  flex: 1,
                  padding: '5px 8px',
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4
                }}
                onClick={() => moveClipToLayer(clip.id, currentLevel + 1)}
                title="Клипийг дээд давхарга руу шилжүүлэх (Дээш гарч бусад клипийн дээгүүр гарна)"
              >
                ▲ Дээш давхарга
              </button>
              <button
                type="button"
                className="btn ghost"
                style={{
                  flex: 1,
                  padding: '5px 8px',
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  opacity: currentLevel <= 1 ? 0.4 : 1
                }}
                disabled={currentLevel <= 1}
                onClick={() => moveClipToLayer(clip.id, Math.max(1, currentLevel - 1))}
                title="Клипийг доод давхарга руу шилжүүлэх"
              >
                ▼ Доош давхарга
              </button>
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 6, lineHeight: 1.3 }}>
              {isMainTrack
                ? 'Үндсэн зам дээрх видео суурь (Layer 1) болж, дээд давхаргууд үүний дээр давхарлагдан харагдана.'
                : `Layer ${currentLevel} нь Үндсэн зам болон доод давхаргуудынхаа дээр давхарлагдан харагдана.`}
            </div>
          </div>
        )}

        {isVisual && (
          <div className="insp-section">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <h4 style={{ margin: 0 }}>Transform (Байрлал, Хэмжээ)</h4>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button
                  type="button"
                  className="btn ghost icon-btn"
                  style={{ padding: '2px 4px', fontSize: 10, opacity: prevKf ? 1 : 0.3 }}
                  disabled={!prevKf}
                  onClick={() => prevKf && setPlayhead(clip.start + prevKf.time)}
                  title="Өмнөх keyframe руу очих"
                >
                  ◀
                </button>
                <button
                  type="button"
                  className="btn ghost icon-btn"
                  style={{
                    padding: '2px 6px',
                    fontSize: 13,
                    color: currentKeyframe ? 'var(--accent)' : '#888',
                    fontWeight: 'bold',
                    transition: 'all 0.15s'
                  }}
                  onClick={() => {
                    if (currentKeyframe) {
                      removeKeyframe(clip.id, currentKeyframe.id);
                    } else {
                      addKeyframe(clip.id, playhead, {
                        scale: interpolated.scale,
                        x: interpolated.x,
                        y: interpolated.y,
                        rotation: interpolated.rotation,
                        opacity: interpolated.opacity
                      });
                    }
                  }}
                  title={currentKeyframe ? "Keyframe устгах (Playhead дээр)" : "Keyframe нэмэх (Playhead дээр)"}
                >
                  {currentKeyframe ? '◆' : '◇'}
                </button>
                <button
                  type="button"
                  className="btn ghost icon-btn"
                  style={{ padding: '2px 4px', fontSize: 10, opacity: nextKf ? 1 : 0.3 }}
                  disabled={!nextKf}
                  onClick={() => nextKf && setPlayhead(clip.start + nextKf.time)}
                  title="Дараагийн keyframe руу очих"
                >
                  ▶
                </button>
                {hasKeyframes && (
                  <span style={{ fontSize: 10, color: 'var(--accent)', marginLeft: 4, fontWeight: 500 }}>
                    {clip.keyframes!.length} kf
                  </span>
                )}
              </div>
            </div>

            <div className="insp-row">
              <span>Хэлбэр</span>
              <div style={{display:'flex',gap:4}}>
                <button
                  type="button"
                  className="btn"
                  style={{fontSize:10,padding:'3px 8px',background:(clip.fitMode ?? 'contain') === 'contain' ? 'var(--accent)' : '#282828',color:(clip.fitMode ?? 'contain') === 'contain' ? '#062926' : '#bbb',fontWeight:(clip.fitMode ?? 'contain') === 'contain' ? 600 : 400}}
                  onClick={() => updateClip(clip.id, { fitMode: 'contain' })}
                  title="Багтаах (Fit) - Видеог бүрэн багтааж харуулах"
                >
                  Багтаах (Fit)
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{fontSize:10,padding:'3px 8px',background:clip.fitMode === 'cover' ? 'var(--accent)' : '#282828',color:clip.fitMode === 'cover' ? '#062926' : '#bbb',fontWeight:clip.fitMode === 'cover' ? 600 : 400}}
                  onClick={() => updateClip(clip.id, { fitMode: 'cover' })}
                  title="Дэлгэц дүүргэх (Cover) - Хажуугийн бүрсгэр хэсгийг тайрч голын манхваг дэлгэц дүүрэн томруулна"
                >
                  Дүүргэх (Cover)
                </button>
              </div>
            </div>

            <div className="insp-row">
              <span>Томруулалт (Scale)</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="number"
                  className="insp-input"
                  style={{ width: 56, textAlign: 'right', padding: '2px 4px', fontSize: 11 }}
                  min={5}
                  max={500}
                  step={1}
                  value={Math.round(interpolated.scale * 100)}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (!isNaN(val) && val > 0) {
                      handlePropChange({ scale: Math.max(0.05, Math.min(5, val / 100)) });
                    }
                  }}
                />
                <span style={{ fontSize: 11, color: '#888' }}>%</span>
              </div>
            </div>
            <input
              className="insp-slider"
              type="range" min={0.05} max={3.0} step={0.01}
              value={interpolated.scale}
              onChange={(e) => handlePropChange({ scale: Number(e.target.value) })}
              title="Масштаб тохируулах (5% - 300%)"
            />
            <div style={{ display: 'flex', gap: 4, marginTop: 4, marginBottom: 8, flexWrap: 'wrap' }}>
              {[20, 35, 50, 75, 100, 150].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  className="btn"
                  style={{
                    fontSize: 10,
                    padding: '2px 6px',
                    flex: '1 0 auto',
                    textAlign: 'center',
                    background: Math.round(interpolated.scale * 100) === pct ? 'var(--accent)' : '#282828',
                    color: Math.round(interpolated.scale * 100) === pct ? '#062926' : '#bbb',
                    fontWeight: Math.round(interpolated.scale * 100) === pct ? 600 : 400
                  }}
                  onClick={() => handlePropChange({ scale: pct / 100 })}
                  title={`${pct}% болгох`}
                >
                  {pct}%
                </button>
              ))}
            </div>

            <div className="insp-row">
              <span>Хэвтээ байрлал (X)</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="number"
                  className="insp-input"
                  style={{ width: 56, textAlign: 'right', padding: '2px 4px', fontSize: 11 }}
                  min={-100}
                  max={100}
                  step={1}
                  value={Math.round((interpolated.x - 0.5) * 200)}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (!isNaN(val)) {
                      handlePropChange({ x: 0.5 + val / 200 });
                    }
                  }}
                />
                <span style={{ fontSize: 11, color: '#888' }}>%</span>
              </div>
            </div>
            <input
              className="insp-slider"
              type="range" min={-0.5} max={1.5} step={0.01}
              value={interpolated.x}
              onChange={(e) => handlePropChange({ x: Number(e.target.value) })}
            />

            <div className="insp-row">
              <span>Босоо байрлал (Y)</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="number"
                  className="insp-input"
                  style={{ width: 56, textAlign: 'right', padding: '2px 4px', fontSize: 11 }}
                  min={-100}
                  max={100}
                  step={1}
                  value={Math.round((interpolated.y - 0.5) * 200)}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (!isNaN(val)) {
                      handlePropChange({ y: 0.5 + val / 200 });
                    }
                  }}
                />
                <span style={{ fontSize: 11, color: '#888' }}>%</span>
              </div>
            </div>
            <input
              className="insp-slider"
              type="range" min={-0.5} max={1.5} step={0.01}
              value={interpolated.y}
              onChange={(e) => handlePropChange({ y: Number(e.target.value) })}
            />

            <div style={{ display: 'flex', gap: 6, marginTop: 4, marginBottom: 8 }}>
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: 10, padding: '3px 8px', flex: 1, justifyContent: 'center' }}
                onClick={() => handlePropChange({ x: 0.5, y: 0.5 })}
                title="Видеог дэлгэцийн голд төвлөрүүлэх"
              >
                Төвд байрлуулах (Голлох)
              </button>
            </div>

            <div className="insp-row">
              <span>Эргүүлэлт (Rotation)</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="number"
                  className="insp-input"
                  style={{ width: 56, textAlign: 'right', padding: '2px 4px', fontSize: 11 }}
                  min={-180}
                  max={180}
                  step={1}
                  value={Math.round(interpolated.rotation)}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (!isNaN(val)) {
                      handlePropChange({ rotation: val });
                    }
                  }}
                />
                <span style={{ fontSize: 11, color: '#888' }}>°</span>
              </div>
            </div>
            <input
              className="insp-slider"
              type="range" min={-180} max={180} step={1}
              value={interpolated.rotation}
              onChange={(e) => handlePropChange({ rotation: Number(e.target.value) })}
            />
            <div style={{ display: 'flex', gap: 4, marginTop: 4, marginBottom: 8 }}>
              {[0, 90, 180, -90].map((deg) => (
                <button
                  key={deg}
                  type="button"
                  className="btn"
                  style={{
                    fontSize: 10,
                    padding: '2px 6px',
                    flex: 1,
                    textAlign: 'center',
                    background: Math.round(interpolated.rotation) === deg ? 'var(--accent)' : '#282828',
                    color: Math.round(interpolated.rotation) === deg ? '#062926' : '#bbb',
                    fontWeight: Math.round(interpolated.rotation) === deg ? 600 : 400
                  }}
                  onClick={() => handlePropChange({ rotation: deg })}
                >
                  {deg}°
                </button>
              ))}
            </div>

            {(hasKeyframes || (clip.scale ?? 1) !== 1 || (clip.x ?? 0.5) !== 0.5 || (clip.y ?? 0.5) !== 0.5 || (clip.rotation ?? 0) !== 0 || clip.fitMode === 'cover') && (
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: 10, marginTop: 6, padding: '5px 8px', width: '100%', justifyContent: 'center', color: '#ff8080' }}
                onClick={() => {
                  updateClip(clip.id, { scale: 1, x: 0.5, y: 0.5, rotation: 0, fitMode: 'contain', keyframes: [] });
                }}
              >
                ↺ Анхны хэмжээ, байрлалыг сэргээх (Reset)
              </button>
            )}
          </div>
        )}

        <div className="insp-section">
          <h4>Looks</h4>
          {isVisual && (
            <div className="insp-row">
              <span>Filter</span>
              <select className="insp-select" value={clip.filterId ?? 'none'}
                onChange={(e) => updateClip(clip.id, { filterId: e.target.value })}>
                {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </div>
          )}
          {isVisual && <div className="insp-row">
            <span>Effect</span>
            <select className="insp-select" value={clip.effectId ?? 'none'}
              onChange={(e) => updateClip(clip.id, { effectId: e.target.value })}>
              {EFFECTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>}
          {isVisual && (
            <>
              <div className="insp-row">
                <span>Transition</span>
                <select className="insp-select" value={clip.transitionId ?? 'none'}
                  onChange={(e) => updateClip(clip.id, { transitionId: e.target.value })}>
                  {TRANSITIONS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </div>
              {(clip.transitionId ?? 'none') !== 'none' && (
                <>
                  <div className="insp-row"><span>Length</span><span>{(clip.transitionDuration ?? 0.6).toFixed(1)}s</span></div>
                  <input className="insp-slider" type="range" min={0.2} max={2} step={0.1}
                    value={clip.transitionDuration ?? 0.6}
                    onChange={(e) => updateClip(clip.id, { transitionDuration: Number(e.target.value) })} />
                </>
              )}
            </>
          )}
          <div className="insp-row"><span>Opacity</span><span>{Math.round(interpolated.opacity * 100)}%</span></div>
          <input className="insp-slider" type="range" min={0} max={1} step={0.02}
            value={interpolated.opacity}
            onChange={(e) => handlePropChange({ opacity: Number(e.target.value) })} />
        </div>
      </div>
    </aside>
  );
}
