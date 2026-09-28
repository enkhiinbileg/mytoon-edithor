import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../store';
import { Icon } from '../Icons';
import { formatTime } from '../util';
import { clipDuration, clipEnd } from '../types';

export interface ExportOptions {
  name: string;
  width: number;
  height: number;
  fps: number;
  quality: 'draft' | 'standard' | 'high';
  scope?: 'all' | 'selected';
  format?: 'mp4' | 'mov' | 'mp3' | 'wav' | 'aac';
  audioBitrate?: '128k' | '192k' | '320k';
  codec?: 'h264' | 'hevc' | 'hevc_alpha' | 'hevc_422' | 'av1' | 'rle';
  bitrateMode?: 'recommended' | 'higher' | 'lower' | 'custom' | 'cbr' | 'vbr';
  customBitrate?: number;
  outPath?: string;
  exportVideo?: boolean;
  signal?: AbortSignal;
  onPreparationProgress?: (completed: number, total: number) => void;
}

export interface CodecOption {
  id: 'h264' | 'hevc' | 'hevc_alpha' | 'hevc_422' | 'av1' | 'rle';
  name: string;
  description?: string;
}

export const CODEC_OPTIONS: CodecOption[] = [
  {
    id: 'h264',
    name: 'H.264',
    description: 'The most common compression method'
  },
  {
    id: 'hevc',
    name: 'HEVC',
    description: 'Efficient compression, saving space'
  },
  {
    id: 'hevc_alpha',
    name: 'HEVC (Alpha)'
  },
  {
    id: 'hevc_422',
    name: 'HEVC (422)'
  },
  {
    id: 'av1',
    name: 'AV1',
    description: 'Efficient compression and compatibility, saving space'
  },
  {
    id: 'rle',
    name: 'RLE',
    description: 'Supports alpha channel. Large export file.'
  }
];

export default function ExportDialog({
  onClose,
  onExport,
  initialScope = 'all',
  initialFormat = 'mp4'
}: {
  onClose: () => void;
  onExport: (o: ExportOptions) => Promise<{ ok: boolean; path?: string; error?: string } | void>;
  initialScope?: 'all' | 'selected';
  initialFormat?: 'mp4' | 'mp3';
}) {
  const s = useEditor.getState();

  // --- Selection and duration ---
  const targetIds = useMemo(() => {
    return s.selectedClipIds?.length ? s.selectedClipIds : (s.selectedClipId ? [s.selectedClipId] : []);
  }, [s.selectedClipIds, s.selectedClipId]);

  const selectedClips = useMemo(() => {
    return s.clips.filter((c) => targetIds.includes(c.id));
  }, [s.clips, targetIds]);

  const hasSelection = selectedClips.length > 0;

  const [scope, setScope] = useState<'all' | 'selected'>(
    hasSelection && initialScope === 'selected' ? 'selected' : (hasSelection && initialScope !== 'all' ? 'selected' : 'all')
  );

  const selectedDuration = useMemo(() => {
    if (!hasSelection) return 0;
    const minStart = Math.min(...selectedClips.map((c) => c.start));
    const maxEnd = Math.max(...selectedClips.map((c) => clipEnd(c)));
    return Math.max(0.1, maxEnd - minStart);
  }, [selectedClips, hasSelection]);

  const activeDuration = scope === 'selected' ? selectedDuration : s.duration();

  // --- Project Name & Destination ---
  const defaultBaseName = s.projectName || '0921';
  const [name, setName] = useState(
    scope === 'selected' ? `${defaultBaseName}_selection` : defaultBaseName
  );

  const [exportDir, setExportDir] = useState<string>('');
  useEffect(() => {
    window.api?.getDefaultExportDir?.().then((dir) => {
      if (dir) setExportDir(dir);
    }).catch(() => {});
  }, []);

  // --- Hardware Encoders ---
  const [detectedEncoders, setDetectedEncoders] = useState<{ h264?: string; hevc?: string; av1?: string }>({});
  useEffect(() => {
    window.api?.detectEncoders?.().then((encs) => {
      if (encs) setDetectedEncoders(encs);
    }).catch(() => {});
  }, []);

  // --- Video Settings (CapCut match) ---
  const [exportVideo, setExportVideo] = useState(initialFormat !== 'mp3');
  const [videoCollapsed, setVideoCollapsed] = useState(false);
  const [removeWatermark, setRemoveWatermark] = useState(true);
  const [resolution, setResolution] = useState<'480P' | '720P' | '1080P' | '2K' | '4K'>('1080P');
  const [bitrateOption, setBitrateOption] = useState<'recommended' | 'higher' | 'lower' | 'custom'>('custom');
  const [customBitrate, setCustomBitrate] = useState<number>(1000);
  const [bitrateType, setBitrateType] = useState<'cbr' | 'vbr'>('vbr');
  const [codec, setCodec] = useState<'h264' | 'hevc' | 'hevc_alpha' | 'hevc_422' | 'av1' | 'rle'>('hevc');
  const [isCodecOpen, setIsCodecOpen] = useState(false);
  const codecDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (codecDropdownRef.current && !codecDropdownRef.current.contains(event.target as Node)) {
        setIsCodecOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  const [format, setFormat] = useState<'mp4' | 'mov'>('mp4');
  const [fps, setFps] = useState<number>(s.projectSettings.fps || 30);

  // --- Audio Settings (CapCut match) ---
  const [exportAudio, setExportAudio] = useState(true);
  const [audioCollapsed, setAudioCollapsed] = useState(true);
  const [audioFormat, setAudioFormat] = useState<'mp3' | 'wav' | 'aac'>('mp3');
  const [audioBitrate, setAudioBitrate] = useState<'128k' | '192k' | '320k'>('192k');

  // --- Cover Thumbnail ---
  const [coverUrl, setCoverUrl] = useState<string>(() => {
    const firstMedia = s.media.find((m) => m.thumbs?.length);
    if (firstMedia?.thumbs?.[0]) return firstMedia.thumbs[0];
    return '';
  });
  const [showCoverModal, setShowCoverModal] = useState(false);

  // --- Dimension calculations maintaining project aspect ratio ---
  const projectAspect = (s.projectSettings.width || 1920) / (s.projectSettings.height || 1080);
  const dimensions = useMemo(() => {
    let targetH = 1080;
    if (resolution === '480P') targetH = 480;
    else if (resolution === '720P') targetH = 720;
    else if (resolution === '1080P') targetH = 1080;
    else if (resolution === '2K') targetH = 1440;
    else if (resolution === '4K') targetH = 2160;

    let w = Math.round(targetH * projectAspect / 2) * 2;
    let h = targetH;
    return { width: Math.max(16, w), height: Math.max(16, h) };
  }, [resolution, projectAspect]);

  // --- Estimated File Size Calculation ---
  const estimatedSizeText = useMemo(() => {
    let vKbps = 0;
    if (exportVideo) {
      if (bitrateOption === 'custom') {
        vKbps = Number(customBitrate) || 1000;
      } else {
        const base = resolution === '480P' ? 2000 : (resolution === '720P' ? 4000 : (resolution === '1080P' ? 8000 : (resolution === '2K' ? 14000 : 28000)));
        const fpsMultiplier = (fps || 30) / 30;
        const qualityMultiplier = bitrateOption === 'higher' ? 1.5 : (bitrateOption === 'lower' ? 0.6 : 1.0);
        vKbps = Math.round(base * fpsMultiplier * qualityMultiplier);
      }
    }

    let aKbps = 0;
    if (exportAudio) {
      aKbps = parseInt(audioBitrate) || 192;
    }

    const totalKbps = vKbps + aKbps;
    const totalBytes = (totalKbps * 1000 / 8) * activeDuration;
    const mb = totalBytes / (1024 * 1024);

    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(1)} GB`;
    }
    return `${Math.max(1, Math.round(mb))} MB`;
  }, [exportVideo, exportAudio, bitrateOption, customBitrate, resolution, fps, audioBitrate, activeDuration]);

  // --- Formatted Duration (e.g. 19m 57s) ---
  const durationText = useMemo(() => {
    const totalSec = Math.round(activeDuration);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
    return `${mins}m ${secs}s`;
  }, [activeDuration]);

  const displayBitrate = useMemo(() => {
    if (bitrateOption === 'custom') {
      return `${customBitrate}Kbps`;
    }
    if (bitrateOption === 'higher') return 'Higher';
    if (bitrateOption === 'lower') return 'Lower';
    return 'Recommended';
  }, [bitrateOption, customBitrate]);

  const displayCodec = useMemo(() => {
    const opt = CODEC_OPTIONS.find((o) => o.id === codec);
    return opt?.name || 'HEVC';
  }, [codec]);

  // --- Computed Destination File Path ---
  const activeExt = exportVideo ? format : audioFormat;
  const safeName = name.trim().replace(/[<>:"/\\|?*]/g, '_') || 'video';
  const fullExportPath = useMemo(() => {
    if (!exportDir) return `${safeName}.${activeExt}`;
    const cleanDir = exportDir.replace(/[\\/]+$/, '');
    return `${cleanDir}/${safeName}.${activeExt}`;
  }, [exportDir, safeName, activeExt]);

  // --- Folder Picker ---
  const handlePickFolder = async () => {
    try {
      const picked = await window.api.selectExportFolder(exportDir || undefined);
      if (picked) setExportDir(picked);
    } catch {}
  };

  // --- Export Execution & Live Progress ---
  const [phase, setPhase] = useState<'idle' | 'exporting' | 'completed' | 'error'>('idle');
  const [progress, setProgress] = useState<{ pct: number; speed?: string; fps?: number; remainingSec?: number; stage?: string; encoder?: string; completed?: number; total?: number }>({ pct: 0 });
  const exportAbort = useRef<AbortController | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [finalPath, setFinalPath] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const timerRef = useRef<any>(null);

  useEffect(() => {
    if (phase === 'exporting') {
      const start = Date.now();
      timerRef.current = setInterval(() => {
        setElapsedSec(Math.round((Date.now() - start) / 1000));
      }, 500);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase]);

  // Listen to live progress
  useEffect(() => {
    const unsub = window.api.onExportProgress((info) => {
      if (typeof info === 'number') {
        setProgress({ pct: info });
      } else if (info && typeof info === 'object') {
        setProgress(previous => ({ ...previous, ...info }));
      }
    });
    return () => unsub();
  }, []);

  const handleStartExport = async () => {
    if (!exportVideo && !exportAudio) {
      alert('Video эсвэл Audio-ийн дор хаяж нэгийг сонгоно уу.');
      return;
    }

    if (exportAbort.current) return;
    const controller = new AbortController();
    exportAbort.current = controller;
    setPhase('exporting');
    setProgress({ pct: 0, stage: 'prepare-captions' });
    setElapsedSec(0);
    setErrorMsg('');

    try {
      const mode = bitrateOption === 'custom' ? bitrateType : bitrateOption;
      const res = await onExport({
        name: safeName,
        width: dimensions.width,
        height: dimensions.height,
        fps,
        quality: bitrateOption === 'higher' ? 'high' : (bitrateOption === 'lower' ? 'draft' : 'standard'),
        scope,
        format: exportVideo ? format : audioFormat,
        audioBitrate,
        codec,
        bitrateMode: mode,
        customBitrate: bitrateOption === 'custom' ? customBitrate : undefined,
        outPath: fullExportPath,
        exportVideo,
        signal: controller.signal,
        onPreparationProgress: (completed, total) => {
          if (!controller.signal.aborted) setProgress({ pct: 0, stage: 'prepare-captions', completed, total });
        }
      });

      if (controller.signal.aborted) { setPhase('idle'); return; }

      if (res && !res.ok) {
        setPhase('error');
        setErrorMsg(res.error || 'Export failed.');
      } else {
        setPhase('completed');
        setFinalPath(res?.path || fullExportPath);
      }
    } catch (err: any) {
      if (controller.signal.aborted) { setPhase('idle'); return; }
      setPhase('error');
      setErrorMsg(err?.message || String(err));
    } finally {
      exportAbort.current = null;
    }
  };

  const handleCancelExport = async () => {
    exportAbort.current?.abort();
    try {
      await window.api.cancelExport();
    } catch {}
  };

  return (
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && phase !== 'exporting') onClose();
      }}
    >
      <section className="capcut-export-modal" role="dialog" aria-modal="true" aria-label="Export media">
        {/* Header */}
        <header className="capcut-export-header">
          <h2>Export-{safeName}</h2>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="Close export"
            style={{ color: '#aaa', fontSize: 16 }}
          >
            <Icon name="close" />
          </button>
        </header>

        {/* ===================== PHASE: IDLE (SETTINGS VIEW) ===================== */}
        {phase === 'idle' && (
          <>
            <div className="capcut-export-body">
              {/* Left Column: 16:9 Preview Card */}
              <div className="capcut-export-left">
                <div className="capcut-preview-card">
                  {coverUrl ? (
                    <img src={coverUrl} alt="Cover preview" className="capcut-preview-img" />
                  ) : (
                    <div className="capcut-preview-placeholder">
                      <Icon name="video" style={{ width: 44, height: 44, color: '#444' }} />
                    </div>
                  )}
                  <button
                    type="button"
                    className="capcut-edit-cover-btn"
                    onClick={() => setShowCoverModal(true)}
                    title="Edit project cover image"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                    </svg>
                    <span>Edit cover</span>
                  </button>
                </div>
              </div>

              {/* Right Column: Settings */}
              <div className="capcut-export-right">
                {/* Export timeline */}
                <div className="capcut-field-row">
                  <span className="capcut-field-label">Export timeline</span>
                  <select
                    className="capcut-select"
                    value={scope}
                    onChange={(e) => setScope(e.target.value as 'all' | 'selected')}
                  >
                    <option value="all">Timeline 01 ({formatTime(s.duration())})</option>
                    {hasSelection && (
                      <option value="selected">
                        Сонгосон клипүүд ({selectedClips.length} клип, {formatTime(selectedDuration)})
                      </option>
                    )}
                  </select>
                </div>

                {/* Name */}
                <div className="capcut-field-row">
                  <span className="capcut-field-label">Name</span>
                  <input
                    type="text"
                    className="capcut-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Project name"
                  />
                </div>

                {/* Export to */}
                <div className="capcut-field-row">
                  <span className="capcut-field-label">Export to</span>
                  <div style={{ display: 'flex', gap: 6, width: '100%' }}>
                    <input
                      type="text"
                      className="capcut-input"
                      value={fullExportPath}
                      readOnly
                      title={fullExportPath}
                      style={{ textOverflow: 'ellipsis' }}
                    />
                    <button
                      type="button"
                      className="capcut-folder-btn"
                      onClick={handlePickFolder}
                      title="Хавтас сонгох"
                    >
                      <Icon name="folder" style={{ width: 16, height: 16 }} />
                    </button>
                  </div>
                </div>

                {/* Section: Video */}
                <div className="capcut-section-block">
                  <div
                    className="capcut-accordion-header"
                    onClick={() => setVideoCollapsed(!videoCollapsed)}
                  >
                    <label
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', margin: 0 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={exportVideo}
                        onChange={(e) => setExportVideo(e.target.checked)}
                        className="capcut-checkbox"
                      />
                      <span style={{ fontWeight: 600, color: '#fff', fontSize: 13 }}>Video</span>
                    </label>
                    <span style={{ color: '#888', fontSize: 11, marginRight: 4 }}>
                      {videoCollapsed ? '▼' : '▲'}
                    </span>
                  </div>

                  {exportVideo && !videoCollapsed && (
                    <div className="capcut-section-content">
                      {/* Remove watermark */}
                      <div className="capcut-field-row">
                        <span className="capcut-field-label" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          Remove watermark
                          <span className="capcut-pro-gem" title="Pro Feature">💎</span>
                        </span>
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                          <label className="capcut-toggle-switch">
                            <input
                              type="checkbox"
                              checked={removeWatermark}
                              onChange={(e) => setRemoveWatermark(e.target.checked)}
                            />
                            <span className="capcut-toggle-slider" />
                          </label>
                        </div>
                      </div>

                      {/* Resolution */}
                      <div className="capcut-field-row">
                        <span className="capcut-field-label">Resolution</span>
                        <select
                          className="capcut-select"
                          value={resolution}
                          onChange={(e) => setResolution(e.target.value as any)}
                        >
                          <option value="480P">480P (SD)</option>
                          <option value="720P">720P (HD)</option>
                          <option value="1080P">1080P (Full HD)</option>
                          <option value="2K">2K (QHD)</option>
                          <option value="4K">4K (Ultra HD)</option>
                        </select>
                      </div>

                      {/* Bit rate */}
                      <div className="capcut-field-row">
                        <span className="capcut-field-label" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          Bit rate
                          <span style={{ cursor: 'help', color: '#777' }} title="Encoding bitrate mode">ⓘ</span>
                        </span>
                        <select
                          className="capcut-select"
                          value={bitrateOption}
                          onChange={(e) => setBitrateOption(e.target.value as any)}
                        >
                          <option value="recommended">Recommended</option>
                          <option value="higher">Higher</option>
                          <option value="lower">Lower</option>
                          <option value="custom">Custom</option>
                        </select>
                      </div>

                      {/* Custom Bitrate options (only when Custom selected) */}
                      {bitrateOption === 'custom' && (
                        <div style={{ marginLeft: 132, display: 'flex', flexDirection: 'column', gap: 10, marginTop: -4 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <input
                              type="number"
                              min="200"
                              max="100000"
                              step="100"
                              className="capcut-input"
                              style={{ width: 140 }}
                              value={customBitrate}
                              onChange={(e) => setCustomBitrate(Number(e.target.value))}
                            />
                            <span style={{ color: '#888', fontSize: 12.5 }}>Kbps</span>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
                            <label className="capcut-radio-label">
                              <input
                                type="radio"
                                name="bitrateType"
                                value="cbr"
                                checked={bitrateType === 'cbr'}
                                onChange={() => setBitrateType('cbr')}
                              />
                              <span>CBR (Static Bit Rate)</span>
                            </label>
                            <label className="capcut-radio-label">
                              <input
                                type="radio"
                                name="bitrateType"
                                value="vbr"
                                checked={bitrateType === 'vbr'}
                                onChange={() => setBitrateType('vbr')}
                              />
                              <span>VBR (Variable Bit Rate)</span>
                            </label>
                          </div>
                        </div>
                      )}

                      {/* Codec */}
                      <div className="capcut-field-row" style={{ position: 'relative' }}>
                        <span className="capcut-field-label">Codec</span>
                        <div className="capcut-custom-select-wrapper" ref={codecDropdownRef}>
                          <button
                            type="button"
                            className="capcut-custom-select-trigger"
                            onClick={() => setIsCodecOpen(!isCodecOpen)}
                          >
                            <span>{displayCodec}</span>
                            <span className="capcut-select-arrow">{isCodecOpen ? '▲' : '▼'}</span>
                          </button>
                          {isCodecOpen && (
                            <div className="capcut-codec-popover">
                              {CODEC_OPTIONS.map((opt) => {
                                const isSelected = codec === opt.id;
                                return (
                                  <div
                                    key={opt.id}
                                    className={`capcut-codec-option ${isSelected ? 'selected' : ''}`}
                                    onClick={() => {
                                      setCodec(opt.id);
                                      if (opt.id === 'rle') {
                                        setFormat('mov');
                                      }
                                      setIsCodecOpen(false);
                                    }}
                                  >
                                    <div className="capcut-codec-left">
                                      <span className="capcut-codec-check">
                                        {isSelected ? (
                                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00e5be" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="20 6 9 17 4 12" />
                                          </svg>
                                        ) : null}
                                      </span>
                                      <div className="capcut-codec-text">
                                        <div className="capcut-codec-title">{opt.name}</div>
                                        {opt.description && (
                                          <div className="capcut-codec-desc">{opt.description}</div>
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

                      {/* Format */}
                      <div className="capcut-field-row">
                        <span className="capcut-field-label">Acceleration</span>
                        <span style={{ color: '#00d5c5', fontSize: 13 }}>
                          {(() => {
                            const encoder = detectedEncoders[codec.startsWith('hevc') ? 'hevc' : codec === 'av1' ? 'av1' : 'h264'];
                            if (codec === 'rle') return 'CPU';
                            return encoder?.includes('nvenc') ? 'NVIDIA GPU' : encoder?.includes('qsv') ? 'Intel GPU' : encoder?.includes('amf') ? 'AMD GPU' : encoder ? 'CPU' : 'Шалгаж байна…';
                          })()}
                        </span>
                      </div>
                      <div className="capcut-field-row">
                        <span className="capcut-field-label">Format</span>
                        <select
                          className="capcut-select"
                          value={format}
                          onChange={(e) => setFormat(e.target.value as any)}
                        >
                          <option value="mp4">mp4</option>
                          <option value="mov">mov</option>
                        </select>
                      </div>

                      {/* Frame rate */}
                      <div className="capcut-field-row">
                        <span className="capcut-field-label">Frame rate</span>
                        <select
                          className="capcut-select"
                          value={fps}
                          onChange={(e) => setFps(Number(e.target.value))}
                        >
                          <option value={24}>24fps</option>
                          <option value={25}>25fps</option>
                          <option value={30}>30fps</option>
                          <option value={50}>50fps</option>
                          <option value={60}>60fps</option>
                        </select>
                      </div>

                      {/* Color space */}
                      <div className="capcut-field-row">
                        <span className="capcut-field-label">Color space</span>
                        <span style={{ color: '#888', fontSize: 12.5, paddingLeft: 2 }}>Rec. 709 SDR</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Section: Audio */}
                <div className="capcut-section-block">
                  <div
                    className="capcut-accordion-header"
                    onClick={() => setAudioCollapsed(!audioCollapsed)}
                  >
                    <label
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', margin: 0 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={exportAudio}
                        onChange={(e) => setExportAudio(e.target.checked)}
                        className="capcut-checkbox"
                      />
                      <span style={{ fontWeight: 600, color: '#fff', fontSize: 13 }}>Audio</span>
                    </label>
                    <span style={{ color: '#888', fontSize: 11, marginRight: 4 }}>
                      {audioCollapsed ? '▼' : '▲'}
                    </span>
                  </div>

                  {exportAudio && !audioCollapsed && (
                    <div className="capcut-section-content">
                      <div className="capcut-field-row">
                        <span className="capcut-field-label">Format</span>
                        <select
                          className="capcut-select"
                          value={audioFormat}
                          onChange={(e) => setAudioFormat(e.target.value as any)}
                        >
                          <option value="mp3">MP3</option>
                          <option value="wav">WAV</option>
                          <option value="aac">AAC</option>
                        </select>
                      </div>
                      <div className="capcut-field-row">
                        <span className="capcut-field-label">Bit rate</span>
                        <select
                          className="capcut-select"
                          value={audioBitrate}
                          onChange={(e) => setAudioBitrate(e.target.value as any)}
                        >
                          <option value="128k">128 kbps (Standard)</option>
                          <option value="192k">192 kbps (High Quality)</option>
                          <option value="320k">320 kbps (Studio Master)</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <footer className="capcut-export-footer">
              <div className="capcut-footer-info">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                  <line x1="7" y1="2" x2="7" y2="22" />
                  <line x1="17" y1="2" x2="17" y2="22" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <line x1="2" y1="7" x2="7" y2="7" />
                  <line x1="2" y1="17" x2="7" y2="17" />
                  <line x1="17" y1="17" x2="22" y2="17" />
                  <line x1="17" y1="7" x2="22" y2="7" />
                </svg>
                <span>Duration: {durationText} | Size: about {estimatedSizeText}</span>
              </div>
              <div className="capcut-footer-actions">
                <button
                  type="button"
                  className="capcut-btn-export"
                  onClick={handleStartExport}
                >
                  Export
                </button>
                <button
                  type="button"
                  className="capcut-btn-cancel"
                  onClick={onClose}
                >
                  Cancel
                </button>
              </div>
            </footer>
          </>
        )}

        {/* ===================== PHASE: EXPORTING (MATCHING CAPCUT DESKTOP) ===================== */}
        {phase === 'exporting' && (
          <>
            <div className="capcut-export-body">
              {/* Left Column: 16:9 Cover preview */}
              <div className="capcut-export-left">
                <div className="capcut-preview-card">
                  {coverUrl ? (
                    <img src={coverUrl} alt="Cover preview" className="capcut-preview-img" />
                  ) : (
                    <div className="capcut-preview-placeholder">
                      <Icon name="video" style={{ width: 44, height: 44, color: '#444' }} />
                    </div>
                  )}
                </div>
              </div>

              {/* Right Column: Exporting heading, Meta Table, Pro Banner */}
              <div className="capcut-exporting-right">
                <div className="capcut-exporting-head">
                  <h3 className="capcut-exporting-title">Exporting</h3>
                  <div
                    className="capcut-exporting-status"
                    title={progress.speed ? `Speed: ${progress.speed} | FPS: ${progress.fps ?? '-'} | Remaining: ${progress.remainingSec ?? '-'}s` : undefined}
                  >
                      <span>{progress.stage === 'prepare-captions' ? `Хадмал бэлдэж байна${progress.total ? ` · ${progress.completed ?? 0}/${progress.total}` : '…'}` : progress.stage === 'mux-audio' ? 'Дуу нэгтгэж, файл бэлдэж байна' : progress.stage === 'prepare-video' ? 'Дүрс бэлдэж байна' : 'Дүрс боловсруулж байна'}{progress.speed ? ` · ${progress.speed}` : ''}</span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.7 }}>
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                  </div>
                </div>

                {/* Metadata summary list */}
                <div className="capcut-meta-table">
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Video Name:</span>
                    <span className="capcut-meta-val">{safeName}</span>
                  </div>
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Duration:</span>
                    <span className="capcut-meta-val">{durationText}</span>
                  </div>
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Size:</span>
                    <span className="capcut-meta-val">{estimatedSizeText}(Estimated)</span>
                  </div>
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Resolution:</span>
                    <span className="capcut-meta-val">{resolution}</span>
                  </div>
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Bitrate:</span>
                    <span className="capcut-meta-val">{displayBitrate}</span>
                  </div>
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Codec:</span>
                    <span className="capcut-meta-val">{displayCodec}</span>
                  </div>
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Format:</span>
                    <span className="capcut-meta-val">{format}</span>
                  </div>
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Color space:</span>
                    <span className="capcut-meta-val">Rec. 709 SDR</span>
                  </div>
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Frame rate:</span>
                    <span className="capcut-meta-val">{fps}fps</span>
                  </div>
                </div>

                {/* Pro Subscription Banner */}
                <div className="capcut-pro-banner">
                  <div className="capcut-pro-top">
                    <div className="capcut-pro-title-wrap">
                      <span className="capcut-pro-badge">💎 Pro</span>
                      <span className="capcut-pro-heading">Unlock 80+ premium features with Pro</span>
                    </div>
                    <button type="button" className="capcut-btn-subscribe">
                      Subscribe
                    </button>
                  </div>
                  <div className="capcut-pro-features">
                    <div className="capcut-pro-feature-item">
                      <div className="capcut-pro-feature-icon">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <rect x="2" y="5" width="20" height="14" rx="3" />
                          <path d="M7 15h3M14 15h3M7 11h10" />
                        </svg>
                      </div>
                      <span>Auto captions</span>
                    </div>
                    <div className="capcut-pro-feature-item">
                      <div className="capcut-pro-feature-icon">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M12 2l2.4 5 5.6.8-4 4 1 5.6-5-2.8-5 2.8 1-5.6-4-4 5.6-.8z" />
                        </svg>
                      </div>
                      <span>AI tools</span>
                    </div>
                    <div className="capcut-pro-feature-item">
                      <div className="capcut-pro-feature-icon">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                          <line x1="12" y1="19" x2="12" y2="22" />
                        </svg>
                      </div>
                      <span>Isolate voice</span>
                    </div>
                    <div className="capcut-pro-feature-item">
                      <div className="capcut-pro-feature-icon">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                      </div>
                      <span>Quality assets</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom Bar: Percentage, Sleek Cyan Progress Bar, Back to home & Cancel buttons */}
            <footer className="capcut-exporting-footer">
              <div className="capcut-exporting-pct">
                {Number(progress.pct || 0).toFixed(1)}%
              </div>
              <div className="capcut-exporting-track">
                <div
                  className="capcut-exporting-fill"
                  style={{ width: `${Math.min(100, Math.max(0, progress.pct || 0))}%` }}
                />
              </div>
              <div className="capcut-exporting-actions">
                <button
                  type="button"
                  className="capcut-btn-back-home"
                  onClick={onClose}
                  title="Буцах (Экспорт ард үргэлжилнэ)"
                >
                  Back to home
                </button>
                <button
                  type="button"
                  className="capcut-btn-cancel-dark"
                  onClick={handleCancelExport}
                >
                  Cancel
                </button>
              </div>
            </footer>
          </>
        )}

        {/* ===================== PHASE: COMPLETED (SUCCESS VIEW) ===================== */}
        {phase === 'completed' && (
          <>
            <div className="capcut-export-body">
              {/* Left Column */}
              <div className="capcut-export-left">
                <div className="capcut-preview-card">
                  {coverUrl ? (
                    <img src={coverUrl} alt="Cover preview" className="capcut-preview-img" />
                  ) : (
                    <div className="capcut-preview-placeholder">
                      <Icon name="video" style={{ width: 44, height: 44, color: '#444' }} />
                    </div>
                  )}
                </div>
              </div>

              {/* Right Column */}
              <div className="capcut-exporting-right">
                <div className="capcut-exporting-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00c4cc" strokeWidth="2.5">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    <h3 className="capcut-exporting-title" style={{ margin: 0 }}>Export completed</h3>
                  </div>
                </div>

                <div className="capcut-meta-table">
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Video Name:</span>
                    <span className="capcut-meta-val">{safeName}</span>
                  </div>
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Duration:</span>
                    <span className="capcut-meta-val">{durationText}</span>
                  </div>
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Resolution:</span>
                    <span className="capcut-meta-val">{resolution}</span>
                  </div>
                  <div className="capcut-meta-row">
                    <span className="capcut-meta-label">Saved to:</span>
                    <span className="capcut-meta-val" style={{ wordBreak: 'break-all', color: '#00c4cc' }} title={finalPath}>
                      {finalPath}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
                  <button
                    type="button"
                    className="capcut-btn-action"
                    onClick={() => window.api.showItemInFolder(finalPath)}
                  >
                    <Icon name="folder" style={{ width: 15, height: 15 }} />
                    <span>Open folder</span>
                  </button>
                  <button
                    type="button"
                    className="capcut-btn-action"
                    onClick={() => window.api.openExportPath(finalPath)}
                  >
                    <Icon name="play" style={{ width: 15, height: 15 }} />
                    <span>Play</span>
                  </button>
                </div>
              </div>
            </div>

            <footer className="capcut-exporting-footer">
              <div className="capcut-exporting-pct" style={{ color: '#00c4cc' }}>
                100.0%
              </div>
              <div className="capcut-exporting-track">
                <div className="capcut-exporting-fill" style={{ width: '100%' }} />
              </div>
              <div className="capcut-exporting-actions">
                <button
                  type="button"
                  className="capcut-btn-back-home"
                  onClick={onClose}
                >
                  Complete
                </button>
              </div>
            </footer>
          </>
        )}

        {/* ===================== PHASE: ERROR ===================== */}
        {phase === 'error' && (
          <div className="capcut-progress-view">
            <div className="capcut-progress-box" style={{ maxWidth: 520 }}>
              <div className="capcut-error-icon">⚠️</div>
              <h3 style={{ fontSize: 17, margin: '12px 0 6px', color: '#ff6b6b' }}>Экспорт амжилтгүй боллоо</h3>
              <div className="capcut-error-box">
                {errorMsg}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                <button
                  type="button"
                  className="capcut-btn-export"
                  onClick={() => setPhase('idle')}
                >
                  Дахин оролдох
                </button>
                <button
                  type="button"
                  className="capcut-btn-cancel"
                  onClick={onClose}
                >
                  Хаах
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Cover selector submodal */}
        {showCoverModal && (
          <div className="modal-backdrop" style={{ zIndex: 70 }} onClick={() => setShowCoverModal(false)}>
            <div
              className="capcut-cover-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <h3>Ковер зураг сонгох</h3>
              <p style={{ color: '#888', fontSize: 12 }}>Төслийн клипүүдээс эсвэл шинэ зураг сонгоно уу:</p>
              <div className="capcut-cover-grid">
                {s.media.filter((m) => m.thumbs?.length).map((m) => (
                  <div
                    key={m.id}
                    className="capcut-cover-thumb"
                    onClick={() => {
                      if (m.thumbs?.[0]) setCoverUrl(m.thumbs[0]);
                      setShowCoverModal(false);
                    }}
                  >
                    <img src={m.thumbs[0]} alt={m.name} />
                    <span className="thumb-name">{m.name}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 15 }}>
                <button
                  type="button"
                  className="capcut-btn-cancel"
                  onClick={() => setShowCoverModal(false)}
                >
                  Болих
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
