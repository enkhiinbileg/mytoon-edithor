import React, { useState, useEffect } from 'react';
import { useEditor } from '../store';
import { clipEnd, type Clip } from '../types';
import { runAutoSyncSrt } from '../syncSrt';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccessNotice?: (msg: string) => void;
}

export default function SrtSyncModal({ isOpen, onClose, onSuccessNotice }: Props) {
  const curState = useEditor();
  const [srtPath, setSrtPath] = useState<string>('');
  const [srtName, setSrtName] = useState<string>('');
  const [srtEntriesCount, setSrtEntriesCount] = useState<number>(0);

  const [scriptMode, setScriptMode] = useState<'text' | 'file' | 'audio_auto'>('file');
  const [scriptText, setScriptText] = useState<string>('');
  const [scriptTxtPath, setScriptTxtPath] = useState<string>('');
  const [scriptTxtName, setScriptTxtName] = useState<string>('');

  const [videoOffset, setVideoOffset] = useState<number>(0);
  const [includeAllAudio, setIncludeAllAudio] = useState<boolean>(true);

  const [busy, setBusy] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');

  const aTrack = curState.tracks.find((t) => t.kind === 'audio');
  const aClips = aTrack
    ? curState.clips.filter((c) => c.trackId === aTrack.id && c.kind === 'av').sort((a, b) => a.start - b.start)
    : [];

  const totalAudioDur = aClips.reduce((acc, c) => acc + (c.outPoint - c.inPoint), 0);

  useEffect(() => {
    if (!isOpen) return;
    setErrorMsg('');
    setStatusMsg('');
  }, [isOpen]);

  if (!isOpen) return null;

  const handlePickSrt = async () => {
    try {
      const res = await window.api.openSrtFile();
      if (res && res.path) {
        setSrtPath(res.path);
        setSrtName(res.name || res.path.split(/[\\/]/).pop() || '');
        setSrtEntriesCount(res.entriesCount || 0);
        setErrorMsg('');
      }
    } catch (err: any) {
      setErrorMsg(`SRT файл нээхэд алдаа: ${err?.message || err}`);
    }
  };

  const handlePickTxt = async () => {
    try {
      const res = await window.api.openTxtFile();
      if (res && res.path) {
        setScriptTxtPath(res.path);
        setScriptTxtName(res.name || res.path.split(/[\\/]/).pop() || '');
        if (res.text) {
          setScriptText(res.text);
        }
        setErrorMsg('');
      }
    } catch (err: any) {
      setErrorMsg(`Скрипт файл нээхэд алдаа: ${err?.message || err}`);
    }
  };

  const handleExecuteSync = async () => {
    if (!srtPath) {
      setErrorMsg('Англи SRT хадмал файлаа сонгоно уу.');
      return;
    }

    if (!aClips.length) {
      setErrorMsg('Audio 1 зам дээр ямар ч voice аудио алга байна.');
      return;
    }

    setBusy(true);
    setErrorMsg('');
    setStatusMsg('🚀 Тохиргоог шалгаж, эвлүүлэлтийг эхлүүлж байна...');

    try {
      const success = await runAutoSyncSrt(
        (msg) => {
          setStatusMsg(msg);
        },
        {
          srtPath,
          scriptText: scriptText.trim(),
          scriptPath: scriptTxtPath,
          videoOffset,
          includeAllAudio,
          pacingMode: 'motion' // Option 1B: dynamic video motion, no freeze frames
        }
      );

      if (success) {
        onSuccessNotice?.('✨ Амжилттай: Видеоны үзэгдлүүд монгол voice-той 100% яв цав таарлаа!');
        setTimeout(() => {
          onClose();
        }, 1200);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Эвлүүлэх үед тодорхойгүй алдаа гарлаа.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(4px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <div
        style={{
          width: 580,
          maxWidth: '92vw',
          maxHeight: '90vh',
          backgroundColor: '#18181b',
          border: '1px solid #27272a',
          borderRadius: 12,
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)',
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
            background: 'linear-gradient(180deg, #222226 0%, #18181b 100%)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>📜</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>
                SRT & Voice 100% Яв Цав Тааруулагч
              </div>
              <div style={{ fontSize: 11, color: '#a1a1aa' }}>
                Англи хадмал болон Монгол скриптийг өгүүлбэр бүрээр нь AI-аар харьцуулж эвлүүлэх
              </div>
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
              padding: 4
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Step 1: English SRT File */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#38bdf8' }}>
              1. Англи SRT хадмал файл:
            </label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                type="button"
                className="btn"
                onClick={handlePickSrt}
                disabled={busy}
                style={{
                  padding: '7px 14px',
                  fontSize: 12,
                  fontWeight: 500,
                  backgroundColor: '#27272a',
                  color: '#fff',
                  border: '1px solid #3f3f46',
                  borderRadius: 6,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6
                }}
              >
                <span>📂</span>
                <span>{srtPath ? 'Өөр SRT сонгох' : 'Англи .srt файл сонгох'}</span>
              </button>
              <div
                style={{
                  fontSize: 11,
                  color: srtPath ? '#4ade80' : '#71717a',
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {srtName ? `✓ ${srtName} (${srtEntriesCount} мөр)` : 'Файл сонгогдоогүй байна'}
              </div>
            </div>
          </div>

          {/* Step 2: Mongolian Script */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#38bdf8' }}>
                2. Монгол Скрипт (ElevenLabs ярианы эх бичвэр):
              </label>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  onClick={() => setScriptMode('file')}
                  style={{
                    padding: '2px 8px',
                    fontSize: 10,
                    borderRadius: 4,
                    border: 'none',
                    background: scriptMode === 'file' ? '#2563eb' : '#27272a',
                    color: '#fff',
                    cursor: 'pointer'
                  }}
                >
                  Файлаас (.txt)
                </button>
                <button
                  type="button"
                  onClick={() => setScriptMode('text')}
                  style={{
                    padding: '2px 8px',
                    fontSize: 10,
                    borderRadius: 4,
                    border: 'none',
                    background: scriptMode === 'text' ? '#2563eb' : '#27272a',
                    color: '#fff',
                    cursor: 'pointer'
                  }}
                >
                  Текст хуулах (Paste)
                </button>
                <button
                  type="button"
                  onClick={() => setScriptMode('audio_auto')}
                  style={{
                    padding: '2px 8px',
                    fontSize: 10,
                    borderRadius: 4,
                    border: 'none',
                    background: scriptMode === 'audio_auto' ? '#2563eb' : '#27272a',
                    color: '#fff',
                    cursor: 'pointer'
                  }}
                >
                  Voice-оос сонсох (AI)
                </button>
              </div>
            </div>

            {scriptMode === 'file' && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={handlePickTxt}
                  disabled={busy}
                  style={{
                    padding: '7px 14px',
                    fontSize: 12,
                    fontWeight: 500,
                    backgroundColor: '#27272a',
                    color: '#fff',
                    border: '1px solid #3f3f46',
                    borderRadius: 6,
                    cursor: busy ? 'not-allowed' : 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6
                  }}
                >
                  <span>📄</span>
                  <span>{scriptTxtPath ? 'Өөр файл сонгох' : 'Монгол скрипт (.txt) сонгох'}</span>
                </button>
                <div
                  style={{
                    fontSize: 11,
                    color: scriptTxtName ? '#4ade80' : '#71717a',
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {scriptTxtName ? `✓ ${scriptTxtName}` : 'Сонгоогүй бол voice-оос автоматаар уншина'}
                </div>
              </div>
            )}

            {scriptMode === 'text' && (
              <textarea
                value={scriptText}
                onChange={(e) => setScriptText(e.target.value)}
                placeholder="ElevenLabs дээр уншуулсан Монгол скриптээ энд хуулж тавина уу..."
                disabled={busy}
                rows={4}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: 8,
                  fontSize: 11,
                  backgroundColor: '#111',
                  border: '1px solid #333',
                  borderRadius: 6,
                  color: '#fff',
                  resize: 'vertical'
                }}
              />
            )}

            {scriptMode === 'audio_auto' && (
              <div
                style={{
                  padding: 10,
                  fontSize: 11,
                  backgroundColor: 'rgba(37, 99, 235, 0.1)',
                  border: '1px solid rgba(37, 99, 235, 0.3)',
                  borderRadius: 6,
                  color: '#93c5fd'
                }}
              >
                🎙️ Gemini Multimodal Audio нь Timeline дээрх монгол яриаг чихээрээ сонсож, ярьж буй өгүүлбэрүүдийг үг үсэггүй буулган Англи хадмалтай харьцуулна.
              </div>
            )}
          </div>

          {/* Step 3: Pacing & Scope */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 500, color: '#d4d4d8' }}>
                Киноны интро зөрүү (Offset секунд):
              </label>
              <input
                type="number"
                step="0.5"
                value={videoOffset}
                onChange={(e) => setVideoOffset(parseFloat(e.target.value) || 0)}
                disabled={busy}
                style={{
                  padding: '6px 10px',
                  fontSize: 12,
                  backgroundColor: '#111',
                  border: '1px solid #333',
                  borderRadius: 6,
                  color: '#fff'
                }}
              />
              <span style={{ fontSize: 10, color: '#71717a' }}>
                Хэрэв видеоны эхэнд лого, интро байгаа бол оруулна
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 500, color: '#d4d4d8' }}>
                Аудио хамрах хүрээ:
              </label>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11,
                  color: '#e4e4e7',
                  cursor: 'pointer',
                  paddingTop: 6
                }}
              >
                <input
                  type="checkbox"
                  checked={includeAllAudio}
                  onChange={(e) => setIncludeAllAudio(e.target.checked)}
                  disabled={busy}
                />
                <span>Audio 1-ийн бүх {aClips.length} аудио (Нийт {Math.round(totalAudioDur / 60)} мин)</span>
              </label>
            </div>
          </div>

          {/* Error display */}
          {errorMsg && (
            <div
              style={{
                padding: '8px 12px',
                fontSize: 11,
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: 6,
                color: '#f87171'
              }}
            >
              ⚠️ {errorMsg}
            </div>
          )}

          {/* Status display */}
          {statusMsg && (
            <div
              style={{
                padding: '8px 12px',
                fontSize: 11,
                backgroundColor: 'rgba(16, 185, 129, 0.15)',
                border: '1px solid rgba(16, 185, 129, 0.4)',
                borderRadius: 6,
                color: '#34d399',
                display: 'flex',
                alignItems: 'center',
                gap: 8
              }}
            >
              {busy && <span className="spinner" style={{ display: 'inline-block', width: 12, height: 12 }} />}
              <span>{statusMsg}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid #27272a',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            background: '#141416'
          }}
        >
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              backgroundColor: 'transparent',
              color: '#a1a1aa',
              border: '1px solid #3f3f46',
              borderRadius: 6,
              cursor: busy ? 'not-allowed' : 'pointer'
            }}
          >
            Хаах
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleExecuteSync}
            disabled={busy || !srtPath}
            style={{
              padding: '6px 18px',
              fontSize: 12,
              fontWeight: 600,
              backgroundColor: busy || !srtPath ? '#3f3f46' : '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: busy || !srtPath ? 'not-allowed' : 'pointer',
              boxShadow: busy || !srtPath ? 'none' : '0 2px 10px rgba(37, 99, 235, 0.35)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <span>{busy ? '⏳ Эвлүүлж байна...' : '🚀 100% Яв Цав Эвлүүлэх'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
