import { useEffect, useState } from 'react';
import { Icon } from '../Icons';

export default function VisionSettingsModal({
  onClose,
  onSaved,
  onRunVision
}: {
  onClose: () => void;
  onSaved: () => void;
  onRunVision?: () => void;
}) {
  const [hasKey, setHasKey] = useState<boolean>(false);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => {
    window.api.readSettings().then((s) => {
      setHasKey(Boolean(s.geminiApiKey));
    });
  }, []);

  const handleSave = async (andRun = false) => {
    const keyToSave = apiKey.trim();
    if (!keyToSave && !hasKey) return;
    setSaving(true);
    try {
      if (keyToSave) {
        await window.api.updateSettings({ geminiApiKey: keyToSave });
        setHasKey(true);
        setApiKey('');
      }
      setStatusMsg('✓ Gemini API түлхүүр хадгалагдлаа! Vision AI ажиллахад бэлэн.');
      onSaved();
      if (andRun && onRunVision) {
        onClose();
        onRunVision();
      } else {
        setTimeout(() => {
          onClose();
        }, 1200);
      }
    } catch (e) {
      setStatusMsg(`Алдаа: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setSaving(true);
    try {
      await window.api.updateSettings({ geminiApiKey: '' });
      setHasKey(false);
      setStatusMsg('Gemini түлхүүр устгагдлаа.');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true">
      <div className="dialog" style={{ width: 460, maxWidth: '95vw', padding: '18px 22px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="dub" style={{ width: 18, height: 18, color: 'var(--primary, #00c48c)' }} />
            Vision AI (Дүрс таних) Тохиргоо
          </h3>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>

        <p style={{ margin: '0 0 12px 0', fontSize: 12, color: 'var(--text-dim, #aaa)', lineHeight: 1.4 }}>
          Google Gemini Flash Vision AI нь таны бичлэгийн кадруудыг нүдээрээ харж монгол voice ярианд яв цав тохирох үзэгдлийг автоматаар зүсэж эдитлэнэ.
        </p>

        <div style={{
          padding: '10px 14px',
          borderRadius: 6,
          background: hasKey ? 'rgba(0, 196, 140, 0.12)' : 'rgba(255, 255, 255, 0.05)',
          border: `1px solid ${hasKey ? 'var(--primary, #00c48c)' : 'rgba(255, 255, 255, 0.1)'}`,
          marginBottom: 14,
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>{hasKey ? '🟢' : '⚪'}</span>
            <span>
              {hasKey ? 'Vision AI идэвхжсэн (Google Gemini бэлэн)' : 'Vision AI идэвхжээгүй (Gemini түлхүүр оруулаагүй)'}
            </span>
          </div>
          {hasKey && onRunVision && (
            <button
              className="btn"
              onClick={() => {
                onClose();
                onRunVision();
              }}
              style={{
                background: 'var(--primary, #00c48c)',
                color: '#000',
                border: 'none',
                padding: '4px 10px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 5,
                cursor: 'pointer'
              }}
            >
              ⚡ Шууд ажиллуулах
            </button>
          )}
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 11, marginBottom: 6, color: '#ccc' }}>
            {hasKey ? 'Шинэ түлхүүрээр солих (эсвэл хоосон үлдээх):' : 'Google Gemini API Key оруулах:'}
          </label>
          <input
            type="password"
            placeholder="AIzaSy..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 12px',
              fontSize: 12,
              borderRadius: 6,
              background: '#1a1a1a',
              border: '1px solid #333',
              color: '#fff',
              outline: 'none'
            }}
          />
          <div style={{ marginTop: 6, fontSize: 11, color: '#888' }}>
            Түлхүүргүй бол <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{ color: 'var(--primary, #00c48c)' }}>aistudio.google.com</a> дээрээс үнэгүй авах боломжтой.
          </div>
        </div>

        {statusMsg && (
          <div style={{ margin: '0 0 12px 0', fontSize: 12, color: statusMsg.startsWith('✓') ? '#00c48c' : '#ff6b6b' }}>
            {statusMsg}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {hasKey && (
            <button
              className="btn"
              onClick={handleRemove}
              disabled={saving}
              style={{ background: '#331111', color: '#ff7777', border: 'none', padding: '6px 12px', fontSize: 12, borderRadius: 6, cursor: 'pointer' }}
            >
              Түлхүүр устгах
            </button>
          )}
          <button
            className="btn"
            onClick={onClose}
            style={{ background: '#2a2a2a', color: '#ccc', border: 'none', padding: '6px 12px', fontSize: 12, borderRadius: 6, cursor: 'pointer' }}
          >
            Болих
          </button>
          {apiKey.trim() && onRunVision && (
            <button
              className="btn"
              onClick={() => handleSave(true)}
              disabled={saving}
              style={{ background: 'var(--primary, #00c48c)', color: '#000', border: 'none', padding: '6px 14px', fontSize: 12, borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}
            >
              ⚡ Хадгалаад шууд эдитлэх
            </button>
          )}
          <button
            className="btn primary"
            onClick={() => handleSave(false)}
            disabled={saving || (!apiKey.trim() && !hasKey)}
            style={{ padding: '6px 16px', fontSize: 12, borderRadius: 6, fontWeight: 600, cursor: (apiKey.trim() || hasKey) ? 'pointer' : 'default' }}
          >
            {saving ? 'Хадгалж байна...' : 'Хадгалах'}
          </button>
        </div>
      </div>
    </div>
  );
}
