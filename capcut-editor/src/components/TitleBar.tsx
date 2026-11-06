import { useState } from 'react';
import { Icon } from '../Icons';
import { useEditor } from '../store';

export default function TitleBar({ onExport, onSave, onOpen, onNew, onClose, onOpenProjects, onGoHome }: {
  onExport: () => void; onSave: (saveAs?:boolean) => void; onOpen: () => void; onNew: () => void; onClose: () => void; onOpenProjects: () => void; onGoHome: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const name = useEditor(s => s.projectName), dirty = useEditor(s => s.dirty);
  const rename = useEditor(s => s.renameProject);
  const clips = useEditor(s => s.clips), pct = useEditor(s => s.exportPct);
  return <header className="titlebar">
    <div
      className="logo"
      title="Үндсэн дэлгэц рүү буцах"
      onClick={onGoHome}
      style={{ cursor: 'pointer' }}
    >
      <span className="logo-mark">
        <img
          src="./logo.png"
          alt="Logo"
          draggable={false}
          style={{ width: 24, height: 24, borderRadius: 5, objectFit: 'cover', display: 'block' }}
        />
      </span>
      <span>Cutline</span>
    </div>
    <button
      type="button"
      className="btn ghost"
      onClick={onGoHome}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        fontSize: 12,
        fontWeight: 600,
        background: 'rgba(255,255,255,0.08)',
        borderRadius: 'var(--radius-sm)',
        color: '#38bdf8'
      }}
      title="Үндсэн дэлгэц рүү буцах (Home)"
    >
      <span>🏠</span>
      <span>Home</span>
    </button>
    <div className="project-menu">
      <button className="menu-trigger" onClick={() => setMenu(!menu)} aria-expanded={menu}>Menu <span>⌄</span></button>
      {menu && <><button className="menu-dismiss" aria-label="Close menu" onClick={() => setMenu(false)} /><div className="menu-popover">
        <button onClick={() => {setMenu(false);onGoHome();}}>🏠 Үндсэн дэлгэц (Home)</button>
        <button onClick={() => {setMenu(false);onOpenProjects();}}>📁 Төслийн сан <kbd>Ctrl P</kbd></button>
        <button onClick={() => {setMenu(false);onNew();}}>Шинэ төсөл <kbd>Ctrl N</kbd></button>
        <button onClick={() => {setMenu(false);onOpen();}}>Файлаас нээх <kbd>Ctrl O</kbd></button>
        <hr /><button onClick={() => {setMenu(false); window.dispatchEvent(new CustomEvent('open-image-recap'));}}>🎨 Зураг & Хадмал холбогч</button>
        <button onClick={() => {setMenu(false); window.dispatchEvent(new CustomEvent('open-audio-merger'));}}>🎵 Аудио нэгтгэх (Merge Audio)</button>
        <button onClick={() => {setMenu(false);onSave();}}>Хадгалах <kbd>Ctrl S</kbd></button>
        <button onClick={() => {setMenu(false);onSave(true);}}>Өөр нэрээр хадгалах <kbd>Ctrl Shift S</kbd></button>
      </div></>}
    </div>
    <button
      type="button"
      className="btn ghost"
      onClick={onOpenProjects}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        fontSize: 12,
        fontWeight: 600,
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text)'
      }}
      title="Төслийн сан (Projects Library - Ctrl+P)"
    >
      <span>📁</span>
      <span>Төслүүд</span>
    </button>
    <button
      type="button"
      className="btn ghost"
      onClick={() => window.dispatchEvent(new CustomEvent('open-audio-merger'))}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        fontSize: 12,
        fontWeight: 600,
        background: 'rgba(99,102,241,0.1)',
        border: '1px solid rgba(99,102,241,0.25)',
        borderRadius: 'var(--radius-sm)',
        color: '#a5b4fc'
      }}
      title="Хоёр буюу түүнээс олон аудио нэгтгэх"
    >
      <span>🎵</span>
      <span>Аудио нэгтгэх</span>
    </button>
    <button
      type="button"
      className="btn ghost"
      onClick={() => window.dispatchEvent(new CustomEvent('open-image-recap'))}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        fontSize: 12,
        fontWeight: 600,
        background: 'rgba(168,85,247,0.12)',
        border: '1px solid rgba(168,85,247,0.3)',
        borderRadius: 'var(--radius-sm)',
        color: '#d8b4fe'
      }}
      title="Зураг, хадмал, хоолойг уялдуулж видео үүсгэх"
    >
      <span>🎨</span>
      <span>Зураг & Хадмал студи</span>
    </button>
    <div className="title-project"><input aria-label="Project name" value={name} onChange={e => rename(e.target.value)} onFocus={() => useEditor.getState().beginGesture()} onBlur={() => useEditor.getState().endGesture()} /><span className="save-state">{dirty ? '● Хадгалагдаагүй' : '✓ Автоматаар хадгалагдсан'}</span></div>
    <div className="titlebar-actions">
      <button className="btn save-btn" onClick={() => onSave()} title="Save project (Ctrl+S)">Save</button>
      <button className="btn primary" onClick={onExport} disabled={!clips.length || pct !== null}><Icon name="export" />{typeof pct === 'number' ? `Exporting ${pct}%` : 'Export'}</button>
      <div className="win-controls">
        <button onClick={() => window.api.minimize()} title="Minimize"><Icon name="min" /></button>
        <button onClick={() => window.api.toggleMaximize()} title="Maximize"><Icon name="max" /></button>
        <button className="close" onClick={onClose} title="Close"><Icon name="close" /></button>
      </div>
    </div>
  </header>;
}

