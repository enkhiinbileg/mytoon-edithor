import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icons';
import { formatTime } from '../util';
import { useEditor } from '../store';
import {
  listAllProjects,
  switchToProject,
  createNewProject,
  duplicateProject,
  deleteProject,
  renameProject,
  openProject,
  showProjectInFolder
} from '../project';
import type { ProjectMeta } from '../project-types';

interface HomeScreenProps {
  onEnterEditor: () => void;
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '1.2M';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

function formatRelativeDate(ts: number): string {
  if (!ts) return '';
  const now = Date.now();
  const diff = now - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Дөнгөж сая';
  if (mins < 60) return `${mins} мин өмнө`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} цагийн өмнө`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Өчигдөр';
  if (days < 7) return `${days} өдрийн өмнө`;
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function resolveCoverUrl(cover?: string): string {
  if (!cover) return '';
  if (cover.startsWith('data:') || cover.startsWith('media:') || cover.startsWith('http:') || cover.startsWith('https:')) {
    return cover;
  }
  return window.api?.toMediaUrl ? window.api.toMediaUrl(cover) : cover;
}

interface ContextMenuState {
  x: number;
  y: number;
  project: ProjectMeta;
}

export default function HomeScreen({ onEnterEditor }: HomeScreenProps) {
  const currentProjectId = useEditor((s) => s.currentProjectId);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const [cardMenuId, setCardMenuId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});

  const renameInputRef = useRef<HTMLInputElement>(null);

  const loadList = async () => {
    setLoading(true);
    try {
      const list = await listAllProjects();
      setProjects(list);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    loadList();
  }, []);

  useEffect(() => {
    const handleGlobalClick = () => {
      if (contextMenu) setContextMenu(null);
      if (cardMenuId) setCardMenuId(null);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setCardMenuId(null);
        setRenamingId(null);
      }
    };
    window.addEventListener('click', handleGlobalClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('click', handleGlobalClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu, cardMenuId]);

  const handleOpen = async (id: string) => {
    try {
      await switchToProject(id);
      onEnterEditor();
    } catch (e: any) {
      alert(e.message || 'Төслийг нээхэд алдаа гарлаа');
    }
  };

  const handleCreateNew = async () => {
    try {
      await createNewProject();
      onEnterEditor();
    } catch (e: any) {
      alert(e.message || 'Шинэ төсөл үүсгэхэд алдаа гарлаа');
    }
  };

  const handleOpenFile = async () => {
    try {
      await openProject();
      onEnterEditor();
    } catch (e: any) {
      alert(e.message || 'Файл нээхэд алдаа гарлаа');
    }
  };

  const handleDuplicate = async (id: string) => {
    setCardMenuId(null);
    setContextMenu(null);
    try {
      await duplicateProject(id);
      await loadList();
    } catch (e: any) {
      alert(e.message || 'Төсөл хувилахад алдаа гарлаа');
    }
  };

  const handleDelete = async (id: string, name: string) => {
    setCardMenuId(null);
    setContextMenu(null);
    if (!confirm(`"${name}" төслийг бүрмөсөн устгах уу?`)) return;
    try {
      await deleteProject(id);
      await loadList();
    } catch (e: any) {
      alert(e.message || 'Төсөл устгахад алдаа гарлаа');
    }
  };

  const handleStartRename = (p: ProjectMeta) => {
    setCardMenuId(null);
    setContextMenu(null);
    setRenamingId(p.id);
    setRenameText(p.name);
    setTimeout(() => {
      if (renameInputRef.current) {
        renameInputRef.current.focus();
        renameInputRef.current.select();
      }
    }, 50);
  };

  const handleCommitRename = async (id: string) => {
    if (!renameText.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      await renameProject(id, renameText.trim());
      setRenamingId(null);
      await loadList();
    } catch (e: any) {
      alert(e.message || 'Нэр солиход алдаа гарлаа');
    }
  };

  const handleShowInFolder = async (id: string) => {
    setCardMenuId(null);
    setContextMenu(null);
    try {
      await showProjectInFolder(id);
    } catch (e: any) {
      alert(e.message || 'Файлын хавтас нээхэд алдаа гарлаа');
    }
  };

  const handleContextMenu = (e: React.MouseEvent, p: ProjectMeta) => {
    e.preventDefault();
    e.stopPropagation();
    setCardMenuId(null);
    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - 180),
      y: Math.min(e.clientY, window.innerHeight - 200),
      project: p
    });
  };

  const filtered = projects.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div
      className="capcut-home-screen"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
        background: '#0e0f13',
        color: '#e4e4eb',
        fontFamily: 'var(--font)',
        overflow: 'hidden',
        userSelect: 'none'
      }}
    >
      {/* 1. TOP WINDOW TITLE BAR */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 42,
          padding: '0 10px 0 16px',
          background: '#0a0b0e',
          borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
          WebkitAppRegion: 'drag'
        } as React.CSSProperties}
      >
        {/* Brand Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13 }}>
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 5,
              background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
              display: 'grid',
              placeItems: 'center',
              color: '#ffffff'
            }}
          >
            <Icon name="scissors" style={{ width: 13, height: 13 }} />
          </div>
          <span style={{ letterSpacing: 0.3, color: '#f3f4f6', fontWeight: 700 }}>Cutline</span>
          <span
            style={{
              fontSize: 9,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'rgba(56, 189, 248, 0.15)',
              color: '#38bdf8',
              fontWeight: 700,
              marginLeft: 2,
              letterSpacing: 0.5
            }}
          >
            STUDIO
          </span>
        </div>

        {/* Window controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            type="button"
            className="btn ghost icon-btn"
            style={{ padding: '5px 8px', color: '#8c9099' }}
            title="Тохиргоо"
          >
            <Icon name="settings" style={{ width: 15, height: 15 }} />
          </button>
          <div className="win-controls" style={{ display: 'flex', alignItems: 'center', marginLeft: 4 }}>
            <button
              onClick={() => window.api.minimize()}
              title="Minimize"
              style={{ padding: '6px 12px', color: '#8c9099', background: 'none' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            >
              <Icon name="min" style={{ width: 12, height: 12 }} />
            </button>
            <button
              onClick={() => window.api.toggleMaximize()}
              title="Maximize"
              style={{ padding: '6px 12px', color: '#8c9099', background: 'none' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            >
              <Icon name="max" style={{ width: 12, height: 12 }} />
            </button>
            <button
              className="close"
              onClick={() => window.api.close()}
              title="Close"
              style={{ padding: '6px 14px', color: '#8c9099', background: 'none' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#e11d48';
                e.currentTarget.style.color = '#ffffff';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'none';
                e.currentTarget.style.color = '#8c9099';
              }}
            >
              <Icon name="close" style={{ width: 12, height: 12 }} />
            </button>
          </div>
        </div>
      </header>

      {/* 2. BODY: LEFT SIDEBAR + MAIN CONTENT */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* LEFT SIDEBAR (CapCut Rail) */}
        <aside
          style={{
            width: 200,
            background: '#0e0f13',
            borderRight: '1px solid rgba(255, 255, 255, 0.05)',
            display: 'flex',
            flexDirection: 'column',
            padding: '14px 10px',
            gap: 16,
            flexShrink: 0
          }}
        >
          {/* User Profile Card */}
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(255, 255, 255, 0.05)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, #2b2e38, #181920)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 13,
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: '#9ca3af'
                }}
              >
                <Icon name="unlock" style={{ width: 16, height: 16 }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 12, fontWeight: 650, color: '#f3f4f6' }}>Cutline Creator</span>
                <span style={{ fontSize: 10, color: '#717682' }}>Pro Local Edition</span>
              </div>
            </div>

            <div
              style={{
                background: 'linear-gradient(90deg, #ec4899, #8b5cf6, #06b6d4)',
                borderRadius: 6,
                padding: '5px 8px',
                textAlign: 'center',
                fontSize: 11,
                fontWeight: 700,
                color: '#ffffff',
                cursor: 'pointer',
                boxShadow: '0 2px 10px rgba(139, 92, 246, 0.25)',
                transition: 'opacity 0.15s'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.9')}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
            >
              ✨ Cutline Pro
            </div>
          </div>

          {/* Primary Nav */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <button
              type="button"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderRadius: 6,
                background: '#1f2027',
                color: '#ffffff',
                fontWeight: 600,
                fontSize: 13,
                textAlign: 'left'
              }}
            >
              <Icon name="home" style={{ width: 16, height: 16, color: '#38bdf8' }} />
              <span>Home</span>
            </button>

            <button
              type="button"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderRadius: 6,
                color: '#8c9099',
                fontSize: 13,
                textAlign: 'left',
                transition: 'all 0.15s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#ffffff';
                e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#8c9099';
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <Icon name="templates" style={{ width: 16, height: 16 }} />
              <span>Templates</span>
            </button>
          </div>

          {/* CREATE WITH AI section */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#5e616c', padding: '6px 12px', letterSpacing: 0.8 }}>
              CREATE WITH AI
            </span>

            <button
              type="button"
              onClick={handleCreateNew}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 12px',
                borderRadius: 6,
                color: '#8c9099',
                fontSize: 13,
                textAlign: 'left',
                transition: 'all 0.15s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#ffffff';
                e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#8c9099';
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <Icon name="video" style={{ width: 15, height: 15 }} />
              <span>Video Studio</span>
            </button>

            <button
              type="button"
              onClick={handleCreateNew}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 12px',
                borderRadius: 6,
                color: '#8c9099',
                fontSize: 13,
                textAlign: 'left',
                transition: 'all 0.15s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#ffffff';
                e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#8c9099';
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <Icon name="design" style={{ width: 15, height: 15 }} />
              <span>Design Studio</span>
            </button>

            <button
              type="button"
              onClick={handleCreateNew}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 12px',
                borderRadius: 6,
                color: '#8c9099',
                fontSize: 13,
                textAlign: 'left',
                transition: 'all 0.15s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#ffffff';
                e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#8c9099';
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <Icon name="dub" style={{ width: 15, height: 15 }} />
              <span>Auto Dubbing</span>
            </button>
          </div>

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Bottom Promo Card (Sound to Scene) */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: 8,
              background: 'linear-gradient(135deg, #0b4e60 0%, #0369a1 100%)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              color: '#ffffff',
              boxShadow: '0 4px 16px rgba(3, 105, 161, 0.25)',
              position: 'relative',
              overflow: 'hidden'
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.2 }}>Sound to Scene</div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.8)', lineHeight: 1.4 }}>
              Auto-dub video with AI voices & sync visual events
            </div>
          </div>
        </aside>

        {/* MAIN CONTENT AREA */}
        <main
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            background: '#131418',
            padding: '20px 28px',
            overflowY: 'auto'
          }}
        >
          {/* TOP GLOWING HERO BANNER (CAPCUT 1:1) */}
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: 116,
              borderRadius: 12,
              background: 'linear-gradient(90deg, #00bfa5 0%, #00b4d8 35%, #0096c7 70%, #0284c7 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 8px 30px rgba(0, 180, 216, 0.22), inset 0 1px 0 rgba(255,255,255,0.2)',
              marginBottom: 22,
              flexShrink: 0
            }}
          >
            {/* Center "[+] Create project" Button */}
            <button
              type="button"
              onClick={handleCreateNew}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '12px 30px',
                borderRadius: 8,
                background: '#0b0c10',
                color: '#ffffff',
                fontSize: 15,
                fontWeight: 650,
                cursor: 'pointer',
                boxShadow: '0 4px 22px rgba(0, 0, 0, 0.5)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                transition: 'all 0.15s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'scale(1.02)';
                e.currentTarget.style.background = '#000000';
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'scale(1)';
                e.currentTarget.style.background = '#0b0c10';
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
              }}
            >
              <div
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  width: 20,
                  height: 20,
                  background: 'rgba(255, 255, 255, 0.12)',
                  borderRadius: 4,
                  fontSize: 13,
                  fontWeight: 700
                }}
              >
                +
              </div>
              <span style={{ letterSpacing: 0.2 }}>Create project</span>
            </button>
          </div>

          {/* PROJECTS TOOLBAR */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 16,
              gap: 12
            }}
          >
            {/* Left: Projects title & count */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#f3f4f6' }}>Projects</h2>
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 10,
                  background: 'rgba(255, 255, 255, 0.06)',
                  color: '#8c9099'
                }}
              >
                {filtered.length}
              </span>
            </div>

            {/* Right: Search, Grid/List view toggle, Open file, Refresh */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* Search input */}
              <div style={{ position: 'relative' }}>
                <input
                  style={{
                    width: 200,
                    padding: '6px 26px 6px 28px',
                    fontSize: 12,
                    borderRadius: 6,
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    background: 'rgba(255, 255, 255, 0.04)',
                    color: '#f3f4f6',
                    outline: 'none'
                  }}
                  placeholder="Search projects..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <span
                  style={{
                    position: 'absolute',
                    left: 8,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    fontSize: 12,
                    opacity: 0.5,
                    pointerEvents: 'none'
                  }}
                >
                  <Icon name="search" style={{ width: 13, height: 13 }} />
                </span>
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    style={{
                      position: 'absolute',
                      right: 6,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      fontSize: 11,
                      color: '#8c9099',
                      padding: 2
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* View Switch (Grid / List) */}
              <div
                style={{
                  display: 'flex',
                  background: 'rgba(255, 255, 255, 0.04)',
                  borderRadius: 6,
                  padding: 2,
                  border: '1px solid rgba(255, 255, 255, 0.06)'
                }}
              >
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  style={{
                    padding: '4px 7px',
                    fontSize: 12,
                    borderRadius: 4,
                    background: viewMode === 'grid' ? 'rgba(255, 255, 255, 0.12)' : 'transparent',
                    color: viewMode === 'grid' ? '#ffffff' : '#8c9099'
                  }}
                  title="Grid view"
                >
                  <Icon name="grid" style={{ width: 14, height: 14 }} />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  style={{
                    padding: '4px 7px',
                    fontSize: 12,
                    borderRadius: 4,
                    background: viewMode === 'list' ? 'rgba(255, 255, 255, 0.12)' : 'transparent',
                    color: viewMode === 'list' ? '#ffffff' : '#8c9099'
                  }}
                  title="List view"
                >
                  <Icon name="list" style={{ width: 14, height: 14 }} />
                </button>
              </div>

              {/* Open .cutline file from disk */}
              <button
                type="button"
                className="btn"
                onClick={handleOpenFile}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  fontSize: 12,
                  borderRadius: 6,
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  background: 'rgba(255, 255, 255, 0.04)',
                  color: '#e4e4eb'
                }}
                title="Open project from file (.cutline)"
              >
                <Icon name="folder" style={{ width: 14, height: 14 }} />
                <span>Open file</span>
              </button>

              {/* Refresh list */}
              <button
                type="button"
                className="btn ghost icon-btn"
                onClick={loadList}
                style={{
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  color: '#8c9099'
                }}
                title="Refresh project list"
              >
                <Icon name="refresh" style={{ width: 14, height: 14 }} />
              </button>
            </div>
          </div>

          {/* PROJECTS GALLERY (GRID VIEW) */}
          {loading ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: '#8c9099' }}>
              Төслүүдийг уншиж байна...
            </div>
          ) : filtered.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '60px 0',
                gap: 12,
                color: '#8c9099'
              }}
            >
              <div style={{ width: 48, height: 48, opacity: 0.4 }}>
                <Icon name="video" style={{ width: '100%', height: '100%' }} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 650, color: '#f3f4f6' }}>Одоогоор төсөл алга байна</div>
              <div style={{ fontSize: 12 }}>Дээрх "+ Create project" товчийг дарж шинэ төсөл эхлүүлээрэй.</div>
              <button
                type="button"
                className="btn primary"
                onClick={handleCreateNew}
                style={{ marginTop: 8, padding: '8px 22px', borderRadius: 6 }}
              >
                + Шинэ төсөл эхлүүлэх
              </button>
            </div>
          ) : viewMode === 'grid' ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(142px, 1fr))',
                gap: 14
              }}
            >
              {filtered.map((p) => {
                const isActive = p.id === currentProjectId;
                const coverUrl = resolveCoverUrl(p.cover);
                const hasValidImage = coverUrl && !failedImages[p.id];
                const isHovered = hoveredCardId === p.id;
                const sizeStr = formatFileSize(p.size);
                const durStr = formatTime(p.duration || 0, false);

                return (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      cursor: 'pointer',
                      borderRadius: 8,
                      overflow: 'visible',
                      position: 'relative',
                      transition: 'transform 0.15s ease'
                    }}
                    onMouseEnter={() => setHoveredCardId(p.id)}
                    onMouseLeave={() => setHoveredCardId(null)}
                    onClick={() => handleOpen(p.id)}
                    onContextMenu={(e) => handleContextMenu(e, p)}
                  >
                    {/* Thumbnail Box: Aspect ratio ~4:5 */}
                    <div
                      style={{
                        position: 'relative',
                        width: '100%',
                        paddingTop: '120%',
                        background: '#15161c',
                        borderRadius: 8,
                        overflow: 'hidden',
                        border: isActive
                          ? '2px solid #00c4cc'
                          : isHovered
                          ? '1px solid rgba(255, 255, 255, 0.25)'
                          : '1px solid rgba(255, 255, 255, 0.06)',
                        boxShadow: isActive ? '0 0 14px rgba(0, 196, 204, 0.3)' : 'none',
                        transition: 'border-color 0.15s, box-shadow 0.15s'
                      }}
                    >
                      {/* PURE THUMBNAIL (No overlays or clappers on top of character!) */}
                      {hasValidImage ? (
                        <img
                          src={coverUrl}
                          alt=""
                          style={{
                            position: 'absolute',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover'
                          }}
                          onError={() => setFailedImages((prev) => ({ ...prev, [p.id]: true }))}
                          draggable={false}
                        />
                      ) : (
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            background: '#161720',
                            color: '#474b5b'
                          }}
                        >
                          <Icon name="video" style={{ width: 28, height: 28, opacity: 0.7 }} />
                          <span style={{ fontSize: 10, letterSpacing: 0.6, fontWeight: 600 }}>CUTLINE</span>
                        </div>
                      )}

                      {/* HOVER ACTION OVERLAY */}
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          background: 'rgba(0, 0, 0, 0.42)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          opacity: isHovered ? 1 : 0,
                          transition: 'opacity 0.15s ease',
                          pointerEvents: isHovered ? 'auto' : 'none'
                        }}
                      >
                        {/* Play / Open Button */}
                        <div
                          style={{
                            width: 38,
                            height: 38,
                            borderRadius: '50%',
                            background: 'rgba(2, 132, 199, 0.95)',
                            display: 'grid',
                            placeItems: 'center',
                            color: '#ffffff',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                            transform: isHovered ? 'scale(1)' : 'scale(0.85)',
                            transition: 'transform 0.15s ease'
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpen(p.id);
                          }}
                          title={isActive ? 'Үргэлжлүүлэх' : 'Нээх'}
                        >
                          <Icon name="play" style={{ width: 16, height: 16, marginLeft: 2 }} filled />
                        </div>

                        {/* Top-Right Menu Button on hover */}
                        <button
                          type="button"
                          style={{
                            position: 'absolute',
                            top: 6,
                            right: 6,
                            width: 24,
                            height: 24,
                            borderRadius: 4,
                            background: 'rgba(0, 0, 0, 0.65)',
                            color: '#ffffff',
                            display: 'grid',
                            placeItems: 'center',
                            padding: 0
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCardMenuId(cardMenuId === p.id ? null : p.id);
                          }}
                          title="Цэс"
                        >
                          <Icon name="more" style={{ width: 14, height: 14 }} />
                        </button>
                      </div>

                      {/* Dropdown Menu from card ⋮ */}
                      {cardMenuId === p.id && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 34,
                            right: 6,
                            background: '#1c1e24',
                            border: '1px solid rgba(255, 255, 255, 0.12)',
                            borderRadius: 6,
                            boxShadow: '0 8px 24px rgba(0,0,0,0.7)',
                            zIndex: 100,
                            minWidth: 140,
                            padding: '4px 0',
                            display: 'flex',
                            flexDirection: 'column'
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            style={{
                              padding: '7px 12px',
                              fontSize: 11,
                              textAlign: 'left',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              color: '#f3f4f6'
                            }}
                            onClick={() => handleOpen(p.id)}
                          >
                            <span>▶</span>
                            <span>Нээх</span>
                          </button>
                          <button
                            type="button"
                            style={{
                              padding: '7px 12px',
                              fontSize: 11,
                              textAlign: 'left',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              color: '#f3f4f6'
                            }}
                            onClick={() => handleStartRename(p)}
                          >
                            <span>✏️</span>
                            <span>Нэр солих</span>
                          </button>
                          <button
                            type="button"
                            style={{
                              padding: '7px 12px',
                              fontSize: 11,
                              textAlign: 'left',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              color: '#f3f4f6'
                            }}
                            onClick={() => handleDuplicate(p.id)}
                          >
                            <span>📄</span>
                            <span>Хувилах</span>
                          </button>
                          <button
                            type="button"
                            style={{
                              padding: '7px 12px',
                              fontSize: 11,
                              textAlign: 'left',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              color: '#f3f4f6'
                            }}
                            onClick={() => handleShowInFolder(p.id)}
                          >
                            <span>📁</span>
                            <span>Хавтас нээх</span>
                          </button>
                          <hr
                            style={{
                              border: 'none',
                              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                              margin: '3px 0'
                            }}
                          />
                          <button
                            type="button"
                            style={{
                              padding: '7px 12px',
                              fontSize: 11,
                              textAlign: 'left',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              color: '#f87171'
                            }}
                            onClick={() => handleDelete(p.id, p.name)}
                          >
                            <span>🗑️</span>
                            <span>Устгах</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* METADATA BELOW THUMBNAIL (CapCut 1:1 format: Title + Size | Duration) */}
                    <div
                      style={{
                        paddingTop: 6,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* Line 1: Title */}
                      {renamingId === p.id ? (
                        <input
                          ref={renameInputRef}
                          style={{
                            padding: '2px 4px',
                            fontSize: 12,
                            width: '100%',
                            background: '#1f2027',
                            color: '#ffffff',
                            border: '1px solid #38bdf8',
                            borderRadius: 4,
                            outline: 'none'
                          }}
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          onBlur={() => handleCommitRename(p.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCommitRename(p.id);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: '#f3f4f6',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}
                          title={p.name}
                          onDoubleClick={() => handleStartRename(p)}
                        >
                          {p.name}
                        </div>
                      )}

                      {/* Line 2: CapCut Exact Subtitle: [Size] | [Duration] */}
                      <div
                        style={{
                          fontSize: 11,
                          color: '#717682',
                          letterSpacing: 0.1,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6
                        }}
                      >
                        <span>{sizeStr}</span>
                        <span style={{ opacity: 0.4 }}>|</span>
                        <span>{durStr}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* LIST VIEW */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {filtered.map((p) => {
                const isActive = p.id === currentProjectId;
                const coverUrl = resolveCoverUrl(p.cover);
                const hasValidImage = coverUrl && !failedImages[p.id];
                const sizeStr = formatFileSize(p.size);
                const durStr = formatTime(p.duration || 0, false);

                return (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '8px 12px',
                      background: 'rgba(255, 255, 255, 0.02)',
                      borderRadius: 6,
                      border: isActive ? '1px solid #00c4cc' : '1px solid rgba(255, 255, 255, 0.05)',
                      cursor: 'pointer'
                    }}
                    onClick={() => handleOpen(p.id)}
                    onContextMenu={(e) => handleContextMenu(e, p)}
                  >
                    {/* Small thumbnail */}
                    <div
                      style={{
                        position: 'relative',
                        width: 48,
                        height: 36,
                        borderRadius: 4,
                        background: '#15161c',
                        overflow: 'hidden',
                        flexShrink: 0
                      }}
                    >
                      {hasValidImage ? (
                        <img
                          src={coverUrl}
                          alt=""
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={() => setFailedImages((prev) => ({ ...prev, [p.id]: true }))}
                        />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: '#474b5b' }}>
                          <Icon name="video" style={{ width: 18, height: 18 }} />
                        </div>
                      )}
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#f3f4f6' }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: '#717682', marginTop: 2 }}>
                        {sizeStr} · {durStr} · {p.clipCount || 0} clips · {formatRelativeDate(p.updatedAt)}
                      </div>
                    </div>

                    <button
                      type="button"
                      className="btn primary"
                      style={{ fontSize: 11, padding: '4px 12px', borderRadius: 4 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpen(p.id);
                      }}
                    >
                      {isActive ? 'Үргэлжлүүлэх' : 'Нээх'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </div>

      {/* 3. RIGHT-CLICK CONTEXT MENU (Native CapCut feel) */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            background: '#1c1e24',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.8)',
            zIndex: 9999,
            minWidth: 150,
            padding: '4px 0',
            display: 'flex',
            flexDirection: 'column'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            style={{
              padding: '7px 14px',
              fontSize: 12,
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: '#f3f4f6'
            }}
            onClick={() => handleOpen(contextMenu.project.id)}
          >
            <span>▶</span>
            <span>Нээх</span>
          </button>
          <button
            type="button"
            style={{
              padding: '7px 14px',
              fontSize: 12,
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: '#f3f4f6'
            }}
            onClick={() => handleStartRename(contextMenu.project)}
          >
            <span>✏️</span>
            <span>Нэр солих</span>
          </button>
          <button
            type="button"
            style={{
              padding: '7px 14px',
              fontSize: 12,
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: '#f3f4f6'
            }}
            onClick={() => handleDuplicate(contextMenu.project.id)}
          >
            <span>📄</span>
            <span>Хувилах</span>
          </button>
          <button
            type="button"
            style={{
              padding: '7px 14px',
              fontSize: 12,
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: '#f3f4f6'
            }}
            onClick={() => handleShowInFolder(contextMenu.project.id)}
          >
            <span>📁</span>
            <span>Хавтас нээх</span>
          </button>
          <hr
            style={{
              border: 'none',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              margin: '3px 0'
            }}
          />
          <button
            type="button"
            style={{
              padding: '7px 14px',
              fontSize: 12,
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: '#f87171'
            }}
            onClick={() => handleDelete(contextMenu.project.id, contextMenu.project.name)}
          >
            <span>🗑️</span>
            <span>Устгах</span>
          </button>
        </div>
      )}
    </div>
  );
}
