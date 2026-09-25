import { useEffect, useState } from 'react';
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
  openProject
} from '../project';
import type { ProjectMeta } from '../project-types';

function formatRelativeDate(ts: number): string {
  if (!ts) return '';
  const now = Date.now();
  const diff = now - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Дөнгөж сая';
  if (mins < 60) return `${mins} минутын өмнө`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} цагийн өмнө`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Өчигдөр';
  if (days < 7) return `${days} өдрийн өмнө`;
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

export default function ProjectsModal({ onClose }: { onClose: () => void }) {
  const currentProjectId = useEditor((s) => s.currentProjectId);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

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

  const handleOpen = async (id: string) => {
    if (id === currentProjectId) {
      onClose();
      return;
    }
    try {
      await switchToProject(id);
      onClose();
    } catch (e: any) {
      alert(e.message || 'Төслийг нээхэд алдаа гарлаа');
    }
  };

  const handleCreateNew = async () => {
    try {
      await createNewProject();
      onClose();
    } catch (e: any) {
      alert(e.message || 'Шинэ төсөл үүсгэхэд алдаа гарлаа');
    }
  };

  const handleDuplicate = async (id: string) => {
    setMenuOpenId(null);
    try {
      await duplicateProject(id);
      await loadList();
    } catch (e: any) {
      alert(e.message || 'Төсөл хувилахад алдаа гарлаа');
    }
  };

  const handleDelete = async (id: string, name: string) => {
    setMenuOpenId(null);
    if (!confirm(`"${name}" төслийг бүрмөсөн устгах уу?`)) return;
    try {
      await deleteProject(id);
      await loadList();
    } catch (e: any) {
      alert(e.message || 'Төсөл устгахад алдаа гарлаа');
    }
  };

  const handleStartRename = (p: ProjectMeta) => {
    setMenuOpenId(null);
    setRenamingId(p.id);
    setRenameText(p.name);
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

  const handleOpenFile = async () => {
    try {
      await openProject();
      onClose();
    } catch (e: any) {
      alert(e.message || 'Файл нээхэд алдаа гарлаа');
    }
  };

  const filtered = projects.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        className="modal-card"
        style={{
          width: '88vw',
          maxWidth: 960,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.7)',
          overflow: 'hidden'
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-0)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>📁</span>
            <div>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650, color: 'var(--text)' }}>
                Төслийн сан (Projects Library)
              </h2>
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                Өмнөх төслүүдээсээ шууд үргэлжлүүлэн ажиллах
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Search */}
            <div style={{ position: 'relative' }}>
              <input
                className="insp-input"
                style={{
                  width: 180,
                  padding: '5px 8px 5px 26px',
                  fontSize: 12,
                  borderRadius: 'var(--radius-sm)'
                }}
                placeholder="Төсөл хайх..."
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
                🔍
              </span>
            </div>

            <button
              type="button"
              className="btn"
              onClick={handleOpenFile}
              style={{ fontSize: 12, padding: '5px 10px', gap: 5 }}
              title="Компьютер дээрх .cutline файл нээх"
            >
              <Icon name="open" style={{ width: 14, height: 14 }} />
              Файлаас нээх
            </button>

            <button
              type="button"
              className="btn primary"
              onClick={handleCreateNew}
              style={{ fontSize: 12, padding: '5px 12px', gap: 5 }}
            >
              <span style={{ fontSize: 14, fontWeight: 'bold' }}>+</span>
              Шинэ төсөл
            </button>

            <button
              type="button"
              className="btn ghost icon-btn"
              onClick={onClose}
              style={{ padding: 6, marginLeft: 4 }}
              title="Хаах"
            >
              <Icon name="close" style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: 20,
            background: 'var(--bg-1)'
          }}
          onClick={() => menuOpenId && setMenuOpenId(null)}
        >
          {loading ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-dim)' }}>
              Төслүүдийг уншиж байна...
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
                gap: 16
              }}
            >
              {/* New Project Tile */}
              <div
                onClick={handleCreateNew}
                style={{
                  height: 190,
                  borderRadius: 'var(--radius)',
                  border: '2px dashed var(--border)',
                  background: 'rgba(255,255,255,0.02)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  gap: 10
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent)';
                  e.currentTarget.style.background = 'rgba(77, 124, 254, 0.06)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border)';
                  e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    background: 'var(--bg-3)',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 22,
                    color: 'var(--accent)',
                    fontWeight: 600
                  }}
                >
                  +
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                  Шинэ төсөл эхлүүлэх
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  Хоосон цагаан талбар
                </span>
              </div>

              {/* Project Cards */}
              {filtered.map((p) => {
                const isActive = p.id === currentProjectId;
                const coverUrl = !p.cover ? '' : (p.cover.startsWith('data:') || p.cover.startsWith('media:') || p.cover.startsWith('http')) ? p.cover : (window.api.toMediaUrl ? window.api.toMediaUrl(p.cover) : p.cover);

                return (
                  <div
                    key={p.id}
                    style={{
                      height: 190,
                      borderRadius: 'var(--radius)',
                      background: 'var(--bg-2)',
                      border: isActive ? '2px solid var(--accent)' : '1px solid var(--border)',
                      boxShadow: isActive ? '0 0 12px rgba(77, 124, 254, 0.35)' : 'none',
                      display: 'flex',
                      flexDirection: 'column',
                      overflow: 'hidden',
                      position: 'relative',
                      cursor: 'pointer',
                      transition: 'transform 0.12s, box-shadow 0.12s'
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.3)';
                        e.currentTarget.style.transform = 'translateY(-2px)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) {
                        e.currentTarget.style.borderColor = 'var(--border)';
                        e.currentTarget.style.transform = 'translateY(0)';
                      }
                    }}
                    onClick={() => handleOpen(p.id)}
                  >
                    {/* Thumbnail Cover (16:9) */}
                    <div
                      style={{
                        position: 'relative',
                        width: '100%',
                        height: 118,
                        background: '#15151c',
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                    >
                      {coverUrl ? (
                        <img
                          src={coverUrl}
                          alt=""
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover'
                          }}
                          draggable={false}
                        />
                      ) : (
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: 4,
                            opacity: 0.4
                          }}
                        >
                          <span style={{ fontSize: 26 }}>🎬</span>
                          <span style={{ fontSize: 10 }}>Cutline Project</span>
                        </div>
                      )}

                      {/* Active Tag */}
                      {isActive && (
                        <div
                          style={{
                            position: 'absolute',
                            left: 6,
                            top: 6,
                            background: 'var(--accent)',
                            color: '#fff',
                            fontSize: 9,
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 3,
                            boxShadow: '0 2px 6px rgba(0,0,0,0.5)'
                          }}
                        >
                          ИДЭВХТЭЙ
                        </div>
                      )}

                      {/* Duration Tag */}
                      <div
                        style={{
                          position: 'absolute',
                          right: 6,
                          bottom: 6,
                          background: 'rgba(0,0,0,0.75)',
                          color: '#fff',
                          fontSize: 10,
                          fontWeight: 600,
                          padding: '1px 5px',
                          borderRadius: 3
                        }}
                      >
                        {formatTime(p.duration || 0, false)}
                      </div>

                      {/* Hover Overlay with Open Button */}
                      <div
                        className="project-hover-overlay"
                        style={{
                          position: 'absolute',
                          inset: 0,
                          background: 'rgba(0,0,0,0.4)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          opacity: 0,
                          transition: 'opacity 0.15s'
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                        onMouseLeave={(e) => (e.currentTarget.style.opacity = '0')}
                      >
                        <button
                          type="button"
                          className="btn primary"
                          style={{ fontSize: 11, padding: '5px 14px', borderRadius: 20 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpen(p.id);
                          }}
                        >
                          {isActive ? 'Үргэлжлүүлэх' : 'Нээх'}
                        </button>
                      </div>
                    </div>

                    {/* Metadata Footer */}
                    <div
                      style={{
                        padding: '8px 10px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flex: 1,
                        background: 'var(--bg-2)'
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {renamingId === p.id ? (
                          <input
                            autoFocus
                            className="insp-input"
                            style={{ padding: '2px 6px', fontSize: 12, width: '90%' }}
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
                              fontSize: 12,
                              fontWeight: 600,
                              color: 'var(--text)',
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
                        <div
                          style={{
                            fontSize: 10,
                            color: 'var(--text-dim)',
                            marginTop: 2,
                            display: 'flex',
                            gap: 6
                          }}
                        >
                          <span>{formatRelativeDate(p.updatedAt)}</span>
                          <span>·</span>
                          <span>{p.clipCount || 0} клип</span>
                        </div>
                      </div>

                      {/* Options Menu Button */}
                      <div style={{ position: 'relative' }}>
                        <button
                          type="button"
                          className="btn ghost icon-btn"
                          style={{ padding: '2px 6px', fontSize: 14, color: 'var(--text-dim)' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenId(menuOpenId === p.id ? null : p.id);
                          }}
                          title="Цэс"
                        >
                          ⋮
                        </button>

                        {/* Dropdown Menu */}
                        {menuOpenId === p.id && (
                          <div
                            style={{
                              position: 'absolute',
                              right: 0,
                              bottom: 24,
                              background: 'var(--bg-3)',
                              border: '1px solid var(--border)',
                              borderRadius: 'var(--radius)',
                              boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                              zIndex: 100,
                              minWidth: 120,
                              padding: '4px 0',
                              display: 'flex',
                              flexDirection: 'column'
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              style={{
                                padding: '6px 12px',
                                fontSize: 11,
                                textAlign: 'left',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                color: 'var(--text)'
                              }}
                              onClick={() => handleStartRename(p)}
                            >
                              ✏️ Нэр солих
                            </button>
                            <button
                              type="button"
                              style={{
                                padding: '6px 12px',
                                fontSize: 11,
                                textAlign: 'left',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                color: 'var(--text)'
                              }}
                              onClick={() => handleDuplicate(p.id)}
                            >
                              📄 Хувилах
                            </button>
                            <hr
                              style={{
                                border: 'none',
                                borderTop: '1px solid var(--border)',
                                margin: '2px 0'
                              }}
                            />
                            <button
                              type="button"
                              style={{
                                padding: '6px 12px',
                                fontSize: 11,
                                textAlign: 'left',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                color: '#f87171'
                              }}
                              onClick={() => handleDelete(p.id, p.name)}
                            >
                              🗑️ Устгах
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
