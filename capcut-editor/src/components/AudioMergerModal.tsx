import React, { useState } from 'react';
import { Icon } from '../Icons';
import { useEditor } from '../store';
import { importPaths } from '../importMedia';

interface AudioItem {
  id: string;
  path: string;
  name: string;
  duration: number;
  size: number;
}

interface AudioMergerModalProps {
  onClose: () => void;
  initialFiles?: string[];
}

function formatHumanDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} цаг ${m} мин ${sec} сек`;
  if (m > 0) return `${m} мин ${sec} сек`;
  return `${sec} сек`;
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AudioMergerModal({ onClose, initialFiles = [] }: AudioMergerModalProps) {
  const [items, setItems] = useState<Array<AudioItem | null>>([null, null]);
  const [customOutputPath, setCustomOutputPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [mergedResult, setMergedResult] = useState<{
    outputPath: string;
    name: string;
    duration: number;
    size?: number;
  } | null>(null);

  // Initialize with initialFiles if provided
  React.useEffect(() => {
    if (initialFiles.length > 0) {
      (async () => {
        const loaded: Array<AudioItem | null> = [];
        for (const fp of initialFiles) {
          try {
            const probe = await window.api.probe(fp);
            loaded.push({
              id: Math.random().toString(36).slice(2, 9),
              path: fp,
              name: fp.split(/[/\\]/).pop() || fp,
              duration: probe.duration || 0,
              size: 0
            });
          } catch {}
        }
        while (loaded.length < 2) loaded.push(null);
        setItems(loaded);
      })();
    }
  }, [initialFiles]);

  const handlePickForSlot = async (index: number) => {
    try {
      const res = await window.api.openAudioFileDialog();
      if (!res || !res.ok || !res.path) return;
      setItems(prev => {
        const next = [...prev];
        next[index] = {
          id: Math.random().toString(36).slice(2, 9),
          path: res.path,
          name: res.name || res.path.split(/[/\\]/).pop() || 'audio.mp3',
          duration: res.duration || 0,
          size: res.size || 0
        };
        return next;
      });
      setErrorMsg(null);
    } catch (e: any) {
      setErrorMsg(e.message || 'Файл сонгоход алдаа гарлаа');
    }
  };

  const handlePickMultiple = async () => {
    try {
      const files = await window.api.openMultipleAudioFiles();
      if (!files || !files.length) return;
      const valid = files.filter(f => f.ok && f.path).map(f => ({
        id: Math.random().toString(36).slice(2, 9),
        path: f.path,
        name: f.name,
        duration: f.duration || 0,
        size: f.size || 0
      }));
      if (!valid.length) return;

      setItems(prev => {
        const existing = prev.filter((x): x is AudioItem => x !== null);
        const merged = [...existing, ...valid];
        while (merged.length < 2) merged.push(null as any);
        return merged;
      });
      setErrorMsg(null);
    } catch (e: any) {
      setErrorMsg(e.message || 'Файлууд сонгоход алдаа гарлаа');
    }
  };

  const handleAddSlot = () => {
    setItems(prev => [...prev, null]);
  };

  const handleRemoveSlot = (index: number) => {
    setItems(prev => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length < 2) next.push(null);
      return next;
    });
  };

  const handleMove = (index: number, direction: 'up' | 'down') => {
    setItems(prev => {
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const next = [...prev];
      const temp = next[index];
      next[index] = next[targetIndex];
      next[targetIndex] = temp;
      return next;
    });
  };

  const handleChooseSavePath = async () => {
    try {
      const defaultName = `merged_voice_${Date.now()}.mp3`;
      const chosen = await window.api.saveAudioFileDialog(defaultName);
      if (chosen) setCustomOutputPath(chosen);
    } catch {}
  };

  const validItems = items.filter((x): x is AudioItem => x !== null);
  const totalDuration = validItems.reduce((acc, x) => acc + (x.duration || 0), 0);
  const canMerge = validItems.length >= 2 && !busy;

  const handleMerge = async () => {
    if (!canMerge) return;
    setBusy(true);
    setProgressMsg('Аудио файлуудыг шалгаж, чанарын алдагдалгүй нэгтгэж байна...');
    setErrorMsg(null);
    setMergedResult(null);

    try {
      const filePaths = validItems.map(x => x.path);
      const res = await window.api.mergeAudioFiles({
        filePaths,
        outputPath: customOutputPath || undefined
      });

      if (!res.ok || !res.outputPath) {
        throw new Error(res.error || 'Аудио нэгтгэхэд алдаа гарлаа.');
      }

      setMergedResult({
        outputPath: res.outputPath,
        name: res.name || 'merged_voice.mp3',
        duration: res.duration || totalDuration,
        size: res.size
      });
    } catch (e: any) {
      setErrorMsg(e.message || 'Аудио нэгтгэхэд алдаа гарлаа.');
    } finally {
      setBusy(false);
      setProgressMsg('');
    }
  };

  const handleAddToProject = async () => {
    if (!mergedResult) return;
    try {
      await importPaths([mergedResult.outputPath]);
      alert('Нэгтгэсэн аудио төслийн медиа санд амжилттай нэмэгдлээ!');
    } catch (e: any) {
      alert('Медиа санд нэмэхэд алдаа: ' + e.message);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 680,
          maxHeight: '90vh',
          background: '#18181b',
          border: '1px solid #27272a',
          borderRadius: 14,
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.6)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          color: '#f4f4f5'
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #27272a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#1f1f23'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22 }}>🎵</span>
            <div>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#fafafa' }}>
                Хоёр буюу түүнээс олон аудио нэгтгэх
              </h2>
              <p style={{ margin: 0, fontSize: 12, color: '#a1a1aa' }}>
                Тасарсан voice болон дуу хоолойнуудыг дарааллаар нь нэг файл болгон нэгтгэнэ
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#a1a1aa',
              fontSize: 18,
              cursor: busy ? 'not-allowed' : 'pointer',
              padding: 6,
              borderRadius: 6
            }}
          >
            ✕
          </button>
        </div>

        {/* Scrollable Body */}
        <div
          style={{
            padding: '18px 20px',
            overflowY: 'auto',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 16
          }}
        >
          {/* Top Selection Helper Buttons */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              className="btn"
              type="button"
              onClick={handlePickMultiple}
              disabled={busy}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(99, 102, 241, 0.15)',
                color: '#818cf8',
                border: '1px solid rgba(99, 102, 241, 0.3)'
              }}
            >
              <span>📂</span>
              <span>Олноор зэрэг сонгох (Ctrl/Shift-ээр олон mp3 зэрэг сонгох)</span>
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={handleAddSlot}
              disabled={busy}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span>➕</span>
              <span>Нэмэлт аудио мөр нэмэх</span>
            </button>
          </div>

          {/* Slots List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {items.map((item, index) => {
              const isFirst = index === 0;
              const isSecond = index === 1;
              const slotLabel = isFirst
                ? 'Аудио 1 (Эхний хэсэг)'
                : isSecond
                ? 'Аудио 2 (Хоёр дахь хэсэг)'
                : `Аудио ${index + 1}`;

              return (
                <div
                  key={item?.id || `empty-slot-${index}`}
                  style={{
                    background: item ? '#232328' : '#1c1c20',
                    border: `1px solid ${item ? '#3f3f46' : '#2e2e33'}`,
                    borderRadius: 10,
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    transition: 'border-color 0.15s ease'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          background: item ? '#6366f1' : '#3f3f46',
                          color: '#fff',
                          fontSize: 11,
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: 12
                        }}
                      >
                        #{index + 1}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: item ? '#e4e4e7' : '#a1a1aa' }}>
                        {slotLabel}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {items.length > 2 && (
                        <>
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={busy || index === 0}
                            onClick={() => handleMove(index, 'up')}
                            style={{ padding: '2px 6px', fontSize: 11 }}
                            title="Дээш шилжүүлэх"
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={busy || index === items.length - 1}
                            onClick={() => handleMove(index, 'down')}
                            style={{ padding: '2px 6px', fontSize: 11 }}
                            title="Доош шилжүүлэх"
                          >
                            ▼
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={busy}
                            onClick={() => handleRemoveSlot(index)}
                            style={{ padding: '2px 6px', fontSize: 11, color: '#f87171' }}
                            title="Энэ мөрийг хасах"
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {item ? (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        background: '#18181b',
                        padding: '8px 12px',
                        borderRadius: 8
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                        <span style={{ fontSize: 20 }}>🎙️</span>
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: '#fff',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis'
                            }}
                            title={item.name}
                          >
                            {item.name}
                          </div>
                          <div style={{ fontSize: 11, color: '#a1a1aa', display: 'flex', gap: 10 }}>
                            <span>⏱️ {formatHumanDuration(item.duration)}</span>
                            {item.size > 0 && <span>💾 {formatFileSize(item.size)}</span>}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => handlePickForSlot(index)}
                          style={{ fontSize: 11, padding: '4px 8px' }}
                        >
                          Солих...
                        </button>
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={busy}
                          onClick={() => {
                            setItems(prev => {
                              const next = [...prev];
                              next[index] = null;
                              return next;
                            });
                          }}
                          style={{ fontSize: 11, padding: '4px 8px', color: '#f87171' }}
                        >
                          Арилгах
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: '1.5px dashed #3f3f46',
                        borderRadius: 8,
                        padding: '16px',
                        cursor: busy ? 'not-allowed' : 'pointer',
                        background: 'rgba(255, 255, 255, 0.02)'
                      }}
                      onClick={() => !busy && handlePickForSlot(index)}
                    >
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePickForSlot(index);
                        }}
                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <span>📂</span>
                        <span>{slotLabel} сонгох...</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Destination & Summary Section */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: 8,
              background: '#202025',
              border: '1px solid #2f2f35',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              fontSize: 12
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#a1a1aa' }}>Сонгогдсон аудионууд:</span>
              <span style={{ fontWeight: 600, color: '#e4e4e7' }}>
                {validItems.length} файл (Эхний {validItems.length} хэсэг)
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#a1a1aa' }}>Нийт тооцоолсон хугацаа:</span>
              <span style={{ fontWeight: 700, color: '#38bdf8' }}>
                ⏱️ {formatHumanDuration(totalDuration)}
              </span>
            </div>

            <div style={{ borderTop: '1px solid #2e2e33', paddingTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#a1a1aa', flexShrink: 0 }}>Хадгалах хавтас:</span>
                <span
                  style={{
                    color: '#e4e4e7',
                    overflowWrap: 'anywhere',
                    textAlign: 'right',
                    fontSize: 11
                  }}
                >
                  {customOutputPath || 'Downloads (Автоматаар Downloads хавтсанд хадгалагдана)'}
                </span>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={handleChooseSavePath}
                  style={{ fontSize: 11, padding: '3px 8px', flexShrink: 0 }}
                >
                  Өөрчлөх...
                </button>
              </div>
            </div>
          </div>

          {/* Status / Errors */}
          {busy && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(99, 102, 241, 0.15)',
                border: '1px solid rgba(99, 102, 241, 0.3)',
                color: '#a5b4fc',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 13
              }}
            >
              <span className="spinner" style={{ width: 16, height: 16, border: '2px solid #818cf8', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} />
              <span>{progressMsg || 'Аудио нэгтгэж байна...'}</span>
            </div>
          )}

          {errorMsg && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#fca5a5',
                fontSize: 13
              }}
            >
              ⚠️ {errorMsg}
            </div>
          )}

          {/* Success Merged Result */}
          {mergedResult && (
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 10,
                background: 'rgba(16, 185, 129, 0.12)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#34d399', fontWeight: 700, fontSize: 14 }}>
                <span>✅</span>
                <span>Аудио амжилттай нэгтгэгдлээ!</span>
              </div>
              <div style={{ fontSize: 12, color: '#d1fae5', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div><strong>Нэр:</strong> {mergedResult.name}</div>
                <div><strong>Нийт хугацаа:</strong> {formatHumanDuration(mergedResult.duration)}</div>
                {mergedResult.size ? <div><strong>Хэмжээ:</strong> {formatFileSize(mergedResult.size)}</div> : null}
                <div style={{ overflowWrap: 'anywhere' }}><strong>Байршил:</strong> {mergedResult.outputPath}</div>
              </div>

              {/* Audio Player Preview */}
              <audio
                controls
                src={window.api?.toMediaUrl ? window.api.toMediaUrl(mergedResult.outputPath) : mergedResult.outputPath}
                style={{ width: '100%', marginTop: 4, height: 36 }}
              />

              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => window.api.showItemInFolder(mergedResult.outputPath)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span>📂</span>
                  <span>Хавтаст харуулах</span>
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={handleAddToProject}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span>➕</span>
                  <span>Төслийн Медиа санд нэмэх</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 20px',
            borderTop: '1px solid #27272a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#1f1f23'
          }}
        >
          <div style={{ fontSize: 12, color: '#a1a1aa' }}>
            {validItems.length < 2
              ? 'Нэгтгэхийн тулд хамгийн багадаа 2 аудио сонгоно уу'
              : `Бэлэн: ${validItems.length} файл нэгтгэгдэнэ`}
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
              Хаах
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!canMerge}
              onClick={handleMerge}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 16px',
                fontWeight: 600,
                background: canMerge ? '#4f46e5' : undefined
              }}
            >
              <span>🔗</span>
              <span>{busy ? 'Нэгтгэж байна...' : 'Хоёр аудиог нэгтгэх'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
