import { useEditor } from '../store';
import { EFFECTS, FILTERS, TRANSITIONS } from '../looks';

type Mode = 'filters' | 'effects' | 'transitions';

const TITLES: Record<Mode, string> = {
  filters: 'Filters',
  effects: 'Effects',
  transitions: 'Transitions'
};

/** Grid of looks that apply to the selected clip. */
export default function LookPanel({ mode }: { mode: Mode }) {
  const clip = useEditor((s) => s.clips.find((c) => c.id === s.selectedClipId));
  const media = useEditor((s) => (clip?.mediaId ? s.media.find((m) => m.id === clip.mediaId) : undefined));
  const firstThumb = useEditor((s) => s.media.find((m) => m.thumbs.length > 0)?.thumbs[0]);
  const updateClip = useEditor((s) => s.updateClip);

  const swatch = media?.thumbs[Math.floor(media.thumbs.length / 2)] ?? firstThumb;

  if (!clip || clip.kind !== 'av' || media?.kind === 'audio') {
    return (
      <section className="panel">
        <div className="panel-head"><span className="panel-title">{TITLES[mode]}</span></div>
        <div className="panel-body">
          <div className="empty-hint">Select a video or image clip on the timeline to apply {TITLES[mode].toLowerCase()}.</div>
        </div>
      </section>
    );
  }

  const current =
    mode === 'filters' ? (clip.filterId ?? 'none')
    : mode === 'effects' ? (clip.effectId ?? 'none')
    : (clip.transitionId ?? 'none');

  const apply = (id: string) => {
    if (mode === 'filters') updateClip(clip.id, { filterId: id });
    else if (mode === 'effects') updateClip(clip.id, { effectId: id });
    else updateClip(clip.id, { transitionId: id });
  };

  const items =
    mode === 'filters' ? FILTERS.map((f) => ({ id: f.id, label: f.label, css: f.css }))
    : mode === 'effects' ? EFFECTS.map((e) => ({ id: e.id, label: e.label, css: '' }))
    : TRANSITIONS.map((t) => ({ id: t.id, label: t.label, css: '' }));

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">{TITLES[mode]}</span>
      </div>

      <div className="panel-body">
        <div className="empty-hint" style={{ padding: '0 0 12px', textAlign: 'left' }}>
          {mode === 'transitions'
            ? 'Applies between this clip and the next one on the same track.'
            : 'Applies to the selected clip.'}
        </div>

        <div className="preset-grid">
          {items.map((it) => (
            <button
              key={it.id}
              className={'preset-card' + (current === it.id ? ' active' : '')}
              onClick={() => apply(it.id)}
              title={it.label}
            >
              <div className="preset-stage">
                {mode === 'filters' && swatch ? (
                  <img src={swatch} alt="" style={{ filter: it.css || 'none' }} />
                ) : mode === 'transitions' ? (
                  <TransitionGlyph id={it.id} />
                ) : (
                  <EffectGlyph id={it.id} />
                )}
              </div>
              <div className="preset-label">{it.label}</div>
            </button>
          ))}
        </div>

        {mode === 'transitions' && current !== 'none' && (
          <div className="insp-section" style={{ marginTop: 16 }}>
            <h4>Duration</h4>
            <input
              className="insp-slider"
              type="range"
              min={0.2}
              max={2}
              step={0.1}
              value={clip.transitionDuration ?? 0.6}
              onChange={(e) => updateClip(clip.id, { transitionDuration: Number(e.target.value) })}
            />
            <div className="insp-row"><span>Length</span><span>{(clip.transitionDuration ?? 0.6).toFixed(1)}s</span></div>
          </div>
        )}
      </div>
    </section>
  );
}

function TransitionGlyph({ id }: { id: string }) {
  const bg =
    id === 'none' ? 'linear-gradient(90deg,#4d7cfe 0 50%,#1d5f52 50% 100%)'
    : id === 'fade' ? 'linear-gradient(90deg,#4d7cfe,#1d5f52)'
    : id === 'wipeleft' ? 'linear-gradient(270deg,#4d7cfe 0 45%,#1d5f52 55% 100%)'
    : id === 'wiperight' ? 'linear-gradient(90deg,#4d7cfe 0 45%,#1d5f52 55% 100%)'
    : id === 'slideup' ? 'linear-gradient(0deg,#4d7cfe 0 45%,#1d5f52 55% 100%)'
    : id === 'slidedown' ? 'linear-gradient(180deg,#4d7cfe 0 45%,#1d5f52 55% 100%)'
    : id === 'circleopen' ? 'radial-gradient(circle at 50% 50%,#4d7cfe 30%,#1d5f52 60%)'
    : 'linear-gradient(90deg,#4d7cfe,#000 50%,#1d5f52)';
  return <div style={{ width: '100%', height: '100%', background: bg }} />;
}

function EffectGlyph({ id }: { id: string }) {
  return (
    <div className={'effect-glyph fx-' + id}>
      <span />
    </div>
  );
}
