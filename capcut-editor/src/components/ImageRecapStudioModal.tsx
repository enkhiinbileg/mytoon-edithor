import React, { useState, useEffect, useRef } from 'react';
import { useEditor } from '../store';
import type { ImagePanelItem, ImagePlanRow } from '../types';
import { applyImagePlanToTimeline, createInstantImagePlan } from '../utils/imageMotion';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccessNotice?: (msg: string) => void;
}

const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;

export default function ImageRecapStudioModal({ isOpen, onClose, onSuccessNotice }: Props) {
  // Audio state
  const [audioPath, setAudioPath] = useState<string>('');
  const [audioName, setAudioName] = useState<string>('');
  const [audioDuration, setAudioDuration] = useState<number>(0);

  // Subtitle state
  const [subtitles, setSubtitles] = useState<{ id: string; start: number; end: number; text: string }[]>([]);
  const [subFileName, setSubFileName] = useState<string>('');

  // Image panels state
  const [panels, setPanels] = useState<ImagePanelItem[]>([]);
  const [rawPickedPaths, setRawPickedPaths] = useState<string[]>([]);
  const [sliceMode, setSliceMode] = useState<'none' | 'smart'>('none');

  // Settings
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16'>('16:9');
  const [fitMode, setFitMode] = useState<'contain' | 'cover'>('contain');
  const [distribution, setDistribution] = useState<'spread' | 'sequential'>('spread');
  const [motionPreset, setMotionPreset] = useState<'variety' | 'action' | 'scroll' | 'static'>('variety');
  const [includeCaptions, setIncludeCaptions] = useState<boolean>(true);

  // Storyboard Plan
  const [plan, setPlan] = useState<ImagePlanRow[]>([]);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  // Dedicated Picker Modal for a specific row
  const [pickingForRow, setPickingForRow] = useState<ImagePlanRow | null>(null);

  // Selection View Mode ('filmstrip', 'reader', 'grid')
  const [panelViewMode, setPanelViewMode] = useState<'filmstrip' | 'reader' | 'grid'>('filmstrip');
  const [storySegment, setStorySegment] = useState<'all' | 'start' | 'mid' | 'end'>('all');
  const [filmstripOffset, setFilmstripOffset] = useState<number>(0);
  const [autoAdvance, setAutoAdvance] = useState<boolean>(false);
  const [hoveredPanel, setHoveredPanel] = useState<ImagePanelItem | null>(null);
  const [searchPanelNum, setSearchPanelNum] = useState<string>('');
  const [galleryZoom, setGalleryZoom] = useState<'small' | 'medium' | 'large'>('medium');

  // NEW: Card width slider for Filmstrip (140px to 380px)
  const [filmstripCardWidth, setFilmstripCardWidth] = useState<number>(200);

  // NEW: HD Zoom & Pan Lightbox Inspector
  const [zoomedPanel, setZoomedPanel] = useState<ImagePanelItem | null>(null);
  const [zoomScale, setZoomScale] = useState<number>(1.0);
  const [zoomPan, setZoomPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // UI status
  const [busy, setBusy] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [recentUpdatedRowId, setRecentUpdatedRowId] = useState<string | null>(null);

  // Audio row preview
  const [playingRowId, setPlayingRowId] = useState<string | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  // 1. Initial Timeline Auto-Detect
  useEffect(() => {
    if (!isOpen) return;

    const store = useEditor.getState();

    // Auto-detect Audio from timeline
    const aTrack = store.tracks.find((t) => t.kind === 'audio');
    const aClips = aTrack
      ? store.clips.filter((c) => c.trackId === aTrack.id && c.kind === 'av').sort((a, b) => a.start - b.start)
      : [];
    if (aClips.length > 0) {
      const firstAClip = aClips[0];
      const aMedia = store.media.find((m) => m.id === firstAClip.mediaId);
      if (aMedia) {
        setAudioPath(aMedia.path);
        setAudioName(aMedia.name || aMedia.path.split(/[\\/]/).pop() || '');
        const maxEnd = aClips.reduce((acc, c) => Math.max(acc, c.start + (c.outPoint - c.inPoint)), 0);
        setAudioDuration(maxEnd);
      }
    }

    // Auto-detect Subtitles from timeline
    const textClips = store.clips
      .filter((c) => c.kind === 'text' && c.style && c.style.text && c.style.text.trim())
      .sort((a, b) => a.start - b.start);
    if (textClips.length > 0) {
      const parsed = textClips.map((c, idx) => ({
        id: c.id || `sub_${idx}`,
        start: c.start,
        end: c.start + Math.max(0.2, c.outPoint - c.inPoint),
        text: c.style!.text.trim()
      }));
      setSubtitles(parsed);
      setSubFileName(`Timeline-аас (${parsed.length} мөр)`);
    }

    // Auto-detect already imported panels if available
    const existingImageMedia = store.media.filter((m) => m.kind === 'image');
    if (existingImageMedia.length > 0 && panels.length === 0) {
      const existingPanels: ImagePanelItem[] = existingImageMedia.map((m, idx) => ({
        id: m.id || `panel_${idx}`,
        name: m.name || `image_${idx + 1}`,
        path: m.path,
        width: m.width || 1920,
        height: m.height || 1080
      }));
      setPanels(existingPanels);
      setRawPickedPaths(existingPanels.map((p) => p.path));
    }
  }, [isOpen]);

  // 2. Automatically generate the Storyboard plan whenever subtitles or panels change!
  useEffect(() => {
    if (subtitles.length > 0 && panels.length > 0 && plan.length === 0) {
      const initialPlan = createInstantImagePlan({
        subtitles,
        panels,
        audioDuration,
        aspect: aspectRatio,
        distribution,
        motionPreset
      });
      setPlan(initialPlan);
      if (initialPlan[0]) setSelectedRowId(initialPlan[0].id);
    }
  }, [subtitles, panels, audioDuration, aspectRatio, distribution, motionPreset, plan.length]);

  // Sync filmstrip position whenever selected row changes
  // Keep filmstrip centered when active sentence changes
  useEffect(() => {
    if (!selectedRowId || !panels.length || !plan.length) return;
    const curRow = plan.find((r) => r.id === selectedRowId);
    if (curRow) {
      const pIdx = panels.findIndex((p) => p.id === curRow.panelId || p.path === curRow.imagePath);
      if (pIdx >= 0) {
        setFilmstripOffset(pIdx);
      }
    }
  }, [selectedRowId, panels.length]);

  // Cleanup audio preview on close
  useEffect(() => {
    return () => {
      audioPlayerRef.current?.pause();
    };
  }, []);

  if (!isOpen) return null;

  const activeRow = plan.find((r) => r.id === selectedRowId) || plan[0];
  const activePanelIndex = activeRow
    ? panels.findIndex((p) => p.id === activeRow.panelId || p.path === activeRow.imagePath)
    : 0;

  // Expected chronological panel for active sentence
  const curSentenceIdx = plan.findIndex((r) => r.id === activeRow?.id);
  const expectedStoryIdx = Math.max(
    0,
    Math.min(panels.length - 1, Math.floor((Math.max(0, curSentenceIdx) / Math.max(1, plan.length - 1)) * panels.length))
  );

  // Audio row preview
  const handlePlayRow = (row: ImagePlanRow) => {
    if (!audioPath) return;
    if (playingRowId === row.id) {
      audioPlayerRef.current?.pause();
      setPlayingRowId(null);
      return;
    }

    if (!audioPlayerRef.current) {
      audioPlayerRef.current = new Audio();
      const mediaUrl = window.api.toMediaUrl ? window.api.toMediaUrl(audioPath) : audioPath;
      audioPlayerRef.current.src = mediaUrl;
    }

    const audio = audioPlayerRef.current;
    audio.currentTime = row.start;
    audio.play().catch(() => {});
    setPlayingRowId(row.id);

    const checkStop = () => {
      if (audio.currentTime >= row.end || audio.paused) {
        audio.pause();
        setPlayingRowId(null);
        audio.removeEventListener('timeupdate', checkStop);
      }
    };
    audio.addEventListener('timeupdate', checkStop);
  };

  // Re-load panels with chosen Slice Mode ('none' = whole images, 'smart' = gutter slice)
  const handleReloadWithSliceMode = async (newMode: 'none' | 'smart') => {
    setSliceMode(newMode);
    if (!rawPickedPaths.length) return;

    try {
      setBusy(true);
      setStatusMsg(newMode === 'none' ? 'Зургуудыг бүтнээр нь (зүсэхгүй) бэлтгэж байна...' : 'Цэвэр зайгаар кадруудыг зүсэж байна...');
      const prep = await window.api.prepareImagePanels(rawPickedPaths, { sliceMode: newMode });
      if (prep && prep.ok && prep.panels && prep.panels.length > 0) {
        setPanels(prep.panels);
        setStatusMsg(`✓ ${prep.panels.length} зураг бэлэн боллоо (${newMode === 'none' ? 'Бүтэн зургаар' : 'Цэвэр кадруудаар'}).`);

        if (subtitles.length > 0) {
          const updated = createInstantImagePlan({
            subtitles,
            panels: prep.panels,
            audioDuration,
            aspect: aspectRatio,
            distribution,
            motionPreset
          });
          setPlan(updated);
          if (updated[0]) setSelectedRowId(updated[0].id);
        }
      }
    } catch (e: any) {
      setErrorMsg(`Алдаа: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  // Pick Images / Folder
  const handlePickImages = async (mode: 'files' | 'folder') => {
    try {
      setBusy(true);
      setErrorMsg('');
      setStatusMsg('Зургуудыг сонгож байна...');

      const picked = await window.api.openImagesOrFolder(mode);
      if (!picked || !picked.length) {
        setStatusMsg('');
        setBusy(false);
        return;
      }

      setRawPickedPaths(picked);
      setStatusMsg('Зургуудыг бэлтгэж байна...');

      const prep = await window.api.prepareImagePanels(picked, { sliceMode });

      if (prep && prep.ok && prep.panels && prep.panels.length > 0) {
        setPanels(prep.panels);
        setStatusMsg(`✓ Нийт ${prep.panels.length} зураг бэлэн боллоо.`);

        if (subtitles.length > 0) {
          const instantPlan = createInstantImagePlan({
            subtitles,
            panels: prep.panels,
            audioDuration,
            aspect: aspectRatio,
            distribution,
            motionPreset
          });
          setPlan(instantPlan);
          if (instantPlan[0]) setSelectedRowId(instantPlan[0].id);
        }
      } else {
        setErrorMsg(prep?.error || 'Зургуудыг боловсруулж чадсангүй.');
      }
    } catch (e: any) {
      setErrorMsg(`Зураг боловсруулахад алдаа: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  // Reset all sequence cleanly in chronological order from #1 to #End
  const handleResetChronologicalDistribution = () => {
    if (!subtitles.length || !panels.length) return;
    const fresh = createInstantImagePlan({
      subtitles,
      panels,
      audioDuration,
      aspect: aspectRatio,
      distribution: 'spread',
      motionPreset
    });
    setPlan(fresh);
    if (fresh[0]) setSelectedRowId(fresh[0].id);
    setStatusMsg(`✓ Бүх ${fresh.length} өгүүлбэрт ${panels.length} зургийг зохиолын дарааллаар нь 1-ээс эхлэн цэгцтэй дахин тараалаа!`);
  };

  // Explicit function to assign panel to a target row ID
  const assignPanelToTargetRow = (targetRowId: string, panel: ImagePanelItem) => {
    if (!targetRowId || !panel) return;

    setPlan((prev) =>
      prev.map((r) =>
        r.id === targetRowId
          ? {
              ...r,
              panelId: panel.id,
              imagePath: panel.path,
              imageWidth: panel.width,
              imageHeight: panel.height,
              imageName: panel.name
            }
          : r
      )
    );

    // Keep filmstrip centered on selected panel
    const pIdx = panels.findIndex((x) => x.id === panel.id);
    if (pIdx >= 0) {
      setFilmstripOffset(pIdx);
    }

    // Flash visual feedback on this row
    setRecentUpdatedRowId(targetRowId);
    setTimeout(() => setRecentUpdatedRowId(null), 1200);

    // If picking via modal popup, close it
    setPickingForRow(null);
    setZoomedPanel(null);

    // Auto-advance if enabled
    if (autoAdvance) {
      const curIdx = plan.findIndex((r) => r.id === targetRowId);
      if (curIdx >= 0 && curIdx < plan.length - 1) {
        setSelectedRowId(plan[curIdx + 1].id);
      }
    }
  };

  // Assign panel to currently active row
  const handleAssignPanel = (panel: ImagePanelItem) => {
    const targetId = selectedRowId || plan[0]?.id;
    if (!targetId) return;
    assignPanelToTargetRow(targetId, panel);
  };

  // Step panel forward or backward for a specific row
  const handleStepPanel = (rowId: string, direction: -1 | 1) => {
    if (!panels.length) return;
    setSelectedRowId(rowId);

    setPlan((prev) =>
      prev.map((r) => {
        if (r.id !== rowId) return r;
        let curIdx = panels.findIndex((p) => p.id === r.panelId || p.path === r.imagePath);
        if (curIdx === -1) curIdx = 0;
        const nextIdx = Math.max(0, Math.min(panels.length - 1, curIdx + direction));
        setFilmstripOffset(nextIdx);
        const newPanel = panels[nextIdx];
        if (!newPanel) return r;
        return {
          ...r,
          panelId: newPanel.id,
          imagePath: newPanel.path,
          imageWidth: newPanel.width,
          imageHeight: newPanel.height,
          imageName: newPanel.name
        };
      })
    );

    setRecentUpdatedRowId(rowId);
    setTimeout(() => setRecentUpdatedRowId(null), 800);
  };

  // Jump to specific panel number directly
  const handleSetPanelByNumber = (rowId: string, num: number) => {
    setSelectedRowId(rowId);
    const targetIdx = Math.max(0, Math.min(panels.length - 1, num - 1));
    const targetPanel = panels[targetIdx];
    if (!targetPanel) return;
    assignPanelToTargetRow(rowId, targetPanel);
  };

  // 1-Click Framing Focus
  const handleSetRowFocus = (rowId: string, focus: 'top' | 'center' | 'bottom') => {
    setSelectedRowId(rowId);
    setPlan((prev) =>
      prev.map((r) => {
        if (r.id !== rowId) return r;
        const dur = Math.max(0.1, r.duration);
        let yStart = 0.5;
        let yEnd = 0.5;

        if (focus === 'top') {
          yStart = 0.32;
          yEnd = 0.38;
        } else if (focus === 'bottom') {
          yStart = 0.65;
          yEnd = 0.68;
        } else {
          yStart = 0.5;
          yEnd = 0.5;
        }

        const kfs = [
          { id: Math.random().toString(36).slice(2, 8), time: 0, scale: 1.1, x: 0.5, y: yStart },
          { id: Math.random().toString(36).slice(2, 8), time: dur, scale: 1.15, x: 0.5, y: yEnd }
        ];

        return { ...r, keyframes: kfs };
      })
    );
  };

  // Split a sentence row into 2 cuts
  const handleSplitRow = (rowId: string) => {
    setPlan((prev) => {
      const idx = prev.findIndex((r) => r.id === rowId);
      if (idx === -1) return prev;
      const target = prev[idx];
      if (target.duration < 0.6) return prev;

      const mid = target.start + target.duration / 2;
      const part1: ImagePlanRow = {
        ...target,
        end: mid,
        duration: mid - target.start
      };

      const curPanelIdx = panels.findIndex((p) => p.id === target.panelId || p.path === target.imagePath);
      const nextPanel = panels[Math.min(panels.length - 1, (curPanelIdx >= 0 ? curPanelIdx : 0) + 1)] || panels[0];

      const part2: ImagePlanRow = {
        ...target,
        id: Math.random().toString(36).slice(2, 9),
        start: mid,
        duration: target.end - mid,
        panelId: nextPanel.id,
        imagePath: nextPanel.path,
        imageWidth: nextPanel.width,
        imageHeight: nextPanel.height,
        imageName: nextPanel.name
      };

      const copy = [...prev];
      copy.splice(idx, 1, part1, part2);
      return copy;
    });
  };

  // Re-generate distribution
  const handleDistributionChange = (mode: 'spread' | 'sequential') => {
    setDistribution(mode);
    if (subtitles.length && panels.length) {
      const updated = createInstantImagePlan({
        subtitles,
        panels,
        audioDuration,
        aspect: aspectRatio,
        distribution: mode,
        motionPreset
      });
      setPlan(updated);
    }
  };

  // Motion Preset change
  const handleMotionPresetChange = (preset: 'variety' | 'action' | 'scroll' | 'static') => {
    setMotionPreset(preset);
    setPlan((prev) =>
      prev.map((r, idx) => {
        let motion: ImagePlanRow['motion'] = 'zoom_in';
        if (preset === 'action') motion = 'zoom_in';
        else if (preset === 'scroll') motion = 'pan_down';
        else if (preset === 'static') motion = 'static';
        else {
          const types: ImagePlanRow['motion'][] = ['zoom_in', 'pan_down', 'zoom_out'];
          motion = types[idx % types.length];
        }

        const dur = Math.max(0.1, r.duration);
        let kfs = [{ id: Math.random().toString(36).slice(2, 8), time: 0, scale: 1.0, x: 0.5, y: 0.5 }];
        if (motion === 'zoom_in') {
          kfs = [
            { id: Math.random().toString(36).slice(2, 8), time: 0, scale: 1.0, x: 0.5, y: 0.5 },
            { id: Math.random().toString(36).slice(2, 8), time: dur, scale: 1.18, x: 0.5, y: 0.5 }
          ];
        } else if (motion === 'zoom_out') {
          kfs = [
            { id: Math.random().toString(36).slice(2, 8), time: 0, scale: 1.18, x: 0.5, y: 0.5 },
            { id: Math.random().toString(36).slice(2, 8), time: dur, scale: 1.0, x: 0.5, y: 0.5 }
          ];
        } else if (motion === 'pan_down') {
          kfs = [
            { id: Math.random().toString(36).slice(2, 8), time: 0, scale: 1.12, x: 0.5, y: 0.38 },
            { id: Math.random().toString(36).slice(2, 8), time: dur, scale: 1.12, x: 0.5, y: 0.62 }
          ];
        }

        return { ...r, motion, keyframes: kfs };
      })
    );
  };

  // Apply to Timeline
  const handleApplyToTimeline = async () => {
    if (!plan.length) return;
    setBusy(true);
    setStatusMsg('Timeline дээр зургуудыг буулгаж байна...');
    try {
      const ok = await applyImagePlanToTimeline({
        audioPath,
        audioDuration,
        plan,
        aspectRatio,
        fitMode,
        addCaptions: includeCaptions
      });
      if (ok) {
        onSuccessNotice?.(`✓ ${plan.length} зураг Timeline дээр амжилттай буулаа!`);
        onClose();
      }
    } catch (e: any) {
      setErrorMsg(`Timeline руу буулгахад алдаа: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  // Story segment filtering
  const segmentSize = Math.max(1, Math.ceil(panels.length / 3));
  let segmentPanels = panels;
  if (storySegment === 'start') {
    segmentPanels = panels.slice(0, segmentSize);
  } else if (storySegment === 'mid') {
    segmentPanels = panels.slice(segmentSize, segmentSize * 2);
  } else if (storySegment === 'end') {
    segmentPanels = panels.slice(segmentSize * 2);
  }

  // Filter panels by number/name if searched
  const filteredPanels = searchPanelNum
    ? segmentPanels.filter((p, idx) => String(idx + 1).includes(searchPanelNum) || p.name.toLowerCase().includes(searchPanelNum.toLowerCase()))
    : segmentPanels;

  // Filmstrip window: centered on filmstripOffset (controlled by arrows, slider, and row selection)
  const centerIdx = Math.max(0, Math.min(Math.max(0, panels.length - 1), filmstripOffset));
  const filmstripWindowStart = Math.max(0, Math.min(Math.max(0, panels.length - 8), centerIdx - 3));
  const filmstripPanels = panels.slice(filmstripWindowStart, filmstripWindowStart + 8);

  // Grid column sizing based on zoom toggle
  const gridColumnWidth = galleryZoom === 'small' ? '90px' : galleryZoom === 'large' ? '180px' : '125px';

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.90)',
        backdropFilter: 'blur(12px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12
      }}
    >
      <div
        style={{
          width: '98%',
          maxWidth: 1380,
          height: '95vh',
          backgroundColor: '#121215',
          border: '1px solid #27272a',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 60px -12px rgba(0, 0, 0, 0.9)',
          overflow: 'hidden'
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '10px 18px',
            borderBottom: '1px solid #27272a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'linear-gradient(90deg, rgba(99, 102, 241, 0.18) 0%, rgba(168, 85, 247, 0.14) 100%)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 24 }}>🎨</span>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#f4f4f5', display: 'flex', alignItems: 'center', gap: 8 }}>
                Зураг & Хадмал уялдуулагч студи
                <span style={{ fontSize: 11, background: '#10b981', color: '#000', padding: '1px 8px', borderRadius: 10, fontWeight: 800 }}>
                  HD Zoom & Smart Filmstrip
                </span>
              </div>
              <div style={{ fontSize: 11, color: '#a1a1aa' }}>
                Кадр бүрийг 400% хүртэл томруулан уншиж шалгаад, 1 товшилтоор хялбар оноож солино
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#71717a', fontSize: 22, cursor: 'pointer', padding: 4 }}
          >
            ✕
          </button>
        </div>

        {/* Top Control Bar: Slicing Mode + Re-order + Distribution + Presets */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            padding: '8px 18px',
            backgroundColor: '#18181c',
            borderBottom: '1px solid #27272a'
          }}
        >
          {/* Slicing Mode Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#f4f4f5', fontWeight: 600 }}>✂️ Зүсэх горим:</span>
            <button
              type="button"
              onClick={() => handleReloadWithSliceMode('none')}
              style={{
                padding: '4px 10px',
                borderRadius: 5,
                fontSize: 11,
                fontWeight: sliceMode === 'none' ? 700 : 500,
                cursor: 'pointer',
                border: sliceMode === 'none' ? '1px solid #10b981' : '1px solid #333',
                background: sliceMode === 'none' ? 'rgba(16, 185, 129, 0.25)' : '#222',
                color: sliceMode === 'none' ? '#34d399' : '#888'
              }}
              title="Зургуудыг огт дундуур нь таслахгүй! Бүтэн зургаар нь ашиглана"
            >
              🖼️ Бүтэн зургаар (Зүсэхгүй)
            </button>
            <button
              type="button"
              onClick={() => handleReloadWithSliceMode('smart')}
              style={{
                padding: '4px 10px',
                borderRadius: 5,
                fontSize: 11,
                fontWeight: sliceMode === 'smart' ? 700 : 500,
                cursor: 'pointer',
                border: sliceMode === 'smart' ? '1px solid #a855f7' : '1px solid #333',
                background: sliceMode === 'smart' ? 'rgba(168, 85, 247, 0.25)' : '#222',
                color: sliceMode === 'smart' ? '#d8b4fe' : '#888'
              }}
              title="Зөвхөн цэвэр цагаан/хар зайгаар нь кадруудыг зүснэ"
            >
              ✂️ Цэвэр зайгаар зүсэх
            </button>
          </div>

          {/* Reset / Clean Sequence Button (Solves mixed jumpy numbers!) */}
          <button
            type="button"
            onClick={handleResetChronologicalDistribution}
            style={{
              background: 'rgba(59, 130, 246, 0.2)',
              color: '#93c5fd',
              border: '1px solid rgba(59, 130, 246, 0.5)',
              borderRadius: 5,
              padding: '4px 10px',
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4
            }}
            title="1-р өгүүлбэрээс эхлээд сүүл хүртэл зургуудыг 1-ээс эхлэн цэгцтэй жигд дахин хуваарилах"
          >
            <span>🔄</span>
            <span>Дарааллыг 1-ээс эхлүүлэн цэгцлэх</span>
          </button>

          {/* Replace All Images Button */}
          <button
            type="button"
            onClick={() => handlePickImages('folder')}
            style={{
              background: 'linear-gradient(135deg, #a855f7 0%, #6366f1 100%)',
              color: '#fff',
              border: 'none',
              borderRadius: 5,
              padding: '5px 12px',
              fontSize: 11,
              fontWeight: 800,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              boxShadow: '0 2px 10px rgba(168, 85, 247, 0.45)'
            }}
            title="Шинэ зургийн хавтас сонгож, бүх зургуудыг тэр чигт нь шинэчлэх"
          >
            <span>📁</span>
            <span>Бүх зургийг шинэ хавтсаар солих</span>
          </button>

          {/* Motion Presets */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 11, color: '#a1a1aa' }}>Хөдөлгөөн:</span>
            {[
              { id: 'variety', label: '✨ Кино шиг' },
              { id: 'scroll', label: '📜 Scroll' },
              { id: 'action', label: '🔥 Action' },
              { id: 'static', label: '🛑 Хөдөлгөөнгүй' }
            ].map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleMotionPresetChange(p.id as any)}
                style={{
                  padding: '3px 7px',
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: motionPreset === p.id ? 700 : 400,
                  cursor: 'pointer',
                  border: motionPreset === p.id ? '1px solid #6366f1' : '1px solid #333',
                  background: motionPreset === p.id ? 'rgba(99, 102, 241, 0.25)' : '#222',
                  color: motionPreset === p.id ? '#a5b4fc' : '#888'
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Aspect Ratio */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <button
              type="button"
              onClick={() => setAspectRatio('16:9')}
              style={{
                padding: '3px 8px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                border: aspectRatio === '16:9' ? '1px solid #10b981' : '1px solid #333',
                background: aspectRatio === '16:9' ? 'rgba(16, 185, 129, 0.2)' : '#222',
                color: aspectRatio === '16:9' ? '#34d399' : '#888'
              }}
            >
              📺 16:9
            </button>
            <button
              type="button"
              onClick={() => setAspectRatio('9:16')}
              style={{
                padding: '3px 8px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                border: aspectRatio === '9:16' ? '1px solid #ec4899' : '1px solid #333',
                background: aspectRatio === '9:16' ? 'rgba(236, 72, 153, 0.2)' : '#222',
                color: aspectRatio === '9:16' ? '#f472b6' : '#888'
              }}
            >
              📱 9:16
            </button>
          </div>

          {/* Fit Mode Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#1c1c24', padding: '3px 8px', borderRadius: 6, border: '1px solid #2e2e38' }}>
            <span style={{ fontSize: 11, color: '#f4f4f5', fontWeight: 600 }}>Хэлбэр:</span>
            <button
              type="button"
              onClick={() => setFitMode('contain')}
              style={{
                padding: '3px 9px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                border: fitMode === 'contain' ? '1px solid #10b981' : '1px solid #333',
                background: fitMode === 'contain' ? 'rgba(16, 185, 129, 0.25)' : '#222',
                color: fitMode === 'contain' ? '#34d399' : '#888'
              }}
              title="Бүтнээр нь багтаах - Зургийг огтхон ч тайрахгүй, дүрүүдийн царай яриаг 100% бүтэн харуулна"
            >
              🖼️ Бүтнээр нь (Fit)
            </button>
            <button
              type="button"
              onClick={() => setFitMode('cover')}
              style={{
                padding: '3px 9px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                border: fitMode === 'cover' ? '1px solid #6366f1' : '1px solid #333',
                background: fitMode === 'cover' ? 'rgba(99, 102, 241, 0.25)' : '#222',
                color: fitMode === 'cover' ? '#a5b4fc' : '#888'
              }}
              title="Дэлгэц дүүргэх - 9:16 дэлгэцийг дүүргэж томруулна"
            >
              📱 Дүүргэх (Cover)
            </button>
          </div>
        </div>

        {/* Status / Error Toast */}
        {errorMsg && (
          <div style={{ padding: '6px 18px', backgroundColor: 'rgba(239, 68, 68, 0.15)', borderBottom: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', fontSize: 12 }}>
            ⚠️ {errorMsg}
          </div>
        )}
        {statusMsg && !errorMsg && (
          <div style={{ padding: '5px 18px', backgroundColor: 'rgba(99, 102, 241, 0.1)', borderBottom: '1px solid rgba(99, 102, 241, 0.2)', color: '#c4b5fd', fontSize: 11 }}>
            ℹ️ {statusMsg}
          </div>
        )}

        {/* Main Content Area */}
        {panels.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 40 }}>
            <span style={{ fontSize: 56 }}>📁</span>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#f4f4f5' }}>
              Манхва / Комик зургуудын хавтасаа сонгоно уу
            </div>
            <button
              type="button"
              onClick={() => handlePickImages('folder')}
              style={{
                padding: '12px 28px',
                borderRadius: 8,
                background: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
                color: '#fff',
                fontSize: 14,
                fontWeight: 700,
                border: 'none',
                cursor: 'pointer',
                boxShadow: '0 4px 15px rgba(139, 92, 246, 0.4)'
              }}
            >
              📁 Зургийн хавтас сонгох
            </button>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1.05fr 1.15fr', gap: 12, padding: 12, overflow: 'hidden' }}>
            {/* Left Column: Storyboard List */}
            <div style={{ display: 'flex', flexDirection: 'column', backgroundColor: '#0e0e11', borderRadius: 8, border: '1px solid #27272a', overflow: 'hidden' }}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid #222', fontSize: 12, fontWeight: 700, color: '#f4f4f5', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>🎬 Эвлүүлгийн дараалал ({plan.length} өгүүлбэр)</span>
                <span style={{ fontSize: 10, color: '#34d399', fontWeight: 600 }}>
                  Мөр дээр дарж баруунаас зургаа сонгоно
                </span>
              </div>

              <div style={{ flex: 1, overflowY: 'auto' }}>
                {plan.map((row, index) => {
                  const mediaUrl = window.api.toMediaUrl ? window.api.toMediaUrl(row.imagePath) : row.imagePath;
                  const isSelected = selectedRowId === row.id;
                  const isRecentlyUpdated = recentUpdatedRowId === row.id;
                  const panelIdx = panels.findIndex((p) => p.id === row.panelId || p.path === row.imagePath);

                  return (
                    <div
                      key={row.id}
                      onClick={() => setSelectedRowId(row.id)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '26px 26px 88px 65px 1fr 105px 22px',
                        gap: 6,
                        alignItems: 'center',
                        padding: '6px 8px',
                        borderBottom: '1px solid #16161a',
                        backgroundColor: isRecentlyUpdated
                          ? 'rgba(16, 185, 129, 0.28)'
                          : isSelected
                          ? 'rgba(99, 102, 241, 0.28)'
                          : index % 2 === 0
                          ? 'rgba(255,255,255,0.01)'
                          : 'transparent',
                        cursor: 'pointer',
                        borderLeft: isSelected ? '5px solid #8b5cf6' : '5px solid transparent',
                        boxShadow: isSelected ? 'inset 0 0 12px rgba(139, 92, 246, 0.2)' : 'none',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      {/* Index # */}
                      <div style={{ fontSize: 11, color: isSelected ? '#a5b4fc' : '#71717a', fontWeight: 800, textAlign: 'center' }}>
                        #{index + 1}
                      </div>

                      {/* Play Sentence Audio */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedRowId(row.id);
                          handlePlayRow(row);
                        }}
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 4,
                          background: playingRowId === row.id ? '#10b981' : '#27272a',
                          color: '#fff',
                          border: '1px solid #3f3f46',
                          cursor: 'pointer',
                          fontSize: 10,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                        title="Хоолойг тоглуулах"
                      >
                        {playingRowId === row.id ? '⏸' : '▶'}
                      </button>

                      {/* Thumbnail Preview - CLICKING OPENS DIRECT PICKER! */}
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedRowId(row.id);
                          setPickingForRow(row);
                        }}
                        style={{
                          width: 88,
                          height: 52,
                          borderRadius: 5,
                          overflow: 'hidden',
                          backgroundColor: '#000',
                          border: isSelected ? '2.5px solid #8b5cf6' : '1px solid #333',
                          position: 'relative',
                          cursor: 'pointer'
                        }}
                        title="Товшиж энэ өгүүлбэрийн зургийг шууд солих"
                      >
                        <img src={mediaUrl} alt={row.imageName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            background: 'rgba(0,0,0,0.85)',
                            fontSize: 8,
                            color: '#34d399',
                            textAlign: 'center',
                            fontWeight: 800
                          }}
                        >
                          Кадр #{panelIdx >= 0 ? panelIdx + 1 : '?'}
                        </div>
                        <div
                          style={{
                            position: 'absolute',
                            top: 2,
                            left: 2,
                            background: 'rgba(0,0,0,0.7)',
                            fontSize: 8,
                            color: '#c7d2fe',
                            padding: '1px 3px',
                            borderRadius: 2
                          }}
                        >
                          Солих 🔍
                        </div>
                      </div>

                      {/* Timing */}
                      <div style={{ fontSize: 10, color: '#a1a1aa', fontFamily: 'monospace' }}>
                        <div>{clock(row.start)}</div>
                        <div style={{ color: '#71717a' }}>({row.duration.toFixed(1)}s)</div>
                      </div>

                      {/* Subtitle text */}
                      <div
                        onClick={() => setSelectedRowId(row.id)}
                        style={{
                          fontSize: 11,
                          color: isSelected ? '#fff' : '#ddd',
                          fontWeight: isSelected ? 600 : 400,
                          lineHeight: 1.3,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical'
                        }}
                      >
                        {row.text || '(Хадмалгүй)'}
                      </div>

                      {/* Controls: Stepper (◀ / ▶) + Framing */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStepPanel(row.id, -1);
                            }}
                            style={{ background: '#222', color: '#ccc', border: '1px solid #333', borderRadius: 3, padding: '2px 5px', fontSize: 10, cursor: 'pointer' }}
                            title="Өмнөх зураг руу солих"
                          >
                            ◀
                          </button>
                          <input
                            type="number"
                            value={panelIdx >= 0 ? panelIdx + 1 : 1}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10);
                              if (!isNaN(val)) handleSetPanelByNumber(row.id, val);
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedRowId(row.id);
                            }}
                            style={{ width: 38, background: '#1b1b1f', border: '1px solid #444', color: '#34d399', fontSize: 10, textAlign: 'center', borderRadius: 3, padding: '2px 1px', fontWeight: 700 }}
                            title="Зургийн дугаарыг бичиж солих"
                          />
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStepPanel(row.id, 1);
                            }}
                            style={{ background: '#222', color: '#ccc', border: '1px solid #333', borderRadius: 3, padding: '2px 5px', fontSize: 10, cursor: 'pointer' }}
                            title="Дараагийн зураг руу солих"
                          >
                            ▶
                          </button>
                        </div>

                        {/* Framing */}
                        <div style={{ display: 'flex', gap: 2 }}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSetRowFocus(row.id, 'top');
                            }}
                            style={{ background: '#181820', color: '#93c5fd', border: '1px solid #2a2a34', borderRadius: 2, padding: '1px 2px', fontSize: 8, cursor: 'pointer', flex: 1 }}
                            title="Камерыг дээд хэсэг (Царай/Яриа) рүү төвлөрүүлэх"
                          >
                            ⬆️Дээд
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSetRowFocus(row.id, 'center');
                            }}
                            style={{ background: '#181820', color: '#ccc', border: '1px solid #2a2a34', borderRadius: 2, padding: '1px 2px', fontSize: 8, cursor: 'pointer', flex: 1 }}
                            title="Камерыг голлуулах"
                          >
                            🎯Гол
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSetRowFocus(row.id, 'bottom');
                            }}
                            style={{ background: '#181820', color: '#fca5a5', border: '1px solid #2a2a34', borderRadius: 2, padding: '1px 2px', fontSize: 8, cursor: 'pointer', flex: 1 }}
                            title="Камерыг доод хэсэг рүү төвлөрүүлэх"
                          >
                            ⬇️Доод
                          </button>
                        </div>
                      </div>

                      {/* Split button */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSplitRow(row.id);
                        }}
                        style={{ background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', fontSize: 11, padding: 1 }}
                        title="Энэ өгүүлбэрт 2 зураг оруулах (Хуваах)"
                      >
                        ✂️
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right Column: Super-Easy Selection Modes (Filmstrip / Reader / Grid) */}
            <div style={{ display: 'flex', flexDirection: 'column', backgroundColor: '#0e0e11', borderRadius: 8, border: '1px solid #27272a', overflow: 'hidden' }}>
              {/* Header Tabs: Switch between Filmstrip, Reader, Grid */}
              <div style={{ padding: '8px 12px', borderBottom: '1px solid #222', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6, background: '#151518' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => setPanelViewMode('filmstrip')}
                    style={{
                      background: panelViewMode === 'filmstrip' ? 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' : '#222',
                      color: panelViewMode === 'filmstrip' ? '#fff' : '#aaa',
                      border: 'none',
                      borderRadius: 4,
                      padding: '5px 12px',
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer'
                    }}
                    title="Ойролцоох 5-7 зургийг томоор харуулах (Хамгийн хялбар)"
                  >
                    🎞️ Ойролцоох 5 кадр
                  </button>
                  <button
                    type="button"
                    onClick={() => setPanelViewMode('reader')}
                    style={{
                      background: panelViewMode === 'reader' ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : '#222',
                      color: panelViewMode === 'reader' ? '#fff' : '#aaa',
                      border: 'none',
                      borderRadius: 4,
                      padding: '5px 12px',
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer'
                    }}
                    title="Манхваг дээрээс доош гүйлгэж уншиж байгаад сонгох"
                  >
                    📜 Манхва уншигч (Босоо)
                  </button>
                  <button
                    type="button"
                    onClick={() => setPanelViewMode('grid')}
                    style={{
                      background: panelViewMode === 'grid' ? '#3f3f46' : '#222',
                      color: panelViewMode === 'grid' ? '#fff' : '#888',
                      border: 'none',
                      borderRadius: 4,
                      padding: '5px 10px',
                      fontSize: 11,
                      cursor: 'pointer'
                    }}
                    title="Бүх зургийг тор хэлбэрээр харах"
                  >
                    🔲 Бүх зураг
                  </button>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => handlePickImages('folder')}
                    style={{
                      background: 'rgba(168, 85, 247, 0.25)',
                      color: '#d8b4fe',
                      border: '1px solid rgba(168, 85, 247, 0.5)',
                      borderRadius: 4,
                      padding: '4px 10px',
                      fontSize: 10,
                      fontWeight: 700,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4
                    }}
                    title="Өөр шинэ хавтас сонгож солих"
                  >
                    <span>📁</span>
                    <span>Хавтас солих</span>
                  </button>

                  {/* Auto-Advance Pill */}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#a1a1aa', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={autoAdvance}
                      onChange={(e) => setAutoAdvance(e.target.checked)}
                    />
                    <span>⚡ Сонгомогц дараагийнх руу шилжих</span>
                  </label>
                </div>
              </div>

              {/* Story Segment Filter Bar */}
              <div style={{ padding: '6px 12px', background: '#121216', borderBottom: '1px solid #1f1f23', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 10, color: '#888' }}>Бүлэг:</span>
                  {[
                    { id: 'all', label: `Бүгд (${panels.length})` },
                    { id: 'start', label: `🟢 Эхлэл (1-${segmentSize})` },
                    { id: 'mid', label: `🟡 Өрнөл (${segmentSize + 1}-${segmentSize * 2})` },
                    { id: 'end', label: `🔴 Төгсгөл (${segmentSize * 2 + 1}-${panels.length})` }
                  ].map((sg) => (
                    <button
                      key={sg.id}
                      type="button"
                      onClick={() => setStorySegment(sg.id as any)}
                      style={{
                        background: storySegment === sg.id ? '#312e81' : '#1b1b1f',
                        color: storySegment === sg.id ? '#c7d2fe' : '#71717a',
                        border: storySegment === sg.id ? '1px solid #6366f1' : '1px solid #27272a',
                        borderRadius: 3,
                        padding: '2px 7px',
                        fontSize: 9,
                        fontWeight: storySegment === sg.id ? 700 : 400,
                        cursor: 'pointer'
                      }}
                    >
                      {sg.label}
                    </button>
                  ))}
                </div>

                {/* Active Row Indicator */}
                <div style={{ fontSize: 11, color: '#f4f4f5', background: 'rgba(99, 102, 241, 0.2)', padding: '2px 8px', borderRadius: 4, border: '1px solid rgba(99, 102, 241, 0.4)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  🎯 Засаж буй: <b>#{plan.findIndex((r) => r.id === activeRow?.id) + 1}</b> "{activeRow?.text.slice(0, 20)}..."
                </div>
              </div>

              {/* ================= VIEW 1: SMART FILMSTRIP (RECOMMENDED) ================= */}
              {panelViewMode === 'filmstrip' && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 10, gap: 10, overflow: 'hidden' }}>
                  {/* Filmstrip Controls Bar: Jump Button + Card Size Slider */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, background: '#16161b', padding: '6px 10px', borderRadius: 6, border: '1px solid #27272a' }}>
                    {/* Story Jump Button */}
                    <button
                      type="button"
                      onClick={() => {
                        setFilmstripOffset(expectedStoryIdx);
                        if (panels[expectedStoryIdx]) handleAssignPanel(panels[expectedStoryIdx]);
                      }}
                      style={{
                        background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 10,
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4
                      }}
                      title="Энэ өгүүлбэрийн видео дээрх минутад тохирох зургууд руу шууд үсрэх"
                    >
                      <span>🎯</span>
                      <span>Зохиолын дагуух кадр руу үсрэх (#{expectedStoryIdx + 1})</span>
                    </button>

                    {/* Card Size Slider */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10, color: '#aaa' }}>Картын хэмжээ:</span>
                      <input
                        type="range"
                        min={140}
                        max={340}
                        value={filmstripCardWidth}
                        onChange={(e) => setFilmstripCardWidth(Number(e.target.value))}
                        style={{ width: 90, accentColor: '#10b981', cursor: 'pointer' }}
                        title="Зургийн өргөн, өндрийг тохируулах"
                      />
                      <span style={{ fontSize: 10, color: '#34d399', fontFamily: 'monospace', width: 34 }}>
                        {filmstripCardWidth}px
                      </span>
                    </div>
                  </div>

                  {/* Filmstrip Carousel */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, overflow: 'hidden' }}>
                    {/* Shift Left */}
                    <button
                      type="button"
                      onClick={() => setFilmstripOffset((prev) => Math.max(0, prev - 3))}
                      disabled={centerIdx <= 0}
                      style={{
                        height: '100%',
                        width: 44,
                        background: centerIdx <= 0 ? '#141416' : '#27272a',
                        border: '1px solid #3f3f46',
                        color: centerIdx <= 0 ? '#52525b' : '#fff',
                        borderRadius: 8,
                        cursor: centerIdx <= 0 ? 'not-allowed' : 'pointer',
                        fontSize: 20,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        userSelect: 'none'
                      }}
                      title="Өмнөх кадр руу шилжих (◀)"
                    >
                      ◀
                    </button>

                    {/* Cards */}
                    <div
                      onWheel={(e) => {
                        if (e.deltaY !== 0) {
                          e.currentTarget.scrollLeft += e.deltaY;
                        }
                      }}
                      style={{ flex: 1, display: 'flex', gap: 10, overflowX: 'auto', padding: '6px 2px', height: '100%' }}
                    >
                      {filmstripPanels.map((p) => {
                        const url = window.api.toMediaUrl ? window.api.toMediaUrl(p.path) : p.path;
                        const pIdx = panels.findIndex((x) => x.id === p.id);
                        const isCurrentActive = activePanelIndex === pIdx;

                        return (
                          <div
                            key={p.id}
                            onClick={() => {
                              handleAssignPanel(p);
                              setFilmstripOffset(pIdx);
                            }}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              setZoomedPanel(p);
                              setZoomScale(1.0);
                              setZoomPan({ x: 0, y: 0 });
                            }}
                            style={{
                              flex: `0 0 ${filmstripCardWidth}px`,
                              height: '100%',
                              borderRadius: 8,
                              overflow: 'hidden',
                              backgroundColor: '#000',
                              border: isCurrentActive ? '3.5px solid #10b981' : '1px solid #333',
                              cursor: 'pointer',
                              display: 'flex',
                              flexDirection: 'column',
                              position: 'relative',
                              boxShadow: isCurrentActive ? '0 0 16px rgba(16, 185, 129, 0.6)' : 'none',
                              transition: 'transform 0.1s ease',
                              userSelect: 'none'
                            }}
                            title={`Кадр #${pIdx + 1} (${p.name}) - Товшиж сонгох | Хоёр дараад томруулах`}
                          >
                            {/* Zoom button on card */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setZoomedPanel(p);
                                setZoomScale(1.0);
                                setZoomPan({ x: 0, y: 0 });
                              }}
                              style={{
                                position: 'absolute',
                                top: 6,
                                left: 6,
                                background: 'rgba(0,0,0,0.85)',
                                color: '#fff',
                                border: '1px solid #666',
                                borderRadius: 4,
                                padding: '2px 7px',
                                fontSize: 10,
                                fontWeight: 700,
                                cursor: 'pointer',
                                zIndex: 10
                              }}
                              title="Томруулж нарийн харах (Zoom)"
                            >
                              🔍 Томруулах
                            </button>

                            <div style={{ flex: 1, position: 'relative', overflow: 'hidden', backgroundColor: '#000' }}>
                              <img
                                src={url}
                                alt={p.name}
                                style={{ width: '100%', height: '100%', objectFit: fitMode, backgroundColor: '#000', display: 'block', pointerEvents: 'none' }}
                              />
                              {isCurrentActive && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    bottom: 6,
                                    right: 6,
                                    background: '#10b981',
                                    color: '#000',
                                    fontSize: 9,
                                    fontWeight: 900,
                                    padding: '2px 6px',
                                    borderRadius: 4,
                                    zIndex: 5,
                                    pointerEvents: 'none',
                                    boxShadow: '0 2px 6px rgba(0,0,0,0.6)'
                                  }}
                                >
                                  ✓ ОДООГИЙН
                                </div>
                              )}
                            </div>
                            <div style={{ background: '#18181c', borderTop: '1px solid #27272a', padding: '5px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: 12, fontWeight: 800, color: isCurrentActive ? '#34d399' : '#fff' }}>
                                #{pIdx + 1}
                              </span>
                              <span style={{ fontSize: 9, color: isCurrentActive ? '#34d399' : '#888' }}>
                                {isCurrentActive ? 'Сонгосон' : 'Сонгох 👆'}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Shift Right */}
                    <button
                      type="button"
                      onClick={() => setFilmstripOffset((prev) => Math.min(panels.length - 1, prev + 3))}
                      disabled={centerIdx >= panels.length - 1}
                      style={{
                        height: '100%',
                        width: 44,
                        background: centerIdx >= panels.length - 1 ? '#141416' : '#27272a',
                        border: '1px solid #3f3f46',
                        color: centerIdx >= panels.length - 1 ? '#52525b' : '#fff',
                        borderRadius: 8,
                        cursor: centerIdx >= panels.length - 1 ? 'not-allowed' : 'pointer',
                        fontSize: 20,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        userSelect: 'none'
                      }}
                      title="Дараагийн кадр руу шилжих (▶)"
                    >
                      ▶
                    </button>
                  </div>

                  {/* Comic Story Scrubber Slider */}
                  <div style={{ background: '#18181c', padding: '6px 14px', borderRadius: 6, border: '1px solid #27272a', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 11, color: '#a1a1aa', whiteSpace: 'nowrap' }}>
                      Манхвагийн байрлал: <b>#{centerIdx + 1} / {panels.length}</b>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={panels.length - 1}
                      value={centerIdx}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setFilmstripOffset(val);
                      }}
                      style={{ flex: 1, accentColor: '#6366f1', cursor: 'pointer' }}
                    />
                  </div>
                </div>
              )}

              {/* ================= VIEW 2: WEBTOON READER (VERTICAL STRIP) ================= */}
              {panelViewMode === 'reader' && (
                <div
                  style={{
                    flex: 1,
                    overflowY: 'auto',
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 14,
                    alignItems: 'center'
                  }}
                >
                  <div style={{ fontSize: 11, color: '#a5b4fc', textAlign: 'center', width: '100%', padding: '6px', background: '#18181f', borderRadius: 4 }}>
                    📖 Манхваг дээрээс доош гүйлгэж уншаад, тохирох зургийн <b>[Энэ зургийг сонгох]</b> ногоон товчийг дарна уу!
                  </div>

                  {filteredPanels.map((p) => {
                    const url = window.api.toMediaUrl ? window.api.toMediaUrl(p.path) : p.path;
                    const pIdx = panels.findIndex((x) => x.id === p.id);
                    const isCurrentActive = activePanelIndex === pIdx;

                    return (
                      <div
                        key={p.id}
                        id={`reader-panel-${pIdx}`}
                        style={{
                          width: '100%',
                          maxWidth: 540,
                          minHeight: 220,
                          borderRadius: 8,
                          overflow: 'hidden',
                          backgroundColor: '#18181c',
                          border: isCurrentActive ? '3px solid #10b981' : '1px solid #2e2e34',
                          boxShadow: isCurrentActive ? '0 0 20px rgba(16, 185, 129, 0.45)' : '0 4px 12px rgba(0,0,0,0.5)',
                          display: 'flex',
                          flexDirection: 'column',
                          flexShrink: 0
                        }}
                      >
                        {/* Header bar of panel */}
                        <div style={{ padding: '8px 14px', background: isCurrentActive ? '#064e3b' : '#222228', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 13, fontWeight: 800, color: isCurrentActive ? '#34d399' : '#fff' }}>
                            Кадр #{pIdx + 1} ({p.name})
                          </span>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setZoomedPanel(p);
                                setZoomScale(1.0);
                                setZoomPan({ x: 0, y: 0 });
                              }}
                              style={{ background: '#27272a', color: '#ccc', border: '1px solid #444', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
                            >
                              🔍 Томруулах
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAssignPanel(p)}
                              style={{
                                background: isCurrentActive ? '#10b981' : 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                                color: isCurrentActive ? '#000' : '#fff',
                                border: 'none',
                                borderRadius: 4,
                                padding: '4px 14px',
                                fontSize: 11,
                                fontWeight: 800,
                                cursor: 'pointer'
                              }}
                            >
                              {isCurrentActive ? '✓ Одоо сонгосон' : 'Энэ зургийг сонгох 👆'}
                            </button>
                          </div>
                        </div>

                        {/* Image body */}
                        <div
                          onClick={() => handleAssignPanel(p)}
                          style={{
                            width: '100%',
                            minHeight: 180,
                            maxHeight: 520,
                            backgroundColor: '#000',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer'
                          }}
                        >
                          <img
                            src={url}
                            alt={p.name}
                            style={{
                              width: '100%',
                              maxHeight: 520,
                              objectFit: 'contain',
                              backgroundColor: '#000',
                              display: 'block'
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ================= VIEW 3: FULL GRID ================= */}
              {panelViewMode === 'grid' && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <div style={{ padding: '6px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#141418' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10, color: '#888' }}>Хэмжээ:</span>
                      {(['small', 'medium', 'large'] as const).map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          onClick={() => setGalleryZoom(sz)}
                          style={{
                            background: galleryZoom === sz ? '#6366f1' : '#222',
                            color: galleryZoom === sz ? '#fff' : '#888',
                            border: 'none',
                            padding: '2px 6px',
                            fontSize: 10,
                            borderRadius: 3,
                            cursor: 'pointer'
                          }}
                        >
                          {sz === 'small' ? 'Жижиг' : sz === 'medium' ? 'Дунд' : 'Том'}
                        </button>
                      ))}
                    </div>

                    <input
                      type="text"
                      placeholder="Дугаар..."
                      value={searchPanelNum}
                      onChange={(e) => setSearchPanelNum(e.target.value)}
                      style={{
                        background: '#1b1b1f',
                        border: '1px solid #333',
                        color: '#fff',
                        borderRadius: 4,
                        padding: '2px 6px',
                        fontSize: 10,
                        width: 75
                      }}
                    />
                  </div>

                  <div
                    style={{
                      flex: 1,
                      overflowY: 'auto',
                      padding: 8,
                      display: 'grid',
                      gridTemplateColumns: `repeat(auto-fill, minmax(${gridColumnWidth}, 1fr))`,
                      gap: 8,
                      alignContent: 'start',
                      position: 'relative'
                    }}
                  >
                    {filteredPanels.map((p) => {
                      const url = window.api.toMediaUrl ? window.api.toMediaUrl(p.path) : p.path;
                      const pIdx = panels.findIndex((x) => x.id === p.id);
                      const isCurrentActive = activePanelIndex === pIdx;

                      return (
                        <div
                          key={p.id}
                          onClick={() => handleAssignPanel(p)}
                          onMouseEnter={() => setHoveredPanel(p)}
                          onMouseLeave={() => setHoveredPanel(null)}
                          style={{
                            cursor: 'pointer',
                            borderRadius: 6,
                            overflow: 'hidden',
                            border: isCurrentActive ? '2.5px solid #10b981' : '1px solid #2c2c32',
                            backgroundColor: '#0a0a0c',
                            position: 'relative',
                            aspectRatio: '16/10',
                            boxShadow: isCurrentActive ? '0 0 12px rgba(16, 185, 129, 0.6)' : 'none',
                            transition: 'transform 0.1s ease'
                          }}
                          title={`Кадр #${pIdx + 1} (${p.name})`}
                        >
                          <img src={url} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.8)', fontSize: 9, color: '#fff', padding: '1px 3px', textAlign: 'center', fontWeight: 700 }}>
                            #{pIdx + 1}
                          </div>
                          {isCurrentActive && (
                            <div style={{ position: 'absolute', top: 2, right: 2, background: '#10b981', color: '#000', fontSize: 8, fontWeight: 800, padding: '1px 4px', borderRadius: 3 }}>
                              ✓ Идэвхтэй
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Hover Large Preview popup in Grid Mode */}
              {hoveredPanel && panelViewMode === 'grid' && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 65,
                    right: 20,
                    width: 320,
                    height: 220,
                    backgroundColor: '#18181b',
                    border: '2px solid #6366f1',
                    borderRadius: 8,
                    overflow: 'hidden',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.9)',
                    pointerEvents: 'none',
                    zIndex: 10000,
                    display: 'flex',
                    flexDirection: 'column'
                  }}
                >
                  <img
                    src={window.api.toMediaUrl ? window.api.toMediaUrl(hoveredPanel.path) : hoveredPanel.path}
                    alt={hoveredPanel.name}
                    style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }}
                  />
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.85)', padding: '2px 8px', fontSize: 10, color: '#c4b5fd' }}>
                    🔍 Томруулсан харагдац: {hoveredPanel.name}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ================= DEDICATED PICKER MODAL FOR A SPECIFIC ROW ================= */}
        {pickingForRow && (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.85)',
              zIndex: 10050,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 20
            }}
            onClick={() => setPickingForRow(null)}
          >
            <div
              style={{
                width: '90%',
                maxWidth: 960,
                height: '85vh',
                backgroundColor: '#18181c',
                border: '1px solid #3f3f46',
                borderRadius: 12,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                boxShadow: '0 20px 50px rgba(0,0,0,0.9)'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div style={{ padding: '12px 18px', borderBottom: '1px solid #27272a', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#202026' }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#f4f4f5' }}>
                    🖼️ Өгүүлбэр #{plan.findIndex((r) => r.id === pickingForRow.id) + 1}-д зураг сонгох
                  </div>
                  <div style={{ fontSize: 12, color: '#a5b4fc', marginTop: 2 }}>
                    "{pickingForRow.text}"
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setPickingForRow(null)}
                  style={{ background: 'none', border: 'none', color: '#888', fontSize: 20, cursor: 'pointer' }}
                >
                  ✕
                </button>
              </div>

              {/* Grid of All Panels */}
              <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
                {panels.map((p, idx) => {
                  const url = window.api.toMediaUrl ? window.api.toMediaUrl(p.path) : p.path;
                  const isCur = pickingForRow.panelId === p.id || pickingForRow.imagePath === p.path;

                  return (
                    <div
                      key={p.id}
                      onClick={() => assignPanelToTargetRow(pickingForRow.id, p)}
                      style={{
                        borderRadius: 6,
                        overflow: 'hidden',
                        backgroundColor: '#0a0a0c',
                        border: isCur ? '3px solid #10b981' : '1px solid #333',
                        cursor: 'pointer',
                        aspectRatio: '16/10',
                        position: 'relative'
                      }}
                    >
                      <img src={url} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.8)', fontSize: 10, color: '#fff', textAlign: 'center', fontWeight: 800, padding: '2px 0' }}>
                        Кадр #{idx + 1}
                      </div>
                      {isCur && (
                        <div style={{ position: 'absolute', top: 3, right: 3, background: '#10b981', color: '#000', fontSize: 9, fontWeight: 900, padding: '1px 5px', borderRadius: 3 }}>
                          ✓ ОДООГИЙН
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ================= HD ZOOM & PAN LIGHTBOX MODAL ================= */}
        {zoomedPanel && (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.92)',
              zIndex: 10100,
              display: 'flex',
              flexDirection: 'column',
              userSelect: 'none'
            }}
          >
            {/* Lightbox Header Bar */}
            <div
              style={{
                padding: '10px 20px',
                background: '#18181c',
                borderBottom: '1px solid #2e2e34',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                zIndex: 10
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: '#f4f4f5' }}>
                  🔍 Кадр #{panels.findIndex((x) => x.id === zoomedPanel.id) + 1} ({zoomedPanel.name})
                </span>
                <span style={{ fontSize: 11, color: '#a1a1aa' }}>
                  {zoomedPanel.width} × {zoomedPanel.height} px · Хулганы хүрдээр томруулж, чирч шалгана уу
                </span>
              </div>

              {/* Zoom Controls */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setZoomScale((s) => Math.max(0.5, s - 0.25))}
                  style={{ background: '#27272a', color: '#fff', border: '1px solid #444', borderRadius: 4, width: 28, height: 28, cursor: 'pointer', fontSize: 14 }}
                  title="Жижигрүүлэх (-)"
                >
                  -
                </button>
                <span style={{ fontSize: 12, color: '#34d399', fontWeight: 800, width: 45, textAlign: 'center' }}>
                  {Math.round(zoomScale * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => setZoomScale((s) => Math.min(5.0, s + 0.25))}
                  style={{ background: '#27272a', color: '#fff', border: '1px solid #444', borderRadius: 4, width: 28, height: 28, cursor: 'pointer', fontSize: 14 }}
                  title="Томруулах (+)"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setZoomScale(1.0);
                    setZoomPan({ x: 0, y: 0 });
                  }}
                  style={{ background: '#27272a', color: '#ccc', border: '1px solid #444', borderRadius: 4, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
                  title="Анхны хэмжээг сэргээх"
                >
                  ↺ 100%
                </button>

                {/* Assign to active row button */}
                <button
                  type="button"
                  onClick={() => handleAssignPanel(zoomedPanel)}
                  style={{
                    background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                    color: '#000',
                    fontWeight: 900,
                    border: 'none',
                    borderRadius: 5,
                    padding: '6px 16px',
                    fontSize: 12,
                    cursor: 'pointer',
                    boxShadow: '0 2px 10px rgba(16, 185, 129, 0.5)'
                  }}
                  title="Энэ зургийг сонгосон өгүүлбэрт шууд оноох"
                >
                  ✓ Энэ зургийг сонгох
                </button>

                {/* Close */}
                <button
                  type="button"
                  onClick={() => setZoomedPanel(null)}
                  style={{ background: '#27272a', color: '#fff', border: '1px solid #444', borderRadius: 4, width: 28, height: 28, cursor: 'pointer', fontSize: 14, marginLeft: 10 }}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Interactive Zoom/Pan Canvas */}
            <div
              style={{
                flex: 1,
                overflow: 'hidden',
                backgroundColor: '#0a0a0d',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: isPanning ? 'grabbing' : 'grab',
                position: 'relative'
              }}
              onWheel={(e) => {
                e.preventDefault();
                setZoomScale((prev) => Math.max(0.4, Math.min(5.0, prev + (e.deltaY < 0 ? 0.2 : -0.2))));
              }}
              onMouseDown={(e) => {
                setIsPanning(true);
                panStartRef.current = { x: e.clientX - zoomPan.x, y: e.clientY - zoomPan.y };
              }}
              onMouseMove={(e) => {
                if (!isPanning) return;
                setZoomPan({
                  x: e.clientX - panStartRef.current.x,
                  y: e.clientY - panStartRef.current.y
                });
              }}
              onMouseUp={() => setIsPanning(false)}
              onMouseLeave={() => setIsPanning(false)}
            >
              <img
                src={window.api.toMediaUrl ? window.api.toMediaUrl(zoomedPanel.path) : zoomedPanel.path}
                alt={zoomedPanel.name}
                draggable={false}
                style={{
                  maxHeight: '85vh',
                  maxWidth: '85vw',
                  objectFit: 'contain',
                  transform: `translate(${zoomPan.x}px, ${zoomPan.y}px) scale(${zoomScale})`,
                  transition: isPanning ? 'none' : 'transform 0.1s ease',
                  boxShadow: '0 10px 40px rgba(0,0,0,0.8)'
                }}
              />
            </div>
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            padding: '10px 18px',
            borderTop: '1px solid #27272a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: '#151518'
          }}
        >
          <div style={{ fontSize: 12, color: '#34d399', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>✓</span>
            <span>{plan.length} зураг холбогдсон · Нийт хугацаа: {clock(audioDuration)} · Хар кадргүй тасралтгүй</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: '#27272a',
                color: '#ccc',
                border: '1px solid #3f3f46',
                borderRadius: 6,
                padding: '7px 16px',
                fontSize: 12,
                cursor: 'pointer'
              }}
            >
              Хаах
            </button>

            <button
              type="button"
              onClick={handleApplyToTimeline}
              disabled={busy || !plan.length}
              style={{
                background: plan.length ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : '#333',
                color: '#fff',
                fontWeight: 700,
                border: 'none',
                borderRadius: 6,
                padding: '9px 24px',
                fontSize: 13,
                cursor: plan.length ? 'pointer' : 'not-allowed',
                boxShadow: plan.length ? '0 4px 15px rgba(16, 185, 129, 0.4)' : 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 8
              }}
            >
              <span>🚀</span>
              <span>{busy ? 'Буулгаж байна...' : 'Timeline дээр шууд буулгах (Apply to Timeline)'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
