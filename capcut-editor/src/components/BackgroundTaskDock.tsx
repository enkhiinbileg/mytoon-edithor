import type { ReactNode } from 'react';
import type { AutoPipelineBgState, SafeRecapBgState } from '../types';

const STEP_SHORT: Record<string, string> = {
  voice: '1/5 Voice',
  whisper: '2/5 Whisper',
  fix: '3/5 Засвар',
  autocut: '4/5 Auto-Cut',
  export: '5/5 Export'
};

interface Props {
  autoPipelineVisible: boolean;
  autoPipelineBg: AutoPipelineBgState | null;
  onRestoreAutoPipeline: () => void;
  onDismissAutoPipeline: () => void;
  safeRecapVisible: boolean;
  safeRecapOpen: boolean;
  safeRecapBg: SafeRecapBgState | null;
  onRestoreSafeRecap: () => void;
  onOpenSafeRecap: () => void;
  onDismissSafeRecap: () => void;
  children?: ReactNode;
}

export default function BackgroundTaskDock({
  autoPipelineVisible,
  autoPipelineBg,
  onRestoreAutoPipeline,
  onDismissAutoPipeline,
  safeRecapVisible,
  safeRecapOpen,
  safeRecapBg,
  onRestoreSafeRecap,
  onOpenSafeRecap,
  onDismissSafeRecap,
  children
}: Props) {
  const autoRunning = Boolean(autoPipelineBg?.running || autoPipelineBg?.batchRunning);
  const autoStatus = autoPipelineBg?.status || 'idle';
  const safeBusy = Boolean(safeRecapBg?.busy);

  const hasContent = autoPipelineVisible || safeRecapVisible || Boolean(children);
  if (!hasContent) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 18,
        bottom: 18,
        zIndex: 9500,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 10,
        pointerEvents: 'none',
        maxWidth: 'min(380px, calc(100vw - 36px))'
      }}
    >
      {autoPipelineVisible && (
        <div
          style={{
            pointerEvents: 'auto',
            width: 340,
            maxWidth: '100%',
            background: '#111625',
            border:
              autoStatus === 'running'
                ? '1px solid rgba(56, 189, 248, 0.55)'
                : autoStatus === 'completed'
                ? '1px solid rgba(16, 185, 129, 0.55)'
                : autoStatus === 'failed'
                ? '1px solid rgba(239, 68, 68, 0.55)'
                : '1px solid rgba(255, 255, 255, 0.16)',
            borderRadius: 12,
            padding: '10px 12px',
            boxShadow: '0 14px 36px rgba(0, 0, 0, 0.65)',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
            color: '#e2e8f0'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 15 }}>🚀</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap' }}>
                1-Click Авто Видео
              </span>
              {autoPipelineBg?.outputName && (
                <span
                  style={{
                    fontSize: 11,
                    color: '#94a3b8',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                  title={autoPipelineBg.outputName}
                >
                  · {autoPipelineBg.outputName}
                </span>
              )}
            </div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                padding: '2px 7px',
                borderRadius: 999,
                flexShrink: 0,
                background:
                  autoStatus === 'completed'
                    ? 'rgba(16,185,129,0.2)'
                    : autoStatus === 'failed'
                    ? 'rgba(239,68,68,0.2)'
                    : autoStatus === 'canceled'
                    ? 'rgba(245,158,11,0.2)'
                    : 'rgba(56,189,248,0.18)',
                color:
                  autoStatus === 'completed'
                    ? '#34d399'
                    : autoStatus === 'failed'
                    ? '#fca5a5'
                    : autoStatus === 'canceled'
                    ? '#fcd34d'
                    : '#7dd3fc'
              }}
            >
              {autoStatus === 'running'
                ? `${autoPipelineBg?.overallPct ?? 0}%`
                : autoStatus === 'completed'
                ? '✓ Бэлэн'
                : autoStatus === 'failed'
                ? '✕ Алдаа'
                : autoStatus === 'canceled'
                ? 'Зогссон'
                : 'Хураасан'}
            </span>
          </div>

          {(autoStatus === 'running' || autoStatus === 'completed') && (
            <div style={{ height: 5, borderRadius: 999, background: '#0b0f1a', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${autoStatus === 'completed' ? 100 : Math.max(3, autoPipelineBg?.overallPct ?? 0)}%`,
                  background: autoStatus === 'completed' ? '#10b981' : 'linear-gradient(90deg, #10b981, #38bdf8)',
                  transition: 'width 0.25s ease'
                }}
              />
            </div>
          )}

          <div
            style={{
              fontSize: 11,
              color: autoStatus === 'failed' ? '#fecaca' : '#94a3b8',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
            title={autoPipelineBg?.message || autoPipelineBg?.error || ''}
          >
            {autoStatus === 'running' && autoPipelineBg?.batchRunning && autoPipelineBg?.batchTotal
              ? `Багц ${(autoPipelineBg.batchCompleted || 0) + 1}/${autoPipelineBg.batchTotal} · `
              : autoStatus === 'running' && autoPipelineBg?.stepKey
              ? `${STEP_SHORT[autoPipelineBg.stepKey] || ''} · `
              : ''}
            {autoPipelineBg?.message ||
              (autoStatus === 'idle' ? 'Оруулсан мэдээлэл хадгалагдсан — дэлгэж үргэлжлүүлнэ үү' : '')}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={onRestoreAutoPipeline}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: 'none',
                background: 'linear-gradient(135deg, #10b981 0%, #3b82f6 100%)',
                color: '#fff',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              Дэлгэх
            </button>
            {!safeRecapOpen && (
              <button
                type="button"
                onClick={onOpenSafeRecap}
                style={{
                  padding: '4px 9px',
                  borderRadius: 6,
                  border: '1px solid rgba(16,185,129,0.45)',
                  background: 'rgba(16,185,129,0.16)',
                  color: '#6ee7b7',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer'
                }}
                title="Safe +18 Webtoon Recap Studio нээх"
              >
                🛡️ +18 Нээх
              </button>
            )}
            {autoStatus === 'completed' && autoPipelineBg?.outPath && (
              <button
                type="button"
                onClick={() => window.api.showItemInFolder?.(autoPipelineBg.outPath!)}
                style={{
                  padding: '4px 9px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.18)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#e2e8f0',
                  fontSize: 11,
                  cursor: 'pointer'
                }}
              >
                📁 Хавтас
              </button>
            )}
            {!autoRunning && (
              <button
                type="button"
                onClick={onDismissAutoPipeline}
                style={{
                  marginLeft: 'auto',
                  padding: '3px 7px',
                  borderRadius: 6,
                  border: 'none',
                  background: 'rgba(255,255,255,0.08)',
                  color: '#cbd5e1',
                  fontSize: 11,
                  cursor: 'pointer'
                }}
                title="Хаах"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}

      {safeRecapVisible && (
        <div
          style={{
            pointerEvents: 'auto',
            width: 340,
            maxWidth: '100%',
            background: '#14141c',
            border: safeBusy
              ? '1px solid rgba(245, 158, 11, 0.55)'
              : safeRecapBg?.errorMsg
              ? '1px solid rgba(239, 68, 68, 0.55)'
              : '1px solid rgba(16, 185, 129, 0.45)',
            borderRadius: 12,
            padding: '10px 12px',
            boxShadow: '0 14px 36px rgba(0, 0, 0, 0.65)',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
            color: '#e4e4e7'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 15 }}>🛡️</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap' }}>
                Safe +18 Recap
              </span>
              {safeRecapBg?.sessionName && (
                <span
                  style={{
                    fontSize: 11,
                    color: '#a1a1aa',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  · {safeRecapBg.sessionName}
                </span>
              )}
            </div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                padding: '2px 7px',
                borderRadius: 999,
                flexShrink: 0,
                background: safeBusy
                  ? 'rgba(245,158,11,0.2)'
                  : safeRecapBg?.errorMsg
                  ? 'rgba(239,68,68,0.2)'
                  : 'rgba(16,185,129,0.18)',
                color: safeBusy ? '#fcd34d' : safeRecapBg?.errorMsg ? '#fca5a5' : '#34d399'
              }}
            >
              {safeBusy
                ? safeRecapBg?.progressPct != null
                  ? `${safeRecapBg.progressPct}%`
                  : 'Ажиллаж...'
                : safeRecapBg?.errorMsg
                ? 'Алдаа'
                : 'Бэлэн'}
            </span>
          </div>

          {safeBusy && safeRecapBg?.progressPct != null && (
            <div style={{ height: 4, borderRadius: 999, background: '#272730', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${Math.max(4, safeRecapBg.progressPct)}%`,
                  background: '#10b981',
                  transition: 'width 0.2s ease'
                }}
              />
            </div>
          )}

          <div
            style={{
              fontSize: 11,
              color: safeRecapBg?.errorMsg ? '#fca5a5' : '#a1a1aa',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
            title={safeRecapBg?.errorMsg || safeRecapBg?.statusMsg || ''}
          >
            {safeRecapBg?.errorMsg ||
              safeRecapBg?.statusMsg ||
              `${safeRecapBg?.panelCount ?? 0} кадр · ${safeRecapBg?.planCount ?? 0} мөр`}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={onRestoreSafeRecap}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: 'none',
                background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                color: '#fff',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              Дэлгэх
            </button>
            {!safeBusy && (
              <button
                type="button"
                onClick={onDismissSafeRecap}
                style={{
                  marginLeft: 'auto',
                  padding: '3px 7px',
                  borderRadius: 6,
                  border: 'none',
                  background: 'rgba(255,255,255,0.08)',
                  color: '#cbd5e1',
                  fontSize: 11,
                  cursor: 'pointer'
                }}
                title="Хаах"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}

      {children}
    </div>
  );
}
