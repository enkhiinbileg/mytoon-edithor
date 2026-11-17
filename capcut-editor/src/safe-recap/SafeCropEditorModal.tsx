import React, { useEffect, useRef, useState } from 'react';
import type { SafeCensorBox, SafeCensorMode, SafeCropRect, SafePanelItem } from './types';

interface Props {
  panel: SafePanelItem;
  sessionId: string;
  defaultCensorMode: SafeCensorMode;
  onClose: () => void;
  onSave: (updated: SafePanelItem) => void;
}

const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export default function SafeCropEditorModal({ panel, sessionId, defaultCensorMode, onClose, onSave }: Props) {
  const [cropRect, setCropRect] = useState<SafeCropRect | null>(panel.cropRect ? { ...panel.cropRect } : null);
  const [censorBoxes, setCensorBoxes] = useState<SafeCensorBox[]>(
    Array.isArray(panel.censorBoxes) ? panel.censorBoxes.map((b) => ({ ...b })) : []
  );
  const [tool, setTool] = useState<'crop' | 'censor'>('crop');
  const [newMode, setNewMode] = useState<SafeCensorMode>(defaultCensorMode);
  const [showOverlayHints, setShowOverlayHints] = useState<boolean>(true);
  const [previewMode, setPreviewMode] = useState<'edit' | 'sanitized'>('edit');
  const [sanitizedUrl, setSanitizedUrl] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [recheckInfo, setRecheckInfo] = useState<string>('');

  const imgBoxRef = useRef<HTMLDivElement | null>(null);
  const [dragState, setDragState] = useState<{
    kind: 'draw_crop' | 'move_crop' | 'draw_censor';
    startX: number;
    startY: number;
    origCrop?: SafeCropRect;
  } | null>(null);
  const [draftBox, setDraftBox] = useState<SafeCropRect | null>(null);

  const imgAspect = (panel.width || 1080) / Math.max(1, panel.height || 1440);

  const getRelPoint = (e: React.PointerEvent) => {
    const rect = imgBoxRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    return {
      x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((e.clientY - rect.top) / rect.height, 0, 1)
    };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (previewMode === 'sanitized') return;
    e.preventDefault();
    const pt = getRelPoint(e);
    if (tool === 'crop') {
      if (
        cropRect &&
        pt.x >= cropRect.x &&
        pt.x <= cropRect.x + cropRect.w &&
        pt.y >= cropRect.y &&
        pt.y <= cropRect.y + cropRect.h
      ) {
        setDragState({ kind: 'move_crop', startX: pt.x, startY: pt.y, origCrop: { ...cropRect } });
      } else {
        setDragState({ kind: 'draw_crop', startX: pt.x, startY: pt.y });
        setDraftBox({ x: pt.x, y: pt.y, w: 0.02, h: 0.02 });
      }
    } else {
      setDragState({ kind: 'draw_censor', startX: pt.x, startY: pt.y });
      setDraftBox({ x: pt.x, y: pt.y, w: 0.02, h: 0.02 });
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragState) return;
    const pt = getRelPoint(e);
    if (dragState.kind === 'move_crop' && dragState.origCrop) {
      const dx = pt.x - dragState.startX;
      const dy = pt.y - dragState.startY;
      const nx = clamp(dragState.origCrop.x + dx, 0, 1 - dragState.origCrop.w);
      const ny = clamp(dragState.origCrop.y + dy, 0, 1 - dragState.origCrop.h);
      setCropRect({ ...dragState.origCrop, x: nx, y: ny });
    } else {
      const x = Math.min(dragState.startX, pt.x);
      const y = Math.min(dragState.startY, pt.y);
      const w = Math.max(0.03, Math.abs(pt.x - dragState.startX));
      const h = Math.max(0.03, Math.abs(pt.y - dragState.startY));
      setDraftBox({ x, y, w: Math.min(1 - x, w), h: Math.min(1 - y, h) });
    }
  };

  const handlePointerUp = () => {
    if (!dragState) return;
    if (dragState.kind === 'draw_crop' && draftBox && draftBox.w >= 0.08 && draftBox.h >= 0.08) {
      setCropRect(draftBox);
    } else if (dragState.kind === 'draw_censor' && draftBox && draftBox.w >= 0.03 && draftBox.h >= 0.03) {
      setCensorBoxes((prev) => [...prev, { id: uid(), ...draftBox, mode: newMode, strength: 24 }]);
    }
    setDragState(null);
    setDraftBox(null);
  };

  const applyFaceAutoCrop = () => {
    const face = panel.faceBoxes?.[0];
    if (!face) {
      setCropRect({ x: 0, y: 0, w: 1, h: 0.45 });
      return;
    }
    const cx = face.x + face.w / 2;
    const cy = face.y + face.h / 2;
    const w = Math.min(1, Math.max(0.48, face.w * 2.8));
    const h = Math.min(1, Math.max(0.38, face.h * 2.8));
    const x = clamp(cx - w / 2, 0, 1 - w);
    const y = clamp(cy - h * 0.42, 0, 1 - h);
    setCropRect({ x, y, w, h });
  };

  const refreshSanitizedPreview = async (runRecheck = false) => {
    if (!window.api.safeRecap) return;
    setBusy(true);
    setRecheckInfo('');
    try {
      const res = await window.api.safeRecap.previewEdit({
        sessionId,
        panel,
        cropRect,
        censorBoxes,
        recheck: runRecheck
      });
      if (res.ok && res.previewPath) {
        setSanitizedUrl(window.api.toMediaUrl(res.previewPath) + `?t=${Date.now()}`);
        setPreviewMode('sanitized');
        if (runRecheck && res.recheck) {
          setRecheckInfo(
            res.recheck.safe
              ? `✓ Локал ONNX дахин шалгалт: АЮУЛГҮЙ (NSFW=${Math.round((res.recheck.nsfwScore || 0) * 100)}%)`
              : `⚠️ Анхаар: Дахин шалгалтаар эрсдэл илэрлээ (NSFW=${Math.round((res.recheck.nsfwScore || 0) * 100)}%). Crop/Blur-ээ нэмнэ үү.`
          );
        }
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (previewMode === 'sanitized' && !sanitizedUrl) {
      refreshSanitizedPreview(false);
    }
  }, [previewMode]);

  const handleSave = async (forceStatus?: SafePanelItem['safetyStatus']) => {
    if (!window.api.safeRecap) return;
    setBusy(true);
    try {
      const res = await window.api.safeRecap.previewEdit({
        sessionId,
        panel,
        cropRect,
        censorBoxes,
        recheck: forceStatus !== 'excluded',
        materializeFull: true
      });
      const nextStatus: SafePanelItem['safetyStatus'] =
        forceStatus ||
        (censorBoxes.length > 0 ? 'blurred' : cropRect ? 'cropped' : 'safe');

      onSave({
        ...panel,
        cropRect,
        censorBoxes,
        safetyStatus: nextStatus,
        sanitizedThumbPath: res.previewPath || panel.sanitizedThumbPath,
        sanitizedRenderPath: res.renderPath || panel.sanitizedRenderPath,
        sanitizedWidth: res.renderWidth || panel.width,
        sanitizedHeight: res.renderHeight || panel.height,
        recheckSafe: res.recheck?.safe ?? true,
        needsReview: false,
        safetyReason:
          nextStatus === 'excluded'
            ? 'Хэрэглэгч хассан'
            : censorBoxes.length > 0 && cropRect
            ? 'Гараар Crop + Blur хийсэн'
            : censorBoxes.length > 0
            ? 'Гараар Blur/Mask хийсэн'
            : cropRect
            ? 'Гараар аюулгүй хэсгийг Crop хийсэн'
            : 'Гараар аюулгүй гэж баталгаажуулсан'
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.88)',
        zIndex: 10020,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16
      }}
    >
      <div
        style={{
          width: '94vw',
          maxWidth: 1120,
          height: '90vh',
          backgroundColor: '#141418',
          border: '1px solid #2e2e36',
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid #27272f',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: '#191920'
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#f4f4f5' }}>
              ✂️ Аюулгүй Crop & Censor Засварлагч — {panel.name}
            </div>
            <div style={{ fontSize: 11, color: '#a1a1aa' }}>
              Эх зургийг өөрчлөхгүй! Ногоон хүрээгээр аюулгүй хэсгийг авч, эсвэл Blur хайрцаг зурна уу.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#a1a1aa', fontSize: 20, cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        {/* Toolbar */}
        <div
          style={{
            padding: '8px 16px',
            borderBottom: '1px solid #27272f',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            backgroundColor: '#18181f'
          }}
        >
          <button
            type="button"
            onClick={() => {
              setPreviewMode('edit');
              setTool('crop');
            }}
            style={{
              padding: '5px 10px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
              border: previewMode === 'edit' && tool === 'crop' ? '1px solid #10b981' : '1px solid #333',
              background: previewMode === 'edit' && tool === 'crop' ? 'rgba(16,185,129,0.22)' : '#23232b',
              color: previewMode === 'edit' && tool === 'crop' ? '#6ee7b7' : '#d4d4d8'
            }}
          >
            ✂️ Safe Crop зурах / зөөх
          </button>

          <button
            type="button"
            onClick={() => {
              setPreviewMode('edit');
              setTool('censor');
            }}
            style={{
              padding: '5px 10px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
              border: previewMode === 'edit' && tool === 'censor' ? '1px solid #f59e0b' : '1px solid #333',
              background: previewMode === 'edit' && tool === 'censor' ? 'rgba(245,158,11,0.22)' : '#23232b',
              color: previewMode === 'edit' && tool === 'censor' ? '#fcd34d' : '#d4d4d8'
            }}
          >
            🖍️ Censor хайрцаг нэмэх
          </button>

          {tool === 'censor' && (
            <select
              value={newMode}
              onChange={(e) => setNewMode(e.target.value as SafeCensorMode)}
              style={{
                background: '#23232b',
                color: '#f4f4f5',
                border: '1px solid #3f3f46',
                borderRadius: 6,
                padding: '4px 8px',
                fontSize: 11
              }}
            >
              <option value="blur">Blur (Зөөлөн бүдгэрүүлэх)</option>
              <option value="mosaic">Mosaic (Пиксел)</option>
              <option value="glow">Glow (Цагаан гэрэл)</option>
              <option value="bar">Bar (Хар хаалт)</option>
            </select>
          )}

          <button
            type="button"
            onClick={applyFaceAutoCrop}
            style={{
              padding: '5px 9px',
              borderRadius: 6,
              fontSize: 11,
              cursor: 'pointer',
              border: '1px solid #3b82f6',
              background: 'rgba(59,130,246,0.16)',
              color: '#93c5fd'
            }}
          >
            👤 Царай дээр Crop
          </button>
          <button
            type="button"
            onClick={() => setCropRect({ x: 0, y: 0, w: 1, h: 0.45 })}
            style={{
              padding: '5px 9px',
              borderRadius: 6,
              fontSize: 11,
              cursor: 'pointer',
              border: '1px solid #3f3f46',
              background: '#23232b',
              color: '#d4d4d8'
            }}
          >
            ⬆️ Дээд 45%
          </button>
          <button
            type="button"
            onClick={() => setCropRect(null)}
            style={{
              padding: '5px 9px',
              borderRadius: 6,
              fontSize: 11,
              cursor: 'pointer',
              border: '1px solid #3f3f46',
              background: '#23232b',
              color: '#d4d4d8'
            }}
          >
            ⬜ Crop арилгах
          </button>

          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#a1a1aa', marginLeft: 4 }}>
            <input type="checkbox" checked={showOverlayHints} onChange={(e) => setShowOverlayHints(e.target.checked)} />
            AI хайрцаг харуулах
          </label>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => setPreviewMode('edit')}
              style={{
                padding: '5px 10px',
                borderRadius: 6,
                fontSize: 11,
                cursor: 'pointer',
                border: previewMode === 'edit' ? '1px solid #818cf8' : '1px solid #333',
                background: previewMode === 'edit' ? 'rgba(99,102,241,0.2)' : '#23232b',
                color: '#e4e4e7'
              }}
            >
              Засах горим
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => refreshSanitizedPreview(true)}
              style={{
                padding: '5px 10px',
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                border: '1px solid #10b981',
                background: 'rgba(16,185,129,0.2)',
                color: '#6ee7b7'
              }}
            >
              {busy ? 'Шалгаж байна...' : '🔍 Гаралтыг урьдчилж харах + Шалгах'}
            </button>
          </div>
        </div>

        {/* Main Workspace */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Canvas */}
          <div
            style={{
              flex: 1,
              backgroundColor: '#0c0c10',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
              overflow: 'auto'
            }}
          >
            {previewMode === 'sanitized' && sanitizedUrl ? (
              <div style={{ textAlign: 'center' }}>
                <img
                  src={sanitizedUrl}
                  alt="Sanitized preview"
                  style={{ maxWidth: '100%', maxHeight: '66vh', borderRadius: 8, border: '2px solid #10b981' }}
                />
                {recheckInfo && (
                  <div style={{ marginTop: 8, fontSize: 12, color: recheckInfo.startsWith('✓') ? '#34d399' : '#fbbf24' }}>
                    {recheckInfo}
                  </div>
                )}
              </div>
            ) : (
              <div
                ref={imgBoxRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                style={{
                  position: 'relative',
                  aspectRatio: String(imgAspect),
                  height: '66vh',
                  maxWidth: '100%',
                  userSelect: 'none',
                  cursor: tool === 'crop' ? 'crosshair' : 'cell',
                  boxShadow: '0 8px 30px rgba(0,0,0,0.7)',
                  overflow: 'hidden'
                }}
              >
                <img
                  src={window.api.toMediaUrl(panel.path)}
                  alt={panel.name}
                  draggable={false}
                  style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
                />

                {/* AI Face & NSFW hints */}
                {showOverlayHints &&
                  (panel.faceBoxes || []).map((f, i) => (
                    <div
                      key={`f_${i}`}
                      style={{
                        position: 'absolute',
                        left: `${f.x * 100}%`,
                        top: `${f.y * 100}%`,
                        width: `${f.w * 100}%`,
                        height: `${f.h * 100}%`,
                        border: '1.5px dashed #60a5fa',
                        pointerEvents: 'none'
                      }}
                    />
                  ))}
                {showOverlayHints &&
                  (panel.nsfwBoxes || []).map((n, i) => (
                    <div
                      key={`n_${i}`}
                      style={{
                        position: 'absolute',
                        left: `${n.rect.x * 100}%`,
                        top: `${n.rect.y * 100}%`,
                        width: `${n.rect.w * 100}%`,
                        height: `${n.rect.h * 100}%`,
                        border: '1.5px dashed #ef4444',
                        backgroundColor: 'rgba(239,68,68,0.12)',
                        pointerEvents: 'none'
                      }}
                    >
                      <span
                        style={{
                          fontSize: 9,
                          background: '#ef4444',
                          color: '#fff',
                          padding: '1px 3px',
                          position: 'absolute',
                          top: 0,
                          left: 0
                        }}
                      >
                        {n.label}
                      </span>
                    </div>
                  ))}

                {/* Active Censor Boxes */}
                {censorBoxes.map((b) => (
                  <div
                    key={b.id}
                    style={{
                      position: 'absolute',
                      left: `${b.x * 100}%`,
                      top: `${b.y * 100}%`,
                      width: `${b.w * 100}%`,
                      height: `${b.h * 100}%`,
                      border: '2px solid #f59e0b',
                      backdropFilter: b.mode === 'bar' ? undefined : 'blur(10px)',
                      backgroundColor:
                        b.mode === 'bar'
                          ? 'rgba(0,0,0,0.92)'
                          : b.mode === 'glow'
                          ? 'rgba(255,255,255,0.75)'
                          : 'rgba(245,158,11,0.2)',
                      pointerEvents: 'none'
                    }}
                  />
                ))}

                {/* Active Crop Box */}
                {cropRect && (
                  <div
                    style={{
                      position: 'absolute',
                      left: `${cropRect.x * 100}%`,
                      top: `${cropRect.y * 100}%`,
                      width: `${cropRect.w * 100}%`,
                      height: `${cropRect.h * 100}%`,
                      border: '2.5px solid #10b981',
                      boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.58)',
                      pointerEvents: 'none'
                    }}
                  />
                )}

                {/* Draft Drag Box */}
                {draftBox && (
                  <div
                    style={{
                      position: 'absolute',
                      left: `${draftBox.x * 100}%`,
                      top: `${draftBox.y * 100}%`,
                      width: `${draftBox.w * 100}%`,
                      height: `${draftBox.h * 100}%`,
                      border: tool === 'crop' ? '2px dashed #34d399' : '2px dashed #fbbf24',
                      backgroundColor: 'rgba(255,255,255,0.12)',
                      pointerEvents: 'none'
                    }}
                  />
                )}
              </div>
            )}
          </div>

          {/* Right Sidebar: Censor Box List & Info */}
          <div
            style={{
              width: 270,
              borderLeft: '1px solid #27272f',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              backgroundColor: '#16161c',
              overflowY: 'auto'
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: '#f4f4f5' }}>Шүүлтийн мэдээлэл</div>
            <div style={{ fontSize: 11, color: '#a1a1aa', lineHeight: 1.5 }}>
              <div>Төлөв: <b style={{ color: '#e4e4e7' }}>{panel.safetyStatus}</b></div>
              <div>NSFW оноо: <b style={{ color: '#e4e4e7' }}>{Math.round((panel.nsfwScore || 0) * 100)}%</b></div>
              <div>Царай олдсон: <b style={{ color: '#e4e4e7' }}>{panel.faceBoxes?.length || 0}</b></div>
              {panel.safetyReason && <div style={{ marginTop: 4, color: '#cbd5e1' }}>{panel.safetyReason}</div>}
            </div>

            <hr style={{ borderColor: '#27272f', width: '100%' }} />

            <div style={{ fontSize: 12, fontWeight: 700, color: '#f4f4f5' }}>
              Censor хайрцгууд ({censorBoxes.length})
            </div>
            {censorBoxes.length === 0 && (
              <div style={{ fontSize: 11, color: '#71717a' }}>
                Хэрэв тайрах боломжгүй эмзэг хэсэг байвал &quot;Censor хайрцаг нэмэх&quot; товчийг дараад зураг дээр чирнэ үү.
              </div>
            )}
            {censorBoxes.map((b, idx) => (
              <div
                key={b.id}
                style={{
                  backgroundColor: '#202028',
                  border: '1px solid #30303b',
                  borderRadius: 6,
                  padding: 8,
                  fontSize: 11,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#fcd34d', fontWeight: 600 }}>Хайрцаг #{idx + 1}</span>
                  <button
                    type="button"
                    onClick={() => setCensorBoxes((prev) => prev.filter((x) => x.id !== b.id))}
                    style={{
                      background: 'rgba(239,68,68,0.2)',
                      color: '#fca5a5',
                      border: 'none',
                      borderRadius: 4,
                      padding: '2px 6px',
                      fontSize: 10,
                      cursor: 'pointer'
                    }}
                  >
                    Устгах
                  </button>
                </div>
                <select
                  value={b.mode}
                  onChange={(e) =>
                    setCensorBoxes((prev) =>
                      prev.map((x) => (x.id === b.id ? { ...x, mode: e.target.value as SafeCensorMode } : x))
                    )
                  }
                  style={{
                    background: '#141418',
                    color: '#e4e4e7',
                    border: '1px solid #3f3f46',
                    borderRadius: 4,
                    padding: '3px 6px',
                    fontSize: 11
                  }}
                >
                  <option value="blur">Blur (Бүдгэрүүлэх)</option>
                  <option value="mosaic">Mosaic (Пиксел)</option>
                  <option value="glow">Glow (Гэрэл хаалт)</option>
                  <option value="bar">Bar (Хар хаалт)</option>
                </select>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '10px 16px',
            borderTop: '1px solid #27272f',
            backgroundColor: '#191920',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => handleSave('excluded')}
            style={{
              padding: '7px 12px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              border: '1px solid rgba(239,68,68,0.5)',
              background: 'rgba(239,68,68,0.16)',
              color: '#fca5a5'
            }}
          >
            🚫 Энэ кадрыг бүхэлд нь хасах (Excluded)
          </button>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '7px 14px',
                borderRadius: 6,
                fontSize: 12,
                cursor: 'pointer',
                border: '1px solid #3f3f46',
                background: '#27272f',
                color: '#d4d4d8'
              }}
            >
              Болих
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleSave()}
              style={{
                padding: '7px 16px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                border: 'none',
                background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                color: '#fff'
              }}
            >
              {busy ? 'Хадгалж байна...' : '✓ Хадгалж, Шалгаад буцах'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
