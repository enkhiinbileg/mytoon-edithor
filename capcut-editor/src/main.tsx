import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// The renderer normally gets `api` from the Electron preload. Provide an inert
// stand-in when the page is opened in a plain browser so the UI can be
// inspected with ordinary devtools during development.
if (!window.api) {
  const offline = 'not running in Electron';
  window.api = ({
    prepareVoiceEdit: async()=>({ok:false,error:'Open the desktop app.'}),
    renderVoiceEdit: async()=>({ok:false,error:'Open the desktop app.'}),
    syncTimelineVoice: async()=>({ok:false,error:'Open the desktop app.'}),
    buildScriptRecap: async()=>({ok:false,error:'Open the desktop app.'}),
    onScriptStudioProgress: ()=>()=>{},
    cancelVoiceEdit: async()=>false,
    onVoiceEditProgress: ()=>()=>{},
    recapStatus: async () => ({downloader:false,running:false}),
    setupRecapDownloader: async () => ({ok:false,error:'Open the desktop app to install the downloader.'}),
    runFastRecap: async () => ({ok:false,error:'Fast recap requires the desktop app.'}),
    cancelFastRecap: async () => false,
    onRecapProgress: () => () => {},
    saveProject: async () => ({ok:false,error:'Open the desktop app to save a project file.'}),
    openProject: async () => ({ok:false,error:'Open the desktop app to open a project file.'}),
    autosaveProject: async (data: any, path: any) => { localStorage.setItem('cutline-draft',JSON.stringify({data,path})); return {ok:true}; },
    restoreProject: async () => { try { return JSON.parse(localStorage.getItem('cutline-draft') || 'null'); } catch { return null; } },
    readSettings: async () => ({ anthropicApiKey: false, elevenLabsApiKey: false }),
    updateSettings: async () => ({ anthropicApiKey: false, elevenLabsApiKey: false }),
    whisperStatus: async () => ({ available: false, binary: null, models: [] }),
    downloadWhisperModel: async () => '',
    onWhisperProgress: () => () => {},
    transcribe: async () => ({ ok: false, error: offline }),
    openSubtitles: async () => ({ ok: false, error: offline }),
    autosaveDub: async () => false,
    restoreDub: async () => null,
    saveDubAs: async () => ({ ok: false, error: offline }),
    openDubFrom: async () => ({ ok: false, error: offline }),
    exportDubSrt: async () => ({ ok: false, error: offline }),
    translateProviders: async () => [],
    translateModels: async () => ({ ok: false, error: offline }),
    translateSegments: async () => ({ ok: false, error: offline }),
    synthesizeDub: async () => ({ ok: false, error: offline }),
    onDubProgress: () => () => {},
    voiceProviders: async () => [],
    listVoices: async () => ({ ok: false, error: offline }),
    listTtsModels: async () => ({ ok: false, error: offline }),
    voiceQuota: async () => ({ ok: true, quota: null }),

    initialMedia: async () => [],
    openMedia: async () => [],
    probe: async () => ({ duration: 0, width: 0, height: 0, fps: 30, hasVideo: false, hasAudio: false, kind: 'unknown' }),
    thumbnails: async () => [],
    saveExportDialog: async () => null,
    runExport: async () => ({ ok: false, error: 'not running in Electron' }),
    onExportProgress: () => () => {},
    showItemInFolder: async () => {},
    minimize: async () => {},
    toggleMaximize: async () => false,
    close: async () => {},
    toMediaUrl: (p: string) => p
  } as any);
}

import React from 'react';

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: any }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error('[RootErrorBoundary caught error]:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          backgroundColor: '#111114',
          color: '#fff',
          fontFamily: 'Inter, system-ui, sans-serif',
          padding: 24,
          textAlign: 'center'
        }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Дэлгэцийн дүрслэлд түр алдаа гарлаа</h2>
          <p style={{ fontSize: 13, color: '#888', maxWidth: 460, marginBottom: 20, lineHeight: 1.5 }}>
            {String(this.state.error?.message || this.state.error || 'Санах ойн түр ачаалал үүссэн тул төслийг дахин ачаална уу.')}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 20px',
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 6,
              background: '#00c48c',
              color: '#000',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            Дахин ачаалах (Reload)
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>
);
