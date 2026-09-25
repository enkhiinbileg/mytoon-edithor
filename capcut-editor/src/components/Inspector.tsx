import { useEditor, isMainVideoTrack, getVideoTrackLevel } from '../store';
import { clipDuration } from '../types';
import { EFFECTS, FILTERS, TRANSITIONS } from '../looks';
import { formatTime } from '../util';
import { interpolateClipKeyframes, getKeyframeAt, getPrevNextKeyframes } from '../keyframes';
import { useFonts } from '../fontManager';

export default function Inspector() {
  const { catalog, importCustom } = useFonts();
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
      <div className="panel-head">
        <span className="panel-title">
          {clip.kind === 'text' ? 'Text' : clip.kind === 'sticker' ? 'Sticker' : 'Clip'}
        </span>
      </div>

      <div className="panel-body" onPointerDown={()=>useEditor.getState().beginGesture()} onPointerUp={()=>useEditor.getState().endGesture()} onFocus={()=>useEditor.getState().beginGesture()} onBlur={()=>useEditor.getState().endGesture()}>
        {isOverlay && st && (
          <>
            <div className="insp-section">
              <h4>Content</h4>
              {clip.kind === 'text' ? (
                <textarea
                  className="insp-input"
                  rows={2}
                  value={st.text}
                  onChange={(e) => updateClipStyle(clip.id, { text: e.target.value })}
                />
              ) : (
                <div className="insp-row"><span>Sticker</span><span style={{ fontSize: 22 }}>{st.text}</span></div>
              )}
              {matchedVideoClip && (
                <div style={{ marginTop: 8, padding: '7px 9px', background: '#181920', borderRadius: 6, border: '1px solid rgba(56,189,248,0.2)' }}>
                  <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2 }}>🎬 Харгалзах эх дүрс:</div>
                  <div style={{ fontSize: 11, color: '#38bdf8', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={matchedVideoClip.label}>
                    {matchedVideoClip.label || 'Үзэгдэл'}
                  </div>
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ fontSize: 10, padding: '3px 8px', marginTop: 4, color: '#38bdf8', width: '100%', justifyContent: 'center' }}
                    onClick={() => select(matchedVideoClip.id)}
                  >
                    Дүрсийг тохируулах ➔
                  </button>
                </div>
              )}
            </div>

            <div className="insp-section">
              <h4>Style</h4>
              {clip.kind === 'text' && (
                <div style={{ marginBottom: 12 }}>
                  <div className="insp-row" style={{ marginBottom: 4 }}>
                    <span style={{ fontWeight: 600 }}>Фонт</span>
                    <button
                      type="button"
                      className="btn ghost icon-btn"
                      style={{ fontSize: 11, padding: '2px 6px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 4 }}
                      onClick={importCustom}
                      title="Өөрийн компьютероос .ttf / .otf / .woff2 фонт нэмэх"
                    >
                      <span>➕</span> Фонт нэмэх
                    </button>
                  </div>
                  <select
                    className="insp-input"
                    style={{
                      width: '100%',
                      padding: '6px 8px',
                      fontFamily: st.fontFamily ? `"${st.fontFamily}", sans-serif` : 'inherit',
                      fontSize: 12,
                      cursor: 'pointer',
                      borderRadius: 4
                    }}
                    value={st.fontFamily || ''}
                    onChange={(e) => updateClipStyle(clip.id, { fontFamily: e.target.value })}
                  >
                    <option value="">Default (Segoe UI)</option>
                    {catalog.capcut.length > 0 && (
                      <optgroup label="⚡ CapCut Фонтууд">
                        {catalog.capcut.map((f) => (
                          <option key={f.id} value={f.family} style={{ fontFamily: `"${f.family}", sans-serif` }}>
                            {f.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {catalog.custom.length > 0 && (
                      <optgroup label="📁 Миний Оруулсан Фонтууд">
                        {catalog.custom.map((f) => (
                          <option key={f.id} value={f.family} style={{ fontFamily: `"${f.family}", sans-serif` }}>
                            {f.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {catalog.system.length > 0 && (
                      <optgroup label="🔤 Системийн Фонтууд">
                        {catalog.system.map((f) => (
                          <option key={f.id} value={f.family} style={{ fontFamily: `"${f.family}", sans-serif` }}>
                            {f.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
              )}
              <div className="insp-row"><span>Size</span><span>{Math.round(st.fontSize)}</span></div>
              <input
                className="insp-slider"
                type="range" min={16} max={260} step={2}
                value={st.fontSize}
                onChange={(e) => updateClipStyle(clip.id, { fontSize: Number(e.target.value) })}
              />
              <div className="insp-row">
                <span>Colour</span>
                <input
                  className="insp-color"
                  type="color"
                  value={st.color}
                  onChange={(e) => updateClipStyle(clip.id, { color: e.target.value })}
                />
              </div>
              {clip.kind === 'text' && (
                <>
                  <label className="insp-check">
                    <input type="checkbox" checked={st.bold} onChange={(e) => updateClipStyle(clip.id, { bold: e.target.checked })} />
                    Bold
                  </label>
                  <label className="insp-check">
                    <input type="checkbox" checked={st.shadow} onChange={(e) => updateClipStyle(clip.id, { shadow: e.target.checked })} />
                    Shadow
                  </label>
                  <label className="insp-check">
                    <input
                      type="checkbox"
                      checked={st.stroke !== false && (Boolean(st.stroke) || Boolean(st.strokeWidth))}
                      onChange={(e) => updateClipStyle(clip.id, { stroke: e.target.checked, strokeWidth: e.target.checked ? (st.strokeWidth || 5) : 0, strokeColor: st.strokeColor || '#000000' })}
                    />
                    Stroke (Хар хүрээ)
                  </label>
                  {(st.stroke !== false && (Boolean(st.stroke) || Boolean(st.strokeWidth))) && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 8px', background: 'rgba(0,0,0,0.25)', borderRadius: 6, margin: '4px 0 8px' }}>
                      <div className="insp-row">
                        <span style={{ fontSize: 11 }}>Stroke өнгө</span>
                        <input
                          className="insp-color"
                          type="color"
                          value={st.strokeColor || '#000000'}
                          onChange={(e) => updateClipStyle(clip.id, { strokeColor: e.target.value })}
                        />
                      </div>
                      <div className="insp-row">
                        <span style={{ fontSize: 11 }}>Stroke өргөн ({st.strokeWidth || 5}px)</span>
                      </div>
                      <input
                        className="insp-range"
                        type="range"
                        min={1}
                        max={16}
                        value={st.strokeWidth || 5}
                        onChange={(e) => updateClipStyle(clip.id, { strokeWidth: Number(e.target.value) })}
                      />
                    </div>
                  )}
                  <label className="insp-check">
                    <input
                      type="checkbox"
                      checked={Boolean(st.background)}
                      onChange={(e) => updateClipStyle(clip.id, { background: e.target.checked ? 'rgba(0,0,0,0.55)' : '' })}
                    />
                    Background
                  </label>

                  {/* CapCut Style Presets */}
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', marginBottom: 6 }}>
                      ⚡ CapCut Quick Styles
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ fontSize: 10, padding: '5px 6px', color: '#FFE600', fontWeight: 800, background: '#1c1c22', border: '1px solid #333' }}
                        onClick={() => updateClipStyle(clip.id, { color: '#FFE600', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: true, background: '' })}
                      >
                        🟡 CapCut Yellow
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ fontSize: 10, padding: '5px 6px', color: '#FFFFFF', fontWeight: 800, background: '#1c1c22', border: '1px solid #333' }}
                        onClick={() => updateClipStyle(clip.id, { color: '#FFFFFF', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: true, background: '' })}
                      >
                        ⚪ CapCut White
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ fontSize: 10, padding: '5px 6px', color: '#38bdf8', fontWeight: 800, background: '#1c1c22', border: '1px solid #333' }}
                        onClick={() => updateClipStyle(clip.id, { color: '#38bdf8', bold: true, stroke: true, strokeColor: '#000000', strokeWidth: 5, shadow: true, background: '' })}
                      >
                        🔵 Anime Cyan
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ fontSize: 10, padding: '5px 6px', color: '#FFFFFF', fontWeight: 700, background: 'rgba(0,0,0,0.6)', border: '1px solid #444' }}
                        onClick={() => updateClipStyle(clip.id, { color: '#FFFFFF', bold: true, stroke: false, strokeWidth: 0, shadow: true, background: 'rgba(0,0,0,0.65)' })}
                      >
                        ⬛ Dark Pill
                      </button>
                    </div>
                  </div>

                  {/* Apply to All Captions Button */}
                  <div style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      className="btn primary"
                      style={{ width: '100%', padding: '7px 10px', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
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
                      }}
                      title="Энэ хадмалын хэв загварыг бүх 1746 хадмалд нэгэн зэрэг хуулах"
                    >
                      <span>✨</span> Бүх хадмалд хэрэглэх
                    </button>
                  </div>
                </>
              )}
            </div>

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
          </>
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
