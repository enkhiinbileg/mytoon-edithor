import { useEditor } from '../store';
import { STICKERS } from '../looks';

export default function StickerPanel() {
  const addStickerClip = useEditor((s) => s.addStickerClip);

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Stickers</span>
      </div>
      <div className="panel-body">
        <div className="empty-hint" style={{ padding: '0 0 12px', textAlign: 'left' }}>
          Adds a 4s sticker on the overlay track at the playhead.
        </div>
        <div className="sticker-grid">
          {STICKERS.map((s) => (
            <button key={s} className="sticker-card" onClick={() => addStickerClip(s)} title={s}>
              {s}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
