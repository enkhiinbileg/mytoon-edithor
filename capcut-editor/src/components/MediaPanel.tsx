import { useState } from 'react';
import { Icon } from '../Icons';
import { useEditor } from '../store';
import { importPaths } from '../importMedia';
import { formatShort } from '../util';

export default function MediaPanel({ audioOnly = false }: { audioOnly?: boolean }) {
  const media = useEditor(s => s.media), add = useEditor(s => s.addMediaToTimeline);
  const [loading,setLoading] = useState(false), [error,setError] = useState('');
  const [query,setQuery] = useState(''), [kind,setKind] = useState('all');
  async function importFiles() {
    setError('');
    try {
      const paths = await window.api.openMedia();
      if (!paths.length) return;
      setLoading(true);
      const items = await importPaths(paths);
      if (items.length < paths.length) setError((paths.length-items.length)+' file(s) could not be imported. Check the media format and FFmpeg installation.');
    } catch(e) {setError(e instanceof Error ? e.message : String(e));}
    finally {setLoading(false);}
  }
  const userMedia = media.filter(m => !m.isInternal && !m.id.startsWith('freeze-'));
  const shown = userMedia.filter(m => (!audioOnly || m.kind==='audio') && (kind==='all'||m.kind===kind) && m.name.toLowerCase().includes(query.toLowerCase()));
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; mediaId: string; path: string; name: string } | null>(null);

  return (
    <section
      className="panel media-panel"
      onClick={() => setCtxMenu(null)}
    >
      <aside className="library-sidebar"><span className="sidebar-heading">Library</span>
        <button className={kind==='all'?'active':''} onClick={()=>setKind('all')}><Icon name="folder" />{audioOnly ? 'Your audio' : 'Import'}</button>
        {!audioOnly && <><button className={kind==='video'?'active':''} onClick={()=>setKind('video')}><Icon name="media" />Videos</button><button className={kind==='image'?'active':''} onClick={()=>setKind('image')}><Icon name="sticker" />Images</button><button className={kind==='audio'?'active':''} onClick={()=>setKind('audio')}><Icon name="audio" />Audio</button></>}
        <div className="library-sidebar-bottom">Local media<span>{userMedia.length} assets</span></div>
      </aside>
      <div className="media-main">
        <div className="panel-head"><button className="btn import-button" onClick={importFiles} disabled={loading}><Icon name="plus" />{loading?'Importing…':'Import'}</button><span className="asset-count">{shown.length} items</span></div>
        <div className="media-search"><input aria-label="Search media" placeholder="Search media" value={query} onChange={e=>setQuery(e.target.value)} /><span>⌕</span></div>
        <div className="panel-body">
          {error && <div className="dub-error" role="alert">{error}</div>}
          {!!shown.length && <div className="media-grid">{shown.map(m=><div
            key={m.id}
            className="media-card"
            title={m.name+' · Double-click to add, Right-click for options'}
            onDoubleClick={()=>add(m.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu({ x: Math.min(window.innerWidth - 180, e.clientX), y: Math.min(window.innerHeight - 150, e.clientY), mediaId: m.id, path: m.path, name: m.name });
            }}
            draggable
            onDragStart={e=>e.dataTransfer.setData('text/media-id',m.id)}
          >
            <div className="media-thumb">{m.thumbs[0]?<img src={m.thumbs[0]} alt="" />:<Icon name={m.kind==='audio'?'audio':'media'} style={{width:26,height:26}} />}<span className="media-badge">{formatShort(m.duration)}</span><button className="media-add" aria-label={'Add '+m.name+' to timeline'} onClick={()=>add(m.id)}><Icon name="plus" /></button></div><div className="media-name">{m.name}</div>
          </div>)}</div>}
          {!shown.length && !loading && <div className="media-empty"><div className="empty-folder"><Icon name="folder" /></div><h3>{query?'No matching media':'Your story starts here'}</h3><p>{query?'Try a different search.':'Import videos, photos, and audio to start creating.'}</p>{!query&&<button className="btn" onClick={importFiles}>Import media</button>}<small>Drag assets onto the timeline</small></div>}
        </div>
      </div>

      {ctxMenu && (
        <div
          style={{
            position: 'fixed',
            left: ctxMenu.x,
            top: ctxMenu.y,
            background: '#1c1e24',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.8)',
            zIndex: 99999,
            minWidth: 160,
            padding: '4px 0',
            display: 'flex',
            flexDirection: 'column'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ padding: '6px 12px', fontSize: 11, color: '#9ca3af', borderBottom: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ctxMenu.name}
          </div>
          <button
            type="button"
            style={{ padding: '7px 12px', fontSize: 12, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, color: '#f3f4f6', background: 'transparent', border: 'none', cursor: 'pointer' }}
            onClick={() => {
              add(ctxMenu.mediaId);
              setCtxMenu(null);
            }}
          >
            <span>➕</span>
            <span>Timeline-д нэмэх</span>
          </button>
          <button
            type="button"
            style={{ padding: '7px 12px', fontSize: 12, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, color: '#38bdf8', background: 'transparent', border: 'none', cursor: 'pointer' }}
            onClick={() => {
              window.dispatchEvent(new CustomEvent('open-audio-script'));
              setCtxMenu(null);
            }}
          >
            <span>⚡</span>
            <span>Скрипттэй уялдуулж таймлайн үүсгэх</span>
          </button>
          <button
            type="button"
            style={{ padding: '7px 12px', fontSize: 12, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, color: '#f3f4f6', background: 'transparent', border: 'none', cursor: 'pointer' }}
            onClick={() => {
              window.api.showItemInFolder(ctxMenu.path);
              setCtxMenu(null);
            }}
          >
            <span>📁</span>
            <span>Хавтас нээх</span>
          </button>
        </div>
      )}
    </section>
  );
}

